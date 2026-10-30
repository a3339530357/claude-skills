// bili.mjs —— B 站共用：链接解析、WBI 签名、视频详情、官方 AI 总结（bilibili-subtitle skill）
//
// WBI 签名参考 Douyin_TikTok_Download_API 的 dtk/signing/native/wbi.py：
//   nav 接口公布两张图片的文件名（img_key / sub_key，约每天轮换）→ 按 MIXIN 表重排取前 32 位 = mixin key；
//   参数加 wts 后按 key 排序、值里删掉 !'()*、encodeURIComponent 拼接 → w_rid = md5(query + mixin)。
//   未签名的 /x/web-interface/view 现在会回 412，详情也要走 wbi/view。

import crypto from 'node:crypto';

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const API = 'https://api.bilibili.com';
const MIXIN = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];

const headers = (cookie) => ({ cookie, 'user-agent': UA, referer: 'https://www.bilibili.com/' });

// ---- 输入解析：BV 号 / av 号 / 视频链接（含 ?p=N）/ b23.tv 短链 / 整段分享文本 ----
export async function resolveVideo(input) {
  let s = String(input || '').trim();
  const short = s.match(/https?:\/\/(?:b23\.tv|bili2233\.cn)\/[A-Za-z0-9]+/);
  if (short) {
    // 短链跟一次 302 拿真实地址
    const r = await fetch(short[0], { redirect: 'manual', headers: { 'user-agent': UA } });
    s = r.headers.get('location') || s;
  }
  const p = Number(s.match(/[?&]p=(\d+)/)?.[1]) || null;
  const bv = s.match(/BV[0-9A-Za-z]{10}/)?.[0];
  if (bv) return { bvid: bv, p };
  const av = s.match(/(?:^|\/|\b)av(\d+)/i)?.[1] || (/^\d+$/.test(s) ? s : null);
  if (av) return { aid: av, p };
  return null;
}

// ---- WBI ----
let keysCache = null;
async function mixinKey(cookie) {
  if (keysCache) return keysCache;
  // 未登录也会给 keys（code=-101），所以不看 code
  const j = await (await fetch(`${API}/x/web-interface/nav`, { headers: headers(cookie) })).json();
  const stem = (u) => String(u || '').split('/').pop().split('.')[0];
  const raw = stem(j.data?.wbi_img?.img_url) + stem(j.data?.wbi_img?.sub_url);
  if (raw.length < 64) throw new Error('nav 没给 WBI keys（接口变了？）');
  return (keysCache = MIXIN.map(i => raw[i]).join('').slice(0, 32));
}

export async function wbiGet(cookie, uri, params) {
  const all = { ...params, wts: Math.floor(Date.now() / 1000) };
  const query = Object.keys(all).sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(all[k]).replace(/[!'()*]/g, ''))}`).join('&');
  const w_rid = crypto.createHash('md5').update(query + await mixinKey(cookie)).digest('hex');
  const r = await fetch(`${API}${uri}?${query}&w_rid=${w_rid}`, { headers: headers(cookie) });
  if (!r.ok) throw new Error(`${uri} HTTP ${r.status}`);
  return r.json();
}

export async function isLoggedIn(cookie) {
  const j = await (await fetch(`${API}/x/web-interface/nav`, { headers: headers(cookie) })).json();
  return !!j.data?.isLogin;
}

// ---- 视频详情：标题、UP 主、简介、分 P（每 P 的 cid 和时长）----
export async function fetchView(cookie, { bvid, aid }) {
  const j = await wbiGet(cookie, '/x/web-interface/wbi/view', bvid ? { bvid } : { aid });
  if (j.code !== 0) throw new Error(`视频详情失败 code=${j.code} ${j.message}（删除/私密/番剧？番剧走 /bangumi，不在本技能范围）`);
  const d = j.data;
  return {
    bvid: d.bvid, aid: d.aid, title: d.title, desc: d.desc, owner: d.owner?.name, owner_mid: d.owner?.mid,
    duration_s: d.duration, pubdate: new Date(d.pubdate * 1000).toISOString(),
    pages: (d.pages || []).map(x => ({ page: x.page, cid: x.cid, part: x.part, duration_s: x.duration })),
  };
}

// ---- 官方「AI 视频总结」（播放页的「AI 小助手」那块）：摘要 + 带时间戳的提纲 ----
// 不是每条视频都有：没生成过 / UP 关掉 / 太短 都会返回空
export async function fetchConclusion(cookie, view, cid) {
  const j = await wbiGet(cookie, '/x/web-interface/view/conclusion/get', { bvid: view.bvid, cid, up_mid: view.owner_mid });
  const m = j.data?.model_result;
  if (j.code !== 0 || !m || (!m.summary && !m.outline?.length)) return null;
  const ts = (sec) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
  const lines = [m.summary || ''];
  for (const o of m.outline || []) {
    lines.push('', `## ${ts(o.timestamp)} ${o.title}`);
    for (const po of o.part_outline || []) lines.push(`- ${ts(po.timestamp)} ${po.content}`);
  }
  return lines.join('\n').trim();
}

// ---- srt → 纯文本（去序号、时间轴、连续重复行）----
export function srtToText(srt) {
  const out = [];
  for (const raw of String(srt).split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || /^\d+$/.test(l) || l.includes('-->')) continue;
    if (out[out.length - 1] !== l) out.push(l);
  }
  return out.join('\n');
}

// 字数 / 时长：B 站字幕是真 ASR/人工字幕，不会「编」，这里只用来发现「字幕只覆盖了一小段」或「基本是音乐」
export function density(text, durationS) {
  const n = String(text).replace(/\s/g, '').length;
  if (!durationS) return { chars: n, perMin: null, note: '' };
  const perMin = Math.round(n / (durationS / 60));
  const note = perMin < 100 ? '（偏低：可能字幕只覆盖了一部分，或视频以音乐/画面为主）' : '';
  return { chars: n, perMin, note };
}
