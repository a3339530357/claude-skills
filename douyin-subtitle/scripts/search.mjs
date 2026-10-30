// search.mjs —— 按关键词搜抖音视频（douyin-subtitle skill）
// 综合搜索 www.douyin.com/aweme/v1/web/general/search/single/：只要登录 Cookie，不需要 a_bogus 签名
// （参数照 MediaCrawler，它的代码对这个接口也跳过签名；2026-10-29 实测通过，含翻页）。
//
// 用法: node search.mjs "<关键词>" [--pages N] [--sort 0|1|2] [--time 0|1|7|182]
//   --pages  翻几页，每页约 15 条，默认 1，最多 5（搜索挂在用户账号上，翻太多会触发风控）
//   --sort   0 综合（默认）/ 1 最多点赞 / 2 最新发布
//   --time   0 不限（默认）/ 1 一天内 / 7 一周内 / 182 半年内
// 输出: 终端列表 + 当前目录 search_<关键词>.json（序号、ID、链接、作者、标题、时长、点赞）
// 挑中的视频交给 api_extract.mjs <ID> 提取字幕。

import fs from 'node:fs';
import { getDouyinCookie, LOGIN_HINT } from './cookie.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
// 网页端普通浏览器参数；不带也许能过，带上更像真网页，少触发风控
const BROWSER_PARAMS = {
  device_platform: 'webapp', aid: '6383', channel: 'channel_pc_web', version_code: '190600', version_name: '19.6.0',
  update_version_code: '170400', pc_client_type: '1', cookie_enabled: 'true', browser_language: 'zh-CN', browser_platform: 'Win32',
  browser_name: 'Chrome', browser_version: '141.0.0.0', browser_online: 'true', engine_name: 'Blink', engine_version: '141.0.0.0',
  os_name: 'Windows', os_version: '10', cpu_core_num: '8', device_memory: '8', platform: 'PC', screen_width: '1920', screen_height: '1080',
  effective_type: '4g', round_trip_time: '50',
};

async function searchPage(cookie, keyword, { offset = 0, searchId = '', sort = 0, time = 0 } = {}) {
  const filtered = sort || time;
  const p = new URLSearchParams({
    ...BROWSER_PARAMS,
    search_channel: 'aweme_general', enable_history: '1', keyword, search_source: 'tab_search', query_correct_type: '1',
    is_filter_search: filtered ? '1' : '0', offset: String(offset), count: '15', need_filter_settings: '1', list_type: 'multi',
    search_id: searchId,
    ...(filtered ? { filter_selected: JSON.stringify({ sort_type: String(sort), publish_time: String(time) }) } : {}),
  });
  const r = await fetch('https://www.douyin.com/aweme/v1/web/general/search/single/?' + p, {
    headers: { cookie, 'user-agent': UA, accept: 'application/json, text/plain, */*',
      referer: `https://www.douyin.com/search/${encodeURIComponent(keyword)}?type=general` },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { throw new Error(`返回的不是 JSON（${text.length} 字节）——可能被风控或接口变了`); }
  if (j.status_code) throw new Error(`status_code ${j.status_code} ${j.status_msg || ''}（2483 = 要登录 → ${LOGIN_HINT}；其他多半是风控，去浏览器里搜一次过验证码）`);
  // data[] 里混着视频卡片和别的卡片（用户、话题、合集等），只取 aweme_info
  const items = (j.data || []).map(d => d.aweme_info).filter(a => a?.aweme_id).map(a => ({
    aweme_id: a.aweme_id,
    url: `https://www.douyin.com/video/${a.aweme_id}`,
    author: a.author?.nickname || '',
    title: (a.desc || '').replace(/\s+/g, ' ').trim(),
    duration_s: Math.round((a.video?.duration || 0) / 1000),
    likes: a.statistics?.digg_count ?? null,
    create_time: a.create_time ? new Date(a.create_time * 1000).toISOString().slice(0, 10) : '',
  }));
  return { items, hasMore: !!j.has_more, cursor: j.cursor ?? offset + 15, searchId: j.extra?.search_request_id || j.log_pb?.impr_id || '' };
}

// ---- CLI ----
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; };
const pages = Math.min(5, Math.max(1, parseInt(opt('--pages', '1'), 10) || 1));
const sort = parseInt(opt('--sort', '0'), 10) || 0;
const time = parseInt(opt('--time', '0'), 10) || 0;
const keyword = args.join(' ').trim();
if (!keyword) { console.error('用法: node search.mjs "<关键词>" [--pages N] [--sort 0|1|2] [--time 0|1|7|182]'); process.exit(1); }

try {
  const cookie = await getDouyinCookie();
  const all = [], seen = new Set();
  let offset = 0, searchId = '';
  for (let pg = 0; pg < pages; pg++) {
    if (pg) await new Promise(r => setTimeout(r, 1500 + Math.random() * 1500));   // 翻页间隔，别像机器
    const res = await searchPage(cookie, keyword, { offset, searchId, sort, time });
    for (const it of res.items) if (!seen.has(it.aweme_id)) { seen.add(it.aweme_id); all.push(it); }
    if (!res.hasMore) break;
    offset = res.cursor; searchId = res.searchId;
  }
  all.forEach((it, i) => console.log(`${String(i + 1).padStart(2)}. ${it.author} | ${it.title.slice(0, 40)} | ${it.duration_s}s | 赞${it.likes} | ${it.create_time} | ${it.url}`));
  const file = `search_${keyword.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40)}.json`;
  fs.writeFileSync(file, JSON.stringify(all.map((it, i) => ({ n: i + 1, ...it })), null, 2), 'utf-8');
  console.log(`\n共 ${all.length} 条 → ${file}。提取字幕: node api_extract.mjs <ID>`);
} catch (e) {
  console.error('FAILED:', e.message);
  process.exit(1);
}
