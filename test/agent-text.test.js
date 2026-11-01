/**
 * 会话 ID 与回复提取的测试。
 *
 * 这两件事考试式的写法不会出错，出错都在形状上：事件多了一个 `interrupted`
 * 字段、内容块里混进一个 `tool-call`、或者只有图片没有文字。所以这里的用例
 * 就是那些形状本身。
 */

import assert from "node:assert/strict"
import test from "node:test"

import { SESSION_ID_PREFIX, extractAssistantText, sessionIdFor } from "../lib/agent-text.js"

test("sessionIdFor 带前缀，私聊与群聊都稳定", () => {
  assert.equal(sessionIdFor("wxid_example_dm"), `${SESSION_ID_PREFIX}wxid_example_dm`)
  assert.equal(sessionIdFor("12345678901@chatroom"), `${SESSION_ID_PREFIX}12345678901@chatroom`)
})

test("sessionIdFor 是幂等的同一个函数，不随调用变化", () => {
  const chatId = "wxid_example_dm"
  assert.equal(sessionIdFor(chatId), sessionIdFor(chatId))
})

test("sessionIdFor 转义 ~ 以免和别的会话撞名", () => {
  assert.equal(sessionIdFor("a~b"), `${SESSION_ID_PREFIX}a~7Eb`)
  assert.notEqual(sessionIdFor("a~7Eb"), sessionIdFor("a~b"))
})

test("extractAssistantText 拼回多段文字", () => {
  const event = {
    type: "assistant/message",
    data: {
      content: [
        { type: "text", text: "先说结论：" },
        { type: "text", text: "这事能做。" },
      ],
    },
  }
  assert.equal(extractAssistantText(event), "先说结论：这事能做。")
})

test("extractAssistantText 忽略非 assistant/message 事件", () => {
  assert.equal(extractAssistantText({ type: "user/message", data: { content: [{ type: "text", text: "x" }] } }), undefined)
  assert.equal(extractAssistantText({ type: "turn/started", data: {} }), undefined)
  assert.equal(extractAssistantText(undefined), undefined)
})

test("extractAssistantText 丢掉被打断的半截", () => {
  const event = {
    type: "assistant/message",
    data: { interrupted: true, content: [{ type: "text", text: "我本来想" }] },
  }
  assert.equal(extractAssistantText(event), undefined)
})

test("extractAssistantText 丢掉带工具调用的那条", () => {
  const event = {
    type: "assistant/message",
    data: {
      content: [
        { type: "text", text: "我查一下。" },
        { type: "tool-call", name: "grep", arguments: {} },
      ],
    },
  }
  assert.equal(extractAssistantText(event), undefined, "模型在说明要干什么，不是给用户的回话")
})

test("extractAssistantText 只有非文字块时没有回话", () => {
  const event = {
    type: "assistant/message",
    data: { content: [{ type: "image", data: "…" }, { type: "reasoning", text: "想" }] },
  }
  assert.equal(extractAssistantText(event), undefined)
})

test("extractAssistantText 空文字当成没有回话", () => {
  assert.equal(extractAssistantText({ type: "assistant/message", data: { content: [{ type: "text", text: "" }] } }), undefined)
  assert.equal(extractAssistantText({ type: "assistant/message", data: {} }), undefined)
})
