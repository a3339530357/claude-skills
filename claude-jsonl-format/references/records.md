# 记录类型逐字段

基于本机 32 个真实会话、16883 条记录实测（Claude Code 2.1.30x–2.1.31x）。字段会随版本增加，**先跑 `scripts/survey.mjs` 核对**再依赖具体键名。

分三组：对话内容（带 `uuid`/`parentUuid`）、会话状态（只带 `sessionId`）、API 调试。

---

## 一、对话内容

这一组都带 `uuid` 和 `parentUuid`，构成一棵消息树。**`parentUuid` 可以指向任意带 `uuid` 的记录**——包括 `attachment` 和 `system`，不只是 user/assistant。只按消息类型建索引会误判成大量断链。

共同字段：

| 字段 | 说明 |
|---|---|
| `uuid` | 本条记录的唯一 id |
| `parentUuid` | 上一条记录的 uuid；`null` 表示会话根 |
| `timestamp` | ISO-8601 UTC |
| `sessionId` / `session_id` | 会话 id（两种写法都出现过） |
| `cwd` | 工作目录，**权威来源**，不要从目录名反解 |
| `gitBranch` | 当时的 git 分支 |
| `version` | 产生这条记录的 Claude Code 版本 |
| `userType` | 通常 `external` |
| `entrypoint` | `cli` / `sdk-cli` 等 |
| `isSidechain` | 是否为子代理（subagent）分支 |
| `slug` | 会话短名 |

### `user`

| 字段 | 说明 |
|---|---|
| `message` | `{ role: "user", content }`，content 可能是字符串或块数组 |
| `isMeta` | `true` 表示这条不是人打的，是系统代注入的上下文 |
| `isCompactSummary` | `true` 表示这是压缩生成的摘要，不是真实对话 |
| `toolUseResult` | 当 content 是 `tool_result` 时，这里是结构化的工具返回值 |
| `sourceToolAssistantUUID` | tool_result 对应哪条 assistant 的 tool_use |
| `permissionMode` | 当时的权限模式 |
| `promptSource` / `promptId` | 提示来源与 id |
| `origin` / `turnOrigin` / `turnPosition` | 该轮从哪来、在第几位 |
| `interruptedMessageId` | 被中断的消息 id |
| `refusedMessageId` | 被拒绝的消息 id |
| `isVisibleInTranscriptOnly` | 只在 transcript 里可见（不进 API） |
| `sandboxed` | 是否在沙箱里执行 |

**判断一条 user 记录是真人输入还是工具回传**：看 content 里是不是只有 `tool_result` 块。真人输入一定是 `text`。

### `assistant`

| 字段 | 说明 |
|---|---|
| `message` | `{ id, model, role: "assistant", content, stop_reason, usage }` |
| `message.id` | **同一次模型回复的多行共享这个 id**，分组就靠它 |
| `requestedModel` / `advisorModel` | 请求的模型名（网关重定向时和 `message.model` 可能不同） |
| `effort` / `perTurnEffort` | 推理强度 |
| `thinkingDurationMs` / `thinkingDisplay` | 思考耗时与展示方式 |
| `apiBlockIndex` | 该块在这次响应里的序号 |
| `requestRef` | 指向 `api-request` 的 id |
| `requestId` | API 层的请求 id |
| `error` / `isApiErrorMessage` / `apiErrorStatus` / `apiErrorIsTransient` | 出错时的诊断信息 |
| `truncatedAfterOutput` / `streamCutCause` / `isAbortedMidStream` | 流被截断的标记 |
| `attributionSkill` / `attributionPlugin` / `attributionMcpServer` / `attributionMcpTool` | 该块由哪个技能/插件/MCP 产生 |
| `wireToolInputs` / `wireIngestContext` | 传输层的工具入参快照 |

**注意 `message.id` 的分组规则**：一次回复里 thinking / text / tool_use 各占一行，`tool_result` 的 user 行插在中间。实测某会话 1448 条 assistant 记录对应 718 个 `message.id`，516 个跨多行，最多 5 行。

### `system`

按 `subtype` 分五种，字段差异较大：

| subtype | 用途 | 特有字段 |
|---|---|---|
| `compact_boundary` | 压缩发生的分界线 | `compactMetadata`（见下）、`logicalParentUuid` |
| `turn_duration` | 一轮结束的耗时统计 | `durationMs`、`messageCount`、`pendingBackgroundAgentCount` |
| `local_command` | 用户跑了斜杠命令 | `content`（含 `<command-name>` 等标签）、`commandRun` |
| `stop_hook_summary` | Stop 钩子的执行结果 | `hookCount`、`hookInfos`、`hookErrors`、`preventedContinuation`、`stopReason`、`hasOutput`、`toolUseID` |
| `informational` | 普通提示 | `content`、`level` |

`compactMetadata` 结构：

```json
{
  "trigger": "manual",
  "preTokens": 312572,
  "postTokens": 13445,
  "cumulativeDroppedTokens": 299127,
  "durationMs": 90180,
  "preCompactDiscoveredTools": ["TaskStop", "WebSearch"],
  "preservedSegment": { "headUuid": "...", "tailUuid": "..." }
}
```

`compact_boundary` 的 `parentUuid` 是 `null`，真正的上一条在 `logicalParentUuid` 里。**按 parentUuid 遍历时会在这里断开**，需要特殊处理。

#### `postTokens` 不是「压缩后的上下文大小」

这是最容易读错的字段。实测交叉验证（某会话三次压缩）：

| 次数 | `preTokens` | `postTokens` | 压缩后首次请求的实际 usage |
|---|---:|---:|---:|
| 1 | 312,572 | 13,445 | **46,712** |
| 2 | 200,978 | 10,674 | **31,437** |
| 3 | 241,811 | 13,585 | **37,172** |

`preTokens` 和压缩前最后一次请求的 `usage` 几乎相等（312,637 / 200,907 / 240,832），但 `postTokens` 只有实际值的约 1/3——因为它**只算摘要加保留段，不含 system prompt 和工具定义**。

想回答「压缩后上下文有多大」，要去读压缩之后第一条 `api-request` 对应 assistant 消息的 `message.usage`，不能直接用 `postTokens`。

`cumulativeDroppedTokens` 是**累计**丢弃量，不是单次：299,127 → 489,431 → 717,657。

### `attachment`

系统注入的环境上下文，不是对话。

```json
{
  "attachment": {
    "type": "environment",
    "snapshot": {
      "workingDirectory": "D:\\project\\tests",
      "isWorktree": false, "isGitRepo": false,
      "additionalWorkingDirectories": [],
      "platform": "win32",
      "shell": "PowerShell (primary); ...",
      "osVersion": "Windows 11 Pro 10.0.29671"
    }
  },
  "rendered": [{ "content": "<system-reminder>..." }],
  "renderedRole": "...",
  "renderedInHumanTurn": false
}
```

`rendered` 是最终拼进提示词的文本，想还原模型看到的原文就读这里，不要自己重新拼 `attachment`。

---

## 二、会话状态

这组没有 `uuid`，只有 `sessionId`，不进消息树。同一文件里会有多条，**后写的覆盖先写的**。

| type | 关键字段 | 说明 |
|---|---|---|
| `mode` | `mode` | 交互模式 |
| `permission-mode` | `permissionMode` | 权限模式变更 |
| `ai-title` | `aiTitle` | AI 生成的会话标题，异步写入，可能有多条 |
| `custom-title` | `customTitle` | 用户手动设的标题，优先级高于 ai-title |
| `agent-name` | `agentName` | 当前 agent 名 |
| `last-prompt` | `lastPrompt`、`leafUuid`、`rewound`、`explicit` | 最近一次用户输入，用于 resume |
| `cost-state` | `totalCostUSD`、`modelUsage`、`totalDuration`、`startTime` 等 | 累计成本快照，周期性写入 |
| `tools-used` | `tools` | 本次会话用过的工具名数组 |
| `atis-latch` | `atis` | 内部状态闩锁，通常为空串 |
| `queue-operation` | `operation`、`content`、`reason`、`commandUuid` | 消息队列操作（enqueue 等） |
| `file-history-snapshot` | `messageId`、`snapshot.trackedFileBackups`、`isSnapshotUpdate` | 文件改动快照，供撤销用 |
| `file-history-delta` | `trackingPath`、`backup`、`snapshotMessageId` | 单个文件的增量备份记录 |

`cost-state` 的 `modelUsage` 是 `{ 模型名: {输入输出 token 数} }` 形式；`totalCostUSD` 为 0 说明走的是不返回定价的网关。

---

## 三、API 调试

`api-request` / `api-request-blob` / `api-request-shape` 三件套，记录实际发往 API 的 payload，用内容寻址去重。还原算法见 `api-requests.md`。

| type | 关键字段 |
|---|---|
| `api-request` | `id`、`base`、`keep`、`tail`、`params`、`shapeHash`、`cacheControl`、`requestDigest`、`querySource` |
| `api-request-blob` | `hash`（内容 SHA-256）、`message`（真实的 message 对象） |
| `api-request-shape` | `shapeHash`、`shape`（含 `system` 与 `tools`） |

`params` 里是真正的请求参数：

```json
{
  "model": "claude-opus-5-5",
  "betas": ["claude-code-20250219", "context-1m-2025-08-07", "..."],
  "max_tokens": 32000,
  "thinking": { "type": "adaptive", "display": "summarized" },
  "context_management": {...},
  "output_config": { "effort": "xhigh" }
}
```

`querySource` 标明这次请求来自哪：`repl_main_thread`、子代理等。

---

## 字段漂移的实证

同一台机器上，`assistant` 记录在 2.1.30x 和 2.1.31x 之间新增了 `attributionPlugin`、`attributionSkill`、`wireIngestContext`、`truncatedAfterOutput` 等字段；`user` 新增了 `turnCompanion`、`toolDenialKind`、`queueTranscriptOnly`。

**所以：任何 `if (record.someField)` 的写法都要有 fallback，不要假定字段一定存在。** 先跑 `survey.mjs` 看当前文件实际有哪些键。
