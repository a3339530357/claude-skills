# 已确认的符号索引

记录已定位过的函数、字段、事件名及其含义，避免重复检索。每条都注明是在哪个版本上确认的——Claude Code 迭代快，跨版本可能改名。

## Bash 工具执行链路（2.1.319，本机版本实测）

| 符号 | 类型 | 含义 |
|---|---|---|
| `Xt`（IIFE 内 `class r`） | 类 | **bash 会话类**。构造 `ve.spawn("/bin/bash",["--noprofile","--norc"],{stdio:["pipe","pipe","pipe"],detached:!0})`，常驻进程。**stdout 和 stderr 的 `data` 事件喂同一个累积器 `Me`**——stderr 天然回到工具结果，不需要用户写 `2>&1`。 |
| `Me(t)` | 方法 | 输出累积器：追加到 WeakSet 字段 buffer，超 `Ze` 字节截断（置 truncated 标志）。 |
| `exec(e,t)` | 方法 | 执行命令。**把用户命令包成 `{ ${e} } </dev/null 2>&1; printf '\n${哨兵}%d\n' $?`** 再写入常驻 bash 的 stdin——即每条命令都被强制补了 `2>&1`。哨兵 `__ANT_CMD_<uuid>_DONE__` 划界并带出退出码；`slice(l+o.length).match(/^(-?\d+)/)` 解析。 |
| `Jt(r)` | 函数 | bash 工具的注册工厂，`e=new Xt(r.workdir,r.env)` 持有会话；`exitCode!==0` 时把累积的 output 作为错误抛出。 |
| `Vt()` | 函数 | 构造 env：剔除所有 `ANTHROPIC_*` 变量。 |
| `nt` | 常量 | 默认超时（timeoutMs 兜底值）。 |

**结论（可直接引用）**：Bash 工具的 stderr 捕获是双层保险（spawn stderr 监听 + 命令模板自带 `2>&1`），裸跑命令错误也可见；`2>&1` 只在管道/文件定向场景有真实收益。

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

## Tool search / 技能描述预算 / lean prompt（2.1.322 实测）

| 符号 | 类型 | 含义 |
|---|---|---|
| `upe()` | 函数 | tool search 模式判定：`ENABLE_TOOL_SEARCH=true` → `"tst"`（强制开，不做阈值判断）；`"auto"` → `"tst-auto"`（按阈值）。 |
| `tao(...)` | 函数 | 主开关，埋点 `tengu_tool_search_mode_decision`。先过 `Qit` 硬性检查（`model_unsupported`/`vertex_model_unsupported`/`foundry_deployment_unsupported`/`no_tools_in_request`/`not_registered`/`mcp_search_unavailable`）。 |
| `uSe(e)` / `UIs(e)` | 函数 | 模型支持判定。不支持名单 `w()` 默认 `T=["claude-3-opus","claude-3-sonnet","claude-3-haiku","claude-3-5-sonnet","claude-3-5-haiku","claude-3-7-sonnet"]`（可被 statsig `tengu_tool_search_unsupported_models` 覆盖）。**deepseek/glm 等未知模型不在名单里 → 判定支持**。 |
| `Mae` | 错误类 | "tool search refused"。 |
| `cLn(...)` | 函数 | 拒绝后重发路径：注入 critical_system_reminder `"ToolSearch is no longer available. Tools listed earlier as deferred that are still available are declared in full: call them directly."` **此字符串在二进制里只出现在这一处**——请求里见到它 = 那是拒绝后的重发。 |
| `xpe` / `Bje` | 函数 | 触发条件：请求声明了 deferred tools + HTTP 400/422 + 非 billing + 无其他恢复认领 → 抛 `Mae`，日志 `"[ToolSearch] HTTP ...; sending the request again without deferred tools. ENABLE_TOOL_SEARCH=false avoids the refused request"`。`lIe()` 为假（自定义 base URL 场景）时**任何** 400/422 都触发。 |
| `TMt(e,n)` | 函数 | **技能描述字符预算 = contextWindow × 4 × skillListingBudgetFraction(默认 0.01)**，即窗口的 4%。env `SLASH_COMMAND_TOOL_CHAR_BUDGET` 可整体覆盖；未知模型窗口走默认 `EFr=200000` → 预算 8000 字符。 |
| `LTn(...)` | 函数 | 技能列表渲染：超预算时 `source==="bundled"` 的内置技能无条件保留完整描述，其余按优先级贪心塞，塞不下就 `- name` 裸名。告警文案 `"Skill listing over budget: ... Run /skills to disable some, or raise skillListingBudgetFraction in settings."` |
| `fe(e)` / `Et(e)` / `hJ` / `JD` | 函数 | leanPrompt 判定。`Et` 是已知模型名单（claude-3-\*/haiku/sonnet/opus-4-0..4-7 + 服务器按模型的 `lean_prompt` 配置）；不在名单的模型 → **硬编码 lean=true（精简 system prompt）**。env `CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT` 设真值强制 lean、设假值强制 full。 |
| `o0r` / `Yit` | 常量 | `Yit=10`：tst-auto 模式的默认阈值百分比（窗口的 10%）。`o0r=2.5`：字符兜底换算。 |

**实测印证（2026-11-12 抓包）**：opus-5-5 首轮请求体尾部带 "ToolSearch is no longer available..." → 该请求是被拒后的重发（66 工具全量内联）；deepseek 首轮无此句（21 工具 + ToolSearch 正常发出）。技能描述：opus[1M] 窗口预算 40K 字符 → 49 个全带描述；deepseek 默认 200K 窗口 → 8K 字符预算 → 只剩 10 个 bundled 带描述、39 个裸名。

| `GSs` / `ayi` / `hos` | 函数 | attribution（billing 段）拼装链：`hos` 组 system → `ayi` 调 `GSs` 生成 `x-anthropic-billing-header: cc_version=...; cc_entrypoint=...` 文本并插入 system[0]。开关：`function I(){return Qo(process.env.CLAUDE_CODE_ATTRIBUTION_HEADER)}`，env 设 `"0"` 即不注入（非 firstParty 场景 N() 恒 false，force 也救不回）。`CLAUDE_CODE_ATTRIBUTION_PROJECT` 可指定 Project id。 |
| `GSs` / `ayi` / `hos` | 函数 | attribution（billing 段）拼装链：`hos` 组 system → `ayi` 调 `GSs` 生成 `x-anthropic-billing-header: cc_version=...; cc_entrypoint=...` 文本并插入 system[0]。开关：`function I(){return Qo(process.env.CLAUDE_CODE_ATTRIBUTION_HEADER)}`，env 设 `"0"` 即不注入（非 firstParty 场景 N() 恒 false，force 也救不回）。`CLAUDE_CODE_ATTRIBUTION_PROJECT` 可指定 Project id。 |

## 请求体结构与 prompt cache 断点（2.1.325 / claude.exe 实测）

**先记住顶层结构：`tools`、`system`、`messages` 是三个平级字段，不是嵌套。** 缓存前缀顺序就是 `tools → system → messages`，所以改 tools 影响最大，改 messages 尾部影响最小。工具说明读起来像系统提示词，实际是独立的 `tools` 字段，别混。

| 符号 | 类型 | 含义 |
|---|---|---|
| `$Us(e, n)` | 函数 | **把 system prompt 数组切成带 `cacheScope` 的块**。返回值形如 `[{text, cacheScope: null\|"org"\|"global"}]`。按 `J$`（动态边界）把块分成静态段和动态段；`cacheScope:null` 的块不打断点。埋点 `tengu_sysprompt_boundary_found`（字段 `blockCount`/`staticBlockLength`/`dynamicBlockLength`）和 `tengu_sysprompt_missing_boundary_marker`；走 tool 侧缓存时是 `tengu_sysprompt_using_tool_based_cache`。 |
| `Mos(systemPrompt, enableCache, opts)` | 函数 | **system 块 → 实际请求体的最后一步**。`.map` 里对每块做 `{type:"text", text:wTn(s.text), ...enableCache && s.cacheScope!==null && {cache_control: Wne({scope, ttl})}}`。`scopeRefused` 为真时把 scope 置空。**断点是逐块打的，不是全篇一个。** |
| `Wne({scope, ttl})` | 函数 | 生成 `cache_control`：`{type:"ephemeral", ...ttl && {ttl}, ...scope==="global" && {scope}}`。`ttl` 可为 `"5m"`/`"1h"`（见 `KLe`）。 |
| `KLe(source, {agentCacheTtlOverride, ignoreOverage, mainThreadModel})` | 函数 | 决定 TTL：默认 `5m`；订阅者且命中 `tengu_prompt_cache_1h_config.allowlist` → `1h`（reason=`subscriber`）；overage 状态或非 firstParty → 强制 `5m`。 |
| `J$` | 常量 | `"__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__"`。**静态段/动态段的分界线标记**。 |
| `O`（在 `$Us` 所在 chunk） | 常量 | `"__SYSTEM_PROMPT_STATIC_BREAKPOINT__"`。静态段**内部**的额外断点，靠 `HUs()` / `uFr()` 按行匹配把它拆出来单独成块。 |
| `HUs(prompt)` | 函数 | 只有包含 `O` 标记时才拆，否则原样返回。`uFr(e,n)` 按行找标记（要求该行 trim 后完全等于标记），拆成 `[前段, 标记, 后段]`。 |
| `KZ()` | 函数 | 是否启用 global cache：要求 `xb() && Fi()` 且 provider 是 `firstParty` 或 `anthropicAws`。 |
| `T` / `v` / `U` | 常量 | 三种身份首句：`"You are Claude Code, Anthropic's official CLI for Claude."`、加 `", running within the Claude Agent SDK."`、`"You are a Claude agent, built on Anthropic's Claude Agent SDK."`。集合 `I` 用于识别这类身份块。 |
| `pFr(e)` | 函数 | 选身份首句：vertex → `T`；非交互且有 appendSystemPrompt → `v`；非交互 → `U`；否则 `T`。 |
| `UUs(...)` / `Maa(e)` | 函数 | system prompt 前的指纹短码（sha256 取前 3 位），拼自 `j="59cf53e54c78"` + 版本信息。 |
| `skill_listing`（在消息工厂对象里） | 工厂 | **技能列表是 `messages` 里的一条 meta 消息，不是 system 块**。返回 `Ie({content: "The following skills are ...available for use with the Skill tool:\n\n" + content, isMeta: !0})`。`addsToEarlier:true` 时前半句变成 `also ` 并追加 `". This list adds to the skills listed earlier in this conversation and is not the full list"`。同工厂还有 `critical_system_reminder`、`bash_output_audience_note`、`plan_mode_exit`、`skill_mention`、`dynamic_skill` 等，全是消息。 |
| `dynamic_skill` | 工厂 | 热发现新技能时用，文案 `"New skills discovered in <dir>, now available via the Skill tool:"`，同样 `isMeta:!0`。 |
| `Kns` / `Vns` | 函数 | 给单条 user / assistant 消息的**最后一个** content block 打 `cache_control: Wne({ttl})`——用于 side request / 单次请求路径。主对话路径的断点分配没有在这两个函数里。 |

**推论（2026-11-15 验证）**：安装/删除技能只改变 `messages` 尾部的一条 meta 消息，`tools` 和 `system` 完全不动，所以 prompt cache 命中率能保持 95% 以上。反过来说，**任何改动 `tools` 的操作（增删工具、MCP 重连、enable/disable 插件）都会让整个前缀失效**。

**未确认**：`wTn()` 的具体变换没追；主对话路径里 messages 层断点究竟打在哪几条上，没找到明确证据。
