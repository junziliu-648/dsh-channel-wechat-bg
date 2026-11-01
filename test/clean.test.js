/**
 * 回复清理的单测。
 *
 * 目标不是"把 Markdown 转成富文本"，而是"别让排版符号出现在聊天窗口里"。
 * 所以断言都朝着一个方向：这些符号不该出现在输出里；内容不该丢。
 */

import assert from "node:assert/strict"
import test from "node:test"

import { cleanReply, truncate } from "../lib/clean.js"

test("去掉标题井号，保留文字", () => {
  assert.equal(cleanReply("## 结论\n今天先休息"), "结论\n今天先休息")
  assert.equal(cleanReply("# 一\n# 二"), "一\n二")
})

test("去掉粗体和行内代码记号", () => {
  assert.equal(cleanReply("**重点**是 `npm test` 要先跑"), "重点是 npm test 要先跑")
  assert.equal(cleanReply("~~旧说法~~"), "旧说法")
})

test("链接只留文字，图片整条删掉", () => {
  assert.equal(cleanReply("看这个 [文档](https://example.com/a) 就行"), "看这个 文档 就行")
  assert.equal(cleanReply("![图](https://example.com/a.png)在下面"), "在下面")
})

test("表格变成一句话，分隔行整行丢掉", () => {
  const cleaned = cleanReply("| 项目 | 状态 |\n| --- | --- |\n| 测试 | 通过 |")
  assert.ok(!cleaned.includes("|"), `不该留下竖线：${cleaned}`)
  assert.ok(cleaned.includes("项目"), "内容要留下")
  assert.ok(cleaned.includes("通过"), "内容要留下")
})

test("代码块去掉围栏、留下代码", () => {
  const cleaned = cleanReply("可以这样跑：\n```bash\nnode --test\n```\n这样就行")
  assert.ok(!cleaned.includes("```"))
  assert.ok(!cleaned.includes("bash"))
  assert.ok(cleaned.includes("node --test"))
})

test("列表符号去掉，内容留下", () => {
  assert.equal(cleanReply("- 第一\n- 第二"), "第一\n第二")
  assert.equal(cleanReply("1. 第一\n2. 第二"), "第一\n第二")
})

test("去掉开头的自称前缀", () => {
  assert.equal(cleanReply("大肥鱼：今天还行", { ownNames: ["大肥鱼"] }), "今天还行")
  assert.equal(cleanReply("工作助理: 收到", { ownNames: ["工作助理"] }), "收到")
})

test("超过 300 字会被截断并加省略号", () => {
  const long = "啊".repeat(500)
  const cleaned = cleanReply(long, { maxChars: 300 })
  assert.equal(Array.from(cleaned).length, 300)
  assert.ok(cleaned.endsWith("…"))
})

test("截断优先切在句末标点之后", () => {
  const text = "第一句说完了。".repeat(20)
  const cleaned = cleanReply(text, { maxChars: 40 })
  assert.ok(cleaned.endsWith("。…"), `应该在句号处收尾：${cleaned}`)
  assert.ok(Array.from(cleaned).length <= 40)
})

test("截断不会把 emoji 劈成半个", () => {
  const text = "🐟".repeat(500)
  const cleaned = truncate(text, 10)
  assert.equal(Array.from(cleaned).length, 10)
  assert.ok(!cleaned.includes("\uFFFD"))
})

test("空输入与纯排版符号产出空串", () => {
  for (const input of ["", "   ", "###", "---", "***", "```\n```"]) {
    assert.equal(cleanReply(input), "", JSON.stringify(input))
  }
})
