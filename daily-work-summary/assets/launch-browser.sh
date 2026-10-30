#!/usr/bin/env bash
# 启动(或复用)带调试端口的 Chrome,供 ChatGPT 采集使用。
#
# 为什么要独立 profile:调试端口会让任何本地进程能操控该浏览器实例,不该和你
# 日常那个装满登录态的 profile 混在一起。独立 profile 只登 ChatGPT 一个账号,
# 且登录态长期保留,以后每天只需确认窗口开着。
#
# 为什么必须用 Windows 的 Chrome:Chrome 150 起已忽略 --remote-debugging-address,
# 端口死绑 127.0.0.1。WSL 走 NAT,跨不到 Windows 的回环地址。所以浏览器和采集
# 脚本都放在 Windows 侧,由 WSL 远程调起。
#
# ── 端口为什么要自动发现 ──
# 同一个 user-data-dir 只能有一个 Chrome 实例。profile 已被占用时,再次启动会被
# 单实例机制转发给已有进程,--remote-debugging-port 被静默丢弃。若此时只探测自己
# 指定的那个端口,就会误判成"没起来",而实际上已有实例正带着别的端口在跑。
# 因此本脚本先扫端口范围找现成的调试端点,找到就复用;要新启时也自动挑空闲端口。
#
# 用法:
#   ./launch-browser.sh              启动或复用,末行输出 CDP_PORT=<实际端口>
#   ./launch-browser.sh --status     只报告状态
#   ./launch-browser.sh --kill-stale 关掉占着 profile 却没有调试端口的僵尸进程
#   CDP_PORT=9223 ./launch-browser.sh   指定起始端口(被占则自动往后找)

set -uo pipefail

PROFILE_WIN='C:\Users\a3351\.daily-work-summary\chrome-profile'
PROFILE_WSL="/mnt/c/Users/a3351/.daily-work-summary/chrome-profile"
PROFILE_TAG='daily-work-summary'   # 用于在命令行里认出"我们的" Chrome 进程
PORT_LO=9222
PORT_HI=9235
WANT_PORT="${CDP_PORT:-$PORT_LO}"

CURL="/mnt/c/Windows/System32/curl.exe"
NETSTAT="/mnt/c/Windows/System32/netstat.exe"
TASKKILL="/mnt/c/Windows/System32/taskkill.exe"
PS='/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'

CHROME_CANDIDATES=(
  "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"
  "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"
  "/mnt/c/Users/$USER/AppData/Local/Google/Chrome/Application/chrome.exe"
  "/mnt/c/Users/a3351/AppData/Local/Google/Chrome/Application/chrome.exe"
)

# 一次 netstat 拿到范围内所有监听端口。逐个 curl 探测会在没人监听的端口上白等
# 超时,14 个端口能拖半分钟;先筛出真正有人听的,再去验证是不是 Chrome。
listening_in_range() {
  "$NETSTAT" -ano 2>/dev/null | tr -d '\r' \
    | awk -v lo="$PORT_LO" -v hi="$PORT_HI" '
        $1 == "TCP" && $4 == "LISTENING" {
          n = split($2, a, ":"); p = a[n] + 0
          if (p >= lo && p <= hi) print p
        }' | sort -un
}

# /mnt/c/... -> C:\...
# PowerShell 是 Windows 程序,-FilePath 只认 Windows 路径。直接把 WSL 路径传进去
# 会静默失败(Start-Process 找不到文件,又不返回错误码),表现为"启动了但端口没绑上"。
to_win_path() {
  local p="$1"
  if [[ "$p" =~ ^/mnt/([a-zA-Z])/(.*)$ ]]; then
    local drive="${BASH_REMATCH[1]}" rest="${BASH_REMATCH[2]}"
    printf '%s:\\%s' "$(echo "$drive" | tr '[:lower:]' '[:upper:]')" "${rest//\//\\}"
  else
    printf '%s' "$p"
  fi
}

# 必须用 Windows 侧的 curl:它访问的 127.0.0.1 才是 Chrome 监听的那个。
# max-time 给 1s 足够 —— 本地回环上 Chrome 要么立刻答要么就是没在听,给 3s
# 只会让 25 次探测循环白拖一分钟。
probe() {
  "$CURL" -s --max-time 1 "http://127.0.0.1:$1/json/version" 2>/dev/null
}

# 端口有响应不代表是 Chrome(实测 Clash Verge 会绑 9222 做代理端口),
# 只有响应里含 "Browser" 字段才是真的调试端点。
is_chrome_port() {
  probe "$1" | grep -q '"Browser"'
}

find_chrome_port() {
  local p
  for p in $(listening_in_range); do
    if is_chrome_port "$p"; then echo "$p"; return 0; fi
  done
  return 1
}

# 查有哪些 chrome.exe 在用我们的 profile,顺带取出各自的调试端口(可能为空)。
# 输出每行 "<PID> <端口或空> <是否父进程>"。
#
# 区分父子进程很重要:Chrome 一个实例有十来个进程,只有父进程(命令行里没有
# --type= 的那个)持有 profile 锁。逐个强杀子进程会留下孤儿并让锁异步释放;
# 杀父进程才会干净地带走全部子进程。
profile_procs() {
  "$PS" -NoProfile -Command "
    Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\" |
      Where-Object { \$_.CommandLine -like '*${PROFILE_TAG}*' } |
      ForEach-Object {
        \$p = ''
        if (\$_.CommandLine -match 'remote-debugging-port=(\d+)') { \$p = \$Matches[1] }
        \$k = if (\$_.CommandLine -match '--type=') { 'child' } else { 'parent' }
        \"\$(\$_.ProcessId) \$p \$k\"
      }" 2>/dev/null | tr -d '\r' | grep -E '^[0-9]+' || true
}

login_state() {
  "$CURL" -s --max-time 3 "http://127.0.0.1:$1/json/list" 2>/dev/null \
    | grep -o '"url": "https://chatgpt.com[^"]*"' | head -1
}

report_ready() {
  local port="$1" prefix="$2"
  local ver
  ver=$(probe "$port" | grep -o '"Browser": "[^"]*"' | sed 's/.*: "//; s/"$//')
  echo "${prefix}(端口 ${port}${ver:+,$ver})"
  if [[ -z "$(login_state "$port")" ]]; then
    echo "提示:窗口里还没打开 chatgpt.com,或尚未登录。登录一次即可,登录态存在独立 profile 里。"
  fi
  # 末行固定格式,供调用方 eval 或抓取
  echo "CDP_PORT=$port"
}

# ───────────────────────── --kill-stale ─────────────────────────
if [[ "${1:-}" == "--kill-stale" ]]; then
  PROCS=$(profile_procs)
  if [[ -z "$PROCS" ]]; then
    echo "没有进程占用 profile。"
    exit 0
  fi
  # 只杀父进程:它会带走自己的全部子进程。逐个杀子进程会留孤儿、锁释放也不干净。
  PARENTS=$(echo "$PROCS" | awk '$3 == "parent" {print $1}')
  if [[ -z "$PARENTS" ]]; then
    # 没找到父进程(可能已被杀,只剩孤儿子进程),那就全杀
    PARENTS=$(echo "$PROCS" | awk '{print $1}')
    echo "未找到父进程,清理残留的 $(echo "$PARENTS" | wc -w) 个孤儿进程。"
  else
    echo "关闭占用 profile 的 Chrome 实例(父进程 $(echo "$PARENTS" | tr '\n' ' ')),其子进程会一并退出。"
  fi
  for pid in $PARENTS; do
    "$TASKKILL" /PID "$pid" /T /F >/dev/null 2>&1
  done
  # profile 锁是异步释放的,等它真正干净了再返回,否则紧接着重启会再次撞锁
  for i in $(seq 1 10); do
    sleep 1
    [[ -z "$(profile_procs)" ]] && break
  done
  LEFT=$(profile_procs | wc -l)
  if [[ "$LEFT" -gt 0 ]]; then
    echo "仍有 $LEFT 个进程未退出,再等几秒后重跑本脚本。" >&2
    exit 1
  fi
  echo "已清理。重跑本脚本即可启动新的调试实例。"
  exit 0
fi

# ───────────────────────── --status ─────────────────────────
if [[ "${1:-}" == "--status" ]]; then
  if FOUND=$(find_chrome_port); then
    report_ready "$FOUND" "运行中"
    exit 0
  fi
  PROCS=$(profile_procs)
  if [[ -n "$PROCS" ]]; then
    echo "未运行调试端点,但 profile 被 $(echo "$PROCS" | wc -l) 个进程占用(无调试端口)。"
    echo "执行 $0 --kill-stale 关掉它们。"
    exit 1
  fi
  echo "未运行"
  exit 1
fi

# ─────────────── 1. 有现成的调试实例就复用 ───────────────
# 不限于本脚本启的:手动启的、上次会话遗留的,只要在范围内监听且是 Chrome 就用。
if FOUND=$(find_chrome_port); then
  report_ready "$FOUND" "复用已在运行的调试实例"
  exit 0
fi

# ─────────────── 2. profile 被占但没有调试端口 ───────────────
# 这是最隐蔽的失败模式:Chrome 会把新的启动命令转发给这个进程并丢弃
# --remote-debugging-port,于是无论换哪个端口都绑不上。必须先关掉它。
PROCS=$(profile_procs)
if [[ -n "$PROCS" ]]; then
  echo "profile 已被以下进程占用,但没有一个在监听调试端口:" >&2
  echo "$PROCS" | awk '{printf "  PID %s\n", $1}' >&2
  echo "" >&2
  echo "同一 profile 只能有一个 Chrome 实例。不关掉它们,新启动的命令会被转发过去," >&2
  echo "--remote-debugging-port 被丢弃,换任何端口都没用。" >&2
  echo "  解决:$0 --kill-stale  (关掉后重跑本脚本)" >&2
  echo "  或者:本次用 --skip-chatgpt 跳过 ChatGPT,其余三源不受影响" >&2
  exit 1
fi

# ─────────────── 3. 挑一个空闲端口 ───────────────
CHROME=""
for c in "${CHROME_CANDIDATES[@]}"; do
  [[ -x "$c" ]] && CHROME="$c" && break
done
if [[ -z "$CHROME" ]]; then
  echo "找不到 chrome.exe,请手动指定路径" >&2
  exit 1
fi
CHROME_WIN=$(to_win_path "$CHROME")

BUSY=" $(listening_in_range | tr '\n' ' ') "
PORT=""
for p in $(seq "$WANT_PORT" "$PORT_HI"); do
  [[ "$BUSY" == *" $p "* ]] || { PORT="$p"; break; }
done
if [[ -z "$PORT" ]]; then
  echo "端口 ${WANT_PORT}-${PORT_HI} 全被占用,无法启动。" >&2
  exit 1
fi
if [[ "$PORT" != "$WANT_PORT" ]]; then
  # 常见于 Clash Verge 把 9222 当代理端口
  echo "端口 $WANT_PORT 已被其他程序占用,改用 $PORT。"
fi

mkdir -p "$PROFILE_WSL"

# 用 PowerShell Start-Process 启动,比 WSL 的 nohup & 更可靠地 detach:
# nohup 对 Windows GUI 程序的 detach 不可靠,进程可能不继承完整命令行参数。
launch_once() {
  "$PS" -NoProfile -Command \
    "Start-Process -FilePath '$CHROME_WIN' -ArgumentList '--remote-debugging-port=$1','--user-data-dir=$PROFILE_WIN','--no-first-run','--no-default-browser-check','https://chatgpt.com'" \
    >/dev/null 2>&1
}

launch_once "$PORT"
for i in $(seq 1 25); do
  sleep 1
  if is_chrome_port "$PORT"; then
    report_ready "$PORT" "浏览器已就绪(第 ${i}s)"
    exit 0
  fi
done

# 第一次没绑上。若 profile 已空(强杀 Chrome 后锁会异步释放,期间启动会被静默
# 丢弃),重试一次往往就成 —— 实测强杀后紧接着启动必失败,隔几秒再来就正常。
if [[ -z "$(profile_procs)" ]]; then
  echo "首次启动未绑上端口(profile 锁可能刚释放),重试一次…" >&2
  sleep 3
  launch_once "$PORT"
  for i in $(seq 1 20); do
    sleep 1
    if is_chrome_port "$PORT"; then
      report_ready "$PORT" "浏览器已就绪(重试后第 ${i}s)"
      exit 0
    fi
  done
fi

# ─────────────── 启动失败的诊断 ───────────────
echo "等待 25s 仍未就绪。诊断:" >&2
if FOUND=$(find_chrome_port); then
  # 命令被转发给了别的实例,但那个实例带着调试端口 —— 直接用它
  echo "  - $PORT 没绑上,但发现 $FOUND 上有可用的调试实例,改用它。" >&2
  report_ready "$FOUND" "复用调试实例"
  exit 0
fi
PROCS2=$(profile_procs)
if [[ -n "$PROCS2" ]]; then
  echo "  - profile 已被 $(echo "$PROCS2" | wc -l) 个进程占用,启动命令被转发,端口被丢弃。" >&2
  echo "    解决:$0 --kill-stale 后重跑。" >&2
else
  echo "  - 无进程占用 profile,可能是 Chrome 路径或 profile 权限问题。" >&2
  echo "    Chrome: $CHROME_WIN" >&2
  echo "    Profile: $PROFILE_WIN" >&2
  echo "    手动跑这条看有无报错或弹窗:" >&2
  echo "    powershell.exe -Command \"Start-Process -FilePath '$CHROME_WIN' -ArgumentList '--remote-debugging-port=$PORT','--user-data-dir=$PROFILE_WIN'\"" >&2
fi
echo "  (其余三个源不受影响,可用 --skip-chatgpt 正常采集)" >&2
exit 1
