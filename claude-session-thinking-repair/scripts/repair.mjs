#!/usr/bin/env node
// Claude Code 会话存档修复：默认只读；--apply 才备份并替换原文件。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';

const args = process.argv.slice(2);
const take = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  if (i + 1 >= args.length) fail(`${name} 缺少参数`);
  return args[i + 1];
};
const file = args[0]?.startsWith('--') ? undefined : args[0];
const apply = args.includes('--apply');
const allThinking = args.includes('--all-thinking');
const recoverBroken = args.includes('--recover-broken-lines');
const backupDir = take('--backup-dir');
const restore = take('--restore');
const yes = args.includes('--yes');
const known = new Set(['--apply', '--all-thinking', '--recover-broken-lines', '--backup-dir', '--restore', '--yes', '--json']);
for (const a of args) if (a.startsWith('--') && !known.has(a)) fail(`未知参数: ${a}`);
if (!file) fail('用法: repair.mjs <session.jsonl> [--apply --backup-dir <目录>] [--restore <备份文件> --yes] [--all-thinking] [--recover-broken-lines] [--json]');
if (restore && (apply || backupDir || allThinking || recoverBroken)) fail('--restore 不能与 --apply/--backup-dir/--all-thinking/--recover-broken-lines 同时使用');
if (apply && !backupDir) fail('--apply 必须同时指定 --backup-dir');
if (apply && restore) fail('不能同时修复和回滚');

// 官方签名是上千字符的 base64 密文；第三方网关常塞 24/36 字符的 UUID 片段冒充，按无签名处理。
const MIN_SIGNATURE_LENGTH = 200;
const SIGNATURE_PATTERN = /^[A-Za-z0-9+/=_-]+$/;

function fail(message) {
  console.error(`错误: ${message}`);
  process.exit(2);
}
function hash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}
function isThinking(block) {
  return block?.type === 'thinking' || block?.type === 'redacted_thinking';
}
function untrustedReason(block) {
  if (allThinking) return 'allThinking';
  if (block?.type === 'thinking' && !(typeof block.thinking === 'string' && block.thinking.trim())) return 'whitespace';
  const sig = typeof block?.signature === 'string' ? block.signature.trim() : '';
  if (!sig) return 'missingSignature';
  if (sig.length < MIN_SIGNATURE_LENGTH || !SIGNATURE_PATTERN.test(sig)) return 'shortSignature';
  return null;
}
function needsRemoval(block) {
  return isThinking(block) && untrustedReason(block) !== null;
}
function contentBlocks(record) {
  // api-request* 是内容寻址的调试快照，改了会与 hash 不符，也不参与会话历史。
  if (typeof record?.type === 'string' && record.type.startsWith('api-request')) return [];
  return Array.isArray(record?.message?.content) ? record.message.content : [];
}
function isPayload(block) {
  return block && !isThinking(block);
}
function cleanObject(value, removed) {
  if (Array.isArray(value)) return value.map((v) => cleanObject(v, removed)).filter((v) => v !== undefined);
  if (!value || typeof value !== 'object') return removed.has(value) ? undefined : value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    // uuid 是记录自己的身份，不应因某个父记录被删而抹掉。
    if (key === 'uuid') { out[key] = child; continue; }
    const cleaned = cleanObject(child, removed);
    if (cleaned !== undefined) out[key] = cleaned;
  }
  return out;
}
function compareCounts(before, after) {
  const keys = ['text', 'tool_use', 'tool_result', 'image', 'server_tool_use'];
  const out = {};
  for (const key of keys) {
    if (before[key] !== after[key]) fail(`内容校验失败: ${key} ${before[key]} -> ${after[key]}`);
    out[key] = after[key];
  }
  return out;
}
// 写盘被打断后重写，会留下「半截旧记录 + 完整新记录」拼在同一行；取能解析且带 uuid 的后缀。
function recoverLine(line) {
  let i = line.indexOf('{"', 1);
  while (i > 0) {
    try {
      const record = JSON.parse(line.slice(i));
      if (record && typeof record === 'object' && record.uuid) {
        const prefixParent = line.slice(0, i).match(/"parentUuid":"([^"]+)"/)?.[1];
        return { record, prefixParent, offset: i };
      }
    } catch {}
    i = line.indexOf('{"', i + 1);
  }
  return null;
}
async function eachLine(fileName, fn) {
  const rl = readline.createInterface({ input: fs.createReadStream(fileName, { encoding: 'utf8' }), crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) fn(line, ++n);
}
async function prepass(fileName) {
  const uuids = new Set();
  const broken = [];
  await eachLine(fileName, (line, n) => {
    if (!line.trim()) return;
    try {
      const r = JSON.parse(line);
      if (r.uuid) uuids.add(r.uuid);
    } catch (e) {
      const rec = recoverLine(line);
      broken.push(rec
        ? { line: n, error: e.message, recoverable: true, uuid: rec.record.uuid, droppedPrefixChars: rec.offset }
        : { line: n, error: e.message, recoverable: false });
      if (rec) uuids.add(rec.record.uuid);
    }
  });
  return { uuids, broken };
}
function parseLine(line, ctx) {
  try { return JSON.parse(line); } catch {}
  const rec = recoverLine(line);
  if (!rec) return null;
  const r = rec.record;
  // 后缀自带的父节点不存在时，用前缀里那半截记录的父节点接回链上。
  if (r.parentUuid && !ctx.uuids.has(r.parentUuid) && rec.prefixParent && ctx.uuids.has(rec.prefixParent)) r.parentUuid = rec.prefixParent;
  return r;
}
async function scan(fileName) {
  const ctx = await prepass(fileName);
  const result = {
    lines: 0, invalidJson: ctx.broken.filter((b) => !b.recoverable), brokenLines: ctx.broken.filter((b) => b.recoverable),
    records: 0, thinkingRecords: 0,
    removeBlocks: 0, removeRecords: 0, stripOnlyRecords: 0,
    trustedBlocks: 0, untrustedReasons: {}, thinkingByModel: {}, reparentedRecords: 0,
    duplicateUuids: [], missingParents: [], emptyContent: [],
    preservedSegments: [], signedTurnsWithUntrusted: [],
    counts: { text: 0, tool_use: 0, tool_result: 0, image: 0, server_tool_use: 0 },
    signedTurns: new Map(),
  };
  const uuidLines = new Map();
  const parents = new Map();
  const removed = new Set();
  await eachLine(fileName, (line, n) => {
    result.lines = n;
    if (!line.trim()) return;
    const record = parseLine(line, ctx);
    if (!record) return;
    result.records++;
    if (record.uuid) {
      if (uuidLines.has(record.uuid)) result.duplicateUuids.push({ uuid: record.uuid, lines: [uuidLines.get(record.uuid), n] });
      else uuidLines.set(record.uuid, n);
      if (record.parentUuid) parents.set(record.uuid, record.parentUuid);
    }
    const blocks = contentBlocks(record);
    const thinking = blocks.filter(isThinking);
    const untrusted = blocks.filter(needsRemoval);
    if (thinking.length) result.thinkingRecords++;
    result.trustedBlocks += thinking.length - untrusted.length;
    const model = record.message?.model || '(无 model)';
    for (const b of thinking) {
      const reason = untrustedReason(b);
      const m = result.thinkingByModel[model] ||= { trusted: 0, untrusted: 0 };
      if (reason) { m.untrusted++; result.untrustedReasons[reason] = (result.untrustedReasons[reason] || 0) + 1; } else m.trusted++;
    }
    for (const b of blocks) if (Object.hasOwn(result.counts, b?.type)) result.counts[b.type]++;
    if (blocks.length && !blocks.some(isPayload)) result.emptyContent.push(n);
    if (untrusted.length) {
      result.removeBlocks += untrusted.length;
      if (blocks.every(isThinking)) {
        result.removeRecords++;
        if (record.uuid) removed.add(record.uuid);
      } else result.stripOnlyRecords++;
    }
    if (record.message?.id && thinking.length) {
      const item = result.signedTurns.get(record.message.id) || { trusted: 0, untrusted: 0 };
      item.trusted += thinking.length - untrusted.length;
      item.untrusted += untrusted.length;
      result.signedTurns.set(record.message.id, item);
    }
    if (record.type === 'system' && record.subtype === 'compact_boundary') {
      const uuids = record.compactMetadata?.preservedMessages?.uuids;
      if (Array.isArray(uuids)) result.preservedSegments.push({ line: n, uuids });
    }
  });
  for (const [id, turn] of result.signedTurns) {
    if (turn.trusted && turn.untrusted) result.signedTurnsWithUntrusted.push(id);
  }
  for (const [uuid, parent] of parents) {
    if (!uuidLines.has(parent)) result.missingParents.push({ uuid, parent });
    if (removed.has(uuid)) continue;
    let p = parent;
    const seen = new Set();
    while (removed.has(p) && !seen.has(p)) {
      seen.add(p);
      p = parents.get(p);
    }
    if (p !== parent) result.reparentedRecords++;
  }
  const affectedSegments = result.preservedSegments.filter((s) => s.uuids.some((u) => removed.has(u)));
  const orphanParents = result.missingParents.filter((x) => removed.has(x.parent));
  const preexistingMissingParents = result.missingParents.filter((x) => !removed.has(x.parent));
  return {
    ...result, signedTurns: undefined, affectedSegments, orphanParents, preexistingMissingParents,
    repairNeeded: result.removeBlocks > 0 || result.brokenLines.length > 0,
  };
}
async function repair(fileName, backupDirectory) {
  const before = await scan(fileName);
  if (before.invalidJson.length) fail(`有 ${before.invalidJson.length} 行无法解析也无法恢复，拒绝自动修复`);
  if (before.brokenLines.length && !recoverBroken) {
    fail(`有 ${before.brokenLines.length} 行是写盘中断造成的拼接坏行（见诊断 brokenLines）；确认后加 --recover-broken-lines 一并恢复`);
  }
  if (before.orphanParents.length) fail('存在父节点将被删除但无法重接的记录，拒绝自动修复');
  if (!before.repairNeeded) {
    console.log('没有需要删除的思考块；未修改文件。');
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const targetBackup = path.join(path.resolve(backupDirectory), stamp);
  fs.mkdirSync(targetBackup, { recursive: true });
  const original = fs.readFileSync(fileName);
  const backupFile = path.join(targetBackup, 'original.jsonl');
  fs.writeFileSync(backupFile, original, { flag: 'wx' });
  const metadata = {
    source: path.resolve(fileName), backup: backupFile,
    sha256: hash(original), bytes: original.length,
    createdAt: new Date().toISOString(), allThinking, recoverBroken,
  };
  fs.writeFileSync(path.join(targetBackup, 'manifest.json'), JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' });

  const ctx = await prepass(fileName);
  const removed = new Set();
  const parents = new Map();
  await eachLine(fileName, (line) => {
    if (!line.trim()) return;
    const r = parseLine(line, ctx);
    if (!r) return;
    if (r.uuid && r.parentUuid) parents.set(r.uuid, r.parentUuid);
    const blocks = contentBlocks(r);
    if (r.uuid && blocks.length && blocks.every(isThinking) && blocks.some(needsRemoval)) removed.add(r.uuid);
  });
  const nearestParent = (parent) => {
    const seen = new Set();
    let p = parent;
    while (removed.has(p) && !seen.has(p)) {
      seen.add(p);
      p = parents.get(p);
    }
    return p;
  };
  const temp = path.join(targetBackup, 'repaired.jsonl');
  const out = fs.createWriteStream(temp, { flags: 'wx' });
  let kept = 0;
  await eachLine(fileName, (line) => {
    if (!line.trim()) { out.write(line + '\n'); return; }
    const r = parseLine(line, ctx);
    if (r.uuid && removed.has(r.uuid)) return;
    const blocks = contentBlocks(r);
    if (blocks.length) {
      const filtered = blocks.filter((b) => !needsRemoval(b));
      if (!filtered.length) fail(`第 ${kept + 1} 条修复后为空，已中止`);
      r.message.content = filtered;
    }
    if (r.parentUuid) r.parentUuid = nearestParent(r.parentUuid);
    out.write(JSON.stringify(cleanObject(r, removed)) + '\n');
    kept++;
  });
  await new Promise((resolve, reject) => { out.end(resolve); out.on('error', reject); });
  const after = await scan(temp);
  compareCounts(before.counts, after.counts);
  if (after.invalidJson.length || after.brokenLines.length || after.duplicateUuids.length || after.missingParents.length) {
    fail('修复文件未通过 JSON/UUID/父链校验，原文件未修改');
  }
  if (after.repairNeeded) fail('修复后仍有需要删除的思考块，原文件未修改');
  const beforeSize = fs.statSync(fileName).size;
  if (hash(fs.readFileSync(fileName)) !== metadata.sha256) {
    fail('备份后原文件发生变化（会话仍在写入）；原文件未修改。先完全退出该 Claude Code 会话、修复完成前不要 resume，再从另一个 shell 重跑');
  }
  fs.copyFileSync(temp, fileName);
  const finalHash = hash(fs.readFileSync(fileName));
  if (finalHash !== hash(fs.readFileSync(temp))) fail('写入后的文件校验失败；请使用备份回滚');
  fs.writeFileSync(path.join(targetBackup, 'result.json'), JSON.stringify({
    before: { repairNeeded: before.repairNeeded, removeBlocks: before.removeBlocks, removeRecords: before.removeRecords, brokenLines: before.brokenLines.length },
    after: { repairNeeded: after.repairNeeded, lines: after.lines, sha256: finalHash },
    originalBytes: beforeSize,
  }, null, 2) + '\n');
  console.log(JSON.stringify({ applied: true, backup: backupFile, manifest: path.join(targetBackup, 'manifest.json'), removedBlocks: before.removeBlocks, removedRecords: before.removeRecords, reparentedRecords: before.reparentedRecords, recoveredBrokenLines: before.brokenLines.length, finalSha256: finalHash }, null, 2));
}
function restoreFile(fileName, backupFile) {
  if (!yes) fail('回滚会覆盖当前会话文件；确认路径后添加 --yes');
  const source = fs.readFileSync(backupFile);
  const manifestFile = path.join(path.dirname(backupFile), 'manifest.json');
  if (fs.existsSync(manifestFile)) {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (path.resolve(manifest.source) !== path.resolve(fileName)) fail('备份属于另一个会话，拒绝回滚');
    if (hash(source) !== manifest.sha256) fail('备份文件哈希与 manifest 不符，拒绝回滚');
  } else fail('找不到 manifest.json，拒绝自动回滚');
  fs.copyFileSync(backupFile, fileName);
  if (hash(fs.readFileSync(fileName)) !== hash(source)) fail('回滚后哈希校验失败');
  console.log(JSON.stringify({ restored: true, file: path.resolve(fileName), backup: path.resolve(backupFile), sha256: hash(source) }, null, 2));
}

try {
  if (restore) restoreFile(file, restore);
  else if (apply) await repair(file, backupDir);
  else {
    const report = await scan(file);
    console.log(JSON.stringify(report, null, 2));
    if (report.invalidJson.length || report.duplicateUuids.length) process.exitCode = 1;
  }
} catch (e) {
  fail(e.message);
}
