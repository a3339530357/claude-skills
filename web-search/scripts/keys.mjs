#!/usr/bin/env node
// keys.mjs —— API key 的读取 / 保存（web-search skill）
//
// 查找顺序：
//   1. 环境变量（DEEPSEEK_API_KEY / GLM_API_KEY）—— 临时覆盖用
//   2. <skill>/data/keys.json —— 正常路径，首次使用时由 ensureKey() 写入
//
// data/.gitignore 写的是 `*`，整个目录不进 git、不会被 sync.sh 推到服务器。
//
// 这个文件只负责存取，不负责向用户提问。提问是 Claude 的事（见 SKILL.md），
// 脚本之所以不自己做交互式 prompt，是因为在 agent 里跑 readline 会卡住。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SKILL_DIR = path.resolve(HERE, '..');
export const DATA_DIR = path.join(SKILL_DIR, 'data');
export const KEYS_FILE = path.join(DATA_DIR, 'keys.json');

export const PROVIDERS = {
  deepseek: {
    env: 'DEEPSEEK_API_KEY',
    label: 'DeepSeek',
    // 用户去哪拿：https://platform.deepseek.com/api_keys
    hint: 'DeepSeek 平台的 API key，形如 sk-xxxxxxxx（32 位十六进制）',
  },
  glm: {
    env: 'GLM_API_KEY',
    label: '智谱 GLM',
    // 用户去哪拿：https://open.bigmodel.cn/usercenter/apikeys
    hint: '智谱开放平台的 API key，形如 xxxxxxxx.xxxxxxxx（点号分成两段）',
  },
};

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

// 拿到某个 provider 的 key，拿不到返回 null。
// 返回值不做任何日志打印——调用方也不该打印。
export function getKey(provider) {
  const spec = PROVIDERS[provider];
  if (!spec) throw new Error(`未知 provider: ${provider}`);
  const fromEnv = process.env[spec.env];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const v = readAll()[provider];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export function hasKey(provider) {
  return getKey(provider) !== null;
}

// 脱敏展示：只留头尾，用来让用户确认存的是哪一把
export function maskKey(k) {
  if (!k) return '(未设置)';
  if (k.length <= 12) return k.slice(0, 3) + '***';
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}

// 保存。写 0600 权限（Windows 上不生效但保留意图），并确保 data/ 存在。
export function saveKey(provider, key) {
  if (!PROVIDERS[provider]) throw new Error(`未知 provider: ${provider}`);
  const k = String(key || '').trim();
  if (!k) throw new Error('key 为空');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const all = readAll();
  all[provider] = k;
  fs.writeFileSync(KEYS_FILE, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
  // 每次写完都确认 .gitignore 在位，防止有人误删后把 key 提交上去
  const gi = path.join(DATA_DIR, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '# 这个目录存 API key，任何内容都不提交\n*\n');
  return KEYS_FILE;
}

// ---- CLI ----
if (process.argv[1]?.endsWith('keys.mjs')) {
  const [, , cmd, provider, ...rest] = process.argv;

  if (cmd === 'status') {
    for (const p of Object.keys(PROVIDERS)) {
      const k = getKey(p);
      const src = process.env[PROVIDERS[p].env] && k ? '环境变量' : k ? 'data/keys.json' : '—';
      console.log(`${PROVIDERS[p].label.padEnd(10)} ${maskKey(k).padEnd(16)} ${src}`);
    }
    console.log(`\n文件: ${KEYS_FILE}`);
    process.exit(0);
  }

  if (cmd === 'set') {
    // 从 stdin 读，避免 key 出现在命令行历史 / 进程列表里
    let input = rest.join(' ').trim();
    if (!input) {
      input = await new Promise((res) => {
        let buf = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (d) => (buf += d));
        process.stdin.on('end', () => res(buf.trim()));
      });
    }
    try {
      const f = saveKey(provider, input);
      console.log(`已保存 ${PROVIDERS[provider]?.label ?? provider}: ${maskKey(input)}`);
      console.log(`写入: ${f}`);
    } catch (e) {
      console.error('保存失败: ' + e.message);
      process.exit(1);
    }
    process.exit(0);
  }

  console.error('用法:\n  node keys.mjs status\n  node keys.mjs set <deepseek|glm>   # key 从 stdin 读');
  process.exit(2);
}
