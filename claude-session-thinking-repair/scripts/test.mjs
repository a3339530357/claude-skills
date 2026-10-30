#!/usr/bin/env node
// 在临时夹具上验证 repair.mjs，不读取或修改真实会话。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'repair.mjs');
const workspace = process.argv[2];
if (!workspace) throw new Error('用法: node scripts/test.mjs <项目目录下的测试目录>');
fs.mkdirSync(workspace, { recursive: true });
const fixture = path.join(workspace, 'fixture.jsonl');
const records = [
  { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hello' } },
  { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { id: 'm1', role: 'assistant', content: [{ type: 'thinking', thinking: ' ', signature: '' }] } },
  { type: 'assistant', uuid: 'a2', parentUuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: '保留正文' }] } },
  { type: 'assistant', uuid: 'a3', parentUuid: 'a2', message: { id: 'm2', role: 'assistant', content: [{ type: 'thinking', thinking: 'private', signature: '' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pwd' } }] } },
  { type: 'user', uuid: 'u2', parentUuid: 'a3', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'D:/project' }] } },
  { type: 'system', subtype: 'compact_boundary', uuid: 's1', parentUuid: 'u2', compactMetadata: { preservedMessages: { uuids: ['a1', 'a2'] } } },
];
const original = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
fs.writeFileSync(fixture, original);
const run = (...args) => JSON.parse(execFileSync(process.execPath, [script, fixture, ...args], { encoding: 'utf8' }));
const before = run();
assert.equal(before.repairNeeded, true);
assert.equal(before.removeRecords, 1);
assert.equal(before.reparentedRecords, 1);
assert.equal(before.affectedSegments.length, 1);
assert.equal(fs.readFileSync(fixture, 'utf8'), original, '诊断不应修改文件');
const applied = run('--apply', '--backup-dir', path.join(workspace, 'backups'));
const after = run();
assert.equal(after.repairNeeded, false);
assert.equal(after.missingParents.length, 0);
assert.equal(after.affectedSegments.length, 0);
assert.deepEqual(after.counts, before.counts);
const repaired = fs.readFileSync(fixture, 'utf8');
assert(!repaired.includes('private'));
const restored = run('--restore', applied.backup, '--yes');
assert.equal(fs.readFileSync(fixture, 'utf8'), original);
console.log(JSON.stringify({ passed: true, before: { removeRecords: before.removeRecords, reparentedRecords: before.reparentedRecords }, after: { repairNeeded: after.repairNeeded, counts: after.counts }, restoredSha256: restored.sha256 }, null, 2));
