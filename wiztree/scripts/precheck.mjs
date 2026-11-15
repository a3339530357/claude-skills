#!/usr/bin/env node
/**
 * 清理前安全检查 —— 在删任何目录之前跑一遍，看文件有没有被进程锁住。
 *
 * 大小不要在这里算。WizTree 的 CSV 里已经有每个文件的大小，重新遍历磁盘
 * 等于把最慢的活干两遍：pnpm store 这类目录有十几万个小文件，Windows 上
 * 每个 statSync 都是一次随机 IO，几个目录串起来就能把机器拖死。
 * 所以：
 *   - 大小：从 CSV 查（--csv 参数），或者干脆不报，让调用方自己拿
 *   - 锁定：只抽样，默认 20 个文件，够判断了
 *
 * 用法:
 *   node precheck.mjs "C:\path\to\dir"                      # 只看锁定情况
 *   node precheck.mjs "C:\path" --csv scan.csv              # 同时从 CSV 报大小
 *   node precheck.mjs "C:\path" --sample 50                 # 抽样多少个文件
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const args = process.argv.slice(2);

function flag(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

// 带值的 flag 后面的那个参数是 flag 的值，不是扫描目标
const VALUE_FLAGS = new Set(["--csv", "--sample"]);
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (VALUE_FLAGS.has(a)) { i++; continue; }
  if (a.startsWith("--")) continue;
  positional.push(a);
}

if (positional.length === 0) {
  console.error("用法: node precheck.mjs <dir_or_file> [--csv scan.csv] [--sample N]");
  process.exit(1);
}

const SAMPLE = Number(flag("--sample", 20));
const CSV = flag("--csv", null);

/**
 * 从 WizTree CSV 里查目录大小。目录行自带累计大小，流式读一遍就行 ——
 * 全盘 CSV 有 700 MB 以上，readFileSync 会一次性吃进内存。
 */
async function loadSizes(csvPath, wanted) {
  const sizes = new Map();
  const rl = readline.createInterface({
    input: fs.createReadStream(csvPath, { encoding: "utf8", highWaterMark: 1 << 22 }),
    crlfDelay: Infinity,
  });
  let headerRows = 0;
  for await (const line of rl) {
    if (headerRows < 2) { headerRows++; continue; }
    if (line.length < 4 || line.charCodeAt(0) !== 34) continue;
    const end = line.indexOf('"', 1);
    if (end < 3) continue;
    const p = line.slice(1, end);
    if (!wanted.some((w) => p.startsWith(w))) continue;
    const sizeEnd = line.indexOf(",", end + 2);
    if (sizeEnd < 0) continue;
    const size = Number(line.slice(end + 2, sizeEnd));
    if (!Number.isFinite(size)) continue;
    const key = p.endsWith("\\") ? p.slice(0, -1) : p;
    if (!sizes.has(key)) sizes.set(key, size);
  }
  return sizes;
}

/**
 * 试着以读写方式打开文件。打不开且错误是 EBUSY/EPERM，说明别的进程正占着它。
 * 只抽样，不遍历整个目录 —— 遍历本身就是我们要避免的那件事。
 */
function isLocked(file) {
  try {
    const fd = fs.openSync(file, "r+");
    fs.closeSync(fd);
    return false;
  } catch (err) {
    return err.code === "EBUSY" || err.code === "EPERM";
  }
}

/** 广度优先取前 N 个文件，不做全量遍历。 */
function sampleFiles(dir, max) {
  const found = [];
  const queue = [dir];
  while (queue.length && found.length < max) {
    const cur = queue.shift();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      if (found.length >= max) break;
      const full = path.join(cur, e.name);
      if (e.isDirectory()) queue.push(full);
      else found.push(full);
    }
  }
  return found;
}

const sizes = CSV && fs.existsSync(CSV) ? await loadSizes(CSV, positional) : null;
if (CSV && !sizes) console.log(`(警告: 找不到 CSV ${CSV}，跳过大小查询)`);

for (const target of positional) {
  console.log(`\n=== ${target} ===`);
  const clean = target.replace(/\\+$/, "");

  if (sizes && sizes.has(clean)) {
    console.log(`  大小: ${(sizes.get(clean) / 1024 ** 3).toFixed(2)} GB (来自 CSV)`);
  } else if (sizes) {
    console.log(`  大小: CSV 里没有这个路径`);
  }

  let isDir = false;
  try { isDir = fs.statSync(clean).isDirectory(); } catch { console.log("  路径不存在"); continue; }

  if (!isDir) {
    console.log(`  占用: ${isLocked(clean) ? "是 —— 需要先关闭对应程序" : "否 —— 可直接删除"}`);
    continue;
  }

  const files = sampleFiles(clean, SAMPLE);
  if (files.length === 0) { console.log("  目录为空或无法读取"); continue; }

  const locked = files.filter(isLocked);
  console.log(`  抽样 ${files.length} 个文件, 被占用 ${locked.length} 个`);

  if (locked.length === 0) {
    const partial = files.length < SAMPLE ? "（未达到抽样上限，可能已全部检查）" : "";
    console.log(`  判定: 抽到的文件都能打开，可直接删除 ${partial}`);
  } else {
    console.log("  判定: 部分文件被占用 —— 直接删会删一半后失败");
    for (const f of locked.slice(0, 5)) console.log(`    ${f}`);
    console.log("  建议: 先停掉占用进程，或重启后再删");
  }
}
