---
name: claude-session-to-opencode
description: Migrate a Claude Code conversation into opencode as a real, resumable session — messages, thinking blocks, tool calls and results all preserved. Use this whenever the user wants to move, convert, import, migrate or "continue in opencode" a Claude Code chat/session/history/transcript, mentions ~/.claude/projects or .jsonl transcripts alongside opencode, asks to see a Claude Code conversation inside the opencode TUI/web UI, or wants to pick up a Claude Code session with a different model. Also use it when they ask which Claude Code sessions exist for a directory, since listing is this skill's first step.
---

# Claude Code 会话 → opencode 会话

把一段 Claude Code 对话搬进 opencode，成为可以打开、可以接着聊的会话。

## 交互流程

**不要自己猜要转哪个会话。** 除非用户已经点明了目录或会话，按下面的顺序问：

1. **列出项目目录** —— `bun $SKILL_DIR/scripts/list.ts`
   输出每个目录的真实工作目录、会话数、最近活动时间。请用户选一个。
2. **列出该目录的会话** —— `bun $SKILL_DIR/scripts/list.ts <工作目录或目录名>`
   输出会话 id、标题、消息数（以及其中在活跃分支上的条数）、时间区间。请用户选一个或多个。
3. **确认落点** —— 会话会绑定到**执行 `opencode import` 时所在的目录**。默认用 transcript
   里记录的 `cwd`（脚本会直接把命令打出来）。只有在用户想换目录时才需要确认。
4. **转换 → 校验 → 导入**，见下节。
5. **报告结果** —— 新会话 id、绑定目录、打开方式，以及转换报告里的降级项。

用户已经说了"转 opencode 项目下最近那个会话"这类信息时，跳过对应的询问步骤，但仍要在动手前
把选中的会话报一遍，避免转错。

## 先定位技能目录

下文 `$SKILL_DIR` 指本技能所在目录：

```bash
SKILL_DIR=$(for d in \
  ~/.claude/skills/claude-session-to-opencode \
  ~/.agents/skills/claude-session-to-opencode \
  ~/.config/opencode/skills/claude-session-to-opencode \
  ./.claude/skills/claude-session-to-opencode \
  ./.opencode/skills/claude-session-to-opencode; do [ -d "$d" ] && echo "$d" && break; done)
```

需要 Bun（脚本用 `bun` 执行）和已安装的 `opencode` CLI。

## 三步执行

```bash
# 1. 转换（只读 Claude Code 侧数据，绝不修改）
bun $SKILL_DIR/scripts/convert.ts <transcript.jsonl> --report <报告路径.json>

# 2. 校验（可选但推荐，比 import 的 schema 报错更容易定位问题）
bun $SKILL_DIR/scripts/validate.ts <上一步输出的 .json>

# 3. 导入（必须在目标目录下执行）
cd <目标工作目录> && opencode import <上一步的 .json>
```

`convert.ts` 默认把结果写到 `~/.local/share/opencode/claude-import/`（跟着 `XDG_DATA_HOME`），
并在最后打印可直接复制的 `cd … && opencode import …` 命令。**不要写到临时目录** ——
导入失败时还要能回看这个文件。用 `--report` 存一份转换报告，里面有逐项统计和降级记录。

转换是**确定性**的：同一个 transcript 反复转换得到完全相同的 id，重复导入只会更新已有会话，
不产生第二份。所以出问题重跑是安全的。

有两件事重导入**改不了**，因为 `import` 对消息和 part 用的是 `onConflictDoNothing`：

- 换了 `--all-branches`、`--attachments` 等影响内容的参数后重导入，只会补进新消息，
  已存在的消息不会被改写。
- 在错误的目录下导入过之后，重新在正确目录导入可以修正项目绑定（session 行是
  `onConflictDoUpdate`），但消息内容不变。

要真正重来，先 `opencode session delete <sessionID>`（级联删掉消息和 part），再重新导入。

### 常用参数

| 参数 | 用途 |
|---|---|
| `--out <file>` | 指定输出路径 |
| `--model <id>` / `--provider <id>` | 覆盖模型。显式指定时按用户意图记录，即使本机没有该模型 |
| `--agent <name>` | 记在消息上的 agent，默认 `build` |
| `--all-branches` | 连废弃分支（重试、编辑留下的旧版本）一起转 |
| `--attachments summary` | 注入上下文只留一行标记，不带正文，用于压缩体积 |
| `--report <file>` | 写出 JSON 转换报告 |
| `--no-verify-model` | 跳过 `opencode models` 反查（离线或批量转换时提速） |

## 读输出时该看什么

`convert.ts` 把可能影响结果的信息分成两档，都不要忽略：

- **note** —— 做了选择但没有损失。典型是同一模型名有多个 provider 提供，取了第一个。
- **warning** —— 有实际影响。最常见两种：
  - *"N conversational line(s) are on abandoned branches"*：默认只转活跃链路。用户如果就是想
    看某次被重试掉的回答，才需要 `--all-branches`。
  - *"Model X is not available in this opencode install"*：会话级模型退到了本机可用的模型
    （assistant 消息仍保留原模型名）。如果用户想用别的模型续聊，用 `--model` 明确指定。
- **downgrades** —— 无法一一对应但已保留数据的项目，按出现次数排序。
  `tool-name-passthrough:*` 最常见（MCP 工具、Claude Code 独有工具在 opencode 里没有对应实现，
  原样透传比猜一个名字更安全）；`tool-without-result` 表示工具调用在 transcript 里没有结果，
  已写成错误态。这些通常不需要处理，报告给用户即可。

退出码：0 正常；1 参数或文件错误；2 该 transcript 没有任何对话记录（打开又关掉的空会话，
本机 252 个里有这类文件），不是故障，直接跳过。

## 验证转换结果

导入后确认会话真的能用，而不是只写进了数据库：

```bash
cd <目标目录> && opencode        # TUI 里应能看到并打开这个会话
```

要在不动用户主库的前提下验证，用 `OPENCODE_DB` 指到一个独立文件（相对路径会落在
opencode 数据目录里，用绝对路径更明确）：

```bash
OPENCODE_DB=/abs/path/scratch.db opencode import <file.json>
OPENCODE_DB=/abs/path/scratch.db opencode serve --port 4399
curl -s "http://127.0.0.1:4399/session?directory=<目标目录>&scope=project"
curl -s "http://127.0.0.1:4399/session/<sessionID>/message?directory=<目标目录>"
```

`opencode export <sessionID>` 输出的就是 `import` 吃的同一种格式，需要对照真实会话长什么样时
可以拿它当基准。

## 边界与已知取舍

- **Claude Code 侧只读**。转换器不写、不改、不删 `~/.claude` 下的任何东西。
- **不直写 SQLite**。走 `opencode import` 是为了让 opencode 自己的 schema 校验和项目绑定逻辑
  生效；手写数据库行会跳过校验，产出 UI 渲染不了的会话。理由详见
  [references/mapping.md](references/mapping.md)。
- **`tokens.reasoning` 恒为 0**。Claude Code 不把 thinking token 从 `output_tokens` 里拆出来，
  拆不出就不编造。总量（`tokens.total`）是准的。
- **费用为 0**。Claude Code 不记录费用。
- **文件历史快照不迁移**。Claude Code 的备份索引指向 `~/.claude` 下的文件，opencode 的
  `snapshot` part 存的是 git 对象 hash，语义不同，填错会让 revert 指向不存在的快照。
- **Anthropic thinking 签名会带过去**，放在 opencode 原生使用的
  `metadata.anthropic.signature` 位置，所以用 Anthropic 模型续聊时思考块可以正常重放。

字段级对照、ID 生成规则、工具映射表、以及每一项降级策略的原因，见
[references/mapping.md](references/mapping.md)。改脚本前先读它。
