#!/usr/bin/env node
// providers.mjs —— 两个搜索引擎的实现，统一成同一个返回结构
//
// 返回统一结构（数组）：
//   { title, url, snippet, content?, site?, date?, score? }
//
// 两个后端的差异都收在这个文件里，search.mjs 只管调度和排版。

import { getKey } from './keys.mjs';

// ---------- DeepSeek ----------
// REST JSON，Bearer 鉴权。文档 https://api-docs.deepseek.com/zh-cn/api/search.md
// 计费：5 元 / 1000 次成功请求；只有 HTTP 200 且有结果才计费。

const DS_BASE = 'https://api.deepseek.com';

async function dsCall(pathname, body, key) {
  const r = await fetch(DS_BASE + pathname, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!r.ok) {
    const msg = data?.error?.message || text.slice(0, 300);
    throw new Error(`DeepSeek HTTP ${r.status}: ${msg}`);
  }
  return data;
}

export async function deepseekSearch(query, opts = {}) {
  const key = getKey('deepseek');
  if (!key) throw new Error('NO_KEY:deepseek');
  const body = {
    query,
    count: Math.max(1, Math.min(50, opts.count ?? 10)),
    need_content: !!opts.content,
  };
  // ori_question 是触发搜索的用户原话，帮助检索服务理解意图；没有就省略
  if (opts.oriQuestion) body.ori_question = opts.oriQuestion;
  if (opts.localization) body.localization = opts.localization;

  const data = await dsCall('/v1/tools/search', body, key);
  return (data.results || []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.snippet || r.summary || '',
    content: r.content || undefined,
    site: r.site_name || undefined,
    date: r.date ? String(r.date).slice(0, 10) : undefined,
    score: r.rerank_score,
    authority: r.authority,
  }));
}

export async function deepseekFetch(url) {
  const key = getKey('deepseek');
  if (!key) throw new Error('NO_KEY:deepseek');
  const page = await dsCall('/v1/tools/fetch', { url }, key);
  return { title: page.title || '(untitled)', content: page.content || '' };
}

// ---------- GLM ----------
// MCP over Streamable HTTP，两步握手。端点固定，工具名 web_search_prime（下划线）。
// 坑都在这个函数里消化掉了：
//   - session id 在响应头 mcp-session-id，不在 body
//   - 响应是 SSE，真正的 JSON 在 data: 行，要跳过 id:/event:
//   - result.content[0].text 是双层 JSON 编码，要解析两次

const GLM_URL = 'https://open.bigmodel.cn/api/mcp/web_search_prime/mcp';

function parseSSE(text) {
  const dataLines = text
    .split(/\r?\n/)
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim());
  if (!dataLines.length) throw new Error('GLM 响应里没有 data: 行:\n' + text.slice(0, 500));
  // 可能有多个 data 事件，从后往前找第一个带 result 或 error 的
  for (let i = dataLines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(dataLines[i]);
      if (obj.result || obj.error) return obj;
    } catch { /* 不是 JSON 的行，跳过 */ }
  }
  throw new Error('GLM 的 data: 行都不是合法 JSON');
}

// GLM 会把一部分结果包成 Google 跳转链接（https://www.google.com/goto?url=...），
// 那不是真实地址，对用户没用。识别出来标成 null，排版时不展示。
function cleanGlmUrl(u) {
  if (!u) return null;
  if (/^https?:\/\/www\.google\.com\/goto\?url=/.test(u)) return null;
  if (/^https?:\/\/www\.googleadservices\.com\//.test(u)) return null;
  return u;
}

// 已知：search_domain_filter 在本账号上不生效。
// 2026-11-06 实测，传一个绝对不存在的域名（this-domain-does-not-exist-xyzq.com）
// 仍然返回 10 条不相关的全局结果，说明服务端没执行这个筛选。
// 参数名是对的（tools/list 里就有），所以不是我们传错。
// 保留这个参数（也许以后会生效），但必须在返回后自己按 host 过滤一遍。
//
// 本地过滤有天然局限：GLM 一次只给约 10 条全局结果，限定站点后经常剩 0–1 条。
// 所以站点搜索要优先建议用户改用 DeepSeek 的 `site:` 语法（服务端执行，准确得多）。
export const GLM_DOMAIN_FILTER_WORKS = false;

function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; }
}

function matchHost(host, want) {
  if (!host) return false;
  const w = want.replace(/^www\./, '').toLowerCase();
  const h = host.toLowerCase();
  // 用户写 example.com，子域 a.example.com 也算命中
  return h === w || h.endsWith('.' + w);
}

export async function glmSearch(query, opts = {}) {
  const key = getKey('glm');
  if (!key) throw new Error('NO_KEY:glm');

  const head = {
    Authorization: 'Bearer ' + key,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };

  // 第一步：initialize，session id 从响应头拿
  const initRes = await fetch(GLM_URL, {
    method: 'POST',
    headers: head,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'web-search-skill', version: '1.0' },
      },
    }),
  });
  if (!initRes.ok) throw new Error(`GLM initialize 失败: HTTP ${initRes.status}`);
  const sid = initRes.headers.get('mcp-session-id');
  if (!sid) throw new Error('GLM 没返回 mcp-session-id 响应头');
  await initRes.text();

  // 第二步：tools/call
  const args = { search_query: query, location: opts.location || 'cn' };
  if (opts.recency) args.search_recency_filter = opts.recency;
  if (opts.domain) args.search_domain_filter = opts.domain;

  const res = await fetch(GLM_URL, {
    method: 'POST',
    headers: { ...head, 'Mcp-Session-Id': sid },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'web_search_prime', arguments: args },
    }),
  });
  if (!res.ok) throw new Error(`GLM tools/call 失败: HTTP ${res.status}`);

  const obj = parseSSE(await res.text());
  if (obj.error) throw new Error('GLM RPC 错误: ' + JSON.stringify(obj.error));
  const result = obj.result || {};
  if (result.isError) throw new Error('GLM 工具错误: ' + (result.content?.[0]?.text ?? 'unknown'));

  const text = result.content?.[0]?.text;
  if (!text) throw new Error('GLM 返回结构异常: 没有 content[0].text');

  let decoded = JSON.parse(text);
  if (typeof decoded === 'string') decoded = JSON.parse(decoded);
  if (!Array.isArray(decoded)) throw new Error('GLM 解码后不是数组');

  let items = decoded.map((it) => ({
    title: it.title,
    url: cleanGlmUrl(it.link),
    snippet: (it.content || '').replace(/\s+/g, ' ').trim(),
    content: undefined,
    site: undefined,
    date: undefined,
    score: undefined,
  }));

  // 服务端不执行域名筛选（见文件上方 GLM_DOMAIN_FILTER_WORKS 的说明），
  // 所以在这里补一道本地过滤。url 为 null 的（Google 跳转）无法判断域名，直接剔除。
  if (opts.domain) {
    const before = items.length;
    items = items.filter((it) => matchHost(hostOf(it.url), opts.domain));
    if (items.length === 0) {
      throw new Error(
        `本地过滤后 ${opts.domain} 站内一条不剩（GLM 服务端忽略了域名筛选，只给了 ${before} 条全局结果）。\n` +
        `站点搜索请改用 DeepSeek：search.mjs "${query} site:${opts.domain}"`
      );
    }
  }

  return items;
}

// GLM 的 web_search_prime 没有条数参数（tools/list 里只有 search_query /
// search_domain_filter / search_recency_filter / content_size / location），
// 一次固定返回它认为相关的全部结果。search.mjs 会在 -n 小于实际条数时提示用户。
export const GLM_SUPPORTS_COUNT = false;

export const BACKENDS = {
  deepseek: { search: deepseekSearch, label: 'DeepSeek', supportsCount: true },
  glm: { search: glmSearch, label: 'GLM', supportsCount: false },
};
