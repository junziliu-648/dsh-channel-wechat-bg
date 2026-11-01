/**
 * 发送节流。
 *
 * 两道上限：同一个会话两次回复之间至少隔 `perChatSec` 秒；任意一分钟内最多回
 * `maxPerMinute` 条。两条都过了才允许发 —— 节流的意义是"宁可少说一句"，所以
 * 拿不到许可就是丢弃，不排队补发。排队补发会让一次故障之后突然刷出一串旧回复。
 */

export class ReplyLimiter {
  /**
   * @param {object} [options] - 上限与时钟。
   * @param {number} [options.perChatSec] - 同一会话两次回复的最小间隔（秒）。
   * @param {number} [options.maxPerMinute] - 一分钟内最多回复几条。
   * @param {() => number} [options.now] - 时钟，测试用。
   */
  constructor({ perChatSec = 6, maxPerMinute = 6, now = () => Date.now() } = {}) {
    this.perChatSec = Math.max(0, Number(perChatSec) || 0)
    this.maxPerMinute = Math.max(1, Math.trunc(Number(maxPerMinute) || 1))
    this.now = now
    /** @type {Map<string, {lastAt: number, minute: number[]}>} 会话 → 状态 */
    this.chats = new Map()
  }

  /**
   * 尝试占一个发送名额。
   *
   * 只有真的发出去了才应该调用 `commit`；先 `tryAcquire` 再发，是为了在生成
   * 回复之前就知道"这条发不出去"，省掉一次白跑的模型调用。
   *
   * @param {string} chatId - 会话 ID。
   * @returns {{ok: true} | {ok: false, reason: 'min-interval'|'per-minute', retryAfterMs: number}}
   */
  tryAcquire(chatId) {
    const id = String(chatId)
    const at = this.now()
    const state = this.chats.get(id) ?? { lastAt: null, minute: [] }

    // `lastAt === null` 表示"还没回过"。用 null 而不是 0：时钟从 0 开始的测试里
    // 0 是一个合法的时间戳，拿 0 当哨兵会漏掉第一次间隔判断。
    if (this.perChatSec > 0 && state.lastAt !== null) {
      const waitMs = state.lastAt + this.perChatSec * 1000 - at
      if (waitMs > 0) return { ok: false, reason: "min-interval", retryAfterMs: waitMs }
    }

    const minute = state.minute.filter((t) => t > at - 60_000)
    if (minute.length >= this.maxPerMinute) {
      const oldest = minute[0]
      return { ok: false, reason: "per-minute", retryAfterMs: Math.max(0, oldest + 60_000 - at) }
    }

    this.chats.set(id, { lastAt: state.lastAt, minute })
    return { ok: true }
  }

  /**
   * 记下一次真实发送。
   * @param {string} chatId - 会话 ID。
   */
  commit(chatId) {
    const id = String(chatId)
    const at = this.now()
    const state = this.chats.get(id) ?? { lastAt: null, minute: [] }
    const minute = state.minute.filter((t) => t > at - 60_000)
    minute.push(at)
    this.chats.set(id, { lastAt: at, minute })
  }

  /** 状态接口用：每个会话最近一次回复的时间。 */
  snapshot() {
    const at = this.now()
    const out = {}
    for (const [chatId, state] of this.chats) {
      out[chatId] = {
        lastAt: state.lastAt === null ? null : new Date(state.lastAt).toISOString(),
        lastMinute: state.minute.filter((t) => t > at - 60_000).length,
      }
    }
    return out
  }
}
