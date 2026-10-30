#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
在 Claude Code 的历史对话 (.jsonl) 中搜索关键词，输出命中的项目与 session。

每个 session 会尽量带标题：优先取存档里的 AI 标题（"type":"ai-title" 行，
即 /resume 列表显示的那个），没有则回退用第一条真实用户消息的开头。

路径选择优先级：
  1. --path 显式指定的 projects 目录（最高）
  2. --source win|wsl 指定搜哪一份
  3. 自动按当前运行环境：WSL -> WSL 本地那份；纯 Windows -> Windows 那份

用法示例：
  python search.py 缓存穿透
  python search.py 缓存穿透 布隆过滤器 --all        # 同一对话需同时包含全部词
  python search.py "redis 分布式锁" --source win      # 搜 Windows 那份
  python search.py 限流 --path /mnt/c/Users/a3351/.claude/projects
  python search.py 限流 --limit 10                    # 只看前 N 个
  python search.py 限流 --json                        # 输出 JSON
"""
import argparse
import json
import os
import platform
import re
import sys
from pathlib import Path

# ── 各环境下的 projects 目录候选 ──────────────────────────────
WIN_NATIVE = r"C:\Users\a3351\.claude\projects"                       # Windows 原生访问
WIN_FROM_WSL = "/mnt/c/Users/a3351/.claude/projects"                  # 从 WSL 访问 Windows
WSL_LOCAL = "/home/a33511/.claude/projects"                           # WSL 内部访问自身
WSL_FROM_WIN = r"\\wsl.localhost\Ubuntu\home\a33511\.claude\projects"  # 从 Windows 访问 WSL

# 第一条用户消息里这些开头的内容是注入/系统噪音，不能当标题
FALLBACK_SKIP_PREFIXES = ("<system-reminder", "<local-command", "<task-",
                          "[Request interrupted", "Base directory for this skill:")


def is_wsl():
    if os.environ.get("WSL_DISTRO_NAME"):
        return True
    try:
        return "microsoft" in platform.uname().release.lower()
    except Exception:
        return False


def is_windows():
    return os.name == "nt"


def resolve_root(explicit, source):
    """按优先级解析要搜索的 projects 根目录。返回 (path, 说明)。"""
    if explicit:
        return explicit, "显式指定"
    win = is_windows()
    if source == "win":
        return (WIN_NATIVE if win else WIN_FROM_WSL), "Windows 那份(--source win)"
    if source == "wsl":
        return (WSL_FROM_WIN if win else WSL_LOCAL), "WSL 那份(--source wsl)"
    # 默认：跟随当前运行环境
    if win:
        return WIN_NATIVE, "自动检测: Windows 原生"
    if is_wsl():
        return WSL_LOCAL, "自动检测: WSL"
    return WSL_LOCAL, "自动检测: Linux(回退 WSL 本地路径)"


def extract_text(obj):
    """从一条 jsonl 记录中尽量抽取可读文本，用于上下文展示。"""
    msg = obj.get("message")
    parts = []
    if isinstance(msg, dict):
        content = msg.get("content")
        if isinstance(content, str):
            parts.append(content)
        elif isinstance(content, list):
            for b in content:
                if isinstance(b, dict):
                    if isinstance(b.get("text"), str):
                        parts.append(b["text"])
                    elif b.get("type") == "tool_result" and isinstance(b.get("content"), list):
                        for c in b["content"]:
                            if isinstance(c, dict) and isinstance(c.get("text"), str):
                                parts.append(c["text"])
    elif isinstance(obj.get("content"), str):
        parts.append(obj["content"])
    return "\n".join(parts)


def role_of(obj):
    msg = obj.get("message")
    if isinstance(msg, dict) and msg.get("role"):
        return msg["role"]
    return obj.get("type", "?")


def user_input_text(obj):
    """只取用户真正敲入的文本（content 里的 text block / 纯字符串），
    跳过 tool_result、图片等回传内容——那些不是用户说的话。"""
    msg = obj.get("message")
    if not isinstance(msg, dict):
        return ""
    content = msg.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [b["text"] for b in content
                 if isinstance(b, dict) and b.get("type") == "text" and isinstance(b.get("text"), str)]
        return "\n".join(parts)
    return ""


def fallback_title(text):
    """把第一条用户消息清洗成回退标题。
    返回 (kind, title)，kind 为 'text'(自然语言) 或 'cmd'(斜杠命令)；
    纯噪音/空返回 None。自然语言比命令更能代表会话主题，调用方据此排序。"""
    t = text.strip()
    if not t:
        return None
    # 剥掉嵌在开头的 system-reminder 块，看剩下的真实内容
    m = re.match(r"<system-reminder>.*?</system-reminder>\s*", t, re.S)
    if m:
        t = t[m.end():].strip()
        if not t:
            return None
    # 斜杠命令调用：显示命令及参数，如 "/claude-history-search verbose"。
    # 开头可能是 <command-message> 或 <command-name>，故用 search 而非 match。
    if t.startswith(("<command-message>", "<command-name>", "<local-command")):
        m = re.search(r"<command-name>(/[^<]+)</command-name>", t)
        if m:
            args = re.search(r"<command-args>(.*?)</command-args>", t, re.S)
            extra = args.group(1).strip() if args else ""
            return "cmd", re.sub(r"\s+", " ", (m.group(1) + " " + extra)).strip()
        return None  # /clear 等命令的 stdout 回显等，不单独作标题
    for p in FALLBACK_SKIP_PREFIXES:
        if t.startswith(p):
            return None
    return "text", re.sub(r"\s+", " ", t)


def snippet(text, keys, width=50):
    """返回第一个命中关键词周围的上下文片段（单行）。"""
    low = text.lower()
    pos, hitlen = -1, 0
    for k in keys:
        p = low.find(k.lower())
        if p != -1 and (pos == -1 or p < pos):
            pos, hitlen = p, len(k)
    if pos == -1:
        return ""
    start = max(0, pos - width)
    end = min(len(text), pos + hitlen + width)
    frag = text[start:end].replace("\n", " ").replace("\r", " ").strip()
    return ("…" if start > 0 else "") + frag + ("…" if end < len(text) else "")


def classify(fp, root):
    """从文件路径推断 (项目目录名, session标识, 是否subagent)。
    主对话:  <root>/<项目>/<session>.jsonl
    子代理:  <root>/<项目>/<session>/subagents/agent-xxx.jsonl  -> 归属父 session
    """
    rel = fp.relative_to(root)
    parts = rel.parts
    project_dir = parts[0] if parts else fp.parent.name
    if len(parts) >= 3 and "subagents" in parts:
        return project_dir, parts[1], True
    return project_dir, fp.stem, False


def search_file(fp, keys, match_all):
    """搜索单个 jsonl 文件，返回命中信息或 None。"""
    hits = 0
    found = set()
    first = None  # (role, snippet)
    cwd = None
    ts_first = None
    ts_last = None
    ai_title = None   # 存档里的 AI 标题（/resume 显示的那个）
    fb_text = None    # 第一条自然语言用户消息（首选回退）
    fb_cmd = None     # 第一条斜杠命令（最后回退）
    try:
        with open(fp, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                # AI 标题行特征明显，用子串粗筛避免逐行 json 解析
                if ai_title is None and '"type":"ai-title"' in line:
                    try:
                        t = json.loads(line).get("aiTitle")
                        if isinstance(t, str) and t.strip():
                            ai_title = t.strip()
                    except Exception:
                        pass
                if (fb_text is None or fb_cmd is None) and '"type":"user"' in line:
                    try:
                        o = json.loads(line)
                        # isMeta 行是 skill 注入等系统内容，不代表用户输入
                        if o.get("type") == "user" and not o.get("isSidechain") and not o.get("isMeta"):
                            text = user_input_text(o)
                            if text:
                                fb = fallback_title(text)
                                if fb:
                                    if fb[0] == "text" and fb_text is None:
                                        fb_text = fb[1]
                                    elif fb[0] == "cmd" and fb_cmd is None:
                                        fb_cmd = fb[1]
                    except Exception:
                        pass
                low = line.lower()
                line_hits = [k for k in keys if k.lower() in low]
                if not line_hits:
                    continue
                # 解析以便提取文本/角色/cwd
                try:
                    obj = json.loads(line)
                except Exception:
                    obj = {}
                text = extract_text(obj) if obj else line
                # 以可读文本为准复核命中（排除只命中在元数据里的情况）
                tlow = text.lower()
                real_hits = [k for k in keys if k.lower() in tlow]
                if not real_hits:
                    continue
                hits += 1
                found.update(real_hits)
                if not cwd and isinstance(obj, dict):
                    cwd = obj.get("cwd")
                ts = obj.get("timestamp") if isinstance(obj, dict) else None
                if ts:
                    ts_first = ts_first or ts
                    ts_last = ts
                if first is None:
                    first = (role_of(obj), snippet(text, real_hits))
    except Exception:
        return None
    if hits == 0:
        return None
    if match_all and not set(k.lower() for k in keys).issubset(set(x.lower() for x in found)):
        return None
    return {
        "session": fp.stem,
        "file": str(fp),
        "project_dir": fp.parent.name,
        "cwd": cwd,
        "hits": hits,
        "matched": sorted(found),
        "title": ai_title or fb_text or fb_cmd,
        "first_role": first[0] if first else "",
        "snippet": first[1] if first else "",
        "ts_first": ts_first,
        "ts_last": ts_last,
    }


def main():
    ap = argparse.ArgumentParser(description="搜索 Claude Code 历史对话关键词")
    ap.add_argument("keywords", nargs="+", help="一个或多个关键词")
    ap.add_argument("--path", help="显式指定 projects 目录（优先级最高）")
    ap.add_argument("--source", choices=["win", "wsl"], help="搜 Windows 那份还是 WSL 那份")
    ap.add_argument("--all", action="store_true", help="要求同一对话包含全部关键词(默认任一即可)")
    ap.add_argument("--json", action="store_true", help="以 JSON 输出")
    ap.add_argument("--limit", type=int, default=0, help="最多展示多少个对话(0=全部)")
    args = ap.parse_args()

    root, why = resolve_root(args.path, args.source)
    rootp = Path(root)
    if not rootp.is_dir():
        print(f"[错误] 目录不存在: {root}  ({why})", file=sys.stderr)
        sys.exit(2)

    files = list(rootp.rglob("*.jsonl"))
    # 按 (项目, session) 聚合：subagent 命中并入其父 session
    merged = {}
    for fp in files:
        r = search_file(fp, args.keywords, False)  # 始终OR收集, AND在合并后判断
        if not r:
            continue
        project_dir, session, is_sub = classify(fp, rootp)
        key = (project_dir, session)
        m = merged.get(key)
        if m is None:
            m = {"session": session, "project_dir": project_dir, "cwd": None,
                 "hits": 0, "matched": set(), "title": None,
                 "first_role": "", "snippet": "",
                 "ts_first": None, "ts_last": None, "sub_hits": 0,
                 "file": str(fp.parent / f"{session}.jsonl")}
            merged[key] = m
        m["hits"] += r["hits"]
        if is_sub:
            m["sub_hits"] += r["hits"]
        m["matched"].update(r["matched"])
        if not m["cwd"] and r.get("cwd"):
            m["cwd"] = r["cwd"]
        # 标题以主对话文件的为准，主对话没有才用子代理文件里的
        if r.get("title"):
            if not is_sub or not m.get("title"):
                m["title"] = r["title"]
        if not m["snippet"] and r["snippet"]:
            m["first_role"] = (r["first_role"] + ("·subagent" if is_sub else ""))
            m["snippet"] = r["snippet"]
        for k in ("ts_first", "ts_last"):
            if r.get(k):
                m["ts_first"] = m["ts_first"] or r["ts_first"]
                m["ts_last"] = r["ts_last"]

    results = list(merged.values())
    for m in results:
        m["matched"] = sorted(m["matched"])
    # AND 复核：合并后仍需包含全部关键词
    if args.all:
        need = set(k.lower() for k in args.keywords)
        results = [m for m in results if need.issubset(set(x.lower() for x in m["matched"]))]
    results.sort(key=lambda r: r["hits"], reverse=True)
    if args.limit:
        results = results[: args.limit]

    if args.json:
        print(json.dumps({"root": root, "why": why, "scanned": len(files),
                          "keywords": args.keywords, "match_all": args.all,
                          "results": results}, ensure_ascii=False, indent=2))
        return

    mode = "全部包含(AND)" if args.all else "任一包含(OR)"
    print(f"关键词: {' , '.join(args.keywords)}   [{mode}]")
    print(f"搜索目录: {root}  ({why})")
    print(f"扫描 {len(files)} 个记录文件，命中 {len(results)} 个对话\n")
    if not results:
        print("没有命中。可尝试换关键词，或用 --source 切换数据源。")
        return
    # 按项目分组
    groups = {}
    for r in results:
        key = r["cwd"] or r["project_dir"]
        groups.setdefault(key, []).append(r)
    for proj, items in sorted(groups.items(), key=lambda kv: -sum(i["hits"] for i in kv[1])):
        total = sum(i["hits"] for i in items)
        print(f"📁 {proj}   ({len(items)} 个对话, 共 {total} 处)")
        for r in items:
            day = (r["ts_first"] or "")[:10]
            sub = f" (含子代理{r['sub_hits']}处)" if r.get("sub_hits") else ""
            title = r.get("title") or ""
            if len(title) > 40:
                title = title[:40] + "…"
            print(f"   • session {r['session']}  | {r['hits']}处{sub} | {day} | {title or '（无标题）'} | 命中:{','.join(r['matched'])}")
            if r["snippet"]:
                print(f"     [{r['first_role']}] {r['snippet']}")
        print()


if __name__ == "__main__":
    main()
