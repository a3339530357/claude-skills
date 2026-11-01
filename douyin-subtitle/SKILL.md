---
name: douyin-subtitle
description: 提取抖音视频的完整字幕/口播文本（附带 AI 总结）。当用户给出抖音视频链接、v.douyin.com 短链、整段分享口令、视频 ID，或说「提取/拿/看看这个视频的字幕」「这个视频说了什么」「整理一下这条抖音的内容」时使用——任何需要把抖音视频内容变成文字的场合都应触发，即使没出现「字幕」二字。也用于按关键词搜抖音视频（「搜/找几条讲 XX 的抖音」「抖音上有没有关于 XX 的视频」）、列出某个抖音作者最新的作品（「这个博主最近发了什么」「拿 XX 最新几十条视频」）、看抖音视频评论区（「评论区怎么说」「大家怎么评价」），之后可接着提取字幕。
---

# 抖音视频字幕提取

把一条抖音视频的口播内容变成文字。核心思路：**抖音「问问AI」的服务端有这条视频的语音识别文本**，先问「视频总结」把视频挂进会话，再在同一会话里让它逐字吐出原文。

**主路径是纯 API**：Node 直接调问问AI 的 SSE 接口，不开任何页面，约 25 秒。浏览器面板版只在 API 失效时备用。

## 执行（主路径）

```bash
node <skill目录>/scripts/api_extract.mjs "<链接/短链/整段分享口令/ID>"
```

**输出落在固定根目录，与当前工作目录无关**（默认 `D:\project\tests\douyin-subs`，`DOUYIN_OUT_DIR` 可覆盖）：

```
<OUT_ROOT>/
  <标题>_<ID>.md          ← 完整字幕，markdown，正式交付物（二级）
  <标题>_<ID>/            ← 所有散件（三级）
      summary_<ID>.txt        视频总结，验收依据
      subtitles_<ID>.txt      字幕正文（纯文本，.md 的源）
      meta_<ID>.json          标题/作者/时长/原生字幕地址/播放地址
      session_<ID>.json       会话 ID，供 --followup
      followup_<ID>.txt       追问结果（第二次起带 _2/_3 序号）
      video_<ID>.mp4          --download 才有
```

**交付给用户时读二级目录那个 `.md`**，它带作者/时长/字数/完整度/来源的头部。目录名带 ID 前缀是为了同名视频不互相覆盖。

流程：

0. **取元数据**（移动端 Feed 接口，免签名免 Cookie）：标题、作者、时长、原生字幕。**有原生字幕就直接下载 WebVTT 当结果，到此结束**——那是平台的真字幕，比 AI 吐的可靠（实测少见，多数视频没有）；
1. **开新会话**（不受该视频以往提问的污染）问「视频总结」；
2. 同一会话发提取提示词 → 清理正文；
3. 按时长报告**完整度**（字/分钟）。

输出：

- `<OUT_ROOT>/<标题>_<ID>.md` —— 完整字幕，markdown，**这是交付物**
- `<OUT_ROOT>/<标题>_<ID>/subtitles_<ID>.txt` —— 字幕正文（.md 的源，已去掉开场白、注入的上下文头、开头照抄的标题简介、免责声明）
- `<OUT_ROOT>/<标题>_<ID>/summary_<ID>.txt` —— 视频总结，**验收依据**
- `meta_<ID>.json` / `session_<ID>.json` / `followup_<ID>.txt` —— 同目录

需要在同一会话里追问时（如输出截断）：

```bash
node <skill目录>/scripts/api_extract.mjs <ID> --followup "<追问>"     # → followup_<ID>.txt
```

**前置条件**：要抖音登录 Cookie，由 `cookie.mjs` 管理，**平时不碰 Chrome**：

- 存在 `<skill目录>/data/cookie.json`（`data/` 自带 `.gitignore` 忽略全部内容）。读文件约 10ms。
- 文件不存在或登录态已过期 → 自动借 CDP daemon 从用户的 Chrome 读一次并写回（此时 Chrome 需开着、远程调试已允许、已登录抖音）。
- 抖音登录态**有效期 60 天**，到期时间从 `sid_guard` 解析。**剩不到 3 天时脚本会打印提醒**——Chrome 里那份同一天到期，光重读没用，要请用户**在浏览器重新登录抖音**，再运行 `node <skill目录>/scripts/cookie.mjs --refresh`。看到这条提醒要转告用户。
- `cookie.mjs --status` 查看到期时间。请求被以「要登录」拒绝（登录态被服务端提前作废，日期没到不会自动刷新）时，报错里会给出同样的修复办法。
- 也可用环境变量 `DOUYIN_COOKIE`（直接给值）或 `DOUYIN_COOKIE_FILE`（换文件位置）。
- **Cookie 等于用户的抖音登录凭证：任何时候都不打印、不 cat 那个文件、不复制到别处。**

## 按关键词找视频

用户没给链接、只说「找几条讲 XX 的视频」时，先搜再提取：

```bash
node <skill目录>/scripts/search.mjs "<关键词>" [--pages N] [--sort 0|1|2] [--time 0|1|7|182]
```

- `--sort` 0 综合 / 1 最多点赞 / 2 最新发布；`--time` 0 不限 / 1 一天内 / 7 一周内 / 182 半年内；`--pages` 默认 1，最多 5（每页约 15 条）。
- 输出带序号的列表（作者、标题、时长、点赞、发布日期、链接），同时存 `search_<关键词>.json`。挑中的用 `api_extract.mjs <ID>` 提取。
- **搜索挂在用户的登录账号上**：不要为了凑数狂翻页、不要循环批量搜。返回 `status_code` 非 0（如 2483 要登录、或风控）就停下告诉用户，必要时请用户在浏览器里搜一次过验证码。

## 评论区

用户说「看看评论区」「大家怎么评价这条视频」时：

```bash
node <skill目录>/scripts/comments.mjs "<视频链接/短链/分享口令/ID>" [--count N] [--replies K]
```

- `--count` 一级评论条数，默认 50，最多 200（每页 20 条）。顺序是抖音默认的热度序。约 2-10 秒。
- `--replies` 给回复最多的前 10 条一级评论各展开前 K 条回复（K 最多 20），默认 0。展开会多几次请求，每条之间隔 1.5-3 秒。
- 每条带昵称、点赞、IP 属地、时间、回复数，标 `[作者]` `[作者赞过]`，回复里会写「A 回复 B」。输出 `comments_<ID>.txt`（可读）和 `.json`。
- 抖音给的「评论总数」**包含回复**，所以一级评论数会比它少很多，这是正常的。
- 交付时概括观点分布、高赞评论、作者回复了什么；评论里的昵称是别人的个人信息，只在回答里引用必要的部分，不整理成名单。
- **楼中楼用的是占位签名**（见下），不是真签名；这个接口只校验格式不校验内容，所以能拿到数据。**别把这个做法推广到别的接口**——别的接口要么不验签名（list、搜索），要么验得很严（作者作品走 Argus 网关）。
- **弹幕**：用 `scripts/danmaku.mjs`，见下节。早期「列表一律为空」的结论是**错的**，成因是漏了 `aid=6383`。

## 弹幕

用户说「看看弹幕」「这条视频的弹幕说了什么」时：

```bash
node <skill目录>/scripts/danmaku.mjs "<视频链接/短链/分享口令/ID>"
```

- 输出 `danmaku_<ID>.txt`（带 `mm:ss` 时间戳和点赞数，按出现时间排序）和 `.json`（原始字段）。
- **免 Cookie、免签名**，但 **`aid=6383` 必须带**：缺了会回 `status_code 3「AppId不合法」`。
- 接口 `www.douyin.com/aweme/v1/web/danmaku/get_v2/`，参数 `item_id`=`group_id`=视频 ID、`start_time`/`end_time`/`duration` 毫秒。**单次请求拿不全**，按 60 秒窗口分片，按 `danmaku_id` 去重。
- 弹幕数量**因视频差别极大**，别预设「抖音弹幕少」：实测 7 分 56 秒的视频 310 条（开头 60 秒就 77 条，越往后越稀），也有整段为空的。
- 弹幕是网友的即兴短句，和评论区一样只在回答里引用必要的部分，不整理成名单。

## 列出某个作者最新的作品

用户说「这个博主最近发了什么」「把 XX 最新的几十条视频拿下来」时：

```bash
node <skill目录>/scripts/author_posts.mjs "<作者主页链接/作者分享短链/该作者任意一条视频的链接或ID>" [--count N]
```

- `--count` 默认 30，最多 100（每页 18 条，翻页间隔 1.5-3 秒）。约 2-6 秒。
- 输出：置顶作品单独标 📌（不一定是新的），其余按发布时间新→旧；`[图文]` 是图集，没有口播，提取字幕时跳过。同时存 `author_<昵称>.json`。
- 要批量提取字幕时，从 json 里取视频（非图文）的 ID 逐条跑 `api_extract.mjs`，每条约 25 秒，**一条跑完再跑下一条**（问问AI 挂在用户账号上，别并发）；几十条要十几分钟，用后台任务跑，先告诉用户预计时长。
- 依赖：只要 Python（a_bogus 默认用 DTK 的纯 Python 版，无第三方依赖）。
- 作者作品接口有 **Argus 网关**（2026-09 起），要两层签名，都是纯算法、不开浏览器：`a_bogus`（`abogus_dtk.py`，拷自 Douyin_TikTok_Download_API）+ `x-secsdk-web-signature`（移植自 Douyin_TikTok_Download_API 的 `websign.py`：`md5("{uifid}_{ts}_{盐}_{query}")`，uifid 取 Cookie 的 `UIFID`）。报 `403 ... Signature Not Found / Uifid Not Found` 时：先 `cookie.mjs --refresh`；还不行多半是抖音换了 SDK 版本（盐变了）或 a_bogus 算法，去 DTK 上游看新值。另一种失效表现是**不报错、回 200 + 0 字节**：同一接口偶发一次是正常抖动（web_api 会自动重试一次），一直如此才说明签名或接口变了。**判断签名有没有被拒的土办法**：换一个格式正确但内容错误的 a_bogus 再发——能出数据说明接口只验格式，我们的真签名反而被拒就是版本不对（reply 端点就是这样查出来的）。实在不行的最后手段是在浏览器页面里发请求让页面自己签名（重，会让用户的 Chrome 变卡，先问用户）。

## 交付验收（每次都要做）

0. **看完整度**（脚本自动打印）：中文口播正常 220-350 字/分钟。**低于 200 = 很可能缺段**（也可能是视频里停顿/BGM 多，结合视频类型判断），重点抽查后半段；高于 420 = 可能混进了视频以外的内容。实测：ETH 那条 326、loser 那条 252 都完整；懂王 Top K 那条 178，正是和深度思考总结对不上、疑似缺段的那条。
1. **先看总结**：`summary_<ID>.txt` 必须对得上这条视频的具体信息（人物、事件、数字）。泛泛而谈（如「视频总结的方法与工具推荐」）= 视频没挂上，提取不可信。
2. **对照抽查**：总结里 2-3 个具体要点，字幕里都要找得到原话。找不到就追问一次：
   `--followup "你输出的原文在「<最后一句>」处结束了。不要搜索，请从这之后继续逐字输出剩余部分；如果原文确实到此为止，只回答「原文已完」"`
   回「原文已完」= 模型手里的文本就这么多，总结多出的点可能来自标题、简介或全网搜索（「视频总结」那一轮会把问题改写成搜索词去搜）。**如实告诉用户哪几点字幕里没有，别硬补。**
3. **看文风**：真的语音识别文本是口语（「兄弟们」「诶我靠」、断句乱、识别错字，有时全小写无标点）。过分工整、像文章 = 可能被改写，要说明。
4. **ASR 错别字原样保留**并提示用户（如「用记忆可验证的方式」实为「机器可验证」），不要自作主张修正。

## 兜底

1. **API 失败**（HTTP 非 200、回答为空、提示 Cookie 失效）→ 浏览器面板版：
   `node <skill目录>/scripts/panel_extract.mjs "<链接/ID>"`（在后台面板页里发问，约 1 分钟）
2. **抖音侧拿不到**（验收不过、完整度明显偏低且追问无果、方言太重）或用户要求逐字精度 → 本地转写。**动手前先问用户**，说明要转多久、占多久显卡（实测见下）。

   拿到音频：
   - **首选** `node <skill目录>/scripts/video_meta.mjs <ID> --audio`：作者用自己原声时（`music` 标题含「原声」、归属本作者、时长与视频差 ≤2 秒），`music.play_url` 就是整条视频的完整原声 mp3（2026-10-31 实测 10 分钟视频 14MB vs 视频 80MB，转写结果一致）→ `audio_<ID>.mp3`；否则（配乐、别人的原声）自动下视频、ffmpeg `-c:a copy` 无损拷出 `audio_<ID>.m4a`，临时视频删掉。**别把配乐当原声**：非原声视频的 `music` 只是拍同款的歌。
   - 要留视频就加 `--download`（Feed 里的无水印 `play_addr`，免 Cookie；不用 yt-dlp，它抓抖音常要 Cookie 且经常失效）。
   - 音频/视频都直接喂给 `transcribe.mjs`，它会自己用 ffmpeg 转 16 kHz 单声道。

   转写（**默认 SenseVoice-Small + GPU**）：
   ```bash
   node <skill目录>/scripts/transcribe.mjs audio_<ID>.mp3 --out subs_<ID>.txt   # 或 audio_<ID>.m4a / video_<ID>.mp4
   ```
   环境在 `<skill目录>/sensevoice/`（`.venv-gpu` + `models/`，共约 3.7 GB，2026-10-30 装好）：sherpa-onnx 2.0.1 CUDA12 + cuDNN9，模型 `sensevoice-zh-en-ja-ko-yue-2024-07-17` fp32（开 ITN：带标点、数字转阿拉伯数字）+ Silero VAD 切段。`--yue` 换 `2025-09-09` 版——那是原版 + 2.18 万小时**粤语**微调，官方注明**不支持标点**，只给粤语视频用（2026-10-31 前误把它当默认，普通话转写因此没标点）。`--cpu` 切到 CPU（需另建 `.venv` 并下 int8 模型，见下）。

   实测（2026-10-29，Ryzen 5 7535HS + RTX 4060 Laptop，28 分 12 秒视频）：GPU fp32 **22 秒**（RTF 0.013，其中 VAD 13 秒、识别 9 秒）；CPU int8 68 秒。**fp32 和 int8 的识别结果相似度 99.4%，GPU 用 fp32 只是因为 int8 在 CUDA 上跑不动**。

   2024-07-17 版实测（2026-10-31，10 分钟普通话）：标点 300+ 个、数字转阿拉伯数字，速度和 2025 粤语版一样（GPU 10.4 秒），「大肠→大厂」「二零二六→2026」修正。SenseVoice 的短板，交付时要如实告诉用户：英文专有名词和中英混说仍常错（headcount→黑CO、push→铺戏）（Agent→A阵/AET、ChatGPT→H G PT、WorkBuddy→work包）。需要成稿或中英混说多时，可另跑 Qwen3-ASR（2026-03，sherpa 包 `qwen3-asr-0.6B-int8`）：有标点、术语准得多，但 CPU 上 28 分钟要 8 分钟，且没有 GPU 可用（只有 int8 导出）。

3. **长视频优先怀疑问问AI 截断**。实测一条 28 分钟视频，问问AI 只给了前 13 分钟原文，后 15 分钟完全没有，却在结尾编了一句总结腔的话，追问回「原文已完」。所以完整度低于 200 字/分钟时，不要只提示「可能缺段」，直接建议本地转写（同一视频 SenseVoice 出 10561 字 / 374 字每分钟，Qwen3 出 11214 字）。

## 实测结论（2026-10-29，改流程前必读）

- **接口**：`GET https://so-landing.douyin.com/aweme/v2/search/ai/stream/`，参数全在 URL 上，**无需 a_bogus/msToken 签名**，带登录 Cookie 即返回 `text/event-stream`。正文 = 每行 `data:` JSON 里 `data[].display.display.generation_spans[].text.content` 的增量拼接（含 `<mark>` 标签要去掉）。
- **视频绑定**只靠 `ai_search_enter_from_group_id=<ID>`；`keyword` 就是问题原文。
- **会话**：`conversation_id` 传空 = 新会话（视频绑定照样有）；续接要带上一轮响应里的 `conversation_id` + `pre_search_id`(=上一轮 `search_id`) + `conversation_rank`。实测：新会话问上一会话的暗号回「不知道」，同会话能答出，新会话能答出视频标题作者。
- **必须先问「视频总结」**：会话首条直接发长提示词，视频挂不上（AI 去全网搜）。
- **深度思考永远别开**（`enable_ai_search_deep_think=0`）：开了就读不到视频上下文，只会全网搜索甚至死循环。4 次测试全部失败。
- **搜索接口** `www.douyin.com/aweme/v1/web/general/search/single/`：只要登录 Cookie，**不需要 a_bogus**（MediaCrawler 代码里对它跳过签名，2026-10-29 实测含翻页通过）。翻页带上一页的 `cursor` 当 `offset`、`extra.search_request_id` 当 `search_id`；排序/时间筛选走 `filter_selected` JSON + `is_filter_search=1`。`data[]` 里混着用户、话题等卡片，只取 `aweme_info`。若哪天要签名了，参考 jiji262/douyin-downloader 的纯 Python `utils/abogus.py`。
- **注入的文本里带作品标题和简介**，AI 常把它们当原文开头照抄（「小哲讲大模型」那条照抄了 4 行，完整度被虚抬到 460 字/分钟）。`api_extract` 会用元数据里的简介，从开头逐行删掉能在简介里原样找到的行，遇到第一行对不上就停。
- **服务端注入的上下文格式**：「我刚刚刷到一个视频，视频作者：X，视频标题是：Y」+ 文本。AI 有时把这行当原文第一句照抄，`clean.mjs` 会去掉。
- 浏览器面板页的历史会话按「账号 + 视频」存在服务端，重载/新标签都清不掉，独立页也没有「新对话」按钮——这是 API 版每次开新会话的主要优势。

## 边界（不可逾越）

- 不做点赞、评论、关注、发弹幕等任何写入用户账号的操作，除非用户明确要求；
- Cookie 只存在 `data/cookie.json`，不打印、不复制到别处、不发给抖音以外的任何服务；
- 面板版只在后台标签页操作，用户正在看的标签页只读不碰；滚轮事件会触发滑块验证码，**不要自动解**，请用户手动拖。

## 脚本说明

| 文件 | 作用 |
|---|---|
| `scripts/api_extract.mjs` | **主路径**。读 Cookie → 新会话「视频总结」→ 提取 → 清理 → 出 `.md` + 散件目录；`--followup` 续接同一会话追问 |
| `scripts/outdir.mjs` | 输出布局：`<OUT_ROOT>/<标题>_<ID>.md` + `<标题>_<ID>/` 散件目录；文件名清洗、按 ID 找回目录、markdown 渲染 |
| `scripts/extract_prompt.txt` | 提取提示词（API 版与面板版共用）。面板版靠结尾「注明「（此段无字幕）」。」定位本轮气泡，改时保留 |
| `scripts/search.mjs` | 按关键词搜视频（综合搜索接口，免签名），支持排序、时间筛选、翻页 |
| `scripts/author_posts.mjs` | 作者最新 N 条作品（`/aweme/v1/web/aweme/post/`，a_bogus + secsdk 两层签名），标置顶、图文 |
| `scripts/comments.mjs` | 评论区：一级评论（真签名）+ 楼中楼展开（占位签名，`--replies K`） |
| `scripts/danmaku.mjs` | 弹幕：60 秒分片拉取 + 去重，出带时间戳的 txt 和原始 json。免 Cookie，但 `aid=6383` 必带 |
| `scripts/web_api.mjs` | 网页接口公共层：浏览器参数、a_bogus（调 sign_abogus.py）、Argus 第二层签名（`argus: true` 时）、空响应重试一次 |
| `scripts/sign_abogus.py` | a_bogus 签名入口（web_api 以子进程调用）。默认 `abogus_dtk.py` + `sm3.py`：DTK 2026-09-09 对 bdms.js v1.0.1.19-fix.01 的逆向（Apache-2.0，无依赖）；`ABOGUS_IMPL=f2` 切到 `abogus.py`：f2 项目 2024-11 的 1.0.1.19 版（经 jiji262 拷贝，MIT，需 gmssl），留作对照 |
| `scripts/cookie.mjs` | 抖音登录 Cookie：`DOUYIN_COOKIE` > `data/cookie.json` > CDP 从 Chrome 读（只在文件缺失/过期时）；剩 3 天提醒；`--status` / `--refresh` |
| `scripts/clean.mjs` | 回答 → 纯正文：去 `<mark>`、来源、免责声明、首行开场白、注入的上下文头、开头照抄的标题简介 |
| `scripts/video_meta.mjs` | 元数据（标题/作者/时长/原生字幕/无水印地址）+ 原生字幕下载 + 完整度计算；`--download` 存无水印视频。走移动端 Feed `aweme/v1/feed/?aweme_id=&aid=1128`，必须按 aweme_id 精确匹配（它返回的是一串推荐流） |
| `scripts/resolve_id.mjs` | 从 ID / 长链 / `v.douyin.com` 短链 / 分享口令解析 aweme_id（短链跟随 302） |
| `scripts/panel_extract.mjs` | **备用**：浏览器面板版一键（总结 → 提取 → 读出） |
| `scripts/douyin_ask.mjs` | 面板版发问：后台独立面板页 `so-landing.douyin.com/search_ai_mobile/pc`，URL 参数 `ai_search_req_patch` 绑视频；问题写 `@extract` 用内置提示词 |
| `scripts/transcribe.mjs` | 本地转写（SenseVoice GPU）：喂视频/音频，自动抽 16 kHz 音频 → sherpa-onnx + VAD 出带时间戳文本。`--cpu` 走 CPU |
| `scripts/read_answer.mjs` | 面板版读答：最后一个 chatWrapper 里含问题结尾标记的 `.card-item` 当正文 |

面板版技术要点（改那几个脚本时需要知道的）：

- **后台标签必须先开焦点模拟**：`visibilityState` 为 hidden，鼠标点击不会聚焦输入框，`insertText` 静默丢失。用 `Emulation.setFocusEmulationEnabled({enabled:true})` + JS `el.focus()`。
- **发送验证两道**：输入后确认框里**有**字；回车后确认 `chatWrapper` 数增加且框已清空。只查「框里没字」会把「字没打进去」误判为已发送，空等 150 秒。
- **深度思考开关** `div[class*=deepSearchButton]`，激活时多 `deepSearchButtonActive`；状态留在页面上，脚本每次显式关掉（`DEEP=1` 才开）。
- 发消息用 CDP 真实输入事件（`Input.insertText` + `Input.dispatchKeyEvent` Enter），合成 `KeyboardEvent` 不触发 React 发送。
