/**
 * 传输工厂。
 *
 * 认得四种 kind：`mock`（测试）、`pad`（HTTP 协议端）、`wechatferry`（本机注入桥）、
 * `uia`（本机前台桥：读库收、界面发）。别的 kind 一律抛
 * `TransportNotConfiguredError` —— 配置写错时要立刻停下，而不是落到某个"默认实现"
 * 上去。这里没有默认实现。
 */

import { TransportNotConfiguredError } from "./base.js"
import { MockTransport } from "./mock.js"
import { PadTransport } from "./pad.js"
import { UiaTransport, UIA_CAPABILITIES, UIA_DEFAULT_URL } from "./uia.js"
import { WeChatFerryTransport } from "./wechatferry.js"

export { MockTransport } from "./mock.js"
export { PadTransport } from "./pad.js"
export { UiaTransport, UIA_CAPABILITIES, UIA_DEFAULT_URL } from "./uia.js"
export { WeChatFerryTransport } from "./wechatferry.js"
export {
  TransportError,
  TransportNotConfiguredError,
  TransportUnsupportedError,
  FULL_CAPABILITIES,
  FOREGROUND_CAPABILITIES,
  assertBackgroundSend,
  assertSendCapability,
  normalizeInbound,
} from "./base.js"

/** 认得的 kind。写在这里是为了让错误信息能一次列全。 */
export const TRANSPORT_KINDS = Object.freeze(["mock", "pad", "wechatferry", "uia"])

/**
 * 按配置建一个传输适配器。
 *
 * 注意这里只建对象、不启动。启动是 pipeline 的事，启动时会校验能力声明。
 *
 * @param {object} config - 传输配置。
 * @param {string} [config.kind] - 传输类型。
 * @param {object} [config.pad] - pad 参数。
 * @param {object} [config.wechatferry] - wechatferry 参数。
 * @param {object} [config.uia] - uia 参数。
 * @param {object} [options] - 额外注入。
 * @param {typeof fetch} [options.fetch] - fetch 实现，测试用。
 * @param {(message: string) => void} [options.log] - 日志函数。
 * @param {Array<object>} [options.allow] - 白名单，uia 需要推给桥。
 * @returns {object} 传输适配器。
 * @throws {TransportNotConfiguredError} 当 kind 不认识时。
 */
export function createTransport(config, { fetch, log, allow } = {}) {
  const kind = String(config?.kind ?? "").trim()
  if (kind === "mock") return new MockTransport(config?.mock)
  if (kind === "pad") {
    return new PadTransport({
      baseUrl: config?.pad?.baseUrl,
      token: config?.pad?.token,
      fetch,
      log,
    })
  }
  if (kind === "wechatferry") {
    return new WeChatFerryTransport({
      // baseUrl/token 是几种 HTTP 传输共用的那一层：默认地址由传输自己给
      // （wechatferry 默认指向本机的桥）。
      baseUrl: config?.wechatferry?.baseUrl ?? config?.baseUrl,
      token: config?.wechatferry?.token ?? config?.token,
      dllPath: config?.wechatferry?.dllPath,
      wechatVersion: config?.wechatferry?.wechatVersion,
      fetch,
      log,
    })
  }
  if (kind === "uia") {
    return new UiaTransport({
      baseUrl: config?.uia?.baseUrl ?? config?.baseUrl,
      token: config?.uia?.token ?? config?.token,
      allow,
      fetch,
      log,
    })
  }
  throw new TransportNotConfiguredError(
    `channel-wechat-bg: transport.kind=${JSON.stringify(config?.kind)} 不认识，可选值只有 ${TRANSPORT_KINDS.join(" / ")}。` +
      "没有任何传输可用，已拒绝启动。",
  )
}
