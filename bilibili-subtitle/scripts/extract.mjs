// extract.mjs —— B 站视频字幕 + 官方 AI 总结（bilibili-subtitle skill 主路径）
//
// 用法:
//   node extract.mjs <BV号/av号/视频链接/b23.tv短链/分享文本>          # 链接带 ?p=N 就只取那一 P
//   node extract.mjs <...> --p 3          # 指定分 P
//   node extract.mjs <...> --p all        # 合集全部分 P（默认：单 P 直接取；多 P 且没指定时只取 P1 并列出目录）
// 输出(当前目录): subtitles_<BV>[_pN].txt（纯文本） .srt（带时间轴）  summary_<BV>[_pN].txt（官方 AI 总结）  meta_<BV>.json
//
// 字幕由 yt-dlp 拉（它已实现 /x/player/wbi/v2 字幕轨解析）；本脚本负责 Cookie、选分 P、选字幕轨、转纯文本、官方 AI 总结。
// 字幕轨优先级：UP 主上传的中文 > B 站 AI 中文（ai-zh）> 其他 AI 轨 > 其他。
// Cookie: 由 cookie.mjs 管理（BILI_COOKIE > <skill目录>/data/cookie.json > 缺失/过期时借 CDP 从 Chrome 读一次并写回）；不打印。
// 给 yt-dlp 的 Netscape 格式 Cookie 文件临时写在 data/ 下，跑完立即删除。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getBiliCookie, LOGIN_HINT } from './cookie.mjs';
import { resolveVideo, fetchView, fetchConclusion, isLoggedIn, srtToText, density } from './bili.mjs';

const args = process.argv.slice(2);
const pi = args.indexOf('--p');
const pArg = pi >= 0 ? args.splice(pi, 2)[1] : null;
const target = await resolveVideo(args.join(' '));
if (!target) { console.error('用法: node extract.mjs <BV号/av号/视频链接/b23.tv短链/分享文本> [--p N|all]'); process.exit(1); }

const LANG_RANK = (lang) => /^zh(-Hans|-CN)?$/i.test(lang) ? 0 : /^zh/i.test(lang) ? 1 : lang === 'ai-zh' ? 2 : /^ai-/.test(lang) ? 3 : 4;
const COOKIE_TMP = fileURLToPath(new URL('../data/ytdlp_cookies.txt', import.meta.url));

function writeNetscape(jar, cookie) {
  const rows = jar || cookie.split(/;\s*/).filter(Boolean).map(kv => {
    const i = kv.indexOf('=');
    return { name: kv.slice(0, i), value: kv.slice(i + 1), domain: '.bilibili.com', path: '/', secure: false, expires: 0 };
  });
  const lines = rows.map(c => [c.domain, c.domain.startsWith('.') ? 'TRUE' : 'FALSE', c.path || '/', c.secure ? 'TRUE' : 'FALSE',
    Math.max(0, Math.floor(c.expires || 0)), c.name, c.value].join('\t'));
  fs.writeFileSync(COOKIE_TMP, ['# Netscape HTTP Cookie File', ...lines].join('\n') + '\n', { mode: 0o600 });
}

try {
  const t0 = Date.now();
  const sec = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
  const { cookie, jar } = await getBiliCookie();
  if (!(await isLoggedIn(cookie))) throw new Error(`Cookie 不是登录态，字幕接口只认登录——${LOGIN_HINT}`);

  const view = await fetchView(cookie, target);
  fs.writeFileSync(`meta_${view.bvid}.json`, JSON.stringify(view, null, 2), 'utf-8');
  const multi = view.pages.length > 1;
  console.log(`${view.bvid}  ${view.owner}「${view.title}」 ${view.duration_s}s  共 ${view.pages.length} P`);

  // 选分 P
  let pages;
  const want = pArg ?? (target.p ? String(target.p) : null);
  if (want === 'all') pages = view.pages;
  else if (want) {
    pages = view.pages.filter(x => x.page === Number(want));
    if (!pages.length) throw new Error(`没有 P${want}（共 ${view.pages.length} P）`);
  } else {
    pages = view.pages.slice(0, 1);
    if (multi) {
      console.log(`多 P 视频，没指定分 P，先只取 P1。目录：`);
      for (const x of view.pages.slice(0, 30)) console.log(`  P${x.page}  ${x.part}  (${x.duration_s}s)`);
      if (view.pages.length > 30) console.log(`  ……共 ${view.pages.length} P`);
      console.log('要别的加 --p N，要全部加 --p all');
    }
  }

  // yt-dlp 拉字幕（只拉选中的分 P；--sub-langs all 再由本脚本挑轨，弹幕排除）
  const work = path.resolve(`_ytdlp_${view.bvid}`);
  fs.rmSync(work, { recursive: true, force: true });
  writeNetscape(jar, cookie);
  let res;
  try {
    const ytArgs = ['--cookies', COOKIE_TMP, '--skip-download', '--write-subs', '--sub-langs', 'all,-danmaku', '--sub-format', 'srt/best',
      '--no-warnings', '-P', work, '-o', '%(id)s.%(ext)s', `https://www.bilibili.com/video/${view.bvid}`];
    if (multi) ytArgs.unshift('--playlist-items', pages.map(x => x.page).join(','));
    res = spawnSync('yt-dlp', ytArgs, { encoding: 'utf8', windowsHide: true, timeout: 180000 });
  } finally { fs.rmSync(COOKIE_TMP, { force: true }); }
  if (res.error?.code === 'ENOENT') throw new Error('没装 yt-dlp：python -m pip install -U yt-dlp');
  if (res.status !== 0) throw new Error('yt-dlp 失败:\n' + (res.stderr || res.stdout).split('\n').slice(-8).join('\n'));
  const files = fs.existsSync(work) ? fs.readdirSync(work).filter(f => f.endsWith('.srt')) : [];
  console.log(`[1/2] yt-dlp 字幕 ${sec()}  拿到 ${files.length} 个字幕文件`);

  // 逐 P：挑字幕轨 → 纯文本；再取官方 AI 总结
  for (const pg of pages) {
    const id = multi ? `${view.bvid}_p${pg.page}` : view.bvid;
    const label = multi ? `P${pg.page}「${pg.part}」` : '';
    const tracks = files.filter(f => f.startsWith(id + '.'))
      .map(f => ({ f, lang: f.slice(id.length + 1, -4) }))
      .sort((a, b) => LANG_RANK(a.lang) - LANG_RANK(b.lang));

    if (tracks.length) {
      const best = tracks[0];
      const srt = fs.readFileSync(path.join(work, best.f), 'utf8');
      const text = srtToText(srt);
      fs.writeFileSync(`subtitles_${id}.srt`, srt, 'utf-8');
      fs.writeFileSync(`subtitles_${id}.txt`, text, 'utf-8');
      const d = density(text, pg.duration_s);
      const kind = best.lang.startsWith('ai-') ? 'B 站 AI 字幕' : 'UP 主上传字幕';
      console.log(`${label} 字幕轨 ${best.lang}（${kind}；可选: ${tracks.map(t => t.lang).join(', ')}） → subtitles_${id}.txt  ${d.chars} 字，${d.perMin ?? '?'} 字/分钟${d.note}`);
    } else {
      console.log(`${label} 没有字幕轨（UP 没传、B 站也没生成 AI 字幕）→ 只能本地转写，见 SKILL.md 兜底`);
    }

    const summary = await fetchConclusion(cookie, view, pg.cid).catch(e => { console.log(`  AI 总结请求失败: ${e.message}`); return null; });
    if (summary) {
      fs.writeFileSync(`summary_${id}.txt`, summary, 'utf-8');
      console.log(`  官方 AI 总结 → summary_${id}.txt（${summary.length} 字）`);
    } else console.log('  这条没有官方 AI 总结');
  }
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`[2/2] 完成 ${sec()}`);
} catch (e) {
  console.error('FAILED:', e.message);
  process.exit(1);
}
