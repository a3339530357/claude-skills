"""opencode 会话采集(WSL 端 + Windows 端)。

opencode 不像 Claude Code / Codex 那样一个会话一个 jsonl,而是全部塞进一个
SQLite 库(`~/.local/share/opencode/opencode.db`),三张表分工:

  session  一行一个会话,带 directory(工作目录)、title、parent_id
  message  一行一条消息,只有 role 和时间,**没有正文**
  part     正文在这里,一条消息拆成多个 part(text / reasoning / tool / patch)

所以取一句话要 join 三张表,且时间过滤只能落在 part 上 —— message 和 session
的时间戳都靠不住:会话被 resume 时 session.time_created 还是老日期。

三个坑:

1. **时间戳是毫秒**,不是秒(其余三源都是秒或 ISO)。`to_epoch` 按量级自动判别,
   但读代码时容易看错。

2. **skill / 斜杠命令的正文会以 user 消息落库**。实测运行本技能时,整份 SKILL.md
   (七千字)成了"用户发言"的第一条。不过滤就会让"跑了个技能"看起来像用户打了
   几千字,直接把该目录顶成当天主项目。这是 Claude Code 那个 tool_result 回显坑
   的同款。

3. **数据库正在被写**。opencode 开着时有 -wal 文件,只能只读打开且不能用
   immutable=1(那会忽略 WAL,读到几小时前的旧数据)。
"""

import glob
import json
import os
import sqlite3

from ..common import pathnorm, textclean
from ..common.timewin import to_epoch

DB_NAME = os.path.join(".local", "share", "opencode", "opencode.db")

# 落盘改动的工具。patch 类型的 part 也记文件,但实测只有 edit/write 的三分之一
# (它是快照机制,不是每次改动都有),所以以工具调用为主。
FILE_TOOLS = {"edit", "write", "multiedit", "patch"}

# 注入正文的判据:够长 + 有多级 markdown 标题。真人粘贴的报错日志、代码片段
# 不会有好几个 `## ` 小节,所以不会被误伤。
_INJECT_MIN_LEN = 1200
_INJECT_MIN_HEADINGS = 3


def _db_paths():
    """WSL 侧一个,Windows 侧每个用户一个。"""
    out = [("wsl", os.path.join(os.path.expanduser("~"), DB_NAME))]
    for p in sorted(glob.glob(os.path.join("/mnt/c/Users", "*", DB_NAME))):
        out.append(("windows", p))
    return [(side, p) for side, p in out if os.path.isfile(p)]


def _looks_injected(text):
    """是否为技能/命令正文而非真人发言。"""
    if len(text) < _INJECT_MIN_LEN:
        return False
    if text.count("\n## ") < _INJECT_MIN_HEADINGS:
        return False
    head = text.lstrip()
    return head.startswith("#") or head.startswith("---\nname:")


def _open_ro(path):
    """只读打开。不能加 immutable —— 库正在被写时那会读到 WAL 之前的旧状态。"""
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
    con.row_factory = sqlite3.Row
    return con


def _session_title(row, human):
    """自动生成的 "New session - <ISO>" 没有信息量,用首句真人发言代替。"""
    t = (row["title"] or "").strip()
    if t and not t.startswith("New session -"):
        return t
    if human:
        return textclean.one_line(human[0]["text"], width=60)
    return t or "(无标题)"


def _fold_patches(patches, gap=20 * 60):
    """把对同一批文件的连续改动折成一次"改动回合"。

    opencode 的 edit 是逐处替换,改一个文件常连发五六次;不折叠的话跨源关联里
    同一个文件会重复出现五六条,把真正的多个产出淹掉。按 (文件集合, 时间邻近)
    归并,保留首末时刻和次数,信息不丢但只占一行。
    """
    groups = {}
    for pt in sorted(patches, key=lambda x: x["epoch"] or 0):
        key = tuple(sorted(f["path"] for f in pt["files"]))
        bucket = groups.setdefault(key, [])
        if bucket and (pt["epoch"] or 0) - (bucket[-1]["last_epoch"] or 0) <= gap:
            cur = bucket[-1]
            cur["last_epoch"] = pt["epoch"]
            cur["edits"] += 1
            cur["success"] = cur["success"] and pt.get("success", True)
        else:
            bucket.append({**pt, "last_epoch": pt["epoch"], "edits": 1})
    out = [x for b in groups.values() for x in b]
    out.sort(key=lambda x: x["epoch"] or 0)
    return out


def _scan_session(con, row, window, own_pkgs):
    """取一个会话在窗口内的内容。窗口外一句话都没有则返回 None。"""
    sid = row["id"]
    roles = {}
    for m in con.execute("SELECT id, data FROM message WHERE session_id = ?", (sid,)):
        try:
            roles[m["id"]] = (json.loads(m["data"]) or {}).get("role")
        except (ValueError, TypeError):
            continue

    human, replies, tools, patches = [], [], {}, []
    epochs, sig_acc = [], []
    injected = 0
    cwd = pathnorm.normalize(row["directory"]) if row["directory"] else None

    q = ("SELECT message_id, time_created, data FROM part "
         "WHERE session_id = ? ORDER BY time_created")
    for p in con.execute(q, (sid,)):
        try:
            d = json.loads(p["data"]) or {}
        except (ValueError, TypeError):
            continue
        typ = d.get("type")
        if typ not in ("text", "tool", "patch"):
            continue  # reasoning / step-* 对留档没价值,体量却最大

        e = to_epoch(p["time_created"])
        role = roles.get(p["message_id"])

        if typ == "text":
            raw = (d.get("text") or "").strip()
            if not raw or not textclean.is_meaningful(raw):
                continue
            if role == "user":
                if _looks_injected(raw):
                    injected += 1
                    continue
                if not window.contains_epoch(e):
                    continue
                body, cut, shape = textclean.compress(raw, budget=700, own_pkgs=own_pkgs)
                msig = textclean.extract_signals(raw)
                sig_acc.append(msig)
                human.append({"epoch": e, "text": body, "truncated": cut,
                              "shape": shape, "raw_len": len(raw), "sig": msig or None})
                epochs.append(e)
            elif role == "assistant" and len(raw) > 40:
                if not window.contains_epoch(e):
                    continue
                body, cut, _ = textclean.compress(raw, budget=500, own_pkgs=own_pkgs)
                msig = textclean.extract_signals(raw)
                sig_acc.append(msig)
                replies.append({"epoch": e, "text": body, "truncated": cut,
                                "sig": msig or None})
                epochs.append(e)

        elif typ == "tool":
            name = d.get("tool") or "?"
            st = d.get("state") or {}
            # 工具的时刻在 state.time.start;part.time_created 是落库时刻,
            # 长时间运行的命令两者能差出好几分钟
            te = to_epoch(((st.get("time") or {}).get("start")) or p["time_created"])
            if not window.contains_epoch(te):
                continue
            tools[name] = tools.get(name, 0) + 1
            if name in FILE_TOOLS:
                fp = pathnorm.normalize((st.get("input") or {}).get("filePath"))
                if fp:
                    patches.append({"epoch": te, "success": st.get("status") == "completed",
                                    "files": [{"path": fp, "op": name}],
                                    "sig": {"file": [fp]}})
                    epochs.append(te)

        else:  # patch —— 快照式记录,可能一次带多个文件
            if not window.contains_epoch(e):
                continue
            files = [pathnorm.normalize(f) for f in (d.get("files") or [])]
            files = [f for f in files if f]
            if files:
                patches.append({"epoch": e, "success": True, "hash": d.get("hash"),
                                "files": [{"path": f, "op": "patch"} for f in files],
                                "sig": {"file": files}})
                epochs.append(e)

    if not human and not replies and not patches:
        return None

    epochs = [x for x in epochs if x]
    patches = _fold_patches(patches)

    return {
        "session_id": sid,
        "title": _session_title(row, human),
        "cwd": row["directory"],
        "project": cwd,
        "parent_id": row["parent_id"],
        "is_subagent": bool(row["parent_id"]),
        "model": row["model"],
        "agent": row["agent"],
        "first_epoch": min(epochs) if epochs else None,
        "last_epoch": max(epochs) if epochs else None,
        "human_turns": human,
        "assistant_replies": replies,
        "assistant_turn_count": len(replies),
        "tool_counts": tools,
        "patches": patches,
        "injected_prompts": injected,
        "signals": textclean.merge_signals(
            *sig_acc,
            {"file": [f["path"] for pt in patches for f in pt["files"]]},
        ),
    }


def collect(window, db_paths=None, own_pkgs=()):
    paths = db_paths or _db_paths()
    sessions, skipped, errors = [], 0, []
    lo_ms = window.lo_epoch * 1000

    for side, path in paths:
        try:
            con = _open_ro(path)
        except sqlite3.Error as e:
            errors.append({"db": path, "error": str(e)})
            continue
        try:
            rows = list(con.execute(
                "SELECT id, parent_id, directory, title, model, agent, "
                "       time_created, time_updated "
                "FROM session ORDER BY time_updated DESC"))
            for row in rows:
                # 会话最后一次更新早于窗口起点,里面不可能有窗口内的 part。
                # 反过来不成立:created 在几天前的会话被 resume 后仍有今日内容。
                upd = row["time_updated"] or row["time_created"] or 0
                if upd and upd < lo_ms:
                    skipped += 1
                    continue
                got = _scan_session(con, row, window, own_pkgs)
                if not got:
                    continue
                got["side"] = side
                got["file"] = path
                sessions.append(got)
        except sqlite3.Error as e:
            errors.append({"db": path, "error": str(e)})
        finally:
            con.close()

    sessions.sort(key=lambda s: s["first_epoch"] or 0)
    main = [s for s in sessions if not s["is_subagent"]]
    subs = [s for s in sessions if s["is_subagent"]]

    by_project = {}
    for s in main:
        key = s["project"] or "(未知项目)"
        b = by_project.setdefault(key, {
            "project": key, "display": pathnorm.display_name(key),
            "sessions": 0, "human_turns": 0, "assistant_turns": 0,
            "tools": {}, "patched_files": [], "first": None, "last": None,
        })
        b["sessions"] += 1
        b["human_turns"] += len(s["human_turns"])
        b["assistant_turns"] += s["assistant_turn_count"]
        for k, v in s["tool_counts"].items():
            b["tools"][k] = b["tools"].get(k, 0) + v
        for pt in s["patches"]:
            for f in pt["files"]:
                if f["path"] not in b["patched_files"]:
                    b["patched_files"].append(f["path"])
        for k, v in (("first", s["first_epoch"]), ("last", s["last_epoch"])):
            if v is None:
                continue
            cur = b[k]
            b[k] = v if cur is None else (min(cur, v) if k == "first" else max(cur, v))

    return {
        "sessions": main,
        "subagent_sessions": subs,
        "by_project": by_project,
        "databases": [p for _, p in paths],
        "sessions_skipped_by_mtime": skipped,
        "errors": errors,
    }
