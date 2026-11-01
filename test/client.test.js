/**
 * 客户端插件的接线自检：不启动浏览器，只验证加载器契约。
 *
 * 检查四件事，任何一件错了在真机上都是「页面上什么都不出现、也不报错」：
 *   1. 文件走 `window.__ModuleLoader__.load({ id, factory })` 这个入口；
 *   2. `id` 与本包包名一致；
 *   3. factory 返回 `{ name, inject, apply }`；
 *   4. `apply` 往 `settings.section`（设置弹层左侧的一级入口）里注册一页，
 *      `label` 是导航标题。
 *
 * 另外盯住一个真出过的 bug：接口路径必须是绝对路径。写成 `api/...` 这种
 * 文档相对路径时，设置页的 URL 带层级，请求会打到别处、拿到 404 ——
 * 页面上就是一句红字 HTTP 404，而且不会报别的错。
 */

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import vm from "node:vm"

const HERE = fileURLToPath(new URL(".", import.meta.url))
const CLIENT_SOURCE = readFileSync(join(HERE, "..", "lib", "client.js"), "utf8")
const PACKAGE_NAME = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8")).name

/** 一个够用的假 React：页面在自检里不会被渲染，只要求这些钩子存在。 */
function fakeReact() {
  return {
    createElement: () => null,
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
  }
}

/**
 * 在沙箱里跑一遍客户端文件，拿到它交给加载器的那份声明。
 * @returns {object} `{ id, factory }`。
 */
function loadDeclaration() {
  const captured = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (declaration) => captured.push(declaration) } },
    fetch: async () => {
      throw new Error("自检不该发请求")
    },
    console,
  }
  vm.runInNewContext(CLIENT_SOURCE, sandbox, { filename: "client.js" })
  assert.equal(captured.length, 1, "客户端文件必须调用一次 window.__ModuleLoader__.load")
  return captured[0]
}

test("客户端走 ModuleLoader 的 load({id, factory})，id 等于包名", () => {
  const declaration = loadDeclaration()
  assert.equal(declaration.id, PACKAGE_NAME)
  assert.equal(typeof declaration.factory, "function")
})

test("factory 只 require react，返回 {name, inject, apply}", () => {
  const declaration = loadDeclaration()
  const asked = []
  const module = declaration.factory((name) => {
    asked.push(name)
    if (name === "react") return fakeReact()
    throw new Error(`不该 require ${name}`)
  })
  assert.deepEqual(asked, ["react"])
  assert.equal(module.name, PACKAGE_NAME)
  // 数组来自另一个 realm，先摊平成本地数组再比，否则原型不同会误报。
  assert.deepEqual([...module.inject], ["slots"])
  assert.equal(typeof module.apply, "function")
})

test("apply 把设置页注册进 settings.section，并给出导航标题", () => {
  const declaration = loadDeclaration()
  const module = declaration.factory(() => fakeReact())
  const registrations = []
  const injected = []
  module.apply({
    slots: {
      inject(slot, callback) {
        injected.push(slot)
        return callback()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  })

  assert.deepEqual(injected, ["settings.section"], "只往设置弹层的一级入口里塞页面")
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].options.name, "settings.section")
  assert.equal(typeof registrations[0].options.id, "string")
  assert.notEqual(registrations[0].options.id, "")
  assert.equal(registrations[0].options.label(), "微信通道")
  assert.equal(typeof registrations[0].component, "function")
})

test("设置接口用绝对路径，避免设置页 URL 带层级时 404", () => {
  assert.match(CLIENT_SOURCE, /['"]\/api\/channel-wechat-bg\/settings['"]/)
  assert.doesNotMatch(
    CLIENT_SOURCE,
    /fetch\(\s*['"]api\/channel-wechat-bg/,
    "文档相对路径会在设置页里解析到别处",
  )
})
