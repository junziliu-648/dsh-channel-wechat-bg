import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  DEFAULT_STICKER_RATE,
  DM_RULES,
  GROUP_RULES,
  PersonaStore,
  STICKER_RATE_IDS,
  composeSystemPrompt,
  stickerRule,
} from "../lib/personas.js"

const tmp = () => mkdtempSync(join(tmpdir(), "cwb-persona-"))

test("群聊优先用 <persona>-group.md，私聊不受影响", () => {
  const dir = tmp()
  try {
    writeFileSync(join(dir, "测试鱼.md"), "私聊版", "utf8")
    writeFileSync(join(dir, "测试鱼-group.md"), "群聊版", "utf8")
    const store = new PersonaStore({ dir })
    assert.equal(store.loadForEntry({ kind: "group", persona: "测试鱼" }), "群聊版")
    assert.equal(store.loadForEntry({ kind: "dm", persona: "测试鱼" }), "私聊版")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("没有群聊版就退回原人设，且不刷警告", () => {
  const dir = tmp()
  const warnings = []
  try {
    writeFileSync(join(dir, "测试鱼.md"), "私聊版", "utf8")
    const store = new PersonaStore({ dir, warn: (msg) => warnings.push(msg) })
    assert.equal(store.loadForEntry({ kind: "group", persona: "测试鱼" }), "私聊版")
    assert.deepEqual(warnings, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("记忆段插在人设之后、说话规矩之前", () => {
  const text = composeSystemPrompt({
    persona: "人设正文",
    entry: { kind: "dm", label: "小明", persona: "测试鱼" },
    botName: "鲸曦",
    memory: "## 你记得的事\n- 对方叫小王",
  })
  const at = (needle) => text.indexOf(needle)
  assert.ok(at("人设正文") < at("对方叫小王"))
  assert.ok(at("对方叫小王") < at("说话规矩"))
})

test("表情规则按档位生成，四档各不相同且都写了表情语法", () => {
  const texts = STICKER_RATE_IDS.map((rate) => stickerRule(rate))
  assert.equal(new Set(texts).size, 4)
  for (const text of texts) assert.ok(text.includes("[表情: 名字]"), text)
  // 只有"疯狂"档说几乎每条都配，其他档不能这么说
  assert.ok(stickerRule("crazy").includes("几乎每条"))
  assert.ok(!stickerRule("more").includes("几乎每条"))
  assert.ok(stickerRule("few").includes("大部分回复不用配"))
  // 默认档位是"多"：用户嫌之前用得少
  assert.equal(DEFAULT_STICKER_RATE, "more")
  assert.equal(stickerRule(), stickerRule("more"))
})

test("表情规矩随档位进 system prompt（人设与规矩之间不受影响）", () => {
  const build = (rate) =>
    composeSystemPrompt({ persona: "人设正文", entry: { kind: "dm", label: "小明" }, stickerRate: rate })
  const few = build("few")
  const crazy = build("crazy")
  assert.ok(few.includes(stickerRule("few")))
  assert.ok(crazy.includes(stickerRule("crazy")))
  assert.ok(!crazy.includes("大部分回复不用配"))
})
