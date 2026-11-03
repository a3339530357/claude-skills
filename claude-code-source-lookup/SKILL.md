---
name: claude-code-source-lookup
description: 在 Claude Code 自己的安装二进制里定位实现、报错文案或函数逻辑，用来回答「Claude Code 为什么这么做」「这句报错是哪来的」「这个功能怎么实现的」。Claude Code 以 bun 单文件打包分发，JS 源码是压缩后的纯文本嵌在二进制里，提取后可像读普通源码一样检索，不需要反编译。当用户问及 Claude Code 内部机制、某个 400 或报错的处理逻辑、compact／缓存／工具调用／thinking 的实现、某个版本改了什么，或要求「看下 Claude Code 源码」时都用这个技能——即使用户没提「源码」二字，只要问题涉及 Claude Code 自身行为而不是用户项目代码，也应先查它再回答。
---

# 查 Claude Code 源码

Claude Code 不是开源的，但它的实现基本可读：bun 的 `--compile` 把压缩后的 JS 原样拼在 ELF 末尾，没有加密，也没有编译成机器码。所以「看源码」= 提取可打印文本 + 检索，不需要反编译工具。

关键心态：**你看到的是打包产物，不是官方源码。** 变量名被压成 `e`/`n`/`t`，部分 chunk 懒加载可能不在文件里。给结论时要把「打包产物里确实写着」和「我根据 minify 代码推断」分开讲——这个区分用户很在意，混在一起说等于给假证据。

## 0. 先定位版本

```bash
readlink -f "$(command -v claude)"
```

本机形如 `/root/.local/share/claude/versions/2.1.317`。同目录常有多个历史版本，**查版本差异时用这个**：拿旧版本同样跑一遍提取和检索，对比关键字符串是否存在，就能排除「是不是最近才改的」。

## 1. 提取一次，之后复用

```bash
node <skill目录>/scripts/ccsrc.mjs extract
```

扫二进制里的连续可打印字符，输出到 `~/.cache/ccsrc/<版本>.txt`（约 63MB，5 秒左右）。已存在且比二进制新就跳过。不改安装文件，不写系统临时目录。

`func` 和 `find` 在缓存不存在时会自动提取，所以通常不用单独跑这一步。

**磁盘紧的机器注意**：一台 30G 盘放两三份提取结果就吃掉 200MB。用 `--binary` 查旧版本会额外生成一份缓存，查完记得删：

```bash
rm -f ~/.cache/ccsrc/<旧版本>.txt
```

## 2. 三种检索入口

拿到文本文件后就是普通 `grep`，但入口选得对能省一大半时间。

**入口 A：函数名。** 已知函数名时最准。

```bash
node <skill目录>/scripts/ccsrc.mjs func z3o
```

按 `function <name>(` 定位，然后数括号配对（会跳过字符串字面量里的括号），把整个函数体打出来。压缩代码里函数名基本都保留，这是最可靠的路子。同名函数可能有多个（不同 chunk 里各有一个），全部列出，按内容挑对的那个。

**入口 B：报错文案或日志文案。** 从用户看到的红字倒推处理逻辑，是排查类问题最快的入口。

```bash
node <skill目录>/scripts/ccsrc.mjs find "signature in thinking block"
```

文案命中后往前找最近的 `function xxx(` 或 `if(...)`，那里就是判定条件。

**入口 C：字段名或事件名。** 遥测埋点（`tengu_*`）、配置字段（`compactMetadata.*`）通常保留原名，且往往成组出现，能顺藤摸到整个功能模块。

```bash
node <skill目录>/scripts/ccsrc.mjs find "keptThinkingStripped" --context 300
```

`--context` 控制两侧各取多少字符（默认 300），`--limit` 控制最多显示几条命中（默认 5）。命中数多时先看 `total` 再决定要不要调大 limit。

## 3. 读函数体

`find` 只给一行上下文，容易看断。命中后建议直接 `func` 取完整定义；如果不知道函数名，就用命中的偏移量手工往前翻，找 `function` 关键字。

压缩代码的可读性技巧：

- `let n=e.toLowerCase()` 这类开头通常是在做归一化匹配，后面跟着一串 `includes` 就是白名单；
- `a("tengu_xxx",{...})` 是遥测埋点，字段名往往把整个逻辑讲清楚了，比读控制流快；
- 对象字面量里的字段名（`{boundaryMarker, summaryMessages, messagesToKeep}`）保留原样，能反推出数据结构。

## 4. 验证，别只靠读

读出来的判定逻辑，**抄出来跑一遍**再下结论。这是本技能最有价值的一步——压缩代码很容易看错作用域，跑一下立刻暴露。

```bash
node -e '
function z3o(e){ let n=e.toLowerCase().replaceAll("`","");
  if (n.includes("signature in thinking block")) return true;
  return (n.includes("thinking block")) && (n.includes("invalid signature"));
}
for (const c of ["Invalid signature in thinking block","each thinking block must contain non-whitespace thinking"])
  console.log(z3o(c) ? "命中" : "不命中", "<=", c);
'
```

函数体直接从二进制里复制粘贴，别凭记忆重写。

## 5. 常见坑

- **`strings` 可能没装。** 本机就没有，脚本自己实现提取，不依赖 binutils。
- **提取时的两个陷阱，脚本已处理，改脚本时别踩回去。** 一是块边界：长字符串横跨 16MB 读取边界会被切成两半，需要把尾部未闭合片段留到下一轮拼接，而不是靠「块间重叠」——重叠只覆盖固定长度，长于它的字符串照样断。二是异步写入：`createWriteStream` 是异步落盘的，直接写 `buf.subarray(...)` 会在下一轮 `readSync` 覆盖 `buf` 时写进错数据，必须 `Buffer.from()` 复制。这两个 bug 都会让结果「看起来正常但搜不到东西」，极难察觉。
- **懒加载的 chunk 不在文件里。** 搜不到不等于不存在，可能是运行时才 import。下结论说「没有这段代码」前，先搜相关字段名或埋点名确认。
- **`@bytecode` 标记。** 部分 chunk 头部写 `// @bun @bytecode`，可能是预编译形态而非文本，这类模块搜不到是正常的。
- **同名短变量满天飞。** `e`/`n`/`t`/`r`/`s` 在不同 chunk 里含义完全不同，跨 chunk 拼逻辑必错。一次只看一个函数。
- **多版本对比要用同一套检索词。** 只对比「有没有」不够，还要看 `total` 次数，避免把注释里的提及当成实现。
- **ELF 头部也混在结果里。** 提取结果开头是动态链接符号表（`__gmon_start__` 之类），属正常噪音，检索时忽略即可。

## 6. 输出纪律

回答时按这个分层：

1. **打包产物里直接可见的**：贴函数原文、贴字段名，这是硬证据；
2. **基于压缩代码的推断**：明确说「推断」，并给出依据（比如「变量名不可读，但从调用位置看是…」）；
3. **搜不到 / 不确定的**：直说，不要用「应该是」填空。

用户对「把推断当事实」很敏感，一次混说会让后面所有结论都不可信。

## 已知索引

`references/known-symbols.md` 记录了已确认的函数名、字段名和它们的位置含义。查之前先扫一眼，能省一次全量检索；查到新的也往里补。
