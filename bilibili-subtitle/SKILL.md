---
name: bilibili-subtitle
description: 提取 B 站（哔哩哔哩）视频的完整字幕/口播文本，附带 B 站官方 AI 总结（带时间戳提纲）。当用户给出 bilibili.com/video 链接、b23.tv 短链、BV 号、av 号或 B 站分享文本，或说「提取/拿/看看这个 B 站视频的字幕」「这个视频讲了什么」「整理一下这条 B 站视频」时使用——任何需要把 B 站视频内容变成文字的场合都应触发，即使没出现「字幕」二字。抖音视频不用本技能，用 douyin-subtitle。
---

# B 站视频字幕提取

B 站自己就有字幕：UP 主上传的字幕，或 B 站给大部分口播视频自动生成的 **AI 字幕（`ai-zh` 轨）**。这是真 ASR 结果、带时间轴，不需要像抖音那样问 AI 再验收「有没有编」。唯一门槛：**字幕接口只认登录态**，不登录只能拿到弹幕。

## 用法

```bash
cd <输出目录>        # 输出落在当前目录；不要用临时目录
node <skill目录>/scripts/extract.mjs "<BV号/av号/视频链接/b23.tv短链/整段分享文本>"
node <skill目录>/scripts/extract.mjs "<...>" --p 3      # 多 P 视频指定分 P（链接里带 ?p=3 也行）
node <skill目录>/scripts/extract.mjs "<...>" --p all    # 合集全部分 P
```

单条约 5 秒。多 P 视频没指定分 P 时只取 P1，并打印分 P 目录——看目录判断用户要哪个，再按需重跑。

输出：

| 文件 | 内容 |
|---|---|
| `subtitles_<BV>[_pN].txt` | 纯文本字幕（一行一句，交付用这个） |
| `subtitles_<BV>[_pN].srt` | 带时间轴的原始字幕（用户要时间点、或要定位某段时用） |
| `summary_<BV>[_pN].txt` | B 站官方 AI 总结：一段摘要 + `## mm:ss 章节` / `- mm:ss 要点` 提纲 |
| `meta_<BV>.json` | 标题、UP 主、简介、发布时间、分 P 列表（cid、时长） |

字幕轨优先级：UP 主上传的中文 > B 站 AI 中文（`ai-zh`）> 其他 AI 轨 > 其他。脚本会打印选了哪条、还有哪些可选。

## 交付

- 先读 `summary_` 给用户一个概览（有时间戳提纲的话很适合当目录），再给字幕全文或按用户需要整理。
- 告诉用户字幕来源是「B 站 AI 字幕」还是「UP 主上传字幕」。**AI 字幕的同音错字原样保留**并指给用户（如「SV机」实为「SVG」），不要自作主张改正文。
- 字数/分钟只用来发现异常：低于 100 说明字幕只覆盖一部分或视频以音乐/画面为主，要跟用户说明。

## 没有字幕时

脚本会打印「没有字幕轨」。常见原因：
- **刚发布**：B 站 AI 字幕和 AI 总结要过一阵才生成（实测发布 6 天的 10 分钟口播视频还是空的）。可以过几天再跑。
- 纯音乐/无人声、UP 主关闭、番剧/电影（`/bangumi` 不在本技能范围）。

用户等不了时走本地转写：`yt-dlp -x --audio-format wav --cookies <...>` 下音频 → `ffmpeg -ar 16000 -ac 1` → FunASR Paraformer-zh / faster-whisper。先告诉用户要装模型、要花 CPU 时间，确认后再做。

## Cookie（前置条件）

- 平时只读 `<skill目录>/data/cookie.json`，不碰浏览器；**文件缺失或已过期时**，脚本自动借 CDP daemon（`D:\project\tests\browser\cdp-daemon.mjs`）从用户的 Chrome 读一次 `.bilibili.com` 的 Cookie 并写回。前提是 Chrome 里登录着 B 站、开着远程调试。
- 到期时间取 `SESSDATA` 的过期时间（B 站登录态约半年）。剩不到 3 天时脚本会打印 ⚠ 提醒——**看到这条提醒要转告用户**：先在浏览器重新登录 B 站，再运行 `node <skill目录>/scripts/cookie.mjs --refresh`。
- `node cookie.mjs --status` 看到期时间（不打印值）；`--refresh` 强制从 Chrome 重读。
- 也可用环境变量 `BILI_COOKIE`（整串 Cookie）或 `BILI_COOKIE_FILE`（换文件位置）。
- 报「Cookie 不是登录态」：登录态被服务端提前作废了（如在别处退出登录）。让用户在浏览器确认 B 站还登录着，再 `--refresh`。
- **Cookie 等于用户的 B 站登录凭证：任何时候都不打印、不 cat 那个文件、不复制到别处、不发给 B 站以外的任何服务。** 分享本技能时要排除 `data/` 目录。
- yt-dlp 要 Netscape 格式的 Cookie 文件：脚本临时写在 `data/ytdlp_cookies.txt`，跑完（包括失败）立即删除。

## 边界

- 只读：不点赞、不投币、不评论、不发弹幕，不做任何写入用户账号的操作。
- 不批量爬取：一次处理用户点名的视频；`--p all` 只用在用户明确要整个合集时。

## 脚本说明

| 文件 | 作用 |
|---|---|
| `scripts/extract.mjs` | 主流程：Cookie → 登录检查 → 视频详情（选分 P）→ yt-dlp 拉字幕 → 挑轨、srt 转纯文本 → 官方 AI 总结 |
| `scripts/bili.mjs` | 共用模块：链接解析（含 b23.tv 跟 302）、WBI 签名、`wbi/view` 详情、`view/conclusion/get` AI 总结、srt 转文本、字数密度 |
| `scripts/cookie.mjs` | Cookie 文件缓存 + 到期提醒 + 缺失/过期时 CDP 刷新 |

技术要点（改脚本时需要知道的）：

- **字幕交给 yt-dlp**（已装，`python -m pip install -U yt-dlp` 升级；别直接敲 `pip`，本机 PATH 里排第一的 pip 是 CGG_GeoSoftware 自带的 Perl 脚本）：它实现了 `/x/player/wbi/v2` 的字幕轨解析。多 P 视频在 yt-dlp 里是 playlist，条目序号 = 分 P 号，文件名 `<BV>_p<N>.<lang>.srt`；单 P 是 `<BV>.<lang>.srt`。不加 `--playlist-items` 会把整个合集全拉下来。
- **WBI 签名**（参考 Douyin_TikTok_Download_API 的 `dtk/signing/native/wbi.py`）：`/x/web-interface/nav` 公布 img_key/sub_key（图片文件名，约每天轮换）→ MIXIN 表重排取前 32 位；参数加 `wts` 排序、值删 `!'()*`、encodeURIComponent → `w_rid = md5(query + mixin)`。未签名的 `/x/web-interface/view` 现在回 412。
- **AI 总结** `GET /x/web-interface/view/conclusion/get?bvid&cid&up_mid`（WBI 签名）：`data.code` 0 = 有总结，-1 = 不支持/没生成（`stid=0`）；正文在 `data.model_result.summary` 和 `.outline[].part_outline[]`，时间戳单位是秒。
- 想直接确认某条视频有没有字幕轨：`wbiGet('/x/player/wbi/v2', {bvid, cid})` 看 `data.subtitle.subtitles`。
