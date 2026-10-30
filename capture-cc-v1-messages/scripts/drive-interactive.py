#!/usr/bin/env python3
"""在真 pty 里启动交互式 claude,发一条消息触发 /v1/messages,然后退出。

用途:抓取"交互模式"(而非 -p)下的请求体,与 print 版对拍。
关键点:必须用 pty,否则 claude 检测到 stdin 非 TTY 会自动降级为 print 模式。

用法:
  drive-interactive.py [PROMPT] [WAIT_SEC] [-- <额外 claude 参数...>]
  额外参数会原样透传给交互式 claude,例如 --model / --settings,
  用于指向第三方端点等场景。
"""
import os
import pty
import select
import sys
import time

argv = sys.argv[1:]
extra = []
if "--" in argv:
    i = argv.index("--")
    extra = argv[i + 1:]
    argv = argv[:i]

PROMPT = argv[0] if len(argv) > 0 else "你好"
WAIT_SEC = float(argv[1]) if len(argv) > 1 else 30.0

env = dict(os.environ)
# 代理 + CA 已由外层 shell 注入,这里不重复设置。

pid, fd = pty.fork()
if pid == 0:
    # 子进程:成为交互式 claude(继承环境里的 HTTPS_PROXY / NODE_EXTRA_CA_CERTS)
    os.execvp("claude", ["claude"] + extra)
    os._exit(127)

# 父进程:驱动这个 pty
def drain(deadline):
    while time.time() < deadline:
        r, _, _ = select.select([fd], [], [], 0.3)
        if fd in r:
            try:
                data = os.read(fd, 4096)
            except OSError:
                return False
            if not data:
                return False
            sys.stdout.write(data.decode("utf-8", "replace"))
            sys.stdout.flush()
    return True

start = time.time()
# 1) 等 UI 起来
drain(start + 6)
# 2) 输入消息 + 回车
os.write(fd, PROMPT.encode("utf-8"))
time.sleep(1.0)
os.write(fd, b"\r")
# 3) 等请求发出 + 响应流(边读边显示)
drain(time.time() + WAIT_SEC)
# 4) 优雅退出:Ctrl+C 两次 / 然后强杀
try:
    os.write(fd, b"\x03")
    time.sleep(0.5)
    os.write(fd, b"\x03")
    time.sleep(0.5)
except OSError:
    pass
try:
    os.kill(pid, 15)
    time.sleep(0.5)
    os.kill(pid, 9)
except ProcessLookupError:
    pass
print("\n[drive-interactive] done", flush=True)
