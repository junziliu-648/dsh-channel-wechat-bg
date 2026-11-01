import { test } from "node:test"
import assert from "node:assert/strict"

import { fetchGroups, resolveGroupsUrl } from "../lib/groups.js"

/** 一个只会回一个响应的假 fetch，顺便记下被请求的地址。 */
function fakeFetch(response) {
  const calls = []
  const impl = async (url) => {
    calls.push(String(url))
    if (response instanceof Error) throw response
    return response
  }
  impl.calls = calls
  return impl
}

/** 造一个最小 Response。 */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

test("resolveGroupsUrl 默认取桥的主机名 + 8891", () => {
  assert.equal(resolveGroupsUrl("http://192.168.1.50:8850"), "http://192.168.1.50:8891")
  assert.equal(resolveGroupsUrl(""), "http://127.0.0.1:8891")
  assert.equal(resolveGroupsUrl("不是地址"), "http://127.0.0.1:8891")
})

test("resolveGroupsUrl 配了就用配的，并去掉结尾斜杠", () => {
  assert.equal(resolveGroupsUrl("http://127.0.0.1:8850", "http://10.0.0.5:9999/"), "http://10.0.0.5:9999")
})

test("resolveGroupsUrl 认得 IPv6 字面量要加方括号", () => {
  assert.equal(resolveGroupsUrl("http://[::1]:8850"), "http://[::1]:8891")
})

test("fetchGroups 只留群，别的会话一律不返回", async () => {
  const impl = fakeFetch(
    jsonResponse({
      ok: true,
      groups: [
        { id: "a@chatroom", name: "A 群" },
        { id: "wxid_someone", name: "某个人" },
        { id: "", name: "空 id" },
      ],
    }),
  )
  const result = await fetchGroups({ url: "http://127.0.0.1:8891", fetch: impl })
  assert.deepEqual(result.groups, [{ id: "a@chatroom", name: "A 群" }])
  assert.equal(impl.calls[0], "http://127.0.0.1:8891/groups")
})

test("fetchGroups 连不上时回空列表 + 一句原因，而不是抛错", async () => {
  const impl = fakeFetch(new Error("ECONNREFUSED"))
  const result = await fetchGroups({ url: "http://127.0.0.1:8891", fetch: impl })
  assert.deepEqual(result.groups, [])
  assert.match(result.error, /连不上列群服务/)
})

test("fetchGroups 遇到非 200 也是回原因", async () => {
  const result = await fetchGroups({ url: "http://h:8891", fetch: fakeFetch(jsonResponse({}, 500)) })
  assert.deepEqual(result.groups, [])
  assert.match(result.error, /HTTP 500/)
})

test("fetchGroups 遇到非 JSON 也是回原因", async () => {
  const impl = fakeFetch(new Response("<html>", { status: 200 }))
  const result = await fetchGroups({ url: "http://h:8891", fetch: impl })
  assert.match(result.error, /不是 JSON/)
})

test("fetchGroups 服务自己说没成功，就把它的话带出来", async () => {
  const impl = fakeFetch(jsonResponse({ ok: false, error: "读不到会话表：没有登录" }))
  const result = await fetchGroups({ url: "http://h:8891", fetch: impl })
  assert.deepEqual(result.groups, [])
  assert.match(result.error, /没有登录/)
})
