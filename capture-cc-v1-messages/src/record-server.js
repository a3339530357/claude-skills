#!/usr/bin/env node
'use strict';

// baseurl 通道：明文 HTTP 记录服务器
//
// 为什么需要它：claude 从 2.1.233 起改成 bun 打包的 native 二进制，不再信任
// NODE_EXTRA_CA_CERTS / SSL_CERT_FILE 注入的自签 CA，MITM 代理（src/proxy.js）
// 在这些版本上一律撞 "Self-signed certificate detected"。用 ANTHROPIC_BASE_URL
// 把 claude 指到本地明文 HTTP 端点，整条 TLS 链路就绕开了。
//
// 代价：Host / Connection / Accept-Encoding 这些由本地端点决定，不再是
// api.anthropic.com 的原值；也看不到真实响应。Authorization、anthropic-beta、
// User-Agent、X-Stainless-* 和整个请求体仍然是 claude 原样构造的。
//
// 落盘结构刻意与 proxy.js 保持一致（同一个 logs/<date>.jsonl，同样的
// {id, startedAt, url, method, request:{headers, body}, response:{...}}），
// 这样 extract-v1-messages.js 一套抽取逻辑就能同时吃两个通道的日志。

const http = require('http');
const log = require('./logger');

function parseArgs(argv) {
  const out = { host: '127.0.0.1', port: 18899, status: 401, fakeOk: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') out.port = Number(argv[++i]);
    else if (a === '--host') out.host = argv[++i];
    // 返回什么状态码给 claude。默认 401：claude 会立刻认输退出，不重试太多次，
    // 我们要的请求在它放弃之前就已经完整落盘了。
    else if (a === '--status') out.status = Number(argv[++i]);
    // 伪造一个合法的成功响应。交互模式必须开：TUI 启动时会先发一个认证探测，
    // 拿到 401 就判定 "Login expired"，直接拒绝发送真正的对话请求——那条才是
    // 我们要抓的 70KB 大请求。print 模式不做这个检查，所以默认关着就够用。
    else if (a === '--fake-ok') out.fakeOk = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

// 拼一条最小但格式合法的 Anthropic SSE 流，让 claude 认为请求成功了。
function fakeSseStream(model) {
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  const msg = {
    id: 'msg_capture_fake',
    type: 'message',
    role: 'assistant',
    model: model || 'claude-opus-5',
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 },
  };
  return (
    ev('message_start', { type: 'message_start', message: msg }) +
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '1' } }) +
    ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    ev('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    }) +
    ev('message_stop', { type: 'message_stop' })
  );
}

function handle(req, res, opts) {
  const id = log.nextId();
  const startedAt = Date.now();
  const chunks = [];

  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const headers = log.rawHeadersToObject(req.rawHeaders);
    const fullUrl = `http://${opts.host}:${opts.port}${req.url}`;

    log.printRequestHeader(id, req.method, fullUrl, headers);
    log.printRequestBody(bodyText);

    let parsed = null;
    try { parsed = JSON.parse(bodyText); } catch { /* 非 JSON 请求，按原样处理 */ }

    let status = opts.status;
    let payload;
    if (opts.fakeOk) {
      status = 200;
      if (parsed && parsed.stream) {
        payload = fakeSseStream(parsed.model);
        res.writeHead(status, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      } else {
        payload = JSON.stringify({
          id: 'msg_capture_fake',
          type: 'message',
          role: 'assistant',
          model: (parsed && parsed.model) || 'claude-opus-5',
          content: [{ type: 'text', text: '1' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        });
        res.writeHead(status, { 'content-type': 'application/json' });
      }
    } else {
      payload = JSON.stringify({
        type: 'error',
        error: {
          type: 'authentication_error',
          message: 'cc-zhuabao record-server: request captured, stopping here',
        },
      });
      res.writeHead(status, { 'content-type': 'application/json' });
    }
    res.end(payload);

    log.appendJsonl({
      id,
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      // 标记通道，extract 会据此在产物里写明来源和 caveat
      transport: 'baseurl',
      url: fullUrl,
      method: req.method,
      request: { headers, body: bodyText },
      response: {
        status,
        statusMessage: 'record-server synthetic response',
        headers: { 'content-type': opts.fakeOk && parsed && parsed.stream ? 'text/event-stream' : 'application/json' },
        stream: !!(opts.fakeOk && parsed && parsed.stream),
        body: payload,
      },
    });
  });

  req.on('error', (err) => {
    console.error(`[#${id}] client error:`, err.message);
  });
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(`cc-zhuabao record-server  明文 HTTP 抓包端点（baseurl 通道）

用法:
  node src/record-server.js [--host 127.0.0.1] [--port 18899] [--status 401]

启动后，在另一个终端：
  export ANTHROPIC_BASE_URL="http://127.0.0.1:18899"
  claude -p "你好"
`);
    return;
  }

  const server = http.createServer((req, res) => handle(req, res, args));

  server.on('error', (err) => {
    console.error('record-server 启动失败:', err.message);
    process.exit(1);
  });

  server.listen(args.port, args.host, () => {
    console.log(`\n\x1b[1mcc-zhuabao record-server\x1b[0m 已启动`);
    console.log(`  监听地址      : http://${args.host}:${args.port}`);
    console.log(`  抓包日志目录  : ${log.LOG_DIR}\n`);
    console.log(`  export ANTHROPIC_BASE_URL="http://${args.host}:${args.port}"`);
    console.log(`  claude -p "你好"\n`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
