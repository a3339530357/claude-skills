"""ChatGPT 会话采集。

浏览器在 Windows,采集脚本也必须由 Windows 的 node.exe 执行(Chrome 150 把调试
端口死绑在 127.0.0.1,WSL 跨不过去)。本模块负责:定位 node.exe、把 WSL 路径翻成
Windows 路径、跑 fetch.js、读回结果、压缩分类。

这一路依赖浏览器活着且登录态有效,是四个源里最脆的一环。因此任何一步失败都只把
本源标记为不可用并附上可操作的提示,绝不拖垮其余三源。
"""

import json
import os
import subprocess

from ..common import pathnorm, textclean

# scoop 安装位置优先,其次是常规安装路径
NODE_CANDIDATES = [
    "/mnt/c/Users/a3351/scoop/apps/nodejs/current/node.exe",
    "/mnt/c/Program Files/nodejs/node.exe",
    "/mnt/c/Program Files (x86)/nodejs/node.exe",
]

FAIL_HINTS = {
    "BROWSER_UNREACHABLE": "找不到 Chrome 调试端点(已扫 9222-9235)。先跑 assets/launch-browser.sh;"
                           "若它报 profile 被占,用 launch-browser.sh --kill-stale 清理后重试",
    "NOT_LOGGED_IN": "浏览器里尚未登录 ChatGPT,在弹出的窗口完成登录后重试",
    "AUTH_EXPIRED": "登录态已过期,在浏览器窗口里重新登录",
    "CDP_FAILED": "CDP 通信失败",
    "BAD_PAYLOAD": "返回内容无法解析",
    "MODULE_NOT_FOUND": "Windows 侧的 node 读不到技能脚本(技能装在 node 看不见的位置,"
                        "例如多层 symlink 或非 C 盘的 WSL 目录)。已尝试把脚本临时拷到"
                        "输出目录下重跑仍失败——把技能装到 /mnt/c/... 或 WSL 真实目录下可解决",
}


def find_node():
    for p in NODE_CANDIDATES:
        if os.path.exists(p):
            return p
    # 退而求其次,问 Windows 自己
    try:
        out = subprocess.run(
            ["/mnt/c/Windows/System32/where.exe", "node.exe"],
            capture_output=True, text=True, timeout=15,
        ).stdout
        for line in out.splitlines():
            line = line.strip().strip("\r")
            if line:
                wsl = pathnorm.normalize(line)
                if os.path.exists(wsl):
                    return wsl
    except (OSError, subprocess.SubprocessError):
        pass
    return None


PORT_LO, PORT_HI = 9222, 9235
_CURL = "/mnt/c/Windows/System32/curl.exe"
_NETSTAT = "/mnt/c/Windows/System32/netstat.exe"


def _listening_ports():
    """范围内正在监听的端口。

    一次 netstat 拿全,而不是逐个端口 curl —— 没人监听的端口会让 curl 白等超时,
    十几个端口能拖半分钟。
    """
    try:
        out = subprocess.run([_NETSTAT, "-ano"], capture_output=True, text=True,
                             errors="replace", timeout=20).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    ports = set()
    for line in out.splitlines():
        f = line.split()
        if len(f) < 4 or f[0] != "TCP" or f[3] != "LISTENING":
            continue
        tail = f[1].rsplit(":", 1)
        if len(tail) != 2 or not tail[1].isdigit():
            continue
        p = int(tail[1])
        if PORT_LO <= p <= PORT_HI:
            ports.add(p)
    return sorted(ports)


def _is_chrome(port):
    """端口有响应不代表是 Chrome —— 实测 Clash Verge 会绑 9222 做代理端口。"""
    try:
        out = subprocess.run(
            [_CURL, "-s", "--max-time", "3", f"http://127.0.0.1:{port}/json/version"],
            capture_output=True, text=True, errors="replace", timeout=10,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return '"Browser"' in out


def discover_cdp():
    """找出可用的 Chrome 调试端点,返回 (http_base, port) 或 (None, None)。

    显式配置优先;否则扫端口范围。之所以要扫,是因为同一个 profile 只能有一个
    Chrome 实例:profile 被占时新启动的命令会被转发、--remote-debugging-port 被
    丢弃,已有实例可能带着任意端口在跑。只认死 9222 就会找不到它。
    """
    explicit = os.environ.get("CDP_HTTP")
    if explicit:
        return explicit, None
    want = os.environ.get("CDP_PORT")
    if want and want.isdigit() and _is_chrome(int(want)):
        return f"http://127.0.0.1:{want}", int(want)
    for p in _listening_ports():
        if _is_chrome(p):
            return f"http://127.0.0.1:{p}", p
    return None, None


def _run_node(node, script_wsl, args, env, timeout):
    """跑一次 Windows node,返回 (returncode, stdout, stderr) 或抛 OSError。"""
    script_win = pathnorm.to_windows(script_wsl)
    p = subprocess.run(
        [node, script_win] + list(args),
        capture_output=True, text=True, errors="replace", timeout=timeout, env=env,
    )
    return p.returncode, p.stdout or "", p.stderr or ""


def _stage_runner(script_dir, raw_out):
    """把 chatgpt/ 下的脚本拷到输出目录旁,返回可用的 fetch.js 路径或 None。

    兜底用。node.exe 能不能看见技能目录取决于它装在哪:多层 symlink、9p 不跟随、
    非常规挂载点都会让 UNC/盘符路径解析不出来。而输出目录是用户自己指定的、
    刚刚才成功写过文件的地方,把脚本拷过去跑,绕开安装位置的不确定性。
    """
    import shutil

    dest = os.path.join(os.path.dirname(os.path.abspath(raw_out)), "runner")
    try:
        os.makedirs(dest, exist_ok=True)
        for name in os.listdir(script_dir):
            if name.endswith(".js"):
                shutil.copyfile(os.path.join(script_dir, name), os.path.join(dest, name))
        target = os.path.join(dest, "fetch.js")
        return target if os.path.exists(target) else None
    except OSError:
        return None


def fetch_raw(window, raw_out, script_dir=None, timeout=360):
    """跑 fetch.js 抓当日会话,原样落盘。返回 (ok, info)。"""
    node = find_node()
    if not node:
        return False, {"reason": "NO_NODE", "hint": "Windows 侧找不到 node.exe(Node 22+)"}

    # 必须 realpath 而非 abspath:~/.claude 常是 C:\Users\...\.claude 的 symlink,
    # 拿 symlink 路径转 UNC 后 9p 文件系统不跟随,Windows 侧的 node 找不到 fetch.js。
    script_dir = script_dir or os.path.join(
        os.path.dirname(os.path.dirname(os.path.realpath(__file__))), "chatgpt")
    out_win = pathnorm.to_windows(raw_out)

    # 找调试端点。端口不固定:同一 profile 只能有一个 Chrome 实例,profile 被占时
    # 新启动的命令会被转发、--remote-debugging-port 被丢弃,已有实例可能带着任意
    # 端口在跑。只认死 9222 会找不到它。
    cdp_http, port = discover_cdp()
    if not cdp_http:
        return False, {"reason": "BROWSER_UNREACHABLE",
                       "hint": FAIL_HINTS["BROWSER_UNREACHABLE"]}

    # CDP_HTTP 必须经 WSLENV 传给 Windows node:WSL 的环境变量默认不跨到 Windows
    # 进程。不带后缀的 WSLENV=CDP_HTTP 是双向传递;带 /u 则变成仅 Win->WSL,
    # 反而阻断 WSL->Win,这是实跑踩过的坑。
    env = os.environ.copy()
    env["CDP_HTTP"] = cdp_http
    wslenv = env.get("WSLENV", "")
    if "CDP_HTTP" not in wslenv.split(":"):
        env["WSLENV"] = f"{wslenv}:CDP_HTTP" if wslenv else "CDP_HTTP"

    attempts = [os.path.join(script_dir, "fetch.js")]
    rc, out, err = None, "", ""
    for i, script_wsl in enumerate(attempts):
        try:
            rc, out, err = _run_node(node, script_wsl, [window.date, out_win], env, timeout)
        except subprocess.TimeoutExpired:
            return False, {"reason": "TIMEOUT", "hint": f"抓取超过 {timeout}s"}
        except OSError as e:
            return False, {"reason": "SPAWN_FAILED", "hint": str(e)}

        # node 连脚本都没读到 —— 这是路径问题,不是采集问题。把脚本搬到输出目录再试。
        if rc != 0 and "Cannot find module" in err and i == len(attempts) - 1:
            staged = _stage_runner(script_dir, raw_out)
            if staged:
                attempts.append(staged)
                continue
        break

    if rc != 0:
        info = {"reason": "UNKNOWN", "hint": err.strip()[:400]}
        try:
            e = json.loads(err.strip().splitlines()[-1])
            info["reason"] = e.get("reason", "UNKNOWN")
            info["detail"] = e.get("detail")
        except (ValueError, IndexError):
            if "Cannot find module" in err:
                info["reason"] = "MODULE_NOT_FOUND"
                info["detail"] = err.strip().splitlines()[3][:200] if len(err.splitlines()) > 3 else ""
        info["hint"] = FAIL_HINTS.get(info["reason"]) or info.get("hint") or ""
        return False, info

    try:
        return True, json.loads(out.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return True, {"ok": True}


def collect(window, raw_out, classifier=None, own_pkgs=(), script_dir=None):
    """抓取 + 压缩 + 分类。失败时返回 available=False 而不是抛异常。"""
    ok, info = fetch_raw(window, raw_out, script_dir=script_dir)
    if not ok:
        return {"available": False, "failure": info, "conversations": []}

    try:
        with open(raw_out, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError) as e:
        return {"available": False, "failure": {"reason": "READ_FAILED", "hint": str(e)}, "conversations": []}

    convs = []
    raw_chars = 0
    for c in data.get("conversations", []):
        if c.get("error"):
            continue
        msgs, sigs = [], []
        epochs = []
        for m in c.get("messages", []):
            raw = (m.get("text") or "").strip()
            if not raw:
                continue
            raw_chars += len(raw)
            # 用户消息更值得留细节(常含堆栈/代码),助手消息只留结论
            budget = 700 if m.get("role") == "user" else 450
            body, cut, shape = textclean.compress(raw, budget=budget, own_pkgs=own_pkgs)
            msig = textclean.extract_signals(raw)
            sigs.append(msig)
            epochs.append(m.get("t"))
            msgs.append({
                "role": m.get("role"), "epoch": m.get("t"), "text": body,
                "truncated": cut, "shape": shape, "raw_len": len(raw),
                "model": m.get("model"), "sig": msig or None,
            })
        if not msgs:
            continue

        merged = textclean.merge_signals(*sigs)
        entry = {
            "id": c.get("id"),
            "title": c.get("title"),
            "create_epoch": c.get("create_time"),
            "update_epoch": c.get("update_time"),
            "is_carryover": bool(c.get("is_carryover")),
            "msg_today": c.get("msg_today"),
            "msg_total": c.get("msg_total"),
            "first_epoch": min([e for e in epochs if e] or [None]) if any(epochs) else None,
            "last_epoch": max([e for e in epochs if e] or [None]) if any(epochs) else None,
            "messages": msgs,
            "signals": merged,
        }
        if classifier:
            label, reasons, scores = classifier.classify(
                c.get("title"), [m["text"] for m in msgs], epochs=epochs, signals=merged
            )
            entry.update({"label": label, "label_reasons": reasons, "label_scores": scores})
        convs.append(entry)

    convs.sort(key=lambda c: c.get("first_epoch") or 0)
    kept_chars = sum(len(m["text"]) for c in convs for m in c["messages"])
    return {
        "available": True,
        "account": data.get("account"),
        "raw_file": raw_out,
        "conversations": convs,
        "stats": {
            "conversations": len(convs),
            "messages": sum(len(c["messages"]) for c in convs),
            "raw_chars": raw_chars,
            "kept_chars": kept_chars,
            "compression": round(1 - kept_chars / raw_chars, 3) if raw_chars else 0,
        },
    }
