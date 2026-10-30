"""时间窗换算。

四个数据源的时间表示互不相同,这是采集出错的头号来源:

  Claude Code jsonl   ISO-8601 带 Z 的 UTC 字符串,如 2026-07-30T06:21:30.961Z
  Codex rollout       同上是 UTC,但**文件名和目录用的是本地时间** —— 二者能差一整天
  ChatGPT backend     列表接口给 ISO 字符串,会话正文里给 Unix 秒(float)
  git                 接受本地时间字符串

统一在这里换算,不让各采集器各自为政。所有对外暴露的窗口都是左闭右开 [lo, hi)。
"""

from datetime import datetime, timedelta, timezone


def _local_tz():
    """当前系统本地时区(WSL 通常继承 Windows 的 Asia/Shanghai)。"""
    return datetime.now().astimezone().tzinfo


class DayWindow:
    """某个本地自然日的时间窗,附带各数据源所需的表示形式。"""

    def __init__(self, date_str=None):
        if not date_str:
            date_str = datetime.now().strftime("%Y-%m-%d")
        tz = _local_tz()
        self.date = date_str
        self.lo_local = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=tz)
        self.hi_local = self.lo_local + timedelta(days=1)
        self.lo_utc = self.lo_local.astimezone(timezone.utc)
        self.hi_utc = self.hi_local.astimezone(timezone.utc)
        self.lo_epoch = self.lo_local.timestamp()
        self.hi_epoch = self.hi_local.timestamp()
        # 供字符串比较用(jsonl 里的 timestamp 是定长 ISO,字典序即时序)
        self.lo_iso = self.lo_utc.strftime("%Y-%m-%dT%H:%M:%S.%fZ")[:-4] + "Z"
        self.hi_iso = self.hi_utc.strftime("%Y-%m-%dT%H:%M:%S.%fZ")[:-4] + "Z"
        # git 用本地时间字符串
        self.git_since = self.lo_local.strftime("%Y-%m-%d %H:%M:%S")
        self.git_until = self.hi_local.strftime("%Y-%m-%d %H:%M:%S")

    def contains_epoch(self, epoch):
        return epoch is not None and self.lo_epoch <= epoch < self.hi_epoch

    def contains(self, value):
        """接受 ISO 字符串或 Unix 秒,判断是否落在本窗口内。"""
        e = to_epoch(value)
        return self.contains_epoch(e)

    def prefilter_hints(self):
        """用于逐行扫描前的廉价字符串预筛。

        动辄几万行的 jsonl 全量 json.loads 很慢,先用子串命中筛掉绝大多数行。
        窗口跨越两个 UTC 日期,故返回两天的日期前缀。
        """
        return {self.lo_utc.strftime("%Y-%m-%dT"), self.hi_utc.strftime("%Y-%m-%dT")}

    def local_hhmm(self, value):
        e = to_epoch(value)
        if e is None:
            return "--:--"
        return datetime.fromtimestamp(e, _local_tz()).strftime("%H:%M")

    def local_time(self, value):
        e = to_epoch(value)
        if e is None:
            return None
        return datetime.fromtimestamp(e, _local_tz()).strftime("%Y-%m-%d %H:%M:%S")

    def __repr__(self):
        return f"<DayWindow {self.date} local=[{self.lo_local}, {self.hi_local}) utc=[{self.lo_iso}, {self.hi_iso})>"


def to_epoch(value):
    """把任意来源的时间表示统一成 Unix 秒。无法解析时返回 None。"""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        # ChatGPT 用秒;偶见毫秒级数值,按量级判别
        return float(value) / 1000.0 if value > 1e11 else float(value)
    if not isinstance(value, str):
        return None
    s = value.strip()
    if not s:
        return None
    try:
        # ISO-8601,可能带 Z 或 ±HH:MM;不带时区的按本地时间解释
        iso = s.replace("Z", "+00:00")
        dt = datetime.fromisoformat(iso)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=_local_tz())
        return dt.timestamp()
    except ValueError:
        pass
    try:
        return float(s)
    except ValueError:
        return None
