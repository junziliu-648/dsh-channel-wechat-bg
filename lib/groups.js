/**
 * 从微信那边要一份"我有哪些群"。
 *
 * 桥（uia-bridge）只认 `/health`、`/events`、`/allow`、`/send` 四条协议，
 * 没有"列群"的接口 —— 那是刻意的：桥越小越好审，多一个接口就多一份攻击面。
 * 所以列群交给一个独立的、只读的小服务（`scripts/wx-groups.py`，默认 8891），
 * 它只读数据库、不发消息、不改任何东西。
 *
 * 拿不到就当没有：设置页显示"暂时读不到群列表"，而不是让整页打不开。
 */

import { DEFAULT_GROUPS_PORT } from "./transport/uia.js"

/** 超时。列群只是给下拉框用的，卡五秒以上就该放弃。 */
export const GROUPS_TIMEOUT_MS = 5000

/**
 * 猜群列表服务的地址。
 *
 * 从桥的地址里取主机名，端口固定 8891：桥和列群服务通常跑在同一台机器上，
 * 让用户为这件事再填一个地址是没必要的负担。
 *
 * @param {string} [baseUrl] - 桥地址。
 * @param {string} [explicit] - 显式配置的地址，优先。
 * @returns {string} 群列表服务地址。
 */
export function resolveGroupsUrl(baseUrl, explicit) {
  const given = String(explicit ?? "").trim()
  if (given !== "") return given.replace(/\/+$/, "")
  let host = "127.0.0.1"
  try {
    const url = new URL(String(baseUrl ?? "").trim() === "" ? "http://127.0.0.1" : baseUrl)
    // Node 的 URL.hostname 对 IPv6 会带方括号，先剥掉，最后再按需加回去。
    const name = url.hostname.replace(/^\[|\]$/g, "")
    host = name === "" ? "127.0.0.1" : name
  } catch {
    /* 解析不了就用本机 */
  }
  const bracketed = host.includes(":") ? `[${host}]` : host
  return `http://${bracketed}:${DEFAULT_GROUPS_PORT}`
}

/**
 * 拉一份群列表。
 *
 * @param {object} options - 参数。
 * @param {string} options.url - 服务地址。
 * @param {typeof fetch} [options.fetch] - fetch 实现。
 * @param {number} [options.timeoutMs] - 超时。
 * @returns {Promise<{groups: Array<{id: string, name: string}>, error?: string}>} 结果。
 */
export async function fetchGroups({ url, fetch: fetchImpl = fetch, timeoutMs = GROUPS_TIMEOUT_MS } = {}) {
  const target = `${String(url ?? "").replace(/\/+$/, "")}/groups`
  let response
  try {
    response = await fetchImpl(target, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    return { groups: [], error: `连不上列群服务（${target}）：${String(error?.message ?? error).slice(0, 160)}` }
  }
  if (response.ok !== true) {
    return { groups: [], error: `列群服务返回 HTTP ${response.status}` }
  }
  let body
  try {
    body = await response.json()
  } catch (error) {
    return { groups: [], error: `列群服务返回的不是 JSON：${String(error?.message ?? error).slice(0, 120)}` }
  }
  if (body?.ok !== true) {
    return { groups: [], error: String(body?.error ?? "列群服务没给出 ok: true") }
  }
  const groups = []
  for (const item of Array.isArray(body?.groups) ? body.groups : []) {
    const id = String(item?.id ?? "").trim()
    if (id === "" || !id.endsWith("@chatroom")) continue
    groups.push({ id, name: String(item?.name ?? "").trim() })
  }
  return { groups }
}
