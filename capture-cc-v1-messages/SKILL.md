---
name: capture-cc-v1-messages
description: 抓取本机已安装的 Claude Code CLI（claude）实际发送到 https://api.anthropic.com/v1/messages 的完整 HTTP POST 请求，并导出为一个 JSON 文件，包含 url、method、完整 headers 和已解析的 body（model、system 提示词、tools、metadata、thinking、context_management、output_config、diagnostics、stream 等）。跨平台可用——Windows/PowerShell 用 capture.ps1，Linux/macOS/WSL 用 capture.sh——支持抓取两个入口：print/SDK 路径（claude -p，cc_entrypoint=sdk-cli）和交互式 TUI 路径（真实 pty，cc_entrypoint=cli），两者的 system prompt 和工具列表确实不同。对新版 claude（>=2.1.233 的 native 二进制，不再信任自签 CA）会自动改走 ANTHROPIC_BASE_URL 明文通道，所以 MITM 抓不到的情况下依然能拿到请求。当用户想查看、记录、逆向或对比当前 Claude Code 版本发往 Anthropic API 的确切请求结构时使用本技能——例如在构建兼容客户端、Claude Code 代理、模仿 Claude Code 请求结构的自定义技能，想对比交互模式与 print/-p 的 system prompt，或刚升级 claude 后想看看 system prompt / 工具列表 / beta headers 有什么变化。当用户说"抓一下 claude 的 v1/messages"、"看看 claude code 现在发什么请求"、"我要一份当前版本 claude 调用 API 的请求样本"、"导出 claude code 的 system prompt 和工具定义"、"交互模式和 -p 的系统提示词差在哪"、"capture claude code request body" 等类似话术时主动触发本技能——即使没提到 "v1/messages" 这个词，只要意图是获取已安装 claude CLI 正在发送的请求快照，也应使用。
---

# capture-cc-v1-messages

把本机已安装的 Claude Code CLI（`claude`）实际发往 `/v1/messages?beta=true` 的那一次 HTTP POST 完整抓下来，导出为一个 JSON 文件：

```json
{
  "capturedAt": "ISO 时间",
  "transport": "baseurl",
  "url":     "http://127.0.0.1:18899/v1/messages?beta=true",
  "upstreamEquivalent": "https://api.anthropic.com/v1/messages?beta=true",
  "caveat":  "...哪些字段因通道而失真...",
  "method":  "POST",
  "headers": { ... 完整的请求头 ... },
  "body":    { "model": "...", "messages": [...], "system": [...], "tools": [...], "metadata": {...}, ... }
}
```

`body` 是已解析的 JSON 对象（不是字符串），可直接用作 schema 参考。
`upstreamEquivalent` / `caveat` 只在 baseurl 通道出现（见下）；mitm 通道的 `url` 就是真实的 `https://api.anthropic.com/...`。

## 两个正交的维度

别把这两件事混为一谈——它们解决的是完全不同的问题：

**`--mode` = 抓哪个入口**。决定 claude 构造出什么样的请求。
**`--transport` = 用哪条通道截流量**。只影响我们怎么看到请求，不改变请求内容。

### `--mode`：print vs interactive

| | `--mode print`（默认） | `--mode interactive` |
|---|---|---|
| 触发方式 | `claude -p <prompt>`，一次性无人值守 | 真 pty 里开 `claude` TUI（`drive-interactive.py`） |
| billing header | `cc_entrypoint=sdk-cli` | `cc_entrypoint=cli` |
| User-Agent | `claude-cli/<ver> (external, sdk-cli)` | `claude-cli/<ver> (external, cli)` |
| 自我定义 | "You are a Claude agent, built on ... Claude Agent SDK." | "You are Claude Code, Anthropic's official CLI for Claude." |
| 工具 | 少若干个 | 多出 `AskUserQuestion`、`Artifact` 等交互专属工具 |
| `!` 前缀会话指引 | 无 | 有 |

两份 JSON 的 `tools` 数量和 system 文本不一致是**预期**的，不是抓错了。具体数量随版本变化——2.1.233 实测 print 11 个 / interactive 13 个，别把某个具体数字当常量。

**为什么交互模式非要 pty**：直接把 stdin 用管道喂给 `claude`（不带 `-p`）会被检测为非 TTY，自动降级成 print 模式。`drive-interactive.py` 分配伪终端、模拟"输入→回车→等请求→退出"，确保拿到的是真正的 `cc_entrypoint=cli` 请求。

### `--transport`：baseurl vs mitm

| | `baseurl` | `mitm` |
|---|---|---|
| 原理 | `ANTHROPIC_BASE_URL` 指向本地明文 HTTP 记录服务器 | 起 MITM 代理，自签 CA 解密 HTTPS |
| 对新版 claude | **可用** | 不可用（见下） |
| 请求体 | 100% 真实 | 100% 真实 |
| `Authorization` / `anthropic-beta` / `User-Agent` / `X-Stainless-*` | 真实 | 真实 |
| `Host` / `Connection` / `Accept-Encoding` | 反映本地端点 | 真实 |
| 响应 | 记录服务器合成的 401 | 真实响应（含 SSE 流） |
| 依赖 | 零依赖 | 需要 `node-forge` |

`auto`（默认）按 claude 是不是 native 二进制来选，选中 mitm 后若撞证书错误会自动回退 baseurl 重跑一次。

**为什么默认是 baseurl**：它零依赖、不碰证书，在任何 claude 版本上都能工作，失败模式也最少。mitm 通道能拿到真实 `Host` 头和真实响应，但对环境更挑剔。

**关于 `Self-signed certificate detected`**：曾经以为是 native 二进制（>=2.1.233）不认 `NODE_EXTRA_CA_CERTS`，**这个判断是错的**。真实原因是代理环境变量**大小写两套**——`HTTPS_PROXY` 和 `https_proxy`。像 reclaude 这类包装器启动 claude 时两套都会设置，脚本若只覆盖大写的，claude 仍旧连向包装器的代理，而 CA 却已被换成我们自己的，于是报自签证书错，看起来像"不认 CA"，实则是漏改。本脚本现在两套都覆盖，native 二进制上 mitm 通道实测可用。

排查同类问题时，先 `tr '\0' '\n' < /proc/<claude-pid>/environ | grep -i proxy` 看清楚它到底被指向了哪里。

## skill 自包含

这个 skill **不依赖任何外部项目**。skill 目录下自带：

```
<skill>/
├── SKILL.md
├── package.json                  # 依赖：node-forge（只有 mitm 通道用得到）
├── src/
│   ├── index.js                  # mitm 通道：代理 CLI 入口
│   ├── proxy.js                  # mitm 通道：MITM HTTP/CONNECT 代理
│   ├── ca.js                     # mitm 通道：自签 CA + 动态主机证书
│   ├── record-server.js          # ★ baseurl 通道：明文 HTTP 记录服务器
│   └── logger.js                 # JSONL 落盘（两条通道共用）
└── scripts/
    ├── capture.sh                # ★ 跨平台一键脚本（Linux/macOS/WSL）
    ├── capture.ps1               # Windows 一键脚本（PowerShell，仅 print 入口）
    ├── drive-interactive.py      # 交互模式驱动：在真 pty 里开 claude TUI
    └── extract-v1-messages.js    # 从 JSONL 抽出最完整的 v1/messages 一条
```

两条通道**写同一份 JSONL、同样的记录结构**，所以 `extract-v1-messages.js` 一套逻辑通吃，只是在产物里按 `transport` 字段决定要不要附 caveat。

运行时会在 skill 目录下生成：
- `node_modules/`（mitm 通道首次运行时 `npm install`）
- `certs/ca.pem` + `certs/ca.key`（mitm 代理首次启动时自签生成）
- `logs/<日期>.jsonl`（每次抓包追加）
- `logs/trigger.<mode>.<transport>.log`（claude 本次的输出，失败时拿它诊断）
- 输出 JSON：默认 `<skill>/v1-messages-<mode>.json`（可用 `--out`/`-Out` 改位置）

## 前置要求

- Node.js ≥ 18（验证：`node -v`）
- `claude` 在 PATH 中（验证：`claude --version`）
- **Linux / macOS / WSL**：bash（用 `capture.sh`）；交互模式还需 `python3`
- **Windows**：PowerShell（用 `capture.ps1`）

## 选哪个入口脚本

代理/记录服务器和 claude 必须**同侧**：

- `which claude` 落在 Linux/macOS 路径 → 用 **`capture.sh`**（推荐，最干净）
- 只有 Windows 侧 `claude.exe`、你在 PowerShell 里操作 → 用 **`capture.ps1`**
- WSL 里两侧都有 `claude` → 优先 Linux 侧 + `capture.sh`

## 执行流程

### Linux / macOS / WSL（`capture.sh`）

```bash
# 默认：auto 通道 + print 入口
bash "$HOME/.claude/skills/capture-cc-v1-messages/scripts/capture.sh"

# 交互入口
bash "$HOME/.claude/skills/capture-cc-v1-messages/scripts/capture.sh" --mode interactive

# 强制走代理（只在旧版 node claude 上有意义）
bash "$HOME/.claude/skills/capture-cc-v1-messages/scripts/capture.sh" --transport mitm
```

脚本自动完成：探测通道 →（mitm 才装依赖）→ 起服务（已监听则复用）→ 注入环境变量后按 mode 触发 `claude` → 等新的 `/v1/messages` 落盘 → 抽取 → 无论成功失败都清理掉自己起的进程。

### Windows（`capture.ps1`）

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.claude\skills\capture-cc-v1-messages\scripts\capture.ps1"
```

> `capture.ps1` 只做 print 入口。要抓 interactive，用 WSL 里的 `capture.sh --mode interactive`——pty 在 PowerShell 里没有等价物。
>
> **ps1 的 baseurl 通道尚未在真实 Windows 环境下端到端实测**（语法、版本探测、参数校验已验证）。跑出问题请回报。

### 参数

| 作用 | `capture.sh` | `capture.ps1` | 默认 |
|---|---|---|---|
| 抓哪个入口 | `--mode print\|interactive` | （仅 print） | `print` |
| 用哪条通道 | `--transport auto\|baseurl\|mitm` | `-Transport auto\|baseurl\|mitm` | `auto` |
| 输出路径 | `--out <path>` | `-Out <path>` | `<skill>/v1-messages-<mode>.json` |
| 触发 prompt | `--prompt <text>` | `-Prompt <text>` | `"你好，请只回复：OK"` |
| 端口 | `--port <n>` | `-Port <n>` | mitm 18888 / baseurl 18899 |
| 脱敏 | `--redact` | `-Redact` | off |
| 等待秒数 | `--wait <n>` | `-WaitSec <n>` | `25` |

`--prompt` 只是让 claude 发请求的载体，不影响抓到的 system/tools 结构。`--redact` 会脱敏 `Authorization`、邮箱、64 位 hex 设备指纹、UUID。

### 用户请求 → 命令对照

| 用户说 | 跑什么 |
|---|---|
| "抓一份给我" | 不带任何参数 |
| "抓交互模式的" / "我要 CLI 入口那份" | `--mode interactive` |
| "print 和交互都抓，对比一下" | 先 `--out a.json`，再 `--mode interactive --out b.json` |
| "我要真实的请求头 / 想看响应" | `--transport mitm`（只在旧版 claude 上能成） |
| "脱敏版本" / "我要发给别人" | `--redact` |
| "保存到当前目录" | `--out "$PWD/v1-messages.json"` |
| "用别的 prompt 触发" | `--prompt "..."` |
| "再抓一次跟刚才对比" | 重跑，把 `--out` 指到另一个文件名 |

## 重要事实（影响判断成功/失败）

1. **请求被拒不算失败**。baseurl 通道下记录服务器**故意**返回 401，claude 会打印 `Failed to authenticate. API Error: 401 ...`；mitm 通道下服务器常返回 403。这毫无影响——我们要的是**请求**，它在被拒**之前**就已经完整落盘了。看到这类报错是预期的，**不要重试，不要报错**。

2. **判断成功的唯一标志**是第 4 步打印出 `written: <path>` 和随后的统计：
   ```
   written: .../v1-messages-print.json
     transport      : baseurl
     body bytes     : 49958 (Content-Length: 49958)
     body keys      : model, messages, system, tools, ...
     tools          : 11 -> Agent, Bash, Edit, ...
     system blocks  : 3
   ```
   `body bytes == Content-Length` 是完整性自校验；对不上时抽取脚本会直接报错退出（rc=5），不会让你拿着半份 JSON 去分析。

3. **一次触发通常产生 2 条 `/v1/messages`**（claude 会重试一次）。`extract-v1-messages.js` 取**本次新记录里最大的那条**——正是想要的。`--skip-lines` 保证同一天先后抓 print/interactive 不会串味。

4. **产物里的 `Authorization` 是真实凭据**。要分享给别人务必加 `--redact` 重跑。脚本在未脱敏时会主动提醒。

5. **CA 仅注入到 claude 进程**（mitm 通道），不污染系统证书库或浏览器。

6. **退出码**：0 成功 / 3 证书信任失败（auto 会据此回退）/ 4 其它没抓到 / 5 请求体不完整。

## 失败排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `Self-signed certificate detected` | 小写 `https_proxy` 没被覆盖，claude 仍连着别的代理（如 reclaude），CA 却换成了我们的 | 本脚本已两套都覆盖；手工复现时记得同时设 `HTTPS_PROXY` 和 `https_proxy` |
| 交互模式只抓到几百字节 | TUI 先发认证探测，拿到 401 就判定 `Login expired`，不再发真正的对话请求 | 记录服务器需返回合法成功响应（`--fake-ok`，interactive 模式已自动开启） |
| `claude: command not found` | claude 不在 PATH | 让用户先装 claude code |
| `node: command not found` | 没 Node.js | 让用户装 Node ≥ 18 |
| 服务起不来 | 端口被占且不是我们的服务 | `--port` 换一个端口 |
| `没有新的 /v1/messages 记录` | claude 没真的发出请求 | 看 `logs/trigger.<mode>.<transport>.log`；确认 `claude --version` 能跑；还在登录流程的话先登录 |
| `body bytes != Content-Length` | 日志被截断 | 重跑；持续重现就报告 |
| `body.tools` 为空 | 抽到了轻量探测请求 | 把 `--wait` 加大到 40 重跑 |
| 交互模式抓成了 print 结构 | pty 驱动没起效或 claude 降级 | 确认有 `python3`；`--wait` 调大 |

## 输出契约

成功时同时满足：
- 文件已写出且为合法 JSON
- `body.model` 非空（如 `"claude-opus-5"`）
- `body.tools.length ≥ 9`（interactive 比 print 多几个）
- `body.system.length ≥ 2`
- `body bytes == Content-Length`

向用户报告：一两句话总结产物（"已生成 v1-messages-<mode>.json，X 字节，Y 个工具、Z 个 system 块，入口=print/interactive，通道=baseurl/mitm"），贴文件绝对路径，未脱敏时提醒里面有真实凭据。**不要**把整份 JSON 贴回会话——文件本身就是交付物。
