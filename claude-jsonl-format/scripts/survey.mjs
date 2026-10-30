#!/usr/bin/env node
// survey.mjs - census a Claude Code transcript before you parse it.
//
// Claude Code's .jsonl has no published schema and fields drift between
// versions. Run this first: it tells you which record types actually occur
// in the file you are about to read, and the union of keys each one carries.
// Guessing from memory is how you end up with silently-undefined fields.
//
//   node survey.mjs <file.jsonl | directory> [--json]

import fs from 'fs';
import path from 'path';

const target = process.argv[2];
const asJson = process.argv.includes('--json');
if (!target) {
  console.error('usage: node survey.mjs <file.jsonl | directory> [--json]');
  process.exit(2);
}

function collect(p) {
  const st = fs.statSync(p);
  if (st.isFile()) return [p];
  return fs.readdirSync(p)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => path.join(p, f));
}

const files = collect(target);
const types = new Map();          // type -> { count, keys:Set, samples:[] }
const blockTypes = new Map();     // "record.role.block" -> count
const models = new Map();
const ids = new Map();            // assistant message.id -> row count
const uuids = new Set();
let total = 0, bad = 0;
const tsRange = [null, null];

function bump(map, key) { map.set(key, (map.get(key) || 0) + 1); }

for (const file of files) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { bad++; continue; }
    total++;

    const t = o.type || '(none)';
    if (!types.has(t)) types.set(t, { count: 0, keys: new Set(), samples: [] });
    const rec = types.get(t);
    rec.count++;
    for (const k of Object.keys(o)) rec.keys.add(k);
    if (rec.samples.length < 2) rec.samples.push(o);

    if (o.uuid) uuids.add(o.uuid);
    if (o.timestamp) {
      if (!tsRange[0] || o.timestamp < tsRange[0]) tsRange[0] = o.timestamp;
      if (!tsRange[1] || o.timestamp > tsRange[1]) tsRange[1] = o.timestamp;
    }

    const content = o.message?.content;
    if (o.message?.model) bump(models, o.message.model);
    if (o.type === 'assistant' && o.message?.id) bump(ids, o.message.id);

    if (Array.isArray(content)) {
      for (const b of content) bump(blockTypes, `${t}.${o.message.role}.${b.type || '?'}`);
    } else if (typeof content === 'string') {
      bump(blockTypes, `${t}.${o.message?.role}.STR`);
    }
  }
}

// Parent-chain integrity: parentUuid may point at ANY record carrying a uuid
// (user, assistant, system, attachment), not just messages. Counting only
// messages makes the chain look broken when it is fine.
let chainTotal = 0, chainRoot = 0, chainOk = 0, chainDangling = 0;
const seen = new Map();
for (const file of files) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.uuid) seen.set(o.uuid, o);
  }
}
for (const o of seen.values()) {
  if (o.parentUuid === undefined) continue;
  chainTotal++;
  if (o.parentUuid === null) chainRoot++;
  else if (seen.has(o.parentUuid)) chainOk++;
  else chainDangling++;
}

const multiRow = [...ids.values()].filter(n => n > 1).length;

const report = {
  files: files.length,
  records: total,
  unparseableLines: bad,
  timeRange: tsRange,
  recordTypes: [...types.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([type, v]) => ({ type, count: v.count, keys: [...v.keys].sort() })),
  contentBlocks: [...blockTypes.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => ({ block: k, count: n })),
  models: [...models.entries()].sort((a, b) => b[1] - a[1]).map(([m, n]) => ({ model: m, count: n })),
  assistantMessages: { distinctIds: ids.size, spanningMultipleRows: multiRow },
  parentChain: {
    records: chainTotal, roots: chainRoot, resolved: chainOk, dangling: chainDangling,
    note: 'parentUuid points at any uuid-bearing record (user/assistant/system/attachment)',
  },
};

if (asJson) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }

console.log(`files          : ${report.files}`);
console.log(`records        : ${report.records}${bad ? `  (${bad} unparseable lines skipped)` : ''}`);
console.log(`time range     : ${tsRange[0]} .. ${tsRange[1]}  (UTC)`);
console.log(`models         : ${report.models.map(m => `${m.model}(${m.count})`).join(', ')}`);
console.log(`assistant msgs : ${ids.size} distinct message.id, ${multiRow} span multiple rows`);
console.log(`parent chain   : ${chainOk}/${chainTotal} resolved, ${chainRoot} roots, ${chainDangling} dangling`);
console.log('\nrecord types (count, keys):');
for (const r of report.recordTypes) {
  console.log(`  ${r.type}  (${r.count})`);
  console.log(`      ${r.keys.join(', ')}`);
}
console.log('\ncontent blocks:');
for (const b of report.contentBlocks) console.log(`  ${String(b.count).padStart(6)}  ${b.block}`);
