// author_posts.mjs —— 列出某个抖音作者最新的 N 条作品（douyin-subtitle skill）
// 网页接口 /aweme/v1/web/aweme/post/ 在 Argus 网关保护名单上，要 a_bogus + x-secsdk-web-signature 两层签名（见 web_api.mjs）。
//
// 用法: node author_posts.mjs "<作者主页链接/作者分享短链/该作者任意一条视频的链接或ID>" [--count N]
//   --count  要几条，默认 30，最多 100（每页 18 条，翻页间隔 1.5-3 秒）
// 输出: 终端列表（新→旧）+ 当前目录 author_<昵称>.json。置顶作品会标出来（它们不一定是新的）。
// 挑中的交给 api_extract.mjs <ID> 提取字幕；图文作品没有口播，跳过。

import fs from 'node:fs';
import { getDouyinCookie } from './cookie.mjs';
import { resolveAwemeId } from './resolve_id.mjs';
import { fetchMeta } from './video_meta.mjs';
import { UA, webGet, pause } from './web_api.mjs';

// 作者 sec_uid：主页链接里直接有；作者分享短链跟 302；否则当视频解析，从视频元数据里取作者
async function resolveSecUid(input) {
  let s = String(input || '');
  const short = s.match(/https?:\/\/v\.douyin\.com\/[\w-]+\/?/);
  if (short) {
    const r = await fetch(short[0], { redirect: 'manual', headers: { 'user-agent': UA } });
    const loc = r.headers.get('location') || '';
    if (/\/user\//.test(loc)) s = loc;
  }
  const direct = s.match(/MS4wLjABAAAA[\w-]+/);
  if (direct) return direct[0];
  const aid = await resolveAwemeId(input);
  if (!aid) return null;
  const meta = await fetchMeta(aid);
  return meta?.author_sec_uid || null;
}

const postPage = (cookie, secUid, maxCursor) => webGet(cookie, '/aweme/v1/web/aweme/post/', {
  sec_user_id: secUid, max_cursor: String(maxCursor), count: '18', locate_query: 'false', show_live_replay_strategy: '1',
  need_time_list: '1', time_list_query: '0', whale_cut_token: '', cut_version: '1', publish_video_strategy_type: '2',
}, { argus: true, referer: `https://www.douyin.com/user/${secUid}` });

// ---- CLI ----
const args = process.argv.slice(2);
const ci = args.indexOf('--count');
const want = Math.min(100, Math.max(1, parseInt(ci >= 0 ? args.splice(ci, 2)[1] : '30', 10) || 30));

try {
  const secUid = await resolveSecUid(args.join(' '));
  if (!secUid) { console.error('用法: node author_posts.mjs "<作者主页链接/作者分享短链/该作者任意一条视频>" [--count N]'); process.exit(1); }
  const cookie = await getDouyinCookie();

  const items = [], seen = new Set();
  let cursor = 0, author = '';
  for (let pg = 0; items.filter(x => !x.pinned).length < want && pg < 10; pg++) {
    if (pg) await pause();
    const j = await postPage(cookie, secUid, cursor);
    for (const a of j.aweme_list || []) {
      if (seen.has(a.aweme_id)) continue;
      seen.add(a.aweme_id);
      author ||= a.author?.nickname || '';
      items.push({
        aweme_id: a.aweme_id,
        url: `https://www.douyin.com/video/${a.aweme_id}`,
        title: (a.desc || '').replace(/\s+/g, ' ').trim(),
        type: a.images?.length ? '图文' : '视频',
        duration_s: Math.round((a.video?.duration || 0) / 1000),
        likes: a.statistics?.digg_count ?? null,
        create_time: a.create_time ? new Date(a.create_time * 1000).toISOString().slice(0, 10) : '',
        ts: a.create_time || 0,
        pinned: a.is_top === 1,
      });
    }
    if (!j.has_more) break;
    cursor = j.max_cursor;
  }

  // 置顶作品排在接口最前面但不一定新：单独列出，其余按发布时间新→旧取前 N 条
  const pinned = items.filter(x => x.pinned);
  const latest = items.filter(x => !x.pinned).sort((a, b) => b.ts - a.ts).slice(0, want);
  const line = (it, i) => `${String(i + 1).padStart(3)}. ${it.create_time} | ${it.type === '图文' ? '[图文] ' : ''}${it.title.slice(0, 40)} | ${it.duration_s}s | 赞${it.likes} | ${it.aweme_id}`;
  console.log(`作者: ${author}  sec_uid=${secUid}`);
  if (pinned.length) { console.log('置顶:'); pinned.forEach((it, i) => console.log(line(it, i).replace(/^\s*\d+\./, '  📌'))); }
  console.log(`最新 ${latest.length} 条（新→旧）:`);
  latest.forEach((it, i) => console.log(line(it, i)));
  const file = `author_${(author || secUid.slice(-8)).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40)}.json`;
  fs.writeFileSync(file, JSON.stringify({ author, sec_uid: secUid, pinned, latest: latest.map((it, i) => ({ n: i + 1, ...it })) }, null, 2), 'utf-8');
  console.log(`\n→ ${file}。提取字幕: node api_extract.mjs <ID>（图文跳过）`);
} catch (e) {
  console.error('FAILED:', e.message);
  process.exit(1);
}
