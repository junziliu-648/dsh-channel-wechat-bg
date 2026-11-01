import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  DEFAULT_WAKE_PREFIX,
  effectiveAllow,
  normalizeStickerRate,
  normalizeStore,
  readStore,
  settingsFromBody,
  settingsPath,
  healLabels,
  settingsSnapshot,
  writeStore,
} from "../lib/settings-store.js"

/** 一个临时的 DSH 主目录。 */
function tempHome() {
  return mkdtempSync(join(tmpdir(), "cwb-settings-"))
}

/** 配置里的那份白名单：一条私聊 + 一条群。 */
function configAllow() {
  return [
    { id: "wxid_boss", kind: "dm", label: "小明", persona: "大肥鱼", reply: "always", triggers: [], enabled: true },
    {
      id: "old@chatroom",
      kind: "group",
      label: "旧群",
      persona: "工作助理",
      reply: "mention",
      triggers: ["@"],
      enabled: true,
    },
  ]
}

test("settingsPath 跟着 DSH_HOME 走，没设置就返回空串", () => {
  assert.equal(settingsPath(""), "")
  assert.equal(settingsPath("/x/dsh"), join("/x/dsh", "channel-wechat-bg", "settings.json"))
})

test("normalizeStore 去掉重复 id、空 id，前缀为空时回默认值", () => {
  const store = normalizeStore({
    groups: [{ id: " a@chatroom ", label: "A" }, { id: "a@chatroom" }, { id: "" }, null],
    wakePrefix: "  ",
  })
  assert.deepEqual(store.groups, [{ id: "a@chatroom", label: "A" }])
  assert.equal(store.wakePrefix, DEFAULT_WAKE_PREFIX)
})

test("没设置过时 readStore 返回 configured:false，且不动配置里的群", () => {
  const home = tempHome()
  try {
    const store = readStore(settingsPath(home))
    assert.equal(store.configured, false)
    assert.deepEqual(store.groups, [])
    assert.equal(store.wakePrefix, "!")
    const allow = effectiveAllow(configAllow(), store, { configured: store.configured })
    assert.deepEqual(allow.map((entry) => entry.id), ["wxid_boss", "old@chatroom"])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("写进去再读出来，是同一份", () => {
  const home = tempHome()
  try {
    const path = settingsPath(home)
    writeStore(path, { groups: [{ id: "new@chatroom", label: "测试" }], wakePrefix: "#" })
    const store = readStore(path)
    assert.equal(store.configured, true)
    assert.deepEqual(store.groups, [{ id: "new@chatroom", label: "测试" }])
    assert.equal(store.wakePrefix, "#")
    // 落盘的是给人看的 JSON，不是压成一行的转义串。
    assert.match(readFileSync(path, "utf8"), /\n {2}"wakePrefix": "#"/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("坏掉的设置文件当没设置过，但会告警", () => {
  const home = tempHome()
  try {
    const path = settingsPath(home)
    mkdirSync(join(home, "channel-wechat-bg"), { recursive: true })
    writeFileSync(path, "{不是 JSON", "utf8")
    const warnings = []
    const store = readStore(path, (message) => warnings.push(message))
    assert.equal(store.configured, false)
    assert.equal(warnings.length, 1)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("设置了群之后，群条目被替换，私聊条目原样保留", () => {
  const store = {
    groups: [{ id: "new@chatroom", label: "测试" }],
    wakePrefix: "#",
    configured: true,
  }
  const allow = effectiveAllow(configAllow(), store, { configured: true, persona: "大肥鱼" })
  assert.deepEqual(allow.map((entry) => entry.id), ["wxid_boss", "new@chatroom"])
  const group = allow[1]
  assert.equal(group.kind, "group")
  assert.equal(group.reply, "mention")
  assert.deepEqual(group.triggers, ["#"])
  assert.equal(group.persona, "大肥鱼")
  assert.equal(allow[0].persona, "大肥鱼", "私聊条目不该被改写")
})

test("把群全取消（空数组）就是真的没有群，不退回配置里的旧群", () => {
  const store = { groups: [], wakePrefix: "!", configured: true }
  const allow = effectiveAllow(configAllow(), store, { configured: true })
  assert.deepEqual(allow.map((entry) => entry.id), ["wxid_boss"])
})

test("群名缺省时用 id 当名字，不会渲染出一个空白行", () => {
  const store = { groups: [{ id: "x@chatroom", label: "" }], wakePrefix: "!", configured: true }
  const allow = effectiveAllow(configAllow(), store, { configured: true })
  assert.equal(allow[1].label, "x@chatroom")
})

test("settingsFromBody 只收群 id、去重、名字从生效白名单里找", () => {
  const allow = [
    { id: "wxid_boss", kind: "dm", label: "小明" },
    { id: "a@chatroom", kind: "group", label: "A 群" },
  ]
  const next = settingsFromBody({ groupIds: ["a@chatroom", "a@chatroom", " ", "b@chatroom"], wakePrefix: " ？ " }, allow)
  assert.deepEqual(next.groups, [
    { id: "a@chatroom", label: "A 群" },
    { id: "b@chatroom", label: "" },
  ])
  assert.equal(next.wakePrefix, "？")
})

test("settingsFromBody 的前缀留空时回到默认值", () => {
  const next = settingsFromBody({ groupIds: [], wakePrefix: "" }, [])
  assert.equal(next.wakePrefix, DEFAULT_WAKE_PREFIX)
  assert.deepEqual(next.groups, [])
})

test("快照把微信里的群和已勾选合并：已选但这次没列出来的也要在", () => {
  const allow = [
    { id: "wxid_boss", kind: "dm", label: "小明" },
    { id: "a@chatroom", kind: "group", label: "A 群" },
    { id: "gone@chatroom", kind: "group", label: "很久没说话的群" },
  ]
  const snapshot = settingsSnapshot({
    allow,
    store: { groups: [{ id: "a@chatroom", label: "A 群" }], wakePrefix: "#" },
    available: [{ id: "a@chatroom", name: "A 群" }, { id: "b@chatroom", name: "B 群" }],
  })
  assert.equal(snapshot.wakePrefix, "#")
  assert.deepEqual(snapshot.groups, [
    { id: "a@chatroom", name: "A 群", selected: true },
    { id: "b@chatroom", name: "B 群", selected: false },
    { id: "gone@chatroom", name: "很久没说话的群", selected: true },
  ])
  // 私聊不进勾选列表：它归配置管。
  assert.ok(!snapshot.groups.some((row) => row.id === "wxid_boss"))
})

test("快照带上读不到群列表的原因，界面才能解释为什么只有几个", () => {
  const snapshot = settingsSnapshot({
    allow: [],
    store: { groups: [], wakePrefix: "!" },
    available: [],
    availableError: "连不上列群服务",
  })
  assert.equal(snapshot.availableError, "连不上列群服务")
  assert.deepEqual(snapshot.groups, [])
})

test("显式设过之后：群跟着勾选走，私聊还留在原配置里", () => {
  const store = { version: 1, wakePrefix: "小鱼", groups: [{ id: "g1@chatroom", label: "测试" }] }
  const base = [
    { id: "wxid_me", kind: "dm", label: "小明", persona: "大肥鱼", reply: "always", triggers: [] },
    { id: "old@chatroom", kind: "group", label: "老群", persona: "工作助理", reply: "mention", triggers: ["!"] },
  ]
  const allow = effectiveAllow(base, store, { configured: true })
  assert.deepEqual(
    allow.map((entry) => [entry.id, entry.kind, entry.reply, entry.triggers.join("|")]),
    [
      ["wxid_me", "dm", "always", ""],
      ["g1@chatroom", "group", "mention", "小鱼"],
    ],
  )
  // 没在配置文件里出现过的群，用人设兜底。
  assert.equal(allow[1].persona, "大肥鱼")
})

test("配置里手写过人设的群，勾选后保留它的人设", () => {
  const store = { version: 1, wakePrefix: "!", groups: [{ id: "old@chatroom" }] }
  const base = [
    { id: "wxid_me", kind: "dm", label: "小明", persona: "大肥鱼", reply: "always", triggers: [] },
    { id: "old@chatroom", kind: "group", label: "老群", persona: "工作助理", reply: "always", triggers: ["@我"] },
  ]
  const allow = effectiveAllow(base, store, { configured: true })
  assert.equal(allow[1].persona, "工作助理", "人设不能被勾选框冲掉")
  assert.equal(allow[1].reply, "always")
  assert.equal(allow[1].label, "老群", "没写 label 时沿用配置里的名字")
})

test("一键清空：勾选都没了，群就全走了，私聊不动", () => {
  const store = { version: 1, wakePrefix: "!", groups: [] }
  const base = [
    { id: "wxid_me", kind: "dm", label: "小明", persona: "大肥鱼", reply: "always", triggers: [] },
    { id: "g@chatroom", kind: "group", label: "群", persona: "大肥鱼", reply: "mention", triggers: ["!"] },
  ]
  assert.deepEqual(effectiveAllow(base, store, { configured: true }).map((entry) => entry.id), ["wxid_me"])
})

test("没显式设过时，原配置一字不动（升级后行为不变）", () => {
  const base = [{ id: "g@chatroom", kind: "group", label: "群", persona: "工作助理", reply: "mention", triggers: ["@大肥鱼"] }]
  const store = { version: 1, wakePrefix: "小鱼", groups: [{ id: "其他@chatroom" }] }
  assert.deepEqual(effectiveAllow(base, store, { configured: false }), base)
})

test("新勾的群从这次列表里拿名字，别存成空 label", () => {
  const body = { groupIds: ["1@chatroom", "2@chatroom"], wakePrefix: "!" }
  const allow = [{ id: "1@chatroom", kind: "group", label: "老群" }]
  const available = [
    { id: "1@chatroom", name: "老群改名了" },
    { id: "2@chatroom", name: "新群" },
  ]
  const next = settingsFromBody(body, allow, available)
  assert.deepEqual(next.groups, [
    { id: "1@chatroom", label: "老群" },
    { id: "2@chatroom", label: "新群" },
  ])
})

test("healLabels 只补空 label，已经有人设/旧名的不动", () => {
  const store = {
    wakePrefix: "!",
    groups: [
      { id: "1@chatroom", label: "" },
      { id: "2@chatroom", label: "手工改过" },
      { id: "3@chatroom", label: "" },
    ],
  }
  const available = [
    { id: "1@chatroom", name: "读到了" },
    { id: "2@chatroom", name: "会被忽略" },
  ]
  const healed = healLabels(store, available)
  assert.equal(healed.changed, true)
  assert.deepEqual(healed.store.groups, [
    { id: "1@chatroom", label: "读到了" },
    { id: "2@chatroom", label: "手工改过" },
    { id: "3@chatroom", label: "" },
  ])
  // 再跑一次就没事干了，避免每次打开设置页都写盘。
  assert.equal(healLabels(healed.store, available).changed, false)
})

test("表情档位：认识的保留，不认识的退回默认", () => {
  assert.equal(normalizeStickerRate("few"), "few")
  assert.equal(normalizeStickerRate("疯狂"), "more")
  assert.equal(normalizeStickerRate(""), "more")
  assert.equal(normalizeStickerRate(undefined), "more")
})

test("设置文件没写表情档位时读出来是默认档", () => {
  const dir = mkdtempSync(join(tmpdir(), "cwb-store-"))
  const path = join(dir, "settings.json")
  writeFileSync(path, JSON.stringify({ groups: [], wakePrefix: "!" }), "utf8")
  const store = readStore(path)
  assert.equal(store.stickerRate, "more")
  rmSync(dir, { recursive: true, force: true })
})

test("快照把表情档位和可选项一起给界面", () => {
  const snapshot = settingsSnapshot({
    allow: [],
    store: { groups: [], wakePrefix: "!", stickerRate: "crazy" },
    available: [],
  })
  assert.equal(snapshot.stickerRate, "crazy")
  assert.deepEqual(
    snapshot.stickerRates.map((rate) => rate.id),
    ["few", "normal", "more", "crazy"],
  )
  assert.equal(snapshot.stickerRates[2].label, "多")
})

test("保存时带上表情档位，写进设置文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "cwb-store-"))
  const path = join(dir, "settings.json")
  const body = settingsFromBody({ groupIds: [], wakePrefix: "！", stickerRate: "few" }, [], [])
  const written = writeStore(path, body)
  assert.equal(written.stickerRate, "few")
  assert.equal(readStore(path).stickerRate, "few")
  rmSync(dir, { recursive: true, force: true })
})
