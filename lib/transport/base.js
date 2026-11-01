/**
 * 传输层的公共契约。
 *
 * 这里的每一条错误都是"拒绝启动"，没有"降级"分支。UI 自动化那条路在本插件里
 * 根本不存在，所以当没有任何后台传输被配置好时，唯一的结局是启动失败并说清楚
 * 原因 —— 而不是悄悄去点微信窗口。
 */

/** 传输层的基类错误，方便调用方一次 catch 掉所有配置/能力问题。 */
export class TransportError extends Error {
  /**
   * @param {string} message - 给人看的原因。
   * @param {string} [code] - 给程序看的原因码。
   */
  constructor(message, code = "TRANSPORT_ERROR") {
    super(message)
    this.name = "TransportError"
    this.code = code
  }
}

/** 没有配置任何可用的后台传输。 */
export class TransportNotConfiguredError extends TransportError {
  /**
   * @param {string} message - 给人看的原因。
   */
  constructor(message) {
    super(message, "TRANSPORT_NOT_CONFIGURED")
    this.name = "TransportNotConfiguredError"
  }
}

/** 配置了传输，但它不能后台发送，或者当前构建没有实现。 */
export class TransportUnsupportedError extends TransportError {
  /**
   * @param {string} message - 给人看的原因。
   * @param {string} [code] - 原因码。
   */
  constructor(message, code = "TRANSPORT_UNSUPPORTED") {
    super(message, code)
    this.name = "TransportUnsupportedError"
  }
}

/**
 * 一个能后台收发的能力声明。
 *
 * `backgroundSend` 是真后台传输的立身之本：它为 false 就等于"发送会抢前台"，
 * 那就必须在启动时停下 —— 除非用户明确同意用前台模式。
 */
export const FULL_CAPABILITIES = Object.freeze({ receive: true, backgroundSend: true, groups: true })

/** 前台发送的能力声明：能收能发，但发送会占用前台窗口。 */
export const FOREGROUND_CAPABILITIES = Object.freeze({ receive: true, backgroundSend: false, groups: true })

/**
 * 校验适配器能不能后台发送。
 *
 * @param {{capabilities?: {receive?: boolean, backgroundSend?: boolean, groups?: boolean}}} transport - 传输适配器。
 * @returns {void}
 * @throws {TransportUnsupportedError} 当 `backgroundSend` 不为 true 时。
 */
export function assertBackgroundSend(transport) {
  const capabilities = transport?.capabilities
  if (capabilities?.backgroundSend !== true) {
    throw new TransportUnsupportedError(
      `channel-wechat-bg: 传输 ${transport?.kind ?? "(未知)"} 声明 backgroundSend=${String(capabilities?.backgroundSend)}，` +
        "本插件只接受后台发送。已停止启动，不会退回到 UI 自动化。",
    )
  }
}

/**
 * 校验"能不能发送"，并把前台模式收在一个显式开关后面。
 *
 * 两种放行：
 *   - 传输自称后台发送（`backgroundSend === true`），无条件放行；
 *   - 传输会抢前台，但用户把 `allowForegroundSend` 打开了 —— 这是他知情后的选择，
 *     不是插件的默认行为。
 *
 * 其余情况一律拒绝启动。这里没有第三条路：不会"先试试能不能后台发"，
 * 也不会"发不出去就点窗口"。
 *
 * @param {{kind?: string, capabilities?: {backgroundSend?: boolean}}} transport - 传输适配器。
 * @param {{allowForegroundSend?: boolean}} [options] - 用户的显式许可。
 * @returns {void}
 * @throws {TransportUnsupportedError} 当前配置不允许发送时。
 */
export function assertSendCapability(transport, { allowForegroundSend = false } = {}) {
  const capabilities = transport?.capabilities
  if (capabilities?.backgroundSend === true) return
  if (allowForegroundSend === true) return
  throw new TransportUnsupportedError(
    `channel-wechat-bg: 传输 ${transport?.kind ?? "(未知)"} 的发送会占用前台窗口` +
      `（backgroundSend=${String(capabilities?.backgroundSend)}）。` +
      "如果这就是你要的，把 allowForegroundSend 设成 true 再启用；否则换成能后台发送的传输。",
    "TRANSPORT_FOREGROUND_NOT_ALLOWED",
  )
}

/**
 * 入站消息归一化。适配器只需要给出原始字段，形状在这里统一。
 *
 * @param {object} raw - 适配器给的原始对象。
 * @returns {{chatId: string, chatKind: 'dm'|'group', senderId: string, senderName: string, text: string, timestamp: number, messageId: string, mentionedBot: boolean, self: boolean}}
 */
export function normalizeInbound(raw) {
  const chatId = String(raw?.chatId ?? raw?.chat_id ?? "").trim()
  const chatKind = raw?.chatKind === "group" || raw?.chat_kind === "group" ? "group" : "dm"
  const timestampRaw = raw?.timestamp ?? raw?.createTime ?? raw?.create_time ?? Date.now()
  const timestamp = Number.isFinite(Number(timestampRaw)) ? Number(timestampRaw) : Date.now()
  return {
    chatId,
    chatKind,
    senderId: String(raw?.senderId ?? raw?.sender_id ?? raw?.from ?? "").trim(),
    senderName: String(raw?.senderName ?? raw?.sender_name ?? "").trim(),
    text: String(raw?.text ?? raw?.content ?? ""),
    timestamp,
    messageId: String(raw?.messageId ?? raw?.message_id ?? raw?.id ?? "").trim(),
    mentionedBot: raw?.mentionedBot === true || raw?.mentioned_bot === true || raw?.isAt === true,
    self: raw?.self === true,
  }
}
