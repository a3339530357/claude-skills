---
name: web-search
description: 联网搜索与抓取网页，接 DeepSeek 和智谱 GLM 两个搜索引擎，用用户自己的 API key。当 WebSearch 工具不可用、返回空、被限流，或用户明确要"搜一下/查一下/找最新的/看看网上怎么说/这个报错是什么原因/有没有人遇到过"，以及需要抓取某个具体网页的原文而非摘要时使用。也用于需要时间筛选（一周内/一个月内）、限定站内搜索（只搜某域名）、或需要搜索结果的权威度评分来筛信源的场合。即使没提"搜索"二字，只要问题需要当前网页上的信息而不是模型记忆里的知识，都应先查这个技能。
---

# 联网搜索

两个搜索引擎，一套命令行。**默认 DeepSeek，GLM 作为备用和补充。**

选 DeepSeek 的理由：REST JSON 接口简单、返回字段全（有 `rerank_score` 相关性分和 `authority` 权威度分，能用来筛信源）、还额外提供抓单页转 Markdown 的能力。GLM 的优势是支持时间筛选和域名筛选——这两个 DeepSeek 没有。

## 第一次用：先确认 key

脚本不自己做交互式提问（在 agent 里跑 readline 会卡住），**问用户、存 key 这两步由你做**。

先看状态：

```bash
node <skill目录>/scripts/search.mjs --status
```

输出长这样，`(未设置)` 的那个就是缺的：

```
后端        key                  来源
────────────────────────────────────────────────────
DeepSeek    sk-9207…7649         data/keys.json
智谱 GLM    (未设置)             —
```

**只要默认后端（DeepSeek）有 key，就已经能用了**，不必强求两个都有。缺的那个等到真正需要它的功能时（GLM 才有时间/域名筛选）再找用户要。

### 缺 key 时怎么问

不要只说"请提供 API key"，要说清楚**去哪拿、长什么样**，用户才能一次给对：

> 需要一把 DeepSeek 的 API key 才能联网搜索。
> 拿法：登录 https://platform.deepseek.com/api_keys → 创建 API key，复制以 `sk-` 开头的那串。
> 计费是按次：5 元 / 1000 次成功请求，失败和无结果不计费。
>
> 或者你手上有智谱 GLM 的 key 也行（https://open.bigmodel.cn/usercenter/apikeys，形如 `xxxx.xxxx`），我改用 GLM 搜。

用户给了之后，**用 stdin 存进去，别把 key 拼在命令行参数里**（会留在 shell 历史和进程列表里）：

```bash
printf '%s' "<用户给的key>" | node <skill目录>/scripts/keys.mjs set deepseek
```

存完回显的是脱敏值（`sk-9207…7649`），拿这个跟用户确认对不对。

### 存到哪、会不会泄露

`<skill目录>/data/keys.json`，同目录有 `.gitignore` 写的是 `*`，整个目录不进 git。

这个技能目录是个 git 仓库，还会 `sync.sh` 推到 GitHub 和两台服务器——所以**key 一旦写进脚本或 SKILL.md 就是公开的**。脚本里没有任何硬编码的 key，这点不要改回去。

`keys.mjs set` 每次写完都会检查 `.gitignore` 还在不在，防止有人误删后把 key 提交上去。

### 环境变量可以临时覆盖

`DEEPSEEK_API_KEY` / `GLM_API_KEY` 优先于文件。用户说"这次用另一把 key 试"时用这个，不要覆盖已存的。

## 搜索

```bash
node <skill目录>/scripts/search.mjs "查询词"
node <skill目录>/scripts/search.mjs "查询词" -n 5
node <skill目录>/scripts/search.mjs "查询词" --content      # 带正文，DeepSeek 专属
node <skill目录>/scripts/search.mjs "查询词" --json         # 原始数组
```

### 换后端

```bash
node <skill目录>/scripts/search.mjs "查询词" --backend glm
```

不指定时默认 DeepSeek；如果 DeepSeek 没 key 而 GLM 有，会自动切过去并在 stderr 说一句。

### 只有 GLM 有的筛选

```bash
--recency oneDay|oneWeek|oneMonth|oneYear
```

**用户说"最近一周的"、"最新的"时用 GLM。** 实测有效，返回的条目确实落在时间窗内。

脚本会在强行给 DeepSeek 传 `--recency` 时打一行 warning 说该选项被忽略——因为默默忽略最坑，用户会以为筛选生效了。

### 站点限定：用 DeepSeek 的 `site:`，别用 `--domain`

```bash
node <skill目录>/scripts/search.mjs "MCP 协议 site:modelcontextprotocol.io"     # ← 这样
```

**不要用 `--backend glm --domain example.com`。** 2026-11-06 实测：GLM 的 `search_domain_filter` 参数在服务端**根本不生效**——传一个绝对不存在的域名，照样返回 10 条不相关的全局结果。参数名是对的（`tools/list` 里就写着），所以不是传错，是服务端没执行。

脚本只能拿到结果后自己按 hostname 过滤，但 GLM 一次只给约 10 条全局结果，限定站点后经常剩 0–1 条。所以这个参数留着是为了以后可能修好，**实际站点搜索一律用 DeepSeek 的 `site:`**——那个是服务端执行的，实测全部命中。

### 条数：GLM 不支持

GLM 的 `web_search_prime` 没有条数参数，一次固定返回它认为相关的全部结果（通常 7–10 条）。传 `-n 3` 会在 stderr 提示未生效。**要精确控制条数就用 DeepSeek。**

## DeepSeek 的搜索语法

这些操作符**原样传给服务端**，不用转义：

| 写法 | 含义 |
|---|---|
| `site:github.com` | 限定站内；多个用 `OR` 连。**实测有效，是站点搜索的正路** |
| `-site:example.com` | 排除某站 |
| `-"精确短语"` | 精确匹配 |
| `-关键词` | 排除关键词 |
| `lang:zh,en` | 限定语言 |
| `after:2025-01-01` / `before:2026-01-01` | 时间范围（DeepSeek 用这个代替 GLM 的 `--recency`） |

## 抓单个网页

```bash
node <skill目录>/scripts/search.mjs --fetch https://example.com/article
```

**但优先用自带的 `WebFetch`。** 它中间有个小模型在做提炼，问"这个页面说了什么"更省事也更全；DeepSeek Fetch 是纯搬运，返回原始 Markdown，适合要原文、要精确的哈希/版本号表格、或者写脚本批量处理。

实测同一页面：WebFetch 问"列出所有 SHA256"会真的列全 5 个；Fetch 原样返回，但容易被后续截断逻辑砍掉。认证页面两边都不行。

## 读结果时的判断

DeepSeek 返回三个能帮你筛信源的字段：

- `score`（`rerank_score`，0–3）：**≥1.5 算优质**，低于 1 的基本是沾边
- `authority`（0–4）：**≥3 极权威**（官方文档、政府站），`-1` 是未知
- `date`：UTC 日期。**技术类问题优先看日期新的**，旧文档里 API 可能已经不这么用了

GLM 只返回 `title` / `link` / `content`，没有评分。而且它的结果里会混一部分 `https://www.google.com/goto?url=...` 的跳转链接，脚本已经把它们识别掉、显示成「(无可直接访问的地址)」——**别把这种链接给用户**，想办法从标题和摘要里找真实地址。

## 用搜索结果回答时

用户问的通常是"怎么做 X"、"这个报错是什么意思"，不是"给我列 10 个链接"。所以：

1. **先去读**最权威的几条（官方文档优先，看 `authority` 和域名），别只念 snippet
2. 需要细节就用 `--fetch` 或 WebFetch 抓原文
3. 回答里**带上来源链接**，尤其是版本号、API 参数、价格这类会变的事实
4. **搜不到就说搜不到**，别用模型记忆补。用户装了这个技能就是为了拿真实网页内容，混进记忆里的旧知识比"没找到"更糟

## 出错怎么办

| 表现 | 原因 | 处理 |
|---|---|---|
| 退出码 3，`NO_KEY:deepseek` | 没 key | 按上面「第一次用」的流程找用户要 |
| `HTTP 401` | key 无效或过期 | 让用户重新生成一把，用 `keys.mjs set` 覆盖 |
| `HTTP 402` | 余额不足 | 告诉用户去充值，或切 GLM |
| `HTTP 429` | 超 QPS | 等一下重试；Seach 限 100 QPS，Fetch 限 25 |
| `HTTP 408` / `5xx` | 服务端抖动 | 可以重试 |
| 其它 4xx | 参数错 | **别原样重试**，先看错在哪 |
| `GLM initialize 失败` | 网络或 key 问题 | 先 `--status` 确认 key 在，再看网络 |
| GLM 返回 0 字节 / 空 | 偶发抖动 | 重试一次；一直这样说明接口变了 |

## 关于计费

DeepSeek 按成功请求计费（5 元 / 1000 次），`-n` 只控制条数不影响价格。所以**要 5 条就 `-n 5`，别默认拉 10 条再自己筛**。GLM 走智谱的额度，规则见对方的控制台。

## 脚本分工

| 文件 | 作用 |
|---|---|
| `scripts/search.mjs` | 统一入口，解析参数、调度后端、排版输出 |
| `scripts/providers.mjs` | 两个后端的实现，把差异收敛成同一个返回结构（`title/url/snippet/content/site/date/score`） |
| `scripts/keys.mjs` | key 的读取、保存、脱敏展示、状态查询 |
| `data/keys.json` | 实际存储位置，**不进 git** |
