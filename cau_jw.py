# -*- coding: utf-8 -*-
"""中国农业大学强智教务客户端（只读）

登录、课表、成绩、考试、学期。全部基于 newjw.cau.edu.cn/jsxsd 的真实页面，
2026-10-31 用真实账号抓过样本（见 _probe/，不提交）。

设计原则：
  · 只读：不选课、不评教、不提交任何表单
  · 复用会话：登录一次，后续课表/成绩/考试都走同一个 session
  · 会话失效只重登一次，不循环打学校服务器
  · 解析失败要说清楚是「登录过期」「页面改版」还是「真的没数据」
"""

from __future__ import annotations

import getpass
import html as _html
import json
import re
import sys
import time
from typing import Any

import requests

BASE = "https://newjw.cau.edu.cn"
JSXS = "/jsxsd"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

# 两次请求的最小间隔。强智对频繁请求比较敏感，0.8 秒是在「不把学校服务器
# 打疼」和同步速度（一次要取 5 个页面）之间的折中值。
POLITE_DELAY = 0.8


class CauError(Exception):
    """kind:
        auth    —— 学号/密码不对，或系统要求验证码
        expired —— 会话过期，需要重新登录
        net     —— 网络/服务器问题
        parse   —— 页面结构和预期不一致（学校改版）
    """

    def __init__(self, msg: str, kind: str = "net", code: str = "") -> None:
        super().__init__(msg)
        self.kind = kind
        self.code = code


# ------------------------------------------------------------------ 小工具

def _clean_text(s: str) -> str:
    s = re.sub(r"<br\s*/?>", "\n", s or "", flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    s = _html.unescape(s)
    s = s.replace("\xa0", " ")
    return re.sub(r"[ \t]+", " ", s).strip()


def _cell_text(s: str) -> str:
    return re.sub(r"\s+", " ", _clean_text(s)).strip()


def _table_by_id(html: str, table_id: str) -> str:
    m = re.search(
        r'<table[^>]*\bid=["\']%s["\'][^>]*>.*?</table>' % re.escape(table_id),
        html, re.S | re.I)
    return m.group(0) if m else ""


def _rows(table_html: str) -> list[str]:
    return re.findall(r"<tr[^>]*>(.*?)</tr>", table_html, re.S | re.I)


def _cells(row_html: str) -> list[str]:
    return re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row_html, re.S | re.I)


def _div_blocks(html: str, cls: str) -> list[str]:
    """取出 class 含 cls 的 div 的内部 HTML（按 div 深度配对）。

    强智课表的格子是：
        <div class="kbcontent"> ... <div class='per-bg7'> ... </div> ... </div>
    普通非贪婪正则会停在内部 div 的 </div>，多课程格就会漏掉第二门。
    """
    out: list[str] = []
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


def _parse_weeks(text: str) -> list[int]:
    """1-11(周) / 5,7-16(周) / 14(周) -> [1..11] / [5,7..16] / [14]"""
    m = re.search(r"([\d,\-]+)\s*\(\s*周\s*\)", text or "")
    if not m:
        return []
    out: set[int] = set()
    for part in m.group(1).split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            try:
                out.update(range(int(a), int(b) + 1))
            except ValueError:
                continue
        else:
            try:
                out.add(int(part))
            except ValueError:
                continue
    return sorted(out)


def _parse_periods(text: str) -> list[int]:
    """[01-02节] / [05-06-07-08节] / [09-10-11节] -> [1,2] / [5,6,7,8] / [9,10,11]"""
    m = re.search(r"\[([\d\-]+)\s*节\]", text or "")
    if not m:
        return []
    out = []
    for part in m.group(1).split("-"):
        try:
            out.append(int(part))
        except ValueError:
            pass
    return out


def _semester_options(html: str) -> tuple[list[dict], dict | None]:
    """解析 <select name="xnxq01id"> 的学期选项，返回 (列表, 当前项)。"""
    block = ""
    for name in ("xnxq01id", "xnxqid"):
        m = re.search(
            r'<select[^>]*(?:id|name)=["\']%s["\'][^>]*>(.*?)</select>'
            % re.escape(name), html, re.S | re.I)
        if m:
            block = m.group(1)
            break
    if not block:
        return [], None
    out: list[dict] = []
    current = None
    for m in re.finditer(r"<option([^>]*)>(.*?)</option>", block, re.S | re.I):
        attrs, label_raw = m.group(1), m.group(2)
        vm = re.search(r'value=["\']([^"\']*)["\']', attrs, re.I)
        value = vm.group(1) if vm else ""
        label = re.sub(r"\s+", " ", _clean_text(label_raw)).strip()
        if not label:
            continue
        item = {
            "value": value,
            "label": label,
            "current": "selected" in attrs.lower(),
        }
        out.append(item)
        if item["current"]:
            current = item
    if current is None and out:
        current = out[0]
    return out, current


def _looks_login(html: str) -> bool:
    return bool(
        re.search(r'id=["\']loginForm["\']', html, re.I)
        or re.search(r"请输入密码|请先登录系统|用户登录", html)
    )


def encode_password(user: str, pwd: str, scode: str, sxh: str) -> str:
    """强智登录编码：学号%%%密码 的前 20 个字符后，按 sxh 逐位插入 scode。"""
    code = f"{user}%%%{pwd}"
    enc: list[str] = []
    for i, ch in enumerate(code):
        if i >= 20:
            enc.append(code[i:])
            break
        n = int(sxh[i])
        enc.append(ch)
        enc.append(scode[:n])
        scode = scode[n:]
    return "".join(enc)


# ------------------------------------------------------------------ 解析器

def parse_timetable(html: str) -> dict:
    """把学期理论课表页面解析成统一 schema。

    CAU 的课表是 6 个「大节」×7 天。每个格子里有一份可见的 kbcontent1
    和一份隐藏的 kbcontent（多了教师/周次节次）。解析隐藏那份。
    """
    semesters, current = _semester_options(html)
    table = ""
    m = re.search(r'<table[^>]*\bid=["\']timetable["\'][^>]*>.*?</table>',
                  html, re.S | re.I)
    if m:
        table = m.group(0)
    if not table:
        raise CauError("课表页面里没有 timetable 表格，学校可能改版了", "parse")

    rows = _rows(table)
    if not rows:
        raise CauError("课表表格是空的", "parse")

    times: list[list[str]] = []
    period_to_big: dict[int, int] = {}
    big_small: list[list[int]] = []
    big_rows: list[tuple[str, str, re.Match | None, re.Match | None]] = []
    for row in rows[1:]:
        th = re.search(r"<th[^>]*>(.*?)</th>", row, re.S | re.I)
        if not th:
            continue
        head = _clean_text(th.group(1))
        tm = re.search(r"(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})", head)
        pm = re.search(r"\(([\d,]+)\s*小节\)", head)
        # 表尾的「备注:」行也有 <th>，但没有 7 个 <td>，不能算大节
        if not tm and not pm:
            continue
        if len(re.findall(r"<td[^>]*>", row, re.I)) < 7:
            continue
        big_rows.append((row, head, tm, pm))

    for big, (row, head, tm, pm) in enumerate(big_rows):
        times.append([tm.group(1), tm.group(2)] if tm else ["", ""])
        smalls = []
        if pm:
            for x in pm.group(1).split(","):
                try:
                    smalls.append(int(x))
                except ValueError:
                    pass
        big_small.append(smalls)
        for sp in smalls:
            period_to_big[sp] = big

    merged: dict[tuple, dict] = {}
    for r, (row, _head, _tm, _pm) in enumerate(big_rows):
        tds = re.findall(r"<td[^>]*>(.*?)</td>", row, re.S | re.I)
        for day, td in enumerate(tds[:7]):
            blocks = _div_blocks(td, "kbcontent")
            for block in blocks:
                # 一个格子里可能撞两门课，用 --------------------- 分隔
                for part in re.split(r"-{5,}", block):
                    if not part.strip() or ("&nbsp;" in part and not _clean_text(part)):
                        continue
                    teacher_m = re.search(
                        r"<font[^>]*title=['\"]教师['\"][^>]*>(.*?)</font>",
                        part, re.S | re.I)
                    weeks_m = re.search(
                        r"<font[^>]*title=['\"]周次\(节次\)['\"][^>]*>(.*?)</font>",
                        part, re.S | re.I)
                    room_m = re.search(
                        r"<font[^>]*title=['\"]教室['\"][^>]*>(.*?)</font>",
                        part, re.S | re.I)
                    teacher = _clean_text(teacher_m.group(1)) if teacher_m else ""
                    weeks_text = _clean_text(weeks_m.group(1)) if weeks_m else ""
                    room = _clean_text(room_m.group(1)) if room_m else ""

                    head = part.split("<font", 1)[0]
                    head = re.sub(r"<div[^>]*>", "", head, flags=re.I)
                    lines = [_cell_text(x) for x in re.split(r"<br\s*/?>", head, flags=re.I)]
                    lines = [x for x in lines if x]
                    if not lines:
                        continue
                    name = lines[0]
                    code = ""
                    class_no = ""
                    if len(lines) > 1:
                        cm = re.match(r"^([0-9A-Za-z]+)\s+(\S+)?", lines[1])
                        if cm:
                            code = cm.group(1)
                            class_no = cm.group(2) or ""
                        else:
                            code = lines[1]
                    extra = lines[2:]

                    weeks = _parse_weeks(weeks_text)
                    if not weeks:
                        continue
                    periods = _parse_periods(weeks_text)
                    if periods:
                        slots_big = sorted({period_to_big.get(p, r) for p in periods})
                    else:
                        slots_big = [r]
                    slots = [{"day": day, "period": b} for b in slots_big]
                    campus = ""
                    cm2 = re.match(r"^\(([^)]+)\)", name)
                    if cm2:
                        campus = cm2.group(1)

                    key = (name, code, teacher, room, tuple(weeks))
                    if key in merged:
                        for s in slots:
                            if s not in merged[key]["slots"]:
                                merged[key]["slots"].append(s)
                    else:
                        merged[key] = {
                            "name": name,
                            "code": code,
                            "classNo": class_no,
                            "teacher": teacher,
                            "room": room,
                            "campus": campus,
                            "weeks": weeks,
                            "slots": slots,
                            "extra": extra,
                        }

    courses = sorted(
        merged.values(),
        key=lambda c: (c["slots"][0]["day"], c["slots"][0]["period"], c["name"]))
    total_weeks = max((max(c["weeks"]) for c in courses if c["weeks"]), default=0)
    return {
        "semester": current["label"] if current else "",
        "semesterId": current["value"] if current else "",
        "semesters": semesters,
        "unitCount": len(times),
        "times": times,
        "totalWeeks": total_weeks,
        "courses": courses,
    }


def parse_grades(html: str) -> dict:
    table = _table_by_id(html, "dataList")
    if not table:
        raise CauError("成绩页面里没有 dataList 表格，学校可能改版了", "parse")
    rows = _rows(table)
    if not rows:
        return {"courses": [], "summary": {"count": 0, "totalCredits": 0,
                                           "weighted": None, "byTerm": [],
                                           "letters": {}}}
    headers = [_cell_text(x) for x in _cells(rows[0])]
    # 表头里可能有换行；按关键字确定列位置，别写死
    def idx(*names):
        for i, h in enumerate(headers):
            if any(n in h for n in names):
                return i
        return -1

    i_term = idx("开课学期")
    i_code = idx("课程编号")
    i_name = idx("课程名称")
    i_credit = idx("学分")
    i_score = idx("成绩")
    i_way = idx("修读方式")
    i_attr = idx("课程属性")
    i_group = idx("课组类别")
    i_note = idx("备注")

    courses = []
    for row in rows[1:]:
        cells = [_cell_text(x) for x in _cells(row)]
        if len(cells) < 5 or not any(cells):
            continue
        # 有些行是「未查询到数据」
        if len(cells) == 1 and "未查询到" in cells[0]:
            continue
        def at(i):
            return cells[i] if 0 <= i < len(cells) else ""
        credit_raw = at(i_credit)
        try:
            credit = float(re.search(r"-?\d+(?:\.\d+)?", credit_raw).group(0))
        except Exception:
            credit = 0.0
        score = at(i_score)
        score_num = None
        sm = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*", score)
        if sm:
            score_num = float(sm.group(1))
        courses.append({
            "term": at(i_term),
            "code": at(i_code),
            "name": at(i_name),
            "credit": credit,
            "score": score,
            "scoreNum": score_num,
            "way": at(i_way),
            "attr": at(i_attr),
            "group": at(i_group),
            "note": at(i_note),
        })

    total_credits = round(sum(c["credit"] for c in courses), 2)
    numeric = [c for c in courses if c["scoreNum"] is not None and c["credit"] > 0]
    weighted = None
    if numeric:
        weighted = round(
            sum(c["scoreNum"] * c["credit"] for c in numeric) /
            sum(c["credit"] for c in numeric), 2)

    by_term: dict[str, dict] = {}
    for c in courses:
        t = c["term"] or "未知学期"
        d = by_term.setdefault(t, {"term": t, "count": 0, "credits": 0.0,
                                   "weightedNum": 0.0, "weightedDen": 0.0})
        d["count"] += 1
        d["credits"] += c["credit"]
        if c["scoreNum"] is not None and c["credit"] > 0:
            d["weightedNum"] += c["scoreNum"] * c["credit"]
            d["weightedDen"] += c["credit"]
    by_term_list = []
    for d in by_term.values():
        d["credits"] = round(d["credits"], 2)
        d["weighted"] = (round(d["weightedNum"] / d["weightedDen"], 2)
                         if d["weightedDen"] else None)
        d.pop("weightedNum", None)
        d.pop("weightedDen", None)
        by_term_list.append(d)
    by_term_list.sort(key=lambda x: x["term"], reverse=True)

    letters: dict[str, int] = {}
    for c in courses:
        if c["scoreNum"] is None and c["score"]:
            letters[c["score"]] = letters.get(c["score"], 0) + 1

    return {
        "courses": courses,
        "summary": {
            "count": len(courses),
            "totalCredits": total_credits,
            "weighted": weighted,
            "byTerm": by_term_list,
            "letters": letters,
        },
    }


def parse_exams(html: str) -> dict:
    table = _table_by_id(html, "dataList")
    if not table:
        raise CauError("考试页面里没有 dataList 表格，学校可能改版了", "parse")
    rows = _rows(table)
    if not rows:
        return {"exams": [], "published": False}
    headers = [_cell_text(x) for x in _cells(rows[0])]
    def idx(*names):
        for i, h in enumerate(headers):
            if any(n in h for n in names):
                return i
        return -1
    cols = {
        "campus": idx("校区"),
        "session": idx("考试场次"),
        "code": idx("课程编号"),
        "name": idx("课程名称"),
        "teacher": idx("授课教师"),
        "time": idx("考试时间"),
        "room": idx("考场"),
        "seat": idx("座位号"),
        "ticket": idx("准考证号"),
        "note": idx("备注"),
    }
    exams = []
    for row in rows[1:]:
        cells = [_cell_text(x) for x in _cells(row)]
        if len(cells) == 1 and "未查询到" in cells[0]:
            continue
        if not any(cells):
            continue
        def at(k):
            i = cols[k]
            return cells[i] if 0 <= i < len(cells) else ""
        name = at("name")
        if not name:
            continue
        when = at("time")
        date_m = re.search(r"(20\d{2})[-/年.](\d{1,2})[-/月.](\d{1,2})", when)
        date = ""
        if date_m:
            date = "%s-%02d-%02d" % (date_m.group(1), int(date_m.group(2)),
                                     int(date_m.group(3)))
        begin = ""
        end = ""
        tm = re.search(r"(\d{1,2}:\d{2})\s*[-~至]\s*(\d{1,2}:\d{2})", when)
        if tm:
            begin, end = tm.group(1), tm.group(2)
        exams.append({
            "campus": at("campus"),
            "session": at("session"),
            "code": at("code"),
            "name": name,
            "teacher": at("teacher"),
            "time": when,
            "date": date,
            "begin": begin,
            "end": end,
            "room": at("room"),
            "seat": at("seat"),
            "ticket": at("ticket"),
            "note": at("note"),
        })
    exams.sort(key=lambda e: (e["date"] or "9999", e["begin"] or ""))
    return {"exams": exams, "published": bool(exams)}


def parse_profile(html: str) -> dict:
    name = ""
    sid = ""
    m = re.search(r"姓名[：:]\s*([^<\s]{1,20})", html)
    if m:
        name = _clean_text(m.group(1))
    m = re.search(r"学号[：:]\s*([0-9A-Za-z]{4,30})", html)
    if m:
        sid = m.group(1)
    return {"name": name, "studentId": sid}



def _set_encoding(resp: requests.Response) -> None:
    """按响应头/页面 meta 选编码。强智不同部署 UTF-8 / GBK 都有。"""
    enc = ""
    ct = resp.headers.get("Content-Type", "") or ""
    m = re.search(r"charset=([\w-]+)", ct, re.I)
    if m:
        enc = m.group(1)
    else:
        raw = resp.content or b""
        m = re.search(rb"charset=[\"']?\s*([\w-]+)", raw[:3000], re.I)
        if m:
            enc = m.group(1).decode("ascii", "ignore")
    try:
        resp.encoding = enc or "utf-8"
    except Exception:
        resp.encoding = "utf-8"


# ------------------------------------------------------------------ 客户端

class CauClient:
    def __init__(self) -> None:
        self.s = requests.Session()
        self.s.headers.update({
            "User-Agent": UA,
            "Accept-Language": "zh-CN,zh;q=0.9",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Origin": BASE,
            "Referer": BASE + JSXS + "/",
        })
        self._last = 0.0
        self._logged_in = False
        self._user = ""
        self._pwd = ""
        self._semesters: list[dict] | None = None
        self._current: dict | None = None
        self._last_timetable_html = ""

    # -- HTTP
    def _wait(self) -> None:
        gap = time.time() - self._last
        if gap < POLITE_DELAY:
            time.sleep(POLITE_DELAY - gap)
        self._last = time.time()

    def _get(self, path: str, **kw) -> requests.Response:
        self._wait()
        try:
            r = self.s.get(BASE + path, timeout=30, **kw)
        except requests.RequestException as exc:
            raise CauError("连不上教务系统：%s" % exc, "net") from exc
        _set_encoding(r)
        return r

    def _post(self, path: str, data: dict | None = None, **kw) -> requests.Response:
        self._wait()
        try:
            r = self.s.post(BASE + path, data=data or {}, timeout=35, **kw)
        except requests.RequestException as exc:
            raise CauError("连不上教务系统：%s" % exc, "net") from exc
        _set_encoding(r)
        return r

    # -- 登录
    @property
    def logged_in(self) -> bool:
        return self._logged_in

    def login(self, username: str, password: str) -> None:
        # 先拿一个会话（JSESSIONID / SERVERID）
        self._get(JSXS + "/xsMain.jsp")
        # 种子在根路径，不在 /jsxsd 下（2026-10-31 实测）
        self._wait()
        try:
            seed_resp = self.s.post(
                BASE + "/Logon.do?method=logon&flag=sess",
                headers={"Referer": BASE + JSXS + "/xsMain.jsp",
                         "X-Requested-With": "XMLHttpRequest"},
                timeout=20)
        except requests.RequestException as exc:
            raise CauError("连不上教务系统：%s" % exc, "net") from exc
        seed = (seed_resp.text or "").strip()
        if "#" not in seed:
            raise CauError("没取到登录加密种子，学校可能改版了", "parse")
        scode, sxh = seed.split("#", 1)
        encoded = encode_password(username, password, scode, sxh)

        self._wait()
        try:
            r = self.s.post(
                BASE + "/Logon.do?method=logon",
                data={
                    "userAccount": username,
                    "userPassword": "",
                    "encoded": encoded,
                    "RANDOMCODE": "",
                },
                headers={"Referer": BASE + JSXS + "/xsMain.jsp"},
                allow_redirects=True,
                timeout=35)
        except requests.RequestException as exc:
            raise CauError("连不上教务系统：%s" % exc, "net") from exc
        text = r.text or ""
        ok = ("xsmain" in r.url.lower() or "framework" in r.url.lower()
              or "xsMain" in r.url)
        if not ok:
            if "验证码" in text or "verifycode" in text.lower():
                raise CauError("系统要求验证码：请先在浏览器登录一次，等几分钟再试", "auth")
            if _looks_login(text):
                raise CauError("学号或密码不对", "auth")
            if "loginForm" not in text and "xsMain.jsp" not in r.url:
                ok = True
        if not ok:
            raise CauError("登录没成功，学校系统可能临时抽风", "net")
        self._logged_in = True
        self._user = username
        self._pwd = password
        self._semesters = None
        self._current = None
        self._last_timetable_html = ""

    def ensure_login(self, username: str, password: str) -> None:
        if not self._logged_in:
            self.login(username, password)

    def session_alive(self) -> bool:
        try:
            r = self._get(JSXS + "/framework/xsMain.jsp")
        except CauError:
            return False
        return not _looks_login(r.text)

    # -- 学期
    def semesters(self, force: bool = False) -> list[dict]:
        if self._semesters and not force:
            return self._semesters
        r = self._get(JSXS + "/xskb/xskb_list.do")
        html = r.text
        if _looks_login(html):
            self._logged_in = False
            raise CauError("登录态过期了，重新登录一次", "expired")
        self._last_timetable_html = html
        opts, current = _semester_options(html)
        if not opts:
            raise CauError("课表页面里没有学期下拉框，学校可能改版了", "parse")
        self._semesters = opts
        self._current = current
        return opts

    def current_semester(self) -> dict:
        if not self._semesters:
            self.semesters()
        return self._current or {"value": "", "label": "", "current": True}

    # -- 课表
    def timetable(self, semester_id: str = "", semester_name: str = "") -> dict:
        if not semester_id:
            # 默认课表页就是当前学期，直接解析缓存
            if not self._last_timetable_html:
                r = self._get(JSXS + "/xskb/xskb_list.do")
                self._last_timetable_html = r.text
            html = self._last_timetable_html
        else:
            r = self._post(JSXS + "/xskb/xskb_list.do",
                           {"xnxq01id": semester_id, "zc": ""})
            html = r.text
        if _looks_login(html):
            self._logged_in = False
            raise CauError("登录态过期了，重新登录一次", "expired")
        out = parse_timetable(html)
        if semester_id and semester_name:
            out["semester"] = semester_name
            out["semesterId"] = semester_id
        # 学期列表顺手更新
        if out.get("semesters"):
            self._semesters = out["semesters"]
            self._current = next(
                (x for x in out["semesters"] if x.get("current")), None) or self._current
        return out

    # -- 成绩
    def grades(self) -> dict:
        r = self._post(JSXS + "/kscj/cjcx_list",
                       {"kksj": "", "kcxz": "", "kcmc": "", "xsfs": "all"})
        html = r.text
        if _looks_login(html):
            self._logged_in = False
            raise CauError("登录态过期了，重新登录一次", "expired")
        return parse_grades(html)

    # -- 考试
    def exams(self, semester_id: str = "") -> dict:
        # 查询表单页用来拿学期下拉；拿不到就用课表页的学期列表
        semesters: list[dict] = []
        try:
            q = self._get(JSXS + "/xsks/xsksap_query")
            semesters, current = _semester_options(q.text)
            if not semester_id and current:
                semester_id = current["value"]
        except CauError:
            pass
        if not semesters:
            semesters = self.semesters()
        if not semester_id:
            current = self.current_semester()
            semester_id = current.get("value", "")

        html = ""
        # 结果页：先 POST，失败再 GET
        try:
            r = self._post(JSXS + "/xsks/xsksap_list",
                           {"xqlbmc": "", "xnxqid": semester_id})
            html = r.text
        except CauError:
            html = ""
        if not html or _looks_login(html):
            try:
                r = self._get(JSXS + "/xsks/xsksap_list",
                              params={"xnxqid": semester_id, "xqlbmc": ""})
                html = r.text
            except CauError:
                html = ""
        if not html:
            return {"exams": [], "published": False, "semesterId": semester_id,
                    "semesters": semesters}
        if _looks_login(html):
            self._logged_in = False
            raise CauError("登录态过期了，重新登录一次", "expired")
        out = parse_exams(html)
        out["semesterId"] = semester_id
        out["semesters"] = semesters or self.semesters()
        return out

    # -- 学籍
    def profile(self) -> dict:
        r = self._get(JSXS + "/framework/xsMain.jsp")
        html = r.text
        if _looks_login(html):
            self._logged_in = False
            raise CauError("登录态过期了，重新登录一次", "expired")
        p = parse_profile(html)
        if not p.get("studentId"):
            # 备用：学籍信息页
            try:
                r2 = self._get(JSXS + "/grxx/xjxx")
                p2 = parse_profile(r2.text)
                for k in ("name", "studentId"):
                    if not p.get(k) and p2.get(k):
                        p[k] = p2[k]
            except CauError:
                pass
        return p

    # -- 整份同步
    def sync(self, username: str, password: str) -> dict:
        self.login(username, password)
        profile = self.profile()
        semesters = self.semesters()
        current = self.current_semester()
        tt = self.timetable(current.get("value", ""), current.get("label", ""))
        grades = self.grades()
        try:
            ex = self.exams(current.get("value", ""))
        except CauError as exc:
            ex = {"exams": [], "published": False,
                  "error": str(exc), "semesters": semesters}
        return {
            "ok": True,
            "syncedAt": int(time.time()),
            "profile": profile,
            "semester": current.get("label", ""),
            "semesterId": current.get("value", ""),
            "semesters": semesters,
            "unitCount": tt["unitCount"],
            "times": tt["times"],
            "totalWeeks": tt["totalWeeks"],
            "courses": tt["courses"],
            "grades": grades,
            "exams": ex,
        }


# ------------------------------------------------------------------ CLI（调试用）

def _main() -> int:
    print("CAU 教务客户端调试（只读）")
    user = input("学号：").strip()
    pwd = getpass.getpass("密码（不回显）：")
    if not user or not pwd:
        print("学号和密码都要填")
        return 2
    cli = CauClient()
    try:
        print("登录中…")
        cli.login(user, pwd)
        print("登录成功")
        print("学期：", [(s["value"], s["label"], s["current"]) for s in cli.semesters()[:3]])
        cur = cli.current_semester()
        tt = cli.timetable(cur["value"], cur["label"])
        print("课表：", tt["semester"], "课程", len(tt["courses"]),
              "大节", tt["unitCount"], "总周", tt["totalWeeks"])
        for c in tt["courses"][:5]:
            print("  ", c["name"], c["teacher"], c["room"], c["weeks"][:3],
                  c["slots"][:2])
        gr = cli.grades()
        print("成绩：", gr["summary"])
        ex = cli.exams(cur["value"])
        print("考试：", len(ex["exams"]), "场；published =", ex["published"])
    except CauError as exc:
        print("失败（%s）：%s" % (exc.kind, exc))
        return 1
    except KeyboardInterrupt:
        print("\n已取消")
        return 130
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    raise SystemExit(_main())
