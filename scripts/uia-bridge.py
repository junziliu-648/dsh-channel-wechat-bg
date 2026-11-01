#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""前台发送桥（UIA）。

这个桥和 wcf-bridge 说同一套 HTTP/SSE 协议，区别只有一处，但那一处很要紧：

    收消息：读本机数据库（xwechat_files 下的 message db），**后台**，不动窗口。
    发消息：模拟界面操作（把微信窗口拿到前台 → 打开会话 → 剪贴板贴字 → 发送），
            **占前台**，会抢焦点。

为什么不注入 DLL：微信 4.x 没有可用的注入方案（WeChatFerry 只到 3.9.x）。所以这
是"不降级微信"这条路上唯一能发的办法。

协议：
    GET  /health -> {"ok":true,"injected":true,"accountId":"wxid_...","wechatVersion":"4.1.13.12","foreground":true,...}
    PUT  /allow  -> {"chats":[{"id":"...","kind":"dm","mentions":[]}]}  插件启动时把白名单推过来
    GET  /events -> text/event-stream，每条 data 是一个入站消息
    POST /send   -> {"chatId":"...","text":"...","dryRun":false} -> {"ok":true}

三条纪律：
  1. 只发白名单里的会话；别的 chatId 直接拒（插件的白名单是第二道闸，不是第一道）。
  2. 你正在用电脑时不动手：等键盘鼠标空闲 idle-ms 才发；等满 max-wait 还没空就
     **丢掉这一条**，不发。宁可少回一句，也不在你打字时把微信顶到前面。
  3. 发完把前台还给你：取消置顶、还原被最小化的窗口、SetForegroundWindow 回原来那个。

用法：
    <venv>\\Scripts\\python.exe scripts/uia-bridge.py
    ... --account wxid_example_bot_0000   # 多个微信同时登录时指定小号
    ... --idle-ms 4000 --max-wait-ms 120000
    ... --no-idle                            # 不等待空闲（不建议）
"""

from __future__ import annotations

import argparse
import ctypes
import json
import sys
import threading
import time
from collections import deque
from ctypes import wintypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from wxversion import detect_wechat_version

DEFAULT_PORT = 8850
POLL_INTERVAL = 0.8
TEXT_TYPES = {"文本", "text", "Text"}
PROCESS_NAME = "weixin.exe"
WINDOW_TITLE_HINTS = ("微信", "Weixin", "WeChat")

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32


def log(message: str) -> None:
    print(f"[uia-bridge] {message}", flush=True)


class BridgeError(Exception):
    """可以直接回给插件的错误：文案要能让人知道下一步做什么。"""


# --------------------------------------------------------------------- windows


def _window_pid(hwnd: int) -> int:
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return int(pid.value)


def _process_name(pid: int) -> str:
    try:
        import psutil

        return str(psutil.Process(pid).name() or "").lower()
    except Exception:  # noqa: BLE001 - 拿不到名字就当不是微信
        return ""


def find_main_windows() -> list[dict]:
    """所有 weixin.exe 的可见顶层窗口，按面积降序。

    微信 4.x 的主窗类是 ``Qt51514QWindowIcon``，窗口标题就是「微信」；不同小版本
    类名会变，所以只按"进程名 + 标题关键字"筛，不认死类名。
    """
    found: list[dict] = []
    callback_type = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)

    def visit(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        pid = _window_pid(hwnd)
        if not pid or _process_name(pid) != PROCESS_NAME:
            return True
        title = ctypes.create_unicode_buffer(256)
        user32.GetWindowTextW(hwnd, title, 256)
        if not any(hint in title.value for hint in WINDOW_TITLE_HINTS):
            return True
        rect = wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
        width, height = rect.right - rect.left, rect.bottom - rect.top
        found.append(
            {
                "hwnd": int(hwnd),
                "pid": pid,
                "title": title.value.strip(),
                "area": max(0, width) * max(0, height),
                "rect": (rect.left, rect.top, rect.right, rect.bottom),
            }
        )
        return True

    callback = callback_type(visit)
    user32.EnumWindows(callback, 0)
    found.sort(key=lambda item: -item["area"])
    return found


def accounts_in_use() -> dict[int, str]:
    """pid -> 数据目录名（例如 wxid_xxx_03e0）。

    微信 4.x 每个登录的号一个进程、一个数据目录；靠进程打开的文件反推这个 pid
    到底是谁在跑，这是"两个号都登着"时唯一可靠的区分办法。
    """
    mapping: dict[int, str] = {}
    try:
        import psutil
    except Exception:  # noqa: BLE001
        return mapping
    for process in psutil.process_iter(["pid", "name"]):
        if str(process.info.get("name") or "").lower() != PROCESS_NAME:
            continue
        try:
            handles = process.open_files()
        except Exception:  # noqa: BLE001
            continue
        for handle in handles:
            path = str(handle.path or "")
            if "xwechat_files" not in path:
                continue
            rest = path.split("xwechat_files", 1)[1].lstrip("\\/")
            head = rest.split("\\", 1)[0].split("/", 1)[0]
            if head and head != "all_users":
                mapping[int(process.info["pid"])] = head
                break
    return mapping


# ---------------------------------------------------------------- idle / focus


def idle_ms() -> int | None:
    """距离上一次键盘或鼠标输入过去了多少毫秒；拿不到返回 None。"""

    class LastInputInfo(ctypes.Structure):
        _fields_ = [("cbSize", wintypes.UINT), ("dwTime", wintypes.DWORD)]

    info = LastInputInfo()
    info.cbSize = ctypes.sizeof(LastInputInfo)
    if not user32.GetLastInputInfo(ctypes.byref(info)):
        return None
    return (int(kernel32.GetTickCount()) - int(info.dwTime)) & 0xFFFFFFFF


def foreground_hwnd() -> int:
    return int(user32.GetForegroundWindow() or 0)


# -------------------------------------------------------------------- binding


class Bridge:
    """一个微信小号：读库收消息，模拟界面发消息。"""

    def __init__(self, args) -> None:
        self.args = args
        self.account = str(args.account or "").strip()
        self.self_wxid = ""
        self.hwnd = int(args.hwnd or 0)
        self.db = None
        self.gui = None
        self.wx = None
        self.version = detect_wechat_version()

        self.allow: dict[str, dict] = {}
        self.watermarks: dict[str, int] = {}
        self.nicknames: dict[str, str] = {}

        self.queue: deque[dict] = deque(maxlen=500)
        self.condition = threading.Condition()
        self.stopped = False
        self.send_lock = threading.Lock()
        self.last_idle_ms = 0
        self.verify_timeout_s = max(0.0, float(args.verify_ms) / 1000.0)
        self.sent = 0
        self.failed = 0

    # ---- 绑定

    def _resolve_account(self) -> None:
        if self.account:
            return
        running = accounts_in_use()
        names = sorted({name for name in running.values() if name})
        if len(names) == 1:
            self.account = names[0]
            log(f"自动选中唯一在跑的微信：{self.account}")
            return
        if not names:
            raise BridgeError(
                "没找到正在登录的微信账号。先把微信登上去（两个号都在跑时要加 --account）。"
            )
        listed = "、".join(names)
        raise BridgeError(
            f"同时有多个微信在跑（{listed}），必须用 --account 指定要给哪个号发消息。"
            " 这不是能猜的事：猜错就是用错账号说话。"
        )

    def bind(self) -> None:
        """连上数据库和窗口。可以重复调用（微信重启后走这里重绑）。"""
        self._resolve_account()

        from wechatauto import WeChat, WeChatDB, WeChatGUI

        self.db = WeChatDB(account=self.account)
        info = self.db.get_self_info() or {}
        self.self_wxid = str(info.get("username") or "")
        if not self.self_wxid:
            raise BridgeError(f"读不到账号 {self.account} 的自身信息，微信可能还没登录完。")

        running = accounts_in_use()
        pid = next((p for p, name in running.items() if name == self.account), 0)
        if not pid:
            raise BridgeError(
                f"账号 {self.account}（{self.self_wxid}）当前没有在跑的微信进程。"
                " 这个号没登录，或者刚被关掉。"
            )

        windows = [item for item in find_main_windows() if item["pid"] == pid]
        if not windows:
            raise BridgeError(f"找到了 {self.account} 的进程（pid {pid}），但找不到它的主窗口。")
        self.hwnd = int(windows[0]["hwnd"])

        self.gui = WeChatGUI(hwnd=self.hwnd)
        self.wx = WeChat(gui=self.gui, db=self.db)
        log(
            f"绑定成功：账号 {self.self_wxid}（{self.account}），hwnd {self.hwnd}，"
            f"微信 {self.version or '版本未知'}"
        )

    def ensure_bound(self) -> None:
        if self.wx is None or self.gui is None:
            self.bind()
            return
        try:
            alive = bool(self.gui.is_alive())
        except Exception:  # noqa: BLE001
            alive = False
        if not alive:
            log("微信窗口不在了，重新绑定")
            self.wx = None
            self.bind()

    # ---- 白名单

    def set_allow(self, chats: list[dict]) -> None:
        normalized: dict[str, dict] = {}
        for item in chats or []:
            chat_id = str(item.get("id") or "").strip()
            if not chat_id:
                continue
            normalized[chat_id] = {
                "kind": "group" if str(item.get("kind") or "") == "group" else "dm",
                "mentions": [str(m) for m in (item.get("mentions") or []) if str(m)],
            }
        with self.condition:
            previous = self.allow
            self.allow = normalized
            # 已经在名单里的会话沿用原水位线：插件每次重连都会重推一次白名单，
            # 如果每次都重立水位线，断线期间收到的消息就被悄悄跳过了。
            self.watermarks = {
                chat_id: (
                    self.watermarks.get(chat_id, 0)
                    if chat_id in previous and self.watermarks.get(chat_id, 0) > 0
                    else self._latest_seq(chat_id)
                )
                for chat_id in normalized
            }
            self.condition.notify_all()
        log(f"白名单更新为 {len(normalized)} 个会话：{'、'.join(normalized) or '（空，不接收）'}")

    def _latest_seq(self, chat_id: str) -> int:
        """水位线：从此刻算起，不重放历史消息。"""
        try:
            rows = self.db.get_messages(chat_id, limit=1) if self.db else []
        except Exception as error:  # noqa: BLE001
            log(f"读 {chat_id} 的最新消息失败：{error}")
            rows = []
        return max((int(row.get("sort_seq") or 0) for row in rows), default=0)

    # ---- 收消息

    def nickname_of(self, sender: str) -> str:
        if not sender:
            return ""
        if sender in self.nicknames:
            return self.nicknames[sender]
        try:
            name = str(self.db.get_nickname(sender) or "")
        except Exception:  # noqa: BLE001
            name = ""
        self.nicknames[sender] = name
        return name

    def normalize(self, row: dict, chat_id: str, spec: dict) -> dict | None:
        if str(row.get("type") or "") not in TEXT_TYPES:
            return None
        sender = str(row.get("sender_username") or "")
        text = str(row.get("content") or "")
        if not sender or not text.strip():
            return None

        # 群消息在库里长这样：sender_wxid:\n正文。把人名去掉再给模型看。
        if spec["kind"] == "group":
            for separator in (":\n", "："):
                prefix = sender + separator
                if text.startswith(prefix):
                    text = text[len(prefix) :]
                    break
        if not text.strip():
            return None

        mentions = spec.get("mentions") or []
        return {
            "chatId": chat_id,
            "chatKind": spec["kind"],
            "senderId": sender,
            "senderName": self.nickname_of(sender),
            "text": text,
            "timestamp": int(row.get("create_time") or time.time()),
            "messageId": f"{row.get('shard', '')}:{row.get('local_id', '')}",
            "mentionedBot": any(mention in text for mention in mentions),
            "self": sender == self.self_wxid,
        }

    def receive_forever(self) -> None:
        log(f"开始收消息（每 {POLL_INTERVAL}s 读一次数据库，不动窗口）")
        while not self.stopped:
            with self.condition:
                targets = dict(self.allow)
                watermarks = dict(self.watermarks)
            if not targets:
                time.sleep(0.5)
                continue

            for chat_id, spec in targets.items():
                since = watermarks.get(chat_id, 0)
                if since <= 0:
                    # 没有水位线就先把水位线立起来，否则会把历史消息全当成新的。
                    with self.condition:
                        self.watermarks[chat_id] = self._latest_seq(chat_id)
                    continue
                try:
                    rows = self.db.get_new_messages(chat_id, since, limit=200)
                except Exception as error:  # noqa: BLE001
                    log(f"读 {chat_id} 的新消息失败：{error}")
                    if self.db is None:
                        time.sleep(1.0)
                    continue
                for row in rows:
                    seq = int(row.get("sort_seq") or 0)
                    if seq > since:
                        since = seq
                        with self.condition:
                            self.watermarks[chat_id] = seq
                    inbound = self.normalize(row, chat_id, spec)
                    if inbound is None:
                        continue
                    log(
                        "收到 %s 的消息：%s"
                        % (inbound.get("chatKind") or "?", str(inbound.get("text") or "")[:40])
                    )
                    with self.condition:
                        self.queue.append(inbound)
                        self.condition.notify_all()
            time.sleep(POLL_INTERVAL)

    def peek(self, timeout: float) -> list[dict]:
        """取队列快照但不清空：写成功之后才 drop，否则断在写一半会把消息弄丢。"""
        with self.condition:
            if not self.queue:
                self.condition.wait(timeout)
            return list(self.queue)

    def drop(self, count: int) -> None:
        with self.condition:
            for _ in range(min(count, len(self.queue))):
                self.queue.popleft()

    # ---- 发消息

    def display_name(self, chat_id: str) -> str:
        try:
            if chat_id.endswith("@chatroom"):
                return str(self.db.group_id_to_name(chat_id) or "")
            return str(self.db.get_nickname(chat_id) or "")
        except Exception as error:  # noqa: BLE001
            log(f"查 {chat_id} 的显示名失败：{error}")
            return ""

    def wait_idle(self) -> float:
        """等到用户不动了再动手。等不到就抛错，让这一条直接丢掉。"""
        required = int(self.args.idle_ms)
        if required <= 0:
            return 0.0
        started = time.time()
        while not self.stopped:
            current = idle_ms()
            self.last_idle_ms = current or 0
            if current is None or current >= required:
                return time.time() - started
            if (time.time() - started) * 1000 >= int(self.args.max_wait_ms):
                raise BridgeError(
                    f"你一直在操作（等了 {int(self.args.max_wait_ms / 1000)}s 没等到空闲），"
                    "这条不发。等你离开键盘了它再回。"
                )
            time.sleep(0.25)
        raise BridgeError("桥正在停止，这条不发")

    def restore_focus(self, previous: int) -> None:
        """把前台还回去。这是这个传输方式最该做对的一件事。"""
        try:
            if self.gui is not None:
                self.gui.release_foreground()
        except Exception as error:  # noqa: BLE001
            log(f"取消置顶/还原窗口失败：{error}")
        if previous and previous != self.hwnd:
            try:
                user32.SetForegroundWindow(previous)
            except Exception:  # noqa: BLE001
                pass

    def verify_landed(
        self, chat_id: str, spec: dict, text: str, since: int, timeout: float
    ) -> dict | None:
        """自己回读数据库确认这条真的发出去了。

        不用 wechatauto 的 ``_wait_landed``：它要求 ``sender_id == 2``，而微信 4.x
        的库里自己发的行是 ``sender_id="1"``（还是字符串），于是永远判失败——
        实测消息明明已经发出，它照样报「数据库未确认」。这里改用
        ``get_new_messages`` + ``sender_username`` 自己判，判据和收消息完全一致。
        """
        deadline = time.time() + timeout
        while not self.stopped:
            rows: list[dict] = []
            try:
                rows = self.db.get_new_messages(chat_id, since, limit=50) if self.db else []
            except Exception as error:  # noqa: BLE001
                log(f"发送后回读失败：{error}")
            wanted = text.strip()
            for row in rows:
                if int(row.get("sort_seq") or 0) <= since:
                    continue
                if str(row.get("sender_username") or "") != self.self_wxid:
                    continue
                if str(row.get("type") or "") not in TEXT_TYPES:
                    continue
                content = str(row.get("content") or "")
                if spec["kind"] == "group":
                    for separator in (":\n", "："):
                        prefix = self.self_wxid + separator
                        if content.startswith(prefix):
                            content = content[len(prefix) :]
                            break
                if content.strip() == wanted:
                    return row
            if time.time() >= deadline:
                return None
            time.sleep(0.4)
        return None

    def send_file(self, chat_id: str, path: str) -> dict:
        """发图片/文件。走 WeChat.SendFiles：拖拽式发送，不经过剪贴板。"""
        if chat_id not in self.allow:
            raise BridgeError("这个会话不在白名单里，拒绝发送。")
        if not path:
            raise BridgeError("path 不能为空。")

        self.ensure_bound()
        display = self.display_name(chat_id)
        if not display:
            raise BridgeError(f"查不到 {chat_id} 在微信里的名字，没法打开会话。")

        waited = self.wait_idle()
        previous = foreground_hwnd()
        started = time.time()
        try:
            with self.send_lock:
                response = self.wx.SendFiles(path, who=display, exact=True)
        finally:
            self.restore_focus(previous)

        ok = bool(getattr(response, "is_success", False))
        detail = dict(response) if isinstance(response, dict) else {}
        if ok:
            self.sent += 1
        else:
            self.failed += 1
        elapsed = round(time.time() - started, 2)
        if ok:
            log(f"已发送图片到「{display}」（{elapsed}s，含等待空闲 {round(waited, 2)}s）")
            return {"ok": True, "chatId": chat_id, "chat": display, "elapsedSec": elapsed}
        reason = str(detail.get("message") or detail or "界面操作失败，没有返回原因")
        log(f"发图片失败（{elapsed}s）：{reason}")
        return {"ok": False, "error": reason, "elapsedSec": elapsed}

    def send(self, chat_id: str, text: str, dry_run: bool = False) -> dict:
        spec = self.allow.get(chat_id)
        if spec is None:
            raise BridgeError("这个会话不在白名单里，拒绝发送。")

        self.ensure_bound()
        display = self.display_name(chat_id)
        if not display:
            raise BridgeError(f"查不到 {chat_id} 在微信里的名字，没法打开会话。")

        if dry_run:
            return {
                "ok": True,
                "dryRun": True,
                "chatId": chat_id,
                "chat": display,
                "echo": text,
                "hwnd": self.hwnd,
                "idleMs": self.last_idle_ms,
            }

        waited = self.wait_idle()
        mark = self._latest_seq(chat_id)
        previous = foreground_hwnd()
        started = time.time()
        try:
            with self.send_lock:
                response = self.gui.send_msg(text, display, verify=False)
        finally:
            self.restore_focus(previous)

        clicked = bool(getattr(response, "is_success", False))
        # 注意：WxResponse.__bool__ 等于 is_success，所以 `response or {}` 在失败时
        # 会短路成 {}，把真正的失败原因吞掉。这里必须按类型判断。
        detail = dict(response) if isinstance(response, dict) else {}
        landed = None
        if clicked:
            landed = self.verify_landed(chat_id, spec, text, mark, self.verify_timeout_s)

        ok = clicked and landed is not None
        if ok:
            self.sent += 1
            with self.condition:
                self.watermarks[chat_id] = max(
                    self.watermarks.get(chat_id, 0), int(landed.get("sort_seq") or 0)
                )
        else:
            self.failed += 1
        elapsed = round(time.time() - started, 2)
        if ok:
            log(f"已发送到「{display}」（{elapsed}s，含等待空闲 {round(waited, 2)}s）")
        elif clicked:
            reason = (
                f"界面已经点了发送，但 {round(self.verify_timeout_s, 1)}s 内没在数据库里读到这条。"
                "可能还在路上，也可能没发出去——不会重发。"
            )
            log(f"发送结果未确认（{elapsed}s）：{reason}")
        else:
            reason = str(detail.get("message") or detail or "界面操作失败，没有返回原因")
            log(f"发送失败（{elapsed}s，含等待空闲 {round(waited, 2)}s）：{reason}")
        return {
            "ok": ok,
            "messageId": "" if landed is None else f"{landed.get('shard', '')}:{landed.get('local_id', '')}",
            "error": None if ok else reason[:200],
            "chatId": chat_id,
            "chat": display,
            "elapsedSec": elapsed,
            "waitedIdleSec": round(waited, 2),
        }

    # ---- 健康

    def health(self) -> dict:
        alive = False
        try:
            alive = bool(self.gui is not None and self.gui.is_alive())
        except Exception:  # noqa: BLE001
            alive = False
        return {
            "ok": True,
            "injected": alive,
            "foreground": True,
            "accountId": self.self_wxid,
            "account": self.account,
            "wechatVersion": self.version,
            "hwnd": self.hwnd,
            "allow": sorted(self.allow),
            "idleMs": idle_ms(),
            "sent": self.sent,
            "failed": self.failed,
        }


# ----------------------------------------------------------------------- http


class Handler(BaseHTTPRequestHandler):
    bridge: Bridge
    token: str

    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args) -> None:  # noqa: A002 - 基类签名
        """默认实现会往 stderr 打每行请求，太吵。"""

    def authorized(self) -> bool:
        if self.token == "":
            return True
        return self.headers.get("authorization", "") == f"Bearer {self.token}"

    def body(self) -> dict:
        length = int(self.headers.get("content-length", "0") or "0")
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw or b"{}")

    def json(self, value: dict, status: int = 200) -> None:
        payload = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:  # noqa: N802 - 基类命名
        if not self.authorized():
            self.json({"ok": False, "error": "unauthorized"}, 401)
            return
        if self.path.startswith("/health"):
            self.json(self.bridge.health())
            return
        if self.path.startswith("/events"):
            self.stream()
            return
        self.json({"ok": False, "error": "not found"}, 404)

    def do_PUT(self) -> None:  # noqa: N802 - 基类命名
        if not self.authorized():
            self.json({"ok": False, "error": "unauthorized"}, 401)
            return
        if not self.path.startswith("/allow"):
            self.json({"ok": False, "error": "not found"}, 404)
            return
        try:
            payload = self.body()
        except (ValueError, json.JSONDecodeError) as error:
            self.json({"ok": False, "error": f"请求体不是 JSON：{error}"}, 400)
            return
        try:
            self.bridge.set_allow(payload.get("chats") or [])
        except Exception as error:  # noqa: BLE001
            self.json({"ok": False, "error": str(error)[:200]})
            return
        self.json({"ok": True, "allow": sorted(self.bridge.allow)})

    def do_POST(self) -> None:  # noqa: N802 - 基类命名
        if not self.authorized():
            self.json({"ok": False, "error": "unauthorized"}, 401)
            return
        if self.path.startswith("/send-file"):
            try:
                payload = self.body()
            except (ValueError, json.JSONDecodeError) as error:
                self.json({"ok": False, "error": f"请求体不是 JSON：{error}"}, 400)
                return
            chat_id = str(payload.get("chatId") or "").strip()
            path = str(payload.get("path") or "").strip()
            if not chat_id or not path:
                self.json({"ok": False, "error": "chatId 和 path 都必须非空"}, 400)
                return
            try:
                self.json(self.bridge.send_file(chat_id, path))
            except BridgeError as error:
                self.json({"ok": False, "error": str(error)[:200]})
            except Exception as error:  # noqa: BLE001
                self.json({"ok": False, "error": str(error)[:200]})
            return
        if not self.path.startswith("/send"):
            self.json({"ok": False, "error": "not found"}, 404)
            return
        try:
            payload = self.body()
        except (ValueError, json.JSONDecodeError) as error:
            self.json({"ok": False, "error": f"请求体不是 JSON：{error}"}, 400)
            return

        chat_id = str(payload.get("chatId") or "").strip()
        text = str(payload.get("text") or "")
        if not chat_id or not text.strip():
            self.json({"ok": False, "error": "chatId 和 text 都必须非空"}, 400)
            return

        try:
            result = self.bridge.send(chat_id, text, dry_run=bool(payload.get("dryRun")))
        except BridgeError as error:
            self.json({"ok": False, "error": str(error)[:200]})
            return
        except Exception as error:  # noqa: BLE001 - 发送失败要变成 ok:false，不是 500 堆栈
            self.json({"ok": False, "error": str(error)[:200]})
            return
        self.json(result)

    def stream(self) -> None:
        self.send_response(200)
        self.send_header("content-type", "text/event-stream; charset=utf-8")
        self.send_header("cache-control", "no-cache")
        self.send_header("connection", "keep-alive")
        self.end_headers()
        self.wfile.write(b": bridge ready\n\n")
        self.wfile.flush()
        peer = self.client_address[0] if self.client_address else "?"
        log(f"事件流已连接：{peer}（订阅方通常是插件）")
        try:
            while not self.bridge.stopped:
                items = self.bridge.peek(timeout=15.0)
                if not items:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    continue
                for item in items:
                    line = json.dumps(item, ensure_ascii=False)
                    self.wfile.write(f"data: {line}\n\n".encode("utf-8"))
                self.wfile.flush()
                self.bridge.drop(len(items))
        except (BrokenPipeError, ConnectionResetError):
            return
        finally:
            log(f"事件流已断开：{peer}")


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address) -> None:
        """客户端断开（SSE 关页面、Invoke-RestMethod 收完就关）是常态，不该打堆栈。"""
        error = sys.exc_info()[1]
        if isinstance(error, (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


def main() -> int:
    parser = argparse.ArgumentParser(description="前台发送桥（UIA）：读库收消息、界面操作发消息")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址，默认只监听本机")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"监听端口，默认 {DEFAULT_PORT}")
    parser.add_argument("--token", default="", help="Bearer token，留空表示不鉴权（仅限本机）")
    parser.add_argument("--account", default="", help="微信数据目录名；同时登录多个号时必须指定")
    parser.add_argument("--hwnd", type=int, default=0, help="手工指定微信窗口句柄，一般不用")
    parser.add_argument("--idle-ms", type=int, default=2500, help="要等键盘鼠标空闲多久才动手，默认 2500")
    parser.add_argument("--max-wait-ms", type=int, default=90000, help="最多等多久空闲，等满就丢掉这条")
    parser.add_argument(
        "--verify-ms",
        type=int,
        default=10000,
        help="点完发送后回读数据库等多久，默认 10000；等不到就如实报「未确认」",
    )
    parser.add_argument("--no-idle", action="store_true", help="不等待空闲，立即抢前台（不建议）")
    args = parser.parse_args()
    if args.no_idle:
        args.idle_ms = 0

    try:
        from wechatauto import WeChat  # noqa: F401  —— 只是确认依赖在
    except ImportError:
        log("没有装 wechatauto。先执行：pip install wechatauto-replica")
        return 2

    bridge = Bridge(args)
    try:
        bridge.bind()
    except BridgeError as error:
        log(f"启动失败：{error}")
        return 3

    if args.idle_ms <= 0:
        log("⚠️  已关闭空闲等待：接下来会直接抢前台，你打字时也会被抢。")
    else:
        log(f"抢前台前会等键盘鼠标空闲 {args.idle_ms}ms，等满 {args.max_wait_ms}ms 就丢掉这条。")

    receiver = threading.Thread(target=bridge.receive_forever, name="uia-receiver", daemon=True)
    receiver.start()

    Handler.bridge = bridge
    Handler.token = args.token

    server = Server((args.host, args.port), Handler)
    log(f"监听 http://{args.host}:{args.port}（token：{'有' if args.token else '无'}）")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("收到 Ctrl-C，退出")
    finally:
        bridge.stopped = True
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
