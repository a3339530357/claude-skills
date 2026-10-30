'use strict';

// 日志：控制台打印 + JSONL 落盘
// 每条记录粒度为「一次完整的请求-响应」，body 可能为字符串或被截断为预览。
// 流式响应：累积所有 chunk 文本后写一条总日志，并在控制台实时按 chunk 打印。

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.resolve(__dirname, '..', 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function todayFile() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return path.join(LOG_DIR, `${y}-${m}-${day}.jsonl`);
}

const MAX_BODY_PREVIEW = parseInt(process.env.CC_ZHUABAO_BODY_PREVIEW || '8192', 10);

function truncate(text, limit = MAX_BODY_PREVIEW) {
  if (typeof text !== 'string') return text;
  if (text.length <= limit) return text;
  return text.slice(0, limit) + `\n…[truncated, total ${text.length} chars]`;
}

// 把 raw headers 数组（[name, value, name, value, ...]）转成对象
function rawHeadersToObject(raw) {
  const out = {};
  for (let i = 0; i < raw.length; i += 2) {
    const k = raw[i];
    const v = raw[i + 1];
    if (out[k] === undefined) out[k] = v;
    else if (Array.isArray(out[k])) out[k].push(v);
    else out[k] = [out[k], v];
  }
  return out;
}

// 简单的颜色输出（不依赖外部库）
const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};
function color(c, s) {
  return process.stdout.isTTY ? `${c}${s}${C.reset}` : s;
}

function methodColor(m) {
  switch ((m || '').toUpperCase()) {
    case 'GET': return color(C.green, m);
    case 'POST': return color(C.yellow, m);
    case 'PUT': return color(C.magenta, m);
    case 'DELETE': return color(C.red, m);
    default: return color(C.cyan, m);
  }
}

function statusColor(s) {
  if (!s) return '';
  if (s < 300) return color(C.green, s);
  if (s < 400) return color(C.cyan, s);
  if (s < 500) return color(C.yellow, s);
  return color(C.red, s);
}

function nowIso() { return new Date().toISOString(); }

function appendJsonl(record) {
  const file = todayFile();
  fs.appendFile(file, JSON.stringify(record) + '\n', () => {});
}

// 控制台打印请求头部行
function printRequestHeader(id, method, urlString, headers) {
  const u = new URL(urlString);
  const host = u.host;
  const pathOnly = u.pathname + (u.search || '');
  // eslint-disable-next-line no-console
  console.log(
    `\n${color(C.dim, nowIso())} ${color(C.bold, '#' + id)} ${methodColor(method)} ${color(C.bold, host)}${pathOnly}`
  );
  for (const [k, v] of Object.entries(headers)) {
    // eslint-disable-next-line no-console
    console.log(`  ${color(C.dim, '>')} ${color(C.cyan, k)}: ${Array.isArray(v) ? v.join(', ') : v}`);
  }
}

function printRequestBody(body) {
  if (body == null || body === '') return;
  // eslint-disable-next-line no-console
  console.log(color(C.dim, '  --- request body ---'));
  // eslint-disable-next-line no-console
  console.log(truncate(body));
}

function printResponseHeader(id, status, headers) {
  // eslint-disable-next-line no-console
  console.log(`${color(C.dim, nowIso())} ${color(C.bold, '#' + id)} ${statusColor(status)}`);
  for (const [k, v] of Object.entries(headers)) {
    // eslint-disable-next-line no-console
    console.log(`  ${color(C.dim, '<')} ${color(C.magenta, k)}: ${Array.isArray(v) ? v.join(', ') : v}`);
  }
}

function printResponseChunk(id, chunkText) {
  if (process.env.CC_ZHUABAO_QUIET_STREAM === '1') return;
  if (chunkText == null || chunkText === '') return;
  // 行级输出，前缀化便于阅读 SSE
  const prefix = color(C.dim, `  #${id} `);
  const lines = String(chunkText).split('\n');
  for (const line of lines) {
    if (line === '') continue;
    // eslint-disable-next-line no-console
    console.log(`${prefix}${line}`);
  }
}

function printResponseBodyFinal(body) {
  if (body == null || body === '') return;
  // eslint-disable-next-line no-console
  console.log(color(C.dim, '  --- response body ---'));
  // eslint-disable-next-line no-console
  console.log(truncate(body));
}

let counter = 0;
function nextId() {
  counter += 1;
  return counter;
}

module.exports = {
  appendJsonl,
  printRequestHeader,
  printRequestBody,
  printResponseHeader,
  printResponseChunk,
  printResponseBodyFinal,
  rawHeadersToObject,
  truncate,
  nextId,
  LOG_DIR,
};
