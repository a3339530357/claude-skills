#!/usr/bin/env bash
# One-shot: capture Claude Code's /v1/messages request and write a JSON file.
# Cross-platform (Linux / macOS / WSL) counterpart to capture.ps1.
#
# 两个维度，别混淆：
#
#   --mode       抓哪个「入口」。print = `claude -p`（cc_entrypoint=sdk-cli），
#                interactive = 真 pty 里的 TUI（cc_entrypoint=cli）。两者的
#                system prompt 和工具集确有实测差异。
#
#   --transport  用哪条「通道」把请求截下来。这只影响我们怎么看到流量，
#                不影响 claude 构造的请求体。
#
#     baseurl  ANTHROPIC_BASE_URL 指向本地明文 HTTP 记录服务器。没有 TLS，
#              因此不受证书信任问题影响。claude 从 2.1.233 起是 bun 打包的
#              native 二进制，不再认 NODE_EXTRA_CA_CERTS，这是目前唯一
#              可靠的通道。代价：Host / Connection / Accept-Encoding 由本地
#              端点决定，也看不到真实响应。
#
#     mitm     老办法：起 MITM 代理，用自签 CA 解密 HTTPS。请求头 100% 真实
#              且能看到响应，但只在 claude 仍是 node 脚本的旧版本上可用。
#
#     auto     （默认）探测 claude 是不是 native 二进制来选。选中 mitm 后若
#              撞上证书错误，会自动回退 baseurl 重跑一次。
#
# Usage:
#   scripts/capture.sh                              # auto 通道 + print 入口
#   scripts/capture.sh --mode interactive           # 交互入口
#   scripts/capture.sh --transport mitm             # 强制走代理
#   scripts/capture.sh --out /path/out.json --redact
#   scripts/capture.sh --port 18899 --wait 40 --prompt "你好"

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

MODE="print"
TRANSPORT="auto"
PORT=""
OUT=""
PROMPT="你好，请只回复：OK"
WAIT=25
REDACT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --mode)      MODE="$2"; shift 2;;
    --transport) TRANSPORT="$2"; shift 2;;
    --port)      PORT="$2"; shift 2;;
    --out)       OUT="$2"; shift 2;;
    --prompt)    PROMPT="$2"; shift 2;;
    --wait)      WAIT="$2"; shift 2;;
    --redact)    REDACT=1; shift;;
    -h|--help)
      # 跳过 shebang（NR>1），只印顶部的注释块，遇到第一行非注释就停
      awk 'NR > 1 { if (!/^#/) exit; sub(/^# ?/, ""); print }' "$0"; exit 0;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

case "$MODE" in
  print|interactive) ;;
  *) echo "--mode 只能是 print 或 interactive，收到: $MODE" >&2; exit 2;;
esac
case "$TRANSPORT" in
  auto|baseurl|mitm) ;;
  *) echo "--transport 只能是 auto / baseurl / mitm，收到: $TRANSPORT" >&2; exit 2;;
esac

CA="$SKILL_ROOT/certs/ca.pem"
LOGS_DIR="$SKILL_ROOT/logs"
PROXY_JS="$SKILL_ROOT/src/index.js"
RECORD_JS="$SKILL_ROOT/src/record-server.js"
EXTRACT_JS="$SKILL_ROOT/scripts/extract-v1-messages.js"
DRIVER_PY="$SKILL_ROOT/scripts/drive-interactive.py"
mkdir -p "$LOGS_DIR"

# ---- 生命周期兜底 -------------------------------------------------------
# 旧版本在这里踩过两个坑，都由 trap 一次性解决：
#   1. extract 非 0 退出时 `set -e` 直接跳过结尾的清理代码，代理进程泄漏成孤儿；
#   2. PID 是从 `( cmd & echo $! )` 里取的，`&` 优先级低于 `&&` 导致取到的是
#      子 shell 而非服务进程，清理时等于给脚本自己发信号。
SERVER_PID=""
STARTED_HERE=0
cleanup() {
  if [ "$STARTED_HERE" = 1 ] && [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# 后台起服务。不放进子 shell，$! 才是服务进程本身；
# </dev/null 断开 stdin，输出全部重定向到文件，避免继承调用方的管道
# ——脚本输出接 `| tail` 时曾因此永不返回。
start_bg() {
  local runlog="$1"; shift
  nohup "$@" >"$runlog" 2>&1 </dev/null &
  SERVER_PID=$!
  disown "$SERVER_PID" 2>/dev/null || true
  STARTED_HERE=1
}

port_open() {
  node -e "require('net').connect($1,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null
}

wait_for_port() {
  local p="$1" i
  for i in $(seq 1 50); do
    port_open "$p" && return 0
    sleep 0.2
  done
  return 1
}

# ---- 通道探测 -----------------------------------------------------------
# 顺着符号链接走到真身。macOS 的 readlink 没有 -f，所以手写循环。
resolve_link() {
  local p="$1" n=0 t
  while [ -L "$p" ] && [ "$n" -lt 20 ]; do
    t="$(readlink "$p")"
    case "$t" in
      /*) p="$t";;
      *)  p="$(dirname "$p")/$t";;
    esac
    n=$((n + 1))
  done
  printf '%s\n' "$p"
}

version_ge() {
  # $1 >= $2 ?
  awk -v a="$1" -v b="$2" '
    BEGIN {
      na = split(a, x, ".");
      nb = split(b, y, ".");
      n = (na > nb ? na : nb);
      for (i = 1; i <= n; i++) {
        xi = (i <= na ? x[i] + 0 : 0);
        yi = (i <= nb ? y[i] + 0 : 0);
        if (xi > yi) { exit 0 }
        if (xi < yi) { exit 1 }
      }
      exit 0
    }'
}

detect_transport() {
  local bin real ver
  bin="$(command -v claude 2>/dev/null || true)"
  if [ -z "$bin" ]; then
    echo baseurl; return
  fi
  real="$(resolve_link "$bin")"
  # native 二进制的强特征：真身是 bin/claude.exe（bun --compile 的产物，
  # 即便在 Linux 上文件名也带 .exe）
  case "$real" in
    *.exe) echo baseurl; return;;
  esac
  ver="$(claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
  if [ -n "$ver" ] && version_ge "$ver" "2.1.233"; then
    echo baseurl
  else
    echo mitm
  fi
}

AUTO_PICKED=0
if [ "$TRANSPORT" = "auto" ]; then
  TRANSPORT="$(detect_transport)"
  AUTO_PICKED=1
  echo "[0/4] auto 选定通道: $TRANSPORT"
fi

[ -n "$PORT" ] || { [ "$TRANSPORT" = "mitm" ] && PORT=18888 || PORT=18899; }

# ---- 1. 依赖 ------------------------------------------------------------
# node-forge 只有 MITM 通道用得到；baseurl 通道零依赖，跳过安装省时间。
if [ "$TRANSPORT" = "mitm" ] && [ ! -d "$SKILL_ROOT/node_modules" ]; then
  echo "[1/4] installing node deps under skill dir..."
  ( cd "$SKILL_ROOT" && npm install --no-fund --no-audit --silent )
fi

# ---- 2. 起服务 ----------------------------------------------------------
run_capture() {
  local transport="$1" port="$2"
  local trigger_log="$LOGS_DIR/trigger.$MODE.$transport.log"

  SERVER_PID=""
  STARTED_HERE=0

  if port_open "$port"; then
    echo "[2/4] $transport 服务已在 $port 上监听 — 复用。"
  else
    if [ "$transport" = "mitm" ]; then
      echo "[2/4] starting MITM proxy on port $port..."
      start_bg "$LOGS_DIR/proxy.run.log" node "$PROXY_JS" --port "$port"
    else
      echo "[2/4] starting record-server on port $port..."
      # 交互模式必须伪造成功响应：TUI 拿到 401 会判定 "Login expired" 并拒绝
      # 发出真正的对话请求，最后只能抓到几百字节的认证探测。
      local fake=()
      [ "$MODE" = "interactive" ] && fake=( --fake-ok )
      start_bg "$LOGS_DIR/record-server.run.log" node "$RECORD_JS" --port "$port" "${fake[@]}"
    fi
    echo "$SERVER_PID" > "$LOGS_DIR/$transport.pid"
    if ! wait_for_port "$port"; then
      echo "服务没能在 $port 上起来，看 $LOGS_DIR/${transport}*.run.log" >&2
      return 1
    fi
  fi

  if [ "$transport" = "mitm" ] && [ ! -f "$CA" ]; then
    echo "CA cert not found at $CA — 代理首次启动会生成，重跑一次本脚本。" >&2
    return 1
  fi

  local log="$LOGS_DIR/$(date +%Y-%m-%d).jsonl"
  local lines_before=0
  [ -f "$log" ] && lines_before=$(wc -l < "$log")

  # ---- 3. 触发 claude ---------------------------------------------------
  # 代理环境变量大小写两套都要处理。undici 的 EnvHttpProxyAgent 两种都读，
  # 而像 reclaude 这类包装器会同时设置 HTTPS_PROXY 和 https_proxy——只覆盖大写
  # 的话，claude 仍旧走它们的代理，但 CA 已被我们换掉，于是报
  # "Self-signed certificate detected"，看起来像 claude 不认 CA，实则是漏改。
  if [ "$transport" = "mitm" ]; then
    export HTTPS_PROXY="http://127.0.0.1:$port"  https_proxy="http://127.0.0.1:$port"
    export HTTP_PROXY="http://127.0.0.1:$port"   http_proxy="http://127.0.0.1:$port"
    export NODE_EXTRA_CA_CERTS="$CA"
    unset ANTHROPIC_BASE_URL || true
  else
    export ANTHROPIC_BASE_URL="http://127.0.0.1:$port"
    unset HTTPS_PROXY HTTP_PROXY https_proxy http_proxy NODE_EXTRA_CA_CERTS || true
  fi

  # claude 的输出留在文件里，失败时用来做诊断，别丢进 /dev/null。
  if [ "$MODE" = "interactive" ]; then
    echo "[3/4] driving INTERACTIVE claude in a pty (cc_entrypoint=cli)..."
    if ! command -v python3 >/dev/null 2>&1; then
      echo "interactive 模式需要 python3（pty 驱动）。" >&2
      return 1
    fi
    timeout $((WAIT + 30)) python3 "$DRIVER_PY" "$PROMPT" "$WAIT" >"$trigger_log" 2>&1 || true
  else
    echo "[3/4] triggering claude -p (请求被拒是预期的 — 我们只要请求本身)..."
    echo "" | timeout $((WAIT + 15)) claude -p "$PROMPT" >"$trigger_log" 2>&1 || true
  fi

  # ---- 等新记录落盘 -----------------------------------------------------
  # 只看 lines_before 之后新追加的行。旧版直接 grep 整个文件，同一天第二次
  # 抓包会被上一次的旧记录骗到，立刻"成功"退出。
  #
  # 用 awk 单进程判断而不是 `tail | grep -q`：grep -q 命中就退出，上游 tail
  # 拿到 SIGPIPE 返回 141，`set -o pipefail` 会把整条管道判成失败，于是明明
  # 抓到了却一直等到超时。
  local deadline found=0
  deadline=$(( $(date +%s) + WAIT ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ -f "$log" ] && awk -v skip="$lines_before" \
        'NR > skip && /\/v1\/messages/ { hit = 1; exit } END { exit !hit }' "$log" 2>/dev/null; then
      found=1; break
    fi
    sleep 0.3
  done

  if [ "$found" != 1 ]; then
    echo "warning: ${WAIT}s 内没有新的 /v1/messages 记录。" >&2
    if grep -qi "self-signed certificate\|SELF_SIGNED_CERT" "$trigger_log" 2>/dev/null; then
      echo "诊断: claude 不信任本地 CA。这是 native 二进制（>=2.1.233）的通病，MITM 通道对它无效。" >&2
      return 3   # 3 = 证书信任失败，auto 模式据此回退
    fi
    echo "诊断: 看 $trigger_log 和 $LOGS_DIR/${transport}*.run.log" >&2
    return 4
  fi

  # ---- 4. 抽取 ----------------------------------------------------------
  echo "[4/4] extracting JSON..."
  local default_out="$SKILL_ROOT/v1-messages-${MODE}.json"
  local args=( "$EXTRACT_JS" --in "$log" --out "${OUT:-$default_out}" --skip-lines "$lines_before" )
  [ "$REDACT" = 1 ] && args+=( --redact )
  node "${args[@]}"
}

rc=0
run_capture "$TRANSPORT" "$PORT" || rc=$?

# auto 选了 mitm 却撞上证书信任问题时，自动换 baseurl 再来一次。
# 显式 --transport mitm 的话不自作主张，让失败可见。
if [ "$rc" = 3 ] && [ "$AUTO_PICKED" = 1 ] && [ "$TRANSPORT" = "mitm" ]; then
  echo
  echo "=> MITM 通道不可用，自动回退到 baseurl 通道重试..."
  cleanup
  TRANSPORT="baseurl"
  PORT=18899
  rc=0
  run_capture baseurl 18899 || rc=$?
fi

if [ "$rc" != 0 ]; then
  echo "抓取失败（rc=$rc）。" >&2
  exit "$rc"
fi

if [ "$TRANSPORT" = "baseurl" ]; then
  echo "  注意: Host/Connection/Accept-Encoding 反映的是本地端点；Authorization、"
  echo "        anthropic-beta、User-Agent、X-Stainless-* 和 body 都是 claude 原值。"
fi
if [ "$REDACT" != 1 ]; then
  echo "  提醒: 产物里的 Authorization 是真实凭据，要分享请加 --redact 重跑。"
fi
