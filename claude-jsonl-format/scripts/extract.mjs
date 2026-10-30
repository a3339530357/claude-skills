#!/usr/bin/env node
// extract.mjs - turn a Claude Code transcript into something readable.
//
// Two jobs, because the transcript stores two different things:
//
//   --mode dialog   what the conversation looked like (record types user/assistant/system)
//   --mode request  what was actually sent to the API (api-request + blobs)
//
// Most questions are about the dialog. Only reach for request mode when you
// need the exact wire payload: system prompt, tool definitions, cache markers.
//
// Usage:
//   node extract.mjs <file.jsonl> --mode dialog [--out conv.md] [--json]
//   node extract.mjs <file.jsonl> --mode request [--index N | --last] [--out req.json]
//   node extract.mjs <file.jsonl> --mode list        # index all API requests
//
// Flags:
//   --tools     include tool_use / tool_result in dialog output (default: on)
//   --thinking  include thinking blocks in dialog output (default: off)
//   --meta      include attachment / system / meta records (default: off)

import fs from 'fs';

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
if (!file) {
  console.error('usage: node extract.mjs <file.jsonl> --mode dialog|request|list [options]');
  process.exit(2);
}
const has = f => args.includes('--' + f);
const val = f => { const i = args.indexOf('--' + f); return i >= 0 ? args[i + 1] : null; };

const mode = val('mode') || 'dialog';
const showTools = !has('no-tools');
const showThinking = has('thinking');
const showMeta = has('meta');
const asJson = has('json');

const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim());
const records = [];
for (const line of lines) {
  try { records.push(JSON.parse(line)); } catch { /* skip torn line */ }
}

// ---------------------------------------------------------------- dialog mode

function blockToText(b) {
  switch (b.type) {
    case 'text': return b.text || '';
    case 'thinking': return showThinking ? `[thinking] ${(b.thinking || '').trim()}` : '';
    case 'tool_use': return showTools ? `[tool_use ${b.name}] ${JSON.stringify(b.input ?? {}).slice(0, 2000)}` : '';
    case 'tool_result': {
      if (!showTools) return '';
      const c = b.content;
      const text = Array.isArray(c)
        ? c.map(x => (x.type === 'text' ? x.text : `[${x.type}]`)).join('\n')
        : String(c ?? '');
      const flag = b.is_error ? ' (error)' : '';
      return `[tool_result${flag}] ${text.slice(0, 2000)}`;
    }
    case 'image': return '[image]';
    default: return `[${b.type}] ${JSON.stringify(b).slice(0, 300)}`;
  }
}

function dialog() {
  // One assistant turn is split across several rows that share message.id:
  // thinking / text / tool_use each get their own line, and tool_result rows
  // from the user are interleaved between them. Group by message.id or you
  // will read a turn as a dozen disconnected fragments.
  const out = [];
  let currentId = null;
  let buffer = [];

  const flush = () => {
    if (buffer.length) out.push(buffer.join('\n'));
    buffer = [];
  };

  for (const r of records) {
    if (r.type === 'system' && r.subtype === 'compact_boundary') {
      flush();
      const m = r.compactMetadata || {};
      out.push(`\n===== COMPACT (${m.trigger || '?'}): ${m.preTokens} -> ${m.postTokens} tokens =====\n`);
      currentId = null;
      continue;
    }
    if (r.type === 'system') {
      if (showMeta) { flush(); out.push(`[system.${r.subtype}] ${(r.content || '').toString().slice(0, 500)}`); }
      continue;
    }
    if (r.type === 'attachment') {
      if (showMeta) { flush(); out.push(`[attachment ${r.attachment?.type || '?'}]`); }
      continue;
    }
    if (r.type !== 'user' && r.type !== 'assistant') continue;

    const msg = r.message;
    if (!msg) continue;
    const isCompactSummary = r.isCompactSummary === true;

    let text;
    if (Array.isArray(msg.content)) {
      text = msg.content.map(blockToText).filter(Boolean).join('\n');
    } else {
      text = String(msg.content ?? '');
    }
    if (!text.trim()) continue;

    if (r.type === 'assistant') {
      const id = msg.id || r.uuid;
      if (id !== currentId) { flush(); currentId = id; }
      buffer.push(text);
    } else {
      flush();
      currentId = null;
      const who = isCompactSummary ? 'USER(compact summary)' : (r.isMeta ? 'META' : 'USER');
      out.push(`\n### ${who}\n${text}`);
    }
  }
  flush();
  return out.join('\n');
}

// --------------------------------------------------------------- request mode

function loadRequestIndex() {
  const blobs = new Map();
  const shapes = new Map();
  const requests = [];
  for (const r of records) {
    if (r.type === 'api-request-blob') blobs.set(r.hash, r.message);
    else if (r.type === 'api-request-shape') shapes.set(r.shapeHash, r.shape);
    else if (r.type === 'api-request') requests.push(r);
  }
  return { blobs, shapes, requests };
}

// A request stores only what changed since its parent:
//   base -> id of the PREVIOUS api-request (not a blob hash, not a record uuid)
//   keep -> how many messages of that parent to reuse
//   tail -> blob hashes for the messages appended after those
// Reconstruct by walking base back to the root, then replaying keep/tail forward.
//
// Caveat worth knowing before you trust the result: Claude Code only persists
// blobs for a subset of messages (roughly 25% across a large sample), so tail
// hashes frequently have no stored blob. When that happens the message is
// gone from the transcript - fill the slot with a placeholder rather than
// silently shifting every later index, which would misalign cacheControl paths.
function resolveRequest(req, byId, blobs, depth = 0) {
  if (depth > 500) throw new Error('base chain too deep - cycle?');
  const parent = req.base ? byId.get(req.base) : null;
  const head = parent ? resolveRequest(parent, byId, blobs, depth + 1) : [];
  const messages = head.slice(0, req.keep ?? 0);
  const missing = [];
  for (const h of (req.tail || [])) {
    const m = blobs.get(h);
    if (m) messages.push(m);
    else { messages.push({ role: 'unknown', content: [{ type: 'text', text: `[blob ${h.slice(0, 12)} not persisted]` }] }); missing.push(h); }
  }
  Object.defineProperty(messages, 'missingBlobs', { value: missing, enumerable: false });
  return messages;
}

function requestMode() {
  const { blobs, shapes, requests } = loadRequestIndex();
  if (!requests.length) { console.error('no api-request records in this file'); process.exit(1); }

  if (mode === 'list') {
    const rows = requests.map((r, i) => ({
      index: i,
      id: r.id,
      timestamp: r.timestamp,
      model: r.params?.model,
      base: r.base || null,
      keep: r.keep ?? 0,
      tail: (r.tail || []).length,
      digest: (r.requestDigest || '').slice(0, 12),
    }));
    if (asJson) { console.log(JSON.stringify(rows, null, 2)); return; }
    console.log('idx  timestamp                  model                    keep tail  id');
    for (const r of rows) {
      console.log(`${String(r.index).padStart(3)}  ${r.timestamp || '-'}  ${(r.model || '-').padEnd(22)} ${String(r.keep).padStart(4)} ${String(r.tail).padStart(4)}  ${r.id.slice(0, 8)}`);
    }
    return;
  }

  const idx = has('last') ? requests.length - 1 : Number(val('index') ?? requests.length - 1);
  const req = requests[idx];
  if (!req) { console.error(`no request at index ${idx} (have 0..${requests.length - 1})`); process.exit(1); }

  const byId = new Map(requests.map(r => [r.id, r]));
  const messages = resolveRequest(req, byId, blobs);
  const shape = shapes.get(req.shapeHash) || null;

  const payload = {
    index: idx,
    id: req.id,
    timestamp: req.timestamp,
    model: req.params?.model,
    params: req.params,
    system: shape?.system ?? null,
    tools: shape?.tools ?? null,
    cacheControl: req.cacheControl ?? null,
    messageCount: messages.length,
    missingBlobs: messages.missingBlobs || [],
    messages,
  };

  if (asJson) { console.log(JSON.stringify(payload, null, 2)); return; }

  console.log(`request ${idx}  ${req.timestamp}  model=${req.params?.model}`);
  console.log(`base=${req.base || '(root)'}  keep=${req.keep}  tail=${(req.tail || []).length}`);
  console.log(`messages=${messages.length}  unresolved blobs=${(messages.missingBlobs || []).length}`);
  console.log(`system blocks=${shape?.system?.length ?? 0}  tools=${shape?.tools?.length ?? 0}`);
  console.log('');
  messages.forEach((m, i) => {
    const c = m.content;
    const desc = Array.isArray(c)
      ? c.map(b => b.type === 'text' ? `text(${(b.text || '').length})` : b.type).join(' ')
      : `STR(${String(c ?? '').length})`;
    console.log(`[${String(i).padStart(3)}] ${String(m.role).padEnd(9)} ${desc}`);
  });
}

if (mode === 'dialog') {
  const text = dialog();
  const out = val('out');
  if (out) { fs.writeFileSync(out, text, 'utf8'); console.log(`wrote ${out} (${text.length} chars)`); }
  else console.log(text);
} else {
  requestMode();
}
