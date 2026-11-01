/**
 * 白名单与准入判断。
 *
 * 这个模块刻意不 import 任何东西：它是"谁能跟它说话"的唯一一份规则，所以
 * 它必须能被 `node --test` 直接跑、被别的模块单独复用，而不需要先起一个
 * DSH 进程。档位判断失败的方向也只有一个 —— 拒绝。
 *
 * 稳定的会话 ID 是硬编码的常量，不是配置里的默认值字符串。用户改配置时
 * 改的是"要不要回"，不是"回给谁"：`label` 只用来打日志，`id` 才是身份。
 */

/** 小明。私聊，一直回。 */
export const DM_JUNZILIU = "wxid_example_dm"

/** 测试群。只在被 @ 或命中触发词时回。 */
export const GROUP_TEST = "12345678901@chatroom"

/**
 * 默认白名单。
 *
 * `kind` 不写在这里由调用方猜：私聊 ID 和群 ID 长得不一样，但一段被冒名顶替
 * 的消息可以声称自己来自群。`kind` 参与校验，就是为了让这种声称对不上白名单。
 */
export const DEFAULT_ALLOW = Object.freeze([
  Object.freeze({
    id: DM_JUNZILIU,
    kind: "dm",
    label: "小明",
    persona: "大肥鱼",
    reply: "always",
    triggers: Object.freeze([]),
    enabled: true,
  }),
  Object.freeze({
    id: GROUP_TEST,
    kind: "group",
    label: "测试",
    persona: "工作助理",
    reply: "mention",
    triggers: Object.freeze(["@大肥鱼"]),
    enabled: true,
  }),
])

/** 一条消息被判定为哪种结果时，会带上的原因码。日志和审计都用它。 */
export const DROP_REASONS = Object.freeze({
  DISABLED: "disabled",
  SELF: "self",
  EMPTY: "empty",
  NOT_ALLOWED: "not-allowlisted",
  ENTRY_DISABLED: "entry-disabled",
  KIND_MISMATCH: "kind-mismatch",
  NO_MENTION: "no-mention",
  MENTION_ONLY: "mention-only",
  DUPLICATE: "duplicate",
})

/** 只有这两个值有意义。写错的值在归一化时抛错，而不是被静默当成 always。 */
const REPLY_MODES = new Set(["always", "mention"])
const CHAT_KINDS = new Set(["dm", "group"])

/**
 * 把一条配置项补全成判断逻辑需要的形状。
 * @param {object} entry - 配置里的白名单项。
 * @returns {{id: string, kind: string, label: string, persona: string, reply: string, triggers: string[], enabled: boolean}}
 * @throws 当 id 为空、kind 或 reply 不认识时。
 */
function normalizeEntry(entry) {
  const id = String(entry?.id ?? "").trim()
  if (id === "") throw new Error("channel-wechat-bg: 白名单项缺少 id")
  const kind = String(entry?.kind ?? "").trim()
  if (!CHAT_KINDS.has(kind)) {
    throw new Error(`channel-wechat-bg: ${id} 的 kind 只能是 dm 或 group，收到 ${JSON.stringify(entry?.kind)}`)
  }
  const reply = String(entry?.reply ?? "always").trim()
  if (!REPLY_MODES.has(reply)) {
    throw new Error(`channel-wechat-bg: ${id} 的 reply 只能是 always 或 mention，收到 ${JSON.stringify(entry?.reply)}`)
  }
  const triggers = Array.isArray(entry?.triggers) ? entry.triggers.map((t) => String(t)).filter((t) => t !== "") : []
  const persona = String(entry?.persona ?? "").trim()
  return {
    id,
    kind,
    label: String(entry?.label ?? "").trim() || id,
    persona,
    reply,
    triggers,
    enabled: entry?.enabled !== false,
  }
}

/**
 * 建一个白名单判断器。
 * @param {object} options - 白名单与未知会话策略。
 * @param {object[]} [options.allow] - 白名单项；默认是那两个会话。
 * @param {boolean} [options.denyUnknown] - 必须为 true。这里不提供"放行未知会话"
 *   的实现，因为放行之后没有第二份规则能说出该用哪个人设、哪种 @ 条件 —— 那种
 *   配置只会变成"谁都能让它说话"。
 * @returns {{decide: (input: object) => object, entries: () => object[], has: (chatId: string) => boolean, ids: () => string[]}}
 * @throws 当 denyUnknown 不是 true 时。
 */
export function createPolicy({ allow = DEFAULT_ALLOW, denyUnknown = true } = {}) {
  if (denyUnknown !== true) {
    throw new Error("channel-wechat-bg: denyUnknown 必须为 true；本插件不支持放行未知会话")
  }
  const entries = (Array.isArray(allow) ? allow : []).map(normalizeEntry)
  const byId = new Map(entries.map((entry) => [entry.id, entry]))

  /**
   * 判断一条入站消息该不该回。
   *
   * 顺序是有意的：先排除"自己"和空消息（它们连白名单都不用查），再查白名单，
   * 再查这条白名单项自己的开关，最后才是群里的 @ 条件。任何一步失败都返回
   * `action: 'drop'`，调用方没有"先回了再说"的分支。
   *
   * @param {object} input - 归一化后的入站消息。
   * @param {string} input.chatId - 会话的稳定 ID。
   * @param {string} [input.chatKind] - 适配器声称的会话类型。
   * @param {string} [input.senderId] - 发送者 ID。
   * @param {string} [input.selfId] - 本账号 ID；自己发的消息一律丢。
   * @param {string} [input.text] - 正文。
   * @param {boolean} [input.mentionedBot] - 适配器是否识别出"@ 了本号"。
   * @returns {{action: 'reply'|'drop', reason?: string, entry?: object, text: string}}
   */
  function decide(input) {
    const chatId = String(input?.chatId ?? "").trim()
    const text = String(input?.text ?? "")
    const selfId = String(input?.selfId ?? "").trim()

    if (selfId !== "" && String(input?.senderId ?? "").trim() === selfId) {
      return { action: "drop", reason: DROP_REASONS.SELF, text }
    }
    if (text.trim() === "") return { action: "drop", reason: DROP_REASONS.EMPTY, text }

    const entry = byId.get(chatId)
    if (entry === undefined) {
      if (denyUnknown) return { action: "drop", reason: DROP_REASONS.NOT_ALLOWED, text }
      return { action: "drop", reason: DROP_REASONS.NOT_ALLOWED, text }
    }
    if (!entry.enabled) return { action: "drop", reason: DROP_REASONS.ENTRY_DISABLED, text }

    const claimedKind = String(input?.chatKind ?? "").trim()
    if (claimedKind !== "" && claimedKind !== entry.kind) {
      return { action: "drop", reason: DROP_REASONS.KIND_MISMATCH, text }
    }

    if (entry.reply === "mention") {
      const mentioned = input?.mentionedBot === true || entry.triggers.some((trigger) => text.includes(trigger))
      if (!mentioned) return { action: "drop", reason: DROP_REASONS.NO_MENTION, text }
      const stripped = stripTriggers(text, entry.triggers)
      if (stripped === "") return { action: "drop", reason: DROP_REASONS.MENTION_ONLY, text }
      return { action: "reply", entry, text: stripped }
    }
    return { action: "reply", entry, text }
  }

  return {
    decide,
    entries: () => entries.map((entry) => ({ ...entry, triggers: [...entry.triggers] })),
    has: (chatId) => byId.has(String(chatId).trim()),
    ids: () => entries.map((entry) => entry.id),
  }
}

/**
 * 去掉正文里的 @ 触发词。
 *
 * 群里的 "@大肥鱼 今天跑步了吗" 要作为 "今天跑步了吗" 进模型：把触发词一起
 * 送进去，模型会当成"有人叫我的名字"然后开始自我介绍。
 *
 * @param {string} text - 原文。
 * @param {readonly string[]} triggers - 触发词。
 * @returns {string} 去掉触发词并压缩空白后的正文。
 */
export function stripTriggers(text, triggers) {
  let out = String(text)
  for (const trigger of triggers) {
    if (trigger === "") continue
    out = out.split(trigger).join(" ")
  }
  return out.replace(/[ \t\u3000]+/g, " ").replace(/^[\s:：,，]+/, "").trim()
}
