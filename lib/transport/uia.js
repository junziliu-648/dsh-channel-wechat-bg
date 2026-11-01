/**
 * 前台发送传输：接本机的 `scripts/uia-bridge.py`。
 *
 * 它是三种传输里**唯一会占用前台窗口**的一种：收消息读的是微信的本地数据库
 * （后台、不动窗口），发消息是在界面上模拟打字和点击（会抢前台）。所以：
 *
 *   - 能力声明如实写 `backgroundSend: false`，谁想用它必须先打开
 *     `allowForegroundSend`（见 `base.js` 的 `assertSendCapability`）；
 *   - 启动前要连上桥，并且桥必须自报 `foreground: true`；
 *   - 白名单由插件推给桥（`PUT /allow`），桥只收白名单里的会话 ——
 *     规则只有一份，不靠两边各配一遍。
 *
 * 协议与其他传输一致（`/health`、`/events`、`/send`），额外多一个 `PUT /allow`。
 */

import { HttpLinkTransport } from "./http-link.js"
import { FOREGROUND_CAPABILITIES, TransportError, TransportUnsupportedError } from "./base.js"

/** 桥的默认地址。刻意不跟 wcferry 的 10086、也不跟 pad 的端口撞。 */
export const UIA_DEFAULT_URL = "http://127.0.0.1:8850"

/**
 * 列群服务（`scripts/wx-groups.py`）的默认端口。
 *
 * 它跟桥是两个进程：桥只收发，列群只读库。分开是因为桥越小越好审，
 * 而"列出我有哪些群"这件事完全不需要出现在收发链路上。
 */
export const DEFAULT_GROUPS_PORT = 8891

/** 前台发送的能力声明。 */
export const UIA_CAPABILITIES = FOREGROUND_CAPABILITIES

export class UiaTransport extends HttpLinkTransport {
  capabilities = UIA_CAPABILITIES

  /**
   * @param {object} options - 连接参数。
   * @param {string} [options.baseUrl] - 桥地址，留空即 `http://127.0.0.1:8850`。
   * @param {string} [options.token] - Bearer token。
   * @param {Array<{id: string, kind: string, triggers?: string[]}>} [options.allow] - 要推给桥的白名单。
   * @param {typeof fetch} [options.fetch] - fetch 实现，测试用。
   * @param {(message: string) => void} [options.log] - 日志函数。
   */
  constructor({ baseUrl, token, allow, fetch: fetchImpl, log } = {}) {
    const resolved = String(baseUrl ?? "").trim() === "" ? UIA_DEFAULT_URL : baseUrl
    super({ baseUrl: resolved, token, kind: "uia", label: "UIA 前台桥", fetch: fetchImpl, log })
    /** @type {Array<{id: string, kind: string, triggers?: string[]}>} */
    this.allow = Array.isArray(allow) ? allow : []
  }

  /**
   * 把白名单推给桥。桥那边只认这份清单，插件这边也是同一份。
   *
   * @param {Array<{id: string, kind: string, triggers?: string[]}>} [entries] - 白名单条目。
   * @returns {Promise<void>}
   * @throws {TransportError} 桥拒绝或连不上时。
   */
  async applyAllow(entries = this.allow) {
    const chats = entries.map((entry) => ({
      id: entry.id,
      kind: entry.kind === "group" ? "group" : "dm",
      mentions: Array.isArray(entry.triggers) ? entry.triggers : [],
    }))
    let response
    try {
      response = await this.request("PUT", "/allow", { chats })
    } catch (error) {
      throw new TransportError(
        `channel-wechat-bg: 连不上 UIA 桥（${this.baseUrl}）：${String(error?.message ?? error).slice(0, 160)}。` +
          " 先跑 `python scripts/uia-bridge.py`，再启用插件。",
        "TRANSPORT_BRIDGE_UNREACHABLE",
      )
    }
    if (!response.ok) {
      throw new TransportError(
        `channel-wechat-bg: UIA 桥拒绝了白名单（HTTP ${response.status}）。` +
          " 桥和插件的白名单对不上时不会继续跑。",
        "TRANSPORT_ALLOW_REJECTED",
      )
    }
  }

  /**
   * 启动：先把白名单推过去，再走公共的探活 + 事件流。
   * @returns {Promise<void>}
   */
  async start() {
    await this.applyAllow()
    await super.start()
  }

  /**
   * 每轮重连都重推一次白名单：桥被重启过的话，它那边是空的。
   * @returns {Promise<void>}
   */
  async beforeStream() {
    try {
      await this.applyAllow()
    } catch (error) {
      // 推不动就等下一轮重连；事件流本身会继续断线重试。
      this.log(String(error?.message ?? error))
    }
  }

  /**
   * 桥必须确认自己会占前台。这条闸门防的是"我以为在用后台传输"。
   * @param {{raw?: object}} status - `health()` 的返回值。
   * @returns {Promise<void>}
   */
  async precheck(status) {
    const raw = status?.raw ?? {}
    if (raw.foreground !== true) {
      throw new TransportUnsupportedError(
        "channel-wechat-bg: UIA 桥没有声明 foreground: true，无法确认它是不是前台发送模式。已拒绝启动。",
        "TRANSPORT_FOREGROUND_UNCONFIRMED",
      )
    }
  }
}
