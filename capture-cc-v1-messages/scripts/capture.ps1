# One-shot: capture Claude Code's /v1/messages request and write a JSON file.
# Self-contained — uses files relative to this script, not any external project.
#
# 通道（-Transport），和 capture.sh 一致：
#
#   baseurl  ANTHROPIC_BASE_URL 指向本地明文 HTTP 记录服务器。没有 TLS，
#            因此不受证书信任问题影响。claude 从 2.1.233 起是 bun 打包的
#            native 二进制，不再认 NODE_EXTRA_CA_CERTS，这是目前唯一可靠
#            的通道。代价：Host / Connection / Accept-Encoding 由本地端点
#            决定，也看不到真实响应。
#
#   mitm     老办法：起 MITM 代理，用自签 CA 解密 HTTPS。请求头 100% 真实
#            且能看到响应，但只在 claude 仍是 node 脚本的旧版本上可用。
#
#   auto     （默认）按 claude 版本探测。选中 mitm 后若撞上证书错误，会自动
#            回退 baseurl 重跑一次。
#
# 注意：本脚本只做 print 入口（claude -p）。要抓 interactive 入口，用 WSL 里的
# capture.sh --mode interactive（它需要 pty，PowerShell 里没有等价物）。
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File <skill>\scripts\capture.ps1
#   powershell -ExecutionPolicy Bypass -File <skill>\scripts\capture.ps1 -Transport mitm
#   powershell -ExecutionPolicy Bypass -File <skill>\scripts\capture.ps1 -Out "C:\out\sample.json" -Redact

param(
  [ValidateSet("auto","baseurl","mitm")]
  [string]$Transport = "auto",
  [int]$Port = 0,
  [string]$Out = "",
  [string]$Prompt = "你好，请只回复：OK",
  [switch]$Redact,
  [int]$WaitSec = 25
)

$ErrorActionPreference = "Stop"
$SkillRoot = Split-Path -Parent $PSScriptRoot
$CaPath    = Join-Path $SkillRoot "certs\ca.pem"
$LogsDir   = Join-Path $SkillRoot "logs"
$ProxyJs   = Join-Path $SkillRoot "src\index.js"
$RecordJs  = Join-Path $SkillRoot "src\record-server.js"
$ExtractJs = Join-Path $SkillRoot "scripts\extract-v1-messages.js"

if (-not (Test-Path $LogsDir)) { New-Item -ItemType Directory -Path $LogsDir | Out-Null }

function Test-PortListening([int]$p) {
  $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
  return [bool]$c
}

# native 二进制（bun --compile）不认 NODE_EXTRA_CA_CERTS，MITM 对它无效。
function Get-AutoTransport {
  try {
    $raw = (& claude --version 2>$null) -join " "
    if ($raw -match '(\d+)\.(\d+)\.(\d+)') {
      $ver = [version]("{0}.{1}.{2}" -f $Matches[1], $Matches[2], $Matches[3])
      if ($ver -ge [version]"2.1.233") { return "baseurl" }
      return "mitm"
    }
  } catch { }
  # 版本读不出来时按新版处理：baseurl 通道在两种 claude 上都能工作。
  return "baseurl"
}

$autoPicked = $false
if ($Transport -eq "auto") {
  $Transport = Get-AutoTransport
  $autoPicked = $true
  Write-Host "[0/4] auto 选定通道: $Transport"
}
if ($Port -eq 0) { $Port = if ($Transport -eq "mitm") { 18888 } else { 18899 } }

# ---- 1. Install deps if needed ----
# node-forge 只有 MITM 通道用得到；baseurl 通道零依赖。
if ($Transport -eq "mitm" -and -not (Test-Path (Join-Path $SkillRoot "node_modules"))) {
  Write-Host "[1/4] installing node deps under skill dir..."
  # cmd /c isolates npm so its harmless stderr warnings don't trip $ErrorActionPreference=Stop
  & cmd /c "cd /d ""$SkillRoot"" && npm install --no-fund --no-audit --silent" 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit=$LASTEXITCODE)" }
}

# 返回值约定（和 capture.sh 对齐）：0 成功 / 3 证书信任失败 / 4 其它没抓到
function Invoke-Capture([string]$transport, [int]$port) {
  $serverProc = $null
  $startedHere = $false
  $triggerLog = Join-Path $LogsDir "trigger.print.$transport.log"

  try {
    # ---- 2. 起服务 ----
    if (Test-PortListening $port) {
      Write-Host "[2/4] $transport 服务已在 $port 上监听 — 复用。"
    } else {
      $js = if ($transport -eq "mitm") { $ProxyJs } else { $RecordJs }
      $tag = if ($transport -eq "mitm") { "MITM proxy" } else { "record-server" }
      Write-Host "[2/4] starting $tag on port $port..."
      $serverProc = Start-Process -FilePath "node" `
        -ArgumentList $js,"--port",$port `
        -WorkingDirectory $SkillRoot `
        -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $LogsDir "$transport.stdout.log") `
        -RedirectStandardError  (Join-Path $LogsDir "$transport.stderr.log")
      $startedHere = $true
      $deadline = (Get-Date).AddSeconds(10)
      do {
        Start-Sleep -Milliseconds 200
      } while (-not (Test-PortListening $port) -and (Get-Date) -lt $deadline)
      if (-not (Test-PortListening $port)) {
        Write-Warning "$tag 没能在 $port 上起来，看 $LogsDir\$transport.stderr.log"
        return 4
      }
    }

    if ($transport -eq "mitm" -and -not (Test-Path $CaPath)) {
      Write-Warning "CA cert not found at $CaPath — 代理首次启动会生成，重跑一次。"
      return 4
    }

    # ---- 3. 触发 claude ----
    if ($transport -eq "mitm") {
      $env:HTTPS_PROXY = "http://127.0.0.1:$port"
      $env:HTTP_PROXY  = "http://127.0.0.1:$port"
      $env:NODE_EXTRA_CA_CERTS = $CaPath
      Remove-Item Env:ANTHROPIC_BASE_URL -ErrorAction SilentlyContinue
    } else {
      $env:ANTHROPIC_BASE_URL = "http://127.0.0.1:$port"
      Remove-Item Env:HTTPS_PROXY,Env:HTTP_PROXY,Env:NODE_EXTRA_CA_CERTS -ErrorAction SilentlyContinue
    }

    $today = (Get-Date).ToString("yyyy-MM-dd")
    $logFile = Join-Path $LogsDir "$today.jsonl"
    # 按行数而不是字节数记录基线：抽取时用 --skip-lines 保证只在本次新记录里挑。
    $linesBefore = if (Test-Path $logFile) { @(Get-Content $logFile -Encoding UTF8).Count } else { 0 }

    Write-Host "[3/4] triggering claude -p (请求被拒是预期的 — 我们只要请求本身)..."
    # claude 的输出留在文件里，失败时用来做诊断。空行喂给 stdin 避免它等输入。
    $null = "" | & claude -p $Prompt 2>&1 | Out-File -FilePath $triggerLog -Encoding UTF8

    # ---- 等新记录落盘 ----
    # 只看 linesBefore 之后新追加的行。旧版扫整个文件，同一天第二次抓包会被
    # 上一次的旧记录骗到，立刻"成功"退出。
    $deadline = (Get-Date).AddSeconds($WaitSec)
    $found = $false
    while ((Get-Date) -lt $deadline) {
      if (Test-Path $logFile) {
        $lines = @(Get-Content $logFile -Encoding UTF8)
        if ($lines.Count -gt $linesBefore) {
          $fresh = $lines[$linesBefore..($lines.Count - 1)] -join "`n"
          if ($fresh -match '/v1/messages') { $found = $true; break }
        }
      }
      Start-Sleep -Milliseconds 300
    }

    if (-not $found) {
      Write-Warning "${WaitSec}s 内没有新的 /v1/messages 记录。"
      $trig = if (Test-Path $triggerLog) { Get-Content $triggerLog -Raw -Encoding UTF8 } else { "" }
      if ($trig -match '(?i)self-signed certificate|SELF_SIGNED_CERT') {
        Write-Warning "诊断: claude 不信任本地 CA。这是 native 二进制（>=2.1.233）的通病，MITM 通道对它无效。"
        return 3
      }
      Write-Warning "诊断: 看 $triggerLog 和 $LogsDir\$transport.stderr.log"
      return 4
    }

    # ---- 4. 抽取 ----
    Write-Host "[4/4] extracting JSON..."
    $defaultOut = Join-Path $SkillRoot "v1-messages-print.json"
    $nodeArgs = @($ExtractJs, "--in", $logFile, "--skip-lines", $linesBefore)
    if ($Out) { $nodeArgs += @("--out", $Out) } else { $nodeArgs += @("--out", $defaultOut) }
    if ($Redact) { $nodeArgs += "--redact" }

    & node @nodeArgs
    return $LASTEXITCODE
  }
  finally {
    # 这里必须是 finally：旧版把停代理写在末尾，中途 throw / return 就永远
    # 跑不到，代理进程留成孤儿，下次运行还会被"已在监听 — 复用"误判。
    if ($startedHere -and $serverProc) {
      Write-Host "stopping $transport server (PID=$($serverProc.Id))"
      Stop-Process -Id $serverProc.Id -Force -ErrorAction SilentlyContinue
    }
    Remove-Item Env:HTTPS_PROXY,Env:HTTP_PROXY,Env:NODE_EXTRA_CA_CERTS,Env:ANTHROPIC_BASE_URL -ErrorAction SilentlyContinue
  }
}

$rc = Invoke-Capture $Transport $Port

# auto 选了 mitm 却撞上证书信任问题时，自动换 baseurl 再来一次。
# 显式 -Transport mitm 的话不自作主张，让失败可见。
if ($rc -eq 3 -and $autoPicked -and $Transport -eq "mitm") {
  Write-Host ""
  Write-Host "=> MITM 通道不可用，自动回退到 baseurl 通道重试..."
  $Transport = "baseurl"
  $rc = Invoke-Capture "baseurl" 18899
}

if ($rc -ne 0) {
  Write-Warning "抓取失败（rc=$rc）。"
  exit $rc
}

if ($Transport -eq "baseurl") {
  Write-Host "  注意: Host/Connection/Accept-Encoding 反映的是本地端点；Authorization、"
  Write-Host "        anthropic-beta、User-Agent、X-Stainless-* 和 body 都是 claude 原值。"
}
if (-not $Redact) {
  Write-Host "  提醒: 产物里的 Authorization 是真实凭据，要分享请加 -Redact 重跑。"
}
exit 0
