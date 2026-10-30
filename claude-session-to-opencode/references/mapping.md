# Claude Code → opencode 字段映射

两侧数据模型的对照表。本文档记录**为什么**这样映射，以及无法一一对应时的降级策略。
读代码时的权威来源：

- Claude Code 侧：`~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`（无公开 schema，靠实测）
- opencode 侧：`packages/schema/src/v1/session.ts`（`User` / `Assistant` / `Part` 定义）、
  `packages/core/src/session/sql.ts`（表结构）、`packages/opencode/src/cli/cmd/import.ts`（导入路径）

本表基于本机 252 个真实 transcript（28366 行）实测得出，样本内的所有形态都有对应处理。

## 为什么走 `opencode import`，不直写 SQLite

`opencode import <file.json>` 做三件手写 SQL 无法替代的事：

1. **schema 校验**：每条记录都过 `Schema.decodeUnknownSync(SessionV1.Info / SessionV1.Part)`。
   直写数据库会把不合法的 JSON 塞进 `data` 列，导入时不报错，等到 UI 读取才崩。
2. **项目绑定**：导入时用当前工作目录覆盖 `projectID` / `directory` / `path`
   （`import.ts:180-184`）。projectID 不是路径哈希，而是 `git-remote:<host>/<repo>` 的 SHA-1，
   没有 remote 时退化为首个根提交 hash（`packages/core/src/project.ts:73-115`）。手工算容易错。
3. **迁移兼容**：数据库有 38 个迁移，直写等于把自己钉在当前 schema 上。

代价：导入只写 `session` / `message` / `part` 三张表，不产生 `event` / `event_sequence` 记录。
这是 opencode 自身 `import` 的既有行为，会话照常显示和续聊（库里本来就有 36 个会话没有事件流）。

## 会话级（`info`）

| opencode 字段 | 来源 | 说明 |
|---|---|---|
| `id` | `stableID("ses", …, "claude-session:" + sessionId)` | 由源 session uuid 派生，重跑同一 transcript 得到同一个 id，`import` 走 `onConflictDoUpdate`，天然幂等 |
| `slug` | `claude-<uuid 前 8 位>` | opencode 正常是随机形容词+名词；这里带上来源便于识别 |
| `projectID` / `directory` / `path` | 占位（`global` / transcript 的 `cwd`） | **导入时被覆盖**，所以不需要算对 |
| `title` | `ai-title` 事件的最后一条 → 首条真实用户输入 → `Claude Code <uuid>` | Claude Code 会异步写入 AI 生成的标题 |
| `version` | transcript 的 `version`（Claude Code 版本号） | 字段语义是"哪个版本产生了这个会话"，填 Claude Code 版本比伪造 opencode 版本诚实 |
| `agent` | `--agent`（默认 `build`） | Claude Code 没有等价概念 |
| `model` | 见下方"模型标识" | |
| `cost` | `0` | Claude Code 不记录费用，编造不如留 0 |
| `tokens` | 各 assistant 消息求和 | |
| `time.created` / `time.updated` | 最早 / 最晚消息时间 | |
| `metadata.claudeCode` | 源 uuid、transcript 路径、cwd、Claude Code 版本、git 分支、转换时间 | 溯源信息，opencode 不解释 `metadata` 内容 |

## 消息与 part

Claude Code 把**一个模型回合拆成多行**，同回合的行共享 `message.id`，工具结果作为独立的
`user` 行穿插在中间。opencode 则是**一条 assistant 消息**挂多个 part。因此转换按
`message.id` 分组：

```
Claude Code                            opencode
─────────────────────────────────      ─────────────────────────────────
user(text)                        →    User message + text part
assistant(thinking) ┐                  ┌ step-start part
assistant(tool_use) ├ 同 message.id →  │ reasoning / text / tool parts
user(tool_result)   │  (结果穿插)      │ （tool part 就地补完状态）
assistant(tool_use) ┘                  └ step-finish part
```

| Claude Code 内容块 | opencode part | 说明 |
|---|---|---|
| `text`（assistant） | `text` | |
| `text`（user，`isMeta`） | `text` + `synthetic` + `ignored` | `isMeta` 是 Claude Code 代用户注入的上下文，不是人打的字 |
| `thinking` / `redacted_thinking` | `reasoning` | `signature` 存入 `metadata.anthropic.signature`，与 opencode 原生位置一致（`message-v2.ts:275`），Anthropic 续聊时可重放；其他 provider 忽略。本机样本 3039 个 thinking 块中 1782 个带签名 |
| `tool_use` | `tool`（`status: running`） | 后续 `tool_result` 行把它改写为 `completed` / `error` |
| `server_tool_use` | `tool` + `metadata.providerExecuted: true` | provider 侧执行的工具，结果直接出现在同一 assistant 回合内 |
| `tool_result` | 补完对应 `tool` part 的 `state` | 详见"工具配对" |
| `image`（user） | `file`（`data:` URL） | |
| 未知块类型 | `text`（原始 JSON） | 记入 `downgrades`，不静默丢弃 |

### 消息信封

| opencode 字段 | 来源 |
|---|---|
| `id` | `stableID("msg", …, message.id)` — 由 API message id 派生，确定性 |
| `parentID`（assistant） | 最近一条 user 消息的 id。transcript 若以 assistant 开头则合成一条 user 消息（`downgrades.synthesized-user-parent`） |
| `modelID` / `providerID`（assistant） | 该回合 transcript 里的模型名 |
| `mode` / `agent` | `--agent` |
| `path.cwd` / `path.root` | transcript 的 `cwd`（Claude Code 无 worktree 概念，两者相同） |
| `finish` | `stop_reason` 映射：`end_turn`/`stop_sequence`→`stop`、`tool_use`→`tool-calls`、`max_tokens`→`length`、其他→`other`（取值与库内实测的 `stop`/`tool-calls`/`length`/`other` 一致） |
| `time.created` / `time.completed` | 该回合首行 / 末行时间 |

## ID 生成规则

opencode 的 id 是 `<prefix>_<12 位 hex><14 位 base62>`，hex 部分是
`timestamp * 0x1000 + counter` 的大端编码，session 取按位取反（降序，新的排前面），
message / part 不取反（升序）。见 `packages/schema/src/identifier.ts`。

opencode 原生实现里后 14 位是随机的；转换器改成 seed 的 SHA-1，这样同一个 transcript 反复转换
得到完全相同的 id（除 `metadata.claudeCode.convertedAt`），`opencode import` 走
`onConflictDoUpdate` / `onConflictDoNothing`，重复导入不产生第二份数据。

两条硬约束，都不在 schema 里，但坏了就出问题：

1. **message id 必须随时间升序**。opencode 按 `(time_created, id)` 分页，
   并且 `MessageV2.latest` 用**最大 id** 判定"最近一条"（`message-v2.ts:585-601`）。
   本机 40 个 transcript 存在时间戳回退（最多倒退 203 秒，压缩会事后重写回合），
   所以转换器用一个单调递增的时钟对时间戳做钳制 —— 顺带保证每行的时间戳都严格大于前一行。
2. **part id 必须在所属消息内按插入顺序升序**。part 表只有
   `part_message_id_id_idx`，没有序号列，排序完全靠 id。所以 part id 在 `attach()` 里分配，
   而不是构造 part 时分配 —— 注入上下文 part 是最后构造、最先插入的，早期版本因此排错了序。

低 12 位的 counter 只用来打破同时间戳的平局，取值必须只依赖**当条记录本身**：

- message：`monotonic` 已经保证每行时间戳不同，唯一会撞车的是合成的 user 父消息
  （与它的 assistant 回合同一时刻产生），所以 user 取 0、assistant 取 1 即可。
- part：用 `message.parts.length`，天然是消息内递增的序号。

早期版本用一个全局自增计数器，结果 id 取决于"前面处理过多少条记录" —— 换 `--all-branches`
重跑时，同一条消息会拿到不同的 part id，重导入变成新增而不是更新。

## 工具配对

`tool_use` 与 `tool_result` 通过 Claude Code 的 `tool_use_id` 配对。转换器维护一张待补完表，
`tool_result` 到达时就地把 part 从 `running` 改写为终态：

- 正常结果 → `status: "completed"`，`output` 为拍平后的文本
- `is_error: true` → `status: "error"`，`error` 为同一文本
- 回合结束仍未补完 → `status: "error"`，说明"结果不在 transcript 里"，记 `downgrades.tool-without-result`
- 结果找不到对应调用（分支被跳过 / transcript 截断）→ 保留为 `ignored` 文本，记
  `downgrades.tool-result-without-call`

留 `pending`/`running` 是不能接受的：opencode 重放时会给它补一个
`[Tool execution was interrupted]`（`message-v2.ts:351-360`），因为 Anthropic 拒绝
没有配对结果的 `tool_use`。转换阶段就写清楚终态，不必依赖这个救场。

`tool_result.content` 有四种形态（实测）：字符串（4370）、`array[text]`（141）、
`array[image]`（17）、`array[tool_reference]`（38）。opencode 的 `ToolStateCompleted.output`
只接受字符串，所以：文本拼接；图片转成 `data:` URL 放进 `state.attachments` 并在正文留
`[image <mime>]` 占位；其他块保留原始 JSON。

### 工具名映射

Claude Code 用 PascalCase，opencode 注册小写 id（`packages/opencode/src/tool/registry.ts`）。
映射之后才能命中 opencode 的专用渲染器，而不是通用兜底。

| Claude Code | opencode | | Claude Code | opencode |
|---|---|---|---|---|
| `Bash` / `BashOutput` / `KillShell` / `PowerShell` | `bash` | | `TodoWrite` | `todowrite` |
| `Read` / `NotebookRead` | `read` | | `Task` / `Agent` | `task` |
| `Edit` / `MultiEdit` / `NotebookEdit` | `edit` | | `Skill` | `skill` |
| `Write` | `write` | | `WebFetch` | `webfetch` |
| `Glob` | `glob` | | `WebSearch` | `websearch` |
| `Grep` | `grep` | | `AskUserQuestion` | `question` |
| | | | `ExitPlanMode` | `plan_exit` |

`bash` 而非 `shell`：opencode 为兼容既有插件和已保存的权限，对外仍叫 `bash`
（`tool/shell/id.ts` 有明确注释）。

未在表内的名字**原样透传**并记入 `downgrades.tool-name-passthrough:<名字>`。MCP 工具
（`mcp__plugin_playwright_playwright__browser_navigate`）、Claude Code 独有工具
（`TaskCreate` / `TaskUpdate` / `ToolSearch` / `CronCreate`）都走这条路：opencode 没有对应
实现，猜一个名字会渲染成错误的工具，不如显示原名。

参数键改成 camelCase：`file_path`→`filePath`、`old_string`→`oldString`、
`new_string`→`newString`、`replace_all`→`replaceAll`、`notebook_path`→`filePath`、
`new_source`→`newString`。`Task` 的 `subagent_type` 在两侧都是 snake_case，不动。

## Token 用量

Anthropic 的 `usage` 把缓存 token 单列，`input_tokens` 已经是非缓存部分 —— 与 opencode
`getUsage` 归一化后的语义一致（`session.ts:338-380`），所以直接对应：

| opencode | Claude Code |
|---|---|
| `tokens.input` | `usage.input_tokens` |
| `tokens.output` | `usage.output_tokens` |
| `tokens.cache.read` | `usage.cache_read_input_tokens` |
| `tokens.cache.write` | `usage.cache_creation_input_tokens` |
| `tokens.reasoning` | **0** |
| `tokens.total` | 上述四项之和 |

`reasoning` 只能是 0：Claude Code 不把 thinking token 从 `output_tokens` 里拆出来，
拆不出就不能凭空造，否则等于重复计数。影响面是 UI 的 reasoning 明细为空，
以及 `isOverflow` 少算（它优先用 `tokens.total`，而 total 是对的，见 `overflow.ts:30`）。

## 模型标识

Claude Code 只记模型名，不记 provider（`claude-opus-5`、`glm-5.2`）。转换器跑
`opencode models` 反查哪些 provider 提供该模型，而不是硬编码 `anthropic` —— 这些 transcript
里大量出现经代理访问的第三方模型。同名多 provider 时取第一个并在输出里说明。

模型标识承担两种不同职责，因此分两条路解析：

- **assistant 消息上的模型**是历史记录。保留 transcript 里的原名，哪怕本机没有这个模型。
  252 个 transcript 里有 19 个中途换过模型，所以逐回合解析，不用统一值。
  这个差异是有意义的：opencode 会比较会话模型与每条 assistant 消息的模型，不一致时把
  reasoning 当纯文本重放而不是带签名的 thinking 块（`message-v2.ts:362-376`）。把历史改写成
  新模型会绕过这个保护，把签名发给验不了它的 provider。
- **会话上的模型**是续聊配置。opencode 续聊时优先读 `session.model`
  （`prompt.ts:614-633`），名字对不上会查不到模型。所以会话级模型一定落在本机能跑的模型上：
  transcript 的模型不可用时，退到 opencode 自己的兜底顺序（`~/.local/state/opencode/model.json`
  的最近使用列表 → 任意可用模型），并明确警告。

显式传 `--model` / `--provider` 时按用户意图记录，即使本机不可用（可能在另一台机器续聊），
只给出提示。`<synthetic>` 是 Claude Code 给本地生成回合（如 API 错误提示）的占位符，
不是模型名，这类回合归到 transcript 里最后一个真实模型上。

## 分支与压缩

`parentUuid` 构成链表，重试和编辑会留下废弃分支。默认只转换从最后一行回溯得到的**活跃链路**，
被跳过的行数会报出来，`--all-branches` 可以全转（会同时出现同一提问的多个版本）。
本机 87 个 transcript 存在废弃分支。

压缩边界 `system/compact_boundary` 携带 `logicalParentUuid` 跨过截断点，回溯时作为兜底。
opencode 的 `compaction` part 与之语义不同（它指向 opencode 自己的摘要机制），
所以不映射为 `compaction`，压缩摘要按普通消息处理。

`isCompactSummary` 的 user 行是压缩后注入的摘要正文，按普通用户文本转换（内容本身就是给
模型看的），不做特殊标记。

## 注入上下文（`attachment` / `system` 行）

Claude Code 的 `attachment` 行承载 hook 输出、skill 清单、agent 清单、task 提醒等注入内容
（实测 16 种，共 2817 行）；`system` 行承载斜杠命令回显、hook 摘要等。opencode 没有对应记录，
统一转成下一条 user 消息上的 `text` part，并打 `synthetic: true` + `ignored: true`：

- `synthetic` 让它不出现在提示历史 UI（`packages/app/src/utils/prompt.ts:44` 过滤）
- `ignored` 让它不参与回放给模型的上下文（`message-v2.ts:206`），续聊时不会重新注入一份
  过期的环境快照

`--attachments summary` 只保留一行标记，不带正文，用于压缩体积。

## 明确不映射的内容

| Claude Code | 原因 |
|---|---|
| `file-history-snapshot` / `file-history-delta` | Claude Code 自己的文件备份索引，指向 `~/.claude` 下的备份文件；opencode 的 `snapshot` part 存的是 git 对象 hash，语义不同，填错会让 revert 指向不存在的快照 |
| `mode` / `permission-mode` / `last-prompt` | UI 状态，非会话内容 |
| `queue-operation` | 排队操作记录，对应的消息本身已经在 transcript 里 |
| `pr-link` / `agent-name` | Claude Code 特有的辅助信息 |
| `system/turn_duration` / `stop_hook_summary` / `away_summary` | 计时与 hook 统计。`content` 非空的 system 行按注入上下文处理，这几类没有 `content` |
| `isSidechain` 子代理会话 | 本机样本中恒为 `false`（Claude Code 已改为独立文件记录子代理），无样本可验证 |

## 校验不变量

`validate.ts` 检查的项目，按"schema 会拦下"和"schema 拦不下"分两类：

schema 会拦（提前报错并指出具体 id，比 `import` 的首个 schema 错误更好定位）：
id 前缀、必填字段、时间戳为整数、`tokens` 各项为数值、`completed` 工具有 `output`/`title`/`time`。

schema 拦不下（导入成功但续聊时出问题）：
message id 升序、part id 升序、assistant 的 `parentID` 指向更早的消息、
`sessionID`/`messageID` 自洽、没有 part 停在 `pending`/`running`。

## 空会话

Claude Code 会为"打开又关掉、没提过问"的会话留下只有 `attachment` / `system` 行的文件
（本机 8 个）。这类文件里的注入上下文会挂在一条尾随 user 消息上，仍然可以导入；
真正一条会话记录都没有的，`convert.ts` 以退出码 2 结束并说明原因，不产出无法渲染的空会话。
