/**
 * 静态检查：插件进程自己不许碰 UI 自动化。
 *
 * 这条测试守的是一条边界，而不是"禁止前台发送"：
 *   - 界面操作只允许发生在 `scripts/uia-bridge.py` 那个独立进程里；
 *   - 插件进程（`lib/`）必须始终是一个"只会说 HTTP 的客户端"。
 *
 * 为什么这条边界重要：插件跑在 DSH 宿主进程里。如果哪天有人图省事，把窗口操作
 * 直接写进 `lib/`，那么注入失败、UIA 卡住、剪贴板被抢，都会连带宿主一起出问题；
 * 而且它会让"前台发送"这件事失去唯一的显式开关（桥的 `allowForegroundSend`）。
 *
 * 只看 `lib/`：文档、测试、以及 Python 脚本里出现这些词是允许的 —— 那里正是
 * 唯一该出现它们的地方。
 */

import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const LIB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "lib")

/** 被禁止的符号。中文注释里提到"剪贴板"不算，这里只查代码标识符。 */
const FORBIDDEN = [
  "SetForegroundWindow",
  "ShowWindowAsync",
  "SendInput",
  "keybd_event",
  "mouse_event",
  "SendKeys",
  "Clipboard",
  "clipboard",
  "wechatauto",
  "uiautomation",
  "pyautogui",
]

/**
 * 递归收集 lib/ 下的 .js 文件。
 * @param {string} dir - 目录。
 * @returns {string[]} 文件路径。
 */
function collect(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...collect(full))
    else if (name.endsWith(".js")) out.push(full)
  }
  return out
}

test("lib/ 里没有 UI 自动化的痕迹（界面操作只许在 scripts/uia-bridge.py 里）", () => {
  const files = collect(LIB_DIR)
  assert.ok(files.length >= 5, "应该扫到多个源文件")

  const offenders = []
  for (const file of files) {
    const text = readFileSync(file, "utf8")
    for (const symbol of FORBIDDEN) {
      if (text.includes(symbol)) offenders.push(`${file}: ${symbol}`)
    }
  }
  assert.deepEqual(offenders, [], `插件进程里出现了 UI 自动化符号（应留在桥里）：\n${offenders.join("\n")}`)
})

test("lib/ 里没有把进程提到前台的 Win32 调用", () => {
  const files = collect(LIB_DIR)
  const offenders = files.filter((file) => /user32\.dll|kerndll|koffi|ffi-napi|node-ffi/i.test(readFileSync(file, "utf8")))
  assert.deepEqual(offenders, [], `插件进程里出现了原生调用加载器：${offenders.join(", ")}`)
})
