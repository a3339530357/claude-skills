#!/usr/bin/env node
// Claude Code 单文件二进制检索工具：提取可打印文本，按函数名或关键字定位。
// 只读，不改安装文件；提取结果放 ~/.cache/ccsrc/，不写系统临时目录。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const cmd = args[0];

function die(msg) {
  console.error(`错误: ${msg}`);
  process.exit(2);
}

// Windows 上启动器叫 claude.exe，且 ~/.local/bin/claude.exe 是硬链接指向
// ~/.local/share/claude/versions/<版本>；Linux/macOS 上才是 claude（符号链接）。
const NAMES = process.platform === 'win32' ? ['claude.exe', 'claude'] : ['claude'];

function tryResolve(p) {
  try {
    if (fs.statSync(p).isFile() || fs.lstatSync(p).isSymbolicLink()) return fs.realpathSync(p);
  } catch {}
  return null;
}

function findBinary() {
  for (const n of NAMES) {
    const hit = tryResolve(path.join(os.homedir(), '.local', 'bin', n));
    if (hit) return hit;
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const n of NAMES) {
      const hit = tryResolve(path.join(dir, n));
      if (hit) return hit;
    }
  }
  die('找不到 claude 可执行文件；用 --binary <路径> 指定');
}

function opt(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

// fallback 必须惰性求值：写成 opt('--binary', findBinary()) 会无条件调用 findBinary()，
// 导致传了 --binary 仍然先跑一次探测（Windows 上探测失败就直接 exit 2）。
const binaryArg = opt('--binary', null);
const binary = path.resolve(binaryArg || findBinary());
const version = path.basename(binary);
const cacheDir = path.join(os.homedir(), '.cache', 'ccsrc');
const cacheFile = path.join(cacheDir, `${version}.txt`);

// 一次读 16MB。块尾未闭合的片段留到下一轮拼上，避免长字符串在块边界被切断。
// 注意：写入前必须复制，因为 buf 会被下一轮读取覆盖，createWriteStream 是异步落盘的。
async function extract() {
  if (!fs.existsSync(binary)) die(`二进制不存在: ${binary}`);
  const binStat = fs.statSync(binary);
  if (fs.existsSync(cacheFile)) {
    const c = fs.statSync(cacheFile);
    if (c.mtimeMs >= binStat.mtimeMs && c.size > 1024 * 1024) {
      console.log(JSON.stringify({ cached: true, file: cacheFile, bytes: c.size, binary, version }, null, 2));
      return;
    }
  }
  fs.mkdirSync(cacheDir, { recursive: true });
  const tmp = `${cacheFile}.tmp-${process.pid}`;
  const out = fs.createWriteStream(tmp);
  const finished = new Promise((res, rej) => { out.on('finish', res); out.on('error', rej); });
  const CHUNK = 16 * 1024 * 1024;
  const fd = fs.openSync(binary, 'r');
  const buf = Buffer.allocUnsafe(CHUNK);
  const MIN_RUN = 12;
  let pending = Buffer.alloc(0);
  let lines = 0;
  let pos = 0;
  const printable = (b) => b === 9 || b === 10 || (b >= 32 && b <= 126);
  const emit = (slice) => { out.write(Buffer.from(slice)); out.write('\n'); lines++; };
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK, pos);
      if (n <= 0) break;
      const view = buf.subarray(0, n);
      const data = pending.length ? Buffer.concat([pending, view]) : view;
      let i = 0;
      while (i < data.length) {
        if (!printable(data[i])) { i++; continue; }
        let j = i;
        while (j < data.length && printable(data[j])) j++;
        const atEof = n < CHUNK && j === data.length;
        if (j < data.length || atEof) {
          if (j - i >= MIN_RUN) emit(data.subarray(i, j));
        }
        i = j;
      }
      // 保留尾部未闭合的片段，下一轮拼上
      let k = data.length;
      while (k > 0 && printable(data[k - 1])) k--;
      pending = k < data.length ? Buffer.from(data.subarray(k)) : Buffer.alloc(0);
      pos += n;
      if (n < CHUNK) break;
    }
    if (pending.length >= MIN_RUN) emit(pending);
  } finally {
    fs.closeSync(fd);
    out.end();
  }
  await finished;
  fs.renameSync(tmp, cacheFile);
  const size = fs.statSync(cacheFile).size;
  console.log(JSON.stringify({ cached: false, file: cacheFile, bytes: size, lines, binary, version }, null, 2));
}

async function ensureCache() {
  if (!fs.existsSync(cacheFile)) {
    console.error(`首次使用，正在从 ${version} 提取文本…`);
    await extract();
    console.error('');
  }
  return fs.readFileSync(cacheFile, 'utf8');
}

// 从 start 处的 "function name(" 起数括号配对，返回函数体
function readFunctionBody(text, start) {
  let depth = 0;
  let seenOpen = false;
  let i = start;
  let inStr = null;
  let inTpl = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === inStr) inStr = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = ch; i++; continue; }
    if (ch === '`') { inTpl = inTpl ? 0 : 1; i++; continue; }
    if (ch === '{') { depth++; seenOpen = true; }
    else if (ch === '}') {
      depth--;
      if (seenOpen && depth === 0) return text.slice(start, i + 1);
    }
    i++;
  }
  return text.slice(start, Math.min(start + 4000, text.length));
}

async function func(name) {
  if (!name) die('用法: ccsrc.mjs func <函数名> [--binary <路径>]');
  const text = await ensureCache();
  const needle = `function ${name}(`;
  const hits = [];
  let at = text.indexOf(needle);
  while (at >= 0) {
    hits.push(at);
    at = text.indexOf(needle, at + 1);
  }
  if (!hits.length) {
    // 兜底：可能是箭头函数或简写赋值
    const alt = `${name}=`;
    let p = text.indexOf(alt);
    const altHits = [];
    while (p >= 0 && altHits.length < 20) { altHits.push(p); p = text.indexOf(alt, p + 1); }
    console.log(JSON.stringify({ found: false, name, hint: altHits.length ? `没有 function 声明，但有 ${altHits.length} 处 "${alt}" 赋值，可用 find 查` : '完全没找到，可能是懒加载 chunk 或已被改名' }, null, 2));
    return;
  }
  const bodies = hits.slice(0, 5).map((h) => readFunctionBody(text, h));
  console.log(JSON.stringify({ found: true, name, count: hits.length, bodies }, null, 2));
}

async function find(needle) {
  if (!needle) die('用法: ccsrc.mjs find <关键字> [--context <字符数>] [--limit <条数>]');
  const ctx = Number(opt('--context', '300'));
  const limit = Number(opt('--limit', '5'));
  const text = await ensureCache();
  const out = [];
  let at = text.indexOf(needle);
  let total = 0;
  while (at >= 0) {
    total++;
    if (out.length < limit) {
      out.push({
        offset: at,
        before: text.slice(Math.max(0, at - ctx), at),
        match: needle,
        after: text.slice(at + needle.length, Math.min(text.length, at + needle.length + ctx)),
      });
    }
    at = text.indexOf(needle, at + 1);
  }
  console.log(JSON.stringify({ needle, total, shown: out.length, hits: out }, null, 2));
}

function info() {
  const exists = fs.existsSync(cacheFile);
  const st = exists ? fs.statSync(cacheFile) : null;
  console.log(JSON.stringify({
    binary, version,
    binaryBytes: fs.existsSync(binary) ? fs.statSync(binary).size : null,
    cacheFile, cacheExists: exists, cacheBytes: st ? st.size : null,
    hint: exists ? null : '还没提取，跑一次 extract',
  }, null, 2));
}

try {
  if (cmd === 'extract') await extract();
  else if (cmd === 'func') await func(args[1]);
  else if (cmd === 'find') await find(args[1]);
  else if (cmd === 'info') info();
  else die('用法: ccsrc.mjs <extract|func|find|info> [...]\n  extract            提取可打印文本到 ~/.cache/ccsrc/\n  func <名称>        按 function 名取完整函数体\n  find <关键字>      搜文案/字段名，带上下文\n  info               显示路径与缓存状态\n  通用选项: --binary <路径>');
} catch (e) {
  die(e.message);
}
