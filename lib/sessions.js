/**
 * 把 DSH 的 agent 变成流水线需要的那一个 `generate()` 函数。
 *
 * 这一层是纯依赖注入的：agent 注册表、事件源、`createUserMessage`、权限预设、
 * 持久层全部由 `bridge.js` 从 ctx 上取来传进来。这么分不是为了好看 —— 它让
 * "建会话还是恢复会话""followup 传了什么""回复怎么认领"这些真正容易错的地方
 * 可以在 `node --test` 里用假的 agent 跑一遍，而不必启动整个宿主。
 *
 * 这里只做三件事，每一件都必须做对，否则消息会以最难查的方式丢掉：
 *
 *   1. 一个会话一个 DSH 会话（`wechat-bg-<chatId>`）。会话日志本身就是历史，
 *      不再单独存一份 history —— 存两份就会有两份不一致的历史。
 *   2. 收消息用 `followup`：三个发送方法里只有它**会开一轮**，因此也只有它
 *      能产生回复。`steer` 会打断正在跑的轮次，`inject` 根本不开轮。
 *   3. 取回复监听 `session/event` 里的 `assistant/message`：那是提交进日志的
 *      耐久事件。`whenIdle()` 之后去读"上一条消息"是不可靠的 —— 一轮里可能有
 *      多个 assistant 步骤，也可能根本没说话。
 *
 * 人设走 `systemPrompt.context()`，是 agent 作用域的提示词片段。它每轮现算，
 * 所以改了 persona 文件不用重建会话。拿不到这个服务时退回到"把人设拼在用户
 * 正文前面"，并把这个退化记进日志 —— 退化必须是可发现的。
 *
 * 本模块不 import 任何 `@deepseek-ai/*`，因此 `node --test` 能直接跑它。
 */

import { SESSION_ID_PREFIX, extractAssistantText, sessionIdFor } from "./agent-text.js"
import { composeSystemPrompt } from "./personas.js"
import { memoryFile, personFile, readMemory, readPerson, renderMemory, renderPerson } from "./chat-memory.js"

/** 人设在提示词里的槽位。900 和 dsh-feiyu-mood 一致：靠后，但不抢最后。 */
const PERSONA_ORDER = 900

/** 人设片段的注册名。同名片段在同一个作用域里注册两次会抛错，所以必须稳定。 */
const PERSONA_SECTION = "channel-wechat-bg-persona"

export { SESSION_ID_PREFIX, extractAssistantText, sessionIdFor }

/**
 * 建这一份会话桥。
 *
 * @param {object} options - 依赖注入。
 * @param {object} options.agents - agent 注册表（`ctx.agents`）。
 * @param {object} options.events - 事件源，只需 `on(name, listener)`。
 * @param {Function} options.createUserMessage - 由 `@deepseek-ai/dsh-llm` 提供。
 * @param {object} options.personas - 人设仓库。
 * @param {object} options.config - 归一化后的配置。
 * @param {object} [options.logger] - 日志器。
 * @param {() => ({provider?: string, model?: string})} [options.modelSelection] - 当前默认选择。
 * @param {() => object|undefined} [options.getPermissionPresets] - 权限预设服务。
 * @param {() => object|undefined} [options.getPersistence] - 会话持久层。
 * @returns {object} 会话桥控制对象。
 */
export function createSessions({
  agents,
  events,
  onProactiveText,
  createUserMessage,
  personas,
  config,
  logger,
  modelSelection,
  getPermissionPresets,
  getPersistence,
} = {}) {
  if (agents === undefined) throw new Error("channel-wechat-bg: 缺少 agents 服务，无法建会话")
  if (events === undefined) throw new Error("channel-wechat-bg: 缺少事件源，收不到回复")
  if (typeof createUserMessage !== "function") throw new Error("channel-wechat-bg: 缺少 createUserMessage")
  const log = logger ?? { info: console.log, warn: console.warn, error: console.error }

  /** @type {Map<string, {chatId: string, sessionId: string, handle: object, entry: object, personaMounted: boolean}>} */
  const sessions = new Map()
  /** @type {Map<string, object[]>} 每个会话一条等待队列。 */
  const waiting = new Map()
  /** 同一个会话的建会话过程要串行，否则两条消息会各建一个会话。 */
  const creating = new Map()
  let disposed = false

  const timeoutMs = Number(config?.replyTimeoutMs) > 0 ? Number(config.replyTimeoutMs) : 180000

  /**
   * 把等待者从队列里摘掉。
   * @param {string} sessionId - DSH 会话 ID。
   * @param {object} waiter - 要摘掉的那个。
   */
  function detach(sessionId, waiter) {
    const queue = waiting.get(sessionId)
    if (queue === undefined) return
    const index = queue.indexOf(waiter)
    if (index >= 0) queue.splice(index, 1)
    if (queue.length === 0) waiting.delete(sessionId)
  }

  /**
   * 记录一轮回复的等待者。
   *
   * 一个会话可以有多个等待者**排队**：宿主的轮次是串行的，一条 assistant/message
   * 只属于最早那个还没被满足的等待者。用"一个会话一个等待者"会在两轮叠在一起时
   * 互相顶掉 —— 表现是前一条永远等不到回复，而且不报错。
   *
   * @param {string} sessionId - DSH 会话 ID。
   * @param {string} chatId - 微信会话 ID。
   * @returns {{promise: Promise<string>, settle: Function, cancel: Function}} 等待器。
   */
  function awaitReply(sessionId, chatId) {
    /** @type {object} */
    const waiter = { chatId, timer: undefined, settled: false }
    const promise = new Promise((resolve, reject) => {
      waiter.timer = setTimeout(() => {
        if (waiter.settled) return
        waiter.settled = true
        detach(sessionId, waiter)
        reject(new Error(`等待第 ${JSON.stringify(chatId)} 会话的回复超时（${timeoutMs}ms）`))
      }, timeoutMs)
      // 计时器不该拖住进程退出：插件停掉之后没人等这条回复了。
      waiter.timer?.unref?.()
      waiter.settle = (error, text) => {
        if (waiter.settled) return
        waiter.settled = true
        clearTimeout(waiter.timer)
        detach(sessionId, waiter)
        if (error !== undefined) reject(error)
        else resolve(text)
      }
      const queue = waiting.get(sessionId)
      if (queue === undefined) waiting.set(sessionId, [waiter])
      else queue.push(waiter)
    })
    return {
      promise,
      settle: (error, text) => waiter.settle?.(error, text),
      // 整条等待作废，但不制造一个没人 await 的 rejection。
      cancel: () => {
        if (waiter.settled) return
        waiter.settled = true
        clearTimeout(waiter.timer)
        detach(sessionId, waiter)
      },
    }
  }

  /**
   * 挂人设提示词。
   *
   * @param {object} agentCtx - `setup` 给的 agent 作用域上下文。
   * @param {object} entry - 白名单条目。
   * @returns {boolean} 是否挂上了。
   */
  function mountPersona(agentCtx, entry, state) {
    const systemPrompt = agentCtx?.systemPrompt ?? agentCtx?.get?.("systemPrompt")
    if (systemPrompt === undefined || typeof systemPrompt.context !== "function") return false
    try {
      systemPrompt.context({
        name: PERSONA_SECTION,
        order: PERSONA_ORDER,
        // 函数形式：每轮现读人设文件，改 persona/大肥鱼.md 之后下一句就生效。
        // 每轮现算：人设 + 这个会话的记忆 + 现在说话这个人的画像。
        // 说话人存在 session state 上，由 generate() 每轮更新。
        text: () => {
          const speaker = state.speaker ?? { id: "", name: "" }
          const person = personFile(config?.memoryDir, speaker.id)
          const memory = [renderPerson(readPerson(person, speaker.id)), renderMemory(readMemory(memoryFile(config?.memoryDir, state.chatId)))]
            .filter((block) => block !== "")
            .join("\n\n")
          return composeSystemPrompt({
            persona: typeof personas.loadForEntry === "function" ? personas.loadForEntry(entry) : personas.load(entry.persona),
            entry,
            botName: config?.botName ?? "",
            memory,
            stickerRate: config?.stickerRate,
          })
        },
      })
      return true
    } catch (error) {
      log.warn(`挂人设提示词失败（${entry.label}）：${error?.message ?? error}`)
      return false
    }
  }

  /**
   * 给会话上权限预设。
   *
   * 失败只记录不抛：这发生在建会话里面，抛出去会连带把会话建失败，
   * 结果是一条消息都没有回复。落到 composition 自己的默认值更安全。
   *
   * @param {object} handle - agent 句柄。
   */
  function applyPermission(handle) {
    const preset = String(config?.permission ?? "").trim()
    if (preset === "") return
    const permissions = getPermissionPresets?.()
    if (permissions === undefined) return
    const session = handle?.agent?.session
    if (session === undefined) return
    try {
      permissions.set(session, preset)
    } catch (error) {
      log.warn(`设置权限预设 ${preset} 失败：${error?.message ?? error}`)
    }
  }

  /**
   * 会话在持久层里存在吗。
   * @param {string} sessionId - DSH 会话 ID。
   * @returns {Promise<boolean>}
   */
  async function sessionExists(sessionId) {
    const persistence = getPersistence?.()
    if (persistence === undefined || typeof persistence.stat !== "function") return false
    try {
      return (await persistence.stat(sessionId)) !== undefined
    } catch {
      // 读不了就当它存在：resume 失败会再兜底，而错误地 create 会盖掉已有历史。
      return true
    }
  }

  /**
   * 拿到（必要时建立或恢复）某个微信会话的 agent。
   *
   * @param {string} chatId - 微信会话 ID。
   * @param {object} entry - 白名单条目。
   * @returns {Promise<object>} 会话状态。
   */
  async function ensureSession(chatId, entry) {
    const known = sessions.get(chatId)
    if (known !== undefined && agents.get(known.sessionId) !== undefined) {
      known.entry = entry
      return known
    }
    if (known !== undefined) {
      // 句柄还在表里但注册表里已经没有它了：会话被别处关掉了，重新来一遍。
      sessions.delete(chatId)
      try {
        await known.handle?.dispose?.()
      } catch {
        /* 已经没了，忽略 */
      }
    }

    const pending = creating.get(chatId)
    if (pending !== undefined) {
      await pending.catch(() => undefined)
      return ensureSession(chatId, entry)
    }

    const created = openSession(chatId, entry)
    creating.set(chatId, created)
    try {
      return await created
    } finally {
      if (creating.get(chatId) === created) creating.delete(chatId)
    }
  }

  /**
   * 真正建/恢复一个会话。
   *
   * @param {string} chatId - 微信会话 ID。
   * @param {object} entry - 白名单条目。
   * @returns {Promise<object>} 会话状态。
   */
  async function openSession(chatId, entry) {
    const sessionId = sessionIdFor(chatId)
    const state = { chatId, sessionId, entry, handle: undefined, personaMounted: false }
    const agentOptions = modelOptions()
    const setup = (agentCtx) => {
      state.personaMounted = mountPersona(agentCtx, entry, state)
    }

    let handle
    if (await sessionExists(sessionId)) {
      handle = await agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
    } else {
      const meta = config?.cwd ? { cwd: config.cwd } : undefined
      handle = await agents.create({ sessionId, agentOptions, ...(meta === undefined ? {} : { meta }), setup })
    }

    if (state.personaMounted !== true) {
      log.warn(
        `没有挂上人设提示词（${entry.label}）：这一轮把人设拼在正文前面代替。` +
          `效果会差一些，而且会进会话历史 —— 请检查 systemPrompt 服务是否挂载。`,
      )
    }
    applyPermission(handle)
    state.handle = handle
    sessions.set(chatId, state)
    return state
  }

  /**
   * 这一轮该用哪个模型。
   * @returns {{provider?: string, model?: string}} 选项。
   */
  function modelOptions() {
    const selection = { provider: String(config?.provider ?? ""), model: String(config?.model ?? "") }
    if (selection.provider === "" && selection.model === "") {
      const fallback = modelSelection?.() ?? {}
      return { provider: fallback.provider, model: fallback.model }
    }
    if (selection.provider === "" || selection.model === "") {
      throw new Error(
        `channel-wechat-bg: provider 与 model 必须同时配置，现在 provider=${JSON.stringify(selection.provider)} model=${JSON.stringify(selection.model)}`,
      )
    }
    return selection
  }

  /** 反查：这个 sessionId 属于哪个微信会话。会话数量是个位数，遍历足够。 */
  function chatIdOf(sessionId) {
    for (const [chatId, state] of sessions) {
      if (state?.sessionId === sessionId) return chatId
    }
    return ""
  }

  // 回复的唯一入口：已提交的 assistant/message 事件。
  const offEvent = events.on("session/event", (session, event) => {
    if (disposed) return
    const sessionId = String(session?.id ?? "")
    const text = extractAssistantText(event)
    if (text === undefined) return
    const queue = waiting.get(sessionId)
    const waiter = queue?.[0]
    if (waiter !== undefined) {
      // 走 settle 而不是直接 resolve：它顺手把计时器停掉，并从队列里摘掉这一个，
      // 下一条 assistant/message 才会归下一个等待者。
      waiter.settle(undefined, text)
      return
    }
    // 没有等待者 = 这一轮不是被收到的消息触发的（agent 自己想说话）。
    // 以前这里直接 return，于是"主动发的消息"永远发不出去。
    if (typeof onProactiveText !== "function") return
    const chatId = chatIdOf(sessionId)
    if (chatId === "") return
    Promise.resolve()
      .then(() => onProactiveText(chatId, text))
      .catch((error) => logger?.warn?.(`主动消息没发出去：${String(error?.message ?? error)}`))
  })

  /**
   * 流水线要的那一个函数：把一条消息交给 agent，等它的回复。
   *
   * @param {object} input - 流水线给的输入。
   * @param {string} input.chatId - 微信会话 ID。
   * @param {object} input.entry - 白名单条目。
   * @param {string} input.systemPrompt - 人设提示词（挂不上时的兜底）。
   * @param {string} input.text - 这一轮要说的话。
   * @returns {Promise<string>} 回复正文。
   */
  async function generate({ chatId, entry, systemPrompt, text, speakerId = "", speakerName = "" }) {
    const state = await ensureSession(chatId, entry)
    // 说话人存在 state 上：挂载的那段提示词是每轮现算的，它从这里读"现在是谁在说"。
    state.speaker = { id: String(speakerId ?? ""), name: String(speakerName ?? "") }
    const { promise, settle, cancel } = awaitReply(state.sessionId, chatId)

    // 人设没挂上时，把它拼在正文前面。退化的路径要显式，不能假装没发生。
    const body = state.personaMounted === true ? text : `${systemPrompt}\n\n${text}`

    try {
      state.handle.agent.followup(
        createUserMessage({ content: [{ type: "text", text: body }], source: { kind: "user" } }),
      )
    } catch (error) {
      // 连一轮都没开起来：收回等待者（否则它会以未处理的 rejection 收场），再抛。
      cancel()
      throw error
    }

    try {
      return await promise
    } finally {
      // 超时或被 dispose 打断时，把**这一个**等待者摘掉。用 cancel 而不是删整个
      // 会话的队列：同一个会话后面可能还排着别的等待者。
      cancel()
    }
  }

  /**
   * 关掉所有会话。
   * @returns {Promise<void>}
   */
  async function dispose() {
    if (disposed) return
    disposed = true
    try {
      offEvent?.()
    } catch {
      /* 上下文已经销毁时取消订阅会抛，忽略 */
    }
    for (const queue of [...waiting.values()]) {
      for (const waiter of [...queue]) {
        waiter.settle?.(new Error("通道已停止，这一轮不再等待回复"))
      }
    }
    waiting.clear()
    const handles = [...sessions.values()]
    sessions.clear()
    await Promise.allSettled(handles.map((state) => state.handle?.dispose?.()))
  }

  /**
   * 状态：会话数、会话 ID，以及人设是否挂在提示词上。
   * @returns {object}
   */
  function status() {
    return {
      sessions: [...sessions.values()].map((state) => ({
        chatId: state.chatId,
        sessionId: state.sessionId,
        personaMounted: state.personaMounted,
        label: state.entry?.label ?? "",
      })),
      waiting: [...waiting.values()].reduce((total, queue) => total + queue.length, 0),
    }
  }

  return { generate, dispose, status }
}
