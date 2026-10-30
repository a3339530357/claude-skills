#!/usr/bin/env node
'use strict';

// CLI 入口：启动 MITM 代理并打印环境变量配置指引

const path = require('path');
const { createProxyServer, ca } = require('./proxy');
const { LOG_DIR } = require('./logger');
const { CA_CERT_PATH } = require('./ca');

function parseArgs(argv) {
  const out = { host: '127.0.0.1', port: 8888 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') out.port = Number(argv[++i]);
    else if (a === '--host' || a === '-h') out.host = argv[++i];
    else if (a === '--help') out.help = true;
  }
  return out;
}

function printHelp() {
  // eslint-disable-next-line no-console
  console.log(`cc-zhuabao  Claude Code 流量抓包代理

用法:
  node src/index.js [--host 127.0.0.1] [--port 8888]

环境变量:
  CC_ZHUABAO_BODY_PREVIEW  控制台 body 预览最大字符数（默认 8192）
  CC_ZHUABAO_QUIET_STREAM  设为 1 关闭流式 chunk 的实时打印（仍写 JSONL）

启动后，在另一个终端：
  $env:HTTPS_PROXY = "http://127.0.0.1:8888"
  $env:HTTP_PROXY  = "http://127.0.0.1:8888"
  $env:NODE_EXTRA_CA_CERTS = "${CA_CERT_PATH}"
  claude
`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { printHelp(); return; }

  const server = await createProxyServer({ host: args.host, port: args.port });
  const addr = server.address();
  const proxyUrl = `http://${addr.address}:${addr.port}`;

  // eslint-disable-next-line no-console
  console.log(`\n\x1b[1mcc-zhuabao\x1b[0m 已启动`);
  // eslint-disable-next-line no-console
  console.log(`  代理地址      : ${proxyUrl}`);
  // eslint-disable-next-line no-console
  console.log(`  CA 证书路径   : ${CA_CERT_PATH}${ca.created ? '  (本次新生成)' : ''}`);
  // eslint-disable-next-line no-console
  console.log(`  抓包日志目录  : ${LOG_DIR}\n`);

  // eslint-disable-next-line no-console
  console.log(`\x1b[36m在 PowerShell 中：\x1b[0m`);
  // eslint-disable-next-line no-console
  console.log(`  $env:HTTPS_PROXY = "${proxyUrl}"`);
  // eslint-disable-next-line no-console
  console.log(`  $env:HTTP_PROXY  = "${proxyUrl}"`);
  // eslint-disable-next-line no-console
  console.log(`  $env:NODE_EXTRA_CA_CERTS = "${CA_CERT_PATH}"`);
  // eslint-disable-next-line no-console
  console.log(`  claude          # 启动 Claude Code\n`);

  // eslint-disable-next-line no-console
  console.log(`\x1b[36m在 cmd 中：\x1b[0m`);
  // eslint-disable-next-line no-console
  console.log(`  set HTTPS_PROXY=${proxyUrl}`);
  // eslint-disable-next-line no-console
  console.log(`  set HTTP_PROXY=${proxyUrl}`);
  // eslint-disable-next-line no-console
  console.log(`  set NODE_EXTRA_CA_CERTS=${CA_CERT_PATH}`);
  // eslint-disable-next-line no-console
  console.log(`  claude\n`);

  // eslint-disable-next-line no-console
  console.log(`按 Ctrl+C 停止抓包。\n`);

  process.on('SIGINT', () => {
    // eslint-disable-next-line no-console
    console.log('\n正在关闭...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('启动失败:', err);
  process.exit(1);
});
