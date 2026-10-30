# 常见提取任务

现成代码片段，可直接改。所有片段假设已经逐行读进来：

```js
import fs from 'fs';
const records = fs.readFileSync(file, 'utf8')
  .split('\n').filter(l => l.trim())
  .map(l => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);
```

大文件（>50 MB）改用 `readline` 流式读，不要一次性 `readFileSync`。

---

## 找会话

目录名是编码后的 cwd，不可靠。扫所有文件的 `cwd` 字段最稳。

```js
// 列出某目录下所有会话及其 cwd / 时间范围 / 首条用户输入
const dir = 'C:/Users/x/.claude/projects/D--project-tests';
for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.jsonl'))) {
  const recs = fs.readFileSync(dir + '/' + f, 'utf8')
    .split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean);
  const first = recs.find(r => r.type === 'user' && !r.isMeta);
  const times = recs.map(r => r.timestamp).filter(Boolean).sort();
  console.log(f.slice(0, 8), recs[0]?.cwd, times[0], '..', times.at(-1),
    JSON.stringify(String(first?.message?.content ?? '').slice(0, 60)));
}
```

---

## 导出人类真实输入

过滤掉系统注入的 meta 内容，只留人打的字。

```js
const humanTurns = records.filter(r => {
  if (r.type !== 'user') return false;
  if (r.isMeta) return false;          // 系统注入
  if (r.isCompactSummary) return false; // 压缩摘要
  const c = r.message?.content;
  if (Array.isArray(c) && c.every(b => b.type === 'tool_result')) return false; // 工具回传
  return true;
}).map(r => {
  const c = r.message.content;
  return Array.isArray(c)
    ? c.filter(b => b.type === 'text').map(b => b.text).join('\n')
    : String(c);
});
```

---

## 按 message.id 归并 assistant 回合

```js
const turns = new Map();
for (const r of records) {
  if (r.type !== 'assistant') continue;
  const id = r.message.id;
  if (!turns.has(id)) turns.set(id, {
    id, model: r.message.model, timestamp: r.timestamp, blocks: []
  });
  turns.get(id).blocks.push(...r.message.content);
}

// 每个 turn 现在是一整个模型回合
for (const t of turns.values()) {
  const text = t.blocks.filter(b => b.type === 'text').map(b => b.text).join('');
  const tools = t.blocks.filter(b => b.type === 'tool_use').map(b => b.name);
  console.log(t.model, tools.join(','), text.slice(0, 80));
}
```

---

## 统计工具使用

```js
const toolCount = {};
for (const r of records) {
  if (r.type !== 'assistant') continue;
  for (const b of r.message.content || []) {
    if (b.type === 'tool_use') toolCount[b.name] = (toolCount[b.name] || 0) + 1;
  }
}
console.log(Object.entries(toolCount).sort((a, b) => b[1] - a[1]));
```

注意：子代理的工具调用也会混进来。要排除的话过滤 `isSidechain === true`。

---

## 配对 tool_use 与 tool_result

```js
const results = new Map();
for (const r of records) {
  if (r.type !== 'user') continue;
  const c = r.message?.content;
  if (!Array.isArray(c)) continue;
  for (const b of c) if (b.type === 'tool_result') results.set(b.tool_use_id, b);
}

for (const r of records) {
  if (r.type !== 'assistant') continue;
  for (const b of r.message.content || []) {
    if (b.type !== 'tool_use') continue;
    const res = results.get(b.id);
    console.log(b.name, res ? (res.is_error ? 'ERROR' : 'ok') : 'no result');
  }
}
```

---

## 按本地日期筛会话

`timestamp` 是 UTC。本地 UTC+8 的某天 D 对应 `[D-1T16:00Z, DT16:00Z)`。

```js
function utcRangeForLocalDay(localDay, tzOffsetHours = 8) {
  const start = new Date(localDay + 'T00:00:00Z');
  start.setUTCHours(start.getUTCHours() - tzOffsetHours);
  const end = new Date(start.getTime() + 24 * 3600 * 1000);
  return [start.toISOString(), end.toISOString()];
}
const [lo, hi] = utcRangeForLocalDay('2026-10-27');
const inDay = records.filter(r => r.timestamp >= lo && r.timestamp < hi);
```

**不要用文件 mtime 筛。** 会话 resume 会往旧文件追加新消息，mtime 和内容时间能差好几天。

---

## 找压缩发生的位置

```js
for (const r of records) {
  if (r.type === 'system' && r.subtype === 'compact_boundary') {
    const m = r.compactMetadata || {};
    console.log(r.timestamp, m.trigger, `${m.preTokens} -> ${m.postTokens} tokens`,
      `dropped ${m.cumulativeDroppedTokens}`);
  }
}
```

压缩后 `parentUuid` 会重置为 `null`，真正的前驱在 `logicalParentUuid`。

**注意 `postTokens` 不是压缩后的实际上下文大小**——它不含 system prompt 和工具定义，通常只有真实值的 1/3。要测真实大小，取压缩之后第一条请求的 usage：

```js
const boundaries = records.filter(r => r.type === 'system' && r.subtype === 'compact_boundary');
const after = records.find(r =>
  r.type === 'assistant' && r.message?.usage && r.timestamp > boundaries.at(-1).timestamp);
console.log(after.message.usage.input_tokens);  // 这才是压缩后的真实上下文
```

`cumulativeDroppedTokens` 是累计值，要算单次丢弃用前后两次相减，或者 `preTokens - postTokens` 的近似。

---

## 提取 thinking 并区分可信度

```js
for (const r of records) {
  if (r.type !== 'assistant') continue;
  for (const b of r.message.content || []) {
    if (b.type !== 'thinking') continue;
    const usable = b.signature && b.thinking?.trim();  // 官方 API 接受的条件
    console.log(usable ? 'OK ' : 'BAD', r.message.model,
      (b.thinking || '').trim().slice(0, 60));
  }
}
```

第三方网关写的块 `signature` 为空，回放给官方 API 会 400。

---

## 统计 token 与成本

```js
// 累计成本快照（取最后一条）
const cost = records.filter(r => r.type === 'cost-state').at(-1);
console.log(cost?.totalCostUSD, cost?.modelUsage);

// 逐条 usage（assistant.message.usage）
let inTok = 0, outTok = 0;
for (const r of records) {
  if (r.type !== 'assistant') continue;
  const u = r.message.usage;
  if (!u) continue;
  inTok += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  outTok += u.output_tokens || 0;
}
console.log({ inTok, outTok });
```

---

## 还原某次 API 请求

用脚本最省事：

```bash
node "$SKILL/scripts/extract.mjs" <file.jsonl> --mode list          # 先看索引
node "$SKILL/scripts/extract.mjs" <file.jsonl> --mode request --index 42 --out req.json
```

手写的话核心就三行：

```js
const byId = new Map(records.filter(r => r.type === 'api-request').map(r => [r.id, r]));
const blobs = new Map(records.filter(r => r.type === 'api-request-blob').map(r => [r.hash, r.message]));
const shapes = new Map(records.filter(r => r.type === 'api-request-shape').map(r => [r.shapeHash, r.shape]));
```

然后递归 `base` / `keep` / `tail`。**记住 blob 有约 75% 的缺口**，必须占位而不是跳过。

---

## 导出成可读 Markdown

直接调脚本，别自己写：

```bash
node "$SKILL/scripts/extract.mjs" <file.jsonl> --mode dialog --out conv.md
node "$SKILL/scripts/extract.mjs" <file.jsonl> --mode dialog --thinking --meta --out full.md
```

---

## 子代理（subagent）的记录

`isSidechain === true` 的记录属于子代理分支，混在主对话里会让统计失真。

```js
const main = records.filter(r => !r.isSidechain);
const side = records.filter(r => r.isSidechain);
```

子代理的思考过程、工具调用都在 sidechain 里，如果用户问的是"主对话里发生了什么"，要排除掉。
