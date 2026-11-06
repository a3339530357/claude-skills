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

## 压缩（compact）主链路（2.1.318 复核，函数名与 2.1.317 一致）

| 符号 | 类型 | 含义 |
|---|---|---|
| `E7r(msgs, ctx, cacheSafeParams, suppressFollowUp, opts)` | 函数 | **整段压缩的主函数**。埋点 `tengu_compact`。流程：`JBe` 跑 PreCompact hook → `Vte`+`PRe` 拼摘要请求 → 循环 `gmn` 调 API（`W$`="Prompt is too long" 时用 `cmn` 截断重试，上限 `Yte=3`）→ `qV` 造 `compact_boundary` → `Kte` 包摘要 → `HZe` 算保留段。 |
| `qV(trigger, preTokens, lastUuid, userContext, summarized)` | 函数 | 造 `compact_boundary` 记录。**注意同名函数有 3 个**，这个是 5 参数的版本。`compactMetadata:{trigger, preTokens, userContext, messagesSummarized}`，`parentUuid` 不设（= null）。 |
| `h9e(usedTokens, window, opts, limit, threshold)` | 函数 | **阈值判定的核心**。返回 `{level, pctLeft}`，level ∈ `ok`/`warn`/`compact`/`blocked`。 |
| `Iee(window, opts)` | 函数 | 压缩阈值 = `window - 13000`；有 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 时 = `min(floor(window*pct/100), window-13000)`。 |
| `ERt(model)` | 函数 | 可用窗口 = `contextWindow - min(maxOutputTokens, s9r)`。 |
| `Pne(model, session)` | 函数 | 同上，但允许 session 覆盖窗口。 |
| `bY(used, model, session, override, allow)` | 函数 | `h9e` 的包装，决定用哪个窗口和阈值。 |
| `Kte(summaryText, opts)` | 函数 | **把模型返回的摘要包成 user 消息**。前缀 `dJe` = "This session is being continued from a previous conversation that ran out of context…"。可追加：工具列表、transcript 路径、headTruncated 说明、被丢弃的工具结果说明。 |
| `HZe(boundary, anchorUuid, msgs, subset)` | 函数 | 算 `preservedSegment` 和 `preservedMessages`：`dmn()` 去重取 uuid，`u1e()` 再筛出真正会发给 API 的那部分。 |
| `dmn(list)` | 函数 | 从后往前去重 uuid 并 reverse —— 保留段的 uuid 顺序。 |
| `vG(parts)` | 函数 | 拼装最终消息数组：`[boundaryMarker, ...summaryMessages, ...replacement, ...messagesToKeep, ...attachments, ...hookResults]`。 |
| `cmn(msgs, resp, mediaStripped)` / `kRe(...)` | 函数 | **prompt-too-long 截断重试**。有 gap 信息时丢到 gap 为止，没有时丢最老 20%（`floor(len*0.2)`），至少留 1 组；会在头部插入 `[earlier conversation truncated for compaction retry]`（`lmn`）。 |
| `vcr(text)` | 函数 | 清理模型返回：去掉 `<analysis>` 块（`pZe`），把 `<summary>x</summary>` 换成 `Summary:\nx`，压掉多余空行。 |
| `GV(text)` / `qte(text)` | 函数 | 校验摘要是否合规（有没有 `<summary>` 块）。不合格就抛 `PZe` 错误。 |
| `a9r(ctx)` | 函数 | **快速重填熔断**。连续 `>=3` 次压缩且每次间隔 `<3` 轮（`qtn=3`）→ `trip`，本次不压。 |
| `C7r` = 3 | 常量 | 连续失败 `>=3` 次 → `failure_breaker_open`，不再尝试压缩。 |
| `Fu()` | 函数 | autocompact 总开关，读 settings 的 `autoCompactEnabled`，**默认 `true`**。 |
| `DISABLE_COMPACT` | 环境变量 | 设了就直接返回 `not_needed`，完全不压。 |

## 压缩：microcompact（工具结果清理，2.1.318）

| 符号 | 类型 | 含义 |
|---|---|---|
| `n9r()` | 函数 | microcompact 模式，读 flag `tengu_jiggly_blossom`，默认 `off`；值可为 `on`/`shadow`/`off`/`unknown`。 |
| `xsr` | 常量对象 | `{minIdleSeconds:3900, keepToolUses:12, clearAtLeastTokens:20000, triggerToolUsesBelowCount:3, minTriggerToolUses:27}`。 |
| `Eci(msgs, plan, opts)` | 函数 | 执行 microcompact：把旧的 `tool_result` 内容替换成占位文本，原文先 `persist` 到磁盘。省不够 `Asr=20000` tokens 就返回 `null` 不做。 |
| `n9o(msgs, keepRecent)` | 函数 | 算出 `{clearSet, keepSet, tokensSaved, candidates}`。含图片/文档的 tool_result 不清。 |
| `kRt(msgs, clearSet, contentMap)` | 函数 | 真正改写消息：保留图片/文档的前缀文本，再接占位符。 |
| `[KEEP-RECENT MC]` | 日志文案 | microcompact 触发时的提示：`cleared N tool results (~T tokens), kept last K`。 |
| `tengu_time_based_microcompact` | 埋点 | 字段 `toolsCleared`/`toolsKept`/`keepRecent`/`tokensSaved`/`trigger`。 |
| `tengu_tool_result_clearing_after_idle_planned` | 埋点 | 空闲清理计划：`idle_seconds`、`clearable_tool_uses`、`keep_tool_uses`、`rough_tokens_to_clear`。 |
| `tengu_context_hint_reject` | 埋点 | 上下文提示被拒（`[CONTEXT_HINT_REJECT]`），字段 `mc`（是否应用了 microcompact）、`tokensSaved`。 |
| `tengu_context_hint_busy_fallback` | 埋点 | 忙时回退路径。 |

## 压缩：阈值与窗口（2.1.318）

| 符号 | 类型 | 含义 |
|---|---|---|
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | 环境变量 | 按百分比设压缩阈值（1–100）。 |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | 环境变量 | 手动指定窗口大小，如 `200k`/`200000`。来源枚举：`agent_definition`/`session_override`/`settings_per_model`/`settings_top_level`。 |
| `CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE` | 环境变量 | 硬阻塞阈值（`blocked` 那一档）覆盖。 |
| `tengu_auto_compact_window_in_force` | 埋点 | 窗口来源：`window_origin`、`threshold_source`。 |
| `tengu_auto_compact_prefix_overflow` | 埋点 | **压不动的情况**：固定前缀（系统提示+工具）本身已超阈值，压缩救不了。日志 `autocompact: fixed prefix ~N > threshold M — compaction cannot help`。 |
| `tengu_auto_compact_rapid_refill_breaker` | 埋点 | 快速重填熔断触发。 |
| `tengu_auto_compact_routed_reactive` | 埋点 | 改走 reactive 压缩路径，字段 `thresholdSource`、`classifierOverflow`。 |

## 压缩（compact）相关（2.1.317，保留）

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
