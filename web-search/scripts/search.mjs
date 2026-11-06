#!/usr/bin/env node
// search.mjs —— 统一入口
//
//   node search.mjs "查询词"                     # 默认 DeepSeek，10 条
//   node search.mjs "查询词" -n 5                # 条数
//   node search.mjs "查询词" --content           # 带正文（仅 DeepSeek 支持）
//   node search.mjs "查询词" --backend glm       # 指定后端
//   node search.mjs "查询词" --recency oneWeek   # 时间筛选（仅 GLM 支持）
//   node search.mjs "查询词" --domain zhihu.com  # 域名筛选（仅 GLM 支持）
//   node search.mjs "查询词" --json              # 原始数组
//   node search.mjs --fetch https://example.com  # 抓单页转 Markdown（仅 DeepSeek 支持）
//   node search.mjs --status                     # 看两个 key 的状态
//
// 缺 key 时退出码 3，并在 stderr 输出 `NO_KEY:<provider>`，好让调用方识别出
// 「这是要用户提供 key」而不是「搜索失败」——两种情况该做的事完全不同。

import { BACKENDS, deepseekFetch } from './providers.mjs';
import { getKey, maskKey, PROVIDERS } from './keys.mjs';

const DEFAULT_BACKEND = 'deepseek';

// 某个后端不支持用户指定的选项时，说出来比默默忽略好——
// 用户会以为是筛选生效了，实际只是没筛。
const UNSUPPORTED = {
  glm: {
    content: '--content（GLM 不返回正文，只有摘要）',
    fetch: '--fetch（抓单页只有 DeepSeek 提供）',
  },
  deepseek: {
    recency: '--recency（时间筛选只有 GLM 支持）',
    domain: '--domain（域名筛选只有 GLM 支持）',
  },
};

function parseArgs(argv) {
  const o = {
    query: null,
    fetchUrl: null,
    count: 10,
    content: false,
    json: false,
    status: false,
    backend: null,
    recency: null,
    domain: null,
    location: null,
    oriQuestion: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fetch') o.fetchUrl = argv[++i];
    else if (a === '-n' || a === '--count') o.count = Number(argv[++i]);
    else if (a === '--content') o.content = true;
    else if (a === '--json') o.json = true;
    else if (a === '--status') o.status = true;
    else if (a === '--backend') o.backend = argv[++i];
    else if (a === '--recency') o.recency = argv[++i];
    else if (a === '--domain') o.domain = argv[++i];
    else if (a === '--location') o.location = argv[++i];
    else if (a === '--ori') o.oriQuestion = argv[++i];
    else if (!a.startsWith('-')) o.query = o.query ? o.query + ' ' + a : a;
  }
  return o;
}

function printStatus() {
  // 中文按两格宽算，否则表格对不齐（终端里 CJK 占两列）
  const w = (s) => [...String(s)].reduce((n, c) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(c) ? 2 : 1), 0);
  const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - w(s)));

  console.log(`${pad('后端', 12)}${pad('key', 22)}来源`);
  console.log('─'.repeat(52));
  for (const [p, spec] of Object.entries(PROVIDERS)) {
    const k = getKey(p);
    const src = !k ? '—' : process.env[spec.env] ? '环境变量' : 'data/keys.json';
    console.log(`${pad(spec.label, 12)}${pad(maskKey(k), 22)}${src}`);
  }
}

function printResults(items, backend, query) {
  const label = BACKENDS[backend].label;
  console.log(`# ${label} · "${query}" · ${items.length} 条\n`);
  items.forEach((it, i) => {
    console.log(`[${i + 1}] ${it.title || '(无标题)'}`);
    // GLM 有一部分结果是 Google 跳转链接，providers.mjs 已经把 url 置成 null
    console.log(`    ${it.url || '(无可直接访问的地址)'}`);
    const meta = [
      it.site,
      it.date,
      it.score != null ? `score ${Number(it.score).toFixed(2)}` : null,
      it.authority != null && it.authority >= 0 ? `auth ${it.authority}` : null,
    ].filter(Boolean).join(' | ');
    if (meta) console.log(`    ${meta}`);
    if (it.snippet) console.log(`    ${it.snippet}`);
    if (it.content) console.log(`\n${it.content.slice(0, 2000)}${it.content.length > 2000 ? '…(截断)' : ''}`);
    console.log();
  });
}

async function main() {
  const o = parseArgs(process.argv.slice(2));

  if (o.status) { printStatus(); return; }

  if (!o.query && !o.fetchUrl) {
    console.error(
      '用法:\n' +
      '  node search.mjs "查询词" [-n 5] [--content] [--json]\n' +
      '  node search.mjs "查询词" --backend glm [--recency oneWeek] [--domain example.com]\n' +
      '  node search.mjs --fetch <url>\n' +
      '  node search.mjs --status'
    );
    process.exit(2);
  }

  // fetch 只有 DeepSeek 有
  if (o.fetchUrl) {
    if (!getKey('deepseek')) {
      console.error('NO_KEY:deepseek');
      process.exit(3);
    }
    const page = await deepseekFetch(o.fetchUrl);
    if (o.json) console.log(JSON.stringify(page, null, 2));
    else console.log(`# ${page.title}\n\n${page.content}`);
    return;
  }

  // 选后端：显式指定的优先；否则默认 DeepSeek，但 DeepSeek 没 key 而 GLM 有就自动换
  let backend = o.backend || DEFAULT_BACKEND;
  if (!BACKENDS[backend]) {
    console.error(`未知后端: ${backend}（可选 ${Object.keys(BACKENDS).join(' / ')}）`);
    process.exit(2);
  }
  if (!o.backend && !getKey(backend) && getKey('glm')) {
    backend = 'glm';
    console.error('（DeepSeek 未配置 key，自动改用 GLM）');
  }

  if (!getKey(backend)) {
    console.error(`NO_KEY:${backend}`);
    process.exit(3);
  }

  // 报告被忽略的选项
  for (const [flag, why] of Object.entries(UNSUPPORTED[backend] || {})) {
    const used =
      (flag === 'content' && o.content) ||
      (flag === 'fetch' && o.fetchUrl) ||
      (flag === 'recency' && o.recency) ||
      (flag === 'domain' && o.domain);
    if (used) console.error(`注意: ${BACKENDS[backend].label} 不支持 ${why}，该选项已忽略`);
  }

  const items = await BACKENDS[backend].search(o.query, {
    count: o.count,
    content: o.content,
    recency: o.recency,
    domain: o.domain,
    location: o.location,
    oriQuestion: o.oriQuestion,
  });

  if (o.json) { console.log(JSON.stringify(items, null, 2)); return; }
  if (!items.length) { console.log(`(${BACKENDS[backend].label} 没有返回结果)`); return; }

  // GLM 没有条数参数，一次给多少就是多少。用户传了 -n 却没被遵守要说出来，
  // 否则他们会以为只花了 n 条的额度。
  if (!BACKENDS[backend].supportsCount && o.count && items.length > o.count) {
    console.error(`注意: ${BACKENDS[backend].label} 不支持指定条数，返回了全部 ${items.length} 条（-n ${o.count} 未生效）`);
  }

  printResults(items, backend, o.query);
}

main().catch((e) => {
  const m = e.message || String(e);
  if (m.startsWith('NO_KEY:')) { console.error(m); process.exit(3); }
  console.error('搜索失败: ' + m);
  process.exit(1);
});
