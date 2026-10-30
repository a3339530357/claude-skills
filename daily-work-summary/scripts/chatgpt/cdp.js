#!/usr/bin/env node
/**
 * 极简 CDP 客户端 —— 必须由 **Windows 侧的 node.exe** 执行。
 *
 * 为什么不能在 WSL 里跑:Chrome 150 已忽略 --remote-debugging-address,调试端口
 * 死绑 127.0.0.1。WSL 是 NAT 网络,跨不到 Windows 的回环地址。让 Windows 的 node
 * 去连 Windows 的 localhost,是唯一不需要管理员权限、不改防火墙的路子。
 *
 * 依赖:Node 22+ 的内置全局 WebSocket(无需 npm install)。
 */

const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:9222';

async function listTargets() {
  const res = await fetch(`${CDP_HTTP}/json/list`);
  if (!res.ok) throw new Error(`CDP /json/list -> HTTP ${res.status}`);
  return res.json();
}

/** 定位 ChatGPT 标签页 */
async function findChatGPTTarget() {
  let targets;
  try {
    targets = await listTargets();
  } catch (e) {
    throw new Error(
      `连不上调试端口 ${CDP_HTTP} —— 浏览器可能没在跑。原始错误: ${e.message}`
    );
  }
  const page = targets.find((t) => {
    if (t.type !== 'page') return false;
    try {
      return /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/.test(new URL(t.url).hostname);
    } catch {
      return false;
    }
  });
  if (!page) throw new Error('浏览器里没有打开 chatgpt.com 的标签页');
  return page;
}

/** 在页面上下文求值;表达式返回 Promise 时会等它 settle */
function evaluate(wsUrl, expression, { timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`CDP 求值超时(${timeout}ms)`));
    }, timeout);
    const settle = (fn, arg) => {
      clearTimeout(timer);
      try { ws.close(); } catch {}
      fn(arg);
    };

    ws.onerror = (e) => settle(reject, new Error('WebSocket 错误: ' + (e.message || e.type)));
    ws.onopen = () =>
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }));
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id !== 1) return;
      if (msg.error) return settle(reject, new Error('CDP: ' + JSON.stringify(msg.error)));
      const r = msg.result || {};
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        return settle(reject, new Error('页面内异常: ' + (d.exception?.description || d.text)));
      }
      settle(resolve, r.result?.value);
    };
  });
}

async function evalInChatGPT(expression, opts) {
  const page = await findChatGPTTarget();
  return evaluate(page.webSocketDebuggerUrl, expression, opts);
}

module.exports = { CDP_HTTP, listTargets, findChatGPTTarget, evaluate, evalInChatGPT };
