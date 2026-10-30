// resolve_id.mjs —— 从各种输入里取抖音 aweme_id（douyin-subtitle skill）
// 支持：纯 ID / 含 modal_id、/video/、/note/ 的长链 / v.douyin.com 短链 / 整段分享文本

export async function resolveAwemeId(arg) {
  const s = String(arg || '');
  // 短链本身不含 ID，跟随 302 拿到 iesdouyin.com/share/video/<ID>
  const short = s.match(/https?:\/\/v\.douyin\.com\/[\w-]+\/?/);
  if (short) {
    const r = await fetch(short[0], { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' } });
    const m = (r.headers.get('location') || '').match(/\/(?:video|note)\/(\d{15,25})/);
    if (m) return m[1];
  }
  const m = s.match(/(?:modal_id=|\/video\/|\/note\/)(\d{15,25})/) || s.match(/(\d{15,25})/);
  return m ? m[1] : null;
}
