/**
 * 会话 ID 与"从事件里取回复"这两件纯逻辑。
 *
 * 它们单独放在这里，是因为这是整条链路里最容易静默出错的一步：取错了，表现
 * 是"有时候不回消息"，而不是报错。放在不 import 宿主的文件里，`node --test`
 * 才能直接把每种事件形状摆出来。
 */

/** 本插件拥有的会话 ID 前缀，和其他插件的会话区分开。 */
export const SESSION_ID_PREFIX = "channel-wechat-bg-"

/**
 * 由一个微信会话 ID 推出 DSH 会话 ID。
 *
 * 只需要转义 `~`：真实微信 ID 是 `[A-Za-z0-9_.@-]`，`@chatroom` 里的 `@`
 * 是合法的，而 `SessionId` 是未校验的品牌字符串，JSONL 后端落盘前还会再编码
 * 一次，所以这里不需要更重的转义。转义 `~` 只是为了防止将来出现带 `~` 的 ID
 * 和别的会话撞名。
 *
 * @param {string} chatId - 微信会话 ID。
 * @returns {string} DSH 会话 ID。
 */
export function sessionIdFor(chatId) {
  return `${SESSION_ID_PREFIX}${String(chatId).replaceAll("~", "~7E")}`
}

/**
 * 从一条已提交的会话事件里取出模型的回话。
 *
 * 四条规矩都来自实战：
 *   - 只认 `assistant/message`，别的事件（工具调用、思考、标题）都不是回话。
 *   - `interrupted: true` 的那条是被打断的半截，发出去就是断句。
 *   - 带 `tool-call` 块的那条是模型在"说明我要干什么"，不是给用户的话。
 *   - 没有 `text` 块（只有图片、只有思考）时没有话可说，返回 undefined，
 *     让上层按"这轮没回复"处理，而不是发一条空白。
 *
 * @param {object} event - `session/event` 给的已提交事件。
 * @returns {string|undefined} 回话正文，没有回话时 undefined。
 */
export function extractAssistantText(event) {
  if (event?.type !== "assistant/message") return undefined
  const data = event.data ?? {}
  // 两种事件形状都认：早期的 data.content，和现在的 data.message.content
  // （data 里还带 turn/step/usage）。只认一种会让整条回复链静默失效。
  const msg = data.message ?? data
  if (data.interrupted === true || msg?.interrupted === true) return undefined
  const content = msg?.content
  if (!Array.isArray(content)) return undefined
  if (content.some((block) => block?.type === "tool-call")) return undefined
  const text = content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("")
  return text === "" ? undefined : text
}
