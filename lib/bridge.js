/**
 * `sessions.js` 与 cordis 上下文之间的那一层。
 *
 * 它只做一件事：把 ctx 上的服务取出来交给会话桥。所有判断都在 `sessions.js`
 * 里，因为那里能用假的 agent 跑测试；这里只剩"从哪个属性取"，取错了逃不过
 * 一次真实的启动。
 *
 * 这个文件 import 了 `@deepseek-ai/dsh-llm`，于是它不参与 `node --test` ——
 * 代价明确，换来的是会话逻辑可测。
 */

import { createUserMessage } from "@deepseek-ai/dsh-llm"
import { createSessions } from "./sessions.js"

export { SESSION_ID_PREFIX, extractAssistantText, sessionIdFor } from "./agent-text.js"

/**
 * 建这一份 bridge。
 *
 * @param {object} options - 依赖注入。
 * @param {object} options.ctx - 插件的 cordis 上下文。
 * @param {object} options.config - 归一化后的配置。
 * @param {object} options.personas - 人设仓库。
 * @param {object} [options.logger] - 日志器。
 * @returns {object} bridge 控制对象。
 */
export function createBridge({ ctx, config, personas, logger, onProactiveText } = {}) {
  return createSessions({
    agents: ctx.agents,
    onProactiveText,
    events: { on: (name, listener) => ctx.on(name, listener) },
    createUserMessage,
    personas,
    config,
    logger,
    modelSelection: () => ctx.agentDefaultModel?.currentSelection?.() ?? { provider: "", model: "" },
    // 用 getter 而不是在装配时取一次值：这两个服务允许在插件加载之后才挂上来，
    // 早取一次就会永远拿到 undefined。
    getPermissionPresets: () => ctx.get("permissionPresets"),
    getPersistence: () => ctx.get("sessionPersistence"),
  })
}
