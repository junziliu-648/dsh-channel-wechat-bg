/**
 * dsh-channel-wechat-bg 的类型声明。
 *
 * 插件本体是纯 ESM JavaScript，没有构建步骤；这份手写声明只描述"外面能看见的
 * 东西"，也就是配置、传输接口、以及协议层的数据形状。内部模块之间靠 JSDoc
 * 传递类型，不在这里重复。
 */

/** 微信会话的种类：单聊或群聊。 */
export type ChatKind = "dm" | "group"

/** 白名单里的一个会话。 */
export interface AllowEntry {
  /** 稳定的会话 ID（`wxid_…` 或 `…@chatroom`），不是昵称。 */
  id: string
  kind: ChatKind
  /** 只用于日志和称呼，不参与任何判断。 */
  label: string
  /** `persona/` 下的文件名（不含 `.md`）。 */
  persona: string
  /** `always`：每条都回；`mention`：群里只有被 @ 或命中 `triggers` 才回。 */
  reply: "always" | "mention"
  /** `reply: "mention"` 时，正文里出现任意一条就算被叫到。 */
  triggers: string[]
  enabled: boolean
}

/** 传输的能力声明。 */
export interface TransportCapabilities {
  /** 能不能收到消息。 */
  receive: boolean
  /**
   * 能不能在不抢焦点、不动剪贴板的情况下发送。
   *
   * 写 `false` 的适配器（比如 `uia`）不会被直接拒绝：它要求配置里
   * `allowForegroundSend: true`（见 {@link assertSendCapability}），
   * 也就是"用户知道了，并且同意了"。
   */
  backgroundSend: boolean
  /** 能不能往群里发。 */
  groups: boolean
}

/** 传输层交给流水线的入站消息（已归一化）。 */
export interface InboundMessage {
  /** 微信会话 ID。 */
  chatId: string
  chatKind: ChatKind
  /** 发送者 ID。等于自己的 ID 时会被流水线丢掉。 */
  senderId: string
  senderName?: string
  text: string
  /** 毫秒时间戳。 */
  timestamp: number
  /** 协议层给的稳定消息 ID，用于去重；没有时按内容指纹去重。 */
  messageId?: string
  /** 群里这条消息有没有 @ 到机器人。 */
  mentionedBot?: boolean
  /** 这条是不是自己发的。 */
  self?: boolean
}

/** 一次发送的结果。适配器不抛异常，失败一律落在这里。 */
export interface SendResult {
  ok: boolean
  messageId?: string
  error?: string
}

/**
 * 一个传输适配器。
 *
 * 两种都支持：
 * - 后台传输（`pad`、`wechatferry`）：`backgroundSend: true`，无条件放行；
 * - 前台传输（`uia`）：`backgroundSend: false`，需要 `allowForegroundSend: true`。
 *
 * 但界面操作本身只能发生在插件进程之外（`scripts/uia-bridge.py`）。
 * `test/no-ui-automation.test.js` 会确认 `lib/` 里没有任何窗口 API。
 */
export interface WeChatTransport {
  readonly kind: string
  readonly capabilities: TransportCapabilities
  /** 自己的账号 ID，用来丢掉自己发的消息。 */
  readonly selfId?: string
  start(): Promise<void>
  stop(): Promise<void>
  onMessage(handler: (message: InboundMessage) => void): () => void
  sendText(chatId: string, text: string): Promise<SendResult>
  listChats?(): Promise<Array<{ chatId: string; chatKind: ChatKind; title: string }>>
  health(): Promise<{ ok: boolean; detail?: string }>
}

/** 节流参数。 */
export interface RateLimitConfig {
  perChatSec: number
  maxPerMinute: number
  debounceMs: number
  maxReplyChars: number
}

/** 审计参数。 */
export interface AuditConfig {
  /** 留空则用 `$DSH_HOME/wechat-bg-audit.jsonl`。 */
  path: string
  /** 是否把消息正文写进审计。默认 `false`。 */
  logContent: boolean
}

/** 传输配置（扁平写法，和 `cordis.patch.yml` 一致）。 */
export interface TransportConfig {
  kind: "mock" | "pad" | "wechatferry" | "uia"
  /** `uia` 留空即 `http://127.0.0.1:8850`；`wechatferry` 留空即 `:8849`；`pad` 必填。 */
  baseUrl: string
  token: string
  dllPath: string
  wechatVersion: string
}

/** 插件配置。字段含义见 `config.example.yml`。 */
export interface WeChatBgConfig {
  enabled: boolean
  cwd: string
  botName: string
  transport: TransportConfig
  /**
   * 允许发送时占用前台窗口。只影响 `backgroundSend: false` 的传输（`uia`）。
   * 默认 `false`：关着时 `uia` 拒绝启动，不会退回任何"别的"发送方式。
   */
  allowForegroundSend: boolean
  allow: AllowEntry[]
  denyUnknown: boolean
  permission: "read-only" | "workspace-write" | "danger-full-access"
  rateLimit: RateLimitConfig
  audit: AuditConfig
  provider: string
  model: string
  personaDir: string
  /** 每个会话的长期记忆目录；留空用 <DSH_HOME>/wechat-bg/memory。 */
  memoryDir: string
  replyTimeoutMs: number
}

/** 一条审计记录。 */
export interface AuditEntry {
  /** ISO 时间戳。 */
  ts: string
  chatId: string
  direction: "in" | "out"
  chars: number
  transport: string
  result:
    | "ok"
    | "error"
    | "disabled"
    | "not-allowlisted"
    | "throttled"
    | "dropped"
    | "accepted"
    | "no-reply"
    | "empty-after-clean"
    | "generate-error"
  /** 丢弃/节流的原因码。 */
  reason?: string
  error?: string
  /** 只有 `audit.logContent: true` 时才有。 */
  text?: string
}

/** `/api/channel-wechat-bg/status` 的响应体。 */
export interface StatusSnapshot {
  name: string
  enabled: boolean
  started: boolean
  /** 启动失败的原因，没失败时为 `undefined`。 */
  error?: string
  transport: {
    kind: string
    capabilities?: TransportCapabilities
    started: boolean
  }
  allow: AllowEntry[]
  denyUnknown: boolean
  permission: string
  /** 用户是否显式允许了"发送时占用前台窗口"。 */
  allowForegroundSend: boolean
  rateLimit: RateLimitConfig
  auditPath: string
  counters?: {
    received: number
    replied: number
    sent: number
    failed: number
    dropped: Record<string, number>
  }
  bridge?: {
    sessions: Array<{ chatId: string; sessionId: string; personaMounted: boolean; label: string }>
    waiting: number
  }
}

/** 插件名，也是 Cordis 条目名。 */
export declare const name: "channel-wechat-bg"

/** 依赖的宿主服务。 */
export declare const inject: string[]

/** 状态接口路径。 */
export declare const STATUS_PATH: string

/** 配置模式（schemastery）。 */
export declare const Config: unknown

/** Cordis 入口。 */
export declare function apply(ctx: unknown, config: unknown): void

/** 从一个微信会话 ID 推出 DSH 会话 ID。 */
export declare function sessionIdFor(chatId: string): string

/** 从一条已提交的会话事件里取出模型的回话。 */
export declare function extractAssistantText(event: unknown): string | undefined

/** 会话 ID 前缀。 */
export declare const SESSION_ID_PREFIX: string
