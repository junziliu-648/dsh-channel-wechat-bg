/**
 * 审计日志。
 *
 * 每一条收进来说的话、每一条发出去的话，都记一行 JSONL。默认不记正文 ——
 * 审计的目的是"事后能证明它只跟这两个会话说过话"，而不是留一份聊天记录副本。
 * 真需要正文时把 `logContent` 打开，代价是明文落盘。
 *
 * token、cookie、二维码、密钥任何情况下都不进日志：它们不该出现在错误信息里，
 * 所以 `redact` 在写盘前再兜一次底。
 */

import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

/** 一眼能认出来的密钥形状，写盘前替换掉。 */
const SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(token|secret|password|access_token|api_key)\s*[=:]\s*\S{6,}/gi,
  /\b(?:wxid|qr)[A-Za-z0-9_-]{16,}\b/g,
]

/**
 * 把可能是密钥的片段换成占位符。
 * @param {string} text - 原文。
 * @returns {string} 替换后的文本。
 */
export function redact(text) {
  let out = String(text ?? "")
  out = out.replace(SECRET_PATTERNS[0], "Bearer ***")
  out = out.replace(SECRET_PATTERNS[1], (_match, key) => `${key}=***`)
  return out
}

/**
 * 建一个审计写入器。
 *
 * 写盘失败不能拖垮通道：审计是旁路，不是主路。失败只报告一次，之后继续尝试。
 *
 * @param {object} options - 输出目标。
 * @param {string} options.path - JSONL 文件路径。
 * @param {boolean} [options.logContent] - 是否把正文也写进去，默认不写。
 * @param {() => number} [options.now] - 时钟，测试用。
 * @param {(path: string, text: string) => void} [options.write] - 写入函数，测试用。
 * @returns {{record: (entry: object) => object, path: string}}
 */
export function createAudit({ path, logContent = false, now = () => Date.now(), write } = {}) {
  const target = String(path ?? "").trim()
  let ready = false
  let reported = false
  const sink = write ?? ((file, text) => appendFileSync(file, text, "utf8"))

  /**
   * 写一行审计。
   * @param {object} entry - 审计条目。
   * @param {string} entry.chatId - 会话 ID。
   * @param {'in'|'out'} entry.direction - 收还是发。
   * @param {number} [entry.chars] - 字符数。
   * @param {string} [entry.transport] - 传输类型。
   * @param {string} [entry.result] - 结果码。
   * @param {string} [entry.reason] - 丢弃原因。
   * @param {string} [entry.error] - 错误信息。
   * @param {string} [entry.text] - 正文；只在 logContent 打开时保留。
   * @returns {object} 实际写下去的对象（测试会检查它）。
   */
  function record(entry) {
    const row = {
      ts: new Date(now()).toISOString(),
      chatId: String(entry?.chatId ?? ""),
      direction: entry?.direction === "out" ? "out" : "in",
      chars: Number.isFinite(entry?.chars) ? entry.chars : String(entry?.text ?? "").length,
      transport: String(entry?.transport ?? ""),
      result: String(entry?.result ?? ""),
    }
    if (entry?.reason !== undefined && entry.reason !== "") row.reason = String(entry.reason)
    if (entry?.error !== undefined && entry.error !== "") row.error = redact(entry.error).slice(0, 200)
    if (logContent && typeof entry?.text === "string") row.text = entry.text.slice(0, 2000)

    if (target === "") return row
    try {
      if (!ready) {
        mkdirSync(dirname(target), { recursive: true })
        ready = true
      }
      sink(target, `${JSON.stringify(row)}\n`)
    } catch (error) {
      if (!reported) {
        reported = true
        // 只喊一次，避免磁盘满的时候刷满主日志。
        console.warn(`[channel-wechat-bg] 审计日志写入失败：${redact(error?.message ?? error)}`)
      }
    }
    return row
  }

  return { record, path: target }
}
