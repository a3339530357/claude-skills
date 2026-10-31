// outdir.mjs —— 输出布局（douyin-subtitle skill）
//
// 约定（2026-11-01 定）：
//   输出根目录（二级）       <标题>_<ID>.md          ← 完整字幕，markdown，一眼能读
//   同名三级子目录           <标题>_<ID>/            ← 其余全部散件
//                              meta_<ID>.json
//                              summary_<ID>.txt
//                              session_<ID>.json
//                              subtitles_<ID>.txt
//                              followup_<ID>[-N].txt
//                              video_<ID>.mp4
//
// 根目录默认 D:\project\tests\douyin-subs，可用环境变量 DOUYIN_OUT_DIR 覆盖。
// 目录名带 ID 前缀的唯一目的：同名视频不互相覆盖，且按 ID 排序即时间序。

import fs from 'node:fs';
import path from 'node:path';

export const OUT_ROOT = process.env.DOUYIN_OUT_DIR || 'D:\\project\\tests\\douyin-subs';

const BAD = /[\\/:*?"<>|\u0000-\u001f]/g;

// Windows 文件名清洗：非法字符→_、去结尾的点/空格（Windows 会静默吞掉）、限长
export function safeName(s, max = 60) {
  let t = String(s || '').replace(BAD, '_').replace(/\s+/g, ' ').trim();
  t = t.replace(/[. ]+$/, '');
  if (t.length > max) t = t.slice(0, max).trim().replace(/[. ]+$/, '');
  return t;
}

// 一次算清所有路径；meta 还没取到时也能用（走 ID）
export function paths(aid, meta) {
  const title = safeName(meta?.title);
  const base = title ? `${title}_${aid}` : aid;
  const dir = path.join(OUT_ROOT, base);
  const f = (name) => path.join(dir, name);
  return {
    base,
    dir,
    md: path.join(OUT_ROOT, `${base}.md`),   // 二级：完整字幕
    meta: f(`meta_${aid}.json`),             // 以下三级
    summary: f(`summary_${aid}.txt`),
    session: f(`session_${aid}.json`),
    subs: f(`subtitles_${aid}.txt`),
    video: f(`video_${aid}.mp4`),
    followup: (n = 1) => f(n > 1 ? `followup_${aid}_${n}.txt` : `followup_${aid}.txt`),
  };
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 只凭 ID 找回已有目录（追问时还不知道标题，标题在 meta 里、meta 在目录里）
// 目录名形如 `<标题>_<ID>`，也可能是不带标题的纯 `<ID>`
export function findDir(aid) {
  if (!fs.existsSync(OUT_ROOT)) return null;
  for (const e of fs.readdirSync(OUT_ROOT, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    if (e.name === aid || e.name.endsWith(`_${aid}`)) return path.join(OUT_ROOT, e.name);
  }
  return null;
}

// 把 subtitles_<ID>.txt 渲染成 markdown 放到二级目录
// 正文按原样保留段落（txt 里用空行分段），只加一层头部元信息
export function writeMarkdown(aid, meta, extra = {}) {
  const p = paths(aid, meta);
  if (!fs.existsSync(p.subs)) return null;
  const body = fs.readFileSync(p.subs, 'utf8').trim();
  if (!body) return null;

  const dur = meta?.duration_s;
  const rows = [
    meta?.author ? `- 作者：${meta.author}` : null,
    dur ? `- 时长：${Math.floor(dur / 60)}分${String(Math.round(dur % 60)).padStart(2, '0')}秒（${dur}s）` : null,
    `- 字数：${body.replace(/\s/g, '').length}`,
    extra.perMin != null ? `- 完整度：${extra.perMin} 字/分钟` : null,
    extra.source ? `- 来源：${extra.source}` : null,
    `- 视频：https://www.douyin.com/video/${aid}`,
    `- 提取：${new Date().toISOString().slice(0, 10)}`,
  ].filter(Boolean);

  const md = `# ${meta?.title || aid}\n\n${rows.join('\n')}\n\n---\n\n${body}\n`;
  fs.mkdirSync(OUT_ROOT, { recursive: true });
  fs.writeFileSync(p.md, md, 'utf8');
  return p.md;
}
