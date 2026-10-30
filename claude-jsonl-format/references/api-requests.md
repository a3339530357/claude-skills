# API 请求快照：去重与还原

`api-request` / `api-request-blob` / `api-request-shape` 三件套记录了**实际发往 API 的 payload**。它们用内容寻址 + 增量引用来压缩体积，读起来比对话流复杂得多。

**绝大多数任务不需要碰这套。** 只有在需要 system prompt 原文、工具定义、缓存断点位置，或者排查"模型到底看到了什么"时才用。

---

## 为什么这样存

一次 100 轮的对话会发 100 次请求，每次请求里 99% 的消息和上次相同。全量存一遍是几百 MB。所以 Claude Code 存成：

- **`api-request-blob`**：按内容 SHA-256 去重后的 message 对象，每条只存一次
- **`api-request`**：只记录"在父请求的基础上，复用前 N 条，再追加这几条新的"
- **`api-request-shape`**：system prompt 和 tools 定义，同样按哈希去重

实测某会话：600 个 blob 被 1648 次引用，零冗余。

---

## 三个字段的含义

```json
{
  "type": "api-request",
  "id": "d7dbea96-0a4c-4c2f-b89a-77dbc1cf3850",
  "base": "a85856a7-24d9-4734-a459-f6b33e5eae7d",
  "keep": 68,
  "tail": ["9a4c2f24...", "74155984...", "4135ac3f..."],
  "shapeHash": "612818319b83...",
  "params": { "model": "...", "thinking": {...}, ... },
  "cacheControl": [ { "path": ["messages", 68, "content", 1], "value": { "type": "ephemeral" } } ],
  "requestDigest": "5648bd02..."
}
```

| 字段 | 含义 |
|---|---|
| `base` | **上一条 `api-request` 的 `id`** |
| `keep` | 复用 base 解析结果的前 `keep` 条 messages |
| `tail` | 追加在其后的 message 的 blob hash 列表 |
| `shapeHash` | 指向 `api-request-shape`，取 `system` 与 `tools` |
| `cacheControl` | 缓存断点，`path` 是 `["messages", 索引, "content", 块索引]` |
| `requestDigest` | 整个 payload 的摘要 |

### 关于 `base` 的两个常见误判

`base` 不是 blob hash（长度对不上），也**不是**任何记录的 `uuid`。它是**另一条 `api-request` 记录的 `id`**。

我一开始拿它去匹配 blob hash 和记录 uuid，都是 0 命中；匹配 `api-request.id` 后 713/713 全中。

---

## 还原算法

```js
function resolve(req, byId, blobs) {
  const parent = req.base ? byId.get(req.base) : null;
  const head = parent ? resolve(parent, byId, blobs) : [];
  const messages = head.slice(0, req.keep);
  for (const h of req.tail) {
    messages.push(blobs.get(h));   // 注意：可能取不到，见下节
  }
  return messages;
}
```

递归深度 = 请求链长度。实测某会话 39 层，6000 行的文件也能瞬间算完。加个深度上限防环。

`keep` 单调递增（61 → 64 → 66 → 68 → 71 → 73），验证了这是追加式日志。

---

## 已知缺口：blob 并未全部持久化

**这是最重要的一条。** `tail` 里的 hash 常常找不到对应的 blob：

| 会话 | 请求数 | tail 引用 | 能还原 | 覆盖率 |
|---|---|---|---|---|
| 8c224dcb | 740 | 4354 | 1842 | 42% |
| e9f52481 | 858 | 12783 | 2041 | **16%** |
| 5bc75408 | 44 | 257 | 187 | 73% |
| 17812a63 | 2 | 4 | 4 | 100% |
| **合计** | 1862 | 18768 | 4765 | **25%** |

而且**越往后覆盖越差**（某会话前 25% 有 55%，后 25% 只剩 16%）。

这说明 Claude Code 只对部分消息持久化了 blob——大概是命中缓存的、或体积较大的那些。**别指望能完整还原任意一次请求。**

### 缺 blob 时怎么处理

**不要静默跳过。** 跳过会让后续所有消息的索引整体前移，导致 `cacheControl.path` 里的索引全部错位，还原出来的缓存断点位置是错的。

正确做法是占位，保持索引对齐：

```js
for (const h of req.tail) {
  const m = blobs.get(h);
  if (m) messages.push(m);
  else messages.push({
    role: 'unknown',
    content: [{ type: 'text', text: `[blob ${h.slice(0,12)} not persisted]` }]
  });
}
```

`scripts/extract.mjs` 就是这么做的，输出里的 `unresolved blobs` 计数告诉你这次还原有多少缺口。

---

## `api-request-shape`

```json
{
  "type": "api-request-shape",
  "shapeHash": "612818319b83...",
  "version": "2.1.309",
  "shape": {
    "system": [ { "type": "text", "text": "You are Claude Code, ..." }, ... ],
    "tools":  [ { "name": "Bash", "description": "...", "input_schema": {...} }, ... ]
  }
}
```

**system prompt 和 tools 只在这里。** `api-request` 本身不存。同一 shape 被大量请求复用（实测 11 个 shape 服务 727 次请求）。

想读 system prompt 原文：

```js
const shape = shapes.get(req.shapeHash);
console.log(shape.system.map(b => b.text).join('\n'));
```

---

## 什么时候值得用这套

| 想做 | 用哪套 |
|---|---|
| 导出对话内容 | 事件流（`user`/`assistant`） |
| 统计工具调用 | 事件流的 `tool_use` 块 |
| 看 system prompt 原文 | `api-request-shape` |
| 看某次请求带了哪些工具 | `api-request-shape` |
| 排查缓存命中 / 断点位置 | `api-request` 的 `cacheControl` |
| 确认模型实际收到什么 | 两者都要，且注意 blob 缺口 |

---

## `params` 里有什么

```json
{
  "model": "claude-opus-5-5",
  "betas": ["claude-code-20250219", "context-1m-2025-08-07", "interleaved-thinking-2025-05-14", "..."],
  "max_tokens": 32000,
  "thinking": { "type": "adaptive", "display": "summarized" },
  "context_management": { ... },
  "output_config": { "effort": "xhigh" }
}
```

`thinking.type` 实测都是 `adaptive`，`output_config.effort` 对应 `/effort` 设置。

**注意**：`params.model` 是**请求时指定的模型**，`assistant.message.model` 是**实际响应的模型**。经网关重定向时两者可能不同（比如都写着 `deepseek-v4.1-flash`），这正好可以用来判断流量走了哪条通道。
