/**
 * 重复消息去重。
 *
 * 后台传输会重连、会补拉历史、会在断线后重放一小段。同一条消息因此可能到两次。
 * 去重键优先用传输给的 messageId；没有 ID 的适配器退化成"发送者 + 时间 + 正文"，
 * 这在补拉历史时同样稳定。
 */

/**
 * 一个有界的、按时间过期的去重器。
 *
 * 有界是必须的：一个长期运行的后台进程不能把十年份的键都存在内存里。
 */
export class Deduper {
  /**
   * @param {object} [options] - 过期时间与容量。
   * @param {number} [options.ttlMs] - 键保留多久，默认 10 分钟。
   * @param {number} [options.max] - 最多保留多少个键，默认 2048。
   * @param {() => number} [options.now] - 时钟，测试用。
   */
  constructor({ ttlMs = 10 * 60 * 1000, max = 2048, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs
    this.max = max
    this.now = now
    /** @type {Map<string, number>} 键 → 第一次见到的时间 */
    this.seen = new Map()
  }

  /**
   * 记下这次出现；如果之前见过则返回 true。
   * @param {object} message - 入站消息。
   * @returns {boolean} 是否是重复消息。
   */
  isDuplicate(message) {
    const key = dedupeKey(message)
    const at = this.now()
    this.sweep(at)
    if (this.seen.has(key)) return true
    this.seen.set(key, at)
    if (this.seen.size > this.max) {
      // Map 保持插入顺序，所以第一个键就是最老的。
      const oldest = this.seen.keys().next()
      if (!oldest.done) this.seen.delete(oldest.value)
    }
    return false
  }

  /** @param {number} at - 当前时间。 */
  sweep(at) {
    const deadline = at - this.ttlMs
    for (const [key, seenAt] of this.seen) {
      if (seenAt >= deadline) break
      this.seen.delete(key)
    }
  }

  /** 测试与状态接口用。 */
  get size() {
    return this.seen.size
  }
}

/**
 * 为一条消息算去重键。
 * @param {object} message - 入站消息。
 * @returns {string} 稳定键。
 */
export function dedupeKey(message) {
  const chatId = String(message?.chatId ?? "")
  const messageId = message?.messageId
  if (messageId !== undefined && messageId !== null && String(messageId) !== "") {
    return `${chatId}|id:${String(messageId)}`
  }
  const senderId = String(message?.senderId ?? "")
  const ts = String(message?.timestamp ?? "")
  const text = String(message?.text ?? "")
  return `${chatId}|raw:${senderId}|${ts}|${text}`
}
