/**
 * dsh-channel-wechat-bg 的插件入口。
 *
 * 这个插件把微信当成 DSH 的一条通道：一个允许的会话对应一个 DSH 会话，消息
 * 进 `followup`，回复从 `session/event` 出来，发回微信。
 *
 * 入口这一层只负责"接线"和"生命周期"，判断一条消息该不该回全在 pipeline 里。
 * 这样接线出错时能一眼看出来，而规则出错时有测试兜着。
 *
 * 三条不变量，都在这里被守住：
 *   - 默认不启动（`enabled: false`）。装上不等于开始回消息。
 *   - 没有后台传输就拒绝启动，绝不退回 UI 自动化（`pipeline.start()` 里断言）。
 *   - 白名单只有两条固定 ID，没有通配符，没有"先回再检查"。
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { Config } from "./config.js"
import { normalizeConfig, plainConfig } from "./settings.js"
import { createBridge } from "./bridge.js"
import { createPipeline } from "./pipeline.js"
import { createPolicy } from "./policy.js"
import { BUNDLED_PERSONA_DIR, PersonaStore } from "./personas.js"
import { createTransport } from "./transport/index.js"
import { fetchGroups, resolveGroupsUrl } from "./groups.js"
import {
  effectiveAllow,
  healLabels,
  normalizeStickerRate,
  readStore,
  settingsFromBody,
  settingsPath,
  settingsSnapshot,
  writeStore,
} from "./settings-store.js"

/** 插件名。同时是 Cordis 的条目名和日志前缀。 */
export const name = "channel-wechat-bg"

/**
 * 依赖的宿主服务。
 *
 * 只列真正"没有它就完全没法工作"的两个。`systemPrompt` 故意**不**列在这里：
 * 人设挂不上时还能把人设拼进正文（见 `sessions.js` 的退化路径），而把它列进
 * inject 的代价是这个 composition 里只要没有它，插件就永远不装载 —— 静默。
 * 一个能退化的人设，不该有让整条通道消失的权力。
 */
export const inject = ["agents", "agentDefaultModel"]

/**
 * 把路由注册的结果写进文件。
 *
 * 界面上出现 404 时，"到底有没有注册成功"是第一个要回答的问题，而这个
 * 答案在日志里看不见（宿主不把插件日志落盘）。所以自己写一行。
 *
 * @param {string} line - 要记录的一行文本。
 */
function noteRoute(line) {
  try {
    const dir = join(resolveHome(), "channel-wechat-bg")
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, "route.log"), `${new Date().toISOString()} ${line}
`)
  } catch {}
}

/**
 * 找到"该往哪个目录写插件自己的东西"。
 *
 * 宿主进程里 `DSH_HOME` 不一定有值（桌面端就是没有），而设置文件必须落在
 * 一个**跨重启还在**的地方，否则用户勾完群、下次就没了。所以按可信度往下退：
 * `DSH_HOME` → `DSH_PROFILE_DIR`（profile 目录，本来就随 profile 保存）→ 当前目录。
 *
 * @returns {string} 目录路径。
 */
export function resolveHome() {
  const fromHome = String(process.env.DSH_HOME ?? "").trim()
  if (fromHome !== "") return fromHome
  const fromProfile = String(process.env.DSH_PROFILE_DIR ?? "").trim()
  if (fromProfile !== "") return fromProfile
  return process.cwd()
}

/** 状态接口的路由前缀。`/api` 是宿主留给插件的那一段。 */
export const STATUS_PATH = "/api/channel-wechat-bg/status"

/** 设置页读写的路由。跟状态接口同一段前缀，界面那边少一个变量。 */
export const SETTINGS_PATH = "/api/channel-wechat-bg/settings"

export { Config }

/**
 * 把 ctx.logger 包成三件套，拿不到时退回 console。
 *
 * @param {object} ctx - 插件上下文。
 * @returns {{info: Function, warn: Function, error: Function}} 日志器。
 */
function createLogger(ctx) {
  try {
    const logger = ctx.logger?.(name)
    if (logger !== undefined) {
      return {
        info: (message) => logger.info(String(message)),
        warn: (message) => logger.warn(String(message)),
        error: (message) => logger.error(String(message)),
      }
    }
  } catch {
    /* 拿不到就用 console */
  }
  return {
    info: (message) => console.log(`[${name}] ${message}`),
    warn: (message) => console.warn(`[${name}] ${message}`),
    error: (message) => console.error(`[${name}] ${message}`),
  }
}

/**
 * JSON 响应。不让缓存留住，否则轮询看到的永远是旧状态。
 * @param {object} value - 响应体。
 * @param {number} [status] - HTTP 状态码。
 * @returns {Response} 响应。
 */
function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  })
}

/**
 * 插件入口。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} config - schema 解析后的配置（volatile 字段是封装对象）。
 */
export function apply(ctx, config) {
  const log = createLogger(ctx)
  const settings = normalizeConfig(plainConfig(config), { dshHome: resolveHome() })

  // 配置里的白名单是"手写的底稿"；设置页改过的部分存在 settings.json 里，覆盖它。
  // 底稿单独留一份：设置页每次保存都要在它上面重新算，而不是在上一版生效值上叠加。
  const configAllow = Array.isArray(settings.allow) ? settings.allow : []
  const storePath = settingsPath(resolveHome())
  /** @type {{groups: Array<{id: string, label: string}>, wakePrefix: string, configured: boolean}} */
  let store = readStore(storePath, (message) => log.warn(message))
  let allow = effectiveAllow(configAllow, store, { configured: store.configured === true, persona: settings.botName })
  settings.allow = allow
  // 表情档位：设置页存过就以它为准，没存过才用配置里的值（默认"多"）。
  settings.stickerRate = store.configured === true ? normalizeStickerRate(store.stickerRate) : normalizeStickerRate(settings.stickerRate)

  /** 运行期状态。状态路由读它，所以它必须在任何分支下都有值。 */
  const state = {
    /** @type {object|undefined} */
    pipeline: undefined,
    /** @type {object|undefined} */
    bridge: undefined,
    /** @type {object|undefined} */
    transport: undefined,
    /** @type {string|undefined} */
    error: undefined,
    stopping: /** @type {Promise<void>|undefined} */ (undefined),
  }

  // 白名单是"谁能跟它说话"的定义，所以它先被建出来 —— 建不出来就是配置错了，
  // 这时候宁可整条通道不启动，也不要带着半份规则去跑。
  /** @type {object|undefined} */
  let policy
  try {
    policy = createPolicy({ allow: settings.allow, denyUnknown: settings.denyUnknown })
  } catch (error) {
    state.error = String(error?.message ?? error)
    log.error(state.error)
  }

  /**
   * 当前的群列表服务地址。从桥的地址推，用户不用为这件事再填一格。
   * @returns {string} 地址。
   */
  const groupsUrl = () => {
    const transportBase =
      settings.transport?.uia?.baseUrl || settings.transport?.wechatferry?.baseUrl || settings.transport?.pad?.baseUrl
    return resolveGroupsUrl(transportBase, settings.groupsUrl)
  }

  /**
   * 一个会话现在读的是哪份人设文件 —— 设置页要"至少能看见当前值"。
   *
   * 文件可能在内置目录，也可能在用户自己的 persona 目录；两处都查一遍，
   * 查到哪个就报哪个，都没查到就报名字（说明会是空人设）。
   *
   * @param {object} entry - 白名单项。
   * @returns {{file: string, path: string, builtin: boolean}} 人设文件信息。
   */
  const personaInfo = (entry) => {
    const persona = String(entry?.persona ?? "").trim()
    if (persona === "") return { file: "", path: "", builtin: false }
    const names = entry?.kind === "group" ? [`${persona}-group.md`, `${persona}.md`] : [`${persona}.md`]
    for (const name of names) {
      const custom = String(settings.personaDir ?? "").trim()
      if (custom !== "") {
        const path = join(custom, name)
        if (existsSync(path)) return { file: name, path, builtin: false }
      }
      const builtinPath = join(BUNDLED_PERSONA_DIR, name)
      if (existsSync(builtinPath)) return { file: name, path: builtinPath, builtin: true }
    }
    return { file: `${persona}.md`, path: "", builtin: false }
  }

  /** 数一下记忆目录里有几份东西。读不到就当 0，不要因为少个目录让整页打不开。 */
  const memoryInfo = () => {
    const dir = String(settings.memoryDir ?? "").trim()
    const count = (target) => {
      if (target === "") return 0
      try {
        return readdirSync(target).filter((file) => file.endsWith(".json")).length
      } catch {
        return 0
      }
    }
    return {
      dir,
      sessions: count(dir),
      people: count(dir === "" ? "" : join(dir, "people")),
    }
  }

  /**
   * 设置页要的整份快照：白名单、唤醒前缀、微信里能看到的群。
   *
   * 群列表拿不到不算错：它只影响"勾选"这一步的便利性，不该让整页打不开。
   *
   * @returns {Promise<object>} 快照。
   */
  const settingsView = async () => {
    let available = []
    let availableError
    try {
      const result = await fetchGroups({ url: groupsUrl() })
      available = result.groups
      availableError = result.error
    } catch (error) {
      availableError = String(error?.message ?? error)
    }
    // 群名能读到就顺手记下来：这次列出来的群名会把存储里空着的 label 补上，
    // 这样"当初没读到名字"的群下次打开设置页就自动有名字了。
    const healed = healLabels(store, available)
    if (healed.changed === true) {
      try {
        const written = writeStore(storePath, healed.store)
        store = { ...written, configured: true }
        allow = effectiveAllow(configAllow, store, { configured: true, persona: settings.botName })
        settings.allow = allow
      } catch (error) {
        log.warn(`群名补写失败（不影响使用）：${String(error?.message ?? error).slice(0, 120)}`)
      }
    }
    return {
      ...settingsSnapshot({ allow, store, available, availableError }),
      settingsPath: storePath,
      configured: store.configured === true,
      groupsUrl: groupsUrl(),
      // 下面三块是"读得到就展示"的信息：能调的在上面，不能调的至少让人看见现在的值。
      personas: allow.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        label: entry.label,
        name: String(entry.persona ?? "").trim(),
        ...personaInfo(entry),
      })),
      memory: memoryInfo(),
      transport: {
        kind: settings.transport.kind,
        baseUrl:
          settings.transport?.uia?.baseUrl ||
          settings.transport?.wechatferry?.baseUrl ||
          settings.transport?.pad?.baseUrl ||
          "",
      },
    }
  }

  /**
   * 保存设置页的改动，并让改动立刻生效。
   *
   * 生效分三处，缺一处就会出现"界面说改了、实际没改"：
   *   - `policy`：插件这边的判断规则；
   *   - `pipeline.reload`：正在跑的那条流水线（它自己持有一份 policy）；
   *   - `transport.applyAllow`：桥那边的白名单（桥是第二道闸，它也有一份）。
   *
   * @param {object} body - 提交体 `{groupIds, wakePrefix}`。
   * @returns {Promise<object>} 保存后的快照。
   */
  const saveSettings = async (body) => {
    let available = []
    try {
      const result = await fetchGroups({ url: groupsUrl() })
      available = result.groups
    } catch {
      /* 列不出来就当作没有新群，名字退回已有 label */
    }
    const next = settingsFromBody(body, allow, available)
    const written = writeStore(storePath, next)
    store = { ...written, configured: true }
    allow = effectiveAllow(configAllow, store, { configured: true, persona: settings.botName })
    settings.allow = allow
    settings.stickerRate = normalizeStickerRate(store.stickerRate)
    policy = createPolicy({ allow, denyUnknown: settings.denyUnknown })
    state.pipeline?.reload({ allow, stickerRate: settings.stickerRate })
    const transport = state.transport
    if (transport !== undefined && typeof transport.applyAllow === "function") {
      try {
        await transport.applyAllow(allow)
      } catch (error) {
        // 桥推不动不该回滚本地设置：用户点的是"以后按这个来"，桥下次连上会重推。
        log.warn(`白名单已保存，但推给桥失败：${String(error?.message ?? error).slice(0, 200)}`)
      }
    }
    return settingsView()
  }

  /** 汇总一份状态快照。 */
  const snapshot = () => {
    const running = state.pipeline?.status()
    return {
      name,
      enabled: settings.enabled,
      started: running?.started === true,
      error: state.error,
      transport: {
        kind: settings.transport.kind,
        // 能力声明要如实反映"现在有没有在跑"。没启动就没有能力可言。
        capabilities: running?.transport?.capabilities,
        started: running?.started === true,
      },
      allow: (policy?.entries() ?? []).map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        label: entry.label,
        persona: entry.persona,
        reply: entry.reply,
        enabled: entry.enabled,
        triggers: entry.triggers,
      })),
      denyUnknown: settings.denyUnknown,
      permission: settings.permission,
      // 群聊唤醒前缀：群里的消息只有命中它（或被 @）才会被当成"叫我"。
      // 它现在归设置页管，但状态接口也要能看到 —— 排查"为什么没回"时这是头一个要看的。
      wakePrefix: store.wakePrefix,
      settingsPath: storePath,
      allowForegroundSend: settings.allowForegroundSend,
      rateLimit: running?.rateLimit ?? settings.rateLimit,
      auditPath: running?.auditPath ?? settings.audit.path,
      counters: running?.counters,
      bridge: state.bridge?.status(),
    }
  }

  // 状态路由永远注册，即使没启用：装完之后第一个问题就是"它为什么没说话"，
  // 而这个问题必须能在界面上回答，不能只留在日志里。
  Promise.resolve(
    ctx.inject(["connection"], (injected) => {
      const connection = injected.get("connection")
      if (connection === undefined) {
        noteRoute("connection 服务不存在：路由无法注册")
        return
      }
      if (connection.fetch === undefined) {
        noteRoute(`connection.fetch 不存在（connection 的键：${Object.keys(connection).join(",")}）`)
        return
      }
      noteRoute(`connection.fetch 可用，开始注册 ${STATUS_PATH} 与 ${SETTINGS_PATH}`)
      injected.effect(() => {
        try {
          // 一条路径只注册一次：连接层的路由表按 path 精确索引，同 path 注册
          // 第二次会抛 "already registered"（实测），方法是 handler 里自己分的。
          const disposers = [
            connection.fetch.register({
              path: STATUS_PATH,
              methods: ["GET"],
              requestBody: "buffered",
              fetch: () => json(snapshot()),
            }),
            connection.fetch.register({
              path: SETTINGS_PATH,
              methods: ["GET", "PUT"],
              requestBody: "buffered",
              fetch: async (request) => {
                if (String(request?.method ?? "GET").toUpperCase() === "PUT") {
                  let body
                  try {
                    body = await request.json()
                  } catch {
                    return json({ error: "请求体必须是 JSON" }, 400)
                  }
                  try {
                    return json(await saveSettings(body))
                  } catch (error) {
                    return json({ error: String(error?.message ?? error) }, 500)
                  }
                }
                try {
                  return json(await settingsView())
                } catch (error) {
                  return json({ error: String(error?.message ?? error) }, 500)
                }
              },
            }),
          ]
          noteRoute(`已注册 ${disposers.length} 条路由`)
          return () => {
            for (const dispose of disposers) dispose()
          }
        } catch (error) {
          noteRoute(`注册抛错：${String(error?.stack ?? error).slice(0, 400)}`)
          return () => {}
        }
      })
    }),
  ).catch((error) => log.warn(`注册状态路由失败：${error?.message ?? error}`))

  if (settings.enabled !== true) {
    log.info(
      `未启用（enabled: false）：不连接微信，也不发送任何消息。` +
        `白名单 ${policy?.ids().join("、") ?? "（配置有误）"}，状态接口 ${STATUS_PATH}。`,
    )
    return
  }
  if (policy === undefined) {
    log.error("配置有误，拒绝启动。修好 allow / denyUnknown 之后再启用。")
    return
  }

  /**
   * 起传输、起流水线。
   * @returns {Promise<void>}
   */
  const start = async () => {
    const transport = createTransport(settings.transport, {
      log: (message) => log.warn(String(message)),
      // uia 传输要拿白名单去推给桥：规则只有一份，桥不该自己再配一遍。
      allow: settings.allow,
    })
    state.transport = transport

    // 人设仓库只建一个：pipeline 用它拼提示词，bridge 用在每轮的提示词片段里。
    // 建两份就会出现"编辑器里看到的人设"和"实际生效的人设"不一致。
    const personas = new PersonaStore({ dir: settings.personaDir, warn: (message) => log.warn(message) })
    const bridge = createBridge({
      ctx,
      config: settings,
      personas,
      logger: log,
      // agent 主动说话时（没有被收到的消息触发）也把话带出去。
      // 用状态里的 pipeline 而不是外面这个常量：它要到下面几行才建好。
      onProactiveText: (chatId, text) => state.pipeline?.publish?.(chatId, text),
    })
    state.bridge = bridge

    const pipeline = createPipeline({
      config: settings,
      transport,
      generate: (input) => bridge.generate(input),
      personas,
      logger: log,
    })
    state.pipeline = pipeline

    // 这一步会校验 `capabilities.backgroundSend`：不是后台发送的适配器，
    // 在这里就被挡住，而不是等第一条消息回出去才发现窗口被抢走了。
    //
    // 桥可能比 DSH 晚就绪（虚拟机刚开机、微信还没扫码）。原来这里是裸 await，
    // 一旦连不上就永远卡住、也不会重试，整条通道哑掉且日志里看不出来。
    // 现在：单次连接限时，失败就每 30 秒重试一次，直到成功或插件被卸载。
    const CONNECT_TIMEOUT_MS = 20_000
    const RETRY_DELAY_MS = 30_000
    // 两个定时器都要 unref：测试里没连上时，这枚 30 秒的重试定时器
    // 会把整个进程挂住，让人误以为是测试卡死。
    const withTimeout = (promise) =>
      Promise.race([
        promise,
        new Promise((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`连桥超时（${CONNECT_TIMEOUT_MS / 1000} 秒）`)),
            CONNECT_TIMEOUT_MS,
          )
          timer.unref?.()
        }),
      ])

    for (;;) {
      if (state.disposed === true) return
      try {
        await withTimeout(pipeline.start())
        log.info(
          `微信后台通道已启动：传输 ${settings.transport.kind}，` +
            `白名单 ${policy.ids().join("、")}，审计 ${settings.audit.path || "（关闭）"}。`,
        )
        return
      } catch (error) {
        const message = String(error?.message ?? error)
        state.error = message
        log.error(`启动失败：${message}；${RETRY_DELAY_MS / 1000} 秒后重试`)
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, RETRY_DELAY_MS)
          timer.unref?.()
        })
      }
    }
  }

  /**
   * 停：先停接收（不再有新消息进来），再停 bridge（不再等回复）。
   * @returns {Promise<void>}
   */
  const stop = async () => {
    state.disposed = true
    if (state.stopping !== undefined) return state.stopping
    state.stopping = (async () => {
      try {
        await state.pipeline?.stop()
      } catch (error) {
        log.warn(`停止流水线时出错：${error?.message ?? error}`)
      }
      try {
        await state.bridge?.dispose()
      } catch (error) {
        log.warn(`关闭会话时出错：${error?.message ?? error}`)
      }
      state.pipeline = undefined
      state.bridge = undefined
    })()
    return state.stopping
  }

  const starting = start().catch((error) => {
    state.error = String(error?.message ?? error)
    log.error(`启动流程异常退出：${state.error}`)
  })

  // 生命周期挂在这个插件行上：行被卸载（改配置、关插件、退出）时先停干净。
  ctx.effect(() => () => {
    void starting.then(() => stop())
  })
}
