#!/usr/bin/env node
// 交互式选择要修复的会话：先选项目目录，再选其中一次会话或整个目录。
// 只负责挑选和确认，诊断/修复/备份全部交给同目录的 repair.mjs，规则不在这里重复实现。
//
// 用法: node pick.mjs [--root <projects目录>] [--all-thinking]
//   --root          指定 projects 目录；不给则自动找 $CLAUDE_CONFIG_DIR/projects 与 ~/.claude/projects
//   --all-thinking  透传给 repair.mjs：连看似真签名的思考块也删（一般不需要）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const here = path.dirname(fileURLToPath(import.meta.url));
const repairScript = path.join(here, 'repair.mjs');
const args = process.argv.slice(2);
const known = new Set(['--root', '--all-thinking']);
for (const a of args) if (a.startsWith('--') && !known.has(a)) die(`未知参数: ${a}`);
const rootArg = (() => { const i = args.indexOf('--root'); return i < 0 ? undefined : args[i + 1] || die('--root 缺少参数'); })();
const allThinking = args.includes('--all-thinking');
// 最近这么久内有写入的会话视为可能仍在使用；repair.mjs 的哈希检查是最后一道保护，这里只是提前提醒。
const BUSY_MS = 3 * 60 * 1000;

if (!fs.existsSync(repairScript)) die(`找不到 ${repairScript}`);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on('SIGINT', () => { console.log('\n已取消，未修改任何文件。'); process.exit(130); });
// 用行迭代器而不是 rl.question：管道输入时提前到达的行不会丢。
const lines = rl[Symbol.asyncIterator]();
async function ask(q) {
  process.stdout.write(q);
  const { value, done } = await lines.next();
  if (done) { console.log('\n输入已结束，未修改任何文件。'); process.exit(0); }
  return value.trim();
}

function die(message) {
  console.error(`错误: ${message}`);
  process.exit(2);
}
function fmtTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtSize(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)}K`;
  return `${(n / 1024 ** 2).toFixed(1)}M`;
}
function clip(s, n) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ---------- 发现 projects 目录 ----------
function findRoots() {
  if (rootArg) {
    if (!fs.existsSync(rootArg)) die(`目录不存在: ${rootArg}`);
    return [path.resolve(rootArg)];
  }
  const candidates = [];
  if (process.env.CLAUDE_CONFIG_DIR) candidates.push(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects'));
  candidates.push(path.join(os.homedir(), '.claude', 'projects'));
  // 配置目录可能是指向 ~/.claude 的符号链接，按真实路径去重。
  const seen = new Map();
  for (const c of candidates) {
    try { const real = fs.realpathSync(c); if (!seen.has(real)) seen.set(real, c); } catch {}
  }
  return [...seen.values()];
}

function listSessions(projectDir) {
  const out = [];
  for (const e of fs.readdirSync(projectDir, { withFileTypes: true })) {
    // 只列顶层会话文件；<会话>/subagents/ 下的子代理存档不参与 resume。
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    const file = path.join(projectDir, e.name);
    const st = fs.statSync(file);
    out.push({ file, id: e.name.slice(0, -6), mtime: st.mtimeMs, size: st.size });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function listProjects(root) {
  const out = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    let sessions;
    try { sessions = listSessions(dir); } catch { continue; }
    if (!sessions.length) continue;
    out.push({ dir, name: e.name, count: sessions.length, mtime: sessions[0].mtime, size: sessions.reduce((s, x) => s + x.size, 0) });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// ---------- 会话标题：尾部找 custom-title/ai-title，头部找首条用户输入 ----------
function readSlice(file, start, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n).toString('utf8');
  } finally { fs.closeSync(fd); }
}
function parseLines(text) {
  const out = [];
  for (const line of text.split('\n')) { try { out.push(JSON.parse(line)); } catch {} }
  return out;
}
function sessionTitle(s) {
  const TAIL = 512 * 1024;
  const tail = parseLines(readSlice(s.file, Math.max(0, s.size - TAIL), Math.min(TAIL, s.size)));
  let custom, ai, cwd;
  for (const r of tail) {
    if (r.type === 'custom-title' && r.customTitle) custom = r.customTitle;
    if (r.type === 'ai-title' && r.aiTitle) ai = r.aiTitle;
    if (r.cwd) cwd = r.cwd;
  }
  let first;
  const head = parseLines(readSlice(s.file, 0, Math.min(256 * 1024, s.size)));
  for (const r of head) {
    if (!cwd && r.cwd) cwd = r.cwd;
    if (first || r.type !== 'user' || r.isMeta) continue;
    const c = r.message?.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.find((b) => b?.type === 'text')?.text : undefined;
    if (text && !text.startsWith('<')) first = text;
  }
  return { title: custom || ai || first || '(无标题)', cwd };
}

// ---------- 选择 ----------
async function chooseRoot(roots) {
  if (!roots.length) die('没找到 projects 目录，用 --root 指定');
  if (roots.length === 1) return roots[0];
  console.log('\n找到多个 projects 目录:');
  roots.forEach((r, i) => console.log(`  ${i + 1}) ${r}`));
  for (;;) {
    const a = await ask('选择编号 (q 退出): ');
    if (a === 'q') quit();
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= roots.length) return roots[n - 1];
  }
}

async function chooseProject(root) {
  const all = listProjects(root);
  if (!all.length) die(`${root} 下没有会话`);
  let filter = '';
  for (;;) {
    const shown = filter ? all.filter((p) => p.name.toLowerCase().includes(filter.toLowerCase())) : all;
    console.log(`\n项目目录 (${root})${filter ? `，过滤「${filter}」` : ''}，按最近修改排序:`);
    shown.forEach((p, i) => console.log(`  ${String(i + 1).padStart(3)}) ${fmtTime(p.mtime)}  ${String(p.count).padStart(3)} 个会话  ${fmtSize(p.size).padStart(6)}  ${p.name}`));
    if (!shown.length) console.log('  (没有匹配项)');
    const a = await ask('输入编号选择；输入文字按目录名过滤；空回车清除过滤；q 退出: ');
    if (a === 'q') quit();
    if (a === '') { filter = ''; continue; }
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= shown.length) return shown[n - 1];
    filter = a;
  }
}

// 返回 { sessions, whole }；whole 表示整个目录。
async function chooseSessions(project) {
  const sessions = listSessions(project.dir);
  const now = Date.now();
  console.log(`\n${project.name} 下的会话（按最近修改排序）:`);
  sessions.forEach((s, i) => {
    const info = sessionTitle(s);
    s.title = info.title;
    s.cwd = info.cwd;
    s.busy = now - s.mtime < BUSY_MS;
    console.log(`  ${String(i + 1).padStart(3)}) ${fmtTime(s.mtime)}  ${fmtSize(s.size).padStart(6)}  ${s.id.slice(0, 8)}  ${clip(s.title, 50)}${s.busy ? '  [刚有写入，可能仍在使用]' : ''}`);
  });
  for (;;) {
    const a = await ask('输入编号（可多个，如 1,3,5）；a = 整个目录；b = 返回；q 退出: ');
    if (a === 'q') quit();
    if (a === 'b') return null;
    if (a === 'a') return { sessions, whole: true };
    const nums = a.split(/[,，\s]+/).filter(Boolean).map(Number);
    if (nums.length && nums.every((n) => Number.isInteger(n) && n >= 1 && n <= sessions.length)) {
      return { sessions: [...new Set(nums)].map((n) => sessions[n - 1]), whole: false };
    }
    console.log('输入无效。');
  }
}

// ---------- 调用 repair.mjs ----------
function runRepair(extra) {
  const r = spawnSync(process.execPath, [repairScript, ...extra], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  return { code: r.status, stdout: r.stdout || '', stderr: (r.stderr || '').trim() };
}
function diagnose(s) {
  const r = runRepair([s.file, ...(allThinking ? ['--all-thinking'] : [])]);
  try { return JSON.parse(r.stdout); } catch { return { error: r.stderr || `repair.mjs 退出码 ${r.code}` }; }
}
function describe(d) {
  if (d.error) return `诊断失败: ${clip(d.error, 80)}`;
  const parts = [];
  if (d.repairNeeded) parts.push(`需修复：删 ${d.removeBlocks} 个思考块（整行删 ${d.removeRecords} 条，重接 ${d.reparentedRecords} 条）`);
  else parts.push('无需修复');
  if (d.brokenLines?.length) parts.push(`拼接坏行 ${d.brokenLines.length}`);
  if (d.invalidJson?.length) parts.push(`无法恢复的坏行 ${d.invalidJson.length}`);
  if (d.orphanParents?.length) parts.push(`无法重接 ${d.orphanParents.length}`);
  if (d.affectedSegments?.length) parts.push(`影响压缩保留段 ${d.affectedSegments.length}`);
  if (d.signedTurnsWithUntrusted?.length) parts.push(`签名混杂回合 ${d.signedTurnsWithUntrusted.length}`);
  return parts.join('；');
}
// repair.mjs 会直接拒绝的情况，提前排除，免得批量时刷屏。
function blocker(d) {
  if (d.error) return '诊断失败';
  if (d.invalidJson?.length) return '有无法恢复的坏行';
  if (d.orphanParents?.length) return '有无法重接的记录';
  return null;
}

function quit() {
  console.log('已退出，未修改任何文件。');
  rl.close();
  process.exit(0);
}

async function yesNo(q, def = false) {
  const a = (await ask(`${q} ${def ? '[Y/n]' : '[y/N]'}: `)).toLowerCase();
  if (!a) return def;
  return a === 'y' || a === 'yes';
}

// ---------- 主流程 ----------
const root = await chooseRoot(findRoots());
let picked;
let project;
while (!picked) {
  project = await chooseProject(root);
  picked = await chooseSessions(project);
}

console.log(`\n诊断 ${picked.sessions.length} 个会话（只读）...`);
const results = [];
for (const [i, s] of picked.sessions.entries()) {
  if (picked.sessions.length > 1) process.stdout.write(`  [${i + 1}/${picked.sessions.length}] ${s.id.slice(0, 8)} ... `);
  const d = diagnose(s);
  results.push({ s, d });
  if (picked.sessions.length > 1) console.log(describe(d));
  else console.log(`  ${s.id}\n  ${describe(d)}`);
}

let todo = results.filter(({ d }) => !d.error && d.repairNeeded);
const blocked = todo.filter(({ d }) => blocker(d));
todo = todo.filter(({ d }) => !blocker(d));
for (const { s, d } of blocked) console.log(`  跳过 ${s.id.slice(0, 8)}：${blocker(d)}，需人工处理（单独运行 repair.mjs 查看完整诊断）`);
for (const { s, d } of results.filter(({ d }) => d.error)) console.log(`  跳过 ${s.id.slice(0, 8)}：${d.error}`);

if (!todo.length) {
  console.log('\n没有可自动修复的会话，未修改任何文件。');
  rl.close();
  process.exit(0);
}

const busy = todo.filter(({ s }) => s.busy);
if (busy.length) {
  console.log(`\n以下 ${busy.length} 个会话 ${BUSY_MS / 60000} 分钟内有写入，可能仍在使用（包括正在运行本脚本的那个会话）:`);
  for (const { s } of busy) console.log(`  ${s.id.slice(0, 8)}  ${clip(s.title, 50)}`);
  console.log('仍在使用的会话修了也会因「原文件发生变化」中止，或修完又被追加写入。');
  if (!(await yesNo('仍要包含它们吗？'))) todo = todo.filter(({ s }) => !s.busy);
  if (!todo.length) { console.log('没有剩余会话，未修改任何文件。'); rl.close(); process.exit(0); }
}

let recoverBroken = false;
const withBroken = todo.filter(({ d }) => d.brokenLines?.length);
if (withBroken.length) {
  console.log(`\n${withBroken.length} 个会话有写盘中断造成的拼接坏行：修复会取每行能解析的后半段完整记录，丢掉前面半截旧记录。`);
  recoverBroken = await yesNo('一并恢复这些坏行吗？（选否则跳过这些会话）');
  if (!recoverBroken) todo = todo.filter(({ d }) => !d.brokenLines?.length);
  if (!todo.length) { console.log('没有剩余会话，未修改任何文件。'); rl.close(); process.exit(0); }
}

// 备份默认放在当前目录下的顶层文件夹里，不用系统临时目录。
const defaultBackup = path.join(process.cwd(), 'claude-session-repair-backups');
console.log('\n备份目录：修复前把原文件完整复制过去，可用 --restore 回滚。');
const b = await ask(`回车使用默认 ${defaultBackup}；输入其他路径；输入 none 不备份: `);
let backupRoot = null;
if (b.toLowerCase() === 'none') {
  console.log('警告：不留备份，修复后无法回滚。');
  if (!(await yesNo('确定不备份？'))) backupRoot = defaultBackup;
} else backupRoot = path.resolve(b || defaultBackup);

console.log(`\n即将修复 ${todo.length} 个会话${picked.whole ? `（整个目录 ${project.name}）` : ''}:`);
for (const { s, d } of todo) console.log(`  ${s.id.slice(0, 8)}  删 ${d.removeBlocks} 个思考块${d.brokenLines?.length ? `，恢复坏行 ${d.brokenLines.length}` : ''}  ${clip(s.title, 40)}`);
console.log('修复会丢弃这些会话里不可验证的历史思考块（正文、工具调用和结果、附件、压缩摘要保留）。');
console.log(`备份: ${backupRoot || '不备份'}${allThinking ? '；模式: --all-thinking（删除全部思考块）' : ''}`);
console.log('请确认这些会话都已完全退出。');
if ((await ask('输入 yes 开始修复: ')).toLowerCase() !== 'yes') quit();
rl.close();

const report = [];
for (const { s } of todo) {
  const extra = [s.file, '--apply'];
  // 每个会话一个子目录，repair.mjs 再在里面建时间戳目录，回滚时一眼能对上。
  if (backupRoot) extra.push('--backup-dir', path.join(backupRoot, project.name, s.id));
  if (recoverBroken) extra.push('--recover-broken-lines');
  if (allThinking) extra.push('--all-thinking');
  process.stdout.write(`  ${s.id.slice(0, 8)} ... `);
  const r = runRepair(extra);
  let out = null;
  try { out = JSON.parse(r.stdout); } catch {}
  if (r.code === 0 && out?.applied) {
    console.log(`完成：删 ${out.removedBlocks} 个思考块`);
    report.push({ s, ok: true, backup: out.backup });
  } else {
    const msg = r.stderr.split('\n').filter((l) => !l.startsWith('注意:')).join(' ') || r.stdout.trim();
    console.log(`未修改：${clip(msg, 120)}`);
    report.push({ s, ok: false });
  }
}

const ok = report.filter((x) => x.ok);
console.log(`\n结果：成功 ${ok.length}，未修改 ${report.length - ok.length}。`);
if (ok.some((x) => x.backup)) {
  console.log('\n如需回滚（会覆盖当前会话文件，先确认会话已退出）:');
  for (const { s, backup } of ok.filter((x) => x.backup)) {
    console.log(`  node "${repairScript}" "${s.file}" --restore "${backup}" --yes`);
  }
}
if (ok.length) {
  console.log('\n下一步：resume 会话后切官方模型发一个简单请求；看最新 api-request 记录的 params.model 确认真的发给了官方模型。');
  console.log('修好的会话里不要再切回第三方模型聊天，否则下次切官方又会 400。');
}
process.exit(report.length - ok.length ? 1 : 0);
