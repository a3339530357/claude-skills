// web_api.mjs —— 抖音网页接口的签名与请求（author_posts / comments 共用）
//
// 两层签名，都是纯算法、不开浏览器：
//   1) a_bogus：默认用 DTK 对 bdms.js v1.0.1.19-fix.01 的纯 Python 逆向（abogus_dtk.py，2026-09-09，无依赖）；
//      环境变量 ABOGUS_IMPL=f2 切回 f2 的 2024-11 版（abogus.py，需 gmssl）。经 sign_abogus.py 子进程调用。所有网页接口都带。
//   2) x-secsdk-web-signature：移植自 Douyin_TikTok_Download_API 的 dtk/signing/native/websign.py。
//      只有 ArgusSecurityPlugin 网关保护的接口要（2026-09 起：aweme/post、aweme/detail、mix/*、favorite 等；comment/list 不在内）。
//      md5("{uifid}_{timestamp}_{SALT}_{query}")，盐是安全 SDK（secsdk-strategy，project-id=34）字节码字符串表里的常量；
//      uifid 取 Cookie 的 UIFID，verifyFp/fp 取 Cookie 的 s_v_web_id。缺 uifid → 403 Uifid Not Found，缺签名 → Signature Not Found
// msToken 有就带（Cookie 里通常没有；DTK 实测带不带、真假都能过）。

import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LOGIN_HINT } from './cookie.mjs';

// 签名里编码了 UA，请求必须用同一个；browser_version 参数也要对得上
export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const BROWSER_PARAMS = {
  device_platform: 'webapp', aid: '6383', channel: 'channel_pc_web', update_version_code: '170400', pc_client_type: '1',
  pc_libra_divert: 'Windows', version_code: '290100', version_name: '29.1.0', cookie_enabled: 'true', screen_width: '1920',
  screen_height: '1080', browser_language: 'zh-CN', browser_platform: 'Win32', browser_name: 'Chrome', browser_version: '141.0.0.0',
  browser_online: 'true', engine_name: 'Blink', engine_version: '141.0.0.0', os_name: 'Windows', os_version: '10', cpu_core_num: '8',
  device_memory: '8', platform: 'PC', downlink: '10', effective_type: '4g', round_trip_time: '50', support_h265: '1', support_dash: '1',
};
const SIGNER = fileURLToPath(new URL('./sign_abogus.py', import.meta.url));
const SECSDK_SALT = 'A96D855A08C0A9707F8BEF0D9A527E4E';   // douyin_web 专用；SDK 换版本可能变，失效时去 DTK 的 websign.py 看新值

export const cookieVal = (cookie, name) => cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'))?.[1] || '';
// 和 JS URLSearchParams.toString() 一致（被签的串和发出去的串必须逐字节相同）；这些接口的值里没有空格，不用管 + / %20
const enc = (v) => encodeURIComponent(v).replace(/[!'()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function aBogus(query) {
  const r = spawnSync('python', ['-I', SIGNER], { input: JSON.stringify({ query, ua: UA, impl: process.env.ABOGUS_IMPL || 'dtk' }), encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (r.error?.code === 'ENOENT') throw new Error('找不到 python');
  if (r.status !== 0) throw new Error('a_bogus 签名失败: ' + (r.stderr || '').trim().split('\n').pop() + (/gmssl/.test(r.stderr) ? '（python -m pip install gmssl）' : ''));
  return JSON.parse(r.stdout).query;
}

// 第二层：在 a_bogus 之后依次追加 verifyFp、fp、uifid、timestamp，再对整串签名（顺序照网页抓包）
function secsdkSign(query, cookie) {
  const uifid = ['uifid', 'uifid_temp', 'uifidtemp', 'UIFID', 'UIFID_TEMP', 'UIFIDTEMP'].map(n => cookieVal(cookie, n)).find(Boolean);
  if (!uifid) throw new Error(`Cookie 里没有 UIFID，过不了 Argus 网关——${LOGIN_HINT}`);
  const pairs = [...new URLSearchParams(query)];
  const fp = cookieVal(cookie, 's_v_web_id');
  if (fp) pairs.push(['verifyFp', fp], ['fp', fp]);
  const ts = String(Math.floor(Date.now() / 1000));
  pairs.push(['uifid', uifid], ['timestamp', ts]);
  const q = pairs.map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&');
  const sig = crypto.createHash('md5').update(`${uifid}_${ts}_${SECSDK_SALT}_${q}`).digest('hex');
  return { query: `${q}&x-secsdk-web-signature=${sig}`, headers: { uifid, 'x-secsdk-web-signature': sig, 'x-secsdk-web-expire': ts } };
}

// reply 专用占位签名：/comment/list/reply/ 的签名校验比 list 严得多。
// 2026-10-30 实测：不带签名 → 200 + 0 字节；带「格式正确但内容错误」的 a_bogus → 正常返回；
// 带我们按 v1.0.1.19 算的真签名 → 200 + 0 字节（线上已换 v1.0.1.20，算出的值被认成非 SDK 产物）。
// 即该接口只校验格式不校验内容，所以用一个固定占位值。**只给 reply 用**，别处仍然用真签名。
export const REPLY_PLACEHOLDER_ABOGUS = 'A'.repeat(40);

// GET 一个网页接口。argus=true 时加第二层签名（只给网关保护的接口用）。fakeAbogus=true 用占位签名（见上）。
// 抖音偶尔对单次请求回 200 + 0 字节（实测 comment/list 同参数重发即正常），空响应重签重试一次
export async function webGet(cookie, path, params, opts = {}) {
  try { return await webGetOnce(cookie, path, params, opts); }
  catch (e) {
    if (!/0 字节/.test(e.message)) throw e;
    await pause();
    return webGetOnce(cookie, path, params, opts);
  }
}

async function webGetOnce(cookie, path, params, { argus = false, fakeAbogus = false, referer = 'https://www.douyin.com/' } = {}) {
  const msToken = cookieVal(cookie, 'msToken');
  const unsigned = new URLSearchParams({ ...BROWSER_PARAMS, ...params, ...(msToken ? { msToken } : {}) }).toString();
  let query = fakeAbogus ? `${unsigned}&a_bogus=${REPLY_PLACEHOLDER_ABOGUS}` : aBogus(unsigned);
  let extraHeaders = {};
  if (argus) ({ query, headers: extraHeaders } = secsdkSign(query, cookie));
  const r = await fetch(`https://www.douyin.com${path}?${query}`, {
    headers: { cookie, 'user-agent': UA, accept: 'application/json, text/plain, */*', referer, ...extraHeaders },
  });
  if (!r.ok) {
    const body = (await r.text()).slice(0, 80);
    throw new Error(`HTTP ${r.status} ${body}` + (/Argus/.test(body)
      ? `（Argus 网关拒绝：Signature Not Found/Invalid = 签名算法或盐变了，去 DTK 的 websign.py / abogus.py 看上游；Uifid Not Found = Cookie 缺 UIFID → ${LOGIN_HINT}；接口若新进了保护名单，调用处改 argus: true）`
      : ''));
  }
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { throw new Error(`返回的不是 JSON（${text.length} 字节）——可能被风控`); }
  if (j.status_code) throw new Error(`status_code ${j.status_code} ${j.status_msg || ''}`);
  return j;
}

export const pause = () => new Promise(r => setTimeout(r, 1500 + Math.random() * 1500));   // 翻页间隔，别像机器
