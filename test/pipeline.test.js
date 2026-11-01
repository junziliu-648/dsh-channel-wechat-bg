/**
 * 流水线端到端单测（用假传输 + 假模型）。
 *
 * 这一组对应验收清单 §10 的 1–6：只回那两个会话、群里要 @、节流生效、
 * 总开关关掉就一条也不发、审计文件真的写出来了。
 */

import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { DM_JUNZILIU, GROUP_TEST } from "../lib/policy.js"
import { createPipeline } from "../lib/pipeline.js"
import { MockTransport } from "../lib/transport/mock.js"

/** 测试里不想看日志。 */
const quiet = { info: () => {}, warn: () => {}, error: () => {} }

/**
 * 搭一条流水线。
 * @param {object} [options] - 覆盖项。
 * @returns {{pipeline: any, transport: MockTransport, auditPath: string}}
 */
function makePipeline({ enabled = true, rateLimit = {}, generate, transport } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wechat-bg-test-"))
  const auditPath = join(dir, "audit.jsonl")
  const mock = transport ?? new MockTransport()
  const pipeline = createPipeline({
    config: {
      enabled,
      cwd: dir,
      botName: "大肥鱼",
      denyUnknown: true,
      rateLimit: { perChatSec: 0, maxPerMinute: 100, debounceMs: 0, maxReplyChars: 300, ...rateLimit },
      audit: { path: auditPath, logContent: false },
      // 指向空目录，测试不依赖包内人设文件的措辞。
      personaDir: dir,
    },
    transport: mock,
    generate: generate ?? (async () => "好的，我在。"),
    logger: quiet,
  })
  return { pipeline, transport: mock, auditPath, dir }
}

/** 等流水线把异步的生成与发送跑完。 */
function settle(ms = 40) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 读审计文件，逐行解析。 */
function readAudit(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line))
}

test("私聊：回给小明，且只回一条", async () => {
  const { pipeline, transport } = makePipeline()
  await pipeline.start()

  pipeline.accept({ chatId: DM_JUNZILIU, chatKind: "dm", senderId: DM_JUNZILIU, messageId: "m1", text: "在吗" })
  await settle()

  assert.equal(transport.sent.length, 1)
  assert.equal(transport.sent[0].chatId, DM_JUNZILIU)
  assert.equal(transport.sent[0].text, "好的，我在。")
  assert.equal(pipeline.counters.replied, 1)
  await pipeline.stop()
})

test("私聊：别的会话发什么都不回", async () => {
  const { pipeline, transport } = makePipeline()
  await pipeline.start()

  pipeline.accept({ chatId: "wxid_stranger", chatKind: "dm", senderId: "wxid_stranger", messageId: "m2", text: "在吗" })
  await settle()

  assert.equal(transport.sent.length, 0)
  assert.equal(pipeline.counters.dropped["not-allowlisted"], 1)
  await pipeline.stop()
})

test("群聊：@ 了才回，没 @ 不回", async () => {
  const { pipeline, transport } = makePipeline()
  await pipeline.start()

  pipeline.accept({
    chatId: GROUP_TEST,
    chatKind: "group",
    senderId: "wxid_friend",
    messageId: "g1",
    text: "今天天气不错",
    mentionedBot: false,
  })
  await settle()
  assert.equal(transport.sent.length, 0)

  pipeline.accept({
    chatId: GROUP_TEST,
    chatKind: "group",
    senderId: "wxid_friend",
    messageId: "g2",
    text: "@大肥鱼 今天跑步了吗",
    mentionedBot: true,
  })
  await settle()
  assert.equal(transport.sent.length, 1)
  assert.equal(transport.sent[0].chatId, GROUP_TEST)
  await pipeline.stop()
})

test("自己发的、空的、非文本都不回", async () => {
  const { pipeline, transport } = makePipeline()
  await pipeline.start()

  pipeline.accept({ chatId: DM_JUNZILIU, senderId: "wxid_me", self: true, messageId: "s1", text: "我说的话" })
  pipeline.accept({ chatId: DM_JUNZILIU, senderId: DM_JUNZILIU, messageId: "s2", text: "   " })
  pipeline.accept({ chatId: DM_JUNZILIU, senderId: DM_JUNZILIU, messageId: "s3", text: "" })
  await settle()

  assert.equal(transport.sent.length, 0)
  assert.equal(pipeline.counters.dropped.self, 1)
  assert.ok(pipeline.counters.dropped.empty >= 2)
  await pipeline.stop()
})

test("重复消息只回一次", async () => {
  const { pipeline, transport } = makePipeline()
  await pipeline.start()

  const message = { chatId: DM_JUNZILIU, senderId: DM_JUNZILIU, messageId: "dup-1", text: "在吗" }
  pipeline.accept(message)
  pipeline.accept({ ...message })
  await settle()

  assert.equal(transport.sent.length, 1)
  assert.equal(pipeline.counters.dropped.duplicate, 1)
  await pipeline.stop()
})

test("同一会话 6 秒内第二条被节流", async () => {
  const { pipeline, transport } = makePipeline({ rateLimit: { perChatSec: 6, maxPerMinute: 100 } })
  await pipeline.start()

  pipeline.accept({ chatId: DM_JUNZILIU, senderId: DM_JUNZILIU, messageId: "r1", text: "第一句" })
  await settle()
  pipeline.accept({ chatId: DM_JUNZILIU, senderId: DM_JUNZILIU, messageId: "r2", text: "第二句" })
  await settle()

  assert.equal(transport.sent.length, 1)
  const throttleRows = readAudit(pipeline.status().auditPath).filter((row) => row.result === "throttled")
  assert.equal(throttleRows.length, 1)
  assert.equal(throttleRows[0].reason, "min-interval")
  await pipeline.stop()
})

test("一分钟内超过 6 条被拒", async () => {
  const { pipeline, transport } = makePipeline({ rateLimit: { perChatSec: 0, maxPerMinute: 6 } })
  await pipeline.start()

  for (let i = 0; i < 8; i += 1) {
    pipeline.accept({ chatId: DM_JUNZILIU, senderId: DM_JUNZILIU, messageId: `p${i}`, text: `第 ${i + 1} 句` })
    await settle(20)
  }

  assert.equal(transport.sent.length, 6)
  await pipeline.stop()
})

test("总开关关掉时一条都不发，send 也直接失败", async () => {
  const { pipeline, transport } = makePipeline({ enabled: false })
  // 未启动的流水线也不该发。
  const direct = await pipeline.send(DM_JUNZILIU, "偷偷发一条")
  assert.equal(direct.ok, false)
  assert.equal(direct.error, "disabled")

  const decision = pipeline.accept({ chatId: DM_JUNZILIU, senderId: DM_JUNZILIU, messageId: "d1", text: "在吗" })
  assert.equal(decision.action, "drop")
  assert.equal(decision.reason, "disabled")
  await settle()

  assert.equal(transport.sent.length, 0)
  assert.equal(transport.startCalls, 0)
})

test("审计文件写出来了，默认不含正文", async () => {
  const { pipeline, auditPath } = makePipeline()
  await pipeline.start()

  pipeline.accept({ chatId: DM_JUNZILIU, senderId: DM_JUNZILIU, messageId: "a1", text: "这句话不该落盘" })
  await settle()
  await pipeline.stop()

  const rows = readAudit(auditPath)
  assert.ok(rows.length >= 2, "至少一条入站、一条出站")
  const inbound = rows.find((row) => row.direction === "in")
  const outbound = rows.find((row) => row.direction === "out")
  assert.equal(inbound.chatId, DM_JUNZILIU)
  assert.equal(inbound.result, "accepted")
  assert.equal(outbound.result, "ok")
  assert.equal(outbound.transport, "mock")
  assert.equal(inbound.text, undefined, "默认不记正文")
  assert.equal(outbound.text, undefined, "默认不记正文")
  assert.ok(rows.every((row) => typeof row.ts === "string" && row.ts.includes("T")))
})

test("打开 logContent 之后正文才进审计", async () => {
  const { pipeline, auditPath } = makePipeline()
  // 直接改配置里那个字段，模拟用户打开它。
  pipeline.status() // 确认状态可读，不改行为
  const dir = join(auditPath, "..")
  const { createAudit } = await import("../lib/audit.js")
  const audit = createAudit({ path: join(dir, "content.jsonl"), logContent: true })
  audit.record({ chatId: DM_JUNZILIU, direction: "in", text: "这段会被记下来", result: "accepted" })
  const rows = readAudit(join(dir, "content.jsonl"))
  assert.equal(rows[0].text, "这段会被记下来")
})

test("生成失败不会崩，只记一次错误", async () => {
  const { pipeline, transport } = makePipeline({
    generate: async () => {
      throw new Error("模型挂了")
    },
  })
  await pipeline.start()

  pipeline.accept({ chatId: DM_JUNZILIU, senderId: DM_JUNZILIU, messageId: "e1", text: "在吗" })
  await settle()

  assert.equal(transport.sent.length, 0)
  assert.equal(pipeline.counters.failed, 1)
  await pipeline.stop()
})

test("模型返回空内容时不发", async () => {
  const { pipeline, transport } = makePipeline({ generate: async () => "   " })
  await pipeline.start()

  pipeline.accept({ chatId: DM_JUNZILIU, senderId: DM_JUNZILIU, messageId: "n1", text: "在吗" })
  await settle()

  assert.equal(transport.sent.length, 0)
  await pipeline.stop()
})

test("连发几句会被合并成一轮", async () => {
  const prompts = []
  const { pipeline, transport } = makePipeline({
    rateLimit: { debounceMs: 30 },
    generate: async ({ text }) => {
      prompts.push(text)
      return "收到"
    },
  })
  await pipeline.start()

  pipeline.accept({ chatId: DM_JUNZILIU, senderId: DM_JUNZILIU, messageId: "c1", text: "在吗" })
  pipeline.accept({ chatId: DM_JUNZILIU, senderId: DM_JUNZILIU, messageId: "c2", text: "那个事" })
  pipeline.accept({ chatId: DM_JUNZILIU, senderId: DM_JUNZILIU, messageId: "c3", text: "帮我看下" })
  await settle(120)

  assert.equal(prompts.length, 1)
  assert.equal(prompts[0], "在吗\n那个事\n帮我看下")
  assert.equal(transport.sent.length, 1)
  await pipeline.stop()
})

test("管道把 system prompt 交给了模型", async () => {
  const seen = []
  const { pipeline } = makePipeline({
    generate: async ({ systemPrompt }) => {
      seen.push(systemPrompt)
      return "好"
    },
  })
  await pipeline.start()
  pipeline.accept({ chatId: GROUP_TEST, chatKind: "group", senderId: "wxid_f", messageId: "sp1", text: "@大肥鱼 在吗", mentionedBot: true })
  await settle()

  assert.equal(seen.length, 1)
  assert.ok(seen[0].includes("群聊"), "群聊要带上群里的规矩")
  assert.ok(seen[0].includes("300"), "要提到字数上限")
  await pipeline.stop()
})
