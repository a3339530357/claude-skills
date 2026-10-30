---
name: claude-history-search
description: 在 Claude Code 的本机历史对话记录(.jsonl)中按关键词搜索，找出关键词出现在哪些项目、哪些 session 里，并给出上下文片段。当用户说"搜索关键词 X"、"我之前在哪个对话/项目里聊过 X"、"查一下历史对话里有没有 X"、"在 .claude/projects 里找 X"、"哪个 session 提到过 X"，或想回溯/检索自己过去和 Claude 的对话内容时，都应使用本技能。涉及检索 Claude Code 历史会话、past conversations、聊天记录、session 时一律优先使用本技能，即使用户没有明确说"技能"二字。
---

# Claude Code 历史对话搜索

在本机 Claude Code 的对话存档（`.claude/projects/**/*.jsonl`，每个 `.jsonl` 文件是一次 session）中检索关键词，定位它出现在哪些项目、哪些 session，并展示命中处的上下文。

## 核心：先确定搜哪份数据

同一台机器上可能存在两份对话存档，**路径选择按下面的优先级**，不要凭空假设：

1. **用户显式指定的路径最优先**。用户给了目录（如 `/mnt/c/Users/a3351/.claude/projects` 或某个具体路径），就用 `--path` 传入。
2. **用户指定了数据源**（"搜 Windows 那份" / "搜 WSL 那份"），用 `--source win` 或 `--source wsl`。
3. **都没指定时，跟随当前 Claude Code 的运行环境自动选择**：
   - Windows 原生启动 → `C:\Users\a3351\.claude\projects`
   - WSL 里启动 → `/home/a33511/.claude/projects`（即 `\\wsl.localhost\Ubuntu\home\a33511\.claude\projects`）

脚本已内置这套逻辑和环境检测，直接调用即可，无需自己判断环境。

> 注意：本次会话开头用户曾让你搜 Windows 那份（`/mnt/c/...`，约 4426 个对话），而 WSL 本地那份约 525 个。两份内容不同。如果用户没说清且当前结果偏少/偏多不符合预期，可主动反问要搜哪一份。

## 怎么用

直接运行脚本，把用户的关键词传进去：

```bash
python3 ~/.claude/skills/claude-history-search/scripts/search.py <关键词...> [选项]
```

常用形式：

```bash
# 单关键词
python3 .../search.py 缓存穿透

# 多关键词：默认"任一命中即算"(OR)；加 --all 则要求同一对话同时包含全部词(AND)
python3 .../search.py 缓存穿透 布隆过滤器
python3 .../search.py redis 分布式锁 --all

# 指定数据源 / 路径（对应上面的优先级 1、2）
python3 .../search.py 限流 --source win
python3 .../search.py 限流 --path /mnt/c/Users/a3351/.claude/projects

# 只看前 N 个、或要结构化结果
python3 .../search.py 限流 --limit 10
python3 .../search.py 限流 --json
```

把脚本的位置参数 `<关键词>` 换成用户实际要找的词。词里带空格就用引号包起来。

## 输出与汇报

脚本默认输出已按**项目分组**，每个 session 一行（标题、命中次数、日期、命中的词、上下文片段）。标题的取法：优先用存档里的 AI 标题（`"type":"ai-title"` 行，即 `/resume` 列表显示的那个）；没有 AI 标题的会话回退显示第一条真实用户消息的开头（已清洗 skill 注入、system-reminder 等噪音，斜杠命令会显示成 `/命令 参数`）；两者都没有才显示"（无标题）"。`--json` 输出里对应 `title` 字段。给用户汇报时：

- 先给一句总览：命中多少个对话、跨多少个项目、搜的是哪份数据。
- 再呈现结果，通常整理成表格更清晰（项目 / session / 时间 / 标题 / 主题或上下文），标题列能帮用户快速认出目标对话，尤其命中较多时。
- 命中为 0 时，提示可换近义词、或用 `--source` 切换到另一份数据源再试，不要直接判定"没有"。
- **汇报末尾必须附上恢复命令**。从命中里挑出最可能是用户要找的那一个对话（命中次数最多、标题最贴合关键词的），在汇报最后给出一段可直接复制执行的恢复命令，格式固定为：

  ```bash
  cd <该 session 所属的项目目录>
  claude --resume <完整 session ID>
  ```

  例如：

  ```bash
  cd /home/a33511/project/testt
  claude --resume 5adf0448-354a-4b38-b15a-ac6a998cab3b
  ```

  项目目录取分组标题（📁 后面的路径），session ID 用输出里的完整 ID（带全部横杠段，不要只给前 8 位）。只给最可能的那一个，不要每条命中都列一遍；若几条难分高下，可再补一句"如果不是这个，另一个候选是 xxx"。若项目路径的风格（WSL 的 `/home/...` 或 Windows 的 `C:\...`）与当前运行环境不一致，提醒用户到对应环境的终端里执行。命中为 0 时不用给。

## 后续动作

用户常会接着想看某个 session 的完整内容。命中结果里的 `file` 就是该 session 的 `.jsonl` 绝对路径，可据此进一步：读取该文件、提取某段对话、或导出成可读 Markdown。需要时再做，不必每次都主动导出。

## 跨环境提示

本技能装在某个 `.claude/skills` 下只对该环境的 Claude Code 生效。若用户在 Windows 和 WSL 两边都用 Claude Code 且都想用本技能，需在两边各装一份；脚本本身已兼容两种环境的路径，无需改代码。
