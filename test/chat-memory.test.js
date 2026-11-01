import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  MAX_FACTS,
  MAX_LOG,
  extractRemember,
  memoryFile,
  memoryFileName,
  noteExchange,
  readMemory,
  renderMemory,
  writeMemory,
} from "../lib/chat-memory.js"

const tmp = () => mkdtempSync(join(tmpdir(), "cwb-mem-"))

test("会话 id 变成安全的文件名，且不同 id 不会撞", () => {
  const a = memoryFileName("12345678901@chatroom")
  const b = memoryFileName("wxid_example_dm")
  assert.match(a, /^[A-Za-z0-9@._-]+\.json$/)
  assert.notEqual(a, b)
  // 路径分隔符、冒号这些一定不能出现
  assert.ok(!memoryFileName("a/b\\c:d").includes("/"))
  assert.ok(!memoryFileName("a/b\\c:d").includes("\\"))
  assert.ok(!memoryFileName("a/b\\c:d").includes(":"))
  assert.match(memoryFileName("a/b"), /^a_b-[0-9a-f]{8}\.json$/)
})

test("没配目录就不给路径，读写都当没有", () => {
  assert.equal(memoryFile("", "x"), "")
  assert.deepEqual(readMemory(""), { version: 1, facts: [], log: [] })
  assert.equal(writeMemory("", { facts: [], log: [] }), false)
})

test("写进去能读回来，坏文件当没记过", () => {
  const dir = tmp()
  try {
    const file = memoryFile(dir, "12345678901@chatroom")
    assert.equal(writeMemory(file, { version: 1, facts: ["对方叫小王"], log: [] }), true)
    assert.deepEqual(readMemory(file).facts, ["对方叫小王"])
    assert.deepEqual(readMemory(join(dir, "nope.json")), { version: 1, facts: [], log: [] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("`[记住: ...]` 被抽成事实，并且从回复里删掉", () => {
  const out = extractRemember("好呀[记住: 对方在做前端，喜欢简洁] 那我按你说的来")
  assert.deepEqual(out.facts, ["对方在做前端，喜欢简洁"])
  assert.equal(out.text, "好呀 那我按你说的来")
  assert.equal(out.text.includes("记住"), false)
})

test("记一轮对话：对方和自己各一行，事实去重", () => {
  const dir = tmp()
  try {
    const file = memoryFile(dir, "wxid_example_dm")
    noteExchange({ file, userText: "今天好累", replyText: "那就早点睡", facts: ["对方最近加班"], now: 1 })
    const out = extractRemember("嗯[记住: 对方最近加班]")
    noteExchange({ file, userText: "嗯", replyText: out.text, facts: out.facts, now: 2 })
    const mem = readMemory(file)
    assert.deepEqual(mem.facts, ["对方最近加班"])
    assert.deepEqual(mem.log.map((row) => row.who), ["them", "me", "them", "me"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("超过上限就丢最旧的，不会无限长", () => {
  const dir = tmp()
  try {
    const file = memoryFile(dir, "x@chatroom")
    for (let i = 0; i < MAX_LOG + 10; i += 1) {
      noteExchange({ file, userText: `第${i}句`, replyText: "嗯", now: i })
    }
    for (let i = 0; i < MAX_FACTS + 5; i += 1) {
      noteExchange({ file, userText: "x", replyText: "y", facts: [`事实${i}`], now: i })
    }
    const mem = readMemory(file)
    assert.equal(mem.log.length, MAX_LOG)
    assert.equal(mem.facts.length, MAX_FACTS)
    assert.equal(mem.facts.at(-1), `事实${MAX_FACTS + 4}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("没有记忆就不注入空段落", () => {
  assert.equal(renderMemory({ facts: [], log: [] }), "")
  const text = renderMemory({ facts: ["对方叫小王"], log: [{ at: 1, who: "them", text: "在吗" }] })
  assert.match(text, /你记得的事/)
  assert.match(text, /对方叫小王/)
  assert.match(text, /对方：在吗/)
})
