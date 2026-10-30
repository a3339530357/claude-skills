#!/usr/bin/env python3
"""每日工作总结 —— 采集入口。

把五个来源(git / Claude Code / Codex / opencode / ChatGPT)的当日活动收拢成一份
结构化中间态 JSON,供模型据此撰写日报。

编排顺序不是随意的:
  1. 先扫三个 CLI 工具的会话 —— 它们记录了你今天待过的 cwd
  2. 用这些 cwd 去发现 git 仓库,再从仓库改动推导本项目的特有标识(包名、文件名)
  3. 用这些标识构造分类器,才能判断"达梦日期问题"是工作、"番剧推荐"是无关
  4. 最后抓 ChatGPT 并分类

反过来做就没有判据,只能靠固定词表硬猜,换个项目就失灵。

用法:
  python3 collect.py --date 2026-07-30 --out /path/to/outdir
  python3 collect.py --skip-chatgpt          # 浏览器没开时先出其余四源
"""

import argparse
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from scripts.common import classify, pathnorm, textclean  # noqa: E402
from scripts.common.timewin import DayWindow  # noqa: E402
from scripts.sources import (  # noqa: E402
    chatgpt_src, claude_src, codex_src, git_src, opencode_src,
)

DEFAULT_SCAN_ROOTS = ["~/project", "~/projects"]

# 三个 CLI 工具的会话源。结构对齐(sessions / by_project / human_turns),
# 因此下游按同一套逻辑处理,加第四个工具只需往这里加一行。
CLI_TOOLS = ("claude", "codex", "opencode")

# 主项目评分权重。commit 压倒性高是因为它代表真实产出 —— 实测当天交互量最高的
# 项目(125 条)其实是试验目录,而真正的工作项目对话只有个位数却有 4 次提交。
W_COMMIT = 10
W_TURN = 1
W_WORKTREE = 2


def _score_project(entry):
    return (
        entry["commits"] * W_COMMIT
        + entry["human_turns"] * W_TURN
        + entry["worktree_files"] * W_WORKTREE
    )


def build_projects(git_data, cli_data):
    """按归一化路径把各源活动聚到同一个项目下。

    cli_data 是 {工具名: 采集结果} 的字典,三个 CLI 工具结构一致,统一处理。
    """
    projects = {}

    # git 仓库路径列表,用于把子目录会话归并到父仓库。
    # 实测 Claude/Codex 的 cwd 常是仓库子目录(如 .../code/src/main/resources),
    # 不归并就会被拆成独立项目,污染排名。
    repo_paths = sorted(
        (pathnorm.normalize(r["path"]) for r in git_data.get("repos", []) if r.get("path")),
        key=len, reverse=True,  # 长路径优先,避免误归到更上层
    )

    def resolve_key(path):
        norm = pathnorm.normalize(path)
        if not norm:
            return "(未知项目)"
        for rp in repo_paths:
            if pathnorm.is_under(norm, rp):
                return rp
        return norm

    def slot(path):
        key = resolve_key(path)
        return projects.setdefault(key, {
            "path": key,
            "display": pathnorm.display_name(key),
            "name": os.path.basename(key.rstrip("/")) or key,
            "branches": [],
            "commits": 0,
            "commit_list": [],
            "worktree_files": 0,
            "worktree": None,
            "human_turns": 0,
            "by_tool": {t: 0 for t in CLI_TOOLS},
            "sessions": {t: 0 for t in CLI_TOOLS},
            "patched_files": [],
            "touched_files": [],
            "first": None,
            "last": None,
        })

    def touch(p, lo, hi):
        for k, v in (("first", lo), ("last", hi)):
            if v is None:
                continue
            cur = p[k]
            p[k] = v if cur is None else (min(cur, v) if k == "first" else max(cur, v))

    for repo in git_data.get("repos", []):
        p = slot(repo["path"])
        cl = repo.get("commits", [])
        p["commits"] += len(cl)
        p["commit_list"].extend(cl)
        wt = repo.get("worktree") or {}
        files = set(wt.get("staged", [])) | set(wt.get("unstaged", [])) | set(wt.get("untracked", []))
        p["worktree_files"] += len(files)
        p["worktree"] = wt
        p["touched_files"] = sorted(set(p["touched_files"]) | set(repo.get("touched_files", [])))
        if repo.get("branch") and repo["branch"] not in p["branches"]:
            p["branches"].append(repo["branch"])
        for c in cl:
            touch(p, c.get("epoch"), c.get("epoch"))

    for tool in CLI_TOOLS:
        for key, b in ((cli_data.get(tool) or {}).get("by_project") or {}).items():
            p = slot(key)
            p["human_turns"] += b.get("human_turns", 0)
            p["by_tool"][tool] += b.get("human_turns", 0)
            p["sessions"][tool] += b.get("sessions", 0)
            for br in b.get("branches", []):
                if br not in p["branches"]:
                    p["branches"].append(br)
            p["patched_files"] = sorted(
                set(p["patched_files"]) | set(b.get("patched_files", [])))
            touch(p, b.get("first"), b.get("last"))

    ranked = sorted(projects.values(), key=lambda e: (-_score_project(e), e["path"]))
    for i, e in enumerate(ranked):
        e["score"] = _score_project(e)
        e["rank"] = i + 1
        e["is_primary"] = i == 0 and e["score"] > 0
    return ranked


def build_timeline(projects, cli_data, chatgpt_data, window):
    """把各源事件铺到同一条时间轴上 —— 合并后的唯一增量价值就在这里。"""
    ev = []

    def msg_sigs(*groups):
        """逐条消息的锚点(带时刻),供关联时按时间就近取用。"""
        out = []
        for g in groups:
            for m in g or []:
                if m.get("sig") and m.get("epoch"):
                    out.append({"epoch": m["epoch"], "sig": m["sig"]})
        out.sort(key=lambda x: x["epoch"])
        return out

    for p in projects:
        for c in p["commit_list"]:
            ev.append({
                "kind": "commit", "epoch": c.get("epoch"), "project": p["path"],
                "project_name": p["name"], "sha": c.get("short"),
                "title": c.get("subject"),
                "files": len(c.get("files", [])),
                "insertions": c.get("insertions"), "deletions": c.get("deletions"),
            })

    # 三个 CLI 工具的会话事件。各源的助手回复字段名不同(assistant_replies /
    # agent_replies),取并集即可。
    for tool in CLI_TOOLS:
        for s in (cli_data.get(tool) or {}).get("sessions", []):
            if not s.get("human_turns"):
                continue
            e = {
                "kind": "ai-session", "tool": tool,
                "session_id": s.get("session_id"),
                "epoch": s.get("first_epoch"), "epoch_end": s.get("last_epoch"),
                "project": s.get("project"),
                "project_name": pathnorm.display_name(s.get("project")),
                "title": s.get("title") or (s["human_turns"][0]["text"] or "")[:60],
                "turns": len(s["human_turns"]),
                "label": s.get("label"),
                "signals": s.get("signals"),
                "msg_sigs": msg_sigs(s.get("human_turns"),
                                     s.get("assistant_replies"), s.get("agent_replies"),
                                     s.get("patches")),
            }
            if s.get("patches"):
                e["patches"] = sum(len(x["files"]) for x in s["patches"])
            ev.append(e)

    for c in (chatgpt_data or {}).get("conversations", []):
        ev.append({
            "kind": "ai-session", "tool": "chatgpt",
            "epoch": c.get("first_epoch"), "epoch_end": c.get("last_epoch"),
            "title": c.get("title"), "turns": c.get("msg_today"),
            "label": c.get("label"), "carryover": c.get("is_carryover"),
            "signals": c.get("signals"),
            "msg_sigs": msg_sigs(c.get("messages")),
        })

    ev = [e for e in ev if e.get("epoch")]
    ev.sort(key=lambda e: e["epoch"])
    for e in ev:
        e["time"] = window.local_hhmm(e["epoch"])
        if e.get("epoch_end"):
            e["time_end"] = window.local_hhmm(e["epoch_end"])
    return ev


def link_across_sources(timeline, projects, chatgpt_data, cli_data=None, window=None):
    """给每次提交挂上真正相关的 AI 会话。

    这是"卡住→求助→修复→提交"链路的机器可读形式;模型据此写因果,而不是把
    四个源各列一遍流水账。

    用打分而非布尔判定,是因为"同项目"这个条件太松 —— 当天在该项目下的每个
    会话都满足它,结果就是每次提交都挂上一堆不相干的对话。真正有说服力的是
    锚点吻合:同一个文件名、同一个异常、同一个类。所以同项目只给底分,必须
    叠加至少一项锚点证据才够门槛。
    """
    THRESHOLD = 5
    LOCAL_RADIUS = 45 * 60  # 取提交前后 45 分钟内说过的话
    commits = [e for e in timeline if e["kind"] == "commit"]
    sessions = [e for e in timeline if e["kind"] == "ai-session"]

    def local_signals(s, at):
        """取会话中**贴着这次提交**的那几条消息的锚点。

        整段会话累积的锚点不能用:实测那个 Codex 会话从 09:15 一直开到傍晚,
        累积锚点囊括了全天所有文件,于是跟每一次提交都"匹配",区分度归零。
        按时间就近取用,才能反映提交当时到底在聊什么。
        """
        ms = s.get("msg_sigs") or []
        near = [m["sig"] for m in ms if abs(m["epoch"] - at) <= LOCAL_RADIUS]
        if near:
            return textclean.merge_signals(*near)
        # 短会话本身没几条消息,退回整体锚点
        return (s.get("signals") or {}) if len(ms) <= 4 else {}

    # 每次提交涉及的文件名/类名,作为比对基准
    commit_ctx = {}
    for p in projects:
        for c in p["commit_list"]:
            bases = {os.path.basename(f) for f in c.get("files", [])}
            stems = {b.rsplit(".", 1)[0] for b in bases if "." in b}
            commit_ctx[c.get("short")] = {"bases": bases, "stems": stems}

    links = []
    for c in commits:
        ctx = commit_ctx.get(c["sha"], {"bases": set(), "stems": set()})
        related = []
        for s in sessions:
            s_start = s["epoch"]
            s_end = s.get("epoch_end") or s_start

            # 按**区间**而非单点判定。长会话会把提交夹在中间 —— 实测那次 NPE
            # 排查 14:27 起、15:59 止,两次修复提交(14:41、14:59)正落在区间内;
            # 若拿会话结束时刻去减,会算出负 78 分钟而被误判为无关。
            if s_start <= c["epoch"] <= s_end:
                gap, overlap = 0, True
            elif s_end < c["epoch"]:
                gap, overlap = c["epoch"] - s_end, False      # 先求助,后提交
            else:
                gap, overlap = c["epoch"] - s_start, False    # 先提交,后追问验证
            if not overlap and not (-1800 <= gap <= 3 * 3600):
                continue

            sig = local_signals(s, c["epoch"])
            score, why = 0, []

            hit_files = {os.path.basename(x) for x in sig.get("file", [])} & ctx["bases"]
            if hit_files:
                score += 5
                why.append("改到同一文件 " + "、".join(sorted(hit_files)[:2]))

            hit_cls = {x.rsplit(".", 1)[-1] for x in sig.get("class", [])} & ctx["stems"]
            if hit_cls:
                score += 4
                why.append("涉及同一个类 " + "、".join(sorted(hit_cls)[:2]))

            hit_site = {x.split(":")[0] for x in sig.get("site", [])} & ctx["bases"]
            if hit_site:
                score += 4
                why.append("异常栈指向 " + "、".join(sorted(hit_site)[:2]))

            if sig.get("exception"):
                score += 2
                why.append("排查 " + sig["exception"][0])

            if s.get("project") and c.get("project") and pathnorm.is_under(s["project"], c["project"]):
                score += 2
                why.append("同项目")

            if overlap:
                score += 3
                why.append("提交发生在该会话进行中")
            elif 0 <= gap <= 1800:
                score += 2
                why.append("提交前半小时内")

            if score >= THRESHOLD:
                related.append({
                    "tool": s["tool"], "title": s.get("title"),
                    "time": s.get("time"), "time_end": s.get("time_end"),
                    "gap_minutes": round(gap / 60), "overlap": overlap,
                    "score": score, "why": why,
                })

        if related:
            related.sort(key=lambda r: -r["score"])
            links.append({
                "kind": "commit", "sha": c["sha"], "commit": c["title"], "time": c["time"],
                "project": c.get("project_name"), "related": related[:4],
            })

    # CLI 工具实际落盘的改动也作为关联锚点(Codex 的 patch_apply_end、
    # opencode 的 edit/write 工具调用)。0 提交时,这是工作产出的唯一硬证据:
    # 它记录了改过哪些文件、何时改,可以和会话锚点匹配,还原"讨论了什么 → 改了
    # 什么"。匹配逻辑与 commit 相同。
    for tool in (CLI_TOOLS if cli_data else ()):
        for s in (cli_data.get(tool) or {}).get("sessions", []):
            for pt in s.get("patches", []):
                files = [f["path"] for f in pt.get("files", []) if f.get("path")]
                if not files:
                    continue
                bases = {os.path.basename(f) for f in files}
                stems = {b.rsplit(".", 1)[0] for b in bases if "." in b}
                pctx = {"bases": bases, "stems": stems}
                prelated = []
                for s2 in sessions:
                    s_start = s2["epoch"]
                    s_end = s2.get("epoch_end") or s_start
                    if s_start <= pt["epoch"] <= s_end:
                        gap, overlap = 0, True
                    elif s_end < pt["epoch"]:
                        gap, overlap = pt["epoch"] - s_end, False
                    else:
                        gap, overlap = pt["epoch"] - s_start, False
                    if not overlap and not (-1800 <= gap <= 3 * 3600):
                        continue
                    sig = local_signals(s2, pt["epoch"])
                    score, why = 0, []
                    hit_files = {os.path.basename(x) for x in sig.get("file", [])} & pctx["bases"]
                    if hit_files:
                        score += 5
                        why.append("改到同一文件 " + "、".join(sorted(hit_files)[:2]))
                    hit_cls = {x.rsplit(".", 1)[-1] for x in sig.get("class", [])} & pctx["stems"]
                    if hit_cls:
                        score += 4
                        why.append("涉及同一个类 " + "、".join(sorted(hit_cls)[:2]))
                    hit_site = {x.split(":")[0] for x in sig.get("site", [])} & pctx["bases"]
                    if hit_site:
                        score += 4
                        why.append("异常栈指向 " + "、".join(sorted(hit_site)[:2]))
                    if sig.get("exception"):
                        score += 2
                        why.append("排查 " + sig["exception"][0])
                    if s2.get("project") and s.get("project") and pathnorm.is_under(s2["project"], s["project"]):
                        score += 2
                        why.append("同项目")
                    if overlap:
                        score += 3
                        why.append("改动发生在该会话进行中")
                    elif 0 <= gap <= 1800:
                        score += 2
                        why.append("改动前半小时内")
                    if score >= THRESHOLD:
                        prelated.append({
                            "tool": s2["tool"], "title": s2.get("title"),
                            "time": s2.get("time"), "time_end": s2.get("time_end"),
                            "gap_minutes": round(gap / 60), "overlap": overlap,
                            "score": score, "why": why,
                        })
                if prelated:
                    prelated.sort(key=lambda r: -r["score"])
                    span = window.local_hhmm(pt["epoch"]) if window else ""
                    # 同一分钟内结束就不显示区间,免得出现 "11:23–11:23"
                    if window and pt.get("last_epoch"):
                        end = window.local_hhmm(pt["last_epoch"])
                        if end != span:
                            span += "–" + end
                    links.append({
                        "kind": "patch",
                        "tool": tool,
                        "title": f"{tool} 落盘: " + "、".join(sorted(bases)[:3]),
                        "time": span,
                        "edits": pt.get("edits", 1),
                        "project": pathnorm.display_name(s.get("project")),
                        "files": files[:5], "related": prelated[:4],
                    })
    return links


def main():
    ap = argparse.ArgumentParser(description="采集当日五源工作记录")
    ap.add_argument("--date", help="YYYY-MM-DD,默认今天")
    ap.add_argument("--out", required=True, help="输出目录")
    ap.add_argument("--scan-roots", nargs="*", default=None, help="额外扫描的项目根目录")
    ap.add_argument("--skip-chatgpt", action="store_true", help="跳过 ChatGPT(浏览器没开时用)")
    ap.add_argument("--all-authors", action="store_true", help="统计他人提交")
    ap.add_argument("--quiet", action="store_true", help="只输出 JSON 路径")
    args = ap.parse_args()

    window = DayWindow(args.date)
    out_dir = os.path.abspath(os.path.expanduser(args.out))
    raw_dir = os.path.join(out_dir, ".raw")
    os.makedirs(raw_dir, exist_ok=True)

    def log(*a):
        if not args.quiet:
            print(*a, file=sys.stderr)

    log(f"时间窗 {window.date} 本地 [{window.lo_local:%H:%M} → 次日 {window.hi_local:%H:%M}) "
        f"= UTC [{window.lo_iso} , {window.hi_iso})")

    # --- 第一步:三个 CLI 工具的会话(它们告诉我们今天待过哪些目录) ---
    SRC = {"claude": claude_src, "codex": codex_src, "opencode": opencode_src}
    with ThreadPoolExecutor(max_workers=len(SRC)) as pool:
        futs = {t: pool.submit(SRC[t].collect, window) for t in CLI_TOOLS}
        cli_data = {t: f.result() for t, f in futs.items()}
    NAMES = {"claude": "Claude Code", "codex": "Codex", "opencode": "opencode"}
    for t in CLI_TOOLS:
        log(f"{NAMES[t]:<12}: {len(cli_data[t]['sessions'])} 个会话")
    for e in cli_data["opencode"].get("errors", []):
        log(f"  ! opencode 库读取失败 {e['db']}: {e['error']}")

    # --- 第二步:用 cwd 线索发现 git 仓库 ---
    hints = [s["project"] for t in CLI_TOOLS
             for s in cli_data[t]["sessions"] if s.get("project")]
    roots = [os.path.expanduser(r) for r in (args.scan_roots or DEFAULT_SCAN_ROOTS)]
    git_data = git_src.collect(window, hint_paths=hints, scan_roots=roots,
                               mine_only=not args.all_authors)
    n_commits = sum(len(r.get("commits", [])) for r in git_data["repos"])
    log(f"Git         : {len(git_data['repos'])} 个活跃仓库 / {n_commits} 次提交")

    # --- 第三步:从仓库改动推导本项目标识,构造分类器 ---
    tokens = classify.derive_project_tokens(git_data["repos"])
    # 非 git 的活跃项目(如开发工具本身)目录名也加入标识。
    # 否则这类项目的工作会因无 git 标识被判 off-topic -- 实测运行本采集技能
    # 本身的工作就被误判过。目录名作为弱标识:只有对话里出现该词才加分,
    # 试验目录(testt 等)的对话不含技术信号,加不加这个 token 不影响其判定。
    for t in CLI_TOOLS:
        for key, b in (cli_data[t].get("by_project") or {}).items():
            if b.get("human_turns", 0) < 2:
                continue
            name = os.path.basename(key.rstrip("/"))
            if name and len(name) >= 3 and name not in tokens:
                tokens.append(name)
    commit_epochs = [c["epoch"] for r in git_data["repos"] for c in r.get("commits", []) if c.get("epoch")]
    clf = classify.Classifier(project_tokens=tokens, commit_epochs=commit_epochs)
    own_pkgs = [t for t in tokens if "." in t]
    log(f"项目标识    : {', '.join(tokens[:6])}{' …' if len(tokens) > 6 else ''}")

    # 给 CLI 会话也打标签(能识别出"在折腾日报脚本本身"这类元任务)
    for t in CLI_TOOLS:
        for s in cli_data[t]["sessions"]:
            texts = [x["text"] for x in s.get("human_turns", [])]
            if not texts:
                continue
            label, reasons, _ = clf.classify(
                pathnorm.display_name(s.get("project")), texts,
                epochs=[x.get("epoch") for x in s["human_turns"]],
            )
            s["label"], s["label_reasons"] = label, reasons

    # --- 第四步:ChatGPT ---
    if args.skip_chatgpt:
        chatgpt_data = {"available": False, "failure": {"reason": "SKIPPED", "hint": "按参数跳过"},
                        "conversations": []}
    else:
        chatgpt_data = chatgpt_src.collect(
            window, os.path.join(raw_dir, f"chatgpt-{window.date}.json"),
            classifier=clf, own_pkgs=own_pkgs,
        )
        if chatgpt_data["available"]:
            st = chatgpt_data["stats"]
            log(f"ChatGPT     : {st['conversations']} 个会话 / {st['messages']} 条消息 / "
                f"{st['raw_chars']} 字压至 {st['kept_chars']} 字(压缩 {st['compression']:.0%})")
        else:
            log(f"ChatGPT     : 不可用 —— {chatgpt_data['failure'].get('hint') or chatgpt_data['failure'].get('reason')}")

    # --- 汇总 ---
    projects = build_projects(git_data, cli_data)
    timeline = build_timeline(projects, cli_data, chatgpt_data, window)
    links = link_across_sources(timeline, projects, chatgpt_data, cli_data, window)

    # msg_sigs 只服务于关联计算,写进产物只会占体积、干扰阅读
    for e in timeline:
        e.pop("msg_sigs", None)

    buckets = {}
    for c in chatgpt_data.get("conversations", []):
        buckets.setdefault(c.get("label") or "unknown", []).append(c["title"])

    result = {
        "date": window.date,
        "generated_from": {
            "window_local": [str(window.lo_local), str(window.hi_local)],
            "window_utc": [window.lo_iso, window.hi_iso],
        },
        "projects": projects,
        "primary_project": next((p["path"] for p in projects if p.get("is_primary")), None),
        "timeline": timeline,
        "cross_source_links": links,
        "sources": dict({"git": git_data}, **cli_data, chatgpt=chatgpt_data),
        "chatgpt_buckets": buckets,
        "project_tokens": tokens,
    }

    out_json = os.path.join(out_dir, f"collected-{window.date}.json")
    with open(out_json, "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=2)

    if args.quiet:
        print(out_json)
        return

    print(out_json)
    log("")
    log("--- 项目排名(得分 = 提交×10 + 真人提问×1 + 工作区改动×2) ---")
    for p in projects[:8]:
        mark = " ★主项目" if p.get("is_primary") else ""
        by = "+".join(f"{t[:2]}{n}" for t, n in p["by_tool"].items() if n)
        log(f"  {p['score']:>4}  {p['display']:<34} 提交{p['commits']} 提问{p['human_turns']}"
            f"{'(' + by + ')' if by else ''} 工作区{p['worktree_files']}{mark}")
    if links:
        log("")
        n_commit = sum(1 for l in links if l.get("kind") == "commit")
        n_patch = sum(1 for l in links if l.get("kind") == "patch")
        log(f"--- 跨源关联:{n_commit} 次提交、{n_patch} 处改动能追溯到求助会话 ---")
        for l in links[:6]:
            if l.get("kind") == "commit":
                head = f"{l.get('sha','')} {l.get('commit','')}"
            else:
                head = l.get("title", "")
            log(f"  [{l['time']}] {head}")
            for r in l["related"][:3]:
                log(f"        ← {r['tool']:<8} {r['time']} 「{(r['title'] or '')[:34]}」 {'/'.join(r['why'])}")
    if buckets:
        log("")
        log("--- ChatGPT 分类 ---")
        for k, v in buckets.items():
            log(f"  {classify.LABEL_CN.get(k, k)}({len(v)}): {', '.join(v[:5])}")


if __name__ == "__main__":
    main()
