// comments.mjs —— 抖音视频评论区（douyin-subtitle skill）
// 网页接口 /aweme/v1/web/comment/list/（一级评论，每条附带接口自带的前几条回复，作者回复通常在内）。
// 楼中楼接口 /comment/list/reply/ 要用占位签名（见 web_api.mjs 的 REPLY_PLACEHOLDER_ABOGUS 注释：它只校验格式不校验内容）。
// 不在 Argus 网关保护名单上（DTK protection.py 实测 8/8），只要 a_bogus；签名与请求见 web_api.mjs。
//
// 用法: node comments.mjs "<视频链接/短链/分享口令/ID>" [--count N] [--replies K]
//   --count    一级评论要几条，默认 50，最多 200（每页 20 条，翻页间隔 1.5-3 秒）。顺序 = 抖音默认的热度排序
//   --replies  给回复最多的前 10 条一级评论各展开前 K 条回复，默认 0（只用接口自带的那几条）；最多 20
// 输出: 终端预览 + 当前目录 comments_<ID>.txt（可读版）/ comments_<ID>.json（全字段）

import fs from 'node:fs';
import { getDouyinCookie } from './cookie.mjs';
import { resolveAwemeId } from './resolve_id.mjs';
import { webGet, pause } from './web_api.mjs';

const fmt = (c) => ({
  cid: c.cid,
  user: c.user?.nickname || '',
  text: (c.text || '').trim() + (c.image_list?.length ? ' [图片]' : '') + (c.sticker ? ' [表情]' : ''),
  likes: c.digg_count ?? 0,
  reply_total: c.reply_comment_total ?? 0,
  ip: c.ip_label || '',
  time: c.create_time ? new Date(c.create_time * 1000).toISOString().slice(0, 16).replace('T', ' ') : '',
  is_author: (c.label_text || '').includes('作者') || c.label_type === 1,
  author_liked: !!c.is_author_digged,
  reply_to: c.reply_to_username || '',
  replies: [],
});

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; };
const want = Math.min(200, Math.max(1, parseInt(opt('--count', '50'), 10) || 50));
const expand = Math.min(20, Math.max(0, parseInt(opt('--replies', '0'), 10) || 0));

try {
  const AID = await resolveAwemeId(args.join(' '));
  if (!AID) { console.error('用法: node comments.mjs "<视频链接/短链/分享口令/ID>" [--count N] [--replies K]'); process.exit(1); }
  const cookie = await getDouyinCookie();
  const referer = `https://www.douyin.com/video/${AID}`;

  const list = [], seen = new Set();
  let cursor = 0, total = null;
  for (let pg = 0; list.length < want && pg < 15; pg++) {
    if (pg) await pause();
    const j = await webGet(cookie, '/aweme/v1/web/comment/list/', {
      aweme_id: AID, cursor: String(cursor), count: '20', item_type: '0', insert_ids: '', whale_cut_token: '', cut_version: '1', rcFT: '',
    }, { referer });
    total ??= j.total ?? null;
    for (const c of j.comments || []) {
      if (seen.has(c.cid)) continue;
      seen.add(c.cid);
      const it = fmt(c);
      // 接口自带的少量回复（通常 0-3 条）；更多回复要楼中楼接口，目前不可用
      it.replies = (c.reply_comment || []).map(fmt);
      list.push(it);
    }
    if (!j.has_more) break;
    cursor = j.cursor;
  }
  const comments = list.slice(0, want);

  // 楼中楼：只给回复最多的前 10 条展开，免得请求太多
  if (expand) {
    const targets = comments.filter(c => c.reply_total > c.replies.length).sort((a, b) => b.likes - a.likes).slice(0, 10);
    for (const c of targets) {
      // 接口单页最多给 20 条；要更多就按 cursor（偏移量）翻页，最多 3 页
      const got = [], ids = new Set();
      let cursor = 0;
      for (let p = 0; p < 3 && got.length < expand; p++) {
        if (p) await pause();
        const j = await webGet(cookie, '/aweme/v1/web/comment/list/reply/', {
          item_id: AID, comment_id: c.cid, cursor: String(cursor), count: '20', item_type: '0',
        }, { referer, fakeAbogus: true });
        for (const r of (j.comments || []).map(fmt)) if (!ids.has(r.cid)) { ids.add(r.cid); got.push(r); }
        if (!j.has_more) break;
        cursor = j.cursor;
      }
      c.replies = [...got.slice(0, expand), ...c.replies.filter(r => !ids.has(r.cid))];
    }
  }

  // 可读版
  const out = [`视频 ${AID}  评论总数 ${total ?? '?'}（含回复），取了 ${comments.length} 条一级评论（抖音热度序）`, ''];
  comments.forEach((c, i) => {
    const tags = [c.is_author && '作者', c.author_liked && '作者赞过'].filter(Boolean).map(t => `[${t}]`).join('');
    out.push(`${i + 1}. ${c.user}${tags}（赞${c.likes}${c.ip ? ' · ' + c.ip : ''} · ${c.time}${c.reply_total ? ` · ${c.reply_total} 条回复，下面列出 ${c.replies.length} 条` : ''}）`);
    out.push(`   ${c.text}`);
    for (const r of c.replies) out.push(`   ↳ ${r.user}${r.is_author ? '[作者]' : ''}${r.reply_to ? ' 回复 ' + r.reply_to : ''}：${r.text}（赞${r.likes}）`);
  });
  fs.writeFileSync(`comments_${AID}.txt`, out.join('\n'), 'utf-8');
  fs.writeFileSync(`comments_${AID}.json`, JSON.stringify({ aweme_id: AID, total, comments }, null, 2), 'utf-8');
  console.log(out.slice(0, 32).join('\n'));
  if (out.length > 32) console.log('……');
  console.log(`\n→ comments_${AID}.txt / .json`);
} catch (e) {
  console.error('FAILED:', e.message);
  process.exit(1);
}
