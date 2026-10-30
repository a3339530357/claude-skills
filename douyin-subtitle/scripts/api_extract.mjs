// api_extract.mjs —— 纯 API 提取抖音视频字幕（douyin-subtitle skill 主路径）
// 不开任何页面：Node 直接调问问AI 的 SSE 接口 /aweme/v2/search/ai/stream/，无需 a_bogus 签名，只要登录 Cookie。
//
// 用法:
//   node api_extract.mjs <视频URL/短链/分享文本/ID>              # 新会话：视频总结 → 提取 → 清理
//   node api_extract.mjs <ID> --followup "<追问>"                 # 接着上次的会话追问（如输出截断）
// 输出(当前目录): summary_<ID>.txt  subtitles_<ID>.txt  session_<ID>.json（会话 ID，供 --followup 用）
// Cookie: 由 cookie.mjs 管理（DOUYIN_COOKIE > <skill目录>/data/cookie.json > 缺失/过期时借 CDP 从 Chrome 读一次并写回）；不打印

import fs from 'node:fs';
import { resolveAwemeId } from './resolve_id.mjs';
import { cleanAnswer, stripLeadingDescription } from './clean.mjs';
import { fetchMeta, fetchNativeCaptions, density } from './video_meta.mjs';
import { getDouyinCookie, LOGIN_HINT } from './cookie.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

// ---- 发一问，读完整个 SSE 流 ----
// session 为空 = 新会话（视频绑定靠 ai_search_enter_from_group_id，新会话照样有）；
// 续接要带 conversation_id + pre_search_id + conversation_rank（取自上一轮响应）
async function ask(cookie, aid, keyword, session = {}) {
  const p = new URLSearchParams({
    count: '5', cursor: '0', token: 'search', ai_page_type: 'ai_chat', ai_search_enter_from_group_id: aid,
    search_channel: 'aweme_ai_chat', enable_ai_tab_new_framework: '1', need_integration_card: '1', ai_chat_message_use_lynx: '1',
    version_code: '32.1.0', enter_method: 'ai_input', enter_from: 'search_result', search_type: 'ai_chat_search', aid: '6383',
    keyword, search_source: 'ai_input', pc_ai_search_enable_rich_media: '0', pc_ai_search_enable_ruyi: '0',
    enable_ai_search_deep_think: '0',   // 深度思考读不到视频上下文，永远关
    conversation_id: session.conversation_id || '',
    ...(session.search_id ? { pre_search_id: session.search_id, conversation_rank: String(session.conversation_rank || 1) } : {}),
    client_server_extra: JSON.stringify({ ask_ai_client_config: JSON.stringify({ need_personal_summary: '' }) }),
  });
  const r = await fetch('https://so-landing.douyin.com/aweme/v2/search/ai/stream/?' + p,
    { headers: { cookie, referer: 'https://so-landing.douyin.com/search_ai_mobile/pc', 'user-agent': UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const raw = await r.text();
  // SSE 每行 data:<json>；正文是 data[].display.display.generation_spans[].text.content 的增量拼接
  let text = '', sess = {}, status = null;
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    let e; try { e = JSON.parse(line.slice(5)); } catch { continue; }
    if (e.status_code != null) status = e.status_code;
    if (e.conversation_id) sess = { conversation_id: e.conversation_id, conversation_rank: e.conversation_rank, search_id: e.search_id };
    for (const d of Array.isArray(e.data) ? e.data : [e.data])
      for (const s of d?.display?.display?.generation_spans || []) if (s.text?.content) text += s.text.content;
  }
  if (!text) throw new Error(`回答为空（status_code=${status}，${raw.length} 字节）——${LOGIN_HINT}；若登录态没问题，可能是接口变了，改走面板版 panel_extract.mjs`);
  return { text, sess };
}

// ---- main ----
const args = process.argv.slice(2);
const fi = args.indexOf('--followup');
const followup = fi >= 0 ? args.splice(fi, 2)[1] : null;
const AID = await resolveAwemeId(args.join(' '));
if (!AID) { console.error('用法: node api_extract.mjs <视频URL/短链/分享文本/ID> [--followup "<追问>"]'); process.exit(1); }

try {
  const cookie = await getDouyinCookie();
  const sessFile = `session_${AID}.json`;
  const t0 = Date.now();
  const sec = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';

  if (followup) {
    if (!fs.existsSync(sessFile)) throw new Error(`没有 ${sessFile}，先跑一次不带 --followup 的提取`);
    const r = await ask(cookie, AID, followup, JSON.parse(fs.readFileSync(sessFile, 'utf8')));
    fs.writeFileSync(sessFile, JSON.stringify(r.sess));
    const out = cleanAnswer(r.text, console.log);
    fs.writeFileSync(`followup_${AID}.txt`, out, 'utf-8');
    console.log(`追问完成 ${sec()} → followup_${AID}.txt\n${out}`);
  } else {
    // 0) 元数据（免签名免 Cookie）：时长用于完整度判断；有原生字幕就直接用真字幕，不必问 AI
    const meta = await fetchMeta(AID).catch(() => null);
    if (meta) {
      fs.writeFileSync(`meta_${AID}.json`, JSON.stringify(meta, null, 2), 'utf-8');
      console.log(`aweme_id=${AID}  ${meta.author}「${meta.title.slice(0, 30)}」 ${meta.duration_s}s  原生字幕 ${meta.captions.length} 条`);
      const native = meta.captions.length ? await fetchNativeCaptions(meta).catch(() => null) : null;
      if (native) {
        fs.writeFileSync(`subtitles_${AID}.txt`, native, 'utf-8');
        const d = density(native, meta.duration_s);
        console.log(`有平台原生字幕，已直接下载 → subtitles_${AID}.txt（${d.chars} 字，${d.perMin} 字/分钟）。这是真字幕，不需要 AI 提取`);
        process.exit(0);
      }
    } else console.log(`aweme_id=${AID}  （元数据没取到，跳过完整度判断）`);

    console.log('新会话');
    const s1 = await ask(cookie, AID, '视频总结');
    fs.writeFileSync(`summary_${AID}.txt`, cleanAnswer(s1.text), 'utf-8');
    console.log(`[1/2] 视频总结 ${sec()}  conv=${s1.sess.conversation_id}`);
    const prompt = fs.readFileSync(new URL('./extract_prompt.txt', import.meta.url), 'utf8').trim();
    const s2 = await ask(cookie, AID, prompt, s1.sess);
    fs.writeFileSync(sessFile, JSON.stringify(s2.sess));
    let subs = cleanAnswer(s2.text, console.log);
    if (meta) subs = stripLeadingDescription(subs, meta.title, console.log);
    fs.writeFileSync(`subtitles_${AID}.txt`, subs, 'utf-8');
    console.log(`[2/2] 提取 ${sec()}  ${subs.length} 字 → subtitles_${AID}.txt（验收依据 summary_${AID}.txt）`);
    if (meta) { const d = density(subs, meta.duration_s); console.log(`完整度: ${d.chars} 字 / ${meta.duration_s}s = ${d.perMin} 字/分钟 → ${d.verdict}`); }
    console.log('---- 前 300 字 ----\n' + subs.slice(0, 300) + '\n---- 末 150 字 ----\n' + subs.slice(-150));
  }
} catch (e) {
  console.error('FAILED:', e.message);
  process.exit(1);
}
