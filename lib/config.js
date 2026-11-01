/**
 * 配置模式。
 *
 * 这个文件负责"配置长什么样"，`settings.js` 负责"读出来是什么"。分开是因为
 * 这里 import 了 schemastery，而 schemastery 只在宿主里解析得到 —— 读配置的那
 * 一半必须能在 `node --test` 里跑。
 */

import z from "@deepseek-ai/schemastery"

/** 白名单里的一个会话。 */
const AllowEntry = z
  .object({
    // 稳定的会话 ID，不是昵称。昵称会变，ID 不会 —— 白名单只能建立在不会变的东西上。
    id: z.string().required(),
    kind: z.union([z.const("dm"), z.const("group")]).required(),
    // 只用于日志和提示词里的称呼，不参与任何判断。
    label: z.string().default(""),
    // persona/ 目录下的文件名（不含 .md）。
    persona: z.string().default(""),
    // always：私聊，每条都回；mention：群里只有被 @ 或命中 triggers 才回。
    reply: z.union([z.const("always"), z.const("mention")]).default("mention"),
    triggers: z.array(z.string()).default([]),
    enabled: z.boolean().default(true),
  })
  // 数组元素里不能出现 volatile 字段：schemastery 明确禁止（volatile fields
  // require a fixed object path）。白名单本来也不该在界面里随手改，正好一致。
  .description("允许对话的会话。没有通配符，没有例外。")

export const Config = z.object({
  enabled: z.boolean().default(false).volatile().description("总开关。关掉时既不接收也不发送，一条都不发。"),
  cwd: z.string().default("").volatile().description("通道会话记录的工作目录。留空表示不记录。"),
  botName: z.string().default("大肥鱼").volatile().description("它在微信里的名字，用来去掉回复开头的自称。"),
  transport: z
    .object({
      kind: z
        .union([z.const("mock"), z.const("pad"), z.const("wechatferry"), z.const("uia")])
        .default("uia")
        .volatile()
        .description(
          "发送方式。uia：本机桥，读库收消息、界面操作发消息（会占用前台窗口，需同时打开 allowForegroundSend）；" +
            "wechatferry：本机注入（只支持微信 3.9.x）；pad：HTTP 协议服务；mock：只给测试用。",
        ),
      baseUrl: z
        .string()
        .default("")
        .volatile()
        .description(
          "HTTP 端点地址。uia 留空即 http://127.0.0.1:8850；wechatferry 留空即 http://127.0.0.1:8849；pad 必填。",
        ),
      token: z
        .string()
        .default("")
        .role("secret")
        .volatile()
        .description("Bearer token。只用于请求头，绝不打进日志或审计。"),
      dllPath: z.string().default("").volatile().description("wechatferry：sdk.dll 路径，只用于报错指路（注入由桥做）。"),
      wechatVersion: z
        .string()
        .default("")
        .volatile()
        .description("wechatferry：期望的微信版本。填了就必须是 3.9.x，填 4.x 会直接拒绝启动。"),
    })
    .default({}),
  allow: z.array(AllowEntry).default([]),
  denyUnknown: z.boolean().default(true).description("必须是 true。本插件没有『放行未知会话』这条路径。"),
  allowForegroundSend: z
    .boolean()
    .default(false)
    .volatile()
    .description(
      "允许发送时占用前台窗口。只有 uia 传输需要它，而且是显式表态：" +
        "打开之后发消息会短时间抢走你的前台窗口、模拟打字和点击。默认关，关着时 uia 传输拒绝启动。",
    ),
  permission: z
    .union([z.const("read-only"), z.const("workspace-write"), z.const("danger-full-access")])
    .default("read-only")
    .volatile()
    .description("通道会话的权限预设。默认只读：群里任何人都不该能通过它执行命令。"),
  rateLimit: z
    .object({
      perChatSec: z.number().min(0).default(6).volatile().description("同一个会话两条回复之间的最小间隔（秒）。"),
      maxPerMinute: z.number().min(1).default(6).volatile().description("同一个会话每分钟最多几条。"),
      debounceMs: z.number().min(0).default(1200).volatile().description("连发几条时合并成一轮的等待时间。"),
      maxReplyChars: z.number().min(1).default(300).volatile().description("单条回复的字符上限，超出截断。"),
    })
    .default({}),
  audit: z
    .object({
      path: z.string().default("").volatile().description("审计文件路径。留空则用 $DSH_HOME/wechat-bg-audit.jsonl。"),
      logContent: z
        .boolean()
        .default(false)
        .volatile()
        .description("是否把消息正文写进审计。默认不写：内容和密钥一样敏感。"),
    })
    .default({}),
  provider: z.string().default("").volatile().description("模型提供方。留空跟随 DSH 当前选择。"),
  model: z.string().default("").volatile().description("模型名。留空跟随 DSH 当前选择。"),
  personaDir: z.string().default("").volatile().description("人设目录。留空用插件自带的 persona/。"),
  memoryDir: z
    .string()
    .default("")
    .volatile()
    .description("每个会话的长期记忆目录。留空用 <DSH_HOME>/wechat-bg/memory。"),
  groupsUrl: z
    .string()
    .default("")
    .volatile()
    .description(
      "列群服务地址（scripts/wx-groups.py）。留空则取传输地址的主机名 + 8891 端口。" +
        "它只用来给设置页列群，读不到也不影响收发。",
    ),
  stickerRate: z
    .union([z.const("few"), z.const("normal"), z.const("more"), z.const("crazy")])
    .default("more")
    .volatile()
    .description(
      "表情包频率：few 少 / normal 正常 / more 多 / crazy 疯狂。设置页里也能改，改过之后以设置为准。",
    ),
  memeDir: z
    .string()
    .default("")
    .volatile()
    .description(
      "表情包图片目录（配合插件自带的 meme-map.json 把 [表情: 描述] 换成本地图片）。" +
        "留空就不发图，只把标记从正文里摘掉。",
    ),
  replyTimeoutMs: z
    .number()
    .min(1000)
    .default(180000)
    .volatile()
    .description("等一轮回复的上限，超时按失败处理，不发半截话。"),
})

export { normalizeConfig, plainConfig, resolveModelSelection, unvolatile } from "./settings.js"
