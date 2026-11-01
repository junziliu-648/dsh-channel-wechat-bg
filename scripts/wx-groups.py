#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""列群服务（只读）。

给设置页回答一个问题：**这台微信上，我有哪些群？**

它和 `uia-bridge.py` 是两个进程，刻意分开：

    uia-bridge  收发消息（会占前台、会碰界面）
    wx-groups   只读数据库，看一眼会话表

理由很直白：桥越小越好审，多一条"能列东西"的接口就多一份攻击面；而列群这件事
跟收发链路一点关系都没有。就算它挂了、崩了、被人乱调，也发不出一个字。

协议只有一条：

    GET /groups -> {"ok": true, "groups": [{"id": "12345678901@chatroom", "name": "测试"}]}

用法：
    <venv>\\Scripts\\python.exe scripts/wx-groups.py
    ... --account wxid_example_bot_0000   # 多个微信同时登录时指定
    ... --port 8891 --host 0.0.0.0

三条纪律：
  1. 只读：`WeChatDB` 打开的是数据库快照，不写、不发、不改任何东西。
  2. 只列群：`@chatroom` 结尾的会话才算群；私聊和公众号一律不返回 ——
     设置页管群，私聊白名单归配置。
  3. 出错就明说：拿不到数据库、账号没登录，都回 `ok:false` 加一句人能看懂的话，
     而不是回一个空列表让人以为"我没有群"。
"""

from __future__ import annotations

import argparse
import json
import sys
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEFAULT_PORT = 8891
MAX_SESSIONS = 500  # 会话表通常只有几十条；上限只是防一张异常大的表把接口拖死


def log(message: str) -> None:
    print(f"[wx-groups] {message}", flush=True)


class GroupSource:
    """一个微信账号的"群列表"来源。只读。"""

    def __init__(self, account: str) -> None:
        self.account = str(account or "").strip()
        self.db = None

    def bind(self) -> None:
        from wechatauto import WeChatDB

        self.db = WeChatDB(account=self.account)

    def groups(self) -> list[dict]:
        if self.db is None:
            self.bind()
        sessions = self.db.get_sessions(limit=MAX_SESSIONS) or []
        rows: list[dict] = []
        for session in sessions:
            chat_id = str(session.get("username") or "").strip()
            if not chat_id.endswith("@chatroom"):
                continue
            rows.append({"id": chat_id, "name": self.name_of(chat_id, session)})
        rows.sort(key=lambda row: row["name"])
        return rows

    def name_of(self, chat_id: str, session: dict) -> str:
        """群名。查不到就退回会话摘要里的名字，再退回空串。"""
        try:
            name = str(self.db.group_id_to_name(chat_id) or "").strip()
        except Exception:  # noqa: BLE001 - 查名字失败不该让整个接口失败
            name = ""
        if name:
            return name
        return str(session.get("last_sender") or "").strip()


class Handler(BaseHTTPRequestHandler):
    server_version = "wx-groups/1.0"
    source: GroupSource  # 由 make_server 注入

    def log_message(self, fmt: str, *args) -> None:  # noqa: D102 - 基类接口
        log(fmt % args)

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - 基类命名
        if not self.path.startswith("/groups"):
            self.send_json(404, {"ok": False, "error": "只有 GET /groups"})
            return
        try:
            groups = self.source.groups()
        except Exception as error:  # noqa: BLE001 - 统一变成一句人话
            traceback.print_exc()
            self.send_json(500, {"ok": False, "error": f"读不到会话表：{error}"})
            return
        self.send_json(200, {"ok": True, "groups": groups})


def make_server(host: str, port: int, source: GroupSource) -> ThreadingHTTPServer:
    handler = type("BoundHandler", (Handler,), {"source": source})
    return ThreadingHTTPServer((host, port), handler)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="只读的微信群列表服务")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--account", default="", help="要列哪个号的群；留空由 wechatauto 自己找")
    args = parser.parse_args(argv)

    source = GroupSource(args.account)
    try:
        source.bind()
    except Exception as error:  # noqa: BLE001
        log(f"绑定微信数据库失败：{error}")
        log("先确认微信已登录，且 --account 指向正确的账号目录。")
        return 3

    server = make_server(args.host, args.port, source)
    log(f"listening on {args.host}:{args.port}（只读，账号 {args.account or '自动'}）")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("收到中断，退出")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
