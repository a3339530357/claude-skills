"""会话分类:工作 / 学习 / 无关 / 元任务。

实测当天 12 个 ChatGPT 会话里混着番剧推荐和预制菜加热,占 6699 字。留档口径
下不能直接删(那就不叫留档了),但也不能让它们污染正文,所以打标签分区呈现。

判定刻意不写死"番剧""美食"这类词表 —— 那只对某一天有效。改用结构性信号:
有没有技术锚点、有没有本项目特有的包名、是不是提问式学习。项目特有标识由
git 采集器从实际仓库推导后传进来,因此换个项目、换个技术栈同样适用。
"""

import re

from . import textclean

# 通用技术词。命中说明"沾技术",但不足以区分工作还是学习。
TECH_HINTS = {
    "java", "spring", "mybatis", "maven", "gradle", "jvm", "sql", "数据库", "达梦", "dm",
    "oracle", "mysql", "postgres", "redis", "mq", "kafka", "docker", "k8s", "nginx",
    "linux", "shell", "bash", "git", "commit", "分支", "merge", "部署", "war", "jar",
    "tomcat", "apusic", "接口", "api", "http", "json", "xml", "yml", "配置", "日志",
    "异常", "报错", "bug", "调试", "测试", "前端", "vue", "react", "python", "node",
    "npm", "typescript", "算法", "线程", "并发", "缓存", "索引", "事务", "分页",
}

# 学习/求解释的句式
_LEARN_PATTERNS = [
    re.compile(r"(是什么|什么是|啥意思|是啥)"),
    re.compile(r"(有什么|的)?区别"),
    re.compile(r"为什么|为啥|怎么理解|原理"),
    re.compile(r"(怎么|如何)(用|使用|写|实现|理解)"),
    re.compile(r"详解|讲解|解释一下|科普|入门|教程|最佳实践|规范|建议"),
]

# 元任务:关于本套总结工具自身的讨论
_META_PATTERNS = [
    re.compile(r"(日报|周报|每日总结|工作总结).{0,10}(skill|技能|脚本|生成)"),
    re.compile(r"skill.{0,12}(创建|生成|编写|优化)"),
    re.compile(r"提示词|prompt.{0,6}(优化|润色|重写)"),
]

WORK, LEARN, META, OFF = "work", "learn", "meta", "off-topic"

LABEL_CN = {WORK: "工作", LEARN: "学习", META: "元任务", OFF: "无关"}


class Classifier:
    """按当天实际项目上下文来判定,而非固定词表。

    project_tokens: 从 git 仓库推导出的本项目特有标识(包名前缀、仓库名、
                    当天改动的文件名等)。命中即强工作信号。
    commit_epochs:  当天提交时刻,用于时间邻近加权。
    """

    def __init__(self, project_tokens=None, commit_epochs=None, near_window=3600):
        self.project_tokens = [t.lower() for t in (project_tokens or []) if t and len(t) >= 3]
        self.commit_epochs = sorted(commit_epochs or [])
        self.near_window = near_window

    def _near_commit(self, epochs):
        """会话时间是否贴着某次提交(默认一小时内)。"""
        if not self.commit_epochs or not epochs:
            return False
        for e in epochs:
            if e is None:
                continue
            for c in self.commit_epochs:
                if abs(e - c) <= self.near_window:
                    return True
        return False

    def classify(self, title, texts, epochs=None, signals=None):
        """返回 (label, reasons, scores)。"""
        # blob 只用对话内容,不含 title(项目名)。title 总含项目目录名,若纳入
        # 匹配,每个活跃项目的会话都会命中 hit_proj,把"你好"这类试验对话误判
        # 成工作。项目标识必须在对话内容里出现才算"在聊这个项目"。
        blob = " ".join(list(texts or []))
        low = blob.lower()
        sig = signals if signals is not None else textclean.extract_signals(blob)

        work, learn = 0, 0
        reasons = []

        hit_proj = [t for t in self.project_tokens if t in low]
        if hit_proj:
            work += 5
            reasons.append(f"含本项目标识 {', '.join(hit_proj[:3])}")

        if sig.get("site") or sig.get("exception"):
            work += 3
            token = (sig.get("exception") or sig.get("site"))[0]
            reasons.append(f"含异常/定位信息 {token}")
        if sig.get("class"):
            work += 2
            reasons.append(f"含业务类 {sig['class'][0]}")
        if sig.get("file"):
            work += 2
        if sig.get("table"):
            work += 2
            reasons.append("含 SQL 表操作")

        if self._near_commit(epochs):
            work += 2
            reasons.append("时间贴近当天提交")

        tech_hits = {t for t in TECH_HINTS if t in low}
        if tech_hits:
            work += 1
            learn += 1

        if any(p.search(blob) for p in _LEARN_PATTERNS):
            learn += 3
            reasons.append("提问式求解释")
        if tech_hits and not hit_proj and not sig.get("site"):
            learn += 2

        if any(p.search(blob) for p in _META_PATTERNS):
            return META, ["讨论总结工具自身"], {"work": work, "learn": learn}

        # 无技术信号时,只有连项目标识都没命中才判无关。
        # 否则"继续"推进长任务这类会话(内容无信号,但 cwd 是活跃项目)会被误判 --
        # 实测运行本采集技能本身的工作就因内容多为"继续"被判 off-topic。
        if not tech_hits and not sig and work < 5:
            return OFF, ["无任何技术信号"], {"work": work, "learn": learn}

        if work >= 5 and work >= learn:
            return WORK, reasons, {"work": work, "learn": learn}
        if learn >= 4 and learn > work:
            return LEARN, reasons or ["技术学习,未涉及本项目代码"], {"work": work, "learn": learn}
        if work >= 3:
            return WORK, reasons, {"work": work, "learn": learn}
        if learn >= 3:
            return LEARN, reasons, {"work": work, "learn": learn}
        return OFF, reasons or ["技术信号过弱"], {"work": work, "learn": learn}


def derive_project_tokens(repos):
    """从 git 采集结果里推导本项目的特有标识。

    取仓库名,以及当天改动的 Java 包路径前缀(如 com/cgnpc/fas -> com.cgnpc.fas),
    这些串出现在对话里几乎可以断定是在聊本项目。
    """
    tokens = set()
    for r in repos or []:
        name = (r.get("name") or "").strip()
        if name and len(name) >= 3:
            tokens.add(name)
        for f in r.get("touched_files") or []:
            m = re.search(r"(?:^|/)(?:src/main/java/|src/)?((?:com|cn|org)/[a-z0-9_]+/[a-z0-9_]+)/", f)
            if m:
                tokens.add(m.group(1).replace("/", "."))
            base = f.rsplit("/", 1)[-1]
            if base.endswith((".java", ".xml", ".yml", ".vue", ".ts")) and len(base) > 8:
                tokens.add(base)
    return sorted(tokens)
