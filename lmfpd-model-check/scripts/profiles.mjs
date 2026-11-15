#!/usr/bin/env node
// profiles.mjs —— 常测的中转站/端点配置（lmfpd-model-check skill）
//
// 一个 profile = { base, key, api, model? }，存在 <skill>/data/endpoints.json。
// data/.gitignore 写的是 `*`，整个目录不进 git、不会被 sync.sh 推出去。
//
// key 只从 stdin 读，不接受命令行参数（会留在 shell 历史和进程列表里）。
//
// 用法：
//   printf '%s' "$KEY" | node profiles.mjs set oval --base https://www.oval.us.ci/v1 --api cc [--model xxx]
//   node profiles.mjs list
//   node profiles.mjs rm oval

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SKILL_DIR = path.resolve(HERE, '..');
export const DATA_DIR = path.join(SKILL_DIR, 'data');
export const PROFILES_FILE = path.join(DATA_DIR, 'endpoints.json');

export function readProfiles() {
  try {
    return JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function getProfile(name) {
  const all = readProfiles();
  if (all[name]) return all[name];
  // 大小写不敏感兜底
  const hit = Object.keys(all).find((k) => k.toLowerCase() === String(name).toLowerCase());
  return hit ? all[hit] : null;
}

export function maskKey(k) {
  if (!k) return '(无)';
  if (k.length <= 12) return k.slice(0, 3) + '***';
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}

function writeProfiles(all) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
  const gi = path.join(DATA_DIR, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '# 这个目录存 API key，任何内容都不提交\n*\n');
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').trim();
}

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

async function main() {
  const [cmd, name, ...rest] = process.argv.slice(2);
  const all = readProfiles();

  if (cmd === 'list' || !cmd) {
    const names = Object.keys(all);
    if (!names.length) {
      console.log('还没有保存任何端点。');
      return;
    }
    console.log('名称'.padEnd(14) + 'api'.padEnd(16) + 'key'.padEnd(16) + 'base');
    console.log('─'.repeat(80));
    for (const n of names) {
      const p = all[n];
      console.log(n.padEnd(14) + String(p.api || 'responses').padEnd(16) + maskKey(p.key).padEnd(16) + p.base + (p.model ? `   (默认模型 ${p.model})` : ''));
    }
    return;
  }

  if (cmd === 'rm') {
    if (!name || !all[name]) throw new Error(`没有名为 ${name} 的端点`);
    delete all[name];
    writeProfiles(all);
    console.log(`已删除 ${name}`);
    return;
  }

  if (cmd === 'set') {
    if (!name) throw new Error('用法: printf %s KEY | node profiles.mjs set NAME --base URL [--api cc|message|responses] [--model M]');
    const prev = all[name] || {};
    const key = (await readStdin()) || prev.key;
    const base = flag(rest, '--base') || prev.base;
    const api = flag(rest, '--api') || prev.api || 'responses';
    const model = flag(rest, '--model') || prev.model;
    if (!base) throw new Error('缺 --base');
    if (!key) throw new Error('缺 key：请通过 stdin 传入（printf %s KEY | node profiles.mjs set ...）');
    all[name] = { base, key, api, ...(model ? { model } : {}) };
    writeProfiles(all);
    console.log(`已保存 ${name}: base=${base} api=${api} key=${maskKey(key)}${model ? ` model=${model}` : ''}`);
    return;
  }

  throw new Error(`未知子命令 ${cmd}（可用: set / list / rm）`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error('错误: ' + e.message);
    process.exit(1);
  });
}
