// panel_extract.mjs —— 浏览器面板版（备用路径）：在后台面板页里发问。主路径是 api_extract.mjs
// 用法: node panel_extract.mjs <视频URL/短链/分享文本/aweme_id>
// 依次执行：视频总结（绑定 + 验收依据）→ @extract 提取 → read_answer 读出
// 输出(当前目录): summary_<ID>.txt  subtitles_<ID>.txt  panel_tail_<ID>.txt

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveAwemeId } from './resolve_id.mjs';

const here = (f) => fileURLToPath(new URL(f, import.meta.url));
const AID = await resolveAwemeId(process.argv.slice(2).join(' '));
if (!AID) { console.error('无法解析 aweme_id，用法: node panel_extract.mjs <视频URL/短链/分享文本/ID>'); process.exit(1); }

// 子进程不继承 DEEP：深度思考在独立面板页会丢视频上下文
const env = { ...process.env }; delete env.DEEP;
const run = (script, ...args) => execFileSync(process.execPath, [here(script), ...args], { stdio: 'inherit', env });

console.log(`== 1/3 视频总结 (${AID})`);
run('./douyin_ask.mjs', AID, '视频总结');
fs.copyFileSync(`panel_tail_${AID}.txt`, `summary_${AID}.txt`);

console.log('== 2/3 提取字幕');
run('./douyin_ask.mjs', AID, '@extract');

console.log('== 3/3 读出正文');
run('./read_answer.mjs', AID);
console.log(`\n验收依据: summary_${AID}.txt（拿它和 subtitles_${AID}.txt 对照抽查）`);
