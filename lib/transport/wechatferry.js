/**
 * WeChatFerry 传输（本机注入，经本地桥）。
 *
 * ## 为什么中间要有一个桥
 *
 * WeChatFerry 的工作方式是把 sdk.dll 注入微信进程，然后通过本地 RPC 收发消息。
 * 那个 RPC 是 Python/C++ 侧的东西：本插件是纯 ESM、零依赖的，不应该为了它引入
 * 原生模块，更不应该在 DSH 进程里做 DLL 注入 —— 注入失败会连带 DSH 一起死。
 *
 * 所以分成两段：`scripts/wcf-bridge.py` 用 Python 的 `wcferry` 包做注入和收发，
 * 再把它包装成和 `pad` 一样的 HTTP/SSE 协议；这个类只是那个桥的客户端。
 * 好处是桥挂了插件只是"探活失败"，微信挂了 DSH 不受影响。
 *
 * ## 它仍然是真后台
 *
 * 整条链路里没有窗口、没有键鼠、没有剪贴板 —— 注入走的是进程内存，发送走的是
 * 微信自己的发送接口。`backgroundSend` 在这里是结构上成立的。`scripts/
 * verify-background-send.ps1` 可以在真机上复核这一点。
 *
 * ## 它只支持微信 3.9.x
 *
 * 注入依赖微信内部结构的固定偏移，4.x 的编译产物完全不同，注入不了。这里有两道
 * 闸门：配置里写明的版本、以及桥自报的版本，任意一道不是 3.9.x 就拒绝启动。
 * 本机装的是 4.1.13.12，所以默认配置下它**会**拒绝启动 —— 这是设计，不是缺陷。
 *
 * 前置条件、降级步骤、封号风险见 TRANSPORT.md。
 */

import { TransportError, TransportUnsupportedError } from "./base.js"
import { HttpLinkTransport } from "./http-link.js"

/**
 * 桥的默认地址。
 *
 * 刻意避开 wcferry 自己的 RPC 默认端口（10086）：两个端口撞在一起时，最难受的
 * 是"看起来连上了，其实连的是另一个进程"。
 */
export const DEFAULT_BRIDGE_URL = "http://127.0.0.1:8849"

/** WeChatFerry 支持的大版本前缀。 */
export const SUPPORTED_VERSION_PREFIX = "3.9."

export class WeChatFerryTransport extends HttpLinkTransport {
  /**
   * @param {object} [options] - 桥地址与版本约束。
   * @param {string} [options.baseUrl] - 桥地址，默认 `http://127.0.0.1:8849`。
   * @param {string} [options.token] - 桥的 Bearer token（本地一般留空）。
   * @param {string} [options.dllPath] - sdk.dll 路径，只用于报错时指路（注入由桥做）。
   * @param {string} [options.wechatVersion] - 期望的微信版本，只接受 3.9.x。
   * @param {typeof fetch} [options.fetch] - fetch 实现，测试用。
   * @param {(message: string) => void} [options.log] - 日志函数。
   */
  constructor({ baseUrl, dllPath = "", wechatVersion = "", ...rest } = {}) {
    const resolved = String(baseUrl ?? "").trim()
    super({ ...rest, baseUrl: resolved === "" ? DEFAULT_BRIDGE_URL : resolved, kind: "wechatferry", label: "WeChatFerry 桥" })
    this.dllPath = String(dllPath ?? "").trim()
    this.wechatVersion = String(wechatVersion ?? "").trim()
  }

  async start() {
    // 配置写明了版本就先判：版本不对时，让人先看到"微信版本"，而不是"桥连不上"。
    this.assertSupportedVersion(this.wechatVersion, "transport.wechatferry.wechatVersion")
    try {
      await super.start()
    } catch (error) {
      // 探活失败几乎总是两件事：桥没起，或者微信没登录/版本不对。把话一次说完。
      if (error?.code === "TRANSPORT_UNHEALTHY" || error instanceof TransportError) {
        throw new TransportUnsupportedError(
          `${error.message}。WeChatFerry 只能注入微信 3.9.x：请先按 TRANSPORT.md 把微信降到 3.9.x，` +
            `并用 python scripts/wcf-bridge.py 在 ${this.baseUrl} 起桥。已拒绝启动，不会退回到 UI 自动化。`,
          "TRANSPORT_BRIDGE_UNREACHABLE",
        )
      }
      throw error
    }
  }

  /**
   * 启动前的第二道闸门：桥自报的微信版本必须也是 3.9.x。
   *
   * 只信配置是不够的 —— 配置可以写 3.9.11.25，而机器上装的是 4.x。桥探的是真东西。
   *
   * @param {{raw?: object}} status - `health()` 的返回值。
   * @returns {Promise<void>}
   */
  async precheck(status) {
    const raw = status?.raw ?? {}
    const version = String(raw.wechatVersion ?? raw.wechat_version ?? "").trim()
    this.assertSupportedVersion(version, "桥报告的微信版本")
    if (raw.injected === false) {
      throw new TransportUnsupportedError(
        "channel-wechat-bg: WeChatFerry 桥在跑，但 DLL 没有注入成功（injected=false）。" +
          "通常是微信没登录、或者微信版本不是 3.9.x。已拒绝启动。",
        "TRANSPORT_NOT_INJECTED",
      )
    }
  }

  /**
   * 版本闸门。
   *
   * 空字符串表示"没声明"，交给下一道闸门（桥自报）判断 —— 声明了就必须对。
   *
   * @param {string} version - 待检查的版本号。
   * @param {string} where - 这个版本号是从哪来的（写进报错里）。
   * @returns {void}
   */
  assertSupportedVersion(version, where) {
    if (version === "") return
    if (version.startsWith(SUPPORTED_VERSION_PREFIX)) return
    throw new TransportUnsupportedError(
      `channel-wechat-bg: WeChatFerry 只支持微信 ${SUPPORTED_VERSION_PREFIX}x，${where} 是 ${version}。` +
        `微信 4.x 无法注入，已拒绝启动${this.dllPath === "" ? "" : `（桥会加载 ${this.dllPath}）`}。`,
      "TRANSPORT_VERSION_UNSUPPORTED",
    )
  }
}
