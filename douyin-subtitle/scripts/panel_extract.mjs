// panel_extract.mjs —— 浏览器面板版（备用路径）：在后台面板页里发问。主路径是 api_extract.mjs
// 用法: node panel_extract.mjs <视频URL/短链/分享文本/aweme_id>
// 依次执行：视频总结（绑定 + 验收依据）→ @extract 提取 → read_answer 读出
// 输出布局同主路径（见 outdir.mjs）:
//   <OUT_ROOT>/<标题>_<ID>.md          完整字幕
//   <OUT_ROOT>/<标题>_<ID>/            summary/subtitles/panel_tail/detail

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveAwemeId } from './resolve_id.mjs';
import { fetchMeta } from './video_meta.mjs';
import { paths, ensureDir } from './outdir.mjs';

const here = (f) => fileURLToPath(new URL(f, import.meta.url));
const AID = await resolveAwemeId(process.argv.slice(2).join(' '));
if (!AID) { console.error('无法解析 aweme_id，用法: node panel_extract.mjs <视频URL/短链/分享文本/ID>'); process.exit(1); }

// 子进程不继承 DEEP：深度思考在独立面板页会丢视频上下文
const env = { ...process.env }; delete env.DEEP;
const run = (script, ...args) => execFileSync(process.execPath, [here(script), ...args], { stdio: 'inherit', env });

// 先拿元数据定目录名（douyin_ask 的子进程仍写当前目录，跑完再搬进去）
const meta = await fetchMeta(AID).catch(() => null);
const P = paths(AID, meta);
ensureDir(P.dir);
const move = (from, to) => { if (fs.existsSync(from)) { fs.renameSync(from, to); return true; } return false; };

console.log(`== 1/3 视频总结 (${AID})`);
run('./douyin_ask.mjs', AID, '视频总结');
move(`panel_tail_${AID}.txt`, P.summary);
move(`detail_${AID}.json`, P.meta);

console.log('== 2/3 提取字幕');
run('./douyin_ask.mjs', AID, '@extract');

console.log('== 3/3 读出正文');
run('./read_answer.mjs', AID);
move(`panel_tail_${AID}.txt`, P.followup(1));
if (meta) fs.writeFileSync(P.meta, JSON.stringify(meta, null, 2), 'utf-8');

console.log(`\n验收依据: ${P.summary}（拿它和 ${P.subs} 对照抽查）`);
if (fs.existsSync(P.md)) console.log(`markdown → ${P.md}`);
