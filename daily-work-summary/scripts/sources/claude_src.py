"""Claude Code 会话采集(WSL 端 + Windows 端)。

两个坑必须绕开:

1. 会话文件会跨天,也会被 resume。实测某文件里同时躺着 07-29 和 07-30 的消息,
   所以只能按每条消息的 timestamp 判定,文件 mtime 仅用作廉价预筛。

2. type=="user" 的条目里混着 tool_result 工具回显。实测某项目 125 条 user 中
   只有 11 条是真人说的 —— 不过滤会把试验性项目误判成当天主力工作。
"""

import glob
import json
import os

from ..common import pathnorm, textclean
from ..common.timewin import to_epoch

ROOTS = [
    ("wsl", os.path.expanduser("~/.claude/projects")),
    ("windows", "/mnt/c/Users/a3351/.claude/projects"),
]


def _iter_session_files(roots):
    for side, root in roots:
        if not os.path.isdir(root):
            continue
        for f in glob.glob(os.path.join(root, "**", "*.jsonl"), recursive=True):
            yield side, f


def _scan_file(path, window, own_pkgs):
    """扫一个会话文件,只保留落在时间窗内的内容。"""
    hints = window.prefilter_hints()
    cwd = branch = session_id = None
    human, replies, tools = [], [], {}
    epochs = []
    assistant_turns = 0
    sig_acc = []

    try:
        fh = open(path, encoding="utf-8", errors="replace")
    except OSError:
        return None

    with fh:
        for line in fh:
            # 廉价预筛:整行连日期前缀都不含,不必解析 JSON
            if not any(h in line for h in hints):
                continue
            try:
                d = json.loads(line)
            except (json.JSONDecodeError, ValueError):
                continue
            ts = d.get("timestamp")
            if not window.contains(ts):
                continue

            if d.get("cwd"):
                cwd = d["cwd"]
            if d.get("gitBranch"):
                branch = d["gitBranch"]
            if d.get("sessionId"):
                session_id = d["sessionId"]

            e = to_epoch(ts)
            typ = d.get("type")

            if typ == "user":
                if textclean.is_human_turn(d):
                    raw = textclean.strip_reminders(
                        textclean.extract_text((d.get("message") or {}).get("content")) or ""
                    )
                    if raw:
                        body, cut, shape = textclean.compress(raw, budget=700, own_pkgs=own_pkgs)
                        msig = textclean.extract_signals(raw)
                        sig_acc.append(msig)
                        human.append({"epoch": e, "text": body, "truncated": cut,
                                      "shape": shape, "raw_len": len(raw),
                                      "sig": msig or None})
                        epochs.append(e)
            elif typ == "assistant":
                assistant_turns += 1
                epochs.append(e)
                content = (d.get("message") or {}).get("content")
                if isinstance(content, list):
                    for b in content:
                        if not isinstance(b, dict):
                            continue
                        if b.get("type") == "tool_use":
                            n = b.get("name") or "?"
                            tools[n] = tools.get(n, 0) + 1
                        elif b.get("type") == "text":
                            t = (b.get("text") or "").strip()
                            if len(t) > 40:  # 太短的多是过渡语,没有留档价值
                                body, cut, _ = textclean.compress(t, budget=500, own_pkgs=own_pkgs)
                                msig = textclean.extract_signals(t)
                                sig_acc.append(msig)
                                replies.append({"epoch": e, "text": body, "truncated": cut,
                                                "sig": msig or None})

    if not human and not assistant_turns:
        return None

    epochs = [x for x in epochs if x]
    return {
        "file": path,
        "session_id": session_id or os.path.basename(path)[:-6],
        "is_subagent": "/subagents/" in path.replace("\\", "/"),
        "cwd": cwd,
        "project": pathnorm.normalize(cwd) if cwd else None,
        "branch": branch,
        "first_epoch": min(epochs) if epochs else None,
        "last_epoch": max(epochs) if epochs else None,
        "human_turns": human,
        "assistant_replies": replies,
        "assistant_turn_count": assistant_turns,
        "tool_counts": tools,
        "signals": textclean.merge_signals(*sig_acc),
    }


def collect(window, roots=None, own_pkgs=()):
    roots = roots or ROOTS
    sessions, skipped = [], 0

    for side, path in _iter_session_files(roots):
        # 文件最后修改时间早于窗口起点,则不可能含窗口内消息
        try:
            if os.path.getmtime(path) < window.lo_epoch:
                skipped += 1
                continue
        except OSError:
            continue
        got = _scan_file(path, window, own_pkgs)
        if not got:
            continue
        got["side"] = side
        # cwd 拿不到时退回目录名反解(有歧义,仅兜底)
        if not got["project"]:
            got["project"] = pathnorm.decode_claude_dirname(
                os.path.basename(os.path.dirname(path))
            )
        sessions.append(got)

    # 主会话在前,便于阅读;子代理会话单独归类
    main = [s for s in sessions if not s["is_subagent"]]
    subs = [s for s in sessions if s["is_subagent"]]

    by_project = {}
    for s in main:
        key = s["project"] or "(未知项目)"
        b = by_project.setdefault(key, {
            "project": key, "display": pathnorm.display_name(key),
            "branches": set(), "sessions": 0, "human_turns": 0,
            "assistant_turns": 0, "tools": {}, "first": None, "last": None,
        })
        b["sessions"] += 1
        b["human_turns"] += len(s["human_turns"])
        b["assistant_turns"] += s["assistant_turn_count"]
        if s["branch"]:
            b["branches"].add(s["branch"])
        for k, v in s["tool_counts"].items():
            b["tools"][k] = b["tools"].get(k, 0) + v
        for key_, val in (("first", s["first_epoch"]), ("last", s["last_epoch"])):
            if val is None:
                continue
            cur = b[key_]
            b[key_] = val if cur is None else (min(cur, val) if key_ == "first" else max(cur, val))
    for b in by_project.values():
        b["branches"] = sorted(b["branches"])

    return {
        "sessions": main,
        "subagent_sessions": subs,
        "by_project": by_project,
        "files_skipped_by_mtime": skipped,
    }
