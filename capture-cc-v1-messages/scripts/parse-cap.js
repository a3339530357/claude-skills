// 用法: node parse-cap.js <logfile> <lines_before> <label>
const fs = require('fs');
const [,, logFile, lb, label] = process.argv;
const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).slice(+lb);
const recs = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  .filter(r => r.url && r.url.includes('open.bigmodel.cn') && r.url.includes('/v1/messages') && r.method === 'POST');
recs.sort((a, b) => (b.request?.body?.length || 0) - (a.request?.body?.length || 0));
if (!recs.length) { console.log(`${label}: NO CAPTURE`); process.exit(0); }
const r = recs[0];
let b; try { b = JSON.parse(r.request.body); } catch { console.log(`${label}: body parse fail`); process.exit(0); }
const rb = r.response?.body || '';
const m = rb.match(/"input_tokens"\s*:\s*(\d+)/);
const names = (b.tools || []).map(t => t.name);
const mcp = names.filter(n => n.startsWith('mcp__')).length;
const len = s => Buffer.byteLength(typeof s === 'string' ? s : JSON.stringify(s), 'utf8');
console.log(`${label}:`);
console.log(`   tools=${names.length} (MCP:${mcp}) Workflow?=${names.includes('Workflow')}`);
console.log(`   tools定义=${len(b.tools)}字节  system=${len(b.system)}字节  messages=${len(b.messages)}字节`);
console.log(`   请求体总=${len(r.request.body)}字节`);
console.log(`   真实 input_tokens=${m ? m[1] : '未取到(看响应格式)'}`);
