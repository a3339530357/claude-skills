"""跨系统路径归一化。

同一个项目在四个数据源里长相完全不同,不归一就会被拆成好几个"项目":

  Windows Codex 记的 cwd   \\\\wsl.localhost\\Ubuntu\\home\\a33511\\project\\code
  WSL Claude Code 记的 cwd  /home/a33511/project/code
  Windows Claude Code       C:\\Users\\a3351\\Desktop\\project\\foo
  WSL 侧看同一个 Windows 目录  /mnt/c/Users/a3351/Desktop/project/foo

统一折算到"从 WSL 看过去"的绝对路径,作为聚合主键。
"""

import re

# \\wsl.localhost\<发行版>\... 与老式的 \\wsl$\<发行版>\...
_WSL_UNC = re.compile(r"^\\\\wsl(?:\.localhost|\$)\\[^\\]+\\(.*)$", re.IGNORECASE)
# 盘符路径 C:\... 或 C:/...
_WIN_DRIVE = re.compile(r"^([A-Za-z]):[\\/](.*)$")
# Claude Code 的目录名编码:把 / 换成 -
_CC_DIRNAME = re.compile(r"^-[A-Za-z0-9]")


def normalize(path):
    """归一化到 WSL 视角的绝对路径。无法识别时原样返回(去掉尾部斜杠)。"""
    if not path:
        return None
    p = str(path).strip().strip('"')
    if not p:
        return None

    m = _WSL_UNC.match(p)
    if m:
        return "/" + m.group(1).replace("\\", "/").strip("/")

    m = _WIN_DRIVE.match(p)
    if m:
        drive, rest = m.group(1).lower(), m.group(2).replace("\\", "/").strip("/")
        return f"/mnt/{drive}/{rest}" if rest else f"/mnt/{drive}"

    p = p.replace("\\", "/")
    return p.rstrip("/") or "/"


def decode_claude_dirname(name):
    """把 Claude Code 的目录名反解成路径。

    编码方式是把 '/' 替换成 '-',因此原路径里本就含 '-' 的段无法无损还原
    (-home-a33511-project-daily-work-summary 既可能是 daily-work-summary
    也可能是 daily/work/summary)。所以这**只作兜底**:jsonl 内的 cwd 字段
    才是权威来源,拿不到时才退到这里。
    """
    if not name or not _CC_DIRNAME.match(name):
        return None
    return "/" + name[1:].replace("-", "/")


def display_name(path, home="/home/a33511"):
    """给人看的短名:把家目录折成 ~,过长时只留末两段。"""
    if not path:
        return "(未知位置)"
    p = normalize(path)
    if home and p.startswith(home):
        p = "~" + p[len(home):]
    parts = [x for x in p.split("/") if x]
    if len(parts) > 3:
        return ".../" + "/".join(parts[-2:])
    return p


def is_under(path, parent):
    """path 是否位于 parent 之下(或就是 parent)。"""
    a, b = normalize(path), normalize(parent)
    if not a or not b:
        return False
    return a == b or a.startswith(b.rstrip("/") + "/")


def looks_like_windows_side(path):
    """归一化后的路径是否指向 Windows 文件系统。"""
    p = normalize(path) or ""
    return p.startswith("/mnt/") and len(p) > 6 and p[5].isalpha() and p[6] == "/"


def to_windows(path, distro=None):
    """把 WSL 视角的路径翻回 Windows 能识别的形式。

    Windows 侧的 node.exe / chrome.exe 读不懂 /home/... ,必须给 UNC 路径;
    而 /mnt/c/... 要还原成盘符,走 UNC 反而会绕远。
    """
    import os

    p = normalize(path)
    if not p:
        return None
    if p.startswith("/mnt/") and len(p) > 6 and p[5].isalpha() and p[6] == "/":
        return f"{p[5].upper()}:\\" + p[7:].replace("/", "\\")
    distro = distro or os.environ.get("WSL_DISTRO_NAME") or "Ubuntu"
    return f"\\\\wsl.localhost\\{distro}\\" + p.lstrip("/").replace("/", "\\")
