---
name: claude-jsonl-format
description: Claude Code 会话 .jsonl 存档的格式字典与提取工具。当用户要读取、解析、提取、转换 ~/.claude/projects 下的会话记录，问"jsonl 里有哪些字段""这个会话文件怎么解析""从历史对话里把某段内容导出""还原某次请求到底发了什么"，或需要按 message.id 归并对话、按时间筛选会话、跨项目找会话时使用。也适用于编写任何读写 Claude Code transcript 的脚本前先确认结构。即使没提"jsonl"三个字，只要涉及读取 Claude Code 的历史对话文件，都应先查本技能。
---

# Claude Code `.jsonl` 会话存档格式

Claude Code 把每个会话写成一个 `.jsonl` 文件：**一行一个 JSON 对象，没有外层数组，没有公开 schema**。字段会随版本漂移，所以任何解析动作之前，先跑一次普查确认当前版本的真实结构，不要凭记忆写死字段名。

```bash
node <skill>/scripts/survey.mjs ~/.claude/projects/<项目>/<会话>.jsonl
```

## 位置

```
~/.claude/projects/<编码后的cwd>/<session-uuid>.jsonl
~/.claude/projects/<编码后的cwd>/<session-uuid>/     # 同名目录，放附件与工具结果
    custom-title.json
    tool-results/*.txt
```

目录名是 cwd 的编码：`D:\project\tests` → `D--project-tests`，`/home/x/proj` → `-home-x-proj`（盘符和分隔符都换成 `-`）。**不要从目录名反解路径**，每条记录里的 `cwd` 才是权威来源。

同一台机器可能存在多份存档（Windows 原生一份、WSL 里一份），内容不同。用户没说清时先确认读哪一份。

## 两套并存的数据模型

这是最容易搞错的地方。同一个文件里有两类记录，服务两个完全不同的目的：

| | 会话事件流 | API 请求快照 |
|---|---|---|
| 记录类型 | `user` `assistant` `system` `attachment` | `api-request` `api-request-blob` `api-request-shape` |
| 用途 | 给人看的对话 | 实际发给模型的线上 payload |
| 结构 | `uuid` + `parentUuid` 树 | 内容寻址 + 增量引用，需要递归还原 |
| 何时用 | 绝大多数场景 | 需要 system prompt / tools / 缓存标记时 |

**读对话历史只用左边那套。** 右边的 `api-request` 系列是调试用的，还原成本高且有缺口（见 `references/api-requests.md`）。

## 记录类型速查

19 种，按用途分三组。完整字段见 `references/records.md`。

**对话内容（有 uuid / parentUuid）**

| type | 说明 |
|---|---|
| `user` | 用户输入、`tool_result`、系统注入的 meta 内容 |
| `assistant` | 模型输出，一个回合拆成多行，共享 `message.id` |
| `system` | 边界与提示：`compact_boundary` `turn_duration` `local_command` `stop_hook_summary` `informational` |
| `attachment` | 环境快照、文件引用等，`rendered` 是渲染后的文本 |

**会话状态（无 uuid，只有 sessionId）**

`mode` `permission-mode` `ai-title` `custom-title` `agent-name` `last-prompt` `cost-state` `tools-used` `atis-latch` `queue-operation` `file-history-snapshot` `file-history-delta`

**API 调试**

`api-request` `api-request-blob` `api-request-shape`

## 三个必须先知道的坑

### 1. 一个 assistant 回合 = 多行

模型一次回复里有 thinking、text、tool_use，Claude Code **每块写一行**，全部共享同一个 `message.id`；中间还夹着 `tool_result` 的 `user` 行。实测某会话 1448 条 assistant 记录只对应 718 个 `message.id`，其中 516 个跨多行（2–5 行）。

按行遍历会得到碎片。**按 `message.id` 分组**才能还原成一个回合。

### 2. `parentUuid` 指向任意带 uuid 的记录

父节点可能是 `user`、`assistant`、`system`，也可能是 `attachment`。只把消息类型当候选，会误判成大量悬空引用（我实测时误判出 470 条"断链"，实际是 0 条）。

正确做法：把所有带 `uuid` 的记录放进同一个 Map 再查。

### 3. 时间是 UTC，文件时间不可靠

`timestamp` 一律 ISO-8601 UTC。会话 resume 会往**旧文件**里追加新内容，所以文件 mtime、目录日期、文件名日期都不能用来筛会话——只能逐条读 `timestamp`。按本地日筛选要自己换算时区（UTC+8 时，本地日 D 对应 `[D-1T16:00Z, DT16:00Z)`）。

## 内容块类型

`message.content` 可能是字符串，也可能是块数组。块类型：`text` `thinking` `redacted_thinking` `tool_use` `tool_result` `image` `server_tool_use`，以及 system 消息里的 `tool_addition` / `tool_removal`。字段细节见 `references/content-blocks.md`。

## 两个脚本

脚本在本技能目录的 `scripts/` 下。下面用 `$SKILL` 代指该目录，先定位它：

```bash
SKILL=$(for d in ~/.claude/skills/claude-jsonl-format \
                  ~/.agents/skills/claude-jsonl-format \
                  ./.claude/skills/claude-jsonl-format; do
  [ -d "$d" ] && echo "$d" && break
done)
```

**`scripts/survey.mjs`** —— 解析前先跑。输出记录类型分布、每种类型的字段并集、content 块统计、模型分布、父链完整性。

```bash
node "$SKILL/scripts/survey.mjs" <file.jsonl | 目录> [--json]
```

**`scripts/extract.mjs`** —— 三种模式：

```bash
# 导出成可读 Markdown（默认，已按 message.id 归并）
node "$SKILL/scripts/extract.mjs" <file.jsonl> --mode dialog --out conv.md

# 列出所有 API 请求（索引、模型、keep/tail）
node "$SKILL/scripts/extract.mjs" <file.jsonl> --mode list

# 还原第 N 次请求的完整 payload
node "$SKILL/scripts/extract.mjs" <file.jsonl> --mode request --index 42 --out req.json
```

`dialog` 模式默认含 tool_use/tool_result，`--thinking` 加思考内容，`--meta` 加 attachment 与 system 记录。

## 常见任务

**找某个会话**：目录名是编码后的 cwd，但更可靠的是扫所有 `.jsonl` 里的 `cwd` 字段。

**统计用了哪些工具**：`tool_use` 块的 `name`，或直接读 `tools-used` 记录。

**算 token / 成本**：`cost-state` 记录有 `totalCostUSD` 与 `modelUsage`；`api-request` 的 `params` 有 `max_tokens`。

**找压缩发生在哪**：`system` 且 `subtype=compact_boundary`，`compactMetadata` 里有压缩前后的 token 数。**但 `postTokens` 不含 system prompt 和工具定义**，通常只有压缩后真实上下文的 1/3——要测真实值取压缩后第一条请求的 `usage`。

**区分模型**：`assistant.message.model`。注意经第三方网关（如 DeepSeek）写的 thinking 块，`signature` 为空且 `thinking` 是**单个空格 `" "`**（不是空串、不是 null）。`if (!thinking)` 判不出来，必须 `.trim()`。这种块切回官方 API 会被拒（`each thinking block must contain non-whitespace thinking`）。

**处理超长文件**：29 MB / 6000 行的会话很常见。用流式逐行读，不要 `readFileSync` 后整体 `JSON.parse`；也不要把整个文件塞进上下文。

## 边界

本技能只管**格式与提取**。以下已有专门技能，不要重复实现：

- 关键词搜索历史对话 → `claude-history-search`
- 转成 opencode 会话 → `claude-session-to-opencode`
- 抓活的 HTTP 请求 → `capture-cc-v1-messages`

## 参考文档

| 文件 | 内容 |
|---|---|
| `references/records.md` | 19 种记录类型逐字段说明 |
| `references/content-blocks.md` | 内容块与 system 消息结构 |
| `references/api-requests.md` | 请求去重与还原算法，含已知缺口 |
| `references/recipes.md` | 常见提取任务的代码片段 |
