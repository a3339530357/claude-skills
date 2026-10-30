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

// 第二组夹具：假签名、空白思考配长签名、调试快照、写盘中断拼接坏行。
const realSig = 'A'.repeat(1200);
const fixture2 = path.join(workspace, 'fixture2.jsonl');
const good = { type: 'assistant', uuid: 'b2', parentUuid: 'b1', message: { id: 'n1', model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'thinking', thinking: 'real', signature: realSig }] } };
const records2 = [
  { type: 'user', uuid: 'b0', message: { role: 'user', content: 'hi' } },
  { type: 'assistant', uuid: 'b1', parentUuid: 'b0', message: { id: 'g1', model: 'glm-5.3', role: 'assistant', content: [{ type: 'thinking', thinking: 'fake', signature: 'bd15955e368e4d6a9093e76a' }] } },
  good,
  { type: 'assistant', uuid: 'b3', parentUuid: 'b2', message: { id: 'n2', role: 'assistant', content: [{ type: 'thinking', thinking: '  ', signature: realSig }, { type: 'text', text: '正文2' }] } },
  { type: 'api-request-blob', hash: 'h1', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'snap', signature: '' }] } },
];
const lines2 = records2.map((r) => JSON.stringify(r));
// 模拟写盘中断：b4 的半截旧前缀与完整新记录拼在一行；完整记录自带的父节点不存在，前缀里的父节点 b3 存在。
const b4 = { type: 'user', uuid: 'b4', parentUuid: 'ghost', message: { role: 'user', content: 'tail' } };
lines2.push('{"parentUuid":"b3","' + JSON.stringify(b4));
const original2 = lines2.join('\n') + '\n';
fs.writeFileSync(fixture2, original2);
const run2 = (...args) => JSON.parse(execFileSync(process.execPath, [script, fixture2, ...args], { encoding: 'utf8' }));
const d2 = run2();
assert.equal(d2.invalidJson.length, 0);
assert.equal(d2.brokenLines.length, 1, '拼接坏行应识别为可恢复');
assert.equal(d2.untrustedReasons.shortSignature, 1, '24 字符签名应判为不可信');
assert.equal(d2.untrustedReasons.whitespace, 1, '空白思考即使带长签名也应删除');
assert.equal(d2.trustedBlocks, 1);
assert.equal(d2.missingParents.length, 0, '恢复行应接回前缀里的父节点');
let refused = false;
try { execFileSync(process.execPath, [script, fixture2, '--apply', '--backup-dir', path.join(workspace, 'backups2')], { stdio: 'pipe' }); } catch { refused = true; }
assert(refused, '未加 --recover-broken-lines 时应拒绝修复');
assert.equal(fs.readFileSync(fixture2, 'utf8'), original2);
run2('--apply', '--backup-dir', path.join(workspace, 'backups2'), '--recover-broken-lines');
const a2 = run2();
assert.equal(a2.repairNeeded, false);
assert.equal(a2.brokenLines.length, 0);
assert.equal(a2.missingParents.length, 0);
const out2 = fs.readFileSync(fixture2, 'utf8');
assert(!out2.includes('"fake"'));
assert(out2.includes(realSig), '真签名思考应保留');
assert(out2.includes('"snap"'), 'api-request* 调试快照不应被改');
assert(out2.split('\n').some((l) => l.includes('"uuid":"b4"') && l.includes('"parentUuid":"b3"')), 'b4 应接回前缀里的父节点 b3');

console.log(JSON.stringify({ passed: true, before: { removeRecords: before.removeRecords, reparentedRecords: before.reparentedRecords }, after: { repairNeeded: after.repairNeeded, counts: after.counts }, restoredSha256: restored.sha256 }, null, 2));
