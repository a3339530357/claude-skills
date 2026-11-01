// 抖音视频弹幕：aweme/v1/web/danmaku/get_v2，按时间窗拉取（douyin-subtitle skill）
//
// 用法: node danmaku.mjs <链接/短链/分享口令/ID>
// 输出: <OUT_ROOT>/<标题>_<ID>/danmaku_<ID>.txt（带时间戳）+ .json（原始字段）
// 免 Cookie、免签名；元数据走 video_meta 的移动端 Feed。
// 注意: aid=6383 必须带，否则接口回 status_code 3「AppId不合法」。
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveAwemeId } from './resolve_id.mjs';
import { fetchMeta } from './video_meta.mjs';
import { paths, ensureDir } from './outdir.mjs';

const arg = process.argv[2];
if (!arg) { console.error('用法: node danmaku.mjs <链接/ID>'); process.exit(1); }
const id = await resolveAwemeId(arg);
if (!id) { console.error('没解析出 aweme_id'); process.exit(1); }

const meta = await fetchMeta(id);
const durMs = Math.round((meta?.duration_s ?? 0) * 1000);
console.log(`aweme_id=${id}  ${meta?.author ?? ''}「${meta?.title ?? id}」 ${(durMs / 1000).toFixed(1)}s`);
if (!durMs) { console.error('拿不到时长，无法分片'); process.exit(1); }

// 接口单次只返回有限条数，按 60 秒窗口分片，否则只拿得到开头一段
const WIN = 60_000;
const seen = new Map();
for (let start = 0; start < durMs; start += WIN) {
  const end = Math.min(start + WIN, durMs);
  const url = 'https://www.douyin.com/aweme/v1/web/danmaku/get_v2/'
    + `?aid=6383&item_id=${id}&group_id=${id}&start_time=${start}&end_time=${end}&duration=${durMs}`;
  const r = await fetch(url, { headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36',
    Referer: 'https://www.douyin.com/' } });
  if (!r.ok) { console.error(`窗口 ${start / 1000}s HTTP ${r.status}，停止`); break; }
  const j = await r.json();
  const list = j.danmaku_list ?? [];
  for (const d of list) seen.set(d.danmaku_id, d);
  console.log(`  ${String(start / 1000).padStart(4)}-${String(end / 1000).padEnd(4)}s  ${list.length} 条`);
  await new Promise(r2 => setTimeout(r2, 700));
}

const all = [...seen.values()].sort((a, b) => a.offset_time - b.offset_time);
const fmt = ms => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const lines = all.map(d =>
  `[${fmt(d.offset_time)}] ${d.text}${d.digg_count ? ` (${d.digg_count} 赞)` : ''}`);

const p = paths(id, meta);
ensureDir(p.dir);
const head = `# 弹幕：${meta?.title ?? id}\n\n作者：${meta?.author ?? ''} | 时长 ${(durMs / 1000).toFixed(0)}s | 弹幕 ${all.length} 条\n\n`;
await writeFile(path.join(p.dir, `danmaku_${id}.txt`), head + lines.join('\n') + '\n');
await writeFile(path.join(p.dir, `danmaku_${id}.json`), JSON.stringify(all, null, 2));
console.log(`\n共 ${all.length} 条 → ${path.join(p.dir, `danmaku_${id}.txt`)}`);
console.log(lines.slice(0, 20).join('\n'));
