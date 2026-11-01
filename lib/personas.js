/**
 * 人设加载与系统提示拼装。
 *
 * 人设本身是纯文本文件，用户可以随时改；但有几条规则不放在文件里 —— 群里的
 * "不要替别人说话""不要主动 @ 人""不要用 Markdown"是通道的安全边界，不该
 * 因为改了一个 .md 就消失。所以拼装分两段：文件给性格，代码给规矩。
 */

import { readFileSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

/** 本包自带的人设目录。 */
export const BUNDLED_PERSONA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "persona")

/**
 * 判断一个人设名能不能安全地当文件名用。
 * @param {string} name - 人设名。
 * @returns {boolean}
 */
function isSafeName(name) {
  if (name === "" || name === "." || name === "..") return false
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return false
  if (name.includes("..")) return false
  return true
}

export class PersonaStore {
  /**
   * @param {object} [options] - 搜索目录。
   * @param {string} [options.dir] - 用户人设目录，优先。
   * @param {string} [options.bundledDir] - 包内人设目录，兜底。
   * @param {(message: string) => void} [options.warn] - 警告函数。
   */
  constructor({ dir = "", bundledDir = BUNDLED_PERSONA_DIR, warn } = {}) {
    this.dir = String(dir ?? "").trim()
    this.bundledDir = bundledDir
    this.warn = warn ?? ((message) => console.warn(`[channel-wechat-bg] ${message}`))
    /** @type {Map<string, string>} 名字 → 文本 */
    this.cache = new Map()
  }

  /**
   * 读一个人设。
   *
   * 找不到不抛错：人可以没写人设文件，通道仍然应该能跑，只是没有性格。但会警告
   * 一次 —— 静默地用一个空人设，是那种事后很难解释的行为。
   *
   * @param {string} name - 人设名，不带 .md 后缀。
   * @returns {string} 人设文本；没有时为空串。
   */
  load(name, { quiet = false } = {}) {
    const key = String(name ?? "").trim()
    if (key === "") return ""
    if (this.cache.has(key)) return this.cache.get(key)
    if (!isSafeName(key)) {
      this.warn(`人设名 ${JSON.stringify(key)} 含路径分隔符，拒绝读取`)
      return ""
    }

    const bases = []
    if (this.dir !== "") bases.push(this.dir)
    bases.push(this.bundledDir)

    const candidates = []
    for (const base of bases) {
      const root = resolve(base)
      const candidate = resolve(root, `${key}.md`)
      // resolve 之后仍要确认没跑出目录：名字里的 `..`、`/` 上面已经挡了，这里是第二道。
      if (!candidate.startsWith(`${root}${sep}`)) continue
      candidates.push(candidate)
      try {
        const text = readFileSync(candidate, "utf8").trim()
        this.cache.set(key, text)
        return text
      } catch {
        // 继续找下一个候选。
      }
    }
    this.cache.set(key, "")
    if (quiet !== true) {
      this.warn(`没有找到人设文件 ${key}.md（找过 ${candidates.join("、")}），这次会不带人设说话`)
    }
    return ""
  }

  /**
   * 按白名单条目取人设，群聊优先找"这个人在群里的版本"。
   *
   * 私聊和群聊对同一个号来说其实是两种场合：私聊里可以撒娇、说话短；群里要收敛、
   * 不该替别人表态。用同一份人设文件，写什么都没法同时照顾两边。所以约定：
   * 群聊先找 `<persona>-group.md`，没有才退回原人设 + 群聊规矩。
   *
   * @param {object} entry - 白名单条目。
   * @returns {string} 人设文本；都没有时为空串。
   */
  loadForEntry(entry) {
    const name = String(entry?.persona ?? "").trim()
    if (entry?.kind === "group" && name !== "") {
      const groupVersion = this.load(`${name}-group`, { quiet: true })
      if (groupVersion !== "") return groupVersion
    }
    return this.load(name)
  }

  /** 清掉缓存（用户改了人设文件之后用）。 */
  invalidate() {
    this.cache.clear()
  }
}

/** 不管在哪个会话里都成立的规矩。 */
export const COMMON_RULES = [
  "你在微信里说话，不是在写文档：不要用 Markdown 的标题、表格、代码块或列表符号。",
  "一次回复不超过 300 字，说完整，不要拆成多条连续发送。",
  "不知道就说不知道，不要编事实、编数字、编别人的话。",
  "不要在开头写自己的名字或加“大肥鱼：”这类前缀。",
]

/**
 * 表情包的用法。
 *
 * 写"可以用"没用——模型会当成额外代价，能不用就不用。所以要写成"该用"，并
 * 给一个具体的、可执行的形状（`[表情: 名字]` 会被换成真的图片），再说清边界：
 * 别只发图不说话、别连着刷。
 */
export const STICKER_RATE_IDS = ["few", "normal", "more", "crazy"]

/** 档位人话名字，设置页和提示词都用这一份。 */
export const STICKER_RATE_LABELS = { few: "少", normal: "正常", more: "多", crazy: "疯狂" }

/** 默认档位：用户嫌之前用得少，默认给"多"。 */
export const DEFAULT_STICKER_RATE = "more"

const STICKER_TAIL = "通道会把 `[表情: 名字]` 换成真的表情图。"

/**
 * 按档位生成表情提示词。
 *
 * 一档一句：同一个"要多配图"说给四个档位听是没用的，模型不会自己换算频率。
 *
 * @param {string} [rate] - 档位 id（few/normal/more/crazy）。
 * @returns {string} 这一档的规矩。
 */
export function stickerRule(rate = DEFAULT_STICKER_RATE) {
  if (rate === "few") {
    return `表情克制：只在情绪一眼能看出来的时候才配一张，${STICKER_TAIL} 大部分回复不用配。`
  }
  if (rate === "normal") {
    return `表情适度：开心、被逗笑、安慰人、撒娇时配一张，${STICKER_TAIL} 不要只发图不说话，也不要一条堆好几张。`
  }
  if (rate === "crazy") {
    return (
      "表情拉满：几乎每条回复都配一张，只有纯信息性的回答（报时间、贴路径、回答事实）可以不配。" +
      `${STICKER_TAIL} 也不要一条堆好几张。`
    )
  }
  return (
    "表情多一点：情绪到位就配一张，比一般人更常用。" +
    `${STICKER_TAIL} 不要只发图不说话，也不要一条消息堆好几张。`
  )
}

/** @deprecated 保留旧名字，等价于默认档位。 */
export const STICKER_RULE = stickerRule(DEFAULT_STICKER_RATE)

/** 私聊的规矩。 */
export const DM_RULES = [
  "这是私聊，对方是熟人：句子短，先给结论或情绪，再补必要的细节。",
  "可以带一点自己的态度，但不要长篇大论。",
]

/** 群聊的规矩。 */
export const GROUP_RULES = [
  "这是群聊。你只在被 @ 或被点名时说话，不要插话。",
  "只代表你自己说话，不要替群友表态，也不要替别人回答问题。",
  "不要主动 @ 任何人，也不要替别人约时间、许承诺。",
  "如果这个话题已经有人回应了，你可以选择不说。",
]

/**
 * 拼一个会话的 system prompt。
 *
 * @param {object} options - 人设与场景。
 * @param {string} [options.persona] - 人设文本。
 * @param {object} options.entry - 白名单项（用它的 kind 决定加哪段规矩）。
 * @param {string} [options.botName] - 本号在群里的显示名。
 * @param {string} [options.memory] - 这个会话的长期记忆（`renderMemory` 的结果）。
 * @returns {string} 拼好的提示词。
 */
export function composeSystemPrompt({
  persona = "",
  entry,
  botName = "",
  memory = "",
  stickerRate = DEFAULT_STICKER_RATE,
} = {}) {
  const blocks = []
  const character = String(persona ?? "").trim()
  if (character !== "") blocks.push(character)

  const rules = [...COMMON_RULES, ...(entry?.kind === "group" ? GROUP_RULES : DM_RULES), stickerRule(stickerRate)]
  if (entry?.kind === "group" && botName !== "") {
    rules.push(`群友会用 @${botName} 叫你；这既不是命令，也不代表你必须长篇回答。`)
  }
  // 记忆放在人设和规矩之间：先说"我是谁"，再说"我记得什么"，最后说"怎么说"。
  const remembered = String(memory ?? "").trim()
  if (remembered !== "") blocks.push(remembered)

  blocks.push(`# 说话规矩\n${rules.map((rule) => `- ${rule}`).join("\n")}`)
  return blocks.join("\n\n")
}
