/**
 * 把模型输出收拾成"能直接发到微信里的一段话"。
 *
 * 聊天窗口不是 Markdown 渲染器：`## 结论` 会原样显示成一串井号，`**重点**` 会
 * 显示成带星号的字，表格会变成一堆竖线。这个模块只做减法 —— 去掉排版符号、
 * 合并空行、截到上限 —— 不重写语气，也不替模型补话。
 */

/** 句末标点。截断时优先切在这些字符之后，读起来才不像被腰斩。 */
const SENTENCE_END = /[。！？!?…；;]$/

/**
 * 清理一段准备发出去的回复。
 *
 * @param {string} text - 模型原始输出。
 * @param {object} [options] - 上限与人设名。
 * @param {number} [options.maxChars] - 最多多少个字符，默认 300。
 * @param {string[]} [options.ownNames] - 回复开头不该出现的自称。
 * @returns {string} 可以直接发送的纯文本；没有内容时返回空串。
 */
export function cleanReply(text, { maxChars = 300, ownNames = [] } = {}) {
  let out = String(text ?? "").replace(/\r\n/g, "\n")

  // 代码块：留内容、去围栏。带语言标注的第一行（```js）也一起删。
  out = out.replace(/```[^\n]*\n([\s\S]*?)```/g, "$1")
  out = out.replace(/```/g, "")

  // 行内代码、粗体、斜体、删除线。
  out = out.replace(/`([^`\n]+)`/g, "$1")
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "$1")
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1$2")
  out = out.replace(/__([^_\n]+)__/g, "$1")
  out = out.replace(/~~([^~\n]+)~~/g, "$1")

  // 图片整条删掉，链接留文字。
  out = out.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")

  const lines = out.split("\n").map((line) => {
    let next = line
    // 标题：去掉井号与后面的空格。
    next = next.replace(/^\s{0,3}#{1,6}\s*/, "")
    // 引用。
    next = next.replace(/^\s{0,3}>\s?/, "")
    // 表格分隔行（|---|---|）整行丢。
    if (/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(next) && next.includes("-")) return ""
    // 表格行：竖线当分隔符，单元格之间用顿号连起来更像中文。
    if (next.includes("|")) {
      const cells = next
        .split("|")
        .map((cell) => cell.trim())
        .filter((cell) => cell !== "")
      if (cells.length > 1) next = cells.join("、")
    }
    // 无序列表与有序列表：去掉记号，留内容。
    next = next.replace(/^\s*[-*+]\s+/, "")
    next = next.replace(/^\s*\d+[.)]\s+/, "")
    // 水平线整行丢。
    if (/^\s*([-*_])\1{2,}\s*$/.test(next)) return ""
    return next.trimEnd()
  })

  out = lines.join("\n")
  // 三个以上连续空行压成两个（中文聊天里一个空行就够分段了）。
  out = out.replace(/\n{3,}/g, "\n\n").trim()

  // 有些模型会用"大肥鱼：……"开头，微信里没有这个前缀的位置。
  for (const ownName of ownNames) {
    const name = String(ownName).trim()
    if (name === "") continue
    out = out.replace(new RegExp(`^${escapeRegExp(name)}\\s*[:：,，]?\\s*`), "")
  }

  out = out.trim()
  if (out === "") return ""
  return truncate(out, maxChars)
}

/**
 * 截到上限，尽量切在句末。
 *
 * 为什么不拆成多条发：连着刷三条"（1/3）（2/3）（3/3）"在私聊里很吵，而且一旦
 * 中间某条被限流，对方看到的就是半句话。宁可少说，也不刷屏 —— 这是插件 §9 的
 * 选择。
 *
 * @param {string} text - 文本。
 * @param {number} maxChars - 上限。
 * @returns {string} 截断后的文本。
 */
export function truncate(text, maxChars) {
  const limit = Math.max(1, Math.trunc(Number(maxChars) || 300))
  // 按码点切，避免把一个 emoji 或汉字劈成半个。
  const chars = Array.from(text)
  if (chars.length <= limit) return text
  const head = chars.slice(0, limit - 1)
  // 从后往前找句末标点，最多回退 30 个字符，找不到就硬截。
  for (let i = head.length - 1; i >= Math.max(0, head.length - 30); i -= 1) {
    if (SENTENCE_END.test(head[i])) return head.slice(0, i + 1).join("").trimEnd() + "…"
  }
  return head.join("").trimEnd() + "…"
}

/**
 * 把一个字符串转成可以直接放进正则的字面量。
 * @param {string} text - 原文。
 * @returns {string} 转义后的文本。
 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
