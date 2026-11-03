# -*- coding: utf-8 -*-
"""农专 · 校园通知（公开页面，不需要登录）

接两个稳定源：学校主页「通知公告」和本科生院首页的通知块。
本科生院的通知列表页会跳 permission，但首页这块是公开的。

列表结构（2026-10-31 实测）：
    <div class="item">
      <div class="time_box"><div class="day">23</div><div class="month">2026.09</div></div>
      <div class="info_box">
        <a href="...htm" class="title ...">标题</a>
        <a class="tip ...">后勤保障处</a>
      </div>
    </div>
"""

from __future__ import annotations

import html as _html
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

SOURCE = ("学校通知", "https://www.cau.edu.cn/tzgg/index.htm", "学校")
TTL = 30 * 60

# 学生不关心的噪音：招聘/招租/招标/采购/拟聘。学校主页通知公告里这类占很大比例，
# 不滤掉的话第一页几乎全是「博士后招聘」。
_DROP = (
    "招聘", "招租", "招标", "采购", "中标", "询价", "博士后", "科研助理",
    "拟聘", "合同聘用", "人员公示", "人才派遣", "劳务派遣",
    "人才评议", "中选", "遴选", "合作经营", "公开遴选",
    "诚聘", "财务助理", "科研/财务", "院务会",
)

_LOCK = threading.Lock()
_CACHE: dict = {"at": 0.0, "data": None, "full": []}


def _clean(s: str) -> str:
    s = re.sub(r"<[^>]+>", "", s or "")
    s = _html.unescape(s)
    return re.sub(r"\s+", " ", s).strip()


def _get(url: str, timeout: int = 20, retries: int = 2) -> str:
    last: Exception | None = None
    for i in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA,
                "Accept-Language": "zh-CN,zh;q=0.9",
                "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
            })
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                enc = "utf-8"
                m = re.search(rb'charset=["\']?\s*([\w-]+)', raw[:3000], re.I)
                if m:
                    enc = m.group(1).decode("ascii", "ignore")
                try:
                    return raw.decode(enc, errors="replace")
                except LookupError:
                    return raw.decode("utf-8", errors="replace")
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(0.6 * (i + 1))
    raise RuntimeError("连不上学校通知页：%s" % last)


def _div_blocks(html: str, cls: str) -> list[str]:
    out = []
    pat = re.compile(
        r'<div\b[^>]*\bclass=["\'][^"\']*\b%s\b[^"\']*["\'][^>]*>' % re.escape(cls),
        re.I)
    for m in pat.finditer(html):
        i = m.end()
        depth = 1
        for tag in re.finditer(r"<div\b|</div\s*>", html[i:], re.I):
            if tag.group(0).lower().startswith("</"):
                depth -= 1
                if depth == 0:
                    out.append(html[i:i + tag.start()])
                    break
            else:
                depth += 1
    return out


def _parse_list(html: str, base: str, limit: int = 60,
                source_name: str = "学校通知", drop: bool = True,
                stats: dict | None = None) -> list[dict]:
    """解析学校主页「通知公告」列表。

    `drop=False` 时不过滤招聘/招租这类噪音（界面上的「显示全部」走这条路）。
    `stats["hidden"]` 记下滤掉几条 —— 界面上要如实说出来，否则用户只看到
    「最新的是 10 月 15 日」，会以为程序没更新。
    """
    items: list[dict] = []
    for block in _div_blocks(html, "item"):
        dm = re.search(r'class=["\'][^"\']*\bday\b[^"\']*["\'][^>]*>\s*(\d{1,2})\s*<', block, re.I)
        mm = re.search(r'class=["\'][^"\']*\bmonth\b[^"\']*["\'][^>]*>\s*([\d.]{5,10})\s*<', block, re.I)
        if not dm or not mm:
            continue
        tm = re.search(
            r'<a[^>]+href=["\']([^"\']+)["\'][^>]*class=["\'][^"\']*\btitle\b[^"\']*["\'][^>]*>(.*?)</a>',
            block, re.S | re.I)
        if not tm:
            continue
        href = tm.group(1).strip()
        title = _clean(tm.group(2))
        if not title:
            continue
        if drop and any(k in title for k in _DROP):
            if stats is not None:
                stats["hidden"] = stats.get("hidden", 0) + 1
            continue
        dept = ""
        dm2 = re.search(
            r'<a[^>]*class=["\'][^"\']*\btip\b[^"\']*["\'][^>]*>(.*?)</a>',
            block, re.S | re.I)
        if dm2:
            dept = _clean(dm2.group(1))
        date = ""
        if dm and mm:
            parts = re.findall(r"\d+", mm.group(1))
            if len(parts) >= 2:
                date = "%04d-%02d-%02d" % (int(parts[0]), int(parts[1]), int(dm.group(1)))
        url = urllib.parse.urljoin(base, href)
        # 只收学校域名，防止页面被改成外链跳板
        host = (urllib.parse.urlparse(url).hostname or "").lower()
        if not (host == "cau.edu.cn" or host.endswith(".cau.edu.cn")):
            continue
        items.append({
            "title": title,
            "url": url,
            "date": date,
            "source": source_name,
            "dept": dept,
        })
        if len(items) >= limit:
            break
    return items



def _parse_jwc(html: str, base: str, limit: int = 80, drop: bool = True,
               stats: dict | None = None) -> list[dict]:
    """本科生院首页的通知块（jwc.cau.edu.cn）。

    这个列表页本身会跳 permission，但首页这块是公开的。
    """
    items: list[dict] = []
    li_re = re.compile(r"""<li[^>]*class=["'][^"']*effect[^"']*["'][^>]*>(.*?)</li>""", re.S | re.I)
    a_re = re.compile(r"""<a[^>]+href=["']([^"']+)["']""", re.I)
    h3_re = re.compile(r"""<h3[^>]*class=["'][^"']*bbs-title[^"']*["'][^>]*>(.*?)</h3>""", re.S | re.I)
    time_re = re.compile(r"""<span[^>]*class=["'][^"']*bbs-time[^"']*["'][^>]*>(.*?)</span>""", re.S | re.I)
    tag_re = re.compile(r"""<span[^>]*class=["'][^"']*bbs-tag[^"']*["'][^>]*>.*?<i>(.*?)</i>""", re.S | re.I)
    for block in li_re.findall(html):
        hm = a_re.search(block)
        tm = h3_re.search(block)
        if not hm or not tm:
            continue
        title = _clean(tm.group(1))
        if not title:
            continue
        if drop and any(k in title for k in _DROP):
            if stats is not None:
                stats["hidden"] = stats.get("hidden", 0) + 1
            continue
        dm = time_re.search(block)
        date = ""
        if dm:
            raw = _clean(dm.group(1))
            m = re.search(r"(\d{1,2})/(\d{1,2}),?\s*(20\d{2})", raw)
            if m:
                date = "%s-%02d-%02d" % (m.group(3), int(m.group(1)), int(m.group(2)))
        tag = ""
        gm = tag_re.search(block)
        if gm:
            tag = _clean(gm.group(1))
        url = urllib.parse.urljoin(base, hm.group(1).strip())
        host = (urllib.parse.urlparse(url).hostname or "").lower()
        if not (host == "cau.edu.cn" or host.endswith(".cau.edu.cn")):
            continue
        items.append({
            "title": title,
            "url": url,
            "date": date,
            "source": "本科生院",
            "dept": tag,
        })
        if len(items) >= limit:
            break
    return items


def fetch_list(limit: int = 40, force: bool = False, show_all: bool = False) -> dict:
    """取通知列表。

    🔴 为什么默认要过滤、还要翻 6 页：
       学校主页「通知公告」一页 20 条里，招聘/招租/人才评议能占 18 条（2026-11-01
       实测）。只翻 1 页、又滤掉噪音的话，列表就只剩两三条、而且最新的一条是
       半个月前的 —— 用户会以为程序坏了。所以这里多翻几页，并把「藏了几条」
       如实报给界面（`hidden`），界面上给一个「显示全部」的开关。
    """
    limit = max(1, min(80, int(limit or 40)))
    now = time.time()
    if not show_all:
        with _LOCK:
            if not force and _CACHE["data"] is not None and now - _CACHE["at"] < TTL:
                data = dict(_CACHE["data"])
                full = list(_CACHE.get("full") or data.get("items") or [])
                data["items"] = full[:limit]
                data["total"] = len(full)
                data["cached"] = True
                return data

    stats = {"hidden": 0}
    try:
        # 6 页：滤完之后通常还剩十几条，够一屏多了
        pages = [SOURCE[1]] + [
            urllib.parse.urljoin(SOURCE[1], "index%d.htm" % i) for i in range(1, 6)
        ]
        items: list[dict] = []
        seen: set[str] = set()
        last_err = ""
        source_count = 0
        for page_url in pages:
            try:
                page = _get(page_url)
                for it in _parse_list(page, page_url, limit=80,
                                      drop=not show_all, stats=stats):
                    if it["url"] in seen:
                        continue
                    seen.add(it["url"])
                    items.append(it)
                    if len(items) >= 80:
                        break
            except Exception as exc:  # noqa: BLE001
                last_err = str(exc)
            # 够一屏就不再翻下一页：少给学校服务器添麻烦
            if len(items) >= limit:
                break
        # 本科生院首页：列表页会跳权限页，但首页这块通知是公开的
        try:
            jwc_html = _get("https://jwc.cau.edu.cn/")
            for it in _parse_jwc(jwc_html, "https://jwc.cau.edu.cn/", limit=80,
                                 drop=not show_all, stats=stats):
                if it["url"] in seen:
                    continue
                seen.add(it["url"])
                items.append(it)
            source_count = 2
        except Exception as exc:  # noqa: BLE001
            last_err = str(exc)
        if not items:
            raise RuntimeError(last_err or "页面里没解析出通知，学校可能改版了")
        items.sort(key=lambda x: x.get("date") or "0000-00-00", reverse=True)
        data = {
            "ok": True,
            "at": int(now),
            "cached": False,
            "total": len(items),
            "items": items[:limit],
            "sources": source_count or 1,
            "hidden": stats["hidden"],
            "all": show_all,
        }
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc), "items": [], "total": 0,
                "hidden": stats["hidden"]}
    if not show_all:
        with _LOCK:
            _CACHE["at"] = now
            _CACHE["data"] = data
            _CACHE["full"] = items
    return data


if __name__ == "__main__":
    import json
    import sys
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    print(json.dumps(fetch_list(5), ensure_ascii=False, indent=2))
