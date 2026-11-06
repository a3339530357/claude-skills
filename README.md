# claude-skills

个人 Claude Code 技能集合，私有仓库。

## 包含的技能

| 技能 | 用途 |
|---|---|
| `bilibili-subtitle` | B 站视频字幕提取（官方 AI 字幕，带时间轴） |
| `capture-cc-v1-messages` | 抓取 Claude Code 发往 `/v1/messages` 的原始请求 |
| `claude-history-search` | 按关键词搜索本机历史对话 |
| `claude-jsonl-format` | Claude Code `.jsonl` 会话格式字典与提取工具 |
| `claude-session-thinking-repair` | 修复第三方网关切回官方模型时的 400 thinking 报错 |
| `claude-session-to-opencode` | 把 Claude Code 会话迁移到 opencode |
| `daily-work-summary` | 按天汇总 git / 各 AI 工具对话，出日报 |
| `douyin-subtitle` | 抖音字幕、搜索、作者作品、评论区 |
| `html-report` | 生成自包含 HTML 报告 |
| `session-handoff` | 会话交接文档 |
| `web-search` | 联网搜索（DeepSeek + 智谱 GLM），首次使用引导填 key |

## 不提交的内容（见 `.gitignore`）

- `*/data/cookie.json` —— 抖音 / B 站登录凭证
- `*/data/keys.json` —— 搜索引擎 API key（web-search）
- `certs/`、`*.key`、`*.pem` —— CA 私钥
- `douyin-subtitle/sensevoice/` —— 3.7 GB 的 SenseVoice 模型与 venv
- `synced/`、`node_modules/`、`logs/` —— 缓存与依赖

**新机器上使用时**，需要自己补：
1. `douyin-subtitle/data/cookie.json`、`bilibili-subtitle/data/cookie.json`（登录凭证）
2. `web-search/data/keys.json`（搜索 API key，或首次使用时按技能提示填）
3. `douyin-subtitle/sensevoice/`（只有需要本地转写时才要，见该技能 SKILL.md）

## 同步到服务器

```bash
./sync.sh              # 提交 + 推 GitHub + 同步到 yan / yan2
```

## 使用

技能目录软链到 `~/.claude/skills`，或在目标机器上：

```bash
git clone git@github.com:<user>/claude-skills.git ~/.claude/skills
```
