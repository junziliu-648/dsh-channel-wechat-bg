/**
 * 设置页的数据层：白名单群聊 + 群聊唤醒前缀。
 *
 * 为什么不写回 `cordis.patch.yml`：
 *
 *   - 那张表是"用户手写的配置"，每个字段旁边都可能有人的注释。程序去改它，
 *     下一个改配置的人就会对着一堆自己没写过的行发愣。
 *   - 白名单是数组套对象，`configForms` 只能写"单段路径的字符串字段"
 *     （见 dsh-channel-wechat 的 client.js 注释），根本写不回去。
 *
 * 所以状态单独存一份 `<DSH_HOME>/channel-wechat-bg/settings.json`，它有值时
 * **覆盖**配置里的群聊条目，没有值时一切按配置走。这样手改配置仍然有效，
 * 只是会被设置页显式改过的部分盖住。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { DEFAULT_STICKER_RATE, STICKER_RATE_IDS, STICKER_RATE_LABELS } from "./personas.js"

/** 群聊唤醒前缀的默认值。跟历史行为保持一致：英文感叹号。 */
export const DEFAULT_WAKE_PREFIX = "!"

/** 群聊条目的默认人设。设置页新加的群不会问人设，用一个中性的。 */
export const DEFAULT_GROUP_PERSONA = "大肥鱼"

/**
 * 收敛表情档位。认不出来的值一律退回默认，不让一个手抖的字符串把提示词弄空。
 * @param {unknown} value - 原始值。
 * @returns {string} 档位 id。
 */
export function normalizeStickerRate(value) {
  const rate = String(value ?? "").trim()
  return STICKER_RATE_IDS.includes(rate) ? rate : DEFAULT_STICKER_RATE
}

/**
 * 设置文件的位置。
 * @param {string} dshHome - DSH 根目录。
 * @returns {string} 路径。
 */
export function settingsPath(dshHome) {
  const root = String(dshHome ?? "").trim()
  if (root === "") return ""
  return join(root, "channel-wechat-bg", "settings.json")
}

/**
 * 读设置文件。读不到、坏了、没这个文件，都当作"没设置过"。
 *
 * 一个坏掉的小文件不该让整条通道起不来：白名单还有配置里那份兜着。
 *
 * @param {string} path - 文件路径。
 * @param {(message: string) => void} [warn] - 警告函数。
 * @returns {{groups: Array<{id: string, label: string}>, wakePrefix: string}} 设置。
 */
export function readStore(path, warn = () => {}) {
  const empty = { groups: [], wakePrefix: DEFAULT_WAKE_PREFIX, stickerRate: DEFAULT_STICKER_RATE, configured: false }
  if (String(path ?? "") === "") return empty
  let raw
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return empty
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    warn(`设置文件不是合法 JSON，已忽略：${error?.message ?? error}`)
    return empty
  }
  // 读到了文件就说明用户在设置页动过：哪怕 groups 是空数组，也代表"我把群都取消了"，
  // 这时候不能退回配置里的旧群。
  return { ...normalizeStore(parsed), configured: true }
}

/**
 * 把任意形状的对象收敛成设置。
 * @param {object} value - 原始值。
 * @returns {{groups: Array<{id: string, label: string}>, wakePrefix: string}} 设置。
 */
export function normalizeStore(value) {
  const groups = []
  const seen = new Set()
  for (const item of Array.isArray(value?.groups) ? value.groups : []) {
    const id = String(item?.id ?? "").trim()
    if (id === "" || seen.has(id)) continue
    seen.add(id)
    groups.push({ id, label: String(item?.label ?? "").trim() })
  }
  const prefix = String(value?.wakePrefix ?? "").trim()
  return {
    groups,
    wakePrefix: prefix === "" ? DEFAULT_WAKE_PREFIX : prefix,
    stickerRate: normalizeStickerRate(value?.stickerRate),
  }
}

/**
 * 写设置文件。写失败要抛：设置页不能假装保存成功。
 * @param {string} path - 文件路径。
 * @param {{groups: Array<{id: string, label: string}>, wakePrefix: string}} value - 要写的设置。
 * @returns {object} 归一化后真正写下去的内容。
 */
export function writeStore(path, value) {
  if (String(path ?? "") === "") throw new Error("channel-wechat-bg: DSH_HOME 没有设置，无法保存设置。")
  const normalized = normalizeStore(value)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`, "utf8")
  return normalized
}

/**
 * 把存储的设置合到配置的白名单上。
 *
 * 规则：
 *   - 私聊条目永远来自配置。设置页只管群，"谁能私聊它"不该被一个勾选框改掉。
 *   - 存储里有群条目时，它们**替换**配置里的群条目；存储里是空数组时，
 *     表示"用户把群全取消了"，这时候不该退回配置里的旧群 —— 那会让取消无效。
 *   - 存储完全没设置过（`configured: false`）时才用配置里的群。
 *
 * @param {object[]} configAllow - 配置里的白名单。
 * @param {{groups: Array<{id: string, label: string}>, wakePrefix: string}} store - 存储的设置。
 * @param {{configured?: boolean, persona?: string}} [options] - 是否真的读过设置文件。
 * @returns {object[]} 生效的白名单。
 */
export function effectiveAllow(configAllow, store, options = {}) {
  const base = Array.isArray(configAllow) ? configAllow : []
  const direct = base.filter((entry) => entry?.kind !== "group")
  if (options.configured !== true) return [...base]

  const persona = String(options.persona ?? "").trim() || DEFAULT_GROUP_PERSONA
  const prefix = store.wakePrefix === "" ? DEFAULT_WAKE_PREFIX : store.wakePrefix
  // 配置里手写过的群保留它的人设与开关：勾选框只决定"这个群算不算数"，
  // 不该顺手把别人写在配置文件里的人设换掉。
  const known = new Map()
  for (const entry of base) {
    if (entry?.kind !== "group") continue
    known.set(entry.id, entry)
  }
  const groups = store.groups.map((group) => {
    const previous = known.get(group.id)
    const label = String(group.label ?? "").trim()
    return {
      id: group.id,
      kind: "group",
      label: label || String(previous?.label ?? "").trim() || group.id,
      persona: String(previous?.persona ?? "").trim() || persona,
      reply: previous?.reply === "always" ? "always" : "mention",
      triggers: [prefix],
      enabled: previous?.enabled === false ? false : true,
    }
  })
  return [...direct, ...groups]
}

/**
 * 设置页要展示的一份快照。
 *
 * @param {object} options - 输入。
 * @param {object[]} options.allow - 生效的白名单。
 * @param {{groups: Array<{id: string, label: string}>, wakePrefix: string}} options.store - 存储的设置。
 * @param {Array<{id: string, name: string}>} [options.available] - 微信里能看到的群。
 * @param {string} [options.availableError] - 拿不到群列表时的原因。
 * @returns {object} 快照。
 */
export function settingsSnapshot({ allow, store, available = [], availableError }) {
  const selected = new Set(Array.isArray(allow) ? allow.filter((e) => e?.kind === "group").map((e) => e.id) : [])
  const rows = []
  const seen = new Set()
  for (const group of available) {
    const id = String(group?.id ?? "").trim()
    if (id === "" || seen.has(id)) continue
    seen.add(id)
    rows.push({ id, name: String(group?.name ?? "").trim() || id, selected: selected.has(id) })
  }
  // 已经选上、但这次没从微信里列出来的群（改名、还没收到新消息、桥连不上）也要显示，
  // 否则用户会以为自己勾的东西丢了。
  for (const entry of Array.isArray(allow) ? allow : []) {
    if (entry?.kind !== "group" || seen.has(entry.id)) continue
    seen.add(entry.id)
    rows.push({ id: entry.id, name: String(entry.label ?? "").trim() || entry.id, selected: true })
  }
  return {
    wakePrefix: store.wakePrefix === "" ? DEFAULT_WAKE_PREFIX : store.wakePrefix,
    stickerRate: normalizeStickerRate(store.stickerRate),
    stickerRates: STICKER_RATE_IDS.map((id) => ({ id, label: STICKER_RATE_LABELS[id] })),
    groups: rows,
    availableError: availableError === undefined ? undefined : String(availableError),
    allow: (Array.isArray(allow) ? allow : []).map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      label: entry.label,
      reply: entry.reply,
      triggers: entry.triggers,
      enabled: entry.enabled,
    })),
  }
}

/**
 * 把设置页提交的内容收敛成"要写的设置"。
 *
 * 群的名字从当前生效的白名单里找，找不到就用 id 占位 —— 设置页只提交 id，
 * 名字是界面上的东西，不该让客户端决定存什么。
 *
 * @param {{groupIds?: string[], wakePrefix?: string}} body - 提交体。
 * @param {object[]} allow - 当前生效的白名单。
 * @returns {{groups: Array<{id: string, label: string}>, wakePrefix: string}} 设置。
 */
export function settingsFromBody(body, allow, available = []) {
  const labels = new Map()
  for (const entry of Array.isArray(allow) ? allow : []) {
    if (entry?.kind === "group") labels.set(entry.id, String(entry.label ?? "").trim())
  }
  // 新勾上的群在 allow 里还没有条目，名字只能从"这次列出来的群"里拿。
  // 不在这里记下来的话，存进去的 label 就是空串，界面上只能显示一群 wxid。
  const freshNames = new Map()
  for (const group of Array.isArray(available) ? available : []) {
    const id = String(group?.id ?? "").trim()
    const name = String(group?.name ?? "").trim()
    if (id !== "" && name !== "") freshNames.set(id, name)
  }
  const byId = new Map()
  for (const raw of Array.isArray(body?.groupIds) ? body.groupIds : []) {
    const id = String(raw ?? "").trim()
    if (id === "" || byId.has(id)) continue
    byId.set(id, labels.get(id) ?? freshNames.get(id) ?? "")
  }
  const prefix = String(body?.wakePrefix ?? "").trim()
  return {
    groups: [...byId].map(([id, label]) => ({ id, label })),
    wakePrefix: prefix === "" ? DEFAULT_WAKE_PREFIX : prefix,
    stickerRate: normalizeStickerRate(body?.stickerRate),
  }
}

/**
 * 用这次列出来的群名，补上存储里空着的 label。
 *
 * 群名是"能读到就顺手记下来"的东西：读不到时留空、读到了就补，这样即便当初
 * 是空着的，下一次打开设置页也会自动变好，不用谁专门去点保存。
 *
 * @param {{groups: Array<{id: string, label: string}>, wakePrefix: string}} store - 已存储的设置。
 * @param {Array<{id: string, name: string}>} available - 这次列出来的群。
 * @returns {{store: object, changed: boolean}} 补过名字的设置，以及是否真的变了。
 */
export function healLabels(store, available = []) {
  const names = new Map()
  for (const group of Array.isArray(available) ? available : []) {
    const id = String(group?.id ?? "").trim()
    const name = String(group?.name ?? "").trim()
    if (id !== "" && name !== "") names.set(id, name)
  }
  let changed = false
  const groups = (Array.isArray(store?.groups) ? store.groups : []).map((group) => {
    const id = String(group?.id ?? "").trim()
    const label = String(group?.label ?? "").trim()
    if (label !== "" || id === "") return group
    const name = names.get(id)
    if (name === undefined) return group
    changed = true
    return { ...group, label: name }
  })
  return { store: { ...store, groups }, changed }
}
