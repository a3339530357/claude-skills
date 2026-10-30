#!/usr/bin/env node
/**
 * 用 CDP 模拟 prefers-color-scheme 截图。
 *
 * headless 的 --force-dark-mode 走的是浏览器的强制暗化算法,验证不了页面自己写的
 * @media (prefers-color-scheme:dark)。只有 Emulation.setEmulatedMedia 才是真的。
 *
 * 用法: node shot-dark.js <html路径> <输出png> [dark|light] [宽] [高]
 */
const fs = require('fs');
const { spawn } = require('child_process');

const [htmlPath, outPng, scheme = 'dark', W = '1280', H = '3400'] = process.argv.slice(2);
const PORT = 9333;

const chrome = spawn('google-chrome', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, `--window-size=${W},${H}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let target = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch { /* 还没起来 */ }
  }
  if (!target) { console.error('浏览器未就绪'); chrome.kill(); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) =>
    new Promise((res, rej) => { pending.set(++id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  };

  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable');
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: scheme }],
  });
  await send('Page.navigate', { url: 'file://' + htmlPath });
  await sleep(1800);
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(outPng, Buffer.from(data, 'base64'));
  console.log(`${scheme} 模式截图已保存: ${outPng}`);
  ws.close();
  chrome.kill();
  process.exit(0);
})().catch((e) => { console.error(e.message); chrome.kill(); process.exit(1); });
