#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""中国农业大学强智教务 · 本地探测脚本（只跑一次，不保存密码）

目的
----
在写正式客户端之前，先确认农大教务系统的真实接口和页面结构：
  · 登录：/Logon.do?method=logon&flag=sess + encoded
  · 课表：/jsxsd/xskb/xskb_list.do
  · 成绩：/jsxsd/kscj/cjcx_list
  · 考试：/jsxsd/xsks/xsksap_list
  · 学期、学籍、培养计划等

它会做三件事：
  1. 在本机终端里问学号/密码（密码不回显、不落盘）
  2. 登录后把候选页面的 HTML 存到 _probe/html/，方便离线写解析器
  3. 把每页的状态、标题、表格数量、是否像登录页写成 _probe/report.json

🔴 隐私：
  · 密码只存在内存里，不写文件、不打印
  · HTML 里会有姓名、学号、课程、成绩，仅保存在本机 _probe/ 目录
  · _probe/ 已写进 .gitignore，不要把它发给别人

怎么跑
-----
双击 `运行探测.bat`，或在终端里：
    python probe_cau.py

跑完把 _probe/report.json 给 QoderWork 看（HTML 不用发）。
"""

from __future__ import annotations

import getpass
import json
import re
import sys
import time
from pathlib import Path
from urllib.parse import urljoin

import requests

# Windows 控制台默认可能是 GBK；统一成 UTF-8，避免中文标题变乱码。
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

BASE = "https://newjw.cau.edu.cn"
JSXS = "/jsxsd"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

HERE = Path(__file__).resolve().parent
OUT = HERE / "_probe"
HTML_DIR = OUT / "html"
REPORT = OUT / "report.json"

# 两次请求之间至少隔多久，别把学校服务器打疼
GAP = 0.7
_last = 0.0

# 候选页面。先跑登录页，再按顺序试；每个都记录状态和特征。
# 这些是强智 jsxsd 的标准路径，农大部署可能略有差异，所以探测脚本
# 的设计是「先看主页面上的真实链接，再试标准路径」，两边互相印证。
CANDIDATES = [
    # (标签, 方法, 路径, 表单/查询参数)
    ("main", "GET", "/jsxsd/framework/xsMain.jsp", None),
    ("main_v", "GET", "/jsxsd/framework/xsMainV.jsp", None),
    ("timetable_get", "GET", "/jsxsd/xskb/xskb_list.do", None),
    ("timetable_post", "POST", "/jsxsd/xskb/xskb_list.do", {"xnxq01id": "", "zc": ""}),
    ("grades_get", "GET", "/jsxsd/kscj/cjcx_list", None),
    ("grades_post", "POST", "/jsxsd/kscj/cjcx_list",
     {"kksj": "", "kcxz": "", "kcmc": "", "xsfs": "all"}),
    ("exams_get", "GET", "/jsxsd/xsks/xsksap_list", None),
    ("exams_post", "POST", "/jsxsd/xsks/xsksap_list", {"xqlbmc": "", "xnxqid": ""}),
    ("profile", "GET", "/jsxsd/xxwc/xjxx", None),
    ("plan", "GET", "/jsxsd/xxwc/pyfa", None),
    ("rooms", "GET", "/jsxsd/kbcx/kbxx_classroom", None),
    ("rounds", "GET", "/jsxsd/xsxk/xklc_list", None),
]


def _polite() -> None:
    global _last
    gap = time.time() - _last
    if gap < GAP:
        time.sleep(GAP - gap)
    _last = time.time()


def _text(resp: requests.Response) -> str:
    """按页面声明的字符集解码。强智常见 GBK，硬按 UTF-8 会乱码。"""
    raw = resp.content or b""
    m = re.search(rb'charset=["\']?\s*([\w-]+)', raw[:3000], re.I)
    enc = m.group(1).decode("ascii", "ignore") if m else "utf-8"
    try:
        return raw.decode(enc, errors="replace")
    except LookupError:
        return raw.decode("utf-8", errors="replace")


def _title(html: str) -> str:
    m = re.search(r"<title[^>]*>(.*?)</title>", html, re.S | re.I)
    return re.sub(r"\s+", " ", m.group(1)).strip() if m else ""


def _safe_url(url: str) -> str:
    """报告里不放可能带票据/会话的参数值。"""
    try:
        from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode
        s = urlsplit(url or "")
        q = []
        for k, v in parse_qsl(s.query, keep_blank_values=True):
            if re.search(r"(ticket|token|session|jsessionid|password|pwd)", k, re.I):
                v = "***"
            q.append((k, v))
        return urlunsplit((s.scheme, s.netloc, s.path, urlencode(q), s.fragment))
    except Exception:
        return url or ""


def _count(html: str, pattern: str) -> int:
    return len(re.findall(pattern, html, re.I))


def _looks_login(html: str) -> bool:
    return bool(
        re.search(r'id=["\']loginForm["\']', html, re.I)
        or re.search(r"请输入密码|用户登录|请先登录系统", html)
    )


def _looks_captcha(html: str) -> bool:
    return "验证码" in html or "verifycode" in html.lower()


def _meta(tag: str, url: str, resp: requests.Response | None,
          html: str = "", note: str = "") -> dict:
    return {
        "tag": tag,
        "url": _safe_url(url),
        "status": resp.status_code if resp is not None else 0,
        "bytes": len(resp.content) if resp is not None else 0,
        "title": _title(html),
        "tables": _count(html, r"<table\b"),
        "rows": _count(html, r"<tr\b"),
        "login_page": _looks_login(html),
        "captcha": _looks_captcha(html),
        "has_kbcontent": "kbcontent" in html.lower(),
        "has_cjcx": "cjcx" in html.lower(),
        "has_xsks": "xsks" in html.lower(),
        "has_xnxq": "xnxq" in html.lower(),
        "note": note,
    }


def _save(tag: str, html: str, resp: requests.Response | None) -> None:
    HTML_DIR.mkdir(parents=True, exist_ok=True)
    (HTML_DIR / f"{tag}.html").write_text(html, encoding="utf-8", errors="replace")
    if resp is not None:
        (HTML_DIR / f"{tag}.url.txt").write_text(
            f"{resp.status_code}\n{resp.url}\n", encoding="utf-8")


def _options(html: str, names: tuple[str, ...]) -> list[dict]:
    """从 <select id=xnxq01id> 里抠学期选项。"""
    out: list[dict] = []
    for name in names:
        for m in re.finditer(
                r'<select[^>]*(?:id|name)=["\']%s["\'][^>]*>(.*?)</select>'
                % re.escape(name), html, re.S | re.I):
            for v, label in re.findall(
                    r'<option[^>]*value=["\']([^"\']*)["\'][^>]*>(.*?)</option>',
                    m.group(1), re.S | re.I):
                label = re.sub(r"<[^>]+>", "", label)
                label = re.sub(r"\s+", " ", label).strip()
                if label:
                    out.append({"name": name, "value": v, "label": label})
    # 去重
    seen = set()
    uniq = []
    for item in out:
        key = (item["name"], item["value"], item["label"])
        if key not in seen:
            seen.add(key)
            uniq.append(item)
    return uniq


def _links(html: str, base: str) -> list[dict]:
    """主页面上的真实业务链接，用来发现标准路径之外的入口。"""
    want = re.compile(
        r"(xskb|kscj|xsks|xxwc|kbcx|xsxk|pyfa|xjxx|课表|成绩|考试|教室|培养|学籍)",
        re.I)
    out = []
    seen = set()
    for href, text in re.findall(
            r'<a[^>]+href=["\']([^"\']+)["\'][^>]*>(.*?)</a>', html, re.S | re.I):
        plain = re.sub(r"<[^>]+>", "", text)
        plain = re.sub(r"\s+", " ", plain).strip()
        if not want.search(href + " " + plain):
            continue
        url = urljoin(base, href.strip())
        key = (url, plain)
        if key in seen:
            continue
        seen.add(key)
        out.append({"url": _safe_url(url), "text": plain[:80]})
    return out[:120]


def encode_password(user: str, pwd: str, scode: str, sxh: str) -> str:
    """强智登录编码：学号%%%密码 的前 20 个字符后，按 sxh 逐位插入 scode。"""
    code = f"{user}%%%{pwd}"
    enc = []
    for i, ch in enumerate(code):
        if i >= 20:
            enc.append(code[i:])
            break
        n = int(sxh[i])
        enc.append(ch)
        enc.append(scode[:n])
        scode = scode[n:]
    return "".join(enc)


def login(session: requests.Session, user: str, pwd: str) -> dict:
    session.headers.update({
        "User-Agent": UA,
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    })
    # 先访问登录页，拿 JSESSIONID / SERVERID
    _polite()
    r0 = session.get(BASE + JSXS + "/xsMain.jsp", timeout=25)
    _save("00_login_page", _text(r0), r0)

    # 强智的种子在根路径，不在 /jsxsd/ 下（2026-10-31 实测）
    _polite()
    seed_resp = session.post(
        BASE + "/Logon.do?method=logon&flag=sess",
        headers={"Referer": BASE + JSXS + "/xsMain.jsp",
                 "X-Requested-With": "XMLHttpRequest"},
        timeout=20,
    )
    seed = (seed_resp.text or "").strip()
    if "#" not in seed:
        raise RuntimeError(
            "没取到登录加密种子，学校系统可能改版了。返回前 200 字：%r" % seed[:200])

    scode, sxh = seed.split("#", 1)
    encoded = encode_password(user, pwd, scode, sxh)

    _polite()
    r = session.post(
        BASE + "/Logon.do?method=logon",
        data={
            "userAccount": user,
            "userPassword": "",
            "encoded": encoded,
            "RANDOMCODE": "",
        },
        headers={"Referer": BASE + JSXS + "/xsMain.jsp",
                 "Origin": BASE},
        allow_redirects=True,
        timeout=30,
    )
    html = _text(r)
    _save("01_after_login", html, r)

    ok = ("xsmain" in r.url.lower() or "framework" in r.url.lower()
          or "xsMain" in r.url)
    if not ok:
        if "验证码" in html or "verifycode" in html.lower():
            raise RuntimeError("系统要求验证码：请先在浏览器手动登录一次，等几分钟再跑")
        if _looks_login(html):
            raise RuntimeError("登录失败：学号或密码不对（或账号被临时限制）")
        # 兜底：已经离开登录页，但 URL 没匹配上
        if "loginForm" not in html and "xsMain.jsp" not in r.url:
            ok = True
    return {
        "ok": ok,
        "final_url": _safe_url(r.url),
        "cookies": sorted(session.cookies.keys()),
        "seed_len": len(seed),
        "encoded_len": len(encoded),
        "note": "" if ok else "登录后仍在登录页或未跳转",
    }


def main() -> int:
    print("=" * 62)
    print("  中国农业大学 · 教务系统探测")
    print("=" * 62)
    print("说明：密码只存在内存里，不写文件、不打印。")
    print("      采集到的页面会存到 _probe/，仅供本机写解析器使用。")
    print()

    user = input("学号：").strip()
    if not user:
        print("学号不能为空")
        return 2
    pwd = getpass.getpass("密码（不会显示）：")
    if not pwd:
        print("密码不能为空")
        return 2

    OUT.mkdir(parents=True, exist_ok=True)
    HTML_DIR.mkdir(parents=True, exist_ok=True)
    session = requests.Session()

    report: dict = {
        "at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "base": BASE,
        "login": None,
        "semesters": [],
        "endpoints": [],
        "links": [],
        "notes": [],
    }

    try:
        report["login"] = login(session, user, pwd)
        print("\n登录结果：", "成功" if report["login"]["ok"] else "未确认")
        print("最终地址：", report["login"]["final_url"])
    except Exception as exc:  # noqa: BLE001
        report["login"] = {"ok": False, "error": str(exc)}
        print("\n登录失败：", exc)
        REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2),
                          encoding="utf-8")
        print("已写报告：", REPORT)
        return 1

    # 主页面 + 真实链接
    try:
        _polite()
        rm = session.get(BASE + JSXS + "/framework/xsMain.jsp", timeout=25)
        hm = _text(rm)
        _save("02_main", hm, rm)
        report["endpoints"].append(_meta("main", rm.url, rm, hm))
        report["links"] = _links(hm, rm.url)
        # 如果主页面不是真正的主页，再试 xsMainV
        if _looks_login(hm):
            _polite()
            rv = session.get(BASE + JSXS + "/framework/xsMainV.jsp", timeout=25)
            hv = _text(rv)
            _save("03_main_v", hv, rv)
            report["endpoints"].append(_meta("main_v", rv.url, rv, hv))
            report["links"] += _links(hv, rv.url)
    except Exception as exc:  # noqa: BLE001
        report["notes"].append("取主页面失败：%s" % exc)

    # 从主页面和课表页找学期选项
    semesters = []
    for tag, method, path, data in CANDIDATES:
        # 主页面已经取过，跳过重复
        if tag in ("main", "main_v"):
            continue
        url = BASE + path
        try:
            _polite()
            if method == "GET":
                r = session.get(url, timeout=25)
            else:
                r = session.post(url, data=data or {}, timeout=25,
                                 headers={"Referer": BASE + JSXS + "/"})
            html = _text(r)
            _save(tag, html, r)
            meta = _meta(tag, r.url, r, html)
            report["endpoints"].append(meta)
            if not semesters:
                semesters = _options(html, ("xnxq01id", "xnxqid"))
            print("  %-14s %s %5d 字节  %s" %
                  (tag, meta["status"], meta["bytes"], meta["title"][:40]))
        except Exception as exc:  # noqa: BLE001
            report["endpoints"].append({
                "tag": tag, "url": _safe_url(url), "status": 0, "error": str(exc)
            })
            print("  %-14s 失败：%s" % (tag, exc))

    report["semesters"] = semesters

    # 如果从主页面/课表页拿到了学期，带着第一个学期再取一次课表，
    # 这样能拿到真正有课程的页面，而不是空壳。
    if semesters:
        sem = semesters[0]["value"]
        try:
            _polite()
            r = session.post(BASE + JSXS + "/xskb/xskb_list.do",
                             data={"xnxq01id": sem, "zc": ""}, timeout=25,
                             headers={"Referer": BASE + JSXS + "/"})
            html = _text(r)
            _save("timetable_with_semester", html, r)
            report["endpoints"].append(
                _meta("timetable_with_semester", r.url, r, html,
                      note="xnxq01id=%s" % sem))
        except Exception as exc:  # noqa: BLE001
            report["notes"].append("带学期取课表失败：%s" % exc)

    # 汇总判断
    checks = {e.get("tag"): e for e in report["endpoints"]}
    def state(tag: str, key: str = "") -> str:
        e = checks.get(tag)
        if not e:
            return "没试"
        if e.get("login_page"):
            return "跳回登录页"
        if key and not e.get(key):
            return "页面里没有 %s" % key
        return "有内容" if e.get("tables") or e.get("bytes", 0) > 2000 else "页面偏小"

    print("\n关键页面判断：")
    print("  课表：", state("timetable_post", "has_kbcontent"))
    print("  成绩：", state("grades_post", "has_cjcx"))
    print("  考试：", state("exams_post", "has_xsks"))
    print("  学期：", "找到 %d 个" % len(semesters) if semesters else "没找到")

    report["notes"].append(
        "请优先看 timetable_with_semester / grades_post / exams_post 的 HTML；"
        "如果这些页面是登录页，说明对应路径不对，需要从 links 里找真实入口。")
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2),
                      encoding="utf-8")

    print("\n完成。报告：", REPORT)
    print("HTML 目录：", HTML_DIR)
    print("把 report.json 给 QoderWork 看即可；HTML 不用发。")
    print()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n已取消。")
        sys.exit(130)
