/**
 * 测试用的假传输。
 *
 * 它不做任何真实的事，但把真传输的形状完整走一遍：`start`/`stop`、`onMessage`
 * 回调、`sendText` 的返回、`health`。测试用它驱动整条流水线，于是"白名单、
 * 节流、审计"这些规则可以在不碰微信的情况下被测到。
 */

import { FULL_CAPABILITIES } from "./base.js"

export class MockTransport {
  /** 声明自己是能后台收发的，测试才跑得起来。 */
  capabilities = FULL_CAPABILITIES
  kind = "mock"

  /**
   * @param {object} [options] - 初始状态。
   * @param {(payload: {chatId: string, text: string}) => {ok: boolean, messageId?: string, error?: string}} [options.send] - 自定义发送行为。
   */
  constructor({ send } = {}) {
    this.sendImpl = send
    /** @type {{chatId: string, text: string, at: number}[]} 所有成功发送过的消息 */
    this.sent = []
    /** @type {Set<(message: object) => void>} */
    this.handlers = new Set()
    this.started = false
    this.startCalls = 0
    this.stopCalls = 0
  }

  async start() {
    this.startCalls += 1
    this.started = true
  }

  async stop() {
    this.stopCalls += 1
    this.started = false
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
    if (!this.started) return { ok: false, error: "transport_not_started" }
    if (this.sendImpl !== undefined) return this.sendImpl({ chatId, text })
    this.sent.push({ chatId, text, at: Date.now() })
    return { ok: true, messageId: `mock-${this.sent.length}` }
  }

  async health() {
    return { ok: this.started, detail: this.started ? "mock transport 已启动" : "mock transport 未启动" }
  }

  /**
   * 模拟收到一条消息。
   * @param {object} message - 入站消息。
   */
  deliver(message) {
    for (const handler of this.handlers) handler(message)
  }
}
