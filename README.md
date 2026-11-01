# dsh-channel-wechat-bg

> 由 **DSH（DeepSeek Harness）** 制作并驱动：DSH 提供会话、人格、模型与工具，
> 这个插件只负责把微信接成它的一条通道。
>
> **[插件介绍](docs/插件介绍.md)**——一份文档两用：前半讲它替你做什么、不做什么（不用懂代码），
> 后半讲架构、协议、配置与故障排查顺序（给接手维护的人）。

把微信做成 DSH 的一条通道：**收消息完全后台**（读微信自己的本地库，不碰窗口），
**发消息走界面操作**（会短时间占用前台窗口、模拟打字和点击）。**只对白名单里的会话说话**，
其余的理都不理。

它想解决的是另一个问题：很多微信自动回复脚本会**不受控地抢前台**——不管你在干什么，
窗口直接被顶到最前面，失败了也不说。问题不在"占前台"本身，而在于它不受控、不可关、
失败不解释。这一版把"占前台"变成一个**有开关、有边界、有审计**的显式选择。
想彻底不碰自己的桌面，就把微信和桥一起放进虚拟机（见 [插件介绍](docs/插件介绍.md) 第二、三节）。

---

## 它做什么

- 一个微信会话 ↔ 一个 DSH 会话（`channel-wechat-bg-<chatId>`）。会话日志本身就是历史，
  不另存一份。
- 白名单里的**私聊**每条都回；**群聊**只在被 `@大肥鱼`（或配置的 triggers）时才回。
- 连发几条会合并成一轮（默认 1.2 秒）；同一个会话 6 秒内只回一条、一分钟最多 6 条；
  单条回复超过 300 字就截断（不拆成多条连发）。
- 每条进出都写审计（`ts / chatId / direction / chars / result`），**默认不记正文**。
- 人设按会话走：`persona/大肥鱼.md`（私聊）、`persona/工作助理.md`（群聊）。
  人设是挂在 `systemPrompt` 上的一段提示词，改文件下一句就生效，不用重建会话。
- 群聊还能有**单独的一版人格**：把它写成 `persona/<persona>-group.md`（比如 `persona/大肥鱼-group.md`），
  群里就用这一份，私聊仍然是原文件。仓库里带了一份 `大肥鱼-group.md` 当例子——它在群里更收着、
  只在被叫到时搭一句，跟私聊那个爱撒娇的版本是两种场合的两种样子。没写就退回原人设 + 群聊规矩。
- 群里的消息**带着说话人**进模型：`小明：这服务器又挂了`，不是一坨分不清谁说的字。私聊不加前缀
  （对面只有一个人，加了反而像在念台词）。
- 除了会话记忆，还有一层**认识人**的记忆：`<DSH_HOME>/wechat-bg/memory/people/<senderId>.json`。
  同一个人在私聊和群里是同一个人——名字、说话风格、跟你的关系、聊过的重要的事都记在这份画像里，
  跨会话共享；进模型时先给"面前是谁"，再给"这个会话发生过什么"。
- 每个会话有自己的**长期记忆**：`<DSH_HOME>/wechat-bg/memory/<chatId>.json`（可用 `memoryDir` 改），
  里面记着最近聊过什么、对方的偏好、有哪些约定，每轮拼进这个会话的提示词。模型想记点什么时，
  在回复里写 `[记住: 对方在做前端，喜欢简洁]`，通道会把这段抽出来存进记忆、并从发出去的话里删掉。
  记忆是**按 chat 隔离**的：test 群不知道私聊里说过什么。
- 发送时会**先等你手停 2.5 秒**（可配），发完把前台窗口**还回去**；等不到空闲就
  丢掉这一条，不硬抢。

## 它明确不做什么

- **白名单之外的人说话，不回复**。白名单只认稳定 ID，没有通配符，没有"先回再检查"。
- **不在你不知道的情况下抢前台**。`allowForegroundSend` 默认关；关着时 `uia` 传输
  **拒绝启动**，不会"先用别的方式凑合一下"。
- **不主动加好友、不拉群、不群发、不转发**，也不读白名单之外的会话。
- **不把 token、cookie、二维码、密钥写进日志或审计**；正文默认也不写。
- **群聊里不主动 @ 别人**。

## 传输真相：现在能用的只有一条

微信 4.x 的个人号没有官方 API。收发被抽象成 `WeChatTransport`，仓库里带了四种：

| 传输 | 收 | 发 | 状态 |
| --- | --- | --- | --- |
| `uia` | 读本地数据库（后台） | 界面操作（**占前台**） | **已实现**，配 `scripts/uia-bridge.py`，支持微信 4.x |
| `mock` | 内存 | 内存 | 只给测试用 |
| `pad` | HTTP SSE | HTTP | 已实现，要花钱、有封号风险 |
| `wechatferry` | 本机注入 | 本机注入 | 已实现，但只支持微信 **3.9.x** |

装上之后默认是**关着的**：`enabled: false`。即使打开，只要桥没起、微信没登录、
或者 `allowForegroundSend` 没开，插件都会在启动阶段抛错停下。失败要显式。
详见 [TRANSPORT.md](TRANSPORT.md)。

---

## 安装

在 profile 里装（Desktop 版的 `dsh` 只能从应用自带的 CLI 调用，见 `dsh plugin --help`）：

```powershell
dsh plugin --profile desktop add C:\path\to\dsh-channel-wechat-bg
```

`package.json` 里已经声明了 `dsh.bundle.patch`，装上之后插件行会从
`cordis.patch.yml` 插进 profile。默认那一行是**关着的**：

```yaml
- insert:
    - id: channel-wechat-bg
      name: dsh-channel-wechat-bg
      config:
        enabled: false            # 装上不等于开始回消息
        transport:
          kind: uia
          baseUrl: ""
        allowForegroundSend: false  # 抢前台必须自己点头
```

## 开始用它（uia 这条路）

三件事，都在你自己的终端里：

1. **起桥**（它负责读库、开窗口、打字）：

   ```powershell
   C:\path\to\venv\Scripts\python.exe `
     scripts\uia-bridge.py --account wxid_example_bot_0000
   ```

   机器上同时登录了多个微信号时 `--account` 必须给：不给会直接拒绝启动并列出候选，
   免得拿错号说话。起好之后 `http://127.0.0.1:8850/health` 应该返回
   `{"ok":true,"foreground":true,...}`。

2. **确认允许占前台**：配置里 `allowForegroundSend: true`。这是唯一一处"允许抢你的
   前台窗口"的表态；不想给就设 `false`，那时插件会拒绝启动而不是偷偷降级。

3. **打开通道**：把 profile 里的 `enabled` 改成 `true`。

`allow` 里的 ID 就是"允许谁跟它说话"，别随手改；装好之后也可以直接在设置页里勾选群聊。

## 状态

插件注册了一个只读接口：

```
GET http://127.0.0.1:<DSH Web 端口>/api/channel-wechat-bg/status
```

返回 `enabled / started / error / transport{kind,capabilities} / allow / permission /
rateLimit / counters / bridge.sessions`。没启用时也能看 —— "它为什么没说话"这个问题
应该能在界面上回答，而不是只能翻日志。

## 设置页（白名单 / 唤醒前缀 / 表情频率 / 人格 / 记忆）

装好之后，GUI 里进「设置 → 微信通道」（不是插件详情页）。一页分五块，能调的给控件，
不能调的至少把当前值摆出来：

- **群聊唤醒前缀**：群里只有消息带着它（或被 @）才会被当成"叫我"。默认 `!`。
- **表情频率**：`少 / 正常 / 多 / 疯狂` 四档，默认 **多**。四档不是同一个提示词换个形容词，
  是四段强度不同的规矩（「疯狂」= 几乎每条都配，「少」= 只在一眼能看出情绪时配），
  存在设置文件里、下一句就生效。
- **人格**：列出每个白名单会话在读哪份人设文件（`<名字>.md`，群聊优先 `<名字>-group.md`）。
  这一块只读 —— 改性格是改文件的事，不是勾选的事。
- **记忆**：会话记忆和人物画像各有几份、存在哪个目录。同样是只读。
- **群聊白名单**：列出微信里能读到的群，勾上就进白名单，取消就退出。群名后面的
  小灰字是真实的会话 id（`xxx@chatroom`），换群时以它为准。

接口就两个方法：

```
GET  …/api/channel-wechat-bg/settings   → {groups[], wakePrefix, stickerRate, stickerRates[], personas[], memory{}, allow[], settingsPath}
PUT  …/api/channel-wechat-bg/settings   ← {groupIds: string[], wakePrefix: string, stickerRate: string}
```

几件要说清楚的事：

- 改动存在 `<DSH_HOME>/channel-wechat-bg/settings.json`，**不写 `cordis.patch.yml`**。
  那张表是手写配置，程序去改它会把人的注释冲掉；而且白名单是数组套对象，配置
  表单只能写单段字符串字段，根本写不回去。
- 设置文件**有值时覆盖配置里的群**，但私聊条目永远来自配置 —— 设置页只管群，
  "谁能私聊它"不该被一个勾选框改掉。
- 表情档位同理：设置页存过就以它为准，没存过才用配置里的 `stickerRate`。
- 一次都没在设置页保存过（没有 settings.json）时，行为与旧版完全一致。
- 保存后会立刻把新白名单推给桥（`PUT /allow`），并把表情档位交给正在跑的流水线。

## 配置

字段和默认值见 [`config.example.yml`](config.example.yml)。几个值值得单独说：

| 键 | 默认 | 为什么是这个值 |
| --- | --- | --- |
| `enabled` | `false` | 装上不等于开始回消息，得有人显式打开 |
| `allowForegroundSend` | `false` | 抢前台必须是一次明确表态，不能靠默认值 |
| `denyUnknown` | `true` | 写成 `false` 会**拒绝启动**，因为代码里根本没有"放行未知会话"这条路 |
| `permission` | `read-only` | 群里任何人都不该能通过一句话指挥它执行命令 |
| `botName` | `大肥鱼` | 只用于去掉回复开头可能出现的自称 |
| `rateLimit.maxReplyChars` | `300` | 超过就截断，不拆成多条连发 |
| `audit.logContent` | `false` | 正文和密钥一样，不该悄悄落盘 |

## 测试

```powershell
# 需要 node（Desktop 版不自带 PATH 上的 node，用 DSH 运行时里那个）
node --test
```

108 个用例，覆盖 PLUGIN_PROMPT 第 10 节要求的场景，逐条对应：

| 要求 | 测试 |
| --- | --- |
| 1. 只回 `wxid_example_dm`，别的 `wxid_` 拒绝 | `test/policy.test.js`、`test/pipeline.test.js` |
| 2. 群里 @ 就回，不 @ 不回 | `test/policy.test.js`、`test/pipeline.test.js` |
| 3. 自己发的 / 非文本 / 空消息不回 | `test/pipeline.test.js` |
| 4. 6 秒内第二条被限流、一分钟超 6 条拒绝 | `test/limits.test.js`、`test/pipeline.test.js` |
| 5. `enabled: false` 时所有发送都失败 | `test/pipeline.test.js` |
| 6. mock 传输走完整流程、审计文件被写 | `test/pipeline.test.js` |
| 7. 后台传输发送时 `GetForegroundWindow()` 不变 | `scripts/verify-background-send.ps1` |
| 8. 插件进程里没有 `SetForegroundWindow` / `SendInput` / 剪贴板 | `test/no-ui-automation.test.js` |

第 7 条只对**后台传输**（`pad` / `wechatferry`）有意义：

```powershell
powershell -NoProfile -File scripts/verify-background-send.ps1 `
  -BaseUrl http://127.0.0.1:8849 -ChatId wxid_example_dm
```

`uia` 是前台传输，它**本来就会**换前台窗口，所以不适用这条；它有自己的验收方式：

```powershell
node scripts/e2e-uia.mjs --chat 12345678901@chatroom --dry-run   # 只解析名字，不发
node scripts/e2e-uia.mjs --chat 12345678901@chatroom             # 真发一条
```

它会走完整的插件链路（白名单 → 限流 → 传输 → 桥 → 微信 → 数据库回读），最后打印
`{"ok":true,"messageId":"message__message_0.db:31"}` 和一份 `status()`。

## 目录

```
lib/
  index.js        插件入口：接线 + 生命周期 + /status 路由
  bridge.js       薄适配层：把 ctx 上的服务摊平成 sessions.js 要的参数
  sessions.js     一个会话一个 DSH agent：建/恢复、发 followup、等 session/event 里的回复
  agent-text.js   会话 ID 与"从事件里取回复"（纯逻辑，有测试）
  settings.js     配置读取与归一化（纯逻辑，有测试；解开 volatile 封装在这里）
  config.js       schemastery 配置模式
  pipeline.js     白名单 → @ → 合并 → 节流 → 审计 的整条规则链
  policy.js       白名单与 @ 判断
  rate-limit.js   节流
  debounce.js     连发合并
  dedupe.js       去重
  clean.js        去掉 Markdown、截断到 300 字
  audit.js        JSONL 审计 + 密钥脱敏
  personas.js     人设文件 + 提示词拼装
  transport/      base / http-link / mock / pad / uia / wechatferry
persona/          大肥鱼.md、工作助理.md
scripts/          uia-bridge.py + wxversion.py + wcf-bridge.py
                  verify-background-send.ps1 + send-once.mjs + e2e-uia.mjs
test/             node --test（含 apply 接线测试）
```

桥的分工，两种传输长得一样：

```
插件（纯 ESM，零依赖） ── HTTP/SSE ──> scripts/uia-bridge.py（Python + wechatauto） ── 界面/数据库 ──> 微信 4.x
                                    └─> scripts/wcf-bridge.py（Python + wcferry）    ── 注入 ──> 微信 3.9.x
```

界面操作放在另一个进程里：桥崩了插件只是探活失败，不会连带 DSH 一起死；而且
`lib/` 里永远没有一句窗口 API（`test/no-ui-automation.test.js` 守着这条线）。
两种桥和 `pad` 说同一套协议，所以 `lib/transport/http-link.js` 里的连接、重连、
SSE 解析是共用的。

## 风险，说在前面

- **抢前台是真的**：发送那一两秒，微信会被顶到最前面，键盘输入会被临时接管
  （内容是粘贴进输入框的文字，不是敲键）。所以它只在 `allowForegroundSend: true`
  且你已经离开键盘（默认等 2.5 秒空闲）时动手。
- 群聊里它会为了发消息把窗口切到"测试"这个群，**发完会切回原来的窗口**；如果
  你正好在全屏游戏/会议里，这一下切换仍然会被你看见。
- 任何非官方微信通道都**有封号风险**。`uia` 是"模拟一个人在用微信"，风险低于注入和
  协议端，但**不是零**；微信的协议里本来就禁止自动化操作。用专门的号，别用你日常那个。
- `pad` 要**花钱**，账号数据在服务商那边；`wechatferry` **锁死微信 3.9.x**，
  注入是微信明确反对的行为，封号风险最高。
- 桥本身能读群消息、联系人、朋友圈 —— 插件只读白名单里那两个会话，但这中间没有
  沙箱，只有代码里的白名单。
- 这个插件会把微信里的对话送进 DSH 的会话日志，也就是说它会**出现在你的会话列表里**。
  这是有意的（历史只有一份），但你应该知道它在那里。

## 免责声明

本插件是一个**自动化辅助工具**，它只做一件事：把微信上的消息接进 DSH，把回复发回去。

使用者的行为——发给谁、说了什么、用哪个账号跑、对第三方造成什么影响——**由使用者
自己负责，与作者无关**。作者不提供账号、不代为登录，既无法监督也无法控制你拿它做
什么。

非官方通道的自动化操作可能违反微信的服务协议，可能导致账号被限制或封禁；**风险由
使用者自担**。作者不对任何数据丢失、账号损失或由此产生的纠纷承担责任。请只在你
有权操作的账号上使用，并遵守当地法律与平台规则。

> This is a tool. How you use it is on you, not the author.

