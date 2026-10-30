// douyin_ask.mjs —— 抖音 AI 面板发问工具（douyin-subtitle skill，轻量模式 v2）
// 不加载抖音视频页：直接开 so-landing 独立聊天页，视频上下文经 URL 参数绑定。
// 零视频流、零 feed 流、零 iframe —— 只加载文字界面。
//
// 用法: node douyin_ask.mjs <视频URL/短链/分享文本/aweme_id> [问题|@extract]
//   问题缺省 = 视频总结；@extract = scripts/extract_prompt.txt 里的字幕提取提示词
//   DEEP=1 打开深度思考（独立面板页里会丢视频上下文，别用）；FRESH_PANEL=1 整页重载
// 输出(当前目录): panel_tail_<ID>.txt(面板原文) detail_<ID>.json(章节/摘要, best effort)
// 依赖: CDP daemon（环境变量 CDP_DAEMON_DIR 可覆盖，默认 D:\project\tests\browser）

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveAwemeId } from './resolve_id.mjs';

const DAEMON_DIR = process.env.CDP_DAEMON_DIR || 'D:\\project\\tests\\browser';
const STATE_FILE = path.join(DAEMON_DIR, 'cdp-daemon.json');
const DAEMON = path.join(DAEMON_DIR, 'cdp-daemon.mjs');
const DEVICE_ID = '7672052742077449768';
const USER_ID = '98000805886';

// ---- daemon IPC ----
function readState() {
  if (!fs.existsSync(STATE_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}
function ipc(req, port, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port });
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('daemon 超时')); }, timeoutMs);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'));
    sock.on('data', (chunk) => {
      buf += chunk;
      const i = buf.indexOf('\n');
      if (i >= 0) { clearTimeout(timer); sock.destroy(); try { resolve(JSON.parse(buf.slice(0, i))); } catch (e) { reject(e); } }
    });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}
const ping = (port) => ipc({ op: 'ping' }, port, 2000).then(() => true).catch(() => false);
async function ensureDaemon() {
  let st = readState();
  if (st && await ping(st.port)) return st;
  console.log('daemon 未运行，自动拉起...');
  const child = spawn(process.execPath, [DAEMON], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 300));
    st = readState();
    if (st && await ping(st.port)) return st;
  }
  throw new Error('daemon 启动失败');
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function cdp(state, method, params = {}, sessionId) {
  const r = await ipc({ op: 'send', method, params, sessionId }, state.port);
  if (!r.ok) throw new Error(`${method}: ${JSON.stringify(r.error).slice(0, 200)}`);
  return r.result;
}
async function ev(state, sess, expr, opts = {}) {
  const r = await cdp(state, 'Runtime.evaluate', { expression: expr, returnByValue: true, ...opts }, sess);
  const v = r?.result;
  if (v?.subtype === 'error') throw new Error('页面执行错误: ' + (v.description || '').slice(0, 200));
  return v?.value;
}

// ---- 参数 ----
const [,, urlArg, ...rest] = process.argv;
let question = rest.join(' ') || '视频总结';
// @extract = 内置的字幕提取提示词（scripts/extract_prompt.txt），免得在命令行里转义长文本
if (question === '@extract') question = fs.readFileSync(new URL('./extract_prompt.txt', import.meta.url), 'utf8').trim();

const AID = await resolveAwemeId(urlArg);
if (!AID) { console.error('无法解析 aweme_id，用法: node douyin_ask.mjs <视频URL/短链/分享文本/ID> [问题|@extract]'); process.exit(1); }
console.log(`aweme_id=${AID}  question=${question.slice(0, 30)}${question.length > 30 ? '…' : ''}`);

const panelUrl = (aid) => {
  const patch = encodeURIComponent(JSON.stringify({ ai_search_enter_from_group_id: aid, aweme_id: aid }));
  return `https://so-landing.douyin.com/search_ai_mobile/pc?aid=6383&device_id=${DEVICE_ID}&user_id=${USER_ID}` +
         `&ai_search_req_patch=${patch}&scene=feed&page_name=comment_ai_analysis&theme=dark&enter_from=discover`;
};

async function run() {
  const state = await ensureDaemon();

  // 1) 复用独立面板页，没有就开一个后台页
  const tg = await cdp(state, 'Target.getTargets');
  const existing = tg.targetInfos.filter(t => t.type === 'page' && t.url.includes('search_ai_mobile/pc'));
  let page = existing[0];
  if (!page) {
    const r = await cdp(state, 'Target.createTarget', { url: panelUrl(AID), background: true }).catch(() =>
               cdp(state, 'Target.createTarget', { url: panelUrl(AID) }));
    page = { targetId: r.targetId, url: '' };
    await sleep(6000);
  }
  const a1 = await cdp(state, 'Target.attachToTarget', { targetId: page.targetId, flatten: true });
  const sess = a1.sessionId;
  // 后台标签没有焦点：鼠标点击不会聚焦输入框，insertText 会打进空气。开焦点模拟后再用 JS focus()
  await cdp(state, 'Emulation.setFocusEmulationEnabled', { enabled: true }, sess);

  // 2) FRESH_PANEL=1：强制整页重载，拿到干净会话。
  //    AI 面板会保留历史对话，连提多个视频时回答会带着前一个视频的上下文。
  //    不用 Target.closeTarget —— 页面挂着会话时它可能等不到回包，会假死 90 秒。
  //    先 about:blank 再回面板页 = 真正的整页导航，React 重新挂载。
  const fresh = process.env.FRESH_PANEL === '1';
  if (fresh) {
    await cdp(state, 'Page.navigate', { url: 'about:blank' }, sess);
    await sleep(400);
  }

  // 3) 若当前绑定的不是目标视频（或强制重载）→ 导航换绑
  if (fresh || !decodeURIComponent(page.url).includes(`"aweme_id":"${AID}"`)) {
    console.log(fresh ? '强制新会话（整页重载）...' : '绑定目标视频...');
    await cdp(state, 'Page.navigate', { url: panelUrl(AID) }, sess);
    await sleep(fresh ? 5000 : 3000);
  }

  // 3) 等输入框出现（主文档级，无 iframe）
  let pos = null;
  for (let i = 0; i < 15 && !pos; i++) {
    pos = await ev(state, sess, `(() => {
      const els = [...document.querySelectorAll('[contenteditable=true], textarea')].filter(e => e.getBoundingClientRect().width > 100);
      if (!els.length) return null;
      const r = els[els.length-1].getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    })()`).catch(() => null);
    if (!pos) await sleep(1000);
  }
  if (!pos) throw new Error('输入框未出现（面板页加载失败？）');

  // 深度思考开关：DEEP=1 打开，否则确保关闭（开关状态会留在页面上，上一轮开了这轮也还开着）。
  // 开关是 div[class*=deepSearchButton]，激活后多一个 deepSearchButtonActive；JS click 即可切换。
  // 实测独立面板页的深度思考读不到视频上下文，只会全网搜索甚至死循环，默认不要开。
  const wantDeep = process.env.DEEP === '1';
  const deepState = await ev(state, sess, `(() => {
    const b = document.querySelector('[class*="deepSearchButton"]');
    if (!b) return 'missing';
    if (/deepSearchButtonActive/.test(b.className) !== ${wantDeep}) b.click();
    return 'ok';
  })()`);
  if (deepState === 'missing') console.log('找不到深度思考开关（忽略）');
  else {
    await sleep(500);
    const isOn = await ev(state, sess, `/deepSearchButtonActive/.test(document.querySelector('[class*="deepSearchButton"]').className)`);
    console.log(`深度思考: ${isOn ? '开' : '关'}${isOn !== wantDeep ? '（切换失败）' : ''}`);
  }

  // 4) 真实输入：JS 聚焦 → 清稿 → 输入 → 确认字已进框 → 回车 → 确认新气泡出现。
  //    两道验证缺一不可：只看「输入框空了」会把「字根本没打进去」误判成已发送，然后空等 150 秒。
  const INPUT = `[...document.querySelectorAll('[contenteditable=true], textarea')].filter(e => e.getBoundingClientRect().width > 100).pop()`;
  const inputText = () => ev(state, sess, `(() => { const e = ${INPUT}; return e ? (e.innerText || e.value || '') : '?'; })()`).catch(() => '?');
  const bubbleCount = () => ev(state, sess, `document.querySelectorAll('div[class*="chatWrapper"]').length`).catch(() => -1);
  const key = async (k, code, vk, modifiers = 0) => {
    for (const type of ['rawKeyDown', 'keyUp'])
      await cdp(state, 'Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }, sess);
  };
  const qHead8 = question.slice(0, 8);
  const before = await bubbleCount();
  let sentOk = false;
  for (let attempt = 0; attempt < 3 && !sentOk; attempt++) {
    if (attempt) await sleep(1500);
    await ev(state, sess, `(() => { const e = ${INPUT}; e && e.focus(); })()`).catch(() => {});
    await key('a', 'KeyA', 65, 2);
    await key('Delete', 'Delete', 46);
    await cdp(state, 'Input.insertText', { text: question }, sess);
    await sleep(250);
    if (!(await inputText()).includes(qHead8)) { console.log(`send attempt ${attempt + 1}: 文字没进输入框，重试`); continue; }
    await key('Enter', 'Enter', 13);
    for (let i = 0; i < 8 && !sentOk; i++) {
      await sleep(500);
      sentOk = (await bubbleCount()) > before && !(await inputText()).includes(qHead8);
    }
    console.log(`send attempt ${attempt + 1}: ${sentOk ? 'OK' : '回车后没出现新气泡，重试'}`);
  }
  if (!sentOk) throw new Error('问题 3 次都没发出去（页面未就绪或输入框选择器失效）');

  // 5) 轮询生成完成：最后气泡含本轮问题 + 免责声明，1.5s 粒度，最多 150s
  const qHead = question.slice(0, 12);
  let text = '', done = false;
  for (let i = 0; i < 100 && !done; i++) {
    await sleep(1500);
    text = await ev(state, sess, `(() => { const ws = [...document.querySelectorAll('div[class*="chatWrapper"]')]; return ws.length ? (ws[ws.length-1].innerText || '') : ''; })()`).catch(() => '');
    done = text.includes(qHead) && text.includes('以上结果由问问AI');
  }
  fs.writeFileSync(`panel_tail_${AID}.txt`, text, 'utf-8');
  console.log(`panel tail saved (${text.length} chars)${done ? '' : ' —— 150 秒内未生成完，内容可能不完整'}`);

  // 6) 章节/摘要（best effort：独立页跨域 fetch www 接口可能被 CORS 挡，失败即跳过）
  try {
    const detail = await ev(state, sess, `(async () => { const r = await fetch('https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${AID}&aid=6383&device_platform=webapp', {credentials:'include'}); return await r.text(); })()`, { awaitPromise: true });
    if (detail && detail.includes('aweme_detail')) {
      fs.writeFileSync(`detail_${AID}.json`, detail, 'utf-8');
      const d = JSON.parse(detail).aweme_detail || {};
      if ((d.chapter_list || []).length) {
        console.log('===== 章节要点 =====');
        for (const c of d.chapter_list) console.log(`  [${(c.timestamp/1000)|0}s] ${c.desc}${c.detail ? ' — ' + c.detail : ''}`);
      }
    }
  } catch (e) { console.log('detail 跳过(跨域限制，不影响字幕)'); }

  try { await cdp(state, 'Target.detachFromTarget', { sessionId: sess }); } catch {}
}

run().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
