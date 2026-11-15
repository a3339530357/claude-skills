#!/usr/bin/env node
/**
 * WizTree CSV 分析器 —— 给 WizTree 导出的 CSV 做汇总。
 *
 * WizTree 的导出每秒能处理百万行，但导出的 CSV 动辄几百 MB。
 * 用 Node 流式解析，别用 PowerShell 循环：PowerShell 是解释执行，
 * 五百万行要跑十几分钟；V8 有 JIT，同样的活两三秒。
 *
 * 用法:
 *   node analyze.mjs <csv> --root "C:\Users\x" --depth 2
 *   node analyze.mjs <csv> --root "C:\" --big 300MB
 *   node analyze.mjs <csv> --top 30
 */

import fs from "node:fs";
import readline from "node:readline";

const args = process.argv.slice(2);
const csv = args[0];
if (!csv) {
  console.error("用法: node analyze.mjs <csv> [--root PATH] [--depth N] [--big SIZE] [--top N]");
  process.exit(1);
}

function flag(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

const ROOT = flag("--root", null)?.replace(/\\+$/, "") ?? null;
const DEPTH = Number(flag("--depth", ROOT ? 2 : 1));
const TOP = Number(flag("--top", 40));

function parseSize(s) {
  const m = String(s).match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)?$/i);
  if (!m) return Number(s);
  const n = Number(m[1]);
  const unit = (m[2] || "B").toUpperCase();
  const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[unit];
  return Math.floor(n * mult);
}

const MIN_FILE = parseSize(flag("--big", "200MB"));
const rootDepth = ROOT ? ROOT.split("\\").length - 1 : 0;

const dirs = new Map();
const files = [];
let rows = 0;
let headerRows = 0;
let skipped = 0;

const rl = readline.createInterface({
  input: fs.createReadStream(csv, { encoding: "utf8", highWaterMark: 1 << 22 }),
  crlfDelay: Infinity,
});

for await (const line of rl) {
  // 前两行是生成信息和表头
  if (headerRows < 2) { headerRows++; continue; }
  rows++;
  if (line.length < 4 || line.charCodeAt(0) !== 34) { skipped++; continue; }

  const end = line.indexOf('"', 1);
  if (end < 3) { skipped++; continue; }
  const path = line.slice(1, end);

  const sizeEnd = line.indexOf(",", end + 2);
  if (sizeEnd < 0) { skipped++; continue; }
  const size = Number(line.slice(end + 2, sizeEnd));
  if (!Number.isFinite(size)) { skipped++; continue; }

  if (ROOT && !path.startsWith(ROOT)) continue;

  const isDir = path.charCodeAt(path.length - 1) === 92; // 反斜杠
  const trim = isDir ? path.slice(0, -1) : path;

  if (!isDir) {
    if (size >= MIN_FILE) files.push({ path, size });
    continue;
  }

  let depth = 0;
  for (let i = 0; i < trim.length; i++) if (trim.charCodeAt(i) === 92) depth++;
  // ROOT 自身（C:）要和 C:\Users 区分开：ROOT 的深度是它自己那层的层级数
  if (depth > rootDepth) {
    const rel = trim.slice(ROOT ? ROOT.length : 0).replace(/^\\/, "");
    const relDepth = rel === "" ? 0 : rel.split("\\").length;
    if (relDepth <= DEPTH) dirs.set(trim, size);
  }
}

const gb = (b) => (b / 1024 ** 3).toFixed(2).padStart(8);
const sortedDirs = [...dirs.entries()].sort((a, b) => b[1] - a[1]);
const sortedFiles = files.sort((a, b) => b.size - a.size);

const out = [];
const scope = ROOT ? `根: ${ROOT}  深度: ${DEPTH}` : `全盘统计  深度: ${DEPTH}`;
out.push(`${scope}`, `数据行: ${rows}  跳过: ${skipped}`, "");

out.push("===== 目录（按大小） =====");
for (const [k, v] of sortedDirs.slice(0, TOP)) out.push(`${k.padEnd(76)} ${gb(v)} GB`);

out.push("", `===== 单文件 >= ${flag("--big", "200MB")}（前 ${TOP}） =====`);
for (const f of sortedFiles.slice(0, TOP)) out.push(`${(f.size / 1024 ** 3).toFixed(2).padStart(8)} GB  ${f.path}`);

console.log(out.join("\n"));
