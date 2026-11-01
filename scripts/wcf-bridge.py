#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""WeChatFerry 本地桥。

把 WeChatFerry（DLL 注入微信进程的那套）包装成插件认得的 HTTP/SSE 协议：

    GET  /health  -> {"ok":true,"injected":true,"accountId":"wxid_...","wechatVersion":"3.9.11.25"}
    GET  /events  -> text/event-stream，每条 data 是一个入站消息
    POST /send    -> {"chatId":"...","text":"..."} -> {"ok":true}

为什么要有这个桥，而不是让插件直接调 wcferry：插件是纯 ESM、零依赖的，而注入
只能由 Python/C++ 侧做；更要紧的是，注入失败会连带宿主进程一起死，所以它必须待在
另一个进程里。桥挂了，插件只是"探活失败"。

前置条件（详见 TRANSPORT.md）：
  * 微信必须是 **3.9.x**（WeChatFerry 依赖固定偏移，4.x 注入不了）。
  * `pip install wcferry`，版本与微信版本配套。
  * 用一个专用小号，接受封号风险。

用法：
    python scripts/wcf-bridge.py --port 8849
    python scripts/wcf-bridge.py --port 8849 --token 随便一个口令
    python scripts/wcf-bridge.py --wechat-version 3.9.11.25

然后插件配置 transport.kind=wechatferry、transport.baseUrl=http://127.0.0.1:8849。
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from wxversion import detect_wechat_version as _detect_wechat_version

VERSION_PREFIX = "3.9."


def log(message: str) -> None:
    """带时间戳的日志。stdout 直接刷出来，方便在终端里盯。"""
    print(f"[wcf-bridge] {message}", flush=True)


def detect_wechat_version() -> str:
    """尽力探测本机微信版本（实现在 wxversion.py，与 uia-bridge 共用一份）。"""
    return _detect_wechat_version()


def normalize(wcf, message, self_wxid: str, contacts: dict) -> dict | None:
    """把 WxMsg 变成插件认得的入站消息。

    只放行文本（type 1）：插件只处理文本，图片/语音在这里丢掉比在下游丢掉更省事。
    """
    try:
        if int(getattr(message, "type", 0)) != 1:
            return None
        if bool(getattr(message, "from_self", lambda: False)()):
            return None

        sender = str(getattr(message, "sender", "") or "")
        roomid = str(getattr(message, "roomid", "") or "")
        text = str(getattr(message, "content", "") or "")
        chat_id = roomid if roomid else sender
        if not chat_id or not text.strip():
            return None

        sender_name = ""
        if sender:
            if sender not in contacts:
                try:
                    for contact in wcf.get_contacts():
                        contacts[str(contact.wxid)] = str(getattr(contact, "remark", "") or getattr(contact, "name", "") or "")
                except Exception:  # noqa: BLE001 - 联系人表只是锦上添花，拿不到就算了
                    pass
            sender_name = contacts.get(sender, "")

        is_group = bool(roomid)
        mentioned = False
        if is_group:
            try:
                mentioned = bool(message.is_at(self_wxid))
            except Exception:  # noqa: BLE001 - 老版本没有 is_at
                body = text
                at = f"@{sender_name}" if sender_name else ""
                mentioned = (self_wxid in body) or (at != "" and body.startswith(at))

        return {
            "chatId": chat_id,
            "chatKind": "group" if is_group else "dm",
            "senderId": sender,
            "senderName": sender_name,
            "text": text,
            "timestamp": int(getattr(message, "ts", 0) or time.time()),
            "messageId": str(getattr(message, "id", "") or ""),
            "mentionedBot": mentioned,
        }
    except Exception as error:  # noqa: BLE001 - 单条消息出问题不该拖垮接收线程
        log(f"归一化失败，跳过一条消息：{error}")
        return None


class Bridge:
    """注入句柄 + 收消息的队列。轮询和 HTTP 是两件事，用队列解耦。"""

    def __init__(self, wcf, self_wxid: str, version: str, dll_path: str) -> None:
        self.wcf = wcf
        self.self_wxid = self_wxid
        self.version = version
        self.dll_path = dll_path
        self.contacts: dict[str, str] = {}
        self.queue: deque[dict] = deque(maxlen=500)
        self.condition = threading.Condition()
        self.stopped = False

    def receive_forever(self) -> None:
        """一直轮询 wcferry。它没有推送接口，只有 get_msg()。"""
        log("开始收消息（轮询 wcferry.get_msg）")
        while not self.stopped:
            try:
                message = self.wcf.get_msg()
            except Exception as error:  # noqa: BLE001
                log(f"取消息失败：{error}")
                time.sleep(1.0)
                continue
            if message is None:
                time.sleep(0.2)
                continue
            inbound = normalize(self.wcf, message, self.self_wxid, self.contacts)
            if inbound is None:
                continue
            with self.condition:
                self.queue.append(inbound)
                self.condition.notify_all()

    def take(self, timeout: float) -> list[dict]:
        """取走队列里现有的消息；没有就等一会儿。"""
        with self.condition:
            if not self.queue:
                self.condition.wait(timeout)
            items = list(self.queue)
            self.queue.clear()
        return items


class Handler(BaseHTTPRequestHandler):
    bridge: Bridge
    token: str

    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args) -> None:  # noqa: A002 - 基类签名
        """默认实现会往 stderr 打每一行请求，太吵。"""

    def authorized(self) -> bool:
        if self.token == "":
            return True
        return self.headers.get("authorization", "") == f"Bearer {self.token}"

    def json(self, value: dict, status: int = 200) -> None:
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - 基类命名
        if not self.authorized():
            self.json({"ok": False, "error": "unauthorized"}, 401)
            return
        if self.path.startswith("/health"):
            self.json(
                {
                    "ok": True,
                    "injected": True,
                    "accountId": self.bridge.self_wxid,
                    "wechatVersion": self.bridge.version,
                    "dllPath": self.bridge.dll_path,
                }
            )
            return
        if self.path.startswith("/events"):
            self.stream()
            return
        self.json({"ok": False, "error": "not found"}, 404)

    def stream(self) -> None:
        self.send_response(200)
        self.send_header("content-type", "text/event-stream; charset=utf-8")
        self.send_header("cache-control", "no-cache")
        self.send_header("connection", "keep-alive")
        self.end_headers()
        self.wfile.write(b": bridge ready\n\n")
        self.wfile.flush()
        try:
            while not self.bridge.stopped:
                for item in self.bridge.take(timeout=15.0):
                    payload = json.dumps(item, ensure_ascii=False)
                    self.wfile.write(f"data: {payload}\n\n".encode("utf-8"))
                    self.wfile.flush()
                else:
                    # 心跳：让中间层别把长连接当成死连接。
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            return

    def do_POST(self) -> None:  # noqa: N802 - 基类命名
        if not self.authorized():
            self.json({"ok": False, "error": "unauthorized"}, 401)
            return
        if not self.path.startswith("/send"):
            self.json({"ok": False, "error": "not found"}, 404)
            return
        try:
            length = int(self.headers.get("content-length", "0") or "0")
            body = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError) as error:
            self.json({"ok": False, "error": f"请求体不是 JSON：{error}"}, 400)
            return

        chat_id = str(body.get("chatId") or "").strip()
        text = str(body.get("text") or "")
        if not chat_id or not text.strip():
            self.json({"ok": False, "error": "chatId 和 text 都必须非空"}, 400)
            return

        try:
            result = self.bridge.wcf.send_text(text, chat_id)
        except Exception as error:  # noqa: BLE001 - 发送失败要变成 ok:false，不是 500 堆栈
            self.json({"ok": False, "error": str(error)[:200]})
            return
        self.json({"ok": True, "messageId": str(result or "")})


def main() -> int:
    parser = argparse.ArgumentParser(description="WeChatFerry 本地桥")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址，默认只监听本机")
    parser.add_argument("--port", type=int, default=8849, help="监听端口，默认 8849")
    parser.add_argument("--token", default="", help="Bearer token，留空表示不鉴权（仅限本机）")
    parser.add_argument("--dll", default="", help="sdk.dll 路径，交给 wcferry 自己找时留空")
    parser.add_argument("--wechat-version", default="", help="覆盖微信版本探测结果")
    args = parser.parse_args()

    version = args.wechat_version.strip() or detect_wechat_version()
    if version and not version.startswith(VERSION_PREFIX):
        log(f"本机微信是 {version}，WeChatFerry 只能注入 {VERSION_PREFIX}x。先降级再启动。")
        log("降级步骤见 TRANSPORT.md。桥仍然会起来，但插件会拒绝启动（这是设计）。")
    elif version:
        log(f"微信版本 {version}，在支持范围内。")
    else:
        log("没探测到微信版本，闸门交给插件配置里的 transport.wechatferry.wechatVersion。")

    try:
        from wcferry import Wcf
    except ImportError:
        log("没有装 wcferry。先执行：pip install wcferry（需要与微信 3.9.x 配套的版本）")
        return 2

    import os

    if args.dll:
        os.environ.setdefault("WCF_PATH", args.dll)

    try:
        wcf = Wcf()
    except Exception as error:  # noqa: BLE001 - 注入失败必须说清楚，而不是抛栈
        log(f"Wcf() 初始化失败：{error}")
        log("常见原因：微信没启动、微信不是 3.9.x、或 sdk.dll 路径不对。")
        return 3

    try:
        self_wxid = str(wcf.get_self_wxid() or "")
    except Exception as error:  # noqa: BLE001
        log(f"拿自己的 wxid 失败：{error}（微信可能还没登录）")
        return 4

    log(f"已注入，自己的账号：{self_wxid}")

    bridge = Bridge(wcf, self_wxid, version, args.dll)
    receiver = threading.Thread(target=bridge.receive_forever, name="wcf-receiver", daemon=True)
    receiver.start()

    Handler.bridge = bridge
    Handler.token = args.token

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
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
