# -*- coding: utf-8 -*-
"""老农民校园通 · 本地服务

网页版：电脑跑这个服务，手机浏览器打开局域网地址。
它替浏览器登录 newjw.cau.edu.cn，把课表/成绩/考试/公告转成同源 JSON。

凭据：Windows DPAPI 加密后存 %LOCALAPPDATA%\\CAUCampus\\account.bin
     只有当前 Windows 账户能解开；密码不上传、不经过第三方。

访问控制：所有 POST 接口在入口校验 token；GET 里只有 /api/health 和
/api/notice 公开，其余（课表/成绩/考试/学期/state）都要 token。
只读 GET 也一律要求 token，不留无鉴权的数据接口。
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import re
import secrets
import socket
import sys
import threading
import time
import urllib.request
import webbrowser
from ctypes import wintypes
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
WEB_DIR = HERE / "web"
DATA_DIR = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "CAUCampus"
ACCOUNT_FILE = DATA_DIR / "account.bin"
TOKEN_FILE = DATA_DIR / "token.txt"

sys.path.insert(0, str(HERE))
import jw_client  # noqa: E402
import notice_campus  # noqa: E402


# ------------------------------------------------------------------ DPAPI

class _BLOB(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _blob(data: bytes):
    buf = ctypes.create_string_buffer(data, len(data))
    return _BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char))), buf


def _dpapi(data: bytes, protect: bool) -> bytes:
    if os.name != "nt":
        raise OSError("DPAPI 只在 Windows 上可用")
    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    inb, _keep = _blob(data)
    outb = _BLOB()
    fn = crypt32.CryptProtectData if protect else crypt32.CryptUnprotectData
    ok = fn(ctypes.byref(inb), "CAUCampus", None, None, None, 0, ctypes.byref(outb))
    if not ok:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return ctypes.string_at(outb.pbData, outb.cbData)
    finally:
        kernel32.LocalFree(outb.pbData)


def save_account(username: str, password: str) -> bool:
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        raw = json.dumps({"u": username, "p": password}).encode("utf-8")
        ACCOUNT_FILE.write_bytes(_dpapi(raw, True))
        return True
    except Exception:  # noqa: BLE001
        return False


def load_account() -> tuple[str, str] | None:
    try:
        raw = _dpapi(ACCOUNT_FILE.read_bytes(), False)
        d = json.loads(raw.decode("utf-8"))
        u, p = str(d.get("u") or ""), str(d.get("p") or "")
        return (u, p) if u and p else None
    except Exception:  # noqa: BLE001
        return None


def clear_account() -> None:
    try:
        ACCOUNT_FILE.unlink(missing_ok=True)
    except Exception:  # noqa: BLE001
        pass


def load_token() -> str:
    try:
        t = TOKEN_FILE.read_text(encoding="utf-8").strip()
        if t:
            return t
    except FileNotFoundError:
        pass
    t = secrets.token_urlsafe(9)
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        TOKEN_FILE.write_text(t, encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    return t


# ------------------------------------------------------------------ 同步

class Service:
    """串行化对教务系统的访问。

    🔴 强智是会话独占的：App 登录可能把浏览器挤下线。这里只维持一个
    CauClient，所有课表/成绩/考试都复用它，不并发登录。
    """

    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.client: jw_client.CauClient | None = None

    def _ensure(self, username: str, password: str) -> jw_client.CauClient:
        if self.client is None or not self.client.logged_in:
            self.client = jw_client.CauClient()
            self.client.login(username, password)
        return self.client

    def _run(self, username: str, password: str, fn):
        """跑一次只读请求；会话过期就换一个干净会话重试一次。"""
        with self.lock:
            for attempt in (0, 1):
                try:
                    cli = self._ensure(username, password)
                    return fn(cli)
                except jw_client.CauError as exc:
                    if attempt == 0 and exc.kind == "expired":
                        self.client = None
                        continue
                    raise

    def sync(self, username: str, password: str) -> dict:
        with self.lock:
            for attempt in (0, 1):
                try:
                    cli = jw_client.CauClient()
                    self.client = cli
                    return cli.sync(username, password)
                except jw_client.CauError as exc:
                    if attempt == 0 and exc.kind == "expired":
                        self.client = None
                        continue
                    raise
        raise AssertionError("unreachable")

    def semesters_for(self, username: str, password: str) -> list[dict]:
        return self._run(username, password, lambda c: c.semesters(force=True))

    def timetable_for(self, username: str, password: str,
                      semester_id: str, semester_name: str = "") -> dict:
        return self._run(
            username, password,
            lambda c: c.timetable(semester_id, semester_name))

    def exams_for(self, username: str, password: str, semester_id: str) -> dict:
        return self._run(username, password, lambda c: c.exams(semester_id))

    def grades_for(self, username: str, password: str) -> dict:
        return self._run(username, password, lambda c: c.grades())


SERVICE = Service()


def _err(exc: Exception) -> dict:
    out = {"ok": False, "error": str(exc)}
    if isinstance(exc, jw_client.CauError):
        out["kind"] = exc.kind
        if exc.kind == "auth":
            out["authFail"] = True
    return out


# ------------------------------------------------------------------ HTTP

class Handler(SimpleHTTPRequestHandler):
    server_version = "CAUCampus/0.1"
    token = ""

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(WEB_DIR), **kw)

    def _json(self, obj, code: int = 200) -> None:
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            # 用户切页/关页时浏览器会主动断开，不用在日志里打一整段栈
            pass

    def _body(self) -> dict:
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if not n:
                return {}
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:  # noqa: BLE001
            return {}

    def _authed(self) -> bool:
        hdr = self.headers.get("X-Token") or ""
        if hdr and secrets.compare_digest(hdr, self.token):
            return True
        q = parse_qs(urlparse(self.path).query)
        got = (q.get("k", [""])[0] or "")
        return bool(got) and secrets.compare_digest(got, self.token)

    def _need_auth(self) -> bool:
        if not self._authed():
            self._json({"ok": False, "error": "token"}, 403)
            return True
        return False

    def log_message(self, fmt, *args):  # 别刷屏
        try:
            first = str(args[0]) if args else ""
            if "/api/" in first:
                return
            line = fmt % args
            # 别把访问口令写进日志
            line = re.sub(r"([?&]k=)[^&\s\"]+", r"\1***", line)
            sys.stderr.write("  %s\n" % line)
        except Exception:  # noqa: BLE001
            pass

    # -- 路由
    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/health":
            self._json({"ok": True, "version": "0.1"})
            return
        if path == "/api/state":
            if self._need_auth():
                return
            acc = load_account()
            self._json({
                "ok": True,
                "bound": acc is not None,
                "username": acc[0] if acc else "",
                "credState": "ok" if acc else "none",
            })
            return
        if path == "/api/semesters":
            if self._need_auth():
                return
            acc = load_account()
            if not acc:
                self._json({"ok": False, "error": "还没绑定账号", "needBind": True})
                return
            try:
                sems = SERVICE.semesters_for(acc[0], acc[1])
                self._json({"ok": True, "semesters": sems})
            except Exception as exc:  # noqa: BLE001
                self._json(_err(exc))
            return
        if path == "/api/timetable":
            if self._need_auth():
                return
            acc = load_account()
            if not acc:
                self._json({"ok": False, "error": "还没绑定账号", "needBind": True})
                return
            q = parse_qs(urlparse(self.path).query)
            sid = (q.get("semester", [""])[0] or "").strip()
            name = (q.get("name", [""])[0] or "").strip()
            try:
                out = SERVICE.timetable_for(acc[0], acc[1], sid, name)
                out["ok"] = True
                self._json(out)
            except Exception as exc:  # noqa: BLE001
                self._json(_err(exc))
            return
        if path == "/api/exams":
            if self._need_auth():
                return
            acc = load_account()
            if not acc:
                self._json({"ok": False, "error": "还没绑定账号", "needBind": True})
                return
            q = parse_qs(urlparse(self.path).query)
            sid = (q.get("semester", [""])[0] or "").strip()
            try:
                out = SERVICE.exams_for(acc[0], acc[1], sid)
                out["ok"] = True
                self._json(out)
            except Exception as exc:  # noqa: BLE001
                self._json(_err(exc))
            return
        if path == "/api/grades":
            if self._need_auth():
                return
            acc = load_account()
            if not acc:
                self._json({"ok": False, "error": "还没绑定账号", "needBind": True})
                return
            try:
                out = SERVICE.grades_for(acc[0], acc[1])
                out["ok"] = True
                self._json(out)
            except Exception as exc:  # noqa: BLE001
                self._json(_err(exc))
            return
        if path == "/api/notice":
            # 公告是公开页面，不校验 token；这是唯一不需要绑定的栏目
            q = parse_qs(urlparse(self.path).query)
            try:
                limit = max(1, min(80, int((q.get("limit", ["40"])[0] or 40))))
            except ValueError:
                limit = 40
            force = (q.get("force", ["0"])[0] or "0") == "1"
            # all=1 = 不过滤招聘/招租（界面上那个「显示全部」）
            show_all = (q.get("all", ["0"])[0] or "0") == "1"
            self._json(notice_campus.fetch_list(limit=limit, force=force,
                                             show_all=show_all))
            return
        if path in ("/", "/index.html"):
            self.path = "/index.html"
        elif path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return
        elif path.startswith("/api/"):
            self._json({"ok": False, "error": "not found"}, 404)
            return
        super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        # POST 全部在入口校验，避免以后新增接口忘了加
        if not self._authed():
            self._json({"ok": False, "error": "token"}, 403)
            return
        data = self._body()

        if path == "/api/login":
            user = (data.get("username") or "").strip()
            pwd = data.get("password") or ""
            if not user or not pwd:
                self._json({"ok": False, "error": "请填学号和密码"})
                return
            try:
                payload = SERVICE.sync(user, pwd)
            except Exception as exc:  # noqa: BLE001
                self._json(_err(exc))
                return
            if data.get("remember", True):
                payload["saved"] = "" if save_account(user, pwd) else \
                    "fail: 凭据文件写不进去（检查数据目录权限）"
            self._json(payload)
            return

        if path == "/api/sync":
            acc = load_account()
            if not acc:
                self._json({"ok": False, "error": "还没绑定账号", "needBind": True})
                return
            try:
                payload = SERVICE.sync(acc[0], acc[1])
            except Exception as exc:  # noqa: BLE001
                out = _err(exc)
                if isinstance(exc, jw_client.CauError) and exc.kind == "auth":
                    out["authFail"] = True
                self._json(out)
                return
            self._json(payload)
            return

        if path == "/api/unbind":
            clear_account()
            SERVICE.client = None
            self._json({"ok": True})
            return

        self._json({"ok": False, "error": "not found"}, 404)


# ------------------------------------------------------------------ 启动

def lan_ips() -> list[str]:
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("223.5.5.5", 80))
        ips.add(s.getsockname()[0])
        s.close()
    except Exception:  # noqa: BLE001
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127."):
                ips.add(ip)
    except Exception:  # noqa: BLE001
        pass
    return sorted(ips)


def main() -> int:
    ap = argparse.ArgumentParser(description="老农民校园通 · 本地服务")
    ap.add_argument("--port", type=int, default=8790)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    if not WEB_DIR.is_dir():
        print("找不到 web/ 目录，脚本可能被挪动了")
        return 2

    token = load_token()
    Handler.token = token
    local = "http://127.0.0.1:%d/?k=%s" % (args.port, token)
    # 已经有一个在跑（比如用户重复双击 启动.bat）就直接打开它，别再起第二个
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/api/health" % args.port,
                                    timeout=2) as r:
            h = json.loads(r.read().decode("utf-8"))
        if h.get("ok") and h.get("version") == "0.1":
            print("已有 老农民校园通在运行：%s" % local)
            if not args.no_browser:
                webbrowser.open(local)
            return 0
    except Exception:  # noqa: BLE001
        pass
    try:
        srv = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    except OSError as exc:
        print("端口 %d 起不来：%s" % (args.port, exc))
        print("换一个端口：python bridge.py --port 8791")
        return 3

    ips = lan_ips() or ["127.0.0.1"]
    print()
    print("  老农民校园通 · 本地服务已启动")
    print("  " + "-" * 50)
    print("  电脑上打开：  %s" % local)
    for ip in ips:
        print("  手机上打开：  http://%s:%d/?k=%s" % (ip, args.port, token))
    print("  " + "-" * 50)
    print("  手机要和这台电脑连同一个 Wi-Fi。")
    print("  数据目录：%s" % DATA_DIR)
    print("  按 Ctrl+C 停止。")
    print()
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(local)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    raise SystemExit(main())
