"""噪声剥离、分级压缩、锚点抽取。

三件事,对应实测踩到的三个坑:

1. 剥噪声 —— Claude Code 的 user 条目里混着工具回显。实测某项目 125 条 user
   里只有 11 条是真人说的,不剥离会把试验性项目误判成当天主要工作。

2. 分级压缩 —— ChatGPT 单条消息实测可达 1.9 万字(粘贴的服务器日志),当日
   四源合计 15 万字以上。但助手自己都说了"关键看异常第一行 + 业务代码第一行",
   所以按内容形态差异化裁剪,而不是一刀切 truncate。

3. 抽锚点 —— 类名、异常、文件行号是把四个源串成因果链的唯一凭据。
"""

import re

# ---------------------------------------------------------------- 噪声剥离

_NOISE_PREFIXES = (
    "Caveat:",
    "[Request interrupted",
    "<command-name>",
    "<command-message>",
    "<local-command-stdout>",
    "<user-prompt-submit-hook>",
)
_SYSTEM_REMINDER = re.compile(r"^\s*<system-reminder>", re.IGNORECASE)
_TAG_ONLY = re.compile(r"^\s*<[^>]+>\s*$")
# 斜杠命令展开后的包裹标签。整条只剩这些标签说明用户敲的是 /init 之类,
# 不是真的写了这段话 —— 实测 `/init` 会以 <command-message>init</command-message>
# 的形式落进 jsonl 的 user 条目,不剥掉就成了"真人提问"计入项目得分。
_CMD_TAGS = re.compile(r"</?command-[\w-]+>", re.IGNORECASE)


def extract_text(content):
    """从 Claude Code 的 message.content 提取纯文本。

    content 可能是 str,也可能是 block 列表。若列表中出现 tool_result,
    说明整条是工具回显而非真人发言,返回 None 让调用方丢弃。
    """
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return None
    parts = []
    for b in content:
        if not isinstance(b, dict):
            continue
        t = b.get("type")
        if t == "tool_result":
            return None  # 工具回显,整条作废
        if t == "text":
            parts.append(b.get("text") or "")
    return "\n".join(parts) if parts else None


def is_human_turn(entry):
    """判定 Claude Code 的一条 jsonl 记录是否为真人发言。"""
    if entry.get("type") != "user":
        return False
    if entry.get("isMeta") or entry.get("isCompactSummary") or entry.get("isSidechain"):
        return False
    text = extract_text((entry.get("message") or {}).get("content"))
    return bool(text and is_meaningful(text))


def is_meaningful(text):
    """排除系统注入、命令回显、纯标签等非真人内容。"""
    if not text:
        return False
    s = text.strip()
    if not s or _TAG_ONLY.match(s):
        return False
    if _SYSTEM_REMINDER.match(s):
        return False
    if any(s.startswith(p) for p in _NOISE_PREFIXES):
        return False
    # 去掉命令包裹标签后没剩下几个字,说明整条就是一次斜杠命令调用
    if "<command-" in s and len(_CMD_TAGS.sub("", s).strip()) < 12:
        return False
    return True


def strip_reminders(text):
    """去掉正文里夹带的 <system-reminder> 段落,保留真人写的部分。"""
    if not text:
        return ""
    return re.sub(r"<system-reminder>.*?</system-reminder>", "", text, flags=re.S).strip()


# ---------------------------------------------------------------- 形态识别

_STACK_FRAME = re.compile(r"^\s+at\s+[\w$.]+\(", re.MULTILINE)
_EXC_LINE = re.compile(r"^\s*(?:[\w.]+\.)?(\w*(?:Exception|Error))\b[:\s]", re.MULTILINE)
_LOG_LINE = re.compile(
    r"^\s*(?:\d{1,2}[-/][A-Za-z]{3}[-/]\d{4}|\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2})", re.MULTILINE
)
_FENCE = re.compile(r"^```", re.MULTILINE)


def detect_shape(text):
    """判断文本形态,决定用哪种裁剪策略。"""
    if not text:
        return "empty"
    frames = len(_STACK_FRAME.findall(text))
    if frames >= 3 and _EXC_LINE.search(text):
        return "stacktrace"
    lines = text.count("\n") + 1
    if lines >= 15 and len(_LOG_LINE.findall(text)) >= lines * 0.4:
        return "log"
    if _FENCE.search(text) or (lines >= 10 and text.count(";") + text.count("{") >= lines * 0.5):
        return "code"
    return "prose"


# ---------------------------------------------------------------- 分级压缩


def _compress_stack(text, budget, own_pkgs):
    """堆栈:留异常行 + 自家包的业务帧,框架帧折叠掉。

    诊断价值集中在异常类型和第一个业务帧上,几十行 sun.reflect / spring 帧
    对日报毫无意义。
    """
    lines = text.split("\n")
    kept, dropped = [], 0
    for ln in lines:
        is_frame = bool(re.match(r"^\s+at\s", ln))
        if not is_frame:
            kept.append(ln)
            continue
        if own_pkgs and any(p in ln for p in own_pkgs):
            kept.append(ln)
        elif len([k for k in kept if re.match(r"^\s+at\s", k)]) < 2:
            kept.append(ln)  # 最靠前的两帧无论属于谁都留着
        else:
            dropped += 1
    out = "\n".join(kept)
    if dropped:
        out += f"\n\t… 省略 {dropped} 个框架调用帧 …"
    return out[:budget] + (" …" if len(out) > budget else "")


def _head_tail(text, budget, head_ratio=0.7):
    """散文/日志:掐头留尾,中间标注省略量。结论常在开头和结尾。"""
    if len(text) <= budget:
        return text
    head = int(budget * head_ratio)
    tail = budget - head
    omitted = len(text) - budget
    return f"{text[:head]}\n…(省略 {omitted} 字)…\n{text[-tail:]}"


def compress(text, budget=800, own_pkgs=None):
    """按形态分级裁剪。返回 (压缩后文本, 是否被裁剪, 形态)。"""
    text = (text or "").strip()
    if not text:
        return "", False, "empty"
    shape = detect_shape(text)
    if len(text) <= budget:
        return text, False, shape
    if shape == "stacktrace":
        return _compress_stack(text, budget, own_pkgs or []), True, shape
    if shape in ("log", "code"):
        return _head_tail(text, budget, head_ratio=0.75), True, shape
    return _head_tail(text, budget, head_ratio=0.65), True, shape


# ---------------------------------------------------------------- 锚点抽取

_PAT = {
    # 自家 Java 类的全限定名
    "class": re.compile(r"\b((?:com|cn|org|net)\.[a-z0-9_]+(?:\.[a-z0-9_]+)*\.[A-Z]\w+)\b"),
    # 异常/错误类型
    "exception": re.compile(r"\b(\w*(?:Exception|Error))\b"),
    # 源文件 + 行号,定位价值最高
    "site": re.compile(r"\b(\w+\.(?:java|kt|py|js|ts|go|rs)):(\d+)"),
    # 涉及的文件
    "file": re.compile(r"\b([\w./-]+\.(?:java|xml|yml|yaml|properties|sql|sh|bat|py|js|ts|vue|md))\b"),
    # SQL 表
    "table": re.compile(r"\b(?:FROM|JOIN|UPDATE|INSERT\s+INTO)\s+([A-Za-z_]\w*)", re.IGNORECASE),
    # git 短哈希
    "commit": re.compile(r"\b([0-9a-f]{7,40})\b"),
}

# 明显是噪声的异常名,出现在讲解文本里不代表真的报了错
_EXC_STOPWORDS = {"Exception", "Error", "RuntimeException", "Throwable"}


def extract_signals(text, max_each=8):
    """抽出可用于跨源关联的锚点。"""
    if not text:
        return {}
    out = {}
    for key, pat in _PAT.items():
        if key == "commit":
            continue  # 单独处理,避免把十六进制串当哈希
        found = []
        for m in pat.finditer(text):
            v = f"{m.group(1)}:{m.group(2)}" if key == "site" else m.group(1)
            if key == "exception" and v in _EXC_STOPWORDS:
                continue
            if v not in found:
                found.append(v)
            if len(found) >= max_each:
                break
        if found:
            out[key] = found
    return out


def merge_signals(*dicts):
    """合并多份锚点,保持出现顺序、去重。"""
    out = {}
    for d in dicts:
        for k, vs in (d or {}).items():
            bucket = out.setdefault(k, [])
            for v in vs:
                if v not in bucket:
                    bucket.append(v)
    return out


def one_line(text, width=110):
    """压成单行摘要,用于列表展示。"""
    s = re.sub(r"\s+", " ", strip_reminders(text or "")).strip()
    return s[:width] + ("…" if len(s) > width else "")
