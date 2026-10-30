# 内容块与消息结构

`message.content` 有两种形态：**字符串**（早期记录、部分 user 输入）或**块数组**。写解析代码时两种都要处理。

---

## 通用块

### `text`

```json
{ "type": "text", "text": "..." }
```

assistant 的回复正文、user 的输入、tool_result 里的文本内容都用这个。

### `thinking`

```json
{ "type": "thinking", "thinking": "...", "signature": "..." }
```

| 字段 | 说明 |
|---|---|
| `thinking` | 思考正文 |
| `signature` | 加密签名，官方 API 续聊时**必须原样回传** |

**第三方网关的重要差异**：经 DeepSeek 等网关写的 thinking 块，`signature` 是空串，`thinking` 可能是**一个空格**——注意是 `" "`，既不是空串也不是 `null`。

这带来一个隐蔽的判定错误：

```js
if (!b.thinking) { /* 漏判！" " 是真值 */ }
if (b.thinking.trim() === '') { /* 正确 */ }
```

实测某会话 95 个空 thinking 块的 `thinking` 值全是单个空格，用 `if (!thinking)` 一个都查不出来。

这种块：
- 在网关里能正常工作（网关不校验）
- 切回官方 API 会直接 400：`each thinking block must contain non-whitespace thinking`

实测对比（同一会话内切模型）：

| 模型 | thinking 块 | 空块 | 缺签名 |
|---|---|---|---|
| deepseek-v4.1-flash | 293 | 86 | **293（100%）** |
| claude-opus-5-5 | 192 | 0 | 0 |

所以「从 transcript 还原请求再发给官方 API」时，必须先过滤掉 `!signature` 的 thinking 块。

### `redacted_thinking`

```json
{ "type": "redacted_thinking", "data": "..." }
```

安全策略拦截后的加密思考，只有 `data`，没有可读正文。

### `tool_use`

```json
{ "type": "tool_use", "id": "toolu_...", "name": "Bash", "input": { ... } }
```

`id` 用来和后续的 `tool_result` 配对。

### `tool_result`

```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_...",
  "content": "..." | [{ "type": "text", "text": "..." }],
  "is_error": false
}
```

`content` 可能是字符串也可能是块数组（含 `image` 时是数组）。超长结果会被截断，完整内容在会话同名目录的 `tool-results/*.txt` 里。

### `image`

```json
{ "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "..." } }
```

### `server_tool_use`

provider 侧执行的工具（如 web search），结果直接出现在同一 assistant 回合里，没有对应的 user `tool_result` 行。

---

## system 消息里的特殊块

`api-request-shape` 的 `shape.system` 和 `api-request-blob` 里会出现：

### `tool_addition` / `tool_removal`

```json
{ "type": "tool_addition", "tool": { "name": "...", "description": "...", "input_schema": {...} } }
{ "type": "tool_removal", "tool_name": "..." }
```

会话中途增删工具时（比如动态加载 MCP 工具）用来同步工具列表。

---

## 一个 assistant 回合的真实结构

这是最容易读错的地方。**一次模型回复在 transcript 里是多行**：

```
行 N    assistant  content=[thinking]         message.id=msg_X
行 N+1  assistant  content=[tool_use]         message.id=msg_X
行 N+2  assistant  content=[tool_use]         message.id=msg_X
行 N+3  user       content=[tool_result]      ← 工具回传，插在中间
行 N+4  user       content=[tool_result]
行 N+5  assistant  content=[thinking,text,tool_use]  message.id=msg_Y
```

注意最后一行：**一次 assistant 回复也可以是多个块挤在一条记录里**。所以：

- 同一个 `message.id` 的**多条记录**要合并
- 单条记录里的**多个块**按顺序保留

实测分布（某会话 718 个 `message.id`）：

| 行数 | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| 出现次数 | 202 | 326 | 167 | 22 | 1 |

按行遍历 = 把一个回合读成 2–5 个碎片。必须按 `message.id` 归并。

---

## 按 message.id 归并的参考实现

```js
const byId = new Map();
for (const line of lines) {
  const r = JSON.parse(line);
  if (r.type !== 'assistant') continue;
  const id = r.message.id;
  if (!byId.has(id)) byId.set(id, { model: r.message.model, blocks: [] });
  byId.get(id).blocks.push(...r.message.content);
}
```

`tool_result` 的 user 行不带 `message.id`，要靠 `tool_use_id` 配对回对应的 `tool_use`：

```js
const toolResults = new Map();
for (const r of records) {
  if (r.type !== 'user') continue;
  const c = r.message?.content;
  if (!Array.isArray(c)) continue;
  for (const b of c) {
    if (b.type === 'tool_result') toolResults.set(b.tool_use_id, b);
  }
}
```

---

## user 消息里的 meta 内容

`isMeta: true` 的 user 记录是**系统代注入的**，不是人打的字。典型内容：

- `<system-reminder>` 块（环境信息、记忆、指令文件）
- `<local-command-caveat>` / `<command-name>`（斜杠命令）
- 文件内容注入

导出「人类实际说了什么」时要过滤掉这些，否则对话里会混进大量系统文本。判断顺序：

1. `isCompactSummary === true` → 压缩摘要，单独标注
2. `isMeta === true` → 系统注入
3. content 全是 `tool_result` → 工具回传
4. 其余 → 真人输入

---

## 会话同名目录

```
<session-uuid>/
├── custom-title.json      # {"title": "..."}
└── tool-results/
    ├── b77pg2u6x.txt      # 超长工具结果的完整内容
    └── ...
```

`tool_result` 块里被截断的内容，完整版在这里。文件名是随机 id，靠 `tool_result` 块里的引用定位。
