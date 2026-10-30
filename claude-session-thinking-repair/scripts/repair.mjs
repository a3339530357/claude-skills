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
const backupDir = take('--backup-dir');
const restore = take('--restore');
const yes = args.includes('--yes');
const known = new Set(['--apply', '--all-thinking', '--backup-dir', '--restore', '--yes', '--json']);
for (const a of args) if (a.startsWith('--') && !known.has(a)) fail(`未知参数: ${a}`);
if (!file) fail('用法: repair.mjs <session.jsonl> [--apply --backup-dir <目录>] [--restore <备份文件> --yes] [--all-thinking] [--json]');
if (restore && (apply || backupDir || allThinking)) fail('--restore 不能与 --apply/--backup-dir/--all-thinking 同时使用');
if (apply && !backupDir) fail('--apply 必须同时指定 --backup-dir');
if (apply && restore) fail('不能同时修复和回滚');

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
function isTrusted(block) {
  return !allThinking && typeof block?.signature === 'string' && block.signature.trim().length > 0;
}
function needsRemoval(block) {
  return isThinking(block) && !isTrusted(block);
}
function contentBlocks(record) {
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
async function scan(fileName) {
  const input = fs.createReadStream(fileName, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const result = {
    lines: 0, invalidJson: [], records: 0, thinkingRecords: 0,
    removeBlocks: 0, removeRecords: 0, stripOnlyRecords: 0,
    trustedBlocks: 0, retainedRecords: 0, reparentedRecords: 0,
    duplicateUuids: [], missingParents: [], emptyContent: [],
    preservedSegments: [], signedTurnsWithUntrusted: [],
    counts: { text: 0, tool_use: 0, tool_result: 0, image: 0, server_tool_use: 0 },
    signedTurns: new Map(),
  };
  const uuidLines = new Map();
  for await (const line of rl) {
    result.lines++;
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch (e) {
      result.invalidJson.push({ line: result.lines, error: e.message });
      continue;
    }
    result.records++;
    if (record.uuid) {
      if (uuidLines.has(record.uuid)) result.duplicateUuids.push({ uuid: record.uuid, lines: [uuidLines.get(record.uuid), result.lines] });
      else uuidLines.set(record.uuid, result.lines);
    }
    const blocks = contentBlocks(record);
    const thinking = blocks.filter(isThinking);
    const untrusted = blocks.filter(needsRemoval);
    if (thinking.length) result.thinkingRecords++;
    result.trustedBlocks += thinking.filter((b) => !needsRemoval(b)).length;
    for (const b of blocks) if (Object.hasOwn(result.counts, b?.type)) result.counts[b.type]++;
    if (blocks.length && !blocks.some(isPayload)) result.emptyContent.push(result.lines);
    if (untrusted.length) {
      result.removeBlocks += untrusted.length;
      if (blocks.every(isThinking)) result.removeRecords++;
      else result.stripOnlyRecords++;
    }
    if (record.message?.id && thinking.length) {
      const item = result.signedTurns.get(record.message.id) || { trusted: 0, untrusted: 0 };
      item.trusted += thinking.filter((b) => !needsRemoval(b)).length;
      item.untrusted += untrusted.length;
      result.signedTurns.set(record.message.id, item);
    }
    if (record.type === 'system' && record.subtype === 'compact_boundary') {
      const uuids = record.compactMetadata?.preservedMessages?.uuids;
      if (Array.isArray(uuids)) result.preservedSegments.push({ line: result.lines, uuids });
    }
  }
  for (const [id, turn] of result.signedTurns) {
    if (turn.trusted && turn.untrusted) result.signedTurnsWithUntrusted.push(id);
  }
  // 第二次流式扫描只收集父引用，避免把整个会话载入内存。
  const parents = new Map();
  const rl2 = readline.createInterface({ input: fs.createReadStream(fileName, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl2) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r.uuid && r.parentUuid) parents.set(r.uuid, r.parentUuid);
  }
  const removed = new Set();
  const rl3 = readline.createInterface({ input: fs.createReadStream(fileName, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl3) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    const blocks = contentBlocks(r);
    if (r.uuid && blocks.length && blocks.every(isThinking) && blocks.some(needsRemoval)) removed.add(r.uuid);
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
  return { ...result, signedTurns: undefined, affectedSegments, orphanParents, preexistingMissingParents, repairNeeded: result.removeBlocks > 0 };
}
async function repair(fileName, backupDirectory) {
  const before = await scan(fileName);
  if (before.invalidJson.length) fail('原文件有无效 JSON，拒绝自动修复');
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
    createdAt: new Date().toISOString(), allThinking,
  };
  fs.writeFileSync(path.join(targetBackup, 'manifest.json'), JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' });

  const temp = path.join(targetBackup, 'repaired.jsonl');
  const out = fs.createWriteStream(temp, { flags: 'wx' });
  const removed = new Set();
  const parents = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(fileName, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if (r.uuid && r.parentUuid) parents.set(r.uuid, r.parentUuid);
    const blocks = contentBlocks(r);
    if (r.uuid && blocks.length && blocks.every(isThinking) && blocks.some(needsRemoval)) removed.add(r.uuid);
  }
  const nearestParent = (parent) => {
    const seen = new Set();
    let p = parent;
    while (removed.has(p) && !seen.has(p)) {
      seen.add(p);
      p = parents.get(p);
    }
    return p;
  };
  const rl2 = readline.createInterface({ input: fs.createReadStream(fileName, { encoding: 'utf8' }), crlfDelay: Infinity });
  let kept = 0;
  for await (const line of rl2) {
    if (!line.trim()) { out.write(line + '\n'); continue; }
    const r = JSON.parse(line);
    if (r.uuid && removed.has(r.uuid)) continue;
    const blocks = contentBlocks(r);
    if (blocks.length) {
      const filtered = blocks.filter((b) => !needsRemoval(b));
      if (!filtered.length) fail(`第 ${kept + 1} 条修复后为空，已中止`);
      r.message.content = filtered;
    }
    if (r.parentUuid) r.parentUuid = nearestParent(r.parentUuid);
    const cleaned = cleanObject(r, removed);
    out.write(JSON.stringify(cleaned) + '\n');
    kept++;
  }
  await new Promise((resolve, reject) => { out.end(resolve); out.on('error', reject); });
  const after = await scan(temp);
  compareCounts(before.counts, after.counts);
  if (after.invalidJson.length || after.duplicateUuids.length || after.missingParents.length) {
    fail('修复文件未通过 JSON/UUID/父链校验，原文件未修改');
  }
  if (after.repairNeeded) fail('修复后仍有需要删除的思考块，原文件未修改');
  const beforeSize = fs.statSync(fileName).size;
  const beforeHash = hash(fs.readFileSync(fileName));
  if (beforeHash !== metadata.sha256) fail('备份后原文件发生变化，拒绝覆盖；请重新诊断');
  fs.copyFileSync(temp, fileName);
  const finalHash = hash(fs.readFileSync(fileName));
  if (finalHash !== hash(fs.readFileSync(temp))) fail('写入后的文件校验失败；请使用备份回滚');
  fs.writeFileSync(path.join(targetBackup, 'result.json'), JSON.stringify({
    before: { repairNeeded: before.repairNeeded, removeBlocks: before.removeBlocks, removeRecords: before.removeRecords },
    after: { repairNeeded: after.repairNeeded, lines: after.lines, sha256: finalHash },
    originalBytes: beforeSize,
  }, null, 2) + '\n');
  console.log(JSON.stringify({ applied: true, backup: backupFile, manifest: path.join(targetBackup, 'manifest.json'), removedBlocks: before.removeBlocks, removedRecords: before.removeRecords, reparentedRecords: before.reparentedRecords, finalSha256: finalHash }, null, 2));
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
