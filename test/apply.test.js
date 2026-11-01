/**
 * `apply()` 的接线测试。
 *
 * 这是唯一一段"逻辑都对、接错就静默"的代码：`ctx.inject` 的名字、`effect`
 * 的返回、`connection.fetch.register` 的路径、启动失败的落点。它平时只能靠
 * 真启动一次宿主来验证，而宿主重启很贵，所以这里用假的 ctx 把接线跑一遍。
 *
 * 两个 import 需要重定向：
 *   - `@deepseek-ai/schemastery` 指向 profile 里那份真货（版本必须和宿主一致），
 *     找不到就整份测试跳过 —— 用假的 schemastery 测出来的结论没有意义。
 *   - `@deepseek-ai/dsh-llm` 指向本目录的替身，它只需要 `createUserMessage`。
 */

import assert from "node:assert/strict"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { registerHooks } from "node:module"
import { homedir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

/** profile 里真货 schemastery 的位置（用环境变量覆盖，默认取 DSH_HOME）。 */
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh")
const SCHEMASTERY_URL = pathToFileURL(
  join(DSH_HOME, "profiles", "desktop", "node_modules", "@deepseek-ai", "schemastery", "lib", "index.mjs"),
)

const HERE = fileURLToPath(new URL(".", import.meta.url))
const LLM_STUB_URL = pathToFileURL(join(HERE, "fixtures", "dsh-llm-stub.js"))
const INDEX_URL = pathToFileURL(join(HERE, "..", "lib", "index.js"))

const canRun = typeof registerHooks === "function" && existsSync(fileURLToPath(SCHEMASTERY_URL))

if (canRun) {
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "@deepseek-ai/schemastery") {
        return { url: SCHEMASTERY_URL.href, format: "module", shortCircuit: true }
      }
      if (specifier === "@deepseek-ai/dsh-llm") {
        return { url: LLM_STUB_URL.href, format: "module", shortCircuit: true }
      }
      return next(specifier, context)
    },
  })
}

/**
 * 搭一个假 ctx。
 *
 * @param {object} [services] - `ctx.get(name)` 能拿到的服务。
 * @returns {object} 假 ctx 与观察点。
 */
function fakeCtx(services = {}) {
  const routes = []
  const effects = []
  const logs = { info: [], warn: [], error: [] }
  const listeners = []

  const connection = {
    fetch: {
      register: (route) => {
        // 真连接层按 path 精确索引：同一个 path 注册第二次会抛
        // "exact Fetch route <path> is already registered"（实测），
        // 而且这个抛出会把整段 effect 回滚 —— 表现就是界面上 404。
        // 这里照抄那条规则，免得以后又把 GET/PUT 拆成两条注册。
        if (routes.some((existing) => existing.path === route.path)) {
          throw new Error(`connection: exact Fetch route "${route.path}" is already registered`)
        }
        routes.push(route)
        return () => undefined
      },
    },
  }

  // `connection` 必须和调用方给的服务在同一张表里：`ctx.get` 与 `ctx.inject`
  // 回调里那个 `get` 查的是同一个名字空间。分成两张表时 `apply` 会查不到
  // `connection`，于是它在注册状态路由之前就安静地 return 了。
  const resolved = { connection, ...services }

  const ctx = {
    logger: () => ({
      info: (message) => logs.info.push(message),
      warn: (message) => logs.warn.push(message),
      error: (message) => logs.error.push(message),
    }),
    get: (name) => resolved[name],
    on: (name, listener) => {
      listeners.push({ name, listener })
      return () => {
        const index = listeners.findIndex((item) => item.listener === listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    agents: {
      get: () => undefined,
      create: async () => {
        throw new Error("这个测试不该真的建会话")
      },
      resume: async () => {
        throw new Error("这个测试不该真的恢复会话")
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: "deepseek", model: "chat" }) },
    inject: async (names, callback) => {
      assert.deepEqual(names, ["connection"], "只允许向宿主申请 connection 这一段")
      callback({
        get: (name) => resolved[name],
        effect: (factory) => {
          effects.push(factory())
        },
      })
    },
    effect: (factory) => {
      effects.push(factory())
    },
  }

  return { ctx, routes, effects, logs, listeners, services: resolved }
}

/**
 * 让出若干毫秒：`apply` 里的路由注册和启动都是异步的，断言前必须等它们落定。
 *
 * @param {number} [ms] - 等待毫秒数。
 * @returns {Promise<void>}
 */
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

/** 一份最小可用配置（和 cordis.patch.yml 里那份同形）。 */
function config(overrides = {}) {
  return {
    enabled: false,
    cwd: "",
    botName: "大肥鱼",
    transport: { kind: "mock", baseUrl: "", token: "", dllPath: "", wechatVersion: "" },
    allow: [
      { id: "wxid_example_dm", kind: "dm", label: "小明", persona: "大肥鱼", reply: "always", triggers: [], enabled: true },
      {
        id: "12345678901@chatroom",
        kind: "group",
        label: "测试",
        persona: "工作助理",
        reply: "mention",
        triggers: ["@大肥鱼"],
        enabled: true,
      },
    ],
    denyUnknown: true,
    permission: "read-only",
    rateLimit: { perChatSec: 6, maxPerMinute: 6, debounceMs: 1200, maxReplyChars: 300 },
    audit: { path: "", logContent: false },
    provider: "",
    model: "",
    personaDir: "",
    replyTimeoutMs: 180000,
    ...overrides,
  }
}

test("apply 默认不启动，但状态接口照样注册", { skip: canRun ? false : "没有找到宿主的 schemastery" }, async () => {
  const index = await import(INDEX_URL.href)
  const fake = fakeCtx()

  index.apply(fake.ctx, config())
  await tick()

  // 路由永远注册：装完之后第一个问题就是"它为什么没说话"。
  // 两条路由：状态一条，设置页一条（GET 和 PUT 共用一条路径，连接层的路由表
  // 按 path 索引，同 path 注册第二次会抛）。
  assert.equal(fake.routes.length, 2)
  const statusRoute = fake.routes.find((route) => route.path === "/api/channel-wechat-bg/status")
  assert.ok(statusRoute, "状态路由必须注册")
  assert.deepEqual(statusRoute.methods, ["GET"])
  const settingsRoute = fake.routes.find((route) => route.path === "/api/channel-wechat-bg/settings")
  assert.ok(settingsRoute, "设置路由必须注册")
  assert.deepEqual(settingsRoute.methods.slice().sort(), ["GET", "PUT"])

  const response = await statusRoute.fetch()
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.enabled, false)
  assert.equal(body.started, false)
  assert.deepEqual(
    body.allow.map((entry) => entry.id),
    ["wxid_example_dm", "12345678901@chatroom"],
  )
  assert.match(fake.logs.info.join("\n"), /未启用/)
})

test("denyUnknown 不是 true 时拒绝启动并说明原因", { skip: canRun ? false : "没有找到宿主的 schemastery" }, async () => {
  const index = await import(INDEX_URL.href)
  const fake = fakeCtx()

  index.apply(fake.ctx, config({ enabled: true, denyUnknown: false }))
  await tick()

  const body = await (await fake.routes[0].fetch()).json()
  assert.match(body.error ?? "", /denyUnknown/)
  assert.equal(body.started, false, "白名单建不出来就不该启动")
})

test("enabled 但没有后台传输时拒绝启动，把原因写进状态", { skip: canRun ? false : "没有找到宿主的 schemastery" }, async () => {
  const index = await import(INDEX_URL.href)
  const fake = fakeCtx()

  index.apply(
    fake.ctx,
    config({ enabled: true, transport: { kind: "pad", baseUrl: "", token: "", dllPath: "", wechatVersion: "" } }),
  )

  // start() 是异步的，等它落定。
  await tick(30)
  const body = await (await fake.routes[0].fetch()).json()
  assert.equal(body.started, false)
  assert.match(body.error ?? "", /baseUrl|地址/, "必须说清楚为什么没启动")
})

test("wechatferry 在微信 4.x 上拒绝启动", { skip: canRun ? false : "没有找到宿主的 schemastery" }, async () => {
  const index = await import(INDEX_URL.href)
  const fake = fakeCtx()

  index.apply(
    fake.ctx,
    config({
      enabled: true,
      transport: { kind: "wechatferry", baseUrl: "", token: "", dllPath: "C:/x/wcferry.dll", wechatVersion: "4.1.13.12" },
    }),
  )

  await tick(30)
  const body = await (await fake.routes[0].fetch()).json()
  assert.equal(body.started, false)
  assert.match(body.error ?? "", /3\.9\.x/)
})

test("mock 传输能真正启动，状态里能力如实", { skip: canRun ? false : "没有找到宿主的 schemastery" }, async () => {
  const index = await import(INDEX_URL.href)
  const fake = fakeCtx()

  index.apply(fake.ctx, config({ enabled: true }))
  await tick(30)

  const body = await (await fake.routes[0].fetch()).json()
  assert.equal(body.started, true)
  assert.equal(body.error, undefined)
  assert.deepEqual(body.transport.capabilities, { receive: true, backgroundSend: true, groups: true })
  assert.equal(body.transport.kind, "mock")

  // 版本行被卸载时要停干净。
  for (const dispose of fake.effects.reverse()) dispose?.()
  await tick(30)
})

test("设置页的 PUT 真能把群写进白名单，GET 又读得回来", { skip: canRun ? false : "没有找到宿主的 schemastery" }, async () => {
  const index = await import(INDEX_URL.href)
  const fake = fakeCtx()
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "cwb-apply-"))
  try {
    index.apply(fake.ctx, config())
    await tick()

    // 设置页 GET 和 PUT 是同一条路由，方法在 handler 里分。
    const settings = fake.routes.find((route) => route.path === "/api/channel-wechat-bg/settings")
    assert.ok(settings)
    assert.deepEqual(settings.methods.slice().sort(), ["GET", "PUT"])
    const get = { fetch: () => settings.fetch(new Request("http://x/api/channel-wechat-bg/settings")) }

    const saved = await settings.fetch(
      new Request("http://x/api/channel-wechat-bg/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupIds: ["12345678902@chatroom"], wakePrefix: "小鱼" }),
      }),
    )
    assert.equal(saved.status, 200)
    const savedBody = await saved.json()
    assert.equal(savedBody.wakePrefix, "小鱼")
    assert.deepEqual(savedBody.allow.filter((entry) => entry.kind === "group").map((entry) => entry.id), ["12345678902@chatroom"])

    // 存下来的东西必须真的进到生效白名单里，而不是只回显。
    const body = await (await get.fetch()).json()
    assert.equal(body.wakePrefix, "小鱼")
    assert.deepEqual(body.groups.map((row) => [row.id, row.selected]), [["12345678902@chatroom", true]])

    const status = await (await fake.routes.find((route) => route.path.endsWith("/status")).fetch()).json()
    assert.deepEqual(status.allow.map((entry) => entry.id), ["wxid_example_dm", "12345678902@chatroom"])
    assert.deepEqual(status.allow[1].triggers, ["小鱼"], "唤醒前缀要跟着走")
    assert.equal(status.allow[1].persona, "大肥鱼", "没写人设的群用人设兜底")
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

test("resolveHome：宿主没给 DSH_HOME 时退到 profile 目录，再退到当前目录", async () => {
  const index = await import(INDEX_URL.href)
  const saved = { home: process.env.DSH_HOME, profile: process.env.DSH_PROFILE_DIR }
  try {
    process.env.DSH_HOME = "C:/dsh-home"
    assert.equal(index.resolveHome(), "C:/dsh-home")

    delete process.env.DSH_HOME
    process.env.DSH_PROFILE_DIR = "C:/dsh-profile"
    assert.equal(index.resolveHome(), "C:/dsh-profile")

    delete process.env.DSH_PROFILE_DIR
    assert.equal(index.resolveHome(), process.cwd())
  } finally {
    if (saved.home === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved.home
    if (saved.profile === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = saved.profile
  }
})
