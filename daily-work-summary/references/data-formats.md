# 五个数据源的格式与坑

记录于 2026-07-30,基于对真实数据的实测而非文档推断。字段随工具版本会变,
若采集异常,先回到这里核对结构是否仍然成立。

## 目录一览

| 源 | 位置 | 备注 |
|---|---|---|
| Claude Code (WSL) | `~/.claude/projects/<编码路径>/<uuid>.jsonl` | 主力 |
| Claude Code (Windows) | `/mnt/c/Users/a3351/.claude/projects/` | 目录在,实测当日无数据 |
| Codex (Windows) | `/mnt/c/Users/a3351/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | 主力 |
| Codex (WSL) | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | 实测已不活跃 |
| opencode (WSL) | `~/.local/share/opencode/opencode.db` | **SQLite,不是 jsonl** |
| opencode (Windows) | `/mnt/c/Users/*/.local/share/opencode/opencode.db` | 实测已不活跃 |
| ChatGPT | 无本地文件,须经浏览器取 | 见下文 |

opencode 是唯一不落文件的本地源,采集器按用户目录 glob 扫库,多机多用户都能覆盖。

---

## 坑一:文件日期 ≠ 会话日期

**最容易犯的错。** 实测有个 rollout 文件躺在 `sessions/2026/07/20/` 目录下、
文件名也写着 `rollout-2026-07-20T10-08-52-...`,但里面有 **1100 行 07-30 的消息**——
会话被 resume 了,新消息追加进了旧文件。

Claude Code 同理:某个会话文件的消息横跨 07-29 与 07-30 两天。

**因此:**
- 不能按目录日期筛
- 不能按文件名筛
- 不能按 mtime 筛(只能用作**预筛**,因为 mtime 一定 ≥ 最后一条消息时间)
- 只能逐条读 `timestamp` 判定

## 坑二:时区

日志内的 `timestamp` 一律是 UTC(带 `Z`),而 Codex 的**文件名用本地时间**。
实测 `timestamp: 2026-07-20T02:08:58Z` 对应文件名 `2026-07-20T10-08-52`,差 8 小时。

本地(UTC+8)自然日 2026-07-30 对应 UTC 区间 `[2026-07-29T16:00Z, 2026-07-30T16:00Z)`。
统一由 `common/timewin.py` 换算。

## 坑三:同一项目在各源里长相不同

| 源 | 记录的 cwd |
|---|---|
| Windows Codex | `\\wsl.localhost\Ubuntu\home\a33511\project\code` |
| WSL Claude Code | `/home/a33511/project/code` |

**是同一个项目。** 不归一化就会被拆成两条独立记录。由 `common/pathnorm.py` 处理
UNC / 盘符 / WSL 三种形态的互转。

---

## Claude Code jsonl

一行一条记录。关键字段:

```
type        user | assistant | system | attachment | file-history-snapshot | ...
timestamp   ISO-8601 UTC
cwd         工作目录(权威来源,优先于目录名反解)
gitBranch   分支
sessionId   会话 ID
message     { role, content }
```

`message.content` 可能是字符串,也可能是 block 列表,block 的 `type` 有
`text` / `thinking` / `tool_use` / `tool_result`。

### 坑四:`type: "user"` 里混着工具回显

`tool_result` block 也挂在 `type: "user"` 下。实测某项目当日 125 条 user 记录中,
**真人说的只有 11 条**,其余 114 条是工具回显。

不过滤的后果很具体:该试验性目录会以 125 的"提问数"碾压真正的工作项目(4 条),
把主项目判错。

过滤规则见 `common/textclean.py:is_human_turn()`,要点:
- 剔除含 `tool_result` block 的条目
- 剔除 `isMeta` / `isCompactSummary` / `isSidechain`
- 剔除 `<system-reminder>` 开头、`Caveat:` 开头、`[Request interrupted` 开头
- 剔除空内容

### 子代理会话

`<uuid>/subagents/agent-*.jsonl`。里面的 user 消息是主代理下发的指令,不是真人
发言,单独归入 `subagent_sessions`,不计入提问数。

---

## Codex rollout jsonl

```
type      session_meta | event_msg | response_item | turn_context
timestamp ISO-8601 UTC
payload   随 type 而变
```

`session_meta.payload`:`session_id` / `cwd` / `originator` / `cli_version` /
`source` / `forked_from_id`。**一个文件里可能出现上百次**——每次 resume 或 fork
都会追加一条。

### 坑五:同一句话存两份

`event_msg` 与 `response_item` 是同一内容的两种投影。只取 `event_msg`,
否则对话量翻倍。

`event_msg.payload.type` 的取值:

| type | 含义 | 关键字段 |
|---|---|---|
| `user_message` | 用户发言 | `message`, `images`, `text_elements` |
| `agent_message` | 助手发言 | `message`, `phase` |
| `agent_reasoning` | 推理草稿 | 不进日报 |
| `patch_apply_end` | **实际落盘的文件改动** | `changes`(路径→{type: add/update/delete}), `success` |
| `task_started` | 一个回合开始 | `turn_id`, `started_at` |
| `token_count` | 用量统计 | — |

`patch_apply_end.changes` 的 key 是文件路径(可能是 UNC 形式),这是工作产出的
硬证据,比对话内容更能说明"到底改了什么"。

---

## opencode SQLite

`~/.local/share/opencode/opencode.db`。**唯一不落文件的本地源**,取一句话要 join
三张表:

| 表 | 一行是什么 | 关键字段 |
|---|---|---|
| `session` | 一个会话 | `id` / `directory`(工作目录)/ `title` / `parent_id` / `model` / `agent` / `time_created` / `time_updated` |
| `message` | 一条消息 | `id` / `session_id` / `data`(JSON,内含 `role`)—— **没有正文** |
| `part` | 消息的一段 | `message_id` / `time_created` / `data`(JSON,内含 `type`) |

`part.data.type` 的取值(实测占比):`step-start`/`step-finish` 各约 2100、
`tool` 2329、`text` 1474、`reasoning` 1397、`patch` 66。只有 `text` / `tool` /
`patch` 进日报,其余三类体量最大却没有留档价值。

`type: "tool"` 的结构:`{tool: "edit", state: {input, output, status, time: {start, end}}}`。
`edit`/`write` 的 `state.input.filePath` 就是落盘的文件,等价于 Codex 的
`patch_apply_end`。`type: "patch"` 是快照式记录(`{hash, files: [...]}`),
实测只有 edit/write 数量的三分之一,不能只靠它。

### 坑十八:时间戳是毫秒

其余各源是 ISO 字符串或 Unix 秒,opencode 全是**毫秒**。`to_epoch` 按量级自动
判别(> 1e11 视为毫秒),但读代码时极易看错,过滤时间窗时尤其要留意。

另外 `part.time_created` 是**落库时刻**,不是工具执行时刻。长时间运行的 bash
命令两者能差好几分钟,所以工具事件的时刻取 `state.time.start`。

### 坑十九:技能/斜杠命令的正文会以 user 消息落库

实测运行本技能时,整份 SKILL.md(七千多字)成了该会话"用户发言"的第一条。
不过滤就等于"用户打了七千字",直接把该目录顶成当天主项目——和 Claude Code 那个
`tool_result` 回显坑(坑四)同款。

**修复**:`_looks_injected()` 按"够长(≥1200 字)+ 有三个以上 `## ` 小节 + 以
`#` 或 frontmatter 开头"判定。真人粘贴的报错日志、代码片段不会有好几个 markdown
小节,所以不会误伤。同理,Claude Code 的 `/init` 会以
`<command-message>init</command-message>` 落进 user 条目,`textclean.is_meaningful`
剥掉 `command-*` 标签后若剩不到 12 字就丢弃。

### 坑二十:edit 是逐处替换,一个文件能连发六次

opencode 改一个文件常连发五六次 `edit`。不折叠的话跨源关联里同一个文件重复出现
五六条,把当天真正的其他产出淹掉(实测 11 条关联里 6 条是同一个 md 文件)。

**修复**:`_fold_patches()` 按 (文件集合, 20 分钟内) 归并成一次"改动回合",
保留首末时刻和 `edits` 次数。信息不丢,但只占一行。

### 库正在被写

opencode 开着时有 `-wal` 文件。只读打开(`?mode=ro`)是必须的,但**不能加
`immutable=1`** —— 那会忽略 WAL,读到几小时前的旧状态。

---

## ChatGPT

没有本地文件,只能经浏览器取。

### 为什么必须用 Windows 侧的 Node

Chrome 150 起**已忽略 `--remote-debugging-address`**,调试端口死绑 `127.0.0.1`。
WSL 走 NAT(网关 `172.27.96.1`),跨不到 Windows 的回环地址。实测:

```
netstat -ano | grep 9222
  TCP  127.0.0.1:9222  0.0.0.0:0  LISTENING       ← 只有回环
```

绕法是让 **Windows 侧的进程**去连 Windows 的 localhost。Windows 自带的
`C:\Windows\System32\curl.exe` 可以取 CDP 的 HTTP 端点;但 `Runtime.evaluate`
必须走 WebSocket,所以用 Windows 的 `node.exe`(v22+ 内置全局 `WebSocket`,零依赖)。

WSL 侧通过 UNC 路径调起脚本:

```bash
node.exe '\\wsl.localhost\Ubuntu\home\a33511\.claude\skills\daily-work-summary\scripts\chatgpt\fetch.js'
```

### 认证

`/api/auth/session` 靠 cookie 就能拿到,返回体含 `user` 与 `accessToken`。
但 `/backend-api/*` **只认 `Authorization: Bearer <accessToken>`**,光有 cookie 会
401。

ChatGPT 自己在响应里用全大写横幅警告过:该 token 等同于密码。因此取 token 与
调用 backend-api 全部在**页面上下文内**完成(`Runtime.evaluate` 里的 async 函数),
token 不跨进程传出、不写日志、不落盘。

### 接口

```
GET /backend-api/conversations?offset=N&limit=100&order=updated
    → { items: [{id, title, create_time, update_time, is_archived}], total }
    时间是 ISO 字符串。按 update_time 倒序,翻到早于目标日即可停。

GET /backend-api/conversation/<id>
    → { title, mapping: {node_id: {id, message, parent, children}}, current_node }
    message.create_time 是 **Unix 秒(float)** —— 和列表接口的格式不一样。
```

### 坑六:消息树有分支

regenerate 会产生兄弟节点。必须从 `current_node` 沿 `parent` 回溯取主干,
否则会把用户已经放弃的分支也算进来。回溯时要防环。

`message.content.content_type` 的取值:`text` / `multimodal_text` / `code` /
`thoughts` / `reasoning_recap`。后两者是推理草稿,不进日报。
`metadata.is_visually_hidden_from_conversation` 为真的节点同样剔除。

### 坑七:单条消息能到 1.9 万字

实测当日 12 个会话共 104 条消息、**15.2 万字**,其中最长单条 19676 字(粘贴的
Apusic 服务器日志),次长 11464 字(异常堆栈)。

全量喂给模型既慢又贵,而且没必要——助手自己都说了"关键看异常第一行 + 业务代码
第一行"。`common/textclean.py` 按形态分级裁剪:

- **堆栈**:留异常行 + 自家包的业务帧,框架帧折叠成 "省略 N 个框架调用帧"
- **日志/代码**:掐头留尾,标注省略字数
- **散文**:头 65% + 尾 35%

实测压缩率 76%(151654 → 35600 字),诊断信息无损失。

### 坑八:会话内容高度混杂

同一天的 12 个会话里,3 个是生活话题(番剧推荐、动漫推荐、预制菜加热),
1 个是关于日报工具自身的元任务。留档口径下不能直接删,但也不能让它们污染正文。

`common/classify.py` 按结构性信号打标签,刻意**不用固定词表**——"番剧""美食"
这类词只对某一天有效。改用:

- 是否出现本项目特有标识(包名、当日改动的文件名,由 git 采集器自动推导)
- 是否含技术锚点(异常、类名、文件行号、SQL)
- 时间是否贴近当天提交
- 是否为提问式句式("是什么""区别""为什么")

换项目、换技术栈同样适用。

---

## 跨源关联

`collect.py:link_across_sources()` 把提交与求助会话挂钩。两个关键设计:

**按区间而非单点判定时间。** 长会话会把提交夹在中间:实测 NPE 排查会话
14:27 起、15:59 止,而两次修复提交(14:41、14:59)正落在区间内。若拿会话
结束时刻去减提交时刻,会算出负 78 分钟而被误判为无关。

**锚点必须按时间局部化。** 实测某 Codex 会话从 09:15 开到傍晚,若用整段会话
累积的锚点去比对,它囊括了全天所有文件,于是跟每一次提交都"匹配",区分度归零。
改为只取提交前后 45 分钟内消息的锚点,才能反映提交当时到底在聊什么。

**"同项目"不能单独成立关联。** 该条件太松——当天在该项目下的每个会话都满足。
它只给 2 分底分,必须叠加锚点证据(同文件 +5 / 同类 +4 / 异常栈指向 +4)
才能过 5 分门槛。


---

## 聚合与分类的坑

不在单个数据源里,而在跨源聚合与分类环节,首跑时才暴露。

### 坑九:子目录 cwd 被拆成独立项目

Claude/Codex 的 cwd 常是 git 仓库的子目录(如 `~/project/code/src/main/resources`),
归一化后不等于父仓库 `~/project/code`,被当成独立项目,污染排名。

**修复**:`collect.py:build_projects` 里,会话 cwd 位于某 git 仓库路径之下时,
归并到该仓库(`pathnorm.is_under`)。关联判定里的"同项目"也改用 `is_under`
而非 `==`,否则子目录会话匹配不上父仓库的 commit。

### 坑十:分类器的匹配文本不能含项目名

`classify.py` 最初把 title(项目 display_name)纳入匹配 blob。但 title 总含项目
目录名,于是每个活跃项目的会话都命中项目标识,把"你好"这类试验对话误判成工作。

**修复**:blob 只用对话内容(texts),不含 title。项目标识必须在对话里**出现**
才算"在聊这个项目"。同时无技术信号的分支加 `work < 5` 守卫:有项目标识命中的会话
(如运行本技能本身,内容多为"继续")不会被一刀切判无关。

### 坑十一:工作区状态与日期无关

`git status` 是快照,不带时间。某个长期没清理的仓库积压 324 个未跟踪文件,不过滤
就以 648 分抢走"今日主项目",而那些文件当天根本没人碰。

**修复**:工作区文件按 mtime 过滤到当日。未跟踪目录会被 porcelain 折成一条,
需递归探里面的文件。全量计数另存 `all_counts`,供报告说明"另有 N 个历史遗留改动"。

### 坑十二:0 提交时跨源关联为空

原关联逻辑只认 commit。0 提交的日子(纯排障未提交)关联全空,日报写不出因果。

**修复**:`link_across_sources` 增补 Codex `patch_apply_end` 作为关联锚点。patch
记录了实际落盘的文件与时间,是 0 提交时工作产出的唯一硬证据。产物里
`cross_source_links` 元素带 `kind` 字段区分 `commit` / `patch`。

### 坑十三:截图自审依赖读图,纯文本模型会 400

SKILL.md 原让模型截图后 Read PNG 自审。但运行模型若是纯文本的,Read PNG 直接
API 400,连续报错打断流程。

**修复**:新增 `scripts/lint-html.js`,走 CDP 取可量化指标(横向溢出/外部资源/
color-scheme/主题切换/focus-visible/reduced-motion),输出文本报告。模型读文本
自审,不依赖视觉能力。`screenshot.js` 保留但仅限多模态模型。

---

## 浏览器启动的坑

这一串占了 ChatGPT 采集失败的绝大多数,且表象都是"端口没绑上",容易误判。

### 坑十四:profile 被占用时,换端口也救不了

最初误判为"9222 端口冲突",实际根因是 **同一个 user-data-dir 只能有一个 Chrome 实例**。

实测对照:profile 空闲时用 9224 启动成功;此时再用 9225 启动同一 profile,9225
绑不上 —— Chrome 单实例机制把命令转发给了 9224 那个进程,`--remote-debugging-port`
被静默丢弃。**换任何端口都是同样结果。**

旧脚本只探测自己指定的那个端口,探不到就报"没起来",完全不知道 profile 已被占、
且已有实例正带着别的端口在跑。用户看到的现象就是"9222 和 9223 都试了都不行"。

**修复**(`launch-browser.sh` + `chatgpt_src.py`):

1. **先找后启**:启动前用一次 netstat 筛出 9222-9235 里正在监听的端口,再逐个 curl
   验证是不是 Chrome 调试端点。找到就复用 —— 不限于本脚本启的实例。
   (为什么不直接逐端口 curl:没人监听的端口会让 curl 白等超时,14 个端口能拖半分钟。)
2. **识别僵尸占用**:用 CIM 查有哪些 chrome.exe 命令行里含本 profile 路径。若有进程
   占着 profile 却没有一个在监听调试端口,明确报出并给 `--kill-stale` 的解决路径。
3. **`--kill-stale` 只杀父进程**:Chrome 一个实例有十来个进程,只有父进程(命令行里
   没有 `--type=` 的那个)持有 profile 锁。`taskkill /T` 杀父进程会干净带走全部子进程;
   逐个杀子进程会留孤儿、锁释放也不干净。杀完轮询等 profile 真正空了才返回。
4. **采集器自主发现**:`chatgpt_src.discover_cdp()` 同样扫端口范围。因此无论实例是
   脚本启的、手动启的还是上次遗留的,采集器都能找到,用户不必传端口。

端口仍可用 `CDP_PORT` 指定起始值(被占则自动往后找),但日常不需要设。

### 坑十五:PowerShell -FilePath 必须给 Windows 路径

`launch-browser.sh` 原来把 WSL 路径 `/mnt/c/Program Files/.../chrome.exe` 直接传给
`Start-Process -FilePath`。PowerShell 是 Windows 程序,不认这种路径。

危险之处在于**它是静默失败**:Start-Process 报"系统找不到指定的文件",但 stderr 被
`>/dev/null 2>&1` 吞掉,脚本只看到"端口没绑上",于是往 profile 占用、权限问题上
乱猜。实测对照:

```
-FilePath '/mnt/c/Program Files/.../chrome.exe'  → 失败(系统找不到指定的文件)
-FilePath 'C:\Program Files\...\chrome.exe'      → 成功
```

**修复**:加 `to_win_path()` 把 `/mnt/<盘符>/...` 转成 `<盘符>:\...` 再传给
`-FilePath`。诊断输出也一并改用 Windows 路径,便于用户直接复制那条命令手动验证。

顺带把 probe 的 `--max-time` 从 3s 降到 1s:本地回环上 Chrome 要么立刻响应要么就是
没在听,3s 会让 25 次探测循环白拖一分钟。

### 坑十六:pathnorm UNC symlink 断裂

`~/.claude` 实际是 `C:\Users\a3351\.claude` 的 symlink。`chatgpt_src.py` 用
`abspath(__file__)` 得到 `/home/a33511/.claude/...`(symlink 路径),`to_windows`
盲转 UNC 后 9p 文件系统不跟随 symlink,node 找不到 `fetch.js`。

**修复**:`abspath` → `realpath`,解析到 `/mnt/c/Users/a3351/.claude/...` 真实路径,
`to_windows` 还原成 `C:\Users\a3351\.claude\...`,node 能找到。

### 坑十七:WSLENV 后缀方向

`CDP_HTTP` 要从 WSL 传到 Windows node,必须经 `WSLENV`(WSL 的环境变量默认不跨到
Windows 进程)。且 `WSLENV=CDP_HTTP/u` 的 `/u` 后缀表示"仅 Win→WSL",方向反了 ——
正确是不带后缀的 `WSLENV=CDP_HTTP`(双向)。

**修复**:`fetch_raw` 自动把 `CDP_HTTP` 加进子进程的 `WSLENV`,用户无需关心。

