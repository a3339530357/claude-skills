// read_answer.mjs —— 从 AI 面板读最后一条 AI 回答（douyin-subtitle skill）
// 用法: node read_answer.mjs <aweme_id> [问题结尾标记]
//   问题结尾标记缺省 = 「（此段无字幕）」。」（强提示词结尾）
// 输出: <OUT_ROOT>/<标题>_<ID>/subtitles_<ID>.txt + <OUT_ROOT>/<标题>_<ID>.md（布局见 outdir.mjs）

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const DAEMON_DIR = process.env.CDP_DAEMON_DIR || 'D:\\project\\tests\\browser';
const STATE_FILE = path.join(DAEMON_DIR, 'cdp-daemon.json');
import { resolveAwemeId } from './resolve_id.mjs';
import { cleanAnswer } from './clean.mjs';
import { paths, ensureDir, writeMarkdown } from './outdir.mjs';
import { fetchMeta } from './video_meta.mjs';
const [,, idArg, markerArg] = process.argv;
const awemeId = await resolveAwemeId(idArg);
if (!awemeId) { console.error('用法: node read_answer.mjs <视频URL/短链/aweme_id> [问题结尾标记]'); process.exit(1); }
const MARKER = markerArg || '（此段无字幕）」。';

const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
function ipc(req, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port: state.port });
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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function cdp(method, params = {}, sessionId) {
  const r = await ipc({ op: 'send', method, params, sessionId });
  if (!r.ok) throw new Error(`${method}: ${JSON.stringify(r.error).slice(0, 200)}`);
  return r.result;
}

async function main() {
  // 轻量模式：独立面板页（主文档级，无 iframe）；回退旧视频页内的 so-landing iframe
  const tg = await cdp('Target.getTargets');
  let page = tg.targetInfos.find(t => t.type === 'page' && t.url.includes('search_ai_mobile/pc'));
  let sess, ctxId = undefined;
  if (page) {
    const a1 = await cdp('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    sess = a1.sessionId;
  } else {
    page = tg.targetInfos.find(t => t.type === 'page' && t.url.includes(`jingxuan?modal_id=${awemeId}`));
    if (!page) throw new Error(`找不到面板页或 ${awemeId} 的视频标签页（先跑 douyin_ask.mjs）`);
    const a1 = await cdp('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    sess = a1.sessionId;
    const ft = await cdp('Page.getFrameTree', {}, sess);
    let frame = null;
    const walk = (n) => { if (n.frame && n.frame.url.includes('so-landing')) frame = n.frame; (n.childFrames || []).forEach(walk); };
    walk(ft.frameTree);
    if (!frame) throw new Error('AI 面板未打开');
    const world = await cdp('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'read_answer' }, sess);
    ctxId = world.executionContextId;
  }

  // 轮询读最后一个 chatWrapper：必须包含问题结尾标记（= 本轮气泡，排除旧气泡）
  // 且出现免责声明（= 生成完成）。同时取回各个 .card-item 的独立文本——
  // 正文和「推荐追问」是并列的两个 card-item，不能靠正则从整块文本里猜边界。
  let full = '';
  let items = [];
  for (let i = 0; i < 80; i++) {
    const params = {
      expression: `(() => {
        const ws = [...document.querySelectorAll('div[class*="chatWrapper"]')];
        if (!ws.length) return null;
        const w = ws[ws.length - 1];
        return { full: w.innerText || '', items: [...w.querySelectorAll('.card-item')].map(e => e.innerText || '').filter(t => t.trim()) };
      })()`,
      returnByValue: true };
    if (ctxId !== undefined) params.contextId = ctxId;
    const v = (await cdp('Runtime.evaluate', params, sess)).result?.value;
    if (v) { full = v.full || ''; items = v.items || []; }
    if (full.includes(MARKER) && full.includes('以上结果由问问AI')) break;
    await sleep(1500);
  }
  if (!full) throw new Error('没读到对话内容');

  // 正文 = 含问题结尾标记的那个 card-item（问题本身在另一个 query_text 节点里，不会误中）；
  // 兜底：取最长的那块
  let answer = items.find(t => t.includes(MARKER))
    || items.slice().sort((a, b) => b.length - a.length)[0]
    || full;
  // 旧布局（单块文本）才需要按标记切：问题在气泡最前，用第一个匹配
  if (answer === full && answer.includes(MARKER)) {
    const mi = answer.indexOf(MARKER);
    answer = answer.slice(mi + MARKER.length);
  }
  answer = cleanAnswer(answer, console.log);

  // 元数据只用来取标题（决定目录名）和时长（完整度），拿不到也照样出正文
  const meta = await fetchMeta(awemeId).catch(() => null);
  const P = paths(awemeId, meta);
  ensureDir(P.dir);
  fs.writeFileSync(P.subs, answer, 'utf-8');
  const md = writeMarkdown(awemeId, meta, { source: '抖音「问问AI」语音识别（面板版）' });
  console.log(`已保存 ${P.subs}（${answer.length} 字符）`);
  if (md) console.log(`markdown → ${md}`);
  console.log('---- 前 400 字符预览 ----');
  console.log(answer.slice(0, 400));
  try { await cdp('Target.detachFromTarget', { sessionId: sess }); } catch {}
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
