/**
 * 传输层的单测。
 *
 * 两件事要证明：一、没有可用的后台传输时**拒绝启动**，而不是退化成点什么；
 * 二、Pad 适配器的 HTTP/SSE 协议真的是按文档收发（用一个本地假服务器跑真
 * fetch，不打桩）。
 */

import assert from "node:assert/strict"
import { createServer } from "node:http"
import test from "node:test"

import {
  TransportNotConfiguredError,
  TransportUnsupportedError,
  assertBackgroundSend,
  assertSendCapability,
} from "../lib/transport/base.js"
import { createTransport } from "../lib/transport/index.js"
import { MockTransport } from "../lib/transport/mock.js"
import { PadTransport } from "../lib/transport/pad.js"
import { UiaTransport, UIA_CAPABILITIES, UIA_DEFAULT_URL } from "../lib/transport/uia.js"
import { WeChatFerryTransport, DEFAULT_BRIDGE_URL } from "../lib/transport/wechatferry.js"

test("能力声明为不能后台发送时拒绝启动", () => {
  const transport = new MockTransport()
  transport.capabilities = { receive: true, backgroundSend: false, groups: true }
  assert.throws(() => assertBackgroundSend(transport), TransportUnsupportedError)
  assert.throws(() => assertBackgroundSend(transport), /backgroundSend=false/)
})

test("能后台发送的传输放行", () => {
  assert.doesNotThrow(() => assertBackgroundSend(new MockTransport()))
})

test("前台传输默认不放行，打开 allowForegroundSend 才放行", () => {
  const transport = new MockTransport()
  transport.capabilities = { receive: true, backgroundSend: false, groups: true }

  assert.throws(() => assertSendCapability(transport), TransportUnsupportedError)
  assert.throws(() => assertSendCapability(transport), /allowForegroundSend/)
  assert.doesNotThrow(() => assertSendCapability(transport, { allowForegroundSend: true }))

  // 后台传输不看这个开关：它本来就该无条件放行。
  assert.doesNotThrow(() => assertSendCapability(new MockTransport(), { allowForegroundSend: false }))
})

test("配置里没有 transport 时拒绝启动", () => {
  assert.throws(() => createTransport({}), TransportNotConfiguredError)
  assert.throws(() => createTransport(undefined), TransportNotConfiguredError)
})

test("不认识的 transport.kind 拒绝启动，并列出可选值", () => {
  assert.throws(
    () => createTransport({ kind: "telepathy" }),
    (error) =>
      error instanceof TransportNotConfiguredError && error.message.includes("mock / pad / wechatferry / uia"),
  )
})

test("Pad 传输没有 baseUrl 时拒绝启动", () => {
  assert.throws(() => createTransport({ kind: "pad", pad: { baseUrl: "" } }), TransportNotConfiguredError)
  assert.throws(() => createTransport({ kind: "pad", pad: { baseUrl: "   " } }), /baseUrl/)
})

test("Pad 传输的地址不是 http/https 时拒绝启动", () => {
  assert.throws(() => createTransport({ kind: "pad", pad: { baseUrl: "file:///c:/x" } }), /http/)
  assert.throws(() => createTransport({ kind: "pad", pad: { baseUrl: "not a url" } }), /合法地址/)
})

test("WeChatFerry 没声明版本时默认连本机的桥", () => {
  const transport = createTransport({ kind: "wechatferry" })
  assert.ok(transport instanceof WeChatFerryTransport)
  assert.equal(transport.baseUrl, DEFAULT_BRIDGE_URL)
})

test("WeChatFerry 配置里写 4.x 时直接拒绝，不去连桥", async () => {
  const transport = new WeChatFerryTransport({ dllPath: "C:/x/sdk.dll", wechatVersion: "4.1.13.12" })
  await assert.rejects(() => transport.start(), /只支持微信 3\.9\.x/)
})

test("WeChatFerry 桥连不上时，把降级和起桥都说清楚", async () => {
  const transport = new WeChatFerryTransport({ baseUrl: "http://127.0.0.1:9", log: () => {} })
  await assert.rejects(
    () => transport.start(),
    (error) =>
      error instanceof TransportUnsupportedError &&
      error.message.includes("3.9.x") &&
      error.message.includes("wcf-bridge.py"),
  )
})

test("Mock 传输记录发送内容", async () => {
  const transport = new MockTransport()
  await transport.start()
  const result = await transport.sendText("wxid_a", "你好")
  assert.equal(result.ok, true)
  assert.equal(transport.sent.length, 1)
  assert.deepEqual(transport.sent[0].chatId, "wxid_a")
  await transport.stop()
  assert.equal(transport.started, false)
})

test("Mock 传输未启动时发送失败", async () => {
  const transport = new MockTransport()
  const result = await transport.sendText("wxid_a", "你好")
  assert.equal(result.ok, false)
  assert.equal(result.error, "transport_not_started")
})

/**
 * 起一个最小的 Pad 协议端。
 * @param {object} [options] - 行为覆盖。
 * @param {boolean} [options.sendFails] - 发送是否返回 500。
 * @param {object} [options.health] - 自定义 `/health` 响应体（用来模拟 WeChatFerry 桥）。
 * @returns {Promise<{baseUrl: string, close: () => Promise<void>, state: object}>}
 */
async function startFakePad({ sendFails = false, health } = {}) {
  const state = { sends: [], allows: [], closed: false, streams: new Set() }
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1")

    if (url.pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify(health ?? { ok: true, accountId: "wxid_self_0001" }))
      return
    }

    if (url.pathname === "/allow" && request.method === "PUT") {
      let body = ""
      request.on("data", (chunk) => {
        body += chunk
      })
      request.on("end", () => {
        state.allows.push(JSON.parse(body))
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ ok: true }))
      })
      return
    }

    if (url.pathname === "/events") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
      response.write(": hello\n\n")
      state.streams.add(response)
      request.on("close", () => state.streams.delete(response))
      response.write(
        `data: ${JSON.stringify({
          chatId: "wxid_a",
          chatKind: "dm",
          senderId: "wxid_a",
          messageId: "p1",
          text: "你好",
          timestamp: Date.now(),
        })}\n\n`,
      )
      return
    }

    if (url.pathname === "/send") {
      let body = ""
      request.on("data", (chunk) => {
        body += chunk
      })
      request.on("end", () => {
        state.sends.push(JSON.parse(body))
        if (sendFails) {
          response.writeHead(500, { "content-type": "application/json" })
          response.end(JSON.stringify({ error: "pad 端拒绝" }))
          return
        }
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ ok: true, messageId: "pad-1" }))
      })
      return
    }

    response.writeHead(404)
    response.end()
  })

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const baseUrl = `http://127.0.0.1:${address.port}`
  return {
    baseUrl,
    state,
    close: async () => {
      for (const stream of state.streams) stream.end()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

test("Pad 传输：探活、收 SSE、发 HTTP", async () => {
  const pad = await startFakePad()
  const transport = new PadTransport({ baseUrl: pad.baseUrl, token: "t0ken", log: () => {} })
  const received = []
  transport.onMessage((message) => received.push(message))

  try {
    await transport.start()
    assert.equal(transport.selfId, "wxid_self_0001")

    // 等事件流把那条消息推过来。
    for (let i = 0; i < 50 && received.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(received.length, 1)
    assert.equal(received[0].chatId, "wxid_a")
    assert.equal(received[0].text, "你好")

    const result = await transport.sendText("wxid_a", "回一句")
    assert.equal(result.ok, true)
    assert.equal(result.messageId, "pad-1")
    assert.deepEqual(pad.state.sends[0], { chatId: "wxid_a", text: "回一句" })
  } finally {
    await transport.stop()
    await pad.close()
  }
})

test("Pad 传输：协议端报错时返回 ok:false，而不是抛异常", async () => {
  const pad = await startFakePad({ sendFails: true })
  const transport = new PadTransport({ baseUrl: pad.baseUrl, log: () => {} })
  try {
    await transport.start()
    const result = await transport.sendText("wxid_a", "回一句")
    assert.equal(result.ok, false)
    assert.match(result.error, /500|拒绝/)
  } finally {
    await transport.stop()
    await pad.close()
  }
})

test("Pad 传输：协议端没起来时启动失败，不假装健康", async () => {
  const transport = new PadTransport({ baseUrl: "http://127.0.0.1:9", log: () => {} })
  await assert.rejects(() => transport.start(), /探活失败/)
})

test("WeChatFerry：桥报 4.x 时拒绝启动", async () => {
  const bridge = await startFakePad({ health: { ok: true, injected: true, accountId: "wxid_a", wechatVersion: "4.1.13.12" } })
  const transport = new WeChatFerryTransport({ baseUrl: bridge.baseUrl, log: () => {} })
  try {
    await assert.rejects(
      () => transport.start(),
      (error) => error instanceof TransportUnsupportedError && /3\.9\.x/.test(error.message),
    )
  } finally {
    await bridge.close()
  }
})

test("WeChatFerry：DLL 没注入时拒绝启动", async () => {
  const bridge = await startFakePad({
    health: { ok: true, injected: false, accountId: "wxid_a", wechatVersion: "3.9.11.25" },
  })
  const transport = new WeChatFerryTransport({ baseUrl: bridge.baseUrl, log: () => {} })
  try {
    await assert.rejects(() => transport.start(), /injected=false/)
  } finally {
    await bridge.close()
  }
})

test("WeChatFerry：3.9.x + 已注入时，收 SSE、发 HTTP 都走通", async () => {
  const bridge = await startFakePad({
    health: { ok: true, injected: true, accountId: "wxid_self_0002", wechatVersion: "3.9.11.25" },
  })
  const transport = new WeChatFerryTransport({ baseUrl: bridge.baseUrl, token: "t1", log: () => {} })
  const received = []
  transport.onMessage((message) => received.push(message))

  try {
    await transport.start()
    assert.equal(transport.selfId, "wxid_self_0002")

    for (let i = 0; i < 50 && received.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(received.length, 1)
    assert.equal(received[0].text, "你好")

    const result = await transport.sendText("wxid_a", "回一句")
    assert.equal(result.ok, true)
    assert.deepEqual(bridge.state.sends[0], { chatId: "wxid_a", text: "回一句" })
  } finally {
    await transport.stop()
    await bridge.close()
  }
})

test("UIA 传输：默认连本机 8850，能力如实声明为前台发送", () => {
  const transport = createTransport({ kind: "uia" })
  assert.ok(transport instanceof UiaTransport)
  assert.equal(transport.baseUrl, UIA_DEFAULT_URL)
  assert.deepEqual(transport.capabilities, UIA_CAPABILITIES)
  assert.equal(transport.capabilities.backgroundSend, false)
})

test("UIA 传输：桥没声明 foreground 时拒绝启动", async () => {
  const bridge = await startFakePad({ health: { ok: true, accountId: "wxid_a" } })
  const transport = new UiaTransport({ baseUrl: bridge.baseUrl, log: () => {} })
  try {
    await assert.rejects(
      () => transport.start(),
      (error) => error instanceof TransportUnsupportedError && /foreground/.test(error.message),
    )
  } finally {
    await bridge.close()
  }
})

test("UIA 传输：启动时把白名单推给桥，收 SSE、发 HTTP 都走通", async () => {
  const bridge = await startFakePad({
    health: { ok: true, foreground: true, accountId: "wxid_self_0003", wechatVersion: "4.1.13.12" },
  })
  const allow = [
    { id: "wxid_a", kind: "dm", triggers: [] },
    { id: "123@chatroom", kind: "group", triggers: ["@大肥鱼"] },
  ]
  const transport = new UiaTransport({ baseUrl: bridge.baseUrl, allow, log: () => {} })
  const received = []
  transport.onMessage((message) => received.push(message))

  try {
    await transport.start()
    assert.deepEqual(bridge.state.allows[0], {
      chats: [
        { id: "wxid_a", kind: "dm", mentions: [] },
        { id: "123@chatroom", kind: "group", mentions: ["@大肥鱼"] },
      ],
    })

    for (let i = 0; i < 50 && received.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(received.length, 1)

    const result = await transport.sendText("wxid_a", "回一句")
    assert.equal(result.ok, true)
    assert.deepEqual(bridge.state.sends[0], { chatId: "wxid_a", text: "回一句" })
  } finally {
    await transport.stop()
    await bridge.close()
  }
})

test("UIA 传输：桥连不上时，报错里给出起桥命令", async () => {
  const transport = new UiaTransport({ baseUrl: "http://127.0.0.1:9", log: () => {} })
  await assert.rejects(() => transport.start(), /uia-bridge\.py/)
})

