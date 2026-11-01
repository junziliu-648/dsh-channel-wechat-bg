# 传输：四种路，各自的代价

这个插件把"怎么收发微信消息"做成了一个可替换的接口（`WeChatTransport`），
因为**微信 4.x 的个人号没有官方 API**，可用的路只有几条，而每一条都有代价。
这一页把代价写清楚，好让选择是知情的选择。

现在的立场分两种：

- **后台传输**（`pad`、`wechatferry`）：发送时前台窗口不换、不模拟键鼠、不碰剪贴板。
  这是首选。
- **前台传输**（`uia`）：收消息后台，发消息真的会占用前台窗口、模拟打字和点击。
  **它必须被显式允许**（`allowForegroundSend: true`），否则插件拒绝启动。

两种都不许"悄悄发生"：能力声明和实际行为必须一致，不一致就拒绝启动。

---

## 0. 两条闸门

| 闸门 | 位置 | 作用 |
| --- | --- | --- |
| `capabilities.backgroundSend` | 每个传输自己声明 | 如实说明"发送会不会换前台窗口" |
| `assertSendCapability()` | `lib/transport/base.js` | `backgroundSend: false` 时，只有 `allowForegroundSend: true` 才放行，否则抛 `TransportUnsupportedError` |

`test/no-ui-automation.test.js` 另外守一条线：**插件进程里不许有窗口 API**。
界面操作只允许发生在 `scripts/uia-bridge.py` 那个独立进程里 —— 桥崩了插件只是探活
失败，不会连带 DSH 一起死。

---

## 1. `uia` —— 本机前台桥（现在能用的那条）

**是什么**：`scripts/uia-bridge.py` 跑在一个独立的 Python 进程里，用
`wechatauto-replica` 做两件事：

- **收**：直接读微信自己的本地数据库（`xwechat_files`），不改窗口、不点界面 ——
  这是完全后台的；
- **发**：打开会话、把文字粘贴进输入框、点发送 —— 这一步会**把微信窗口顶到前台**。

**为什么这样做**：微信 4.x 已经没有可注入的 DLL 生态，官方又只开放 1:1 机器人。
要让"群里被 @ 就回"这件事在新版微信上成立，只剩"模拟一个人在用微信"这条路。

**怎么接的**：

```
插件（纯 ESM，零依赖） ── HTTP/SSE ──> scripts/uia-bridge.py（Python + wechatauto）
                                        ├─ 读数据库  → 收消息
                                        └─ 开窗口/粘贴/点击 → 发消息
```

协议和 `pad` 一样（`/health`、`/events`、`/send`），额外多一个 `PUT /allow`：
白名单由插件推给桥，桥只监听那两个会话。规则只有一份，不靠两边各配一遍。

**前置条件**：

1. Python 3.10+ 的环境里装了 `wechatauto-replica`、`uiautomation`、`pywin32`、`psutil`
   （仓库里的 `../wechat-fish/.venv` 就是这样一个环境）；
2. 微信正在登录，而且**登录的是你要让它说话的那个号**；
3. 桥在跑：默认 `http://127.0.0.1:8850`；
4. 配置里 `allowForegroundSend: true`。

**启动桥**：

```powershell
C:\path\to\venv\Scripts\python.exe `
  scripts\uia-bridge.py --account wxid_example_bot_0000
```

常用参数：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--port` | `8850` | 端口，插件默认连这个 |
| `--account` | 自动 | 同机多个号在跑时**必须**给，否则拒绝启动（猜错就是用错账号说话） |
| `--idle-ms` | `2500` | 发送前要求你手停多久，避免打断正在打字的你 |
| `--max-wait-ms` | `90000` | 等空闲的上限；等不到就**丢掉这一条**，不硬抢 |
| `--no-idle` | 关 | 不等空闲（不建议） |
| `--token` | 空 | 给了就要 `Authorization: Bearer` |
| `--verify-ms` | `10000` | 发完在数据库里回读确认的超时 |

**两条闸门之外，它自己还查三件事**：

- 桥必须自报 `foreground: true`（否则 `TRANSPORT_FOREGROUND_UNCONFIRMED`）；
- 桥必须已经绑定到账号和窗口（绑不上就起不来，日志里写清原因）；
- 白名单推不过去就拒绝启动（`TRANSPORT_ALLOW_REJECTED`），桥连不上也拒绝
  （`TRANSPORT_BRIDGE_UNREACHABLE`，报错里带起桥命令）。

**行为细节**（这些是它比 `wechat-fish` 那一版温和的地方）：

- 发送前等你空闲 `--idle-ms`；等不到就**这条不发**，不抢鼠标键盘；
- 发完把原来的前台窗口还回去（`SetForegroundWindow(prev)` + `release_foreground()`）；
- 消息落库之后才算成功：回读数据库确认那条文本真的进了会话，`messageId` 是
  `message__message_0.db:31` 这种形式；
- 收消息靠 `sort_seq` 水位线，**重启桥不会重放旧消息**（`PUT /allow` 对已存在的
  会话沿用原水位线，断线期间的消息不会因为重连被跳过）。

**验证**：

```powershell
node scripts/e2e-uia.mjs --chat 12345678901@chatroom --dry-run   # 只解析名字、不发
node scripts/e2e-uia.mjs --chat 12345678901@chatroom             # 真发一条
```

`node scripts/send-once.mjs --kind uia --chat … --allow-foreground` 是更小的版本。

**代价与风险**：

- **会抢前台**：发送那一两秒微信在你面前，键盘焦点被临时接管；
- 微信协议禁止自动化操作，**有封号风险**（比注入低，但不是零）。用小号；
- 它需要窗口处于可操作状态：如果微信被最小化到托盘、或者被别的全屏程序挡住，
  桥会先把它弄出来 —— 这就是"占前台"的字面意思；
- 桥能读整个库（群、联系人都在里面），插件只读白名单那两个会话，中间没有沙箱。

---

## 2. `pad` —— 托管 Pad 协议服务（后台，但要花钱）

**是什么**：第三方把一台设备的协议行为托管起来，给你一个 HTTP 接口，你按
`chatId` 发文本，它把消息推给你（本插件用 SSE 收）。

**前置条件**：一台一直开着的协议服务、地址和 token；服务支持"发文本 + 推新消息"；
最好消息里带稳定的 `messageId`（没有也能跑，但去重会退化成按内容指纹）。

```yaml
transport:
  kind: pad
  baseUrl: http://127.0.0.1:8848
  token: 你的-token
```

**验证后台性**：

```powershell
powershell -NoProfile -File scripts/verify-background-send.ps1 `
  -BaseUrl http://127.0.0.1:8848 -Token 你的-token -ChatId wxid_example_dm
```

**代价与风险**：要花钱；**有封号风险**；账号数据在服务商手里。

---

## 3. `wechatferry` —— 本机注入（后台、免费，但锁死微信 3.9.x）

**是什么**：通过注入 DLL 进微信进程收发消息，链路里没有窗口、没有键鼠、没有剪贴板，
所以是**真后台**的。接法同样是独立进程：

```
插件 ── HTTP/SSE ──> scripts/wcf-bridge.py（Python + wcferry） ── 注入 ──> 微信 3.9.x
```

**前置条件**：微信必须是 **3.9.x**（本机是 4.1.13.12，要先降级并关掉自动更新）、
`pip install wcferry`（`39.x` 配微信 3.9.a.a）、专用小号、桥在跑。

```powershell
python scripts/wcf-bridge.py --port 8849
powershell -NoProfile -File scripts/verify-background-send.ps1 `
  -BaseUrl http://127.0.0.1:8849 -ChatId wxid_example_dm
```

**两道版本闸门**：配置里的 `wechatVersion`（填了就必须是 3.9.x）和桥 `/health`
自报的版本。错误码：`TRANSPORT_VERSION_UNSUPPORTED`、`TRANSPORT_NOT_INJECTED`、
`TRANSPORT_BRIDGE_UNREACHABLE`。

**代价与风险**：注入是微信明确反对的行为，**封号风险最高**；锁死版本，自动更新一次
就失效。

---

## 4. 官方 ClawBot / iLink —— 拿不到群，也不满足需求

官方路径后台、合规、无封号风险，但**机器人只能在 1:1 会话里被使用**：不能进群，
也不能主动给某人发消息。本插件要的两件事它都做不到，所以没有实现。

---

## 5. 自己实现一个适配器

只要满足 `WeChatTransport`，任何实现都能接进来（见 `index.d.ts`）：

```ts
interface WeChatTransport {
  readonly kind: string
  readonly capabilities: { receive: boolean; backgroundSend: boolean; groups: boolean }
  readonly selfId?: string
  start(): Promise<void>
  stop(): Promise<void>
  onMessage(handler: (message: InboundMessage) => void): () => void
  sendText(chatId: string, text: string): Promise<SendResult>
  health(): Promise<{ ok: boolean; detail?: string }>
}
```

四条要求：

1. **`sendText` 不抛异常**，失败一律返回 `{ ok: false, error }`。抛异常会让一次
   网络抖动变成一条没人知道丢在哪里的回复。
2. **`capabilities` 说实话**。发送会抢前台就写 `backgroundSend: false` —— 插件会要求
   用户显式打开 `allowForegroundSend`，那是正确的结局，不是要绕过的东西。
3. **`start()` 失败就抛**。探活没通过还返回成功，等于让插件以为自己在线。
4. **要收发的会话由插件推给你**（如果你的桥有自己的白名单）。两份规则不一致时，
   迟早会出现"插件以为在回白名单，桥在回别的地方"。

---

## 一句话总结

| 传输 | 后台发送 | 群 | 花钱 | 封号风险 | 本插件状态 |
| --- | --- | --- | --- | --- | --- |
| `uia` | **否**（收消息后台，发送占前台） | 能 | 不要 | 中低 | **已实现**（本机桥，需 `allowForegroundSend`） |
| `pad` | 是 | 能 | 要 | 中高 | 已实现（HTTP + SSE） |
| `wechatferry` | 是 | 能 | 不要 | 最高 | 已实现（需微信 3.9.x + 两道版本闸门） |
| 官方 iLink | 是 | 不能 | 不要 | 无 | 不适用 |
