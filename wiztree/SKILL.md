---
name: wiztree
description: 用 WizTree 分析 Windows 磁盘占用、找出占空间的大文件和大目录，并规划安全清理。当用户问「C 盘满了/空间去哪了/什么占了几十G/怎么清磁盘/哪个文件夹太大/能不能删 XXX」，或提到磁盘空间不足、清理缓存、找大文件、分析目录大小、WizTree、Diskspace、dump 目录膨胀时，都用这个技能。即使用户没提「WizTree」三个字，只要问题本质是「磁盘空间被什么占了」或「这些能不能删」，就先用它扫描分析，再给清理建议。也适用于排查某个具体目录为何异常膨胀（如 AppData、node_modules、Docker、缓存目录）。**WSL 分区（ext4.vhdx）也是本技能范围**——WizTree 对那边无效，要用 duc 建索引；用户问「D 盘被 WSL 吃了多少」「WSL 里什么占空间」「ext4.vhdx 怎么缩小」时同样用这个技能。
---

# WizTree 磁盘分析与清理

WizTree 直读 NTFS 的 MFT，全盘扫描只要 8~10 秒。本技能把它的命令行导出能力和一套分析脚本组合起来，用来回答「磁盘被什么占了」并给出安全清理建议。

## 核心原则

**先测量，再判断，最后才删。** 磁盘清理的风险不在「删不掉」，而在「删错」——用户数据、登录态、不可重建的数据库看起来和缓存没什么区别。所以流程固定为：扫描 → 分类 → 报告 → 用户确认 → 执行 → 回读验证。

**默认只出报告，不自动删除。** 哪怕是纯缓存目录，也先列出来等用户点头。用户可能正靠着某个缓存工作（比如剪贴板历史数据库、索引库），体积大不等于可以删。

## 工具位置

```
D:\software\WizTree\WizTree64.exe
```

如果不存在，先用 `winget install AntibodySoftware.WizTree` 装，或问用户装在哪。

## 工作流程

### 第 1 步：扫描并导出 CSV

```powershell
D:\software\WizTree\WizTree64.exe "C:\" /export="<工作目录>\scan.csv" /admin=1
```

- 第一个参数是扫描根目录，可以只扫某个子目录来提高速度
- `/admin=1` 让它有权限读系统目录，不加可能漏掉 `System Volume Information` 之类
- 全盘约 8~10 秒；单个子目录通常不到 1 秒
- 屏幕可能闪一下窗口，提前告诉用户
- **CSV 会很大**：全盘通常 500 MB ~ 1 GB。放在项目目录里，别放 C 盘临时目录

#### CSV 是临时产物，用完必须删

这是本技能唯一会自己造出大文件的地方，而它天然会累积：每次分析都导一份，全盘一份就 500 MB~1 GB，攒几次就是几个 GB 躺在项目目录里没人管。

**扫描前定好路径，分析完立刻删。** 不要「留着下次用」——WizTree 重扫全盘只要 8 秒，省不下什么，但磁盘是真的会被吃掉。

```powershell
# 收尾三件事，按顺序：确认 → 删除 → 验证
Test-Path $csv                                  # 1. 确认路径没写错，别删错东西
Remove-Item $csv -Force                         # 2. 删
Test-Path $csv                                  # 3. 回读确认，返回 False 才算删掉
```

三条注意：

- **只删自己生成的。** 用户可能自己手动导过 CSV 放在桌面（比如 `WizTree_2026*.csv` 这种带时间戳的名字），那是他的文件，不要动。删之前确认路径是你这次扫描写进去的那个。
- **不要在分析中途删**。脚本还没读完就删文件，Windows 上会抛共享冲突或读到半截。等 `analyze.mjs` / `precheck.mjs` 都跑完再删。
- **删完顺手检查目录里有没有历史残留**。之前跑过的扫描经常留下没清干净的 CSV，一并报给用户：

```powershell
Get-ChildItem <工作目录> -Filter *.csv -Recurse |
  Select-Object @{n='MB';e={[math]::Round($_.Length/1MB,2)}}, FullName, LastWriteTime
```

如果确实需要保留一份反复分析（比如全盘数据要拆成十几轮下钻），**在报告里说清楚还留着哪个文件、多大、什么时候删**，而不是默默留着。用户下次发现磁盘少了 1 GB 时不该靠猜。 

### 第 2 步：用 Node 脚本分析，不要用 PowerShell

这一步最容易出错。导出的 CSV 有几百万行，**用 PowerShell 写循环处理会卡死**——它是解释执行，每行都要走一遍语法树遍历和动态类型判断，五百万行要十几分钟甚至更久。同一个逻辑用 Node 只要 2~3 秒，因为 V8 会把热点循环 JIT 编译成机器码。

```powershell
# 顶层目录
node <skill>/scripts/analyze.mjs scan.csv --root "C:\" --depth 1

# 拆解某个大目录
node <skill>/scripts/analyze.mjs scan.csv --root "C:\Users\<name>" --depth 2

# 找大文件（不限根目录）
node <skill>/scripts/analyze.mjs scan.csv --big 500MB --top 30
```

脚本参数：
- `--root`：只统计该路径下（必须和 CSV 里的写法一致，含盘符和反斜杠）
- `--depth`：从 root 往下展开几层；`1` 是 root 的直接子目录
- `--big`：列出超过该大小的单个文件，支持 `300MB`、`2GB`
- `--top`：每个列表输出多少条，默认 40

**逐层往下钻**，不要一次就想看穿。先看顶层，发现 `C:\Users` 占最多，再 `--root C:\Users\x --depth 2`，再对最大的子目录继续。每层都只回答「这一层里谁最大」。

## 性能红线

这套流程里唯一该碰磁盘的地方是第 1 步的 WizTree 扫描本身。其余步骤全部读 CSV 或做常数级的文件访问。

| 操作 | 代价 | 说明 |
|---|---|---|
| WizTree 扫描全盘 | 8~10 秒 | 读 MFT，快，但会占 IO |
| Node 解析 CSV | 2~3 秒 | 纯内存 + 顺序读 |
| precheck 抽样 | O(样本数) | 默认 20 次文件访问，与目录大小无关 |
| **递归遍历目录算大小** | **O(文件数)** | **禁止。CSV 里已经有了** |
| PowerShell 循环解析 CSV | 十几分钟 | **禁止** |
| （WSL）`duc index` 建索引 | 4~6 分钟 | 慢一次，之后查询 39 毫秒 |
| （WSL）`duc ls` 查询 | 39 毫秒 | 读索引库，不碰磁盘 |
| （WSL）`du -sh` 单目录 | 视文件数，分钟级 | **禁止用它逐层钻**，没有缓存 |
| （WSL）`find -type d` | 秒级 | 只读 `d_type`，不 `lstat` |

**不要并发跑多个扫描。** 一次只做一件事；需要对比多个目录时，复用同一份 CSV。

如果脚本或代理要处理清理候选，**先检查它是不是在递归遍历**。几十万个小文件的目录在 Windows 上逐个 `statSync`，足以让整机失去响应——这不是理论风险，是实际发生过的事。

### 第 3 步：分类，而不是直接给删除清单

把发现的东西分四类，区别在于「删了会怎样」：

**A. 系统垃圾 —— 必须走系统工具，不能直接删**

| 项目 | 工具 | 为什么不能直接删 |
|---|---|---|
| `C:\Windows.old` | `cleanmgr /d C:` → 勾「以前的 Windows 安装」 | ACL 被锁，直接删删不干净还留残壳；和回滚机制绑定 |
| `System Volume Information` | `vssadmin delete shadows /for=C: /oldest` | 存着还原点和卷影副本，强删会破坏卷 |
| `hiberfil.sys` | `powercfg /h off` | 休眠文件，关休眠才释放 |
| `pagefile.sys` | 系统属性 → 虚拟内存 | 虚拟内存，改配置才能缩 |
| `$Recycle.Bin` | `Clear-RecycleBin -Force` | 用回收站接口 |

`System Volume Information` 里那些几十 GB 的 `{GUID}{GUID}` 文件就是还原点，删的是还原点不是文件夹。给用户 `vssadmin list shadows /for=C:` 让他看清有哪些再决定。

**B. 可重建缓存 —— 安全，但先查占用**

包管理器缓存（scoop/npm/pnpm/pip/uv/cargo）、浏览器缓存、着色器缓存、IDE 索引、应用更新包。删了会自动重建。

**这一步必须先跑 precheck**，因为「文件被进程锁住」是清理失败最常见的原因：

```powershell
node <skill>/scripts/precheck.mjs "C:\path\to\cache" --csv scan.csv
```

它会报目录大小、抽样检查哪些文件被占用。**必须传 `--csv`** —— 大小从 CSV 里读，不要让它自己遍历目录。

这条约束不是洁癖。precheck 的初版是递归遍历每个文件算大小的，结果一次被传了 8 个缓存目录（其中 pnpm store 有十几万个小文件），在 Windows 上每个 `statSync` 都是一次随机 IO，直接把整台机器拖死。CSV 里明明已经有每个文件的大小，重新去磁盘问一遍是把最慢的活干两遍。

抽样默认 20 个文件，够判断了：如果目录里有被锁的文件，20 个样本基本能撞上；如果 20 个全都能打开，说明大概率没有锁。`--sample` 可以调，但没必要调大 —— 遍历本身就是风险。

如果有占用，直接删会「删一半抛异常」，看着像成功其实没省下多少——必须告诉用户：先关程序，或者重启后再删。

**C. 需要用户判断 —— 只报告不动手**

用户的个人文件、下载内容、游戏、多开浏览器配置、剪贴板历史库、聊天记录。这些体积可能很大，但删了不可恢复。**列出来，说清大小和性质，让用户决定。** 不要因为「看起来像缓存」就替用户拿主意——目录名字不说明任何问题，`Ditto.db` 是剪贴板数据库不是缓存，Chrome 的 `Profile N` 可能是用户手工建的账号配置。

**D. 绝对不动**

用户的数据库、密钥、个人文档目录、`.git` 仓库。扫到就记下来，不列入任何清理建议。

### benchmark / 测试产物：repo 和结果要分开看

跑分工具（agent benchmark、CI、批量测试）经常留下两种东西，**体积差两个数量级，价值完全相反**：

```
runs/2026-09-08T02-40-18-cold/
├── manifest.json              ← 配置记录，小，留着
├── polyglot_grep/1/
│   ├── result.json            ← 评测结果，唯一数据，必须留
│   ├── repo/                  ← 仓库副本，几十 MB，删
│   └── .milo/sessions/*.jsonl ← agent 对话记录，留着
└── *.log                      ← 运行日志，留着
```

**`repo/` 是「跑的时候用的输入」，结果文件是「跑出来的输出」。** 输入可以从题库重新克隆，输出删了就没了。

所以清理这类目录时**不要整个 `rm -rf runs/`**，而是精确删 `repo/`：

```bash
find <root> -mindepth 4 -maxdepth 4 -type d -name repo -print0 |
  while IFS= read -r -d '' d; do rm -rf "$d"; done
```

先确认目录层级再删。目录名可能是 `<runId>/<task>/<attempt>/repo` 这样的四层，写错 `-mindepth`/`-maxdepth` 会一个都匹配不到——**先数数量再删**：

```bash
find <root> -mindepth 4 -maxdepth 4 -type d -name repo | wc -l
```

注意：一个 bench 目录里可能有多个题库（`polyglot_*`、`commander_*`、`ufo_*` 等混在一起），**不要按题目名前缀过滤**，按层级和目录名 `repo` 匹配才全。

### 第 4 步：出报告

按「回收量 / 风险」排序，让用户一眼看到性价比。建议表格形式：

```
| 项目 | 大小 | 风险 | 怎么做 |
|---|---:|---|---|
| Windows.old | 41.68 GB | 低（失去回滚） | cleanmgr 勾选 |
| 还原点（最老的） | 9.33 GB | 低（保留最新） | vssadmin /oldest |
| hiberfil.sys | 12.50 GB | 低（无休眠） | powercfg /h off |
| Chrome CacheStorage | 12.51 GB | 无 | 浏览器设置清除 |
```

同时给一个「保守方案能回收多少」的合计，和一个「激进方案」的合计，让用户挑。

### 第 5 步：执行与验证

用户确认后，逐项执行。**删除类操作要按用户的授权范围来**——如果用户只说了删 A 和 B，不要顺手把 C 也删了。

三项铁律：
1. **先 precheck，再删**。锁定文件会让删除半途失败。
2. **删完立刻回读验证**。`Remove-Item` 没抛异常不等于删干净了；重新测大小，对比预期释放量。返回值和实际状态是两回事。
3. **部分失败要如实报告**。删掉 7 GB 剩 7 GB 就是「部分成功」，不是「已完成」。

## WSL / Linux 分区怎么查

**WizTree 对 WSL 完全无效，不要试。**

WizTree 的本事全在 NTFS 的 `$MFT` 上——整棵目录树预先存在一个文件里，顺序读一遍就拿到全部。而 WSL 的磁盘是一个 `ext4.vhdx` 虚拟磁盘镜像，里面是 ext4 文件系统，没有 MFT。

实测扫 `D:\WSL\Ubuntu` 导出的 CSV **只有 2 行**：一个目录、一个 `ext4.vhdx` 文件。点不进去，`文件,文件夹` 那两列是 `1,0`。

三道门同时关着：① ext4 无 MFT；② vhdx 是磁盘镜像，要挂载+识别文件系统才能读；③ 文件被 WSL 进程独占锁定（CSV 属性列带占用位）。

**WizTree 在这里唯一的价值：告诉你 WSL 总共占了多少。**

### 用 duc，不要用 du 一层层钻

`du` 有个致命设计：**结果算完就丢**。`du -d1` 只输出一层，想看下一层必须重扫整个子树。在 300 GB / 700 万文件的盘上，这就是「钻一层扫五分钟」。

`duc` 把索引落盘（`/root/.cache/duc/duc.db`，约 120 MB），**建一次 4~6 分钟，之后查询 39 毫秒**，想钻几层钻几层。

```bash
# 装（一次）
sudo apt-get install -y duc

# 建索引（一次，4~6 分钟，耐心等完）
sudo duc index -x /

# 之后全部秒回
sudo duc ls -Fg /                         # 顶层
sudo duc ls -Fg /home/user/project        # 随便钻
sudo duc ls -Fg --max-depth 3 /home       # 直接看三层
sudo duc ui /                             # TUI 界面，方向键钻，跟 WizTree 一样
```

**`-x` 是保命参数。** 不加会顺着 `/mnt/c`、`/mnt/d`、`/mnt/e` 把 Windows 全盘重扫一遍——9p 协议比本地 ext4 慢两个数量级，那才是真的卡死。

`duc` 没有增量模式（`duc help index` 里只有 exclude 类选项），重建永远是全量。所以：

- **一天建一次够用**，看目录结构不用重建
- **验证释放了多少空间不要重建，直接 `df -h /`**，一行命令零延迟
- 装了大软件、克隆了大仓库之后才值得重建

### 为什么 Linux 下慢，追不上的根本原因

不是磁盘慢，是**系统调用次数**。

| | WizTree / NTFS | du、find / ext4 |
|---|---|---|
| 数据源 | `$MFT` 一个文件 | 逐层 `opendir` + 每个文件 `lstat` |
| 调用次数 | 几百次 `read()` | **文件数 × 1 次 `lstat`** |
| 300 GB / 700 万文件 | 8 秒 | 4~6 分钟 |

`lstat` 贵在**路径解析**：每次都要从 `/` 逐段走 dcache。CPU 卡在 50% 而不是 100%，就是在内核态/用户态之间来回切，不是在等 IO。**换 SSD、加内存都没用。**

一个能省大量时间的细节：`readdir` 返回的目录项自带 `d_type` 字段（`DT_DIR`/`DT_REG`/`DT_LNK`），ext4 支持填充它。所以 **`find -type d` 不需要 `lstat`**，而 `du` 要拿每个文件的大小，一个都省不掉。这就是为什么数目录几秒钟、算总大小几分钟。

真要限时用 `-maxdepth`：

```bash
find /path -mindepth 4 -maxdepth 4 -type d -name repo   # 到第 4 层就不往下走
```

### 清理完必须压缩 vhdx，否则空间不会还给 Windows

`ext4.vhdx` 是动态扩展盘，**只涨不缩**。在 WSL 里删 100 GB，`df` 会变，但 Windows 里那个文件还是原大小。

#### 哪些操作不会缩（2026-11-15 本机实测）

用户常问「`wsl --shutdown` 或重启会不会自动缩」，**答案是都不会**。实测数据：

| 操作 | vhdx 变化 |
|---|---|
| 在 WSL 里删 2 GB 文件 | 215.04 → 215.04 GB |
| `wsl --shutdown` | 215.04 → **215.04 GB（纹丝不动）** |
| `sudo fstrim -v /`（报告 trim 了 801 GiB） | 215.04 → **215.04 GB（还是不动）** |
| Windows 重启 | 不会，只是重新加载同一个文件 |
| **`diskpart compact vdisk`** | ✅ **唯一能缩的操作** |

`fstrim` 只是告诉虚拟磁盘「这些块我不要了」，虚拟磁盘内部记下这个标记，但**文件大小不变**。没有任何自动化流程会去收缩它。

本机 `.wslconfig` 里没有 `sparseVhd=true`，`fsutil sparse queryflag` 也确认文件不是稀疏的——所以永远只涨不缩。

#### 怎么缩

```powershell
wsl --shutdown
diskpart
  select vdisk file="D:\WSL\Ubuntu\ext4.vhdx"
  attach vdisk readonly
  compact vdisk
  detach vdisk
```

本机没装 Hyper-V 模块（`Optimize-VHD` 不可用），只能走 diskpart。**多项清理攒到一起统一 compact 一次**，省得反复关 WSL。

**实测效果**：299.73 GB → 215.03 GB（压缩 28%），D 盘剩余 200.32 → 285.02 GB。WSL 内释放 92 GB，实际回收 84.7 GB，差额 7.3 GB 是 ext4 元数据 + vhdx 块索引开销。

**压不到理论值就停手**：压缩后 215 GB vs ext4 已用 198 GB，那 17 GB 差距是文件系统固有开销，`fstrim` 也消不掉。

#### diskpart 脚本的两个坑

**① 必须用 CRLF 换行。** 用 LF 写脚本，diskpart 会把 5 行当 1 行读，报「无法解析这些命令」。

```powershell
$lines = @(
 'select vdisk file="D:\WSL\Ubuntu\ext4.vhdx"',
 'attach vdisk readonly',
 'compact vdisk',
 'detach vdisk',
 'exit'
)
[System.IO.File]::WriteAllText('D:\script.txt', ($lines -join "`r`n") + "`r`n", [System.Text.Encoding]::ASCII)
diskpart.exe /s 'D:\script.txt'
```

**② 别把 diskpart 输出接到外部管道。** `diskpart /s x.txt 2>&1 | iconv ...` 这种写法会报「无法处理这些参数」。在 PowerShell 里用 `Out-String` 接，或干脆让它在后台跑。

调 diskpart 时**逐条验证**比整段跑省时间：先只跑 `select vdisk` + `detail vdisk`，确认选对了再逐步加命令。

### 调用 WSL 命令的三个坑（都踩过）

**① Bash 工具调 `wsl.exe` 时，`/mnt/...` 会被 Git Bash 改写成 `C:/Program Files/Git/mnt/...`**

```bash
# ❌ 脚本根本没执行，但 2>/dev/null 把错误吞了，看起来像"执行成功"
wsl.exe -d Ubuntu -- bash /mnt/d/path/script.sh 2>/dev/null

# ✅
MSYS_NO_PATHCONV=1 wsl.exe -d Ubuntu -- bash /mnt/d/path/script.sh
```

用 **PowerShell 工具**调 `wsl -d Ubuntu -- bash -c '...'` 不受影响（路径在字符串里，Git Bash 不参与）。

**② PowerShell 调 `bash -c` 时，`$变量` 被 PowerShell 先展开成空**

```powershell
wsl -d Ubuntu -- bash -c 'for d in /home /var; do echo $d; done'   # 输出全空
wsl -d Ubuntu -- bash -c 'T=/abc; echo "[\$T]"'                     # 反斜杠转义，有效
```

单引号**挡不住**——它在 PowerShell 里只是字符串字面量，参数解析阶段 `$T` 已被替换。**最稳的做法是写成 .sh 文件**，或命令里干脆不出现 `$`（路径写死）。

**③ WSL 每次启动往 stderr 打一行 `your 131072x1 screen size is bogus`**

它和 stdout 交错，会把正常输出挤乱。加 `2>$null`（PowerShell 侧）或 `2>/dev/null`（bash 侧）滤掉。

**调试阶段先别加静音参数。** 上面前两个坑都会表现为「0 秒退出、零输出」，而 `2>/dev/null` 恰好把唯一的线索吞掉——这次因此连续失败三次才发现根因。

### 判断任务是否完成：看进程，不看文件时间

`duc` 是边扫边往数据库写的，**文件 mtime 在变、大小在涨恰恰说明「正在写」**。把「文件被修改」当成「已经定稿」会误报完成。

三个信号同时成立才算完：`ps` 查不到进程、`duc info` 能打出完整数据行（只有表头 = 没写完）、数据库大小不再变化。

## 常见目录的判读参考

这些名字容易误判，看的时候多想一层：

| 路径片段 | 实际是什么 | 处理 |
|---|---|---|
| `AppData\Local\Google\Chrome\User Data\Profile N` | 独立的浏览器配置，可能是登录态/书签 | 用户判断 |
| `Default\Service Worker\CacheStorage` | 网页离线缓存 | 安全 |
| `OptGuideOnDeviceModel` | Chrome 端侧 AI 模型权重 | 安全但会重新下载 |
| `AppData\Local\NVIDIA\DXCache` | 着色器缓存，**常被驱动锁住** | 安全，需关驱动或重启 |
| `AppData\Local\pip\cache`、`uv\cache` | Python 包缓存 | 安全 |
| `scoop\persist\nodejs\cache` | Node 二进制下载缓存 | 安全（`scoop cache rm *`） |
| `.lingma\index`、JetBrains `index` | IDE 代码索引 | 安全，重开会重建 |
| `.m2\repository` | Maven 依赖 | 安全但重下很慢，建议只删 `_remote.repositories` 之外的旧版本 |
| `AppData\Roaming\Cursor\snapshots` | 编辑器快照 | 安全 |
| `C:\$MFT` | NTFS 主文件表，几 GB 是正常的 | **绝对不动** |
| 各种 `.db` / `.sqlite` / `.idx` | 很可能是用户数据 | 用户判断 |
| `D:\...\ext4.vhdx` | **WSL 的整块虚拟磁盘**，WizTree 只能当黑盒看 | 内容要用 `duc` 查；清完要 diskpart compact |
| `target/`（Rust 项目） | Cargo 编译产物，常几十 GB，带 `CACHEDIR.TAG` | 安全，`cargo build` 重建 |
| `tmp/<xxx>-runs/` 下的 `*/*/repo/` | **benchmark 跑分时克隆的仓库副本**（含 `.git`、`node_modules`） | 通常安全，但同目录的 `result.json`、`*.log` 是结果数据，**必须保留** |

## 不要去猜用户的使用习惯

扫描结果里的时间戳、命名模式很容易让人编故事（「这批文件是同一分钟创建的，一定是工具批量生成的」）。但用户完全可能是自己用脚本批量建的，为了存不同账号。**不确定就直接问，不要替用户下结论。**

同理，不要拿「这个体积对一个 X 工具来说不正常」当理由建议删除——用户可能正因为这个「不正常」才依赖它。

## 输出语言

跟随用户。用户说中文就用中文，技术术语保持原文（`MFT`、`JIT`、`vssadmin` 不翻译）。
