/**
 * 端到端自检：真传输（uia 桥）+ 真白名单 + 真限流，只把模型换成一个固定回复。
 *
 * 目的不是"测试"（那由 test/ 负责），而是确认这条链路在这台机器上真的通：
 * 插件 → 桥 → 微信窗口 → 数据库回读。
 *
 * 用法：
 *   node scripts/e2e-uia.mjs --chat 12345678901@chatroom --text "…"
 *   node scripts/e2e-uia.mjs --chat 12345678901@chatroom --dry-run
 */

import { createAudit } from "../lib/audit.js"
import { createPipeline } from "../lib/pipeline.js"
import { createPolicy } from "../lib/policy.js"
import { PersonaStore } from "../lib/personas.js"
import { createTransport } from "../lib/transport/index.js"

function parseArgs(argv) {
  const out = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    if (typeof key !== "string" || !key.startsWith("--")) continue
    out[key.slice(2)] = argv[index + 1] ?? ""
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const chatId = args.chat ?? "12345678901@chatroom"
const text = args.text ?? "自检：前台发送链路。收到请忽略。"
const baseUrl = args["base-url"] ?? "http://127.0.0.1:8850"
const dryRun = process.argv.includes("--dry-run")

const allow = [
  { id: "wxid_example_dm", kind: "dm", label: "小明", persona: "大肥鱼", reply: "always", triggers: [] },
  {
    id: "12345678901@chatroom",
    kind: "group",
    label: "测试",
    persona: "工作助理",
    reply: "mention",
    triggers: ["@大肥鱼"],
  },
]

const policy = createPolicy({ allow, denyUnknown: true })
const transport = createTransport(
  { kind: "uia", baseUrl },
  { allow: allow.map((entry) => ({ id: entry.id, kind: entry.kind, triggers: entry.triggers })), log: (m) => console.error(m) },
)
const personas = new PersonaStore({ dir: "", warn: (m) => console.error(m) })
const audit = createAudit({ path: args["audit"] ?? "" })

const pipeline = createPipeline({
  config: {
    enabled: true,
    allow,
    denyUnknown: true,
    allowForegroundSend: true,
    botName: "大肥鱼",
    audit: { path: args["audit"] ?? "", logContent: false },
    rateLimit: { perChatSec: 6, maxPerMinute: 6, debounceMs: 1200, maxReplyChars: 300 },
  },
  transport,
  personas,
  logger: { info: console.error, warn: console.error, error: console.error },
  generate: async () => text,
})

try {
  await pipeline.start()
  console.error(`传输已启动：${JSON.stringify(transport.capabilities)}`)

  if (dryRun) {
    console.error("dry-run：只推到 /send 的 dryRun 分支，不会真的发。")
    const probe = await fetch(new URL("/send", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ chatId, text, dryRun: true }),
    })
    console.log(JSON.stringify(await probe.json()))
  } else {
    const result = await pipeline.send(chatId, text)
    console.log(JSON.stringify(result))
  }

  console.log(JSON.stringify(pipeline.status()))
} finally {
  await pipeline.stop()
}
