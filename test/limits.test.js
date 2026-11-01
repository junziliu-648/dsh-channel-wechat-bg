/**
 * 节流、去重、合并的单测。
 *
 * 这三个模块都在跟"时间"打交道，所以时钟和定时器都是注入的：测试不该靠
 * `await sleep(1200)` 来证明一个 1200ms 的窗口。
 */

import assert from "node:assert/strict"
import test from "node:test"

import { ChatDebouncer } from "../lib/debounce.js"
import { Deduper, dedupeKey } from "../lib/dedupe.js"
import { ReplyLimiter } from "../lib/rate-limit.js"

test("节流：同一会话 6 秒内第二条被拦", () => {
  let clock = 0
  const limiter = new ReplyLimiter({ perChatSec: 6, maxPerMinute: 6, now: () => clock })

  assert.equal(limiter.tryAcquire("a").ok, true)
  limiter.commit("a")

  clock = 3000
  const second = limiter.tryAcquire("a")
  assert.equal(second.ok, false)
  assert.equal(second.reason, "min-interval")
  assert.equal(second.retryAfterMs, 3000)

  clock = 6000
  assert.equal(limiter.tryAcquire("a").ok, true)
})

test("节流：不同会话互不影响", () => {
  let clock = 0
  const limiter = new ReplyLimiter({ perChatSec: 6, maxPerMinute: 6, now: () => clock })
  assert.equal(limiter.tryAcquire("a").ok, true)
  limiter.commit("a")
  assert.equal(limiter.tryAcquire("b").ok, true)
})

test("节流：一分钟内超过 6 条被拦", () => {
  let clock = 0
  const limiter = new ReplyLimiter({ perChatSec: 0, maxPerMinute: 6, now: () => clock })
  for (let i = 0; i < 6; i += 1) {
    assert.equal(limiter.tryAcquire("a").ok, true, `第 ${i + 1} 条应该放行`)
    limiter.commit("a")
    clock += 1000
  }
  const seventh = limiter.tryAcquire("a")
  assert.equal(seventh.ok, false)
  assert.equal(seventh.reason, "per-minute")

  clock += 60_000
  assert.equal(limiter.tryAcquire("a").ok, true, "一分钟之后再放行")
})

test("去重：同一条消息第二次出现算重复", () => {
  const deduper = new Deduper({ now: () => 0 })
  const message = { chatId: "c", messageId: "m1", senderId: "s", text: "hi", timestamp: 1 }
  assert.equal(deduper.isDuplicate(message), false)
  assert.equal(deduper.isDuplicate(message), true)
})

test("去重：没有 messageId 时退化成 发送者+时间+正文", () => {
  const deduper = new Deduper({ now: () => 0 })
  const message = { chatId: "c", senderId: "s", text: "hi", timestamp: 1700000000 }
  assert.equal(deduper.isDuplicate(message), false)
  assert.equal(deduper.isDuplicate({ ...message }), true)
  assert.equal(deduper.isDuplicate({ ...message, text: "hello" }), false)
})

test("去重：过了 TTL 之后同一条又算新的", () => {
  let clock = 0
  const deduper = new Deduper({ ttlMs: 1000, now: () => clock })
  const message = { chatId: "c", messageId: "m1" }
  assert.equal(deduper.isDuplicate(message), false)
  clock = 500
  assert.equal(deduper.isDuplicate(message), true)
  clock = 1500
  assert.equal(deduper.isDuplicate(message), false)
})

test("去重：键里带会话，不同会话同一个 id 不算重复", () => {
  assert.notEqual(dedupeKey({ chatId: "a", messageId: "m1" }), dedupeKey({ chatId: "b", messageId: "m1" }))
})

test("合并：窗口内的多条消息一次交出", async () => {
  const flushed = []
  const debouncer = new ChatDebouncer({ debounceMs: 20 })
  debouncer.push("c", { text: "第一句" }, (batch) => flushed.push(batch))
  debouncer.push("c", { text: "第二句" }, (batch) => flushed.push(batch))
  debouncer.push("c", { text: "第三句" }, (batch) => flushed.push(batch))
  assert.deepEqual(debouncer.pending(), { c: 3 })

  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(flushed.length, 1)
  assert.equal(flushed[0].messages.length, 3)
  assert.deepEqual(debouncer.pending(), {})
})

test("合并：不同会话各自成批", async () => {
  const flushed = []
  const debouncer = new ChatDebouncer({ debounceMs: 10 })
  debouncer.push("a", { text: "1" }, (batch) => flushed.push(batch))
  debouncer.push("b", { text: "2" }, (batch) => flushed.push(batch))
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(flushed.length, 2)
  assert.deepEqual(flushed.map((batch) => batch.chatId).sort(), ["a", "b"])
})

test("合并：dispose 之后不再回调", async () => {
  const flushed = []
  const debouncer = new ChatDebouncer({ debounceMs: 10 })
  debouncer.push("a", { text: "1" }, (batch) => flushed.push(batch))
  debouncer.dispose()
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(flushed.length, 0)
})
