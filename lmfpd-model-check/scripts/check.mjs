#!/usr/bin/env node
// check.mjs —— 用 lmfpd 检测 API/中转站背后的真实模型，并把报告整理成可读结论
//
// 三种用法：
//   1) 在线检测（会真的调用对方 API、产生费用）
//      node check.mjs --profile oval -m gpt-6-astra
//      node check.mjs -b https://host/v1 -a cc -m glm-5.3 --key-stdin < keyfile
//      常用附加项：-n 3（3 轮）  --tokenizer（加 tokenizer 探测）  --image  -e high  --timeout 180
//      其余 lmfpd 参数放在 -- 之后原样透传
//   2) 只整理已有报告（不发请求）
//      node check.mjs --summarize report.json [-m 覆盖请求模型名]
//   3) 看参考库里有哪些模型
//      node check.mjs --bank [关键词]
//
// key 来源优先级：--key-stdin > 环境变量 LMFPD_API_KEY > API_KEY > profile。
// key 通过子进程环境变量 API_KEY 交给 lmfpd，不出现在命令行参数里。
// 报告默认存到 <当前目录>/lmfpd-results/，lmfpd 自己保证报告里不含凭据。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { getProfile } from './profiles.mjs';

// ───────────────────────── 参数解析 ─────────────────────────

const VALUE_FLAGS = new Set(['-b', '--base', '-m', '--model', '-a', '--api', '--profile', '-n', '--repeat', '--count',
  '-e', '--effort', '--timeout', '-t', '--service-tier', '--out', '--summarize', '-p', '--parallel']);

function parseArgs(argv) {
  const o = { passthrough: [] };
  const dd = argv.indexOf('--');
  if (dd >= 0) {
    o.passthrough = argv.slice(dd + 1);
    argv = argv.slice(0, dd);
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} 缺少取值`);
      o[a.replace(/^-+/, '')] = v;
    } else if (a === '--bank') {
      o.bank = true;
      if (argv[i + 1] && !argv[i + 1].startsWith('-')) o.bankFilter = argv[++i];
    } else if (a.startsWith('-')) {
      o[a.replace(/^-+/, '')] = true;
    } else {
      throw new Error(`无法识别的参数 ${a}`);
    }
  }
  // 短名归一
  const alias = { b: 'base', m: 'model', a: 'api', n: 'repeat', e: 'effort', t: 'service-tier', p: 'parallel', s: 'strict' };
  for (const [s, l] of Object.entries(alias)) if (o[s] !== undefined && o[l] === undefined) o[l] = o[s];
  return o;
}

// ───────────────────────── 参考库定位 ─────────────────────────

// bunx 把包解到 <tmpdir>/bunx-<uid>-lmfpd@<tag>/node_modules/lmfpd；npx 解到 npm 缓存 _npx/<hash>/node_modules/lmfpd
function findBankFile() {
  const roots = [];
  try {
    for (const d of fs.readdirSync(os.tmpdir())) {
      if (/^bunx-.*lmfpd/.test(d)) roots.push(path.join(os.tmpdir(), d, 'node_modules', 'lmfpd'));
    }
  } catch {}
  const npxRoot = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.npm'), process.env.LOCALAPPDATA ? 'npm-cache/_npx' : '_npx');
  try {
    for (const d of fs.readdirSync(npxRoot)) roots.push(path.join(npxRoot, d, 'node_modules', 'lmfpd'));
  } catch {}
  const hits = roots
    .map((r) => path.join(r, 'data', 'unified_bank.json'))
    .filter((f) => fs.existsSync(f))
    .map((f) => ({ f, t: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return hits[0]?.f || null;
}

let _bank;
function loadBank({ warm = false } = {}) {
  if (_bank !== undefined) return _bank;
  let f = findBankFile();
  if (!f && warm) {
    // 让 bunx 把包拉下来一次
    spawnSync(runnerCmd().cmd, [...runnerCmd().pre, 'lmfpd@latest', '--help'], { stdio: 'ignore', shell: runnerCmd().shell });
    f = findBankFile();
  }
  if (!f) return (_bank = null);
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    _bank = { file: f, sha: j.reference_sha256, builtAt: j.built_at, models: j.models.map((m) => ({ id: m.id, family: m.family, family_name: m.family_name, n: m.response_count })) };
  } catch {
    _bank = null;
  }
  return _bank;
}

// 把请求的模型名映射到参考库 id。中转常见改名：加厂商前缀（anthropic/xxx）、加后缀（[1M]）、换前缀（antigravity-opus-5.5）。
function normalizeModel(s) {
  return String(s || '').toLowerCase().replace(/\[[^\]]*\]/g, '').replace(/^.*\//, '').replace(/[_\s]+/g, '-').replace(/-+$/, '').trim();
}

function matchBank(requested, bank) {
  if (!bank || !requested) return { exact: false, ids: [] };
  const ids = bank.models.map((m) => m.id);
  const norm = normalizeModel(requested);
  if (ids.includes(norm)) return { exact: true, ids: [norm] };
  const toks = norm.split('-');
  for (let k = 1; k < toks.length; k++) {
    const tail = toks.slice(k).join('-');
    const hit = ids.filter((id) => id === tail || id.endsWith('-' + tail));
    if (hit.length) return { exact: false, ids: hit, via: tail };
  }
  return { exact: false, ids: [] };
}

// ───────────────────────── 运行 lmfpd ─────────────────────────

function which(cmd) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}

let _runner;
function runnerCmd() {
  if (_runner) return _runner;
  // 注意：不加 --bun。lmfpd 要求 Bun ≥1.4.4 才能用 Bun 运行时，否则 bunx 会自动用 Node（需 ≥22）跑，这是正常的。
  if (which('bunx')) _runner = { cmd: 'bunx', pre: [], shell: false, label: 'bunx' };
  else if (which('npx')) _runner = { cmd: 'npx', pre: ['-y'], shell: process.platform === 'win32', label: 'npx' };
  else throw new Error('找不到 bunx 或 npx，需要先装 Bun 或 Node.js 22+');
  return _runner;
}

function slug(s) {
  return String(s).replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9.\-]+/g, '_').replace(/_+/g, '_').slice(0, 60);
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function runDetect(o) {
  const prof = o.profile ? getProfile(o.profile) : null;
  if (o.profile && !prof) throw new Error(`没有名为 ${o.profile} 的端点配置（node profiles.mjs list 查看）`);
  const base = o.base || prof?.base || process.env.BASE_URL;
  const model = o.model || prof?.model || process.env.MODEL;
  const api = o.api || prof?.api || 'responses';
  let key = o['key-stdin'] ? await readStdin() : '';
  key = key || process.env.LMFPD_API_KEY || process.env.API_KEY || prof?.key || '';
  const missing = [!base && 'base URL (-b)', !model && '模型名 (-m)', !key && 'API key'].filter(Boolean);
  if (missing.length) throw new Error('缺少: ' + missing.join('、'));

  const outDir = path.resolve(o.out || path.join(process.cwd(), 'lmfpd-results'));
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const outFile = path.join(outDir, `${stamp}_${slug(new URL(base).host)}_${slug(model)}.json`);

  const args = ['lmfpd@latest', '-b', base, '-m', model, '-a', api, '--output', outFile, '--json', '--no-update-check'];
  if (o.repeat) args.push('-n', String(o.repeat));
  if (o.count) args.push('--count', String(o.count));
  if (o.parallel) args.push('-p', String(o.parallel));
  if (o.effort) args.push('-e', String(o.effort));
  if (o.timeout) args.push('--timeout', String(o.timeout));
  if (o['service-tier']) args.push('-t', String(o['service-tier']));
  if (o.tokenizer) args.push('--tokenizer');
  if (o.image) args.push('--image');
  if (o.strict) args.push('-s');
  if (o.ns || o['no-stream']) args.push('-ns');
  args.push(...o.passthrough);

  const r = runnerCmd();
  console.error(`[lmfpd] ${r.label} ${args.join(' ')}`);
  console.error(`[lmfpd] key=${key.slice(0, 6)}…${key.slice(-4)}（经环境变量传入）；报告 → ${outFile}`);
  const t0 = Date.now();

  const child = spawn(r.cmd, [...r.pre, ...args], {
    env: { ...process.env, API_KEY: key, FPD_NO_UPDATE_CHECK: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
    shell: r.shell,
  });
  let errTail = '';
  child.stderr.on('data', (d) => {
    const s = d.toString();
    errTail = (errTail + s).slice(-6000);
    // 只把每轮的领先候选这类关键进度透出来，免得 TUI 噪音刷屏
    for (const line of s.split(/\r?\n/)) {
      const clean = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
      if (/round|error|fail|leading|candidate/i.test(clean) && clean.length < 300) console.error('[lmfpd] ' + clean);
    }
  });
  const code = await new Promise((res) => child.on('close', res));
  console.error(`[lmfpd] 退出码 ${code}，用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  if (!fs.existsSync(outFile)) {
    console.log('lmfpd 没有生成报告。stderr 末尾：\n' + errTail.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/).slice(-25).join('\n'));
    process.exit(code || 1);
  }
  summarize(outFile, { model });
  process.exit(code === 0 || code === 1 ? 0 : code);
}

// ───────────────────────── 整理报告 ─────────────────────────

function readReport(file) {
  const raw = fs.readFileSync(file, 'utf8');
  // 有些人是 `bunx ... --json > x.json` 存的，开头会混进 "Resolving dependencies" 之类的 bunx 输出
  const i = raw.indexOf('{');
  if (i < 0) throw new Error('文件里没有 JSON');
  return JSON.parse(raw.slice(i));
}

const pct = (p) => (p == null ? '   —  ' : (p * 100).toFixed(p >= 0.995 || p < 0.001 ? 2 : 1).padStart(5) + '%');

function verdictFor(analysis, reqIds, bank) {
  const res = analysis?.results || [];
  if (!res.length) return { tag: '未评分', text: '这一轮没有产生排名（有效样本不足或全部失败）。' };
  const top = res[0];
  const calibrated = analysis.probability_status === 'reference_calibrated';
  const famOf = (id) => bank?.models.find((m) => m.id === id)?.family || res.find((r) => r.model === id)?.family;
  if (!reqIds.length) {
    return { tag: '无法判定', text: `请求的模型不在参考库里，lmfpd 只能在库内模型中选最像的（这次是 ${top.model}）。这不能证明真假，只能说明输出风格最接近谁。` };
  }
  const reqRank = res.findIndex((r) => reqIds.includes(r.model));
  const reqRow = res[reqRank];
  if (reqIds.includes(top.model)) {
    if (!calibrated) return { tag: '倾向一致', text: `第一名就是请求的模型，但只有 ${analysis.used_outputs} 个有效样本，没有置信度。` };
    if (top.probability >= 0.8) return { tag: '一致', text: `第一名就是请求的模型，置信度 ${pct(top.probability).trim()}。` };
    return { tag: '倾向一致', text: `第一名是请求的模型但置信度只有 ${pct(top.probability).trim()}，第二名 ${res[1]?.model} ${pct(res[1]?.probability).trim()}——同族近邻分不太开，建议 -n 3 复测。` };
  }
  const sameFam = famOf(top.model) && famOf(top.model) === famOf(reqIds[0]);
  const where = reqRank >= 0 ? `请求的模型排第 ${reqRank + 1}${calibrated ? `（${pct(reqRow.probability).trim()}）` : ''}` : '请求的模型不在排名里';
  if (sameFam) {
    const close = calibrated && reqRow && reqRow.probability >= 0.2;
    return {
      tag: close ? '存疑' : '不一致·同家族',
      text: `第一名是同家族的 ${top.model}${calibrated ? `（${pct(top.probability).trim()}）` : ''}，${where}。` +
        (close ? '两者概率接近，可能只是同族分不开，建议 -n 3 复测。' : '常见于中转用同家族的便宜型号（flash/mini/旧版）冒充。'),
    };
  }
  return { tag: '不一致·跨家族', text: `第一名是其他家族的 ${top.model}${calibrated ? `（${pct(top.probability).trim()}）` : ''}，${where}。` };
}

function summarize(file, { model: overrideModel } = {}) {
  const rep = readReport(file);
  if (rep.schema === 'fpd-tokenizer-v1') {
    console.log(`tokenizer 报告  模型=${rep.model || '?'}`);
    console.log('verdict: ' + JSON.stringify(rep.verdict, null, 2));
    if (rep.error) console.log('error: ' + JSON.stringify(rep.error));
    return;
  }
  if (rep.schema !== 'fpd-detection-v1') console.log(`（注意：schema=${rep.schema}，不是已知的 fpd-detection-v1，下面按同样字段尝试解析）`);

  const req = rep.request || {};
  const requested = overrideModel || req.model;
  const bank = loadBank({ warm: true });
  const m = matchBank(requested, bank);

  const claims = {};
  for (const r of rep.rounds || []) for (const s of r.samples || []) if (s.responseModel) claims[s.responseModel] = (claims[s.responseModel] || 0) + 1;

  const L = [];
  L.push('══════════ lmfpd 检测结果 ══════════');
  L.push(`端点       ${req.baseUrl || '?'}  (${req.api || req.format || '?'}${req.stream === false ? ', JSON' : ', SSE'})`);
  L.push(`请求模型   ${requested}`);
  L.push(`响应声称   ${Object.entries(claims).map(([k, v]) => `${k} ×${v}`).join('，') || '（无）'}   ← 响应里的 model 字段，中转可随意填写，不作证据`);
  if (bank) {
    const sameSha = rep.bank?.reference_sha256 && rep.bank.reference_sha256 === bank.sha;
    const lib = `${bank.models.length} 个模型${sameSha ? '' : '（本地参考库版本与报告生成时不同，以下库内匹配按本地版本）'}`;
    if (m.exact) L.push(`参考库     ${lib}；请求模型在库内 ✓ (${m.ids[0]})`);
    else if (m.ids.length) L.push(`参考库     ${lib}；库内没有同名项，按名称推测对应 ${m.ids.join(' / ')}（去掉前缀后匹配 "${m.via}"，请自行确认）`);
    else L.push(`参考库     ${lib}；请求模型不在库内 ✗ —— 只能看出最像谁，无法判真假`);
  } else {
    L.push(`参考库     ${rep.bank?.models ?? '?'} 个模型（本地找不到库文件，无法核对请求模型是否在库内）`);
  }
  L.push(`报告文件   ${path.resolve(file)}`);

  const winners = {};
  const verdicts = [];
  (rep.rounds || []).forEach((r, idx) => {
    const a = r.analysis;
    const samples = r.samples || [];
    const ok = samples.filter((s) => s.state === 'complete' || s.state === 'capped').length;
    L.push('');
    const status = a?.probability_status === 'reference_calibrated' ? '已校准置信度' : a ? '仅排名（有效样本 <3，无置信度）' : '未评分';
    L.push(`── 第 ${idx + 1} 轮  有效样本 ${a?.used_outputs ?? ok}/${samples.length}  ${status}`);
    for (const [i, row] of (a?.results || []).slice(0, 5).entries()) {
      const mark = m.ids.includes(row.model) ? '  ← 请求的模型' : '';
      L.push(`   ${i + 1}. ${row.display_name.padEnd(26)} ${String(row.family_name).padEnd(10)} ${pct(row.probability)}${mark}`);
    }
    samples.forEach((s, i) => {
      if (s.error || (s.state && !['complete', 'capped'].includes(s.state))) L.push(`   ✗ 样本 #${i + 1} ${s.state}: ${s.error || ''}`);
    });
    if (a?.sequence && a.sequence.model_like === false) L.push('   ⚠ 输出序列不像模型生成（自相关异常），可能是缓存/脚本/非 LLM 回复');
    if (a?.prediction) winners[a.prediction] = (winners[a.prediction] || 0) + 1;
    const v = verdictFor(a, m.ids, bank);
    verdicts.push(v);
    L.push(`   判断: [${v.tag}] ${v.text}`);
  });

  if ((rep.rounds || []).length > 1) {
    L.push('');
    L.push(`多轮汇总   ` + Object.entries(winners).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} 胜 ${v}/${rep.rounds.length} 轮`).join('，'));
  }
  if (rep.tokenizer) {
    L.push('');
    L.push('tokenizer 探测（仅参考，不影响排名）: ' + JSON.stringify(rep.tokenizer.verdict ?? rep.tokenizer.error ?? {}).slice(0, 600));
  }
  console.log(L.join('\n'));
}

// ───────────────────────── 参考库列表 ─────────────────────────

function listBank(filter) {
  const bank = loadBank({ warm: true });
  if (!bank) throw new Error('找不到 lmfpd 参考库（bunx/npx 缓存里都没有），先跑一次 bunx lmfpd@latest --help');
  const f = (filter || '').toLowerCase();
  const rows = bank.models.filter((x) => !f || x.id.includes(f) || x.family.includes(f));
  console.log(`参考库 ${bank.models.length} 个模型，构建于 ${bank.builtAt}${f ? `，筛选 "${f}" 命中 ${rows.length}` : ''}`);
  const byFam = {};
  for (const r of rows) (byFam[r.family_name] ||= []).push(r.id);
  for (const [fam, ids] of Object.entries(byFam)) console.log(`  ${fam.padEnd(10)} ${ids.join(', ')}`);
}

// ───────────────────────── 入口 ─────────────────────────

const o = parseArgs(process.argv.slice(2));
try {
  if (o.bank) listBank(o.bankFilter);
  else if (o.summarize) summarize(o.summarize, { model: o.model });
  else await runDetect(o);
} catch (e) {
  console.error('错误: ' + e.message);
  process.exit(1);
}
