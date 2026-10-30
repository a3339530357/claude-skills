---
name: daily-work-summary
description: 当用户想回顾或总结某一天做了什么时使用。触发说法包括"日报""每日总结""工作总结""今天做了什么""总结一下今天""帮我写个工作留档""生成昨天的总结""daily summary""work log",以及任何需要把 git 提交、工作区改动、Claude Code / Codex / opencode / ChatGPT 对话记录合并成一份当日记录的场景。用户提到要补某个历史日期的总结、或想看某天的工作时间线时同样适用。只要涉及"把今天/某天的工作整理出来",就应当使用本技能,即使用户没有明说"日报"二字。
---

# 每日工作留档

把五个来源的当日痕迹——git 提交与工作区改动、Claude Code 会话、Codex 会话、
opencode 会话、ChatGPT 对话——合并成一份 Markdown 留档和一个 HTML 页面。

核心价值不在于把各个源各列一遍流水账,而在于**跨源关联**:单看 git 只知道"改了
哪些文件",单看对话只知道"问了什么";合起来才能还原"卡在哪 → 怎么查 → 怎么解 →
提交了什么 → 怎么验证"的完整链路。这是任何单一来源都给不出的东西。

## 先确定技能目录

下文所有命令里的 `$SKILL_DIR` 指本技能所在目录。**本技能自带全部依赖,不需要任何
其他技能**,因此在 Claude Code / Codex / opencode / Gemini CLI 等任意运行时下都能用,
只是安装路径不同。

先定位它(一条命令即可,取第一个命中的):

```bash
SKILL_DIR=$(for d in \
  ~/.claude/skills/daily-work-summary \
  ~/.agents/skills/daily-work-summary \
  ~/.config/opencode/skills/daily-work-summary \
  ~/.codex/skills/daily-work-summary \
  ./.claude/skills/daily-work-summary \
  ./skills/daily-work-summary; do
  [ -f "$d/scripts/collect.py" ] && echo "$d" && break
done)
echo "SKILL_DIR=$SKILL_DIR"
```

若为空,说明技能装在别处,用 `find ~ -name collect.py -path '*daily-work-summary*' 2>/dev/null`
找一下。**后续每个 Bash 调用都要带上 `SKILL_DIR=...`**(每次 Bash 调用是独立 shell,
变量不跨调用保留),或者直接把实际路径写进命令。

## 执行流程

### 1. 确认日期与输出目录

日期默认今天;用户说"昨天""补一下 7 月 30 号"就按其所指。注意跨零点工作的情形:
时间窗按**本地自然日** [00:00, 次日 00:00) 切分。

输出目录**必须问用户**,不要擅自选一个。问法举例:"报告存到哪个目录?"。
不要使用 `/tmp` 或任何临时目录——用户的全局约定明确禁止。

### 2. 准备浏览器(仅 ChatGPT 需要)

```bash
bash "$SKILL_DIR/assets/launch-browser.sh"
```

脚本会自动处理端口:先扫 9222-9235 找现成的调试实例(不限于本脚本启的,手动启的、
上次遗留的都能复用),没有才新启,且默认端口被占时自动往后挑空闲端口。成功时末行
输出 `CDP_PORT=<实际端口>`。**采集器也会自己扫端口发现实例,所以通常不需要把这个
端口传给 collect.py。**

若提示未登录,告诉用户在弹出的窗口里登录一次即可,登录态存在独立 profile 里,
以后不必重复。

**如果报"profile 已被占用但没有调试端口"**:同一 profile 只能有一个 Chrome 实例,
这些进程会让新启动的命令被转发、调试端口被丢弃,换任何端口都没用。按提示执行:

```bash
bash "$SKILL_DIR/assets/launch-browser.sh" --kill-stale
bash "$SKILL_DIR/assets/launch-browser.sh"
```

`--kill-stale` 只关用本技能独立 profile 的 Chrome,不影响用户日常浏览器窗口。

用户若说"跳过 ChatGPT"或浏览器实在起不来,直接进下一步并加 `--skip-chatgpt`,
另外四个源照常产出。缺一个源不该让整件事停摆。

### 3. 采集

```bash
python3 "$SKILL_DIR/scripts/collect.py" \
  --date YYYY-MM-DD --out <用户指定的目录>
```

产出 `<out>/collected-<date>.json`,并在 stderr 打印项目排名、跨源关联、
ChatGPT 分类概况。**先读这份概况**,它能让你立刻知道当天主线在哪。

原始 ChatGPT 数据落在 `<out>/.raw/` 下,含未压缩全文,需要核对细节时可以查,
但不要整份读进上下文——那正是压缩要解决的问题。**只有 ChatGPT 会落 `.raw/`**;
其余各源的原文在自己的 jsonl / SQLite 库 / git 仓库里,JSON 的 `sessions[].file`
记着路径(opencode 那个是 `.db` 路径,要用 sqlite3 查,别去 grep)。

### 4. 读 JSON 写 Markdown

读 `collected-<date>.json`。重点看这几个字段:

| 字段 | 用途 |
|---|---|
| `primary_project` / `projects[].is_primary` | 当天主线,详细展开;其余项目一句话带过 |
| `cross_source_links` | 已经算好的关联,是写因果的骨架。`kind=commit` 是提交关联,`kind=patch` 是 CLI 工具落盘改动的关联(0 提交的日子只有它) |
| `timeline` | 全天事件流,用来还原工作节奏 |
| `chatgpt_buckets` | 会话分类。`work` 进正文,`learn` 进「今日学到」,`off-topic` 只在末尾记个数 |
| `sources.git.repos[].commits[].digest` | 提交的实际代码变更,用来写"改了什么逻辑"而非"改了哪个文件" |
| `sources.*.sessions[].human_turns` | 你当时真正问了什么 |
| `projects[].by_tool` | 该项目的提问分布在哪个工具上(claude / codex / opencode) |

主项目得分公式是 `提交×10 + 真人提问×1 + 当日工作区改动×2`。提交权重压倒性高,
因为它代表真实产出——实测交互量最高的目录往往是试验场,而真正的工作项目可能
对话没几句却有好几次提交。若排名结果与用户认知不符,以用户说的为准。

### 5. 生成 HTML

**先看前一天的报告,保持风格连续。** 日报是每天一份的连续系列,不该每天换一套视觉:

```bash
ls -1t <输出目录>/*.html 2>/dev/null | head -3
```

有历史文件就读最近那份的 `<style>` 块,继承配色 token、字体角色、版心间距与
signature 元素;内容结构可随当天实际情况调整。

**视觉与技术规范读 `references/html-style.md`** —— 它是自带的,不依赖任何外部技能。
若当前运行时恰好有 `html-report` / `frontend-design` / `dataviz` 技能,可以先调用它们
(更新更快);**没有就照 `html-style.md` 做,不要因为技能缺失就退回朴素 HTML 或
纯 Markdown。**

**自审用 `scripts/lint-html.js`,不要截图后读图。** 它走 CDP 在多视口 × 多主题下
取可量化指标(横向溢出、外部资源、color-scheme、主题是否真切换、focus-visible、
reduced-motion),输出文本报告。之所以不读图:运行本技能的模型若是纯文本的,
Read PNG 会直接 API 400 打断流程(实跑栽过)。

```bash
node "$SKILL_DIR/scripts/lint-html.js" <html绝对路径> 400,1280,2560
```

报告里任何 `✗` 都是真问题,照着修。重点盯:横向溢出(各断点)、外部资源(违反
离线自包含)、`color-scheme(dark)` 是否为 dark(漏了深色模式下原生控件会留白)。

`screenshot.js` 仍保留,但仅在确定当前模型支持图片输入时才用,作为视觉补充。
**不要在纯文本模型下 Read PNG。**

### 6. 交付

报告完整路径,并说明本次有哪些源不可用、剔除了哪些内容(见「诚实交代」)。

## 路径约定(重要)

调用 Read / Write / Edit 时,路径一律用 **WSL 绝对路径**(如 `/home/a33511/project/...`)。
**不要用 Windows 路径(`C:\Users\...`)或 UNC 路径(`\\wsl.localhost\...`)调文件工具** ——
本文档里出现它们只是为了说明数据源在哪,直接拿去调工具会找不到文件(实跑时模型
把用户名都猜错了,连着失败好几次)。跨系统路径转换由采集脚本内部处理,你不用管。

## 报告结构

Markdown 与 HTML 用同一套骨架:

```markdown
# YYYY-MM-DD 工作留档

## 概览
一句话说清今天的主线,后接关键数字(提交数/改动文件/AI 求助轮次/涉及项目)。

## 主线:<项目名>(分支)
### 时间线
按时刻列出提交与求助会话,让人一眼看出节奏。

### <问题一>
- **现象**:报错原文/异常类型/触发场景
- **定位**:怎么一步步缩小范围的
- **解法**:改了什么,为什么这么改
- **产出**:对应 commit(短哈希 + message)
- **坑与弯路**:试过但没走通的思路 ← 这条最容易被略过,但留档价值最高

## 其他项目
每个一到两句。

## 今日学到
学习性质的会话在这里沉淀,写清"原本不清楚什么、现在明白了什么"。

## 遗留
工作区里没提交的改动、没解决的问题、明天要接着做的事。

## 采集说明
数据来源、不可用的源、被剔除的内容及数量。
```

## 写作口径:客观留档

这份文档是写给**几个月后的自己**看的,不是写给领导看的汇报材料。因此:

- **保留技术细节**。异常全名、类名方法名、行号、配置项、SQL、服务器主机名——
  这些正是日后检索时唯一的抓手。不要为了"简洁"把 `NusDeliverPlanServiceImpl
  .getMonthAve() 第 1628 行 BigDecimal.add 传入 null` 缩写成"修复了空指针"。
- **写清因果而不是罗列动作**。"14:27 发现 NPE → 定位到 SP_AVERAGE 字段可能为空
  → 14:41 加空值跳过后提交",而不是"排查了 NPE 问题,提交了代码"。
- **弯路要写**。试过什么方案、为什么放弃,比最终答案更值钱——它能阻止你几个月后
  重新踩一遍。
- **不脱敏**。内网 IP、测试服主机名、业务模块名照实写,这是用户确认过的口径。
  唯一例外是密钥和 token,任何情况下都不得写入报告。
- **不吹**。没做成的就写没做成,卡住了就写卡住了。

## 诚实交代

报告末尾必须说明本次采集的实际情况,包括:

- 哪个源不可用、原因是什么(如"ChatGPT 未采集:浏览器未登录")
- 剔除了多少内容(如"3 个非工作会话已略过")
- 哪些内容被截断(JSON 里 `truncated: true` 的条目)

**截断内容的原文在哪,别写错**:`<out>/.raw/` 下只有 ChatGPT 的未压缩全文。
Claude Code / Codex 的截断内容要回原始 jsonl 找,opencode 的要回 SQLite 库查,
路径都在 JSON 里 `sources.<工具>.sessions[].file`。
写"完整内容在 .raw/ 下可查"对这两个源是错的,几个月后照着找会一场空。

用户选的是留档口径,而留档最怕的就是"看起来很完整但其实缺了一块"。宁可写明
缺口,也不要让读的人以为这就是全部。

## 常见问题

**项目排名把不相干的仓库排前面**
工作区改动已按文件 mtime 过滤到当日,若仍有异常,多半是构建产物在当天被重新
生成。用 `--scan-roots` 缩小扫描范围。

**跨源关联为空**
说明当天提交与对话在时间或内容上都对不上,这本身就是有效信息(比如提交的是
前一天写好的代码)。如实写,不要硬凑因果。

**ChatGPT 抓取失败**
`collect.py` 会打印具体原因和处置建议。最常见的是浏览器没开或登录态过期,
按提示重跑 `launch-browser.sh` 即可。token 全程留在浏览器进程内,不会落盘。

**想知道某个数据源的格式细节**
读 `references/data-formats.md`,里面记录了五个源的结构以及踩过的二十个坑。

**HTML 该长什么样**
读 `references/html-style.md`:风格连续性怎么做、硬性要求、视觉设计规范、
日报专属的呈现要点(代码差异、异常堆栈、时间线、遗留项勾选)。
