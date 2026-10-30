// cookie.mjs —— B 站登录 Cookie（字幕接口要登录：不登录只给弹幕）
//
// 平时只读本地文件，不碰 CDP；文件不存在或已过期时，才借 CDP daemon 从用户的 Chrome 读一次并写回文件。
// 到期时间取 SESSDATA 自身的 expires（B 站登录态一般半年）。
// 剩不到 REMIND_DAYS 天时提醒：Chrome 里那份同一天到期，要先在浏览器重新登录 B 站，再 --refresh。
//
// 文件: 环境变量 BILI_COOKIE_FILE，默认 <skill目录>/data/cookie.json
//       （等于 B 站登录凭证：不要提交、不要随技能分享；任何时候都不打印 cookie 值）
// 优先级: 环境变量 BILI_COOKIE > 文件 > CDP
//
// CLI: node cookie.mjs --status    看到期时间（不打印值）
//      node cookie.mjs --refresh   强制从 Chrome 重新读并写回文件

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const COOKIE_FILE = process.env.BILI_COOKIE_FILE || fileURLToPath(new URL('../data/cookie.json', import.meta.url));
const DAEMON_DIR = process.env.CDP_DAEMON_DIR || 'D:\\project\\tests\\browser';
const STATE_FILE = path.join(DAEMON_DIR, 'cdp-daemon.json');
const REMIND_DAYS = 3;

// ---- CDP（只在刷新时用）----
function ipc(port, req, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port });
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('daemon 超时')); }, timeoutMs);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'));
    sock.on('data', (c) => { buf += c; const i = buf.indexOf('\n'); if (i >= 0) { clearTimeout(timer); sock.destroy(); try { resolve(JSON.parse(buf.slice(0, i))); } catch (e) { reject(e); } } });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; } };
const alive = (st) => st ? ipc(st.port, { op: 'ping' }, 2000).then(() => true, () => false) : Promise.resolve(false);

async function readFromChrome() {
  let st = readState();
  if (!(await alive(st))) {
    console.log('daemon 未运行，自动拉起...');
    spawn(process.execPath, [path.join(DAEMON_DIR, 'cdp-daemon.mjs')], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    for (let i = 0; i < 60 && !(await alive(st = readState())); i++) await new Promise(r => setTimeout(r, 300));
    if (!(await alive(st))) throw new Error('daemon 启动失败（Chrome 开着吗？远程调试允许了吗？）');
  }
  const r = await ipc(st.port, { op: 'send', method: 'Storage.getCookies', params: {} });
  if (!r.ok) throw new Error('读 Cookie 失败: ' + JSON.stringify(r.error).slice(0, 200));
  // 只要 bilibili.com 及其子域（不能 endsWith('bilibili.com')，会误收别的域名）
  const jar = r.result.cookies.filter(c => { const d = c.domain.replace(/^\./, ''); return d === 'bilibili.com' || d.endsWith('.bilibili.com'); });
  if (!jar.some(c => c.name === 'SESSDATA')) throw new Error('Chrome 里没有 B 站登录态（SESSDATA），先在浏览器登录 B 站');
  return jar;
}

const expiresAt = (jar) => Math.floor(jar.find(c => c.name === 'SESSDATA')?.expires || 0);
const daysLeft = (exp) => (exp * 1000 - Date.now()) / 86400000;
const fmtDate = (exp) => new Date(exp * 1000).toLocaleString('zh-CN', { hour12: false });

export async function refreshCookie() {
  const jar = await readFromChrome();
  // jar 原样存（yt-dlp 要的 Netscape 格式需要 domain/path/secure/expires）；cookie 串供 fetch 直接用
  const data = {
    saved_at: new Date().toISOString(), expires_at: expiresAt(jar),
    cookie: jar.map(c => `${c.name}=${c.value}`).join('; '),
    jar: jar.map(({ name, value, domain, path, secure, expires }) => ({ name, value, domain, path, secure, expires })),
  };
  fs.mkdirSync(path.dirname(COOKIE_FILE), { recursive: true });
  fs.writeFileSync(COOKIE_FILE, JSON.stringify(data), 'utf-8');
  console.log(`已从 Chrome 更新 Cookie 文件，登录态到期 ${fmtDate(data.expires_at)}（剩 ${daysLeft(data.expires_at).toFixed(1)} 天）`);
  return data;
}

function readFile() {
  try { return JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8')); } catch { return null; }
}

// 返回 { cookie, jar }；环境变量 BILI_COOKIE 时 jar 为 null
export async function getBiliCookie() {
  if (process.env.BILI_COOKIE) return { cookie: process.env.BILI_COOKIE, jar: null };
  let data = readFile();
  if (!data?.cookie || !data.expires_at || daysLeft(data.expires_at) <= 0) {
    console.log(data ? 'Cookie 文件里的登录态已过期，从 Chrome 重新读取...' : '还没有 Cookie 文件，从 Chrome 读取一次...');
    data = await refreshCookie();
    if (daysLeft(data.expires_at) <= 0) throw new Error('Chrome 里的 B 站登录态也过期了：先在浏览器重新登录 B 站，再运行 cookie.mjs --refresh');
  }
  const left = daysLeft(data.expires_at);
  if (left < REMIND_DAYS)
    console.log(`⚠ B 站登录态 ${left.toFixed(1)} 天后到期（${fmtDate(data.expires_at)}）。请在浏览器重新登录 B 站，然后运行: node "${fileURLToPath(import.meta.url)}" --refresh`);
  return { cookie: data.cookie, jar: data.jar || null };
}

export const LOGIN_HINT = `登录态可能已失效：在浏览器确认 B 站还登录着，然后运行 node "${fileURLToPath(import.meta.url)}" --refresh`;

// ---- CLI ----
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.includes('--refresh')) await refreshCookie();
    else {
      const d = readFile();
      if (!d) console.log(`没有 Cookie 文件（${COOKIE_FILE}）。运行 --refresh 从 Chrome 读取`);
      else console.log(`文件: ${COOKIE_FILE}\n保存于: ${new Date(d.saved_at).toLocaleString('zh-CN', { hour12: false })}\n登录态到期: ${fmtDate(d.expires_at)}（剩 ${daysLeft(d.expires_at).toFixed(1)} 天）`);
    }
  } catch (e) { console.error('FAILED:', e.message); process.exit(1); }
}
