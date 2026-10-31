// video_meta.mjs —— 作品元数据：标题、作者、时长、原生字幕、无水印播放地址（douyin-subtitle skill）
// 走移动端 Feed 接口（media-parser 的主路径）：免签名、免 Cookie。
//
// 用法: node video_meta.mjs <视频URL/短链/分享文本/ID> [--download]
//   --download  把无水印视频存成 <OUT_ROOT>/<标题>_<ID>/video_<ID>.mp4（本地转写兜底用）
// 作为模块: import { fetchMeta, fetchNativeCaptions, density } from './video_meta.mjs'

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolveAwemeId } from './resolve_id.mjs';
import { paths, ensureDir } from './outdir.mjs';

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const HOSTS = ['https://api5-normal-c-hl.amemv.com', 'https://aweme.snssdk.com'];

export async function fetchMeta(aid) {
  for (const host of HOSTS) {
    try {
      const r = await fetch(`${host}/aweme/v1/feed/?aweme_id=${aid}&aid=1128`, { headers: { 'user-agent': UA } });
      const j = await r.json();
      // Feed 返回的是一串推荐流，必须按 aweme_id 精确匹配，不能取第一条
      const a = (j.aweme_list || []).find(x => x.aweme_id === aid);
      if (!a) continue;
      const v = a.video || {};
      return {
        aweme_id: aid,
        title: a.desc || '',
        author: a.author?.nickname || '',
        author_sec_uid: a.author?.sec_uid || '',
        duration_s: Math.round((v.duration || a.duration || 0) / 100) / 10,
        // 原生字幕（平台 AI 生成的 WebVTT）：cla_info.caption_infos 优先，其次 subtitle_infos
        captions: (v.cla_info?.caption_infos || v.subtitle_infos || [])
          .map(c => ({ lang: c.language_code || c.lang, url: c.url || c.Url || c.url_list?.[0] })).filter(c => c.url),
        play_urls: v.play_addr?.url_list || [],
      };
    } catch { /* 换下一个 host */ }
  }
  return null;
}

// 有原生字幕就直接下真字幕：WebVTT → 纯文本（去时间轴、序号、重复行）
export async function fetchNativeCaptions(meta) {
  const cap = meta.captions.find(c => /^(zh|cmn)/i.test(c.lang || '')) || meta.captions[0];
  if (!cap) return null;
  const r = await fetch(cap.url.replace(/^http:/, 'https:'), { headers: { 'user-agent': UA } });
  if (!r.ok) return null;
  const lines = [];
  for (const raw of (await r.text()).split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || l === 'WEBVTT' || /^\d+$/.test(l) || l.includes('-->') || /^(NOTE|STYLE|Kind:|Language:)/.test(l)) continue;
    if (lines[lines.length - 1] !== l) lines.push(l);
  }
  return lines.join('\n');
}

// 字数 / 时长 → 完整度判断。中文口播正常 220-350 字/分钟；BGM、停顿多的视频会偏低，所以只是提示不是判决
export function density(text, durationS) {
  const n = String(text).replace(/\s/g, '').length;
  if (!durationS) return { chars: n, perMin: null, verdict: '无时长，无法判断' };
  const perMin = Math.round(n / (durationS / 60));
  const verdict = perMin < 200 ? '偏低：可能缺段（或视频里停顿/BGM 多），重点抽查后半段'
    : perMin > 420 ? '偏高：可能混进了视频以外的内容，重点查有没有编'
    : '正常';
  return { chars: n, perMin, verdict };
}

// ---- CLI ----
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const dl = args.includes('--download');
  const aid = await resolveAwemeId(args.filter(a => a !== '--download').join(' '));
  if (!aid) { console.error('用法: node video_meta.mjs <视频URL/短链/分享文本/ID> [--download]'); process.exit(1); }
  const meta = await fetchMeta(aid);
  if (!meta) { console.error('Feed 没匹配到这条作品（删除/私密/图文，或接口变了）'); process.exit(1); }
  console.log(JSON.stringify({ ...meta, play_urls: meta.play_urls.length + ' 个' }, null, 2));
  if (dl) {
    const P = paths(aid, meta);
    ensureDir(P.dir);
    for (const u of meta.play_urls) {
      const r = await fetch(u, { headers: { 'user-agent': UA } }).catch(() => null);
      if (!r?.ok) continue;
      fs.writeFileSync(P.video, Buffer.from(await r.arrayBuffer()));
      console.log(`已下载 video_${aid}.mp4（${(fs.statSync(P.video).size / 1048576).toFixed(1)} MB）→ ${P.dir}`);
      break;
    }
  }
}
