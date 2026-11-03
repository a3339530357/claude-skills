# 已确认的符号索引

记录已定位过的函数、字段、事件名及其含义，避免重复检索。每条都注明是在哪个版本上确认的——Claude Code 迭代快，跨版本可能改名。

## 错误分类与自愈（2.1.317）

| 符号 | 类型 | 含义 |
|---|---|---|
| `z3o(e)` | 函数 | 判断一个 400 报错是否属于「thinking 块签名问题」。是硬编码白名单，只认 4 种措辞：`signature in thinking block`、`invalid data in redacted_thinking block`、`thinking.signature` + `field required`、`thinking block`/`redacted_thinking` 搭配 `cannot be modified`/`invalid signature`。不匹配就走普通错误路径，**不自愈**。 |
| `rA(e)` | 函数 | `z3o()` 的外层包装，额外认 `capability_rejected: thinking_signature` 这个稳定 token。 |
| `y8r(status, message, betas)` | 函数 | 把 400/413 归类成 `mid_conv_system`、`cache_control_field`、`thinking_signature`、`image_block` 等类别，是错误分类的总入口。 |
| `Inr(block)` | 函数 | 判断某个 content block 在跨模型时是否要删。只删 `redacted_thinking` 和**带签名**的 `thinking`；空签名的 thinking 返回 false（放行）。这是空白思考块能漏到请求里的原因。 |
| `JNs` / `skn` | 函数 | 跨模型过滤的执行层，只在消息的 model 与当前请求 model 不同时才动手。 |
| `S5o(block)` | 函数 | 识别空白 thinking / 空白 text 块。**能力存在，但只在错误补救路径上被调用**，正常发送路径不调。 |
| `nSn(message, n)` | 函数 | 从某条 assistant 消息里剥掉 thinking 块（可指定从第 n 个开始）。调用点全在 `wRe`/`iet`/`eFs` 等补救路径。 |
| `wRe(messages)` | 函数 | 剥掉所有消息里的全部 thinking，用于 `retry:thinking-signature-strip`。 |
| `nSn` 相关的 `pXn` | 函数 | 剥掉最后一条 assistant 消息的尾部 thinking 块，埋点 `tengu_filtered_trailing_thinking_block`。 |
| `gXn` / `xFe` | 函数 | 过滤「整条消息只有空白 text」的 assistant 记录，埋点 `tengu_filtered_whitespace_only_assistant`。 |
| `capability_rejected: ` | 字符串常量 | 给第三方网关的契约：替换错误体时必须保留这个前缀 + 类别名，客户端才能按 token 匹配并自愈。二进制内附完整对接文档（搜 `classify conservatively`）。 |

## 压缩（compact）相关（2.1.317）

| 符号 | 类型 | 含义 |
|---|---|---|
| `cQe(keptMessages, ctx)` | 函数 | 压缩后决定要不要给保留段打「thinking 已剥离」标记。返回 `{marker, thinkingBlockCount, decidedBy}`。 |
| `Cfi(thinkingType)` | 函数 | 决定 strip 开关：环境变量 `CLAUDE_CODE_WISE_COMET` 优先（source=`env`）；否则非 `adaptive` 一律不 strip（source=`thinking_type`）；`adaptive` 时看 flag `tengu_dapper_fountain`（source=`flag`）。 |
| `Kte(messages)` | 函数 | 把 `thinking_stripped` attachment 换算成「按 message.id 从第几个 thinking 开始剥」的 Map。 |
| `uQe(boundary, anchor, kept, all)` | 函数 | 给 `compact_boundary` 写入 `preservedSegment` 和 `preservedMessages`。 |
| `kBe(records)` | 函数 | 会话文件裁剪（transcript compaction）的规划器，算出哪些行可以丢。 |
| `kMt` / `bMt` | 函数 | 裁剪时的保留判定：边界之前的记录默认丢，除非在 keepIdx 里。 |
| `mgn(messages, ctx, hook)` | 函数 | 构建 `messagesForAPI` 的总入口，请求体就是这里出来的。 |
| `compactMetadata.preservedMessages` | 字段 | `{anchorUuid, uuids, allUuids}`，压缩后保留的消息 uuid。 |
| `compactMetadata.preservedSegment` | 字段 | `{headUuid, anchorUuid, tailUuid}`，保留段的链式范围。 |
| `compact_boundary` | 记录 subtype | 压缩边界。**其 `parentUuid` 恒为 null**，即边界在父链上是根，边界前的记录不会被请求带出去。 |
| `thinking_stripped` | attachment 类型 | 压缩时打了「思考已剥离」标记，后续请求按此跳过 thinking。 |
| `tengu_reactive_compact_succeeded` | 埋点 | 压缩成功事件，字段 `keptThinkingBlockCount`、`keptThinkingStripped`、`keptThinkingStripDecidedBy` 直接说明剥离决策。 |

## 会话存档（2.1.317）

| 符号 | 类型 | 含义 |
|---|---|---|
| `api-request` | 记录类型 | 每次请求的元数据：`params.model`（**判断真实模型的唯一可靠来源**）、`base`（上一条请求的 id，可沿链回溯）、`keep`（该请求带多少条消息）、`tail`（尾部 blob 的 hash 列表）。 |
| `api-request-blob` | 记录类型 | 内容寻址的请求体快照，`hash` + `message`。`base` 字段指向的是上一条 `api-request` 的 `id`，不是 blob hash。 |
| `requestDigest` / `shapeHash` | 字段 | 请求指纹，用于对比两次请求是否同形。 |

## 打包结构

| 特征 | 含义 |
|---|---|
| `// @bun @bytecode` | chunk 头标记，共约 2691 处。部分模块可能是预编译形态，搜不到属正常。 |
| `/$bunfs/root/chunk-xxxxxxxx.js` | chunk 引用路径，约 2687 个唯一值。 |
| `// Version: 2.1.317` | 版本号在文件里多次出现，可用来确认提取的是哪个版本。 |

## 常用检索词

排查 Claude Code 自身行为时，这几个词命中率很高：

- `tengu_` —— 遥测事件名前缀，几乎每个功能都有，字段名往往把逻辑讲清楚了
- `capability_rejected` —— 网关错误契约
- `retry:` —— 自动重试路径的标识（`retry:thinking-signature-strip`、`retry:media-strip` 等）
- `Cannot destructure property` —— 压缩代码里解构失败的报错，反过来能定位对象结构
