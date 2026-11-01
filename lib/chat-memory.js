/**
 * 每个会话的"长期记忆"。
 *
 * 会话历史本来就分开（一个 chat 一个 DSH 会话），但那是**短期的、会随上下文压缩
 * 掉**的。这里存的是这个会话里值得一直记得的东西：聊过什么、对方是什么样的人、
 * 有哪些约定。一 chat 一个文件，互相看不见。
 *
 * 三条设计取舍：
 *   - **不用再调一次模型**。每轮多一次摘要调用的代价是翻倍的延迟和钱，而这里要的
 *     只是"记得住"，不是"写得漂亮"。所以：原始一轮留一行截断，模型想主动记就写
 *     `[记住: ...]`，那是明确的、可测的入口。
 *   - **没有写死的上限之外的东西**。facts 20 条、log 40 条，超出丢最旧的。记忆是
 *     引子，不是数据库；无界增长最后一定会撑爆 prompt。
 *   - **写坏不抛**。记忆是增强，不是主链路；文件坏了就当没记过，通道照常说话。
 */

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** 记忆文件格式版本。变了就在读的时候降级重建。 */
const VERSION = 1

/** 日志保留条数。一轮两条（对方一条、自己一条），所以约等于最近 20 轮。 */
export const MAX_LOG = 40

/** 永久事实保留条数。 */
export const MAX_FACTS = 20

/** 单条截断长度：一行能记住"聊了什么"，不需要原话。 */
export const MAX_ENTRY_CHARS = 120

/** 渲染进 prompt 的字符上限。 */
export const MAX_RENDER_CHARS = 1200

/**
 * 会话 id 到文件名的映射。
 *
 * 微信 id 里有 `@`、`_`、`-`，这些在 Windows 文件名里都合法，但为了不让
 * 路径分隔符之类的字符混进来，非白名单字符一律换成下划线；再拼一段短哈希，
 * 避免"两个 id 收拾完长一样"导致串记忆。
 *
 * @param {string} chatId - 会话 id。
 * @returns {string} 文件名（不含目录）。
 */
export function memoryFileName(chatId) {
  const id = String(chatId ?? "").trim()
  const safe = id.replace(/[^A-Za-z0-9@._-]/g, "_").slice(0, 80)
  const digest = createHash("sha1").update(id).digest("hex").slice(0, 8)
  return `${safe === "" ? "chat" : safe}-${digest}.json`
}

/**
 * 某个会话的记忆文件路径。
 *
 * @param {string} dir - 记忆目录（配置里的 `memoryDir`）。
 * @param {string} chatId - 会话 id。
 * @returns {string} 路径；目录没配时为空串。
 */
export function memoryFile(dir, chatId) {
  const root = String(dir ?? "").trim()
  if (root === "") return ""
  return join(root, memoryFileName(chatId))
}

/**
 * 一条空记忆。
 * @returns {{version: number, facts: string[], log: Array<{at: number, who: string, text: string}>}} 记忆。
 */
export function emptyMemory() {
  return { version: VERSION, facts: [], log: [] }
}

/**
 * 读一个记忆文件。
 *
 * @param {string} file - 路径。
 * @returns {{version: number, facts: string[], log: Array<object>}} 记忆；读不到就是空的。
 */
export function readMemory(file) {
  if (String(file ?? "") === "") return emptyMemory()
  let raw
  try {
    raw = readFileSync(file, "utf8")
  } catch {
    return emptyMemory()
  }
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    return emptyMemory()
  }
  const facts = []
  for (const fact of Array.isArray(data?.facts) ? data.facts : []) {
    const text = String(fact ?? "").trim().slice(0, MAX_ENTRY_CHARS)
    if (text !== "") facts.push(text)
  }
  const log = []
  for (const row of Array.isArray(data?.log) ? data.log : []) {
    const text = String(row?.text ?? "").trim().slice(0, MAX_ENTRY_CHARS)
    if (text === "") continue
    const name = String(row?.name ?? "").trim().slice(0, 40)
    log.push({
      at: Number.isFinite(row?.at) ? Number(row.at) : 0,
      who: row?.who === "me" ? "me" : "them",
      text,
      ...(name === "" ? {} : { name }),
    })
  }
  return { version: VERSION, facts: facts.slice(-MAX_FACTS), log: log.slice(-MAX_LOG) }
}

/**
 * 写记忆。先写临时文件再改名，避免写一半断电留下半截 JSON。
 *
 * @param {string} file - 路径。
 * @param {object} mem - 记忆。
 * @returns {boolean} 是否写成功。
 */
export function writeMemory(file, mem) {
  if (String(file ?? "") === "") return false
  try {
    const dir = join(file, "..")
    mkdirSync(dir, { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, `${JSON.stringify(mem, null, 2)}\n`, "utf8")
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

/**
 * 从回复里抽出"要求记住"的标记。
 *
 * 模型可以写 `[记住: 对方叫小王，做前端]`，这条会被存进 facts，并且从回复里删掉
 * —— 微信里不该出现这个括号。
 *
 * @param {string} reply - 回复原文。
 * @returns {{text: string, facts: string[]}} 去掉标记的回复，以及要记的事实。
 */
export function extractRemember(reply) {
  const facts = []
  const text = String(reply ?? "")
    .replace(/[\[［]\s*记住\s*[:：]\s*([^\]］]+)[\]］]/g, (_all, inner) => {
      const fact = String(inner ?? "").trim().slice(0, MAX_ENTRY_CHARS)
      if (fact !== "") facts.push(fact)
      return ""
    })
    .replace(/[ \t]+\n/g, "\n")
    .trim()
  return { text, facts: facts.slice(0, MAX_FACTS) }
}

/**
 * 记一轮对话。
 *
 * @param {object} options - 参数。
 * @param {string} options.file - 记忆文件。
 * @param {string} options.userText - 对方说的话。
 * @param {string} options.replyText - 自己说的话（已经去掉记住标记）。
 * @param {string[]} [options.facts] - 这一轮新记下的事实。
 * @param {string} [options.userName] - 说话人名字（群聊里要知道是谁）。
 * @param {number} [options.now] - 时间戳。
 * @returns {object} 写回后的记忆。
 */
export function noteExchange({ file, userText, replyText, facts = [], userName = "", now = Date.now() } = {}) {
  const mem = readMemory(file)
  const speaker = String(userName ?? "").trim().slice(0, 40)
  const push = (who, text) => {
    const line = String(text ?? "").trim().replace(/\s+/g, " ")
    if (line === "") return
    const row = { at: now, who, text: line.slice(0, MAX_ENTRY_CHARS) }
    // 群里要留名字：以后回看这段记忆，得知道那句是谁说的。
    if (who === "them" && speaker !== "") row.name = speaker
    mem.log.push(row)
  }
  push("them", userText)
  push("me", replyText)
  mem.log = mem.log.slice(-MAX_LOG)

  for (const fact of Array.isArray(facts) ? facts : []) {
    const text = String(fact ?? "").trim().slice(0, MAX_ENTRY_CHARS)
    if (text === "" || mem.facts.includes(text)) continue
    mem.facts.push(text)
  }
  mem.facts = mem.facts.slice(-MAX_FACTS)

  writeMemory(file, mem)
  return mem
}

/**
 * 把记忆渲染成 prompt 里的一段。
 *
 * 没有记忆时返回空串 —— 空段落会让模型以为自己"应该记得点什么"，反而更糟。
 *
 * @param {object} mem - 记忆。
 * @returns {string} 提示词片段。
 */
export function renderMemory(mem) {
  const facts = Array.isArray(mem?.facts) ? mem.facts : []
  const log = Array.isArray(mem?.log) ? mem.log : []
  if (facts.length === 0 && log.length === 0) return ""

  const lines = []
  lines.push("# 你记得的事")
  lines.push("这是这个会话里你自己记下来的东西，接着聊，不用重新认识。")
  if (facts.length > 0) {
    lines.push("")
    lines.push("确定的事实：")
    for (const fact of facts) lines.push(`- ${fact}`)
  }
  if (log.length > 0) {
    lines.push("")
    lines.push("最近聊过（旧→新）：")
    for (const row of log) {
      const who = row.who === "me" ? "我" : String(row.name ?? "").trim() || "对方"
      lines.push(`- ${who}：${row.text}`)
    }
  }
  const text = lines.join("\n")
  return text.length <= MAX_RENDER_CHARS ? text : `${text.slice(0, MAX_RENDER_CHARS)}…`
}

/* ------------------------------------------------------------------ *
 * 认识人
 *
 * 会话记忆回答"这个会话里发生过什么"；这里回答"面前这个人是谁"。
 * 同一个人在私聊和群里，应该是同一个人，所以按 senderId 存、跨会话共享。
 * ------------------------------------------------------------------ */

/** 每个人的画像保留多少条"聊过的事"。 */
export const MAX_PERSON_LOG = 20

/** 一个人的画像最多留几条事实。 */
export const MAX_PERSON_FACTS = 12

/**
 * 某个人的画像文件。
 *
 * @param {string} dir - 记忆目录（`memoryDir`）。
 * @param {string} senderId - 微信 id。
 * @returns {string} 路径；目录没配时为空串。
 */
export function personFile(dir, senderId) {
  const root = String(dir ?? "").trim()
  const id = String(senderId ?? "").trim()
  if (root === "" || id === "") return ""
  return join(root, "people", memoryFileName(id))
}

/**
 * 读一个人的画像。坏文件当没记过。
 *
 * @param {string} file - 路径。
 * @param {string} [senderId] - 微信 id（文件里没写时补上）。
 * @returns {{version: number, id: string, name: string, facts: string[], log: Array<object>}} 画像。
 */
export function readPerson(file, senderId = "") {
  const empty = { version: VERSION, id: String(senderId ?? ""), name: "", facts: [], log: [] }
  if (String(file ?? "") === "") return empty
  let data
  try {
    data = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return empty
  }
  const facts = (Array.isArray(data?.facts) ? data.facts : [])
    .map((fact) => String(fact ?? "").trim().slice(0, MAX_ENTRY_CHARS))
    .filter((fact) => fact !== "")
  const log = []
  for (const row of Array.isArray(data?.log) ? data.log : []) {
    const text = String(row?.text ?? "").trim().slice(0, MAX_ENTRY_CHARS)
    if (text === "") continue
    log.push({
      at: Number.isFinite(row?.at) ? Number(row.at) : 0,
      chatId: String(row?.chatId ?? ""),
      text,
    })
  }
  return {
    version: VERSION,
    id: String(data?.id ?? senderId ?? ""),
    name: String(data?.name ?? "").trim().slice(0, 40),
    facts: facts.slice(-MAX_PERSON_FACTS),
    log: log.slice(-MAX_PERSON_LOG),
  }
}

/**
 * 写一个人的画像。
 *
 * @param {string} file - 路径。
 * @param {object} person - 画像。
 * @returns {boolean} 是否写成功。
 */
export function writePerson(file, person) {
  return writeMemory(file, person)
}

/**
 * 记一个人的一条发言，顺便更新名字和事实。
 *
 * @param {object} options - 参数。
 * @param {string} options.file - 画像文件。
 * @param {string} [options.name] - 这个人当前的名字。
 * @param {string} [options.chatId] - 在哪说的。
 * @param {string} [options.text] - 说了什么。
 * @param {string[]} [options.facts] - 关于他的新事实。
 * @param {number} [options.now] - 时间戳。
 * @returns {object} 写回后的画像。
 */
export function notePerson({ file, id = "", name = "", chatId = "", text = "", facts = [], now = Date.now() } = {}) {
  const person = readPerson(file, id)
  // 文件里第一次写的时候把 id 落下来，之后就是纯读取。
  if (String(person.id ?? "") === "" && String(id ?? "") !== "") person.id = String(id)
  const display = String(name ?? "").trim().slice(0, 40)
  // 名字会改：改名了就跟着改，别一直叫旧名字。
  if (display !== "") person.name = display

  const line = String(text ?? "").trim().replace(/\s+/g, " ")
  if (line !== "") {
    person.log.push({ at: now, chatId: String(chatId ?? ""), text: line.slice(0, MAX_ENTRY_CHARS) })
    person.log = person.log.slice(-MAX_PERSON_LOG)
  }
  for (const fact of Array.isArray(facts) ? facts : []) {
    const one = String(fact ?? "").trim().slice(0, MAX_ENTRY_CHARS)
    if (one === "" || person.facts.includes(one)) continue
    person.facts.push(one)
  }
  person.facts = person.facts.slice(-MAX_PERSON_FACTS)

  writePerson(file, person)
  return person
}

/**
 * 把一个人的画像渲染成 prompt 里的一段。
 *
 * @param {object} person - 画像。
 * @returns {string} 提示词片段；没内容时返回空串。
 */
export function renderPerson(person) {
  const name = String(person?.name ?? "").trim()
  const facts = Array.isArray(person?.facts) ? person.facts : []
  const log = Array.isArray(person?.log) ? person.log : []
  if (name === "" && facts.length === 0 && log.length === 0) return ""

  const lines = ["# 你认识的这个人"]
  if (name !== "") lines.push(`现在跟你说话的是「${name}」。`)
  if (facts.length > 0) {
    lines.push("")
    lines.push("你知道的：")
    for (const fact of facts) lines.push(`- ${fact}`)
  }
  if (log.length > 0) {
    lines.push("")
    lines.push("他最近说过的（旧→新）：")
    for (const row of log) lines.push(`- ${row.text}`)
  }
  const text = lines.join("\n")
  return text.length <= MAX_RENDER_CHARS ? text : `${text.slice(0, MAX_RENDER_CHARS)}…`
}
