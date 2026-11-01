/**
 * 会话桥的测试。
 *
 * 这里测的都是"错了不报错、只是不回消息"的地方：建还是恢复会话、followup 传了
 * 什么、回复怎么认领、超时怎么办、停的时候有没有把等待者放掉。
 *
 * 依赖全部是假的，包括 `createUserMessage` —— 它来自 `@deepseek-ai/dsh-llm`，
 * 本地解析不到，所以必须在测试里替换成同形的假货。
 */

import assert from "node:assert/strict"
import test from "node:test"

import { createSessions } from "../lib/sessions.js"

/** 让出一轮微任务+宏任务：`generate` 是 async，断言前必须等它跑到 await 点。 */
const tick = () => new Promise((resolve) => setImmediate(resolve))

/** 假的 `createUserMessage`：形状和真的一致，够 sessions 用。 */
function fakeCreateUserMessage({ content, source }) {
  return { type: "user/message", data: { content }, source }
}

/**
 * 搭一套假宿主。
 *
 * @param {object} [options] - 覆盖项。
 * @param {number} [options.replyTimeoutMs] - 等回复的上限。
 * @param {object} [options.config] - 配置覆盖。
 * @param {string[]} [options.persisted] - 持久层里"已存在"的会话 ID。
 * @param {boolean} [options.withSystemPrompt] - setup 里给不给 systemPrompt。
 * @param {boolean} [options.followupThrows] - followup 会不会抛。
 */
function harness({
  replyTimeoutMs = 2000,
  config = {},
  persisted = [],
  withSystemPrompt = true,
  followupThrows = false,
  onProactiveText,
} = {}) {
  const handles = new Map()
  const calls = { create: [], resume: [], followup: [], permission: [], disposed: [] }
  const listeners = []

  function makeAgentCtx() {
    if (!withSystemPrompt) return { get: () => undefined }
    return {
      systemPrompt: {
        context: (section) => {
          calls.personaSection = section
          return () => undefined
        },
      },
    }
  }

  function makeHandle(sessionId) {
    const agent = {
      id: sessionId,
      session: { id: sessionId },
      followup: (message) => {
        if (followupThrows) throw new Error("agent 已经停了")
        calls.followup.push({ sessionId, message })
      },
      whenIdle: async () => undefined,
    }
    return {
      agent,
      dispose: async () => {
        calls.disposed.push(sessionId)
        handles.delete(sessionId)
      },
    }
  }

  const agents = {
    get: (sessionId) => handles.get(sessionId)?.agent,
    create: async (options) => {
      calls.create.push(options)
      const handle = makeHandle(options.sessionId)
      handles.set(options.sessionId, handle)
      await options.setup?.(makeAgentCtx())
      return handle
    },
    resume: async (options) => {
      calls.resume.push(options)
      const handle = makeHandle(options.resumeSessionId)
      handles.set(options.resumeSessionId, handle)
      await options.setup?.(makeAgentCtx())
      return handle
    },
  }

  const events = {
    on: (name, listener) => {
      listeners.push({ name, listener })
      return () => {
        const index = listeners.findIndex((item) => item.listener === listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
  }

  const sessions = createSessions({
    agents,
    events,
    onProactiveText,
    createUserMessage: fakeCreateUserMessage,
    personas: { load: (name) => `人设:${name}` },
    config: {
      cwd: "C:/work",
      provider: "",
      model: "",
      permission: "read-only",
      botName: "大肥鱼",
      replyTimeoutMs,
      ...config,
    },
    logger: { info() {}, warn() {}, error() {} },
    modelSelection: () => ({ provider: "deepseek", model: "chat" }),
    getPermissionPresets: () => ({
      set: (session, preset) => calls.permission.push({ sessionId: session.id, preset }),
    }),
    getPersistence: () => ({
      stat: async (sessionId) => (persisted.includes(sessionId) ? { id: sessionId } : undefined),
    }),
  })

  /** 发一条已提交的会话事件。 */
  const emit = (sessionId, event) => {
    for (const { name, listener } of [...listeners]) {
      if (name === "session/event") listener({ id: sessionId, header: {} }, event)
    }
  }

  return { sessions, calls, emit, handles }
}

/** 一条成形的 assistant 回话事件。 */
function replyEvent(text, extra = {}) {
  return { type: "assistant/message", data: { content: [{ type: "text", text }], ...extra } }
}

const ENTRY = { id: "wxid_example_dm", kind: "dm", label: "小明", persona: "大肥鱼", reply: "always" }
const SESSION_ID = "channel-wechat-bg-wxid_example_dm"

test("第一次对话会新建会话，并带上 cwd 与 setup", async () => {
  const { sessions, calls, emit } = harness()
  const pending = sessions.generate({ chatId: ENTRY.id, entry: ENTRY, systemPrompt: "P", text: "在吗" })
  await tick()

  assert.equal(calls.create.length, 1)
  assert.equal(calls.create[0].sessionId, SESSION_ID)
  assert.deepEqual(calls.create[0].meta, { cwd: "C:/work" })
  assert.deepEqual(calls.create[0].agentOptions, { provider: "deepseek", model: "chat" })

  assert.equal(calls.followup.length, 1)
  assert.equal(calls.followup[0].message.data.content[0].text, "在吗")
  assert.deepEqual(calls.followup[0].message.source, { kind: "user" })

  emit(SESSION_ID, replyEvent("在"))
  assert.equal(await pending, "在")
})

test("已有会话走 resume，而不是新建", async () => {
  const { sessions, calls, emit } = harness({ persisted: [SESSION_ID] })
  const pending = sessions.generate({ chatId: ENTRY.id, entry: ENTRY, systemPrompt: "P", text: "嗯" })
  await tick()

  assert.equal(calls.create.length, 0)
  assert.equal(calls.resume.length, 1)
  assert.equal(calls.resume[0].resumeSessionId, SESSION_ID)

  emit(SESSION_ID, replyEvent("嗯"))
  await pending
})

test("人设挂在 systemPrompt 上，正文里就不再重复", async () => {
  const { sessions, calls, emit } = harness()
  const pending = sessions.generate({ chatId: ENTRY.id, entry: ENTRY, systemPrompt: "人设:大肥鱼", text: "早上好" })
  await tick()

  assert.equal(typeof calls.personaSection.text, "function", "人设要给成 thunk，才能改文件即生效")
  assert.match(calls.personaSection.text(), /人设:大肥鱼/)
  assert.equal(calls.followup[0].message.data.content[0].text, "早上好")

  emit(SESSION_ID, replyEvent("早"))
  assert.equal(await pending, "早")
})

test("挂不上 systemPrompt 时把人设拼在正文前面", async () => {
  const { sessions, calls, emit } = harness({ withSystemPrompt: false })
  const pending = sessions.generate({ chatId: ENTRY.id, entry: ENTRY, systemPrompt: "人设:大肥鱼", text: "在吗" })
  await tick()

  assert.match(calls.followup[0].message.data.content[0].text, /^人设:大肥鱼\n\n在吗$/)

  emit(SESSION_ID, replyEvent("在"))
  await pending
})

test("权限预设落在会话上", async () => {
  const { sessions, calls, emit } = harness()
  const pending = sessions.generate({ chatId: ENTRY.id, entry: ENTRY, systemPrompt: "P", text: "x" })
  await tick()

  assert.deepEqual(calls.permission, [{ sessionId: SESSION_ID, preset: "read-only" }])

  emit(SESSION_ID, replyEvent("y"))
  await pending
})

test("打断的、带工具调用的、别的事件都不算回复", async () => {
  const { sessions, emit } = harness()
  const pending = sessions.generate({ chatId: ENTRY.id, entry: ENTRY, systemPrompt: "P", text: "在吗" })
  await tick()

  emit(SESSION_ID, { type: "turn/started", data: {} })
  emit(SESSION_ID, { type: "assistant/message", data: { interrupted: true, content: [{ type: "text", text: "半截" }] } })
  emit(SESSION_ID, {
    type: "assistant/message",
    data: { content: [{ type: "text", text: "我查一下" }, { type: "tool-call", name: "grep" }] },
  })

  // 直到真正的那条回话出现之前，promise 都不该 settled。
  let settled = false
  pending.then(
    () => (settled = true),
    () => (settled = true),
  )
  await tick()
  assert.equal(settled, false)

  emit(SESSION_ID, replyEvent("在的"))
  assert.equal(await pending, "在的")
})

test("超时按失败处理，并且不再等下一轮", async () => {
  const { sessions } = harness({ replyTimeoutMs: 30 })
  await assert.rejects(
    () => sessions.generate({ chatId: ENTRY.id, entry: ENTRY, systemPrompt: "P", text: "在吗" }),
    /超时/,
  )
  assert.equal(sessions.status().waiting, 0, "超时之后等待者必须被清掉")
})

test("followup 抛错时把等待者收回，不留下未处理的 rejection", async () => {
  const { sessions } = harness({ followupThrows: true })
  await assert.rejects(
    () => sessions.generate({ chatId: ENTRY.id, entry: ENTRY, systemPrompt: "P", text: "x" }),
    /agent 已经停了/,
  )
  assert.equal(sessions.status().waiting, 0)
})

test("同一个会话的两条消息不会各建一个会话，而且各等各的回复", async () => {
  const { sessions, calls, emit } = harness()
  const first = sessions.generate({ chatId: ENTRY.id, entry: ENTRY, systemPrompt: "P", text: "一" })
  const second = sessions.generate({ chatId: ENTRY.id, entry: ENTRY, systemPrompt: "P", text: "二" })
  await tick()

  assert.equal(calls.create.length, 1, "并发时只能建一个会话")
  assert.equal(calls.followup.length, 2)

  // 两条回复排队：先来的先认领。
  emit(SESSION_ID, replyEvent("回一"))
  assert.equal(await first, "回一")
  assert.equal(sessions.status().waiting, 1, "第二条还在等")

  emit(SESSION_ID, replyEvent("回二"))
  assert.equal(await second, "回二")
})

test("只配一半的 provider/model 会在建会话时抛错", async () => {
  const { sessions } = harness({ config: { provider: "deepseek", model: "" } })
  await assert.rejects(
    () => sessions.generate({ chatId: ENTRY.id, entry: ENTRY, systemPrompt: "P", text: "x" }),
    /provider 与 model 必须同时配置/,
  )
})

test("dispose 放掉所有等待者并关掉会话", async () => {
  const { sessions, calls } = harness()
  const pending = sessions.generate({ chatId: ENTRY.id, entry: ENTRY, systemPrompt: "P", text: "在吗" })
  await tick()
  await sessions.dispose()

  await assert.rejects(() => pending, /通道已停止/)
  assert.deepEqual(calls.disposed, [SESSION_ID])
  assert.equal(sessions.status().waiting, 0)
  assert.equal(sessions.status().sessions.length, 0)
})

test("没有等待者时，agent 自己说的话也算主动消息，交给上层发出去", async () => {
  const seen = []
  const { sessions, emit } = harness({ onProactiveText: (chatId, text) => seen.push({ chatId, text }) })

  // 先建会话（generate 会等回复，这里只要它把 sessionId 建出来）
  const pending = sessions.generate({ chatId: ENTRY.id, entry: ENTRY, systemPrompt: "P", text: "在吗" })
  await tick()
  emit(SESSION_ID, replyEvent("先接住这一条"))
  await pending
  await tick()

  // 这一条没有任何人在等 —— 就是 agent 自己冒出来的念头
  emit(SESSION_ID, replyEvent("我自己想说话了"))
  await tick()

  assert.deepEqual(seen, [{ chatId: ENTRY.id, text: "我自己想说话了" }])
})
