"""Git 采集:当天提交 + 工作区未提交改动。

仓库发现走两条路并集:
  1. 从 AI 会话记录里出现过的 cwd 往上找 .git —— 你今天真正待过的地方
  2. 扫描配置的项目根目录 —— 捞出没开 AI 也在改的仓库

只统计当前 git 身份的提交(日报讲的是"我做了什么"),但会记下他人提交数,
免得在协作分支上产生"今天怎么这么安静"的错觉。
"""

import os
import subprocess

from ..common import pathnorm
from ..common.timewin import to_epoch

SEP = "\x1f"  # 字段分隔符,避免 commit message 里的字符撞车
REC = "\x1e"  # 记录分隔符


def _run(args, cwd=None, timeout=30):
    try:
        p = subprocess.run(
            args, cwd=cwd, capture_output=True, text=True,
            errors="replace", timeout=timeout,
        )
        return p.stdout if p.returncode == 0 else ""
    except (subprocess.TimeoutExpired, OSError):
        return ""


def _toplevel(path):
    out = _run(["git", "rev-parse", "--show-toplevel"], cwd=path)
    return pathnorm.normalize(out.strip()) if out.strip() else None


def discover_repos(hint_paths=(), scan_roots=(), max_depth=3):
    """返回去重后的仓库根路径列表。"""
    found = set()

    for p in hint_paths:
        p = pathnorm.normalize(p)
        if not p or not os.path.isdir(p):
            continue
        top = _toplevel(p)
        if top:
            found.add(top)

    for root in scan_roots:
        root = pathnorm.normalize(root)
        if not root or not os.path.isdir(root):
            continue
        base_depth = root.rstrip("/").count("/")
        for dirpath, dirnames, _ in os.walk(root):
            if dirpath.count("/") - base_depth >= max_depth:
                dirnames[:] = []
                continue
            # 跳过明显不该递归的目录,不然在 node_modules 里能走到天亮
            dirnames[:] = [
                d for d in dirnames
                if d not in {"node_modules", "target", "build", "dist", ".venv", "venv", "__pycache__"}
            ]
            if ".git" in dirnames or os.path.exists(os.path.join(dirpath, ".git")):
                found.add(pathnorm.normalize(dirpath))
                dirnames[:] = []  # 不进子仓库
    return sorted(found)


def _identity(repo):
    email = _run(["git", "config", "user.email"], cwd=repo).strip()
    name = _run(["git", "config", "user.name"], cwd=repo).strip()
    return email, name


def _commit_stat(repo, sha):
    """单次提交的文件变更统计。"""
    out = _run(["git", "show", "--numstat", "--format=", sha], cwd=repo)
    files, add, dele = [], 0, 0
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) != 3:
            continue
        a, d, path = parts
        add += int(a) if a.isdigit() else 0
        dele += int(d) if d.isdigit() else 0
        files.append(path)
    return files, add, dele


def _commit_diff_digest(repo, sha, max_chars=1200):
    """提交内容摘要。

    采集深度定为"中等":只取 unified=0 的变更行,不带上下文。足以看出改了什么
    逻辑(比如加了 null 判断),又不会把整个文件正文拖进来。
    """
    out = _run(["git", "show", "--unified=0", "--format=", "--no-color", sha], cwd=repo)
    keep = []
    for line in out.splitlines():
        if line.startswith(("diff --git", "index ", "--- ", "+++ ")):
            continue
        if line.startswith("@@"):
            keep.append(line.split("@@")[-1].strip() or "@@")
        elif line.startswith(("+", "-")) and line.strip() not in ("+", "-"):
            keep.append(line)
        if sum(len(k) for k in keep) > max_chars:
            keep.append("… (差异过长,已截断)")
            break
    return "\n".join(keep)


def collect_repo(repo, window, mine_only=True, diff_digest=True):
    """采集单个仓库在时间窗内的活动。无活动则返回 None。"""
    email, name = _identity(repo)
    branch = _run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=repo).strip() or "(游离头指针)"
    fmt = SEP.join(["%H", "%h", "%an", "%ae", "%aI", "%s", "%b"]) + REC
    base = ["git", "log", f"--since={window.git_since}", f"--until={window.git_until}",
            f"--pretty=format:{fmt}", "--all", "--no-merges"]

    raw_all = _run(base, cwd=repo)
    commits, others = [], 0
    seen = set()
    for rec in raw_all.split(REC):
        rec = rec.strip("\n")
        if not rec.strip():
            continue
        parts = rec.split(SEP)
        if len(parts) < 6:
            continue
        sha, short, an, ae, aiso, subject = parts[:6]
        body = parts[6] if len(parts) > 6 else ""
        if sha in seen:
            continue
        seen.add(sha)
        is_mine = (email and ae == email) or (name and an == name)
        if mine_only and not is_mine:
            others += 1
            continue
        files, add, dele = _commit_stat(repo, sha)
        commits.append({
            "sha": sha, "short": short, "author": an, "email": ae,
            "time": aiso, "epoch": to_epoch(aiso),
            "subject": subject.strip(), "body": body.strip(),
            "files": files, "insertions": add, "deletions": dele,
            "digest": _commit_diff_digest(repo, sha) if diff_digest else "",
        })
    commits.sort(key=lambda c: c["epoch"] or 0)

    # 工作区未提交的改动 —— 体现"正在做但还没交"的部分。
    #
    # 必须按文件 mtime 过滤到当天。工作区状态本身是**与日期无关的快照**:实测
    # 某个长期没清理的仓库积压了 324 个未跟踪文件,不过滤就会以压倒性分数抢走
    # "今日主项目",而那些文件今天根本没人碰过。
    staged, unstaged, untracked = [], [], []
    for line in _run(["git", "status", "--porcelain=v1"], cwd=repo).splitlines():
        if len(line) < 4:
            continue
        x, y, path = line[0], line[1], line[3:].strip().strip('"')
        if x == "?" and y == "?":
            untracked.append(path)
        else:
            if x != " ":
                staged.append(path)
            if y != " ":
                unstaged.append(path)

    def today_only(paths):
        out = []
        for rel in paths:
            full = os.path.join(repo, rel)
            try:
                if os.path.isdir(full):
                    # porcelain 会把整个未跟踪目录折成一条,逐个探里面的文件
                    hit = False
                    for dp, _, fns in os.walk(full):
                        for fn in fns:
                            if window.contains_epoch(os.path.getmtime(os.path.join(dp, fn))):
                                hit = True
                                break
                        if hit:
                            break
                    if hit:
                        out.append(rel)
                elif window.contains_epoch(os.path.getmtime(full)):
                    out.append(rel)
            except OSError:
                continue
        return out

    wt_today = {
        "staged": today_only(staged),
        "unstaged": today_only(unstaged),
        "untracked": today_only(untracked),
    }
    wt_stat = _run(["git", "diff", "--shortstat"], cwd=repo).strip()

    today_files = set(wt_today["staged"]) | set(wt_today["unstaged"])
    touched = sorted({f for c in commits for f in c["files"]} | today_files)

    # 今天既没提交、工作区也没有当日改动 —— 这个仓库今天没被碰过
    if not commits and not any(wt_today.values()):
        return None

    return {
        "path": repo,
        "name": os.path.basename(repo.rstrip("/")),
        "display": pathnorm.display_name(repo),
        "branch": branch,
        "identity": {"name": name, "email": email},
        "commits": commits,
        "others_commits": others,
        "worktree": {
            **wt_today,
            "shortstat": wt_stat,
            # 全量快照另存,供报告说明"另有 N 个历史遗留改动"
            "all_counts": {"staged": len(staged), "unstaged": len(unstaged),
                           "untracked": len(untracked)},
        },
        "touched_files": touched,
    }


def collect(window, hint_paths=(), scan_roots=(), mine_only=True):
    repos = discover_repos(hint_paths, scan_roots)
    out = []
    for r in repos:
        try:
            got = collect_repo(r, window, mine_only=mine_only)
        except Exception as e:  # 单个仓库炸掉不该拖垮整体采集
            out.append({"path": r, "name": os.path.basename(r), "error": str(e),
                        "commits": [], "touched_files": []})
            continue
        if got:
            out.append(got)
    return {"repos": out, "scanned": len(repos)}
