---
name: lmfpd-model-check
description: 用 lmfpd（lm.ikale.io 的模型指纹检测器）判断某个 API / 中转站 / 代理背后实际跑的是不是它声称的模型——测真假、测掺水、测是否被换成同家族便宜型号（flash/mini/旧版）。当用户说"测一下这个中转是不是真的 opus""这家 API 的 gpt 是不是掺假""帮我验一下这个 key 背后是什么模型""这个站说是 claude 实际是啥""跑一下 lmfpd/fpd""模型指纹检测"，或贴出 base URL + key + 模型名想知道真伪，或拿着一份 lmfpd 生成的 JSON 报告问结论时都应使用。即使用户没提 lmfpd，只要问题是"这个接口背后到底是什么模型 / 是不是正版"，就用这个技能。
---

# 用 lmfpd 测模型真假

## 原理（决定了结论能说到什么程度）

lmfpd 让模型按题目要求输出几百个"随机"整数，然后看这串数字的分布。每个模型"随机"出来的数字都有稳定的偏好，就像指纹一样。它把这份指纹和**参考库**里约 70 个模型的样本做比对，给出排名和概率。

这里面有三层限制，你给用户下结论时得心里有数：

1. **只能在库内比较**。概率指的是"在参考库这些模型里，它最像谁"。如果真实模型不在库里，lmfpd 照样会选出一个第一名。所以**请求的模型不在库内时，结论只能是"无法判定"**，不能说它是假的。
2. **同家族的近邻很难分开**。比如 gemini-4-carbon 和 argon，或者 opus-5.5 和 fable-5.2，单轮测出 50%–70% 都正常，不代表有问题。跨家族的差异（比如说是 Claude，测出来像 DeepSeek）才是强证据。
3. **响应里的 `model` 字段不算证据**。那个字段中转站想填什么就填什么。不过如果声称的型号和请求的型号不一样（比如请求 glm-5.3，回来写着 glm-5.3-flash），本身就值得指出来。

## 第一步：凑齐四样东西

| 要什么 | 说明 |
|---|---|
| base URL | 见下面的"URL 坑" |
| 模型名 | 原样照填用户在那个站用的名字，带 `[1M]` 这类后缀也照填，脚本会自己归一 |
| 协议 `-a` | 普通 OpenAI 兼容中转用 `cc`（chat completions），大多数中转只支持这个；Anthropic 格式端点（`/v1/messages`）用 `message`；`responses` 是 lmfpd 默认值，但很多中转不支持，不确定就别用 |
| API key | 见下面的"key 怎么传" |

用户只给了一部分时，**问清楚缺的那几样再跑**，别瞎猜协议导致白跑一轮。

### URL 坑（已实测过）

- 如果给的是裸域名，比如 `https://api.x.com`，lmfpd 会自动补成 `/v1/...`。
- 如果 URL **带了路径**，它会保留原路径、只在后面追加 endpoint，**不会补 `/v1`**。比如 `https://open.bigmodel.cn/api/anthropic` 会被请求成 `.../api/anthropic/messages`，结果 404。正确写法是 `.../api/anthropic/v1`。
- 也可以直接给完整 endpoint，例如 `.../v1/chat/completions`。

### key 怎么传

不要把 key 写进命令行参数，否则会留在 shell 历史和进程列表里。有两种传法：

**常测的站，存成 profile**（存到技能目录的 `data/endpoints.json`，该目录被 gitignore，不会推出去）：

```bash
printf '%s' '<key>' | node <skill目录>/scripts/profiles.mjs set oval --base https://www.oval.us.ci/v1 --api cc
node <skill目录>/scripts/profiles.mjs list      # key 脱敏显示
```

之后用 `--profile oval` 就行。用户说"测一下 oval 的 xxx"时，先 `list` 看看有没有存过。

**临时测一次**，走 stdin：

```bash
printf '%s' '<key>' | node <skill目录>/scripts/check.mjs -b URL -a cc -m MODEL --key-stdin
```

## 第二步：先看参考库里有没有这个模型

```bash
node <skill目录>/scripts/check.mjs --bank            # 全部，按家族分组
node <skill目录>/scripts/check.mjs --bank opus       # 按关键词筛
```

如果请求的模型（去掉中转加的前缀和后缀之后）不在库里，**跑之前就要告诉用户**：这次只能看出"最像谁"，判不了真假。用户坚持要跑也行。参考库会随 `lmfpd@latest` 更新，所以每次都现查，别凭记忆回答。

## 第三步：跑检测

```bash
node <skill目录>/scripts/check.mjs --profile oval -m claude-opus-5.5
node <skill目录>/scripts/check.mjs --profile oval -m claude-opus-5.5 -n 3        # 3 轮，结论更稳
```

- **花费**：每轮 3 个请求，每个请求让模型输出约 300 个数字，按 token 计费的话很便宜。加 `--tokenizer` 会多出 12–22 个短请求。**按次计费的站要先告诉用户请求数。**
- **耗时**：一轮大约 30–120 秒，带 thinking 的模型会更久。
- **一律前台跑，不要用 `run_in_background`**：后台任务的输出会写进 `AppData\Local\Temp` 下的文件，用户明确不要这个，用户要的是结果直接打印在对话里。做法如下：
  - 调用时把 Bash 的 `timeout` 设成 `600000`（10 分钟上限）。`-n 3` 以内一般都能跑完。
  - 要跑的轮数更多时，拆成几次前台调用，每次 `-n 3`。
  - 同时测几个模型时，在同一条消息里发出多个前台 Bash 调用，它们会并行执行，各自直接打印结果。
- **轮数怎么选**：先跑 1 轮。结果是"一致"且置信度 ≥80%，就可以收工。如果是"倾向一致""存疑"，或用户本来就怀疑这个站，再补 `-n 3`。看多轮结果时，以"谁赢了几轮"为准。
- **报告位置**：默认存到 `<当前目录>/lmfpd-results/`，文件名里带时间、主机和模型。lmfpd 保证报告里不含 key。

可选参数：

| 参数 | 什么时候用 |
|---|---|
| `--tokenizer` | 想多一条独立证据时用。它通过 usage 里的 token 数判断 tokenizer。如果声称是 Claude，但测出 `o200k_base`/`cl100k_base`，说明中转是用 tiktoken **估算 usage** 的，计费数字不可信。注意它只能证明"tokenizer 相同"，因为很多模型共用一个 tokenizer |
| `--image` | 怀疑中转识别到测试题关键词就把请求路由到真模型时用。这个模式把题目画成图片发出去。前提是模型支持图片输入；参考库是用文字样本建的，结果会有偏差 |
| `-e high` 等 | 用户在那个站平时就带 effort 参数时，保持一致 |
| `--timeout 180` | 带 thinking 的慢模型首字节超时时加大 |
| `-- 其他参数` | `--` 之后的参数原样透传给 lmfpd，例如 `-- --strict` |

## 第四步：读结果、给结论

脚本会输出整理好的摘要，每轮都有前 5 名、失败样本，以及一行 `判断: [标签]`。标签含义如下：

| 标签 | 含义 | 怎么跟用户说 |
|---|---|---|
| 一致 | 第一名就是请求的模型，置信度 ≥80% | 基本可以认为是真的 |
| 倾向一致 | 第一名对，但置信度不高，或者没有置信度 | 大概率是真的；同族近邻有竞争，要更确定就跑 3 轮 |
| 存疑 | 第一名是同族的另一个型号，但请求的模型概率也不低（≥20%） | 分不太开，跑 3 轮再说 |
| 不一致·同家族 | 第一名是同家族另一个型号，请求的模型远远落后 | 疑似被换成同家族的便宜型号；看看第一名是不是 flash/mini/旧版 |
| 不一致·跨家族 | 第一名是别的家族 | 强证据表明是假的 |
| 无法判定 | 请求的模型不在库内 | 说明原因，只报告"最像谁" |
| 未评分 | 有效样本为 0 | 去排查失败原因（见下表），不能下任何结论 |

脚本给的标签是机械规则算出来的。你要结合上下文再判断一次，比如多轮结果、请求名和声称名对不上、tokenizer 结果等。

### 常见失败原因

| 现象 | 原因 |
|---|---|
| `HTTP 401` | key 错误或已过期 |
| `HTTP 404`，或智谱返回 `missing finish status` | URL 路径不对，按上面的"URL 坑"修。智谱网关出错时会返回 HTTP 200 加 JSON 错误体，lmfpd 会误报成 missing finish status |
| `did not complete (max_tokens)` | thinking 模型想太久，用完了 Messages 协议写死的 8192 token。3 个样本挂 1 个照样能出排名（只是没有置信度） |
| `Too few valid numbers` | 模型没按要求输出数字：中途改主意、混进解释文字、拒答。偶尔一个无所谓；如果全部都这样，可能是中转加了奇怪的 system prompt，或者根本不是 LLM 在回复 |
| 首字节超时 | 加大 `--timeout`；也可能是中转排队 |
| `⚠ 输出序列不像模型生成` | 数字序列的统计特征不像 LLM 生成的，可能是缓存回放或脚本伪造，这本身就值得报告给用户 |

### 给用户的回复结构

先给结论，再给证据：

1. **一句话结论**：是真的 / 疑似被换成 X / 无法判定，外加置信程度。
2. **证据**：第一名及其概率、请求的模型排第几、声称的 model 字段是什么、多轮各自谁赢；有 tokenizer 结果的话也列上。
3. **限制**：说明结论建立在什么前提上，比如库内比较、单轮、同族近邻。
4. **报告路径**：方便用户以后对比或者离线重算。

## 只看已有报告

用户拿着 lmfpd 的 JSON 报告来问（不管是用 `--output` 存的，还是 `--json > x.json` 重定向出来的；后者开头会混进 bunx 的输出，脚本能处理）：

```bash
node <skill目录>/scripts/check.mjs --summarize report.json
node <skill目录>/scripts/check.mjs --summarize report.json -m glm-5.3    # 报告里的模型名不对时覆盖
```

这一步不发请求、不花钱。

## 运行环境说明

- 脚本优先用 `bunx lmfpd@latest`，找不到 bunx 再退到 `npx -y`。
- **不要加 `--bun`**。lmfpd 要求 Bun ≥1.4.4 才能用 Bun 运行时，版本不够时 bunx 会自动改用 Node（需要 ≥22）来跑，这是正常的。
- 参考库从 bunx/npx 的缓存目录里读。找不到时，脚本会先跑一次 `--help` 把包拉下来。
