#!/usr/bin/env node
/**
 * HTML 程序化自检 -- 取代"截图后肉眼读图"。
 *
 * 为什么需要它:SKILL.md 原先让模型截图后 Read PNG 做视觉自审。但运行的模型若是
 * 纯文本的,Read PNG 直接 API 400,连续报错打断流程(2026-07-31 实跑就栽在这)。
 * 改为用 CDP 取可量化指标,输出文本报告,模型读文本即可自审,不依赖视觉能力。
 *
 * 检查项(均可在多视口 × 多主题下量化):
 *   · 横向溢出 -- 最常见、最致命的布局缺陷,各断点逐一测
 *   · 外部资源 -- 自包含硬约束,任何 http(s) 资源加载都会被抓
 *   · 主题切换 -- 深浅背景下 body 背景色是否真的不同(验证 prefers-color-scheme 生效)
 *   · color-scheme -- 是否声明 dark,决定原生控件(复选框/滚动条)是否跟主题
 *   · 无障碍 -- :focus-visible、prefers-reduced-motion 规则是否存在
 *   · 版心宽度 -- 是否限宽居中,超宽屏是否"虚胖"
 *
 * 用法: node lint-html.js <html绝对路径> [视口宽(逗号分隔)]
 * 默认视口: 400,768,1280,1920,2560
 * 退出码: 0 全部通过 / 1 有问题
 */
const { spawn } = require('child_process');

const htmlPath = process.argv[2];
const widths = (process.argv[3] || '400,768,1280,1920,2560').split(',').map(Number);
if (!htmlPath) {
  console.error('用法: node lint-html.js <html绝对路径> [视口宽]');
  process.exit(1);
}

const PORT = 9334;
const chrome = spawn('google-chrome', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let exitCode = 0;

async function getTarget() {
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const t = list.find((x) => x.type === 'page');
      if (t) return t;
    } catch { /* 还没起来 */ }
  }
  return null;
}

function makeClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      pending.set(++id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ws, send, ready: new Promise((r) => { ws.onopen = r; }) };
}

// PAGE_CHECK 在页面上下文里跑,返回 JSON 字符串
const PAGE_CHECK = String.raw`(() => {
  const out = {};
  const de = document.documentElement;

  out.scrollW = de.scrollWidth;
  out.clientW = de.clientWidth;
  out.overflow = out.scrollW > out.clientW + 1;

  // 外部资源:只看真正会发请求的属性
  out.external = [];
  const re = /^https?:\/\//i;
  document.querySelectorAll('link[href],script[src],img[src],source[src],iframe[src],video[src],audio[src]').forEach(el => {
    const v = el.href || el.src;
    if (v && re.test(v)) out.external.push(el.tagName.toLowerCase() + ': ' + v);
  });
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of (sheet.cssRules || [])) {
        const m = (rule.cssText || '').match(/url\((['"]?)(https?:[^)'"]+)/i);
        if (m) out.external.push('css url(): ' + m[2]);
      }
    } catch { /* 跨域样式表 */ }
  }
  document.querySelectorAll('style').forEach(st => {
    const im = st.textContent.match(/@import\s+(['"]?)(https?:[^)'"]+)/i);
    if (im) out.external.push('@import: ' + im[2]);
  });

  out.colorScheme = getComputedStyle(de).colorScheme || '(未声明)';
  out.bg = getComputedStyle(document.body).backgroundColor;

  out.hasFocusVisible = false;
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of (sheet.cssRules || [])) {
        if ((rule.selectorText || '').includes(':focus-visible')) { out.hasFocusVisible = true; break; }
      }
    } catch {}
    if (out.hasFocusVisible) break;
  }

  // 版心:找被 max-width 限住的容器。不查 margin:auto --
  // getComputedStyle 对 margin:auto 返回计算后的像素值而非字面 "auto"。
  let maxWrap = 0;
  document.querySelectorAll('div,main,header,section,article').forEach(el => {
    const mw = parseInt(getComputedStyle(el).maxWidth) || 0;
    if (mw > 200 && el.offsetWidth < window.innerWidth - 10 && mw > maxWrap) maxWrap = mw;
  });
  out.maxContentWidth = maxWrap;
  out.viewportW = window.innerWidth;

  return JSON.stringify(out);
})()`;

const REDUCED_CHECK = String.raw`(() => {
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of (sheet.cssRules || [])) {
        if ((rule.cssText || '').includes('prefers-reduced-motion')) return true;
      }
    } catch {}
  }
  return false;
})()`;

async function probe(c, width, scheme) {
  await c.send('Emulation.setDeviceMetricsOverride', {
    width, height: 900, mobile: width < 768, deviceScaleFactor: 1,
  });
  await c.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: scheme }],
  });
  await sleep(400);
  const r = await c.send('Runtime.evaluate', { expression: PAGE_CHECK, returnByValue: true });
  const data = JSON.parse(r.result.value);
  const r2 = await c.send('Runtime.evaluate', { expression: REDUCED_CHECK, returnByValue: true });
  data.hasReducedMotion = r2.result.value;
  data.width = width;
  data.scheme = scheme;
  return data;
}

(async () => {
  const target = await getTarget();
  if (!target) { console.error('浏览器未就绪'); chrome.kill(); process.exit(1); }

  const c = makeClient(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send('Page.enable');
  await c.send('Page.navigate', { url: 'file://' + htmlPath });
  await sleep(1200);

  const results = [];
  for (const w of widths) {
    results.push(await probe(c, w, 'light'));
    results.push(await probe(c, w, 'dark'));
  }
  c.ws.close();
  chrome.kill();

  const lines = [];
  const L = (s) => lines.push(s);
  const issues = [];
  const at = (w, s) => results.find((x) => x.width === w && x.scheme === s);
  const ref = widths.includes(1280) ? 1280 : widths[Math.floor(widths.length / 2)];

  L('=== HTML 程序化自检报告 ===');
  L('文件: ' + htmlPath);
  L('');

  const ext = results[0].external;
  if (ext.length) {
    issues.push('外部资源');
    L('【✗ 外部资源】发现 ' + ext.length + ' 处外部引用(违反离线自包含):');
    ext.slice(0, 8).forEach((e) => L('  · ' + e));
  } else {
    L('【✓ 外部资源】无 http(s) 资源引用,离线自包含');
  }
  L('');

  L('【横向溢出】');
  let anyOverflow = false;
  for (const w of widths) {
    for (const s of ['light', 'dark']) {
      const r = at(w, s);
      if (r.overflow) {
        anyOverflow = true;
        issues.push(`横向溢出@${w}(${s})`);
        L(`  ${w}px ${s}: ✗ 溢出 ${r.scrollW - r.clientW}px (scrollW=${r.scrollW} clientW=${r.clientW})`);
      }
    }
    if (!at(w, 'light').overflow && !at(w, 'dark').overflow) L(`  ${w}px: ✓`);
  }
  if (!anyOverflow) L('  所有断点无横向溢出');
  L('');

  L('【主题切换】');
  const lightBg = at(ref, 'light').bg;
  const darkBg = at(ref, 'dark').bg;
  if (lightBg === darkBg) {
    issues.push('主题未切换');
    L('  ✗ 深浅背景相同(' + lightBg + '),prefers-color-scheme 未生效');
  } else {
    L('  ✓ 浅色背景 ' + lightBg + ' / 深色背景 ' + darkBg + ',主题切换生效');
  }
  // color-scheme 必须在 dark 模式下取值:light 模式下它本来就是 light,无判别意义
  const darkCs = at(ref, 'dark').colorScheme;
  if (/dark/.test(darkCs)) {
    L('  ✓ color-scheme(dark): ' + darkCs + '(原生控件会跟主题)');
  } else {
    issues.push('color-scheme');
    L('  ✗ color-scheme(dark)=' + darkCs + ',深色模式下原生控件(复选框/滚动条)会留白');
  }
  L('');

  L('【无障碍】');
  L('  ' + (results[0].hasFocusVisible ? '✓' : '✗') + ' :focus-visible 规则 ' + (results[0].hasFocusVisible ? '存在' : '缺失'));
  L('  ' + (results[0].hasReducedMotion ? '✓' : '✗') + ' prefers-reduced-motion 规则 ' + (results[0].hasReducedMotion ? '存在' : '缺失'));
  if (!results[0].hasFocusVisible) issues.push('focus-visible');
  if (!results[0].hasReducedMotion) issues.push('reduced-motion');
  L('');

  const widest = at(Math.max(...widths), 'light');
  L('【版心】最大限宽容器 max-width = ' + widest.maxContentWidth + 'px');
  if (widest.maxContentWidth > 0 && widest.maxContentWidth < widest.viewportW) {
    L(`  ✓ 超宽屏(${widest.viewportW})下版心限在 ${widest.maxContentWidth}px,无虚胖`);
  } else if (!widest.maxContentWidth) {
    L('  (未检测到限宽容器 —— 超宽屏可能撑满,人工确认一下)');
  }
  L('');

  if (issues.length) {
    L('=== 结论:发现 ' + issues.length + ' 类问题 -- ' + issues.join(', ') + ' ===');
    exitCode = 1;
  } else {
    L('=== 结论:全部通过 ===');
  }

  console.log(lines.join('\n'));
  process.exit(exitCode);
})().catch((e) => {
  console.error('自检失败: ' + e.message);
  chrome.kill();
  process.exit(1);
});
