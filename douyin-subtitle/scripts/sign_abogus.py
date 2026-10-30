# sign_abogus.py —— 给抖音网页接口的 query 加 a_bogus 签名（web_api.mjs 调用）
# stdin: {"query": "<不含 a_bogus 的 query>", "ua": "<请求要用的 User-Agent>", "impl": "dtk"|"f2"}
# stdout: {"query": "<加了 &a_bogus=... 的 query>"}
#
# impl:
#   dtk（默认）: abogus_dtk.py —— DTK 2026-09-09 对 bdms.js v1.0.1.19-fix.01 的逆向，纯 Python 无依赖
#   f2         : abogus.py    —— f2 项目 2024-11 的 1.0.1.19 版（经 jiji262 拷贝），依赖 gmssl；留作对照
import json
import os
import sys
from urllib.parse import quote

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

req = json.load(sys.stdin)
# 签名里编码了 UA，发请求时必须用同一个
if req.get("impl", "dtk") == "f2":
    from abogus import ABogus, BrowserFingerprintGenerator  # noqa: E402

    signer = ABogus(fp=BrowserFingerprintGenerator.generate_fingerprint("Chrome"), user_agent=req["ua"])
    signed, _ab, _ua, _body = signer.generate_abogus(req["query"], "")
else:
    from abogus_dtk import ABogus  # noqa: E402

    # 默认浏览器信息 1920x1080 Win32，与 web_api.mjs 的 screen_width/height、browser_platform 参数一致
    value = ABogus(req["ua"]).get_value(req["query"])
    # s4 字母表含 '/' 和 '='，回填 query 时要百分号编码（同 DTK signer._sign_a_bogus）
    signed = f"{req['query']}&a_bogus={quote(value, safe='')}"
print(json.dumps({"query": signed}))
