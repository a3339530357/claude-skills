// 深度拆解一条 /v1/messages 请求体的 token 构成
// 用法: node deep-breakdown.js <logfile>
const fs = require('fs');
const lines = fs.readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean);
const recs = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  .filter(r => r.url && r.url.includes('open.bigmodel.cn') && r.url.includes('/v1/messages') && r.method === 'POST');
recs.sort((a, b) => (b.request?.body?.length || 0) - (a.request?.body?.length || 0));
if (!recs.length) { console.log('no glm capture'); process.exit(1); }
const b = JSON.parse(recs[0].request.body);
const len = s => Buffer.byteLength(typeof s === 'string' ? s : JSON.stringify(s), 'utf8');
const tk = bytes => '~' + Math.round(bytes / 3.1) + 'tok';

console.log('请求体总:', len(b), '字节', tk(len(b)), '\n');

// ---------- SYSTEM ----------
const sysArr = Array.isArray(b.system) ? b.system : [b.system];
console.log('【SYSTEM 系统提示词正文】', len(b.system), '字节', tk(len(b.system)));
sysArr.forEach((x, i) => {
  const t = typeof x === 'string' ? x : (x.text || '');
  console.log(`   block#${i}: ${len(t)} 字节 ${t.slice(0, 50).replace(/\n/g, ' ')}...`);
});

// ---------- TOOLS ----------
console.log('\n【TOOLS 工具定义】', len(b.tools), '字节', tk(len(b.tools)));
const tools = (b.tools || []).slice().sort((a, c) => len(c) - len(a));
const mcp = tools.filter(t => t.name.startsWith('mcp__'));
const builtin = tools.filter(t => !t.name.startsWith('mcp__'));
console.log(`   内置 ${builtin.length} 个: ${len(builtin)} 字节   MCP ${mcp.length} 个: ${len(mcp)} 字节`);
console.log('   Top 工具:');
tools.slice(0, 8).forEach(t => console.log(`     ${t.name.padEnd(22)} ${len(t)} 字节`));

// ---------- MESSAGES ----------
console.log('\n【MESSAGES 对话+注入】', len(b.messages), '字节', tk(len(b.messages)));
const seen = [];
(b.messages || []).forEach((m, i) => {
  const c = m.content;
  let txt;
  if (typeof c === 'string') txt = c;
  else if (Array.isArray(c)) txt = c.map(p => typeof p === 'string' ? p : (p.text || JSON.stringify(p))).join('\n');
  else txt = JSON.stringify(c);
  seen.push({ i, role: m.role, bytes: len(txt), txt });
  console.log(`   msg[${i}] role=${m.role} ${len(txt)} 字节`);
});

// 拆注入内容(在各 message 文本里找标记词)
const allText = seen.map(s => s.txt).join('\n');
const sections = [
  ['superpowers SessionStart hook', /using-superpowers|EXTREMELY-IMPORTANT|superpowers skills override/i],
  ['skills 技能清单', /following skills are available|available for use with the Skill tool/i],
  ['agents 子代理清单', /Available agent types|available agent types for the Agent tool/i],
  ['CLAUDE.md 注入', /Contents of .*CLAUDE\.md|user's private global instructions/i],
  ['工具并发/调用格式指引', /multiple tools and there are no dependencies|function_calls block/i],
];
console.log('\n   注入内容细分:');
let accounted = 0;
for (const [name, re] of sections) {
  const idx = allText.search(re);
  if (idx < 0) { console.log(`     ${name}: 未命中`); continue; }
  // 从标记词往后截到下一个标记词或末尾,粗略量化
  let end = allText.length;
  for (const [, r2] of sections) {
    const m2 = r2.exec(allText.slice(idx + 50));
    if (m2) end = Math.min(end, idx + 50 + m2.index);
  }
  const seg = allText.slice(idx, end);
  console.log(`     ${name}: ${len(seg)} 字节 ${tk(len(seg))}`);
}

// ---------- 汇总排名 ----------
console.log('\n【主要组成 排名(按字节)】');
const parts = [
  ['工具定义 tools', len(b.tools)],
  ['注入对话 messages', len(b.messages)],
  ['系统提示 system', len(b.system)],
].sort((a, c) => c[1] - a[1]);
parts.forEach(([n, v]) => console.log(`   ${n.padEnd(20)} ${v} 字节 ${(100 * v / len(b)).toFixed(0)}%  ${tk(v)}`));
