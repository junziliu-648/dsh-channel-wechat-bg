/**
 * 用真实的传输发一条消息，然后立刻退出。
 *
 * 这个脚本只做一件事，因为它的用途只有一个：给 `verify-background-send.ps1`
 * 在"发送"前后各取一次前台窗口句柄。所以它必须自己起传输、自己发、自己停，
 * 不碰 DSH、不建会话、不等回复 —— 任何多余的动作都会让"窗口有没有被抢走"
 * 这个结论变得不清楚。
 *
 * 用法（后台传输，用来验证"不抢焦点"）：
 *   node scripts/send-once.mjs --kind wechatferry --chat wxid_example_dm \
 *     --text "自检：这条不该抢焦点"
 *
 * 用法（uia 前台传输，它会抢焦点，这是预期行为）：
 *   node scripts/send-once.mjs --kind uia --party group --chat 12345678901@chatroom \
 *     --text "自检：前台发送" --allow-foreground
 *
 * `--kind uia` 时必须同时给 `--allow-foreground`：不给就拒绝启动，
 * 跟插件里的规矩一致 —— 抢前台这件事不能被一个默认值悄悄打开。
 *
 * 退出码：0 发送成功；1 参数/传输错误；2 发送被拒。
 */

import { createTransport } from "../lib/transport/index.js"

/**
 * 解析 `--key value` 形式的参数。
 * @param {string[]} argv - `process.argv.slice(2)`。
 * @returns {Record<string, string>} 参数表。
 */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    if (typeof key !== "string" || !key.startsWith("--")) continue
    out[key.slice(2)] = argv[index + 1] ?? ""
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const kind = args.kind ?? "wechatferry"
const baseUrl = args["base-url"] ?? ""
const token = args.token ?? ""
const chatId = args.chat ?? ""
const party = args.party === "group" ? "group" : "dm"
const text = args.text ?? "自检：这条消息不应该抢走焦点。"
const allowForeground = process.argv.includes("--allow-foreground")

if (chatId === "") {
  console.error(
    "用法：node scripts/send-once.mjs --kind <uia|wechatferry|pad> --chat <chatId> [--base-url <url>] [--token <t>] [--text <t>] [--party dm|group] [--allow-foreground]",
  )
  process.exit(1)
}

if (kind === "uia" && !allowForeground) {
  console.error("uia 传输会抢前台：确认要给的话再加 --allow-foreground。")
  process.exit(1)
}

if (kind === "pad" && baseUrl === "") {
  console.error("pad 传输需要 --base-url。")
  process.exit(1)
}

const allow = [{ id: chatId, kind: party, triggers: [] }]
const transport = createTransport(
  { kind, baseUrl, token, uia: { baseUrl, token }, pad: { baseUrl, token }, wechatferry: { baseUrl, token } },
  { allow, log: (message) => console.error(message) },
)

try {
  if (allowForeground) {
    // 这条只是给脚本自己看的提醒：插件里由 allowForegroundSend 控制，这里由参数控制。
    console.error("注意：uia 模式会占用前台窗口。")
  }
  await transport.start()
  const result = await transport.sendText(chatId, text)
  await transport.stop()
  console.log(JSON.stringify(result))
  process.exit(result?.ok === true ? 0 : 2)
} catch (error) {
  console.error(String(error?.message ?? error))
  process.exit(1)
}
