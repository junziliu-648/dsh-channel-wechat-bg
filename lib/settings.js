/**
 * 配置的读取与归一化。
 *
 * 这里有一个 DSH 特有的坑必须先说清楚：带着 `.volatile()` 的字段，在 schema
 * 解析之后并不是原始值，而是一个只有 `get()` 的封装对象（`Volatile<T>`，
 * 意义是"这格可以在界面里改，改完要重新读"）。所以 `apply` 拿到的
 * `config.transport.kind` 不能直接当字符串用 —— 直接 `.trim()` 会在运行时炸，
 * 而这行代码在测试里永远是绿的，因为它只在真的被宿主加载时才出现。
 *
 * 于是配置一律先过 `plainConfig()` 变成快照再用：读的地方只有一处，误用就少
 * 一处。快照也顺便表达了本插件的态度 —— 改配置要重新加载插件，而不是在运行中
 * 半信半疑地读一半新值。
 *
 * 这个文件刻意不 import 任何东西（包括 schemastery）：它是 `node --test` 能
 * 直接跑的那一层。schema 本身在 `config.js` 里，只被宿主加载。
 */

/**
 * 把一个值从 `Volatile` 封装里解出来。
 *
 * 判据同时看"只有 get 一个键"和"不是 Map/Set"：`Volatile` 就是这么构造的
 * （`{ get() {} }`），而别的对象恰好长得像它的概率极低。
 *
 * @param {unknown} value - schema 解析后的值。
 * @returns {unknown} 里面的真实值。
 */
export function unvolatile(value) {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value
  if (value instanceof Map || value instanceof Set || value instanceof Date) return value
  if (typeof value.get === "function" && typeof value.set !== "function" && Object.keys(value).length <= 1) {
    return value.get()
  }
  return value
}

/**
 * 深拷贝一份去掉封装、可以放心读的配置。
 *
 * @param {unknown} value - schema 解析后的配置。
 * @returns {any} 普通对象。
 */
export function plainConfig(value) {
  const unwrapped = unvolatile(value)
  if (unwrapped === null || typeof unwrapped !== "object") return unwrapped
  if (Array.isArray(unwrapped)) return unwrapped.map((item) => plainConfig(item))
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const [key, item] of Object.entries(unwrapped)) out[key] = plainConfig(item)
  return out
}

/**
 * 把配置补成流水线能直接用的形状。
 *
 * 这里不重复 schema 的默认值，而是只做 schema 做不到的几件事：把空串变成
 * `undefined`（"没配"和"配了个空"要能区分）、把传输参数折成适配器要的形状、
 * 以及给审计文件钉一个绝对路径。
 *
 * @param {object} [config] - `plainConfig()` 的结果。
 * @param {object} [deps] - 注入项。
 * @param {string} [deps.dshHome] - DSH 主目录，用于默认审计路径。
 * @returns {object} 归一化后的配置。
 */
export function normalizeConfig(config, { dshHome = "" } = {}) {
  const source = config ?? {}
  const transport = { ...(source.transport ?? {}) }
  const text = (value) => (typeof value === "string" ? value.trim() : "")

  const auditPath = text(source.audit?.path)
  const home = text(dshHome)

  return {
    enabled: source.enabled === true,
    cwd: text(source.cwd),
    botName: text(source.botName),
    transport: {
      // 面对用户的配置是扁平的（transport.kind/baseUrl/token），工厂要的是按 kind
      // 分组的那一坨。折在这里，是因为"配置长什么样"和"适配器怎么取参数"是两件事，
      // 让用户去写嵌套只是把内部结构泄漏给配置文件。
      kind: text(transport.kind) || "pad",
      pad: {
        baseUrl: text(transport.baseUrl),
        token: typeof transport.token === "string" ? transport.token : "",
      },
      wechatferry: {
        // baseUrl/token 也给它一份：wechatferry 走的是本机的桥，同样是 HTTP，
        // 只是默认地址由传输自己补（它知道桥默认在哪个端口）。
        baseUrl: text(transport.baseUrl),
        token: typeof transport.token === "string" ? transport.token : "",
        dllPath: text(transport.dllPath),
        wechatVersion: text(transport.wechatVersion),
      },
      uia: {
        // 前台桥也走 HTTP：默认地址由传输自己补（http://127.0.0.1:8850）。
        baseUrl: text(transport.baseUrl),
        token: typeof transport.token === "string" ? transport.token : "",
      },
    },
    allow: Array.isArray(source.allow) ? source.allow : [],
    denyUnknown: source.denyUnknown !== false,
    // 前台发送的显式许可。默认关；它是"我知道这条会抢我的窗口"的一次性表态，
    // 不是随传输类型自动打开的东西。
    allowForegroundSend: source.allowForegroundSend === true,
    permission: text(source.permission) || "read-only",
    rateLimit: { ...(source.rateLimit ?? {}) },
    audit: {
      // 没配路径时落在 DSH 主目录下：审计是"这个通道到底做了什么"的唯一证据，
      // 它不该依赖当前工作目录，因为工作目录会随会话变。
      path: auditPath !== "" ? auditPath : home !== "" ? `${home}/wechat-bg-audit.jsonl` : "",
      logContent: source.audit?.logContent === true,
    },
    provider: text(source.provider),
    model: text(source.model),
    personaDir: text(source.personaDir),
    // 每个会话的长期记忆目录。没配就落在 DSH 主目录下，跟审计文件同一个理由：
    // 它不该随当前工作目录变。
    memoryDir: text(source.memoryDir) || (home !== "" ? `${home}/wechat-bg/memory` : ""),
    // 列群服务地址。留空由 groups.js 按传输主机名 + 8891 推出来。
    groupsUrl: text(source.groupsUrl),
    // 表情档位：只有设置页没存过时才用它。认不出来的值在设置层会被收敛成默认。
    stickerRate: text(source.stickerRate) || "more",
    // 表情包图片目录。留空表示不发图，只把 [表情: xx] 标记从正文里摘掉。
    memeDir: text(source.memeDir),
    replyTimeoutMs: Number.isFinite(source.replyTimeoutMs) ? source.replyTimeoutMs : 180000,
  }
}

/**
 * 模型选择：两条都配了才用，都没配就跟随 DSH 当前选择。
 *
 * 只配一条是明确的错误，而不是"另一半用默认"。混着两个来源的选择会在事后
 * 完全无法解释"这条回复是谁生成的"。
 *
 * @param {object} config - 归一化后的配置。
 * @param {() => {provider?: string, model?: string}} [fallback] - 当前默认选择。
 * @returns {{provider: string, model: string}} 选择。
 * @throws {Error} 只配了一半时。
 */
export function resolveModelSelection(config, fallback) {
  const provider = String(config?.provider ?? "").trim()
  const model = String(config?.model ?? "").trim()
  if (provider === "" && model === "") {
    const current = fallback?.() ?? {}
    return { provider: String(current.provider ?? ""), model: String(current.model ?? "") }
  }
  if (provider === "" || model === "") {
    throw new Error(
      `channel-wechat-bg: provider 与 model 必须同时配置，现在 provider=${JSON.stringify(provider)} model=${JSON.stringify(model)}`,
    )
  }
  return { provider, model }
}
