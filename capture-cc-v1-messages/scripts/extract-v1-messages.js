#!/usr/bin/env node
'use strict';

// 从 cc-zhuabao 抓包日志中提取最近一条最完整的
// POST https://api.anthropic.com/v1/messages 请求，
// 导出为单个 JSON 文件：{url, method, headers, body}
//
// 使用：
//   node scripts/extract-v1-messages.js                     # 默认读今天的 jsonl，写到 v1-messages.json
//   node scripts/extract-v1-messages.js --in logs/x.jsonl
//   node scripts/extract-v1-messages.js --out my.json
//   node scripts/extract-v1-messages.js --redact            # 脱敏 Authorization/邮箱/UUID/设备 hash

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = { redact: false, skipLines: 0 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--in' || a === '-i') out.in = argv[++i];
    else if (a === '--out' || a === '-o') out.out = argv[++i];
    else if (a === '--redact') out.redact = true;
    // 只解析日志中第 N 行之后新追加的记录。
    // 用途：同一天先后抓 print 和 interactive 时，日志会累积两条 /v1/messages，
    // 默认“取最大那条”会串味（interactive 通常比 print 大）。capture.sh 会把
    // 触发前的行数作为 N 传进来，确保每次只在本次新记录里挑最大的一条。
    else if (a === '--skip-lines') out.skipLines = parseInt(argv[++i], 10) || 0;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function todayLog() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return path.resolve(__dirname, '..', 'logs', `${y}-${m}-${day}.jsonl`);
}

function findLatestLog() {
  const dir = path.resolve(__dirname, '..', 'logs');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
  if (!files.length) return null;
  files.sort();
  return path.join(dir, files[files.length - 1]);
}

function redactObject(obj) {
  // 深拷贝并脱敏：常见敏感字段就地替换
  const json = JSON.stringify(obj, (k, v) => {
    if (typeof v === 'string') {
      // Bearer token / API key
      if (/^Bearer\s+/i.test(v)) return 'Bearer ***REDACTED***';
      if (/^sk-[A-Za-z0-9_-]+/.test(v)) return 'sk-***REDACTED***';
      // 邮箱
      if (/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(v)) return '***@***';
      // 64 位 hex 设备指纹
      if (/^[0-9a-f]{64}$/i.test(v)) return '***HEX64***';
      // 单纯 UUID
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return '***UUID***';
      // 含有邮箱/UUID/hex 的长字符串（如 metadata.user_id 序列化串）
      let s = v;
      s = s.replace(/([\w.+-]+)@([\w-]+\.[\w.-]+)/g, '***@***');
      s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '***UUID***');
      s = s.replace(/[0-9a-f]{64}/gi, '***HEX64***');
      return s;
    }
    return v;
  });
  return JSON.parse(json);
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    // eslint-disable-next-line no-console
    console.log('usage: node scripts/extract-v1-messages.js [--in <jsonl>] [--out <json>] [--redact]');
    return;
  }

  const inFile = args.in
    ? path.resolve(args.in)
    : (fs.existsSync(todayLog()) ? todayLog() : findLatestLog());

  if (!inFile || !fs.existsSync(inFile)) {
    // eslint-disable-next-line no-console
    console.error('找不到抓包日志文件。请先启动代理并跑过 claude。');
    process.exit(2);
  }

  const records = fs.readFileSync(inFile, 'utf8')
    .split('\n').filter(Boolean)
    .slice(args.skipLines)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    .filter(r => r.url && r.url.includes('/v1/messages') && r.method === 'POST');

  if (!records.length) {
    // eslint-disable-next-line no-console
    console.error(`在 ${inFile} 中没找到 POST /v1/messages 记录（--skip-lines ${args.skipLines} 之后）。
可能原因:
  - mitm 通道: claude 不信任本地 CA（native 二进制 >=2.1.233 的通病），请改用 baseurl 通道
  - baseurl 通道: claude 没读到 ANTHROPIC_BASE_URL，或请求打到了别的端口
  - claude 还卡在登录流程，压根没发请求`);
    process.exit(3);
  }

  // 选体积最大的那条——SDK 偶尔会有 2KB 的轻量探测，
  // 真正含完整 system/tools/messages 的请求通常 60KB+。
  records.sort((a, b) => (b.request?.body?.length || 0) - (a.request?.body?.length || 0));
  const rec = records[0];

  let body;
  try {
    body = JSON.parse(rec.request.body);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('请求体不是合法 JSON，可能日志被截断了：', e.message);
    process.exit(4);
  }

  // 通道信息决定产物里要不要带 caveat。老日志没有这个字段，按 mitm 处理。
  const transport = rec.transport || 'mitm';

  let result = {
    capturedAt: rec.startedAt,
    transport,
    url: rec.url,
    method: rec.method,
    headers: rec.request.headers,
    body,
  };

  if (transport === 'baseurl') {
    // 请求实际打到本地端点，如实说明哪些字段因此失真，免得后来者拿它当
    // 直连 api.anthropic.com 的完整还原。
    result.upstreamEquivalent =
      'https://api.anthropic.com' + rec.url.replace(/^https?:\/\/[^/]+/, '');
    result.caveat =
      'baseurl 通道：请求经 ANTHROPIC_BASE_URL 打到本地明文 HTTP 端点。' +
      'Host / Connection / Accept-Encoding 由该端点决定，响应是记录服务器合成的；' +
      'Authorization、anthropic-beta、User-Agent、X-Stainless-* 及整个 body 均为 claude 原值。';
    // 字段顺序上让 url 系列挨在一起，读起来顺
    result = {
      capturedAt: result.capturedAt,
      transport: result.transport,
      url: result.url,
      upstreamEquivalent: result.upstreamEquivalent,
      caveat: result.caveat,
      method: result.method,
      headers: result.headers,
      body: result.body,
    };
  }

  if (args.redact) result = redactObject(result);

  const outFile = args.out
    ? path.resolve(args.out)
    : path.resolve(__dirname, '..', 'v1-messages.json');

  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));

  // HTTP 头大小写不敏感，别写死 'Content-Length'
  const contentLength = (() => {
    for (const [k, v] of Object.entries(rec.request.headers || {})) {
      if (k.toLowerCase() === 'content-length') return v;
    }
    return undefined;
  })();
  const actualBytes = Buffer.byteLength(rec.request.body, 'utf8');

  // eslint-disable-next-line no-console
  console.log(`written: ${outFile}`);
  // eslint-disable-next-line no-console
  console.log(`  source         : ${inFile} (#${rec.id})`);
  // eslint-disable-next-line no-console
  console.log(`  transport      : ${transport}`);
  // eslint-disable-next-line no-console
  console.log(`  body bytes     : ${actualBytes} (Content-Length: ${contentLength})`);
  // eslint-disable-next-line no-console
  console.log(`  body keys      : ${Object.keys(body).join(', ')}`);
  // eslint-disable-next-line no-console
  console.log(`  tools          : ${(body.tools || []).length} -> ${(body.tools || []).map(t => t.name).join(', ')}`);
  // eslint-disable-next-line no-console
  console.log(`  system blocks  : ${(body.system || []).length}`);
  // eslint-disable-next-line no-console
  console.log(`  redacted       : ${args.redact ? 'yes' : 'no'}`);

  // body bytes 与 Content-Length 对不上通常意味着日志被截断，抽出来的
  // 结构就不可信了——与其让人拿着半份 JSON 去分析，不如当场喊出来。
  if (contentLength !== undefined && Number(contentLength) !== actualBytes) {
    // eslint-disable-next-line no-console
    console.error(`\n警告: body bytes (${actualBytes}) != Content-Length (${contentLength})，请求体可能不完整。`);
    process.exit(5);
  }
}

main();
