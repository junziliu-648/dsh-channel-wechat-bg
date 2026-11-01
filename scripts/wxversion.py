#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""探测本机微信版本。

两个桥（wcf-bridge / uia-bridge）都要回答"这台机器上装的是哪个微信"，而读注册表
这件事和传输方式无关，所以单独放一个模块，免得两处各抄一份、再慢慢走偏。

探测不到时返回空串。空串在插件那边表示"没声明"，闸门交给别的判据 —— 宁可说
不知道，也不要编一个版本号出来。
"""

from __future__ import annotations

UNINSTALL_KEYS = (
    ("HKEY_LOCAL_MACHINE", r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
    ("HKEY_LOCAL_MACHINE", r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
    ("HKEY_CURRENT_USER", r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
)

DISPLAY_NAMES = {"微信", "wechat", "weixin"}


def detect_wechat_version() -> str:
    """读注册表里的 DisplayVersion，也就是安装版本。"""
    try:
        import winreg
    except ImportError:  # 非 Windows
        return ""

    for root_name, path in UNINSTALL_KEYS:
        if not hasattr(winreg, root_name):
            continue
        try:
            with winreg.OpenKey(getattr(winreg, root_name), path) as uninstall:
                count = winreg.QueryInfoKey(uninstall)[0]
                for index in range(count):
                    try:
                        with winreg.OpenKey(uninstall, winreg.EnumKey(uninstall, index)) as entry:
                            try:
                                display = str(winreg.QueryValueEx(entry, "DisplayName")[0])
                            except OSError:
                                continue
                            if display.strip().lower() not in DISPLAY_NAMES:
                                continue
                            try:
                                version = str(winreg.QueryValueEx(entry, "DisplayVersion")[0])
                            except OSError:
                                continue
                            if version.strip():
                                return version.strip()
                    except OSError:
                        continue
        except OSError:
            continue
    return ""
