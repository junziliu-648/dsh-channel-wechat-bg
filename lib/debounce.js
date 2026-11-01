/**
 * 按会话合并消息。
 *
 * 同一个人连着发三句"在吗""那个事""帮我看下"，是三个入站事件、一个意图。
 * 合并窗口给的是"把话说完"的时间，不是"攒够再说"的时间：窗口内每来一条就
 * 重置计时器（trailing debounce），窗口结束后一次性交给下游。
 *
 * 定时器是注入的，测试里可以立刻触发，不必真的等 1.2 秒。
 */

export class ChatDebouncer {
  /**
   * @param {object} [options] - 窗口与定时器。
   * @param {number} [options.debounceMs] - 静默多久之后合并发出，默认 1200ms。
   * @param {(fn: () => void, ms: number) => any} [options.setTimeout] - 定时器。
   * @param {(handle: any) => void} [options.clearTimeout] - 取消定时器。
   */
  constructor({
    debounceMs = 1200,
    setTimeout = globalThis.setTimeout,
    clearTimeout = globalThis.clearTimeout,
  } = {}) {
    this.debounceMs = Math.max(0, Number(debounceMs) || 0)
    this.setTimeout = setTimeout
    this.clearTimeout = clearTimeout
    /** @type {Map<string, {buffer: object[], timer: any}>} */
    this.chats = new Map()
  }

  /**
   * 收下一条消息；窗口到点后把这一窗的消息整体交给 `onFlush`。
   *
   * @param {string} chatId - 会话 ID。
   * @param {object} message - 已经过准入判断的入站消息。
   * @param {(batch: {chatId: string, messages: object[]}) => void} onFlush - 窗口到点的回调。
   */
  push(chatId, message, onFlush) {
    const id = String(chatId)
    const existing = this.chats.get(id)
    const buffer = existing === undefined ? [] : existing.buffer
    buffer.push(message)
    if (existing !== undefined) this.clearTimeout(existing.timer)

    const timer = this.setTimeout(() => {
      this.chats.delete(id)
      if (buffer.length > 0) onFlush({ chatId: id, messages: buffer })
    }, this.debounceMs)
    // Node 的定时器不该把进程钉在后台；浏览器里没有这个方法，所以是可选的。
    if (typeof timer === "object" && timer !== null && typeof timer.unref === "function") timer.unref()

    this.chats.set(id, { buffer, timer })
  }

  /** 立刻放出某个会话的缓冲（停止服务时用）。 */
  flush(chatId, onFlush) {
    const id = String(chatId)
    const state = this.chats.get(id)
    if (state === undefined) return
    this.clearTimeout(state.timer)
    this.chats.delete(id)
    if (state.buffer.length > 0) onFlush({ chatId: id, messages: state.buffer })
  }

  /** 立刻放出所有会话的缓冲，不触发任何回调之外的副作用。 */
  flushAll(onFlush) {
    for (const chatId of [...this.chats.keys()]) this.flush(chatId, onFlush)
  }

  /** 丢掉所有缓冲，不再回调。 */
  dispose() {
    for (const state of this.chats.values()) this.clearTimeout(state.timer)
    this.chats.clear()
  }

  /** 状态接口用。 */
  pending() {
    const out = {}
    for (const [chatId, state] of this.chats) out[chatId] = state.buffer.length
    return out
  }
}
