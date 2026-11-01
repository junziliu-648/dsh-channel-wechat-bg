/**
 * 配置读取层的测试。
 *
 * 这一层的存在理由是宿主把 volatile 字段包成 `{get()}`。测试因此不能只测
 * "普通对象能不能读"，必须测"被包起来的值能不能读" —— 否则这个 bug 会一路
 * 活到生产。
 */

import assert from "node:assert/strict"
import test from "node:test"

import { normalizeConfig, plainConfig, resolveModelSelection, unvolatile } from "../lib/settings.js"

/** 造一个和 `Volatile<T>` 同形的封装。 */
function volatileOf(value) {
  return { get: () => value }
}

test("unvolatile 从封装里取值", () => {
  assert.equal(unvolatile(volatileOf("pad")), "pad")
  assert.equal(unvolatile(volatileOf(0)), 0)
  assert.deepEqual(unvolatile(volatileOf([1, 2])), [1, 2])
})

test("unvolatile 不动普通值", () => {
  assert.equal(unvolatile("pad"), "pad")
  assert.equal(unvolatile(undefined), undefined)
  const map = new Map([["a", 1]])
  assert.equal(unvolatile(map), map, "Map 有 get，但那是 Map 的 get，不能当成封装")
})

test("plainConfig 递归解开 nested 与数组", () => {
  const raw = {
    enabled: volatileOf(true),
    transport: { kind: volatileOf("pad"), token: volatileOf("secret") },
    allow: [{ id: "wxid_x", kind: "dm", enabled: true }],
    rateLimit: { perChatSec: volatileOf(6) },
  }
  assert.deepEqual(plainConfig(raw), {
    enabled: true,
    transport: { kind: "pad", token: "secret" },
    allow: [{ id: "wxid_x", kind: "dm", enabled: true }],
    rateLimit: { perChatSec: 6 },
  })
})

test("normalizeConfig 关掉未知字段、补默认值", () => {
  const out = normalizeConfig({}, { dshHome: "C:/dsh" })
  assert.equal(out.enabled, false, "默认必须是关的")
  assert.equal(out.transport.kind, "pad")
  assert.equal(out.denyUnknown, true)
  assert.equal(out.permission, "read-only")
  assert.deepEqual(out.allow, [])
  assert.equal(out.audit.path, "C:/dsh/wechat-bg-audit.jsonl")
  assert.equal(out.audit.logContent, false, "默认不记录正文")
})

test("normalizeConfig 把扁平 transport 折成适配器要的形状", () => {
  const out = normalizeConfig({
    transport: { kind: "pad", baseUrl: " http://127.0.0.1:8848 ", token: " t " },
  })
  assert.equal(out.transport.pad.baseUrl, "http://127.0.0.1:8848")
  assert.equal(out.transport.pad.token, " t ", "token 原样保留，不 trim 成空、也不改内容")
  assert.deepEqual(out.transport.wechatferry, {
    // wechatferry 走的也是 HTTP（本机的桥），所以两边共用同一份 baseUrl/token。
    baseUrl: "http://127.0.0.1:8848",
    token: " t ",
    dllPath: "",
    wechatVersion: "",
  })
})

test("normalizeConfig 保留显式审计路径", () => {
  const out = normalizeConfig({ audit: { path: "D:/logs/a.jsonl", logContent: true } }, { dshHome: "C:/dsh" })
  assert.equal(out.audit.path, "D:/logs/a.jsonl")
  assert.equal(out.audit.logContent, true)
})

test("normalizeConfig 从不把 denyUnknown 放宽", () => {
  assert.equal(normalizeConfig({ denyUnknown: false }).denyUnknown, false, "这里只如实反映，由 policy 拒绝")
})

test("resolveModelSelection 跟随默认选择", () => {
  const out = resolveModelSelection({ provider: "", model: "" }, () => ({ provider: "p", model: "m" }))
  assert.deepEqual(out, { provider: "p", model: "m" })
})

test("resolveModelSelection 用配置里的选择", () => {
  const out = resolveModelSelection({ provider: "deepseek", model: "chat" }, () => ({ provider: "x", model: "y" }))
  assert.deepEqual(out, { provider: "deepseek", model: "chat" })
})

test("resolveModelSelection 只配一半就抛错", () => {
  assert.throws(() => resolveModelSelection({ provider: "deepseek", model: "" }), /必须同时配置/)
  assert.throws(() => resolveModelSelection({ provider: "", model: "chat" }), /必须同时配置/)
})
