#!/usr/bin/env node
/**
 * 抓取指定日期的 ChatGPT 会话正文,写成 JSON。
 *
 * 安全约定:accessToken 等同于账号密码(ChatGPT 自己在响应里用全大写横幅警告过)。
 * 因此取 token 和调用 backend-api 全在页面上下文内完成,token 绝不跨进程传出、
 * 不写日志、不落盘。本进程只拿到业务数据。
 *
 * 处理三件麻烦事:
 *   1. 旧会话续聊 —— 会话整体落在今天,内部可能只有几条消息是今天的,逐条按
 *      message.create_time 过滤
 *   2. 消息树分支 —— regenerate 会生成兄弟节点,只沿 current_node 回溯主干,
 *      避免把废弃分支计入
 *   3. 隐藏节点 —— system 消息、推理草稿、is_visually_hidden 一律剔除
 *
 * 用法: node.exe fetch.js <YYYY-MM-DD> <输出JSON路径>
 * 退出码: 0 成功 / 2 未登录或登录态失效 / 3 浏览器不可达 / 1 其它
 */
const fs = require('fs');
const path = require('path');
const { evalInChatGPT } = require('./cdp.js');

const dateArg = process.argv[2] || new Date().toLocaleDateString('sv-SE');
const outPath = process.argv[3];
if (!/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
  console.error('日期格式应为 YYYY-MM-DD');
  process.exit(1);
}
const dayStart = new Date(`${dateArg}T00:00:00`).getTime() / 1000;

const EXPR = `(async () => {
  const DAY_START = ${dayStart}, DAY_END = ${dayStart + 86400};

  const sess = await (await fetch('/api/auth/session', { credentials: 'include' })).json().catch(() => ({}));
  const token = sess && sess.accessToken;
  if (!token) return JSON.stringify({ error: 'NOT_LOGGED_IN' });

  const api = async (p) => {
    const r = await fetch(p, {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      credentials: 'include',
    });
    if (r.status === 401 || r.status === 403) throw new Error('AUTH_EXPIRED');
    if (!r.ok) throw new Error(p + ' -> HTTP ' + r.status);
    return r.json();
  };
  const secs = (s) =>
    typeof s === 'number' ? s : s ? new Date(String(s).endsWith('Z') ? s : s + 'Z').getTime() / 1000 : 0;

  // ---- 1. 列出当日有活动的会话 ----
  const cands = [];
  try {
    for (let page = 0; page < 15; page++) {
      const d = await api('/backend-api/conversations?offset=' + page * 100 + '&limit=100&order=updated');
      if (!d.items || !d.items.length) break;
      for (const c of d.items) {
        const u = secs(c.update_time), cr = secs(c.create_time);
        if ((u >= DAY_START && u < DAY_END) || (cr >= DAY_START && cr < DAY_END)) cands.push(c);
      }
      // 列表按 update_time 倒序,翻过目标日起点即可收手
      if (secs(d.items[d.items.length - 1].update_time) < DAY_START) break;
    }
  } catch (e) {
    if (e.message === 'AUTH_EXPIRED') return JSON.stringify({ error: 'AUTH_EXPIRED' });
    throw e;
  }

  // ---- 2. 逐个抓正文 ----
  const results = [];
  for (const c of cands) {
    let detail;
    try {
      detail = await api('/backend-api/conversation/' + c.id);
    } catch (e) {
      results.push({ id: c.id, title: c.title, error: String(e.message) });
      continue;
    }

    const map = detail.mapping || {};
    const chain = [];
    const guard = new Set();
    for (let n = map[detail.current_node]; n && !guard.has(n.id); n = n.parent ? map[n.parent] : null) {
      guard.add(n.id);
      chain.unshift(n);
    }

    const msgs = [];
    for (const node of chain) {
      const m = node.message;
      if (!m) continue;
      const role = m.author && m.author.role;
      if (role !== 'user' && role !== 'assistant') continue;
      if (m.metadata && m.metadata.is_visually_hidden_from_conversation) continue;

      const ct = m.content || {};
      let text = '';
      if (ct.content_type === 'text') text = (ct.parts || []).join('\\n');
      else if (ct.content_type === 'multimodal_text')
        text = (ct.parts || [])
          .map((p) => (typeof p === 'string' ? p : '[' + ((p && p.content_type) || 'asset') + ']'))
          .join('\\n');
      else if (ct.content_type === 'code') text = '\`\`\`\\n' + (ct.text || '') + '\\n\`\`\`';
      else if (ct.content_type === 'thoughts' || ct.content_type === 'reasoning_recap') continue;
      else text = ct.text || '';
      if (!text || !text.trim()) continue;

      msgs.push({
        role,
        t: m.create_time || 0,
        text,
        model: (m.metadata || {}).model_slug || null,
      });
    }

    const todays = msgs.filter((m) => m.t >= DAY_START && m.t < DAY_END);
    if (!todays.length) continue;
    results.push({
      id: c.id,
      title: c.title,
      create_time: secs(c.create_time),
      update_time: secs(c.update_time),
      msg_total: msgs.length,
      msg_today: todays.length,
      is_carryover: secs(c.create_time) < DAY_START,
      messages: todays,
    });
  }

  return JSON.stringify({
    account: (sess.user && (sess.user.name || sess.user.email)) || null,
    date: '${dateArg}',
    conversations: results,
  });
})()`;

(async () => {
  let raw;
  try {
    raw = await evalInChatGPT(EXPR, { timeout: 300000 });
  } catch (e) {
    const unreachable = /连不上调试端口|没有打开 chatgpt/.test(e.message);
    console.error(JSON.stringify({ ok: false, reason: unreachable ? 'BROWSER_UNREACHABLE' : 'CDP_FAILED', detail: e.message }));
    process.exit(unreachable ? 3 : 1);
  }

  let d;
  try {
    d = JSON.parse(raw);
  } catch {
    console.error(JSON.stringify({ ok: false, reason: 'BAD_PAYLOAD' }));
    process.exit(1);
  }

  if (d.error) {
    console.error(JSON.stringify({ ok: false, reason: d.error }));
    process.exit(2);
  }

  const convs = d.conversations || [];
  const chars = convs.reduce((s, c) => s + c.messages.reduce((a, m) => a + m.text.length, 0), 0);

  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(d, null, 2), 'utf8');
  }
  console.log(JSON.stringify({
    ok: true,
    account: d.account,
    date: d.date,
    conversations: convs.length,
    messages: convs.reduce((s, c) => s + c.msg_today, 0),
    chars,
    out: outPath || null,
  }));
})();
