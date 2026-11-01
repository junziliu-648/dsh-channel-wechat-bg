/**
 * 群里要知道"谁说的"，记忆要分"这个会话"和"这个人"两层。
 */

import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createPipeline } from "../lib/pipeline.js"
import { MockTransport } from "../lib/transport/mock.js"
import { personFile } from "../lib/chat-memory.js"

const quiet = { info: () => {}, warn: () => {}, error: () => {} }

async function makePipeline({ memoryDir, generate }) {
  const transport = new MockTransport()
  const pipeline = createPipeline({
    config: {
      enabled: true,
      botName: "鲸曦",
      denyUnknown: true,
      memoryDir,
      allow: [
        { id: "wxid_example_dm", kind: "dm", label: "小明", persona: "大肥鱼", reply: "always" },
        { id: "wxid_abc", kind: "dm", label: "小王", persona: "大肥鱼", reply: "always" },
        { id: "12345678901@chatroom", kind: "group", label: "test", persona: "大肥鱼", reply: "mention", triggers: ["!"] },
      ],
      rateLimit: { perChatSec: 0, maxPerMinute: 100, debounceMs: 0, maxReplyChars: 300 },
      audit: { path: "", logContent: false },
      personaDir: "",
    },
    transport,
    generate: generate ?? (async () => "嗯。"),
    logger: quiet,
  })
  await pipeline.start()
  return { pipeline, transport }
}

const settle = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms))

test("群里带上是谁说的，私聊不加前缀", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cwb-spk-"))
  const seen = []
  try {
    const { pipeline } = await makePipeline({
      memoryDir: dir,
      generate: async (input) => {
        seen.push(input.text)
        return "收到。"
      },
    })

    pipeline.accept({
      chatId: "12345678901@chatroom",
      chatKind: "group",
      senderId: "wxid_example_dm",
      senderName: "小明",
      text: "!今天服务器又挂了",
      timestamp: 1,
    })
    await settle()

    pipeline.accept({
      chatId: "wxid_example_dm",
      chatKind: "dm",
      senderId: "wxid_example_dm",
      senderName: "小明",
      text: "今天服务器又挂了",
      timestamp: 2,
    })
    await settle()

    assert.equal(seen.length, 2)
    assert.equal(seen[0], "小明：今天服务器又挂了")
    assert.equal(seen[1], "今天服务器又挂了")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("同一个人在私聊和群里，共用同一份画像", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cwb-spk-"))
  try {
    const { pipeline, transport } = await makePipeline({ memoryDir: dir })

    pipeline.accept({
      chatId: "12345678901@chatroom",
      chatKind: "group",
      senderId: "wxid_abc",
      senderName: "小王",
      text: "!我在写前端",
      timestamp: 1,
    })
    await settle()

    pipeline.accept({
      chatId: "wxid_abc",
      chatKind: "dm",
      senderId: "wxid_abc",
      senderName: "小王",
      text: "还是那个项目",
      timestamp: 2,
    })
    await settle()

    assert.equal(transport.sent.length, 2)

    // 只该有一个人的画像文件，而不是两个会话各存一份。
    const person = JSON.parse(readFileSync(personFile(dir, "wxid_abc"), "utf8"))
    assert.equal(person.id, "wxid_abc")
    assert.equal(person.name, "小王")
    assert.equal(person.log.length, 2)
    assert.deepEqual(
      person.log.map((row) => row.chatId),
      ["12345678901@chatroom", "wxid_abc"],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("「记住」的东西同时进会话记忆和说话人画像", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cwb-spk-"))
  try {
    const { pipeline } = await makePipeline({
      memoryDir: dir,
      generate: async () => "好，我记着了[记住: 跟他约好周五交稿]",
    })

    pipeline.accept({
      chatId: "12345678901@chatroom",
      chatKind: "group",
      senderId: "wxid_abc",
      senderName: "小王",
      text: "!周五给你稿子",
      timestamp: 1,
    })
    await settle()

    const person = JSON.parse(readFileSync(personFile(dir, "wxid_abc"), "utf8"))
    assert.deepEqual(person.facts, ["跟他约好周五交稿"])
    // 而且这句话没发出去（标记被抽掉了）
    const sent = readFileSync(personFile(dir, "wxid_abc"), "utf8")
    assert.equal(sent.includes("记住"), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
