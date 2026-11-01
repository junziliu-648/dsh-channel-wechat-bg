/**
 * 消息流水线：从收到一条微信消息，到决定发不发、发什么。
 *
 * 这个模块不 import 任何 DSH 的东西：模型调用是从外面注入的一个 async 函数。
 * 于是整条规则链（白名单 → @ 判断 → 合并 → 节流 → 审计）可以在 `node --test`
 * 里用手写的假模型跑完，不需要真的起一个 agent。
 *
 * 每一处"不回复"的理由都会被记下来并计数。一个只会计数的通道，事后无法回答
 * "为什么这条没回"。
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { cleanReply } from "./clean.js"
import { createAudit } from "./audit.js"
import { ChatDebouncer } from "./debounce.js"
import { Deduper } from "./dedupe.js"
import { ReplyLimiter } from "./rate-limit.js"
import { assertSendCapability, normalizeInbound } from "./transport/base.js"
import { createPolicy } from "./policy.js"
import { PersonaStore, composeSystemPrompt } from "./personas.js"
import {
  extractRemember,
  memoryFile,
  noteExchange,
  notePerson,
  personFile,
  readMemory,
  readPerson,
  renderMemory,
  renderPerson,
} from "./chat-memory.js"

/** 默认的运行参数，和 config.example.yml 保持一致。 */
export const DEFAULT_RATE_LIMIT = Object.freeze({
  perChatSec: 6,
  maxPerMinute: 6,
  debounceMs: 1200,
  maxReplyChars: 300,
})

/**
 * 建一条流水线。
 *
 * @param {object} options - 依赖注入。
 * @param {object} options.config - 已经归一化的配置。
 * @param {object} options.transport - 传输适配器。
 * @param {(input: {chatId: string, entry: object, systemPrompt: string, text: string, messages: object[]}) => Promise<string|{text?: string}>} options.generate - 生成回复。
 * @param {object} [options.personas] - 人设仓库。
 * @param {object} [options.logger] - 日志器。
 * @param {() => number} [options.now] - 时钟。
 * @returns {object} 流水线控制对象。
 */
// ---- 表情包：把 [表情: 描述] 换成本地图片 ----
// 表情包图片目录来自配置 `memeDir`；留空就不发图，只把 [表情: xx] 标记摘掉。
const DEFAULT_MEME_ROOT = ""
const MEME_RE = /\[表情[:：]\s*([^\]]+)\]/g
let memeMapCache = null

function loadMemeMap() {
  if (memeMapCache) return memeMapCache
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    memeMapCache = JSON.parse(readFileSync(join(here, "meme-map.json"), "utf8"))
  } catch {
    memeMapCache = []
  }
  if (!Array.isArray(memeMapCache)) memeMapCache = []
  return memeMapCache
}

/**
 * 从正文里摘掉 [表情: xx] 标记，并按描述挑图。
 * @returns {{text: string, paths: string[]}}
 */
export function pickMemes(text, memeRoot = DEFAULT_MEME_ROOT) {
  const map = loadMemeMap()
  const paths = []
  const names = []
  const cleaned = String(text ?? "").replace(MEME_RE, (_, name) => {
    const n = String(name).trim()
    if (n) names.push(n)
    return ""
  })
  if (!names.length || !map.length) {
    return { text: cleaned.trim(), paths }
  }
  for (const name of names) {
    const needle = name.toLowerCase()
    const hit =
      map.find((m) => (m.caption || "").toLowerCase().includes(needle)) ||
      map.find((m) => (m.keywords || "").toLowerCase().includes(needle)) ||
      map.find((m) => (m.tag || "").toLowerCase() === needle)
    if (hit) {
      const root = String(memeRoot ?? "").trim().replace(/[\\/]+$/, "")
      if (root) paths.push(root + "\\" + String(hit.file).replace(/\//g, "\\"))
    }
  }
  return { text: cleaned.trim(), paths }
}

export function createPipeline({ config, transport, generate, personas, logger, now = () => Date.now() } = {}) {
  const log = logger ?? { info: console.log, warn: console.warn, error: console.error }
  const rateLimit = { ...DEFAULT_RATE_LIMIT, ...(config?.rateLimit ?? {}) }
  // 可替换：设置页改白名单时不用重建整条流水线（那张表里还有队列、节流窗口、缓冲）。
  let policy = createPolicy({ allow: config?.allow, denyUnknown: config?.denyUnknown })
  const deduper = new Deduper({ now })
  const limiter = new ReplyLimiter({
    perChatSec: rateLimit.perChatSec,
    maxPerMinute: rateLimit.maxPerMinute,
    now,
  })
  const debouncer = new ChatDebouncer({ debounceMs: rateLimit.debounceMs })
  const personaStore = personas ?? new PersonaStore({ dir: config?.personaDir, warn: (m) => log.warn(m) })
  const audit = createAudit({
    path: config?.audit?.path ?? "",
    logContent: config?.audit?.logContent === true,
    now,
  })

  /** @type {Map<string, Promise<void>>} 每个会话一条串行队列 */
  const queues = new Map()
  /** @type {(() => void) | undefined} */
  let unsubscribe
  let started = false

  const counters = {
    received: 0,
    replied: 0,
    sent: 0,
    failed: 0,
    dropped: Object.create(null),
  }

  /**
   * 记一次丢弃。
   * @param {string} reason - 原因码。
   */
  function countDrop(reason) {
    const key = String(reason)
    counters.dropped[key] = (counters.dropped[key] ?? 0) + 1
  }

  /**
   * 现在允许说话吗？总开关关掉之后，一条也不许再发。
   * @returns {boolean}
   */
  function canSend() {
    return config?.enabled === true && started
  }

  /**
   * 主动发一条：agent 自己想说话时（不是被收到的消息触发），会话日志里照样会
   * 落一条 `assistant/message`，但那一刻没有等待者。这里把那段文字接住，
   * 走和正常回复完全相同的清洗 + 出口，不另开一条发送路径。
   *
   * @param {string} chatId - 会话 ID。
   * @param {string} text - 模型说的话。
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async function publish(chatId, text) {
    const entry = policy.entries().find((item) => item.id === chatId)
    if (entry === undefined) {
      audit.record({ chatId, direction: "out", chars: 0, transport: transport.kind, result: "not-allowlisted" })
      return { ok: false, error: "not-allowlisted" }
    }
    const recalled = extractRemember(String(text ?? ""))
    if (recalled.text.trim() === "") {
      audit.record({ chatId, direction: "out", chars: 0, transport: transport.kind, result: "no-reply" })
      return { ok: false, error: "no-reply" }
    }
    const cleaned = cleanReply(recalled.text, {
      maxChars: rateLimit.maxReplyChars,
      ownNames: [entry.label, entry.persona, config?.botName ?? ""].filter((name) => String(name ?? "") !== ""),
    })
    if (cleaned === "") {
      audit.record({ chatId, direction: "out", chars: 0, transport: transport.kind, result: "empty-after-clean" })
      return { ok: false, error: "empty-after-clean" }
    }
    const result = await send(chatId, cleaned)
    if (result.ok === true) counters.replied += 1
    return result
  }

  /**
   * 发一条消息。这是唯一的出口，节流与总开关都拦在这里。
   *
   * @param {string} chatId - 会话 ID。
   * @param {string} text - 正文。
   * @returns {Promise<{ok: boolean, messageId?: string, error?: string, retryAfterMs?: number}>}
   */
  async function send(chatId, text) {
    if (config?.enabled !== true) {
      audit.record({ chatId, direction: "out", chars: text.length, transport: transport.kind, result: "disabled" })
      return { ok: false, error: "disabled" }
    }
    if (!policy.has(chatId)) {
      audit.record({ chatId, direction: "out", chars: text.length, transport: transport.kind, result: "not-allowlisted" })
      return { ok: false, error: "not-allowlisted" }
    }
    const permit = limiter.tryAcquire(chatId)
    if (!permit.ok) {
      audit.record({
        chatId,
        direction: "out",
        chars: text.length,
        transport: transport.kind,
        result: "throttled",
        reason: permit.reason,
      })
      return { ok: false, error: permit.reason, retryAfterMs: permit.retryAfterMs }
    }
    // 先把 [表情: xx] 摘出来：文字发一条，图再单独发
    let cleanText = String(text)
    let memePaths = []
    try {
      const picked = pickMemes(cleanText, config?.memeDir)
      cleanText = picked.text
      memePaths = picked.paths
    } catch {
      // 挑图失败就按原文发，不影响正常回复
    }

    let result
    if (cleanText.trim()) {
      try {
        result = await transport.sendText(chatId, cleanText)
      } catch (error) {
        result = { ok: false, error: String(error?.message ?? error) }
      }
    } else {
      result = { ok: true }
    }

    if (memePaths.length && typeof transport.sendFile === "function") {
      for (const p of memePaths) {
        try {
          await transport.sendFile(chatId, p)
        } catch (error) {
          audit.record({
            chatId,
            direction: "out",
            chars: 0,
            transport: transport.kind,
            result: "meme-send-error",
            error: String(error?.message ?? error).slice(0, 200),
          })
        }
      }
    }
    if (result?.ok === true) {
      limiter.commit(chatId)
      counters.sent += 1
      audit.record({ chatId, direction: "out", chars: text.length, transport: transport.kind, result: "ok", text })
    } else {
      counters.failed += 1
      audit.record({
        chatId,
        direction: "out",
        chars: text.length,
        transport: transport.kind,
        result: "error",
        error: result?.error ?? "未知错误",
        text,
      })
    }
    return result
  }

  /**
   * 处理一窗合并后的消息：生成、清理、发送。
   * @param {{chatId: string, messages: object[]}} batch - 合并后的一批。
   * @returns {Promise<void>}
   */
  async function runTurn(batch) {
    const { chatId, messages } = batch
    const entry = messages[0]?.entry
    if (entry === undefined) return
    // 群里好几个人说话，到模型眼里不能是一坨字：带上是"谁"说的。
    // 私聊只有对面一个人，加前缀反而像在念台词，所以保持原样。
    const inGroup = entry.kind === "group"
    const lines = []
    for (const message of messages) {
      const body = String(message.text ?? "").trim()
      if (body === "") continue
      if (!inGroup) {
        lines.push(body)
        continue
      }
      const who = String(message.senderName ?? "").trim() || String(message.senderId ?? "").trim() || "某人"
      lines.push(who + "：" + body)
    }
    const text = lines.join("\n").trim()
    if (text === "") return

    // 这一轮是谁在说话：记忆要记到人头上，别记成"群说的"。
    const lastSpeaker = [...messages].reverse().find((message) => String(message.senderId ?? "").trim() !== "")
    const speakerId = String(lastSpeaker?.senderId ?? "").trim()
    const speakerName = String(lastSpeaker?.senderName ?? "").trim()

    // 人设按场合取（群聊优先 <persona>-group.md），记忆按会话取（一 chat 一个文件）。
    const persona = personaStore.loadForEntry(entry)
    const memoryPath = memoryFile(config?.memoryDir, chatId)
    const personPath = personFile(config?.memoryDir, speakerId)
    // 两层一起注入：先"面前是谁"，再"这个会话里发生过什么"。
    const memory = [renderPerson(readPerson(personPath, speakerId)), renderMemory(readMemory(memoryPath))]
      .filter((block) => block !== "")
      .join("\n\n")
    const systemPrompt = composeSystemPrompt({
      persona,
      entry,
      botName: config?.botName ?? "",
      memory,
      stickerRate: config?.stickerRate,
    })

    let raw
    try {
      raw = await generate({ chatId, entry, systemPrompt, text, messages, speakerId, speakerName })
    } catch (error) {
      log.error(`生成回复失败（${entry.label}）：${error?.message ?? error}`)
      audit.record({
        chatId,
        direction: "out",
        chars: 0,
        transport: transport.kind,
        result: "generate-error",
        error: String(error?.message ?? error),
      })
      counters.failed += 1
      return
    }

    const rawReply = typeof raw === "string" ? raw : String(raw?.text ?? "")
    // `[记住: ...]` 是给记忆用的旁白，不属于要发出去的那句话。
    const recalled = extractRemember(rawReply)
    const replyText = recalled.text
    if (replyText.trim() === "") {
      audit.record({ chatId, direction: "out", chars: 0, transport: transport.kind, result: "no-reply" })
      countDrop("no-reply")
      return
    }

    // 名字与人设都从开头去掉：模型偶尔会用"工作助理："开场，微信里没有这个位置。
    const cleaned = cleanReply(replyText, {
      maxChars: rateLimit.maxReplyChars,
      ownNames: [entry.label, entry.persona, config?.botName ?? ""].filter((name) => String(name ?? "") !== ""),
    })
    if (cleaned === "") {
      audit.record({ chatId, direction: "out", chars: 0, transport: transport.kind, result: "empty-after-clean" })
      countDrop("empty-after-clean")
      return
    }

    const result = await send(chatId, cleaned)
    if (result.ok === true) {
      counters.replied += 1
      // 只有真发出去了才记：编辑阶段丢掉的回复不该进记忆，否则"我记得我说过"
      // 和对方的实际聊天记录会对不上。
      const said = lines.join(" / ").slice(0, 200)
      noteExchange({
        file: memoryPath,
        userText: said,
        userName: speakerName,
        replyText: cleaned,
        facts: recalled.facts,
      })
      // 事实也挂到说话人头上：群里定的约定，得知道是跟谁定的。
      if (personPath !== "") {
        notePerson({
          file: personPath,
          id: speakerId,
          name: speakerName,
          chatId,
          text: String(lastSpeaker?.text ?? said),
          facts: recalled.facts,
        })
      }
    }
  }

  /**
   * 把一次会话处理挂到该会话的串行队列上。
   *
   * 串行是必须的：同一个会话里两轮同时往一个 agent 里塞消息，回复会交错，
   * 而且两轮都会以为自己在回答最新那句。
   *
   * @param {{chatId: string, messages: object[]}} batch - 一批消息。
   */
  function enqueue(batch) {
    const chatId = batch.chatId
    const previous = queues.get(chatId) ?? Promise.resolve()
    const next = previous
      .then(() => runTurn(batch))
      .catch((error) => log.error(`处理 ${chatId} 的消息失败：${error?.message ?? error}`))
      .finally(() => {
        if (queues.get(chatId) === next) queues.delete(chatId)
      })
    queues.set(chatId, next)
  }

  /**
   * 收下一条入站消息，跑完整条规则链。
   *
   * @param {object} message - 传输层给的入站消息。
   * @returns {{action: 'queued'|'drop', reason?: string, chatId?: string}}
   */
  function accept(message) {
    const normalized = normalizeInbound(message)
    counters.received += 1

    if (config?.enabled !== true) {
      audit.record({
        chatId: normalized.chatId,
        direction: "in",
        chars: normalized.text.length,
        transport: transport.kind,
        result: "dropped",
        reason: "disabled",
        text: normalized.text,
      })
      countDrop("disabled")
      return { action: "drop", reason: "disabled", chatId: normalized.chatId }
    }
    if (normalized.chatId === "") {
      countDrop("empty")
      return { action: "drop", reason: "empty" }
    }

    const selfId = String(transport.selfId ?? "").trim()
    if (normalized.self === true || (selfId !== "" && normalized.senderId === selfId)) {
      audit.record({
        chatId: normalized.chatId,
        direction: "in",
        chars: normalized.text.length,
        transport: transport.kind,
        result: "dropped",
        reason: "self",
        text: normalized.text,
      })
      countDrop("self")
      return { action: "drop", reason: "self", chatId: normalized.chatId }
    }

    if (deduper.isDuplicate(normalized)) {
      audit.record({
        chatId: normalized.chatId,
        direction: "in",
        chars: normalized.text.length,
        transport: transport.kind,
        result: "dropped",
        reason: "duplicate",
        text: normalized.text,
      })
      countDrop("duplicate")
      return { action: "drop", reason: "duplicate", chatId: normalized.chatId }
    }

    const decision = policy.decide({
      chatId: normalized.chatId,
      chatKind: normalized.chatKind,
      senderId: normalized.senderId,
      selfId,
      text: normalized.text,
      mentionedBot: normalized.mentionedBot,
    })

    if (decision.action === "drop") {
      audit.record({
        chatId: normalized.chatId,
        direction: "in",
        chars: normalized.text.length,
        transport: transport.kind,
        result: "dropped",
        reason: decision.reason,
        text: normalized.text,
      })
      countDrop(decision.reason)
      return { action: "drop", reason: decision.reason, chatId: normalized.chatId }
    }

    audit.record({
      chatId: normalized.chatId,
      direction: "in",
      chars: normalized.text.length,
      transport: transport.kind,
      result: "accepted",
      text: normalized.text,
    })

    debouncer.push(
      normalized.chatId,
      { ...normalized, text: decision.text, entry: decision.entry },
      (batch) => enqueue(batch),
    )
    return { action: "queued", chatId: normalized.chatId }
  }

  /** 启动传输，并开始接收。 */
  async function start() {
    if (started) return
    // 前台发送不是默认行为：传输自称会抢前台时，必须是用户打开
    // `allowForegroundSend` 才放行。不满足就在这里失败，不会"先跑起来再说"。
    assertSendCapability(transport, { allowForegroundSend: config?.allowForegroundSend === true })
    await transport.start()
    started = true
    unsubscribe = transport.onMessage((message) => accept(message))
    log.info(
      `微信通道已启动（传输 ${transport.kind}` +
        `${transport.capabilities?.backgroundSend === true ? "，后台发送" : "，前台发送"}，` +
        `白名单 ${policy.ids().join("、")}）`,
    )
  }

  /** 停止接收，并立刻停止发送。 */
  async function stop() {
    started = false
    debouncer.dispose()
    unsubscribe?.()
    unsubscribe = undefined
    await transport.stop()
    queues.clear()
  }

  /** 状态接口。 */
  function status() {
    return {
      enabled: config?.enabled === true,
      started,
      transport: { kind: transport.kind, capabilities: transport.capabilities },
      allow: policy.entries(),
      denyUnknown: config?.denyUnknown !== false,
      rateLimit,
      limiter: limiter.snapshot(),
      pending: debouncer.pending(),
      counters: { ...counters, dropped: { ...counters.dropped } },
      auditPath: audit.path,
    }
  }

  /**
   * 换一份白名单，不动流水线的其它部件。
   *
   * 设置页勾选群聊走的就是这里：规则只换一张表，排队的消息、节流窗口、
   * 防抖缓冲都照旧 —— 重建流水线会把这些状态全丢掉。
   *
   * @param {{allow?: object[], denyUnknown?: boolean}} next - 新的白名单。
   * @returns {object} 新的 policy。
   */
  function reload(next = {}) {
    policy = createPolicy({
      allow: next.allow ?? config?.allow,
      denyUnknown: next.denyUnknown ?? config?.denyUnknown,
    })
    if (next.allow !== undefined) config.allow = next.allow
    // 表情档位是"说话方式"的一部分：存进 config，下一轮现算提示词时就生效，
    // 不用重启插件。
    if (next.stickerRate !== undefined) config.stickerRate = next.stickerRate
    log.info(`白名单已更新：${policy.ids().join("、") || "（空）"}`)
    return policy
  }

  return {
    accept,
    send,
    publish,
    start,
    stop,
    status,
    reload,
    get policy() {
      return policy
    },
    get started() {
      return started
    },
    counters,
  }
}
