/**
 * `@deepseek-ai/dsh-llm` 的替身。
 *
 * 只有 `test/apply.test.js` 用它：那个测试要跑真正的 `apply()`，而 `apply()`
 * 会经由 `bridge.js` 静态 import 这个包。真的包在 profile 里，Node 从本包目录
 * 解析不到，所以用一份同形的替身顶上去 —— 只实现被用到的那一个函数。
 *
 * 形状必须和真的一致：`createUserMessage({ content, source })` 返回一条
 * user 消息事件。真货还在 source 之外补了时间戳之类的字段，但这里是替身，
 * 多出来的字段对被测代码没有意义。
 */

/**
 * 造一条用户消息。
 *
 * @param {object} input - 消息内容。
 * @param {Array<object>} input.content - 内容块。
 * @param {object} [input.source] - 来源。
 * @returns {object} user 消息事件。
 */
export function createUserMessage({ content, source } = {}) {
  return { type: "user/message", data: { content }, source }
}
