/**
 * HTTP/SSE 传输的公共骨架。
 *
 * `pad` 和 `wechatferry` 在"怎么跟后台说话"这件事上是同一个形状：一个带 token 的
 * HTTP 端点，用 SSE 推入站消息，用 POST 发送。差别只在**它后面是谁** —— 托管协议
 * 端背后是别人的服务器，`wechatferry` 背后是本机注入微信进程的桥。
 *
 * 所以连接、鉴权、重连、SSE 解析、错误收敛都写在这里，两边的子类只负责"启动前
 * 必须满足什么条件"。这样 `wechatferry` 的版本闸门不会和 `pad` 的重连逻辑各写一遍。
 *
 * 协议约定（桥/协议端需要实现）：
 *   GET  {baseUrl}/health   → 200 {"ok":true,"accountId":"wxid_..."}
 *   GET  {baseUrl}/events   → text/event-stream，每条 data 是一个入站消息
 *   POST {baseUrl}/send     → body {"chatId","text"} → {"ok":true,"messageId":"..."}
 *   全部带 Authorization: Bearer {token}（token 为空时不带）
 */

import {
  FULL_CAPABILITIES,
  TransportError,
  TransportNotConfiguredError,
  normalizeInbound,
} from "./base.js"

/** 断流之后的重连间隔，从 2 秒退到 30 秒封顶。 */
const RECONNECT_MIN_MS = 2000
const RECONNECT_MAX_MS = 30_000

/** 探活和发送的超时。事件流不设超时（它本来就该长着）。 */
const REQUEST_TIMEOUT_MS = 15_000
// 发消息/发文件要等桥那边"键盘鼠标空闲"最多 90 秒，再算上微信冷启动抢前台，
// 15 秒根本不够 —— 超时会让 DSH 以为没发出去，实际桥后来还是发出去了。
const SEND_TIMEOUT_MS = 150_000

export class HttpLinkTransport {
  capabilities = FULL_CAPABILITIES
  kind = "http"

  /**
   * @param {object} options - 连接参数。
   * @param {string} options.baseUrl - 端点地址，必须带 http/https。
   * @param {string} [options.token] - Bearer token。
   * @param {string} [options.kind] - 传输名，只用于报错文案。
   * @param {string} [options.label] - 出错时对"对面是什么"的称呼。
   * @param {typeof fetch} [options.fetch] - fetch 实现，测试用。
   * @param {(message: string) => void} [options.log] - 日志函数。
   */
  constructor({ baseUrl, token = "", kind, label, fetch: fetchImpl, log } = {}) {
    if (kind !== undefined) this.kind = kind
    this.label = label ?? "后台传输"
    this.baseUrl = String(baseUrl ?? "").trim().replace(/\/+$/, "")
    this.token = String(token ?? "").trim()
    this.fetch = fetchImpl ?? globalThis.fetch
    this.log = log ?? ((message) => console.warn(`[channel-wechat-bg] ${message}`))
    /** @type {Set<(message: object) => void>} */
    this.handlers = new Set()
    /** @type {AbortController | undefined} */
    this.controller = undefined
    /** @type {Promise<void> | undefined} */
    this.loop = undefined
    this.stopped = false
    /** @type {string | null} */
    this.selfId = null
    /** @type {object | undefined} */
    this.lastHealth = undefined

    if (this.baseUrl === "") {
      throw new TransportNotConfiguredError(this.notConfiguredMessage())
    }
    let parsed
    try {
      parsed = new URL(this.baseUrl)
    } catch {
      throw new TransportNotConfiguredError(`channel-wechat-bg: transport.baseUrl 不是合法地址：${this.baseUrl}`)
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new TransportNotConfiguredError(
        `channel-wechat-bg: transport.baseUrl 只支持 http/https，收到 ${parsed.protocol}`,
      )
    }
  }

  /**
   * 没配 baseUrl 时该说什么。子类可以改。
   * @returns {string}
   */
  notConfiguredMessage() {
    return (
      `channel-wechat-bg: transport.kind=${this.kind} 但没有配置 transport.baseUrl。` +
      "没有任何后台传输可用，已拒绝启动（不会退回到 UI 自动化）。"
    )
  }

  /**
   * 启动前的硬条件。子类在这里加自己的闸门。
   * @param {object} status - `health()` 的返回值。
   * @returns {Promise<void>}
   */
  async precheck(status) {
    void status
  }

  /**
   * 启动：先探活（含子类的闸门），再开事件流。
   * @returns {Promise<void>}
   */
  async start() {
    const status = await this.health()
    if (!status.ok) {
      throw new TransportError(
        `channel-wechat-bg: ${this.label}探活失败：${status.detail ?? "未知原因"}`,
        "TRANSPORT_UNHEALTHY",
      )
    }
    await this.precheck(status)
    this.stopped = false
    this.controller = new AbortController()
    // 事件流是长连接，不能 await 它，否则 apply 永远不返回。
    this.loop = this.pump().catch((error) => {
      if (!this.stopped) this.log(`事件流异常退出：${error?.message ?? error}`)
    })
  }

  async stop() {
    this.stopped = true
    this.controller?.abort()
    try {
      await this.loop
    } catch {
      // 停止时的错误没有意义。
    }
    this.controller = undefined
    this.loop = undefined
  }

  /**
   * @param {(message: object) => void} handler - 入站回调。
   * @returns {() => void} 取消注册。
   */
  onMessage(handler) {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  /**
   * @param {string} chatId - 会话 ID。
   * @param {string} text - 正文。
   * @returns {Promise<{ok: boolean, messageId?: string, error?: string}>}
   */
  async sendText(chatId, text) {
    try {
      const response = await this.request("POST", "/send", { chatId, text }, { timeoutMs: SEND_TIMEOUT_MS })
      const body = await readJson(response)
      if (!response.ok) {
        return { ok: false, error: `HTTP ${response.status} ${redactBody(body)}`.trim() }
      }
      if (body?.ok === false) return { ok: false, error: redactBody(body) || `${this.label}拒绝发送` }
      return { ok: true, messageId: body?.messageId ?? body?.message_id ?? undefined }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error).slice(0, 200) }
    }
  }

  /**
   * 发图片/文件：POST {baseUrl}/send-file
   * @param {string} chatId
   * @param {string} filePath - 虚拟机里的绝对路径
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async sendFile(chatId, filePath) {
    try {
      const response = await this.request("POST", "/send-file", { chatId, path: filePath }, { timeoutMs: SEND_TIMEOUT_MS })
      const body = await readJson(response)
      if (!response.ok) {
        return { ok: false, error: `HTTP ${response.status} ${redactBody(body)}`.trim() }
      }
      if (body?.ok === false) return { ok: false, error: redactBody(body) || `${this.label} 拒绝发送` }
      return { ok: true }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error).slice(0, 200) }
    }
  }

  /**
   * @returns {Promise<{ok: boolean, detail?: string, raw?: object}>}
   */
  async health() {
    try {
      const response = await this.request("GET", "/health")
      if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` }
      const body = await readJson(response)
      this.lastHealth = body
      const accountId = String(body?.accountId ?? body?.account_id ?? body?.selfId ?? "").trim()
      if (accountId !== "") this.selfId = accountId
      return { ok: body?.ok !== false, detail: accountId === "" ? "已连通" : `账号 ${accountId}`, raw: body }
    } catch (error) {
      return { ok: false, detail: String(error?.message ?? error).slice(0, 200) }
    }
  }

  /**
   * 每轮连接事件流之前的钩子。子类可以在这里把"当前该收哪些会话"推给对面 ——
   * 桥重启之后白名单是空的，只在 start() 推一次是不够的。
   * @returns {Promise<void>}
   */
  async beforeStream() {}

  /**
   * 长连接主循环：断线就退避重连，直到被 stop。
   * @returns {Promise<void>}
   */
  async pump() {
    let backoff = RECONNECT_MIN_MS
    while (!this.stopped) {
      try {
        await this.beforeStream()
        const response = await this.request("GET", "/events", undefined, { stream: true })
        if (!response.ok || response.body === null) {
          throw new Error(`事件流 HTTP ${response.status}`)
        }
        backoff = RECONNECT_MIN_MS
        for await (const payload of readSse(response.body)) {
          if (this.stopped) return
          let raw
          try {
            raw = JSON.parse(payload)
          } catch {
            continue
          }
          const message = normalizeInbound(raw)
          if (message.chatId === "") continue
          for (const handler of this.handlers) handler(message)
        }
      } catch (error) {
        if (this.stopped || this.controller?.signal.aborted === true) return
        this.log(`事件流断开：${error?.message ?? error}；${backoff}ms 后重连`)
      }
      if (this.stopped) return
      await sleep(backoff, this.controller?.signal)
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS)
    }
  }

  /**
   * 发一个带认证的请求。
   * @param {string} method - HTTP 方法。
   * @param {string} path - 以 / 开头的路径。
   * @param {object} [body] - JSON 请求体。
   * @param {object} [options] - 额外选项。
   * @param {boolean} [options.stream] - 是否要读流。
   * @returns {Promise<Response>}
   */
  request(method, path, body, { stream = false, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    const headers = { accept: "application/json" }
    if (this.token !== "") headers.authorization = `Bearer ${this.token}`
    /** @type {RequestInit} */
    const init = { method, headers, signal: this.controller?.signal }
    if (body !== undefined) {
      headers["content-type"] = "application/json"
      init.body = JSON.stringify(body)
    }
    if (!stream) {
      // 单次请求不该挂着事件流的 signal：stop 之后的探活仍然应该能超时返回。
      // 取而代之的是一个短超时，免得桥死掉时整个启动挂在这里。
      init.signal = AbortSignal.timeout(timeoutMs)
    }
    return this.fetch(`${this.baseUrl}${path}`, init)
  }
}

/**
 * 读 SSE 流，把每个事件的数据部分 yield 出来。
 * @param {ReadableStream<Uint8Array>} body - 响应体。
 * @returns {AsyncGenerator<string>}
 */
export async function* readSse(body) {
  const decoder = new TextDecoder()
  let buffer = ""
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    let index = buffer.indexOf("\n\n")
    while (index >= 0) {
      const block = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      index = buffer.indexOf("\n\n")
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
      if (data !== "") yield data
    }
  }
}

/**
 * @param {Response} response - 响应。
 * @returns {Promise<any>}
 */
export async function readJson(response) {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

/**
 * 把错误体压成一行可以进审计的文本。
 * @param {any} body - 响应体。
 * @returns {string}
 */
export function redactBody(body) {
  if (body === undefined) return ""
  if (typeof body === "string") return body.slice(0, 200)
  if (typeof body?.error === "string") return body.error.slice(0, 200)
  if (typeof body?.message === "string") return body.message.slice(0, 200)
  try {
    return JSON.stringify(body).slice(0, 200)
  } catch {
    return ""
  }
}

/**
 * @param {number} ms - 毫秒。
 * @param {AbortSignal} [signal] - 取消信号。
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer === "object" && timer !== null && typeof timer.unref === "function") timer.unref()
    signal?.addEventListener("abort", () => {
      clearTimeout(timer)
      resolve()
    })
  })
}
