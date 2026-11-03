---
name: claude-session-thinking-repair
description: 诊断并修复 Claude Code 会话从 DeepSeek、GLM、Kimi 等第三方网关切到官方 Claude 模型时出现的 400「each thinking block must contain non-whitespace thinking」。当用户遇到这个报错、问 /compact 后为什么还报错、想不新建会话而清洗历史 thinking、检查 compact preservedSegment，或要求备份/回滚会话存档时使用。也适用于其他官方 API 拒绝空签名、空白或 redacted_thinking 历史块的会话修复；不要用于一般 jsonl 导出（用 claude-jsonl-format）。
---

# Claude Code 会话 thinking 修复

先读 `claude-jsonl-format` 技能确认会话格式，再使用 `scripts/repair.mjs`。格式没有公开 schema，只对本机当前记录结构做保守修复；不要伪造签名，也不要把思考内容当正文补回。

## 先判断值不值得修

- 当前会话还能在第三方模型下继续时，优先继续完成工作，再处理存档。
- 只想用官方模型且没有保留上下文的必要，新会话更稳妥。
- 想保留当前上下文时，做修复。代价是丢弃历史思考块，正文、工具调用、工具结果、附件和压缩摘要保留。
- **不能热修，必须先退出再修**：会话进程每次工具调用都往存档追加；在会话里或刚退出就立刻 `claude -c` 时跑 `--apply`，会因「读取后原文件发生变化」中止（这是保护，不是故障）。即便侥幸写入，后续追加的记录也可能挂到已删除的 uuid 上。正确顺序：完全退出该会话 → 从另一个 shell 跑修复 → 看到 `applied: true` 后再 resume。
- 官方 API 的 cryptographically signed thinking 只应原样保留；如果同一 `message.id` 下还有无签名块，整个回合也按不可验证处理。

## 1. 定位并只读诊断

```bash
node <skill目录>/scripts/repair.mjs "<会话.jsonl>"
```

输出包括：
- 非法/不可验证 thinking 块（`untrustedReasons` 分原因、`thinkingByModel` 分模型）及受影响的压缩保留段；
- `brokenLines`：写盘中断造成的拼接坏行（半截旧记录 + 完整新记录在同一行），可恢复；`invalidJson` 只列无法恢复的行；
- 将删除多少纯思考记录、重接多少父链；
- 原有 JSON、UUID 重复、父链、空内容异常。

诊断不创建或修改文件。先读报告，向用户说明将丢弃历史思考、需要关闭会话验证，并取得修复该具体文件的同意。

## 2. 备份并修复

```bash
node <skill目录>/scripts/repair.mjs "<会话.jsonl>" --apply --backup-dir "<项目目录>/<顶层修复目录>"
```

`--apply` 才写原文件。**`--backup-dir` 是可选的**：给了就在该目录下建带时间戳的新目录，复制完整原文件并记录 SHA-256 与 manifest，之后可用 `--restore` 回滚；不给则**不留备份**，脚本会打印一行警告，失败后无法回滚，且此时 `--restore` 不可用。推荐给备份目录——会话存档不可再生，磁盘代价通常只有几十 MB。

无论是否备份，脚本都先在同一目录下生成修复文件、跑完 JSON/UUID/父链/内容数量校验，确认原文件自读取后未变化，才替换原文件；任何一步失败都不替换。不备份时用的临时工作目录建在会话文件同目录下（`.repair-tmp-*`），成功后即删，不落系统临时目录。

修复策略：
1. 只处理顶层 `message.content` 数组里的 `thinking` / `redacted_thinking`。
2. 默认删除不可信思考块：无签名、空白思考、以及**假签名**（GLM、DeepSeek 等网关会塞 24/36 字符的 UUID 片段冒充；官方签名是上千字符 base64，脚本以 ≥200 字符 base64 为可信下限）。纯思考记录整行删除，避免留下空消息。
3. 同一记录还有正文或工具块时，仅删除思考块。
4. 子记录引用被删 UUID 时，沿祖先链重接到最近的保留节点；保留其他字段。
5. 不动 `api-request*` 调试快照（内容寻址，改了会与 hash 不符），不把它们当对话历史。
6. 有 `brokenLines` 时须加 `--recover-broken-lines` 才会修：取能解析的后缀记录；它自带的父节点不存在而前缀里的父节点存在时，接回前缀父节点。
7. 校验 JSON、UUID 唯一性、非空内容、父链，以及正文/工具调用/工具结果数量不变。

如需丢弃所有思考（包括看似真签名的块），先向用户说明，再使用 `--all-thinking`。一般不需要：默认模式已会删除假签名，只保留官方模型自己产出的思考。

## 3. 验证和回滚

```bash
node <skill目录>/scripts/repair.mjs "<会话.jsonl>"
node <skill目录>/scripts/repair.mjs "<会话.jsonl>" --restore "<备份目录>/original.jsonl" --yes
```

- 再次诊断应显示 `repairNeeded: false`，但这不是官方 API 已接受的证明。
- resume 后切官方模型，发一个简单请求；只有请求成功才算验证完成。
- 确认请求**真的发给了官方模型**：看存档最新 `api-request` 记录的 `params.model`。`ANTHROPIC_MODEL`、`ANTHROPIC_DEFAULT_OPUS_MODEL` 等环境变量可能把 `/model` 里的「Opus」映射成第三方模型，此时没报错也不代表验证通过。
- 修好的会话里不要再切回第三方模型聊天，否则会重新写入无签名思考，下次切官方又会 400，需要退出后再修一次。
- 仍有 400 时不要继续猜改；有备份就保留，把新错误与诊断结果一起报告。
- 回滚会覆盖当前文件，必须先确认目标文件和备份的哈希/路径，并取得用户同意；`--yes` 不代表可以替用户同意。没留备份的修复无法回滚。

## 边界

- 不自动关闭或杀 Claude Code 进程。
- 不自动压缩、删除其他会话或清理备份。
- 不把会话内容、API key、cookie 或存档上传给外部服务。
- 不把清洗后的会话称作「签名已验证」；脚本只能检查存档结构和删除不可验证块。
