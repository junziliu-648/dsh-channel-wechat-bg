/**
 * Pad 协议传输（HTTP）。
 *
 * "Pad 协议"指的是第三方托管的协议端：对方用一台"平板"登录你的微信号，然后把
 * 收发包成 HTTP/SSE 给你。它天然是后台的 —— 整条链路里没有窗口、没有键鼠、
 * 没有剪贴板，所以 `backgroundSend` 在这里是**结构上成立**的，不是自夸。
 *
 * 代价写在 TRANSPORT.md 里：要付费、要信任第三方、违反微信服务条款、有封号
 * 风险。代码能做的只有把话说清楚，以及把 token 当成密钥对待。
 *
 * 连接、鉴权、重连、SSE 解析都在 `http-link.js` 里，`wechatferry` 共用同一套。
 */

import { HttpLinkTransport } from "./http-link.js"

export class PadTransport extends HttpLinkTransport {
  /**
   * @param {object} options - 服务地址与凭据。
   * @param {string} options.baseUrl - 协议端地址，必须带 http/https。
   * @param {string} [options.token] - Bearer token。
   * @param {typeof fetch} [options.fetch] - fetch 实现，测试用。
   * @param {(message: string) => void} [options.log] - 日志函数。
   */
  constructor(options = {}) {
    super({ ...options, kind: "pad", label: "Pad 协议端" })
  }

  notConfiguredMessage() {
    return (
      "channel-wechat-bg: transport.kind=pad 但没有配置 transport.baseUrl。" +
      "没有任何后台传输可用，已拒绝启动（不会退回到 UI 自动化）。"
    )
  }
}
