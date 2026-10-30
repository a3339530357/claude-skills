"""Codex 会话采集(Windows 端 + WSL 端)。

三个要点:

1. 不能按目录日期找文件。实测有个 rollout 躺在 sessions/2026/07/20/ 下、文件名
   也写着 07-20,里面却有 1100 行 07-30 的消息 —— 会话被 resume 了。所以扫全量
   目录树,靠 mtime 做廉价预筛,再按消息 timestamp 精筛。

2. 同一句话会在 event_msg 和 response_item 里各存一份。只取 event_msg,否则
   对话量翻倍。

3. patch_apply_end.changes 记录了 Codex 实际落盘的文件,是工作产出的硬证据,
   比对话内容更能说明"改了什么"。
"""

import glob
import json
import os

from ..common import pathnorm, textclean
from ..common.timewin import to_epoch

ROOTS = [
    ("windows", "/mnt/c/Users/a3351/.codex/sessions"),
    ("wsl", os.path.expanduser("~/.codex/sessions")),
]


def _scan_file(path, window, own_pkgs):
    hints = window.prefilter_hints()
    cwd = originator = cli_version = session_id = None
    users, agents, patches = [], [], []
    epochs = []
    turns = set()
    sig_acc = []

    try:
        fh = open(path, encoding="utf-8", errors="replace")
    except OSError:
        return None

    with fh:
        for line in fh:
            if not any(h in line for h in hints):
                continue
            try:
                d = json.loads(line)
            except (json.JSONDecodeError, ValueError):
                continue
            ts = d.get("timestamp")
            if not window.contains(ts):
                continue
            e = to_epoch(ts)
            typ = d.get("type")
            p = d.get("payload") if isinstance(d.get("payload"), dict) else {}

            if typ == "session_meta":
                cwd = p.get("cwd") or cwd
                originator = p.get("originator") or originator
                cli_version = p.get("cli_version") or cli_version
                session_id = p.get("session_id") or session_id
                continue

            if typ != "event_msg":
                continue  # response_item 是 event_msg 的重复投影,跳过

            kind = p.get("type")
            if kind == "user_message":
                raw = (p.get("message") or "").strip()
                if raw and textclean.is_meaningful(raw):
                    body, cut, shape = textclean.compress(raw, budget=700, own_pkgs=own_pkgs)
                    msig = textclean.extract_signals(raw)
                    sig_acc.append(msig)
                    users.append({"epoch": e, "text": body, "truncated": cut,
                                  "shape": shape, "raw_len": len(raw),
                                  "has_image": bool(p.get("images") or p.get("local_images")),
                                  "sig": msig or None})
                    epochs.append(e)
            elif kind == "agent_message":
                raw = (p.get("message") or "").strip()
                if len(raw) > 40:
                    body, cut, _ = textclean.compress(raw, budget=500, own_pkgs=own_pkgs)
                    msig = textclean.extract_signals(raw)
                    sig_acc.append(msig)
                    agents.append({"epoch": e, "text": body, "truncated": cut,
                                   "phase": p.get("phase"), "sig": msig or None})
                    epochs.append(e)
            elif kind == "patch_apply_end":
                changes = p.get("changes") or {}
                files = []
                if isinstance(changes, dict):
                    for fpath, meta in changes.items():
                        files.append({
                            "path": pathnorm.normalize(fpath),
                            "op": (meta or {}).get("type") if isinstance(meta, dict) else None,
                        })
                if files:
                    paths = [f["path"] for f in files if f.get("path")]
                    patches.append({"epoch": e, "success": p.get("success"), "files": files,
                                    "sig": {"file": paths} if paths else None})
                    epochs.append(e)
            elif kind == "task_started":
                if p.get("turn_id"):
                    turns.add(p["turn_id"])

    if not users and not agents and not patches:
        return None

    epochs = [x for x in epochs if x]
    return {
        "file": path,
        "session_id": session_id,
        "cwd": cwd,
        "project": pathnorm.normalize(cwd) if cwd else None,
        "originator": originator,
        "cli_version": cli_version,
        "first_epoch": min(epochs) if epochs else None,
        "last_epoch": max(epochs) if epochs else None,
        "human_turns": users,
        "agent_replies": agents,
        "patches": patches,
        "turn_count": len(turns),
        "signals": textclean.merge_signals(
            *sig_acc,
            {"file": [f["path"] for pt in patches for f in pt["files"] if f.get("path")]},
        ),
    }


def collect(window, roots=None, own_pkgs=()):
    roots = roots or ROOTS
    sessions, skipped = [], 0

    for side, root in roots:
        if not os.path.isdir(root):
            continue
        for path in glob.glob(os.path.join(root, "**", "*.jsonl"), recursive=True):
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
            sessions.append(got)

    sessions.sort(key=lambda s: s["first_epoch"] or 0)

    by_project = {}
    for s in sessions:
        key = s["project"] or "(未知项目)"
        b = by_project.setdefault(key, {
            "project": key, "display": pathnorm.display_name(key),
            "sessions": 0, "human_turns": 0, "agent_turns": 0,
            "patched_files": [], "first": None, "last": None,
        })
        b["sessions"] += 1
        b["human_turns"] += len(s["human_turns"])
        b["agent_turns"] += len(s["agent_replies"])
        for pt in s["patches"]:
            for f in pt["files"]:
                if f["path"] and f["path"] not in b["patched_files"]:
                    b["patched_files"].append(f["path"])
        if s["first_epoch"] is not None:
            b["first"] = s["first_epoch"] if b["first"] is None else min(b["first"], s["first_epoch"])
        if s["last_epoch"] is not None:
            b["last"] = s["last_epoch"] if b["last"] is None else max(b["last"], s["last_epoch"])

    return {
        "sessions": sessions,
        "by_project": by_project,
        "files_skipped_by_mtime": skipped,
    }
