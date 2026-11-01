/**
 * 白名单规则的单测。
 *
 * 这一组是插件存在的理由：只有两个会话能跟它说话。所以这些断言写得比别处更死 ——
 * 一旦有人放宽了规则，这里会先红。
 */

import assert from "node:assert/strict"
import test from "node:test"

import {
  DM_JUNZILIU,
  GROUP_TEST,
  createPolicy,
  stripTriggers,
} from "../lib/policy.js"

/** @returns {object} 默认白名单的判断器。 */
function policy() {
  return createPolicy()
}

test("私聊：小明发来的消息可以回", () => {
  const decision = policy().decide({
    chatId: DM_JUNZILIU,
    chatKind: "dm",
    senderId: DM_JUNZILIU,
    text: "今天累吗",
    mentionedBot: false,
  })
  assert.equal(decision.action, "reply")
  assert.equal(decision.entry.label, "小明")
  assert.equal(decision.entry.persona, "大肥鱼")
  assert.equal(decision.text, "今天累吗")
})

test("私聊：别的 wxid 一律拒绝", () => {
  for (const chatId of ["wxid_someoneelse11", "wxid_", "12345678@chatroom", "filehelper"]) {
    const decision = policy().decide({ chatId, chatKind: "dm", senderId: chatId, text: "在吗" })
    assert.equal(decision.action, "drop", `${chatId} 不该被回`)
    assert.equal(decision.reason, "not-allowlisted")
  }
})

test("群聊：@ 了才回，并去掉触发词", () => {
  const decision = policy().decide({
    chatId: GROUP_TEST,
    chatKind: "group",
    senderId: "wxid_friend",
    text: "@大肥鱼 今天跑步了吗",
    mentionedBot: true,
  })
  assert.equal(decision.action, "reply")
  assert.equal(decision.entry.label, "测试")
  assert.equal(decision.entry.persona, "工作助理")
  assert.equal(decision.text, "今天跑步了吗")
})

test("群聊：没 @ 就闭嘴", () => {
  const decision = policy().decide({
    chatId: GROUP_TEST,
    chatKind: "group",
    senderId: "wxid_friend",
    text: "今天天气不错",
    mentionedBot: false,
  })
  assert.equal(decision.action, "drop")
  assert.equal(decision.reason, "no-mention")
})

test("群聊：只写了触发词、没有正文时不回", () => {
  const decision = policy().decide({
    chatId: GROUP_TEST,
    chatKind: "group",
    senderId: "wxid_friend",
    text: "@大肥鱼",
    mentionedBot: true,
  })
  assert.equal(decision.action, "drop")
  assert.equal(decision.reason, "mention-only")
})

test("群聊：适配器自己识别出 @ 也算数", () => {
  const decision = policy().decide({
    chatId: GROUP_TEST,
    chatKind: "group",
    senderId: "wxid_friend",
    text: "@大肥鱼 这个报错怎么解",
    mentionedBot: true,
  })
  assert.equal(decision.action, "reply")
})

test("自己发的消息不回", () => {
  const decision = policy().decide({
    chatId: DM_JUNZILIU,
    senderId: "wxid_me",
    selfId: "wxid_me",
    text: "我刚才说了一句",
  })
  assert.equal(decision.action, "drop")
  assert.equal(decision.reason, "self")
})

test("空消息、纯空白不回", () => {
  for (const text of ["", "   ", "\n\t "]) {
    const decision = policy().decide({ chatId: DM_JUNZILIU, text })
    assert.equal(decision.action, "drop")
    assert.equal(decision.reason, "empty")
  }
})

test("声称的会话类型和白名单对不上时拒绝", () => {
  const decision = policy().decide({
    chatId: GROUP_TEST,
    chatKind: "dm",
    senderId: "wxid_friend",
    text: "@大肥鱼 在吗",
    mentionedBot: true,
  })
  assert.equal(decision.action, "drop")
  assert.equal(decision.reason, "kind-mismatch")
})

test("白名单项被单独关掉时不回", () => {
  const decision = createPolicy({ allow: [{ id: DM_JUNZILIU, kind: "dm", reply: "always", enabled: false }] }).decide({
    chatId: DM_JUNZILIU,
    text: "在吗",
  })
  assert.equal(decision.action, "drop")
  assert.equal(decision.reason, "entry-disabled")
})

test("denyUnknown 只接受 true", () => {
  assert.throws(() => createPolicy({ denyUnknown: false }), /denyUnknown/)
  assert.throws(() => createPolicy({ denyUnknown: "yes" }), /denyUnknown/)
})

test("白名单项写错时立刻报错，而不是悄悄变成 always", () => {
  assert.throws(() => createPolicy({ allow: [{ id: DM_JUNZILIU, kind: "nope" }] }), /kind/)
  assert.throws(() => createPolicy({ allow: [{ id: DM_JUNZILIU, kind: "dm", reply: "sometimes" }] }), /reply/)
  assert.throws(() => createPolicy({ allow: [{ kind: "dm" }] }), /id/)
})

test("stripTriggers 去掉触发词并压缩空白", () => {
  assert.equal(stripTriggers("@大肥鱼 你好", ["@大肥鱼"]), "你好")
  assert.equal(stripTriggers("@大肥鱼@大肥鱼  在吗", ["@大肥鱼"]), "在吗")
  assert.equal(stripTriggers("没有触发词", ["@大肥鱼"]), "没有触发词")
})
