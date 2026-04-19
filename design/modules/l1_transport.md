# Transport 接口契约

L1 实时双向通信原语。管理与外部客户端（TUI、IM bot）的连接，提供推送与接收能力。协议（socket / pipe / WebSocket）是内部实现细节，契约层不暴露。

归属：L1 原语。依赖：无。被调用：Gateway（唯一消费者）。

当前实现：`UnixDomainSocketTransport`。`socketPath` 位置由调用方装配期决定（建议 `~/.clawforum/<clawId>/transport.sock`）。

## 职责边界

### 做

1. `listen` / `close` 管理监听生命周期；`close` idempotent
2. `send(connectionId, data)` 定向发送；未知 id 抛错（调用方捕获后决策 drop 连接）
3. `broadcast(data)` 广播；best-effort——单连接写失败不冒泡、不影响其他连接
4. 连接建立 / 断开 / 消息回调（`onConnect` / `onDisconnect` / `onMessage`）
5. 消息边界保证：每次 `onMessage` 回调收到"一条完整逻辑消息"；frame 方案（当前 `\n` 分隔）对调用方不可见
6. 错误隔离：单连接 socket 错误、回调抛错不冒泡；server-level 错误只记 log
7. stale socket 清理：`listen` 前若 socket path 残留，探测活性——死进程残留则 unlink；活进程占用则抛错拒绝启动

### 不做

- 不解析消息语义（`data` 是 opaque string，业务含义归 Gateway）
- 不做连接鉴权 / 授权 / 限流（Gateway 或未来安全层职责）
- 不做跨机通信（当前实现仅 local UDS）
- 不自己维护消息 buffer / retry（best-effort delivery；Gateway 做更高层 backpressure）
- 不做 TLS / 加密
- 不做 Windows named pipe 支持

## 接口

```ts
interface Connection {
  id: string;                // 实现生成（当前 UDS 用 randomUUID）；对调用方 opaque
  connectedAt: number;       // Unix ms timestamp
}

interface TransportOptions {
  socketPath?: string;       // 本地 IPC 路径（UDS 专属）；见"与现状的差异" B 类
}

interface BroadcastFailure {
  connectionId: string;
  error: Error;
}

type TransportErrorEvent =
  | { kind: 'callback_error'; callbackName: 'onConnect' | 'onDisconnect' | 'onMessage' | 'onTransportError'; connectionId?: string; error: Error }
  | { kind: 'server_error'; error: Error };

interface Transport {
  listen(options?: TransportOptions): Promise<void>;
  close(): Promise<void>;                                      // idempotent

  send(connectionId: string, data: string): void;              // 未知 id 抛错
  broadcast(data: string): { failed: BroadcastFailure[] };     // 预期失败走返回值

  getConnections(): Connection[];
  onConnect(cb: (conn: Connection) => void): void;
  onDisconnect(cb: (conn: Connection, reason?: Error) => void): void;
  onMessage(cb: (conn: Connection, data: string) => void): void;
  onTransportError(cb: (evt: TransportErrorEvent) => void): void;  // 不可预期失败显式通道
}
```

关键约定：
- **消息帧协议对调用方不可见**：`onMessage` 每次回调 = 一条完整逻辑消息；底层如何分帧（UDS 用 `\n`，未来 TCP/WebSocket 可换）不属接口层
- **空消息仍交付**：连续分隔符产生的空字符串也会走 `onMessage`，由调用方决定忽略
- **`send` 未知 id 抛错**是设计语义（预期失败，由 Gateway try/catch 后 drop 连接），不是 bug
- **`broadcast` 返回失败列表**：单连接写失败不冒泡、不影响其他连接，但失败 connectionId 与错误原因通过返回值暴露；Gateway 按列表 drop 连接或审计
- **`onDisconnect(conn, reason?)`**：被动断开且有 socket `'error'` 捕获到原因时透传；主动关闭 / 无错误断开时 `reason` 为 `undefined`
- **`onTransportError`**：承接"不可预期失败"——用户回调抛错、server-level 错误等；调用方（Gateway）负责 emit 审计事件 / 告警；Transport 内部仍做错误隔离防主路径崩溃
- **`close` 期间 pending `listen`** 会让 `listen` reject

## 失败语义

| 失败源 | Transport 行为 |
|---|---|
| `listen` 缺 `socketPath` | 抛 `Error('socketPath required')` |
| `listen` 时 socket 文件残留且无进程占用 | 自动 unlink 后重试 listen |
| `listen` 时 socket 文件被活进程占用 | 抛 `Error('socket ... is in use by a live process')` |
| `listen` 其他错误 | 原样抛 Node 错误 |
| 重复 `listen` | 抛 `Error('transport already listening')` |
| `listen` 期间调用方调 `close()` | server 被 close，`listen` reject `Error('transport closed during listen')` |
| `close()` 后再 `listen` | 抛 `Error('transport already closed')` |
| 重复 `close()` | no-op，idempotent |
| `send` 传入未知 connectionId | 抛 `Error('unknown connection: <id>')` |
| `broadcast` 中单连接 write 抛错 | 计入返回值 `failed`（含 connectionId + error），继续处理下一个连接；调用方按列表决策 drop / 审计 |
| 单连接 socket 触发 `'error'` | 捕获 error，随后 `'close'` 触发 `onDisconnect(conn, reason)` 携带该 error |
| `onConnect` / `onDisconnect` / `onMessage` 回调抛错 | Transport 内部 try/catch 隔离，不影响其他回调；通过 `onTransportError({ kind: 'callback_error', callbackName, connectionId?, error })` 暴露 |
| `onTransportError` 回调自身抛错 | 再捕获后 `console.error`（递归边界，类似 AuditLog `[AUDIT CRITICAL]`）——至此不再回推 |
| server-level `'error'` | 通过 `onTransportError({ kind: 'server_error', error })` 暴露；Transport 状态不自动改变 |

## 不可消除的耦合

- **无跨模块运行时耦合**。唯一消费者 Gateway 通过 interface 调用。
- **`Connection.id` 是 opaque 字符串**：Transport 生成、Gateway 持有；两边对 id 的字符集 / 长度 / 唯一性无共享约束——契约只保证"实现内唯一且稳定"。
- **frame 协议对调用方不可见**：UDS → TCP / WebSocket 切换时 frame 方案会变；Gateway 不得假设 `\n` 分隔等实现细节。此隐藏是显式设计决策。
- **`TransportOptions` 与实现协议相关的字段**（当前 `socketPath`）：interface 层用 optional 吸纳特化字段，属轻微界面泄漏；见 B 类登记。

## 配置常量归属

| 项 | 归属 | 说明 |
|---|---|---|
| `socketPath` | 调用方装配期传入 | 本模块不决定路径策略；建议 `~/.clawforum/<clawId>/transport.sock` |
| frame 分隔符（当前 `\n`） | UDS 实现内部 | 不暴露；未来非 UDS 实现可换 |
| 连接 id 生成（`randomUUID`） | UDS 实现内部 | interface 仅约束"实现内唯一" |

## 与现状的差异（含 Design Principles / 编码规范违规登记）

### A. 必修违规（修复方向已定，待实施）

**A.1 `broadcast` 单连接失败走返回值而非 `console.error`**

违反原则："预期失败由调用方显式处理"——broadcast 写失败是可预期事件，应由 Gateway 决策 drop / 审计；而非吞进 log。

**修复方向**：`broadcast(data)` 返回 `{ failed: BroadcastFailure[] }`；Gateway 按列表处理（drop 坏连接、emit 审计事件）。`console.error` 清零。

**A.2 单连接 `'error'` 原因通过 `onDisconnect(conn, reason?)` 透传**

违反原则："事后仅凭日志和记录能完整重建决策链路"——原先断开原因丢失。

**修复方向**：`onDisconnect` 签名扩 `reason?: Error`；单连接 `'error'` 事件捕获的 Error 在随后 `'close'` 时附带透传。与 broadcast 的 Result 模式一致——断开是预期事件，原因由消费者决策是否审计。

**A.3 回调抛错 / server error 走 `onTransportError` 显式通道**

违反编码规范："不可预期失败暴露而非吞没"。回调内部 bug、server-level 错误属"不可预期失败"，不应降级到 `console.error`。

**修复方向**：新增 `onTransportError(cb: (evt: TransportErrorEvent) => void)`。Transport 内部仍 try/catch 保证主路径不崩，异常通过结构化 event 暴露给 Gateway，Gateway 负责 emit 到 AuditLog / Stream。`onTransportError` 自身再抛错走递归边界 `console.error`（类 `[AUDIT CRITICAL]`）。

**修复依据的原则分工**：broadcast 失败 / disconnect reason 都是**预期失败**——调用方应能 switch 处理，故走返回值 / 回调参数；callback / server 错误是**不可预期失败**——调用方按统一 error 通道暴露。与 LLMService `LLMEventSink` 设计思路同构：L1 不反向依赖 L2，定义协议，由装配层桥接到审计 / 实时通道。

### B. 偏差登记（当前合理或代价过高）

- **`listen(options?)` 的 optional 与实现必填不一致**：interface 签名的 `?` 暗示可不传；但 UDS 实现运行时必填 `socketPath`。违反编码规范"名字准确反映意图"——编译期可捕获的约束推到运行期。修复候选：
  - 候选 α：`listen(options: TransportOptions)` 去掉 `?`；`TransportOptions.socketPath` 也改为必填
  - 候选 β：`TransportOptions` 拆成 discriminated union，按协议区分字段
  - 与"未来多协议并存的 options 组织"合并讨论
- **`broadcast` best-effort 是显式设计决策**：Gateway 契约明确说"backpressure 时 drop oldest"由 Gateway 做而非 Transport——Transport 只保证单连接失败不影响其他连接。best-effort 属**显式决策**路径；但失败通道没暴露就滑入违规（见 A.1）
- **`Connection` 字段极小**：仅 `id + connectedAt`。是否需要 `remoteAddr` / `authContext` 等留给未来——当前 UDS 同机本地无此需求
- **空消息交付**：连续分隔符产生的空字符串交付调用方决定是否忽略。属**显式设计决策**——Transport 不替调用方判断"空消息"语义
- **stale socket 清理的竞态窗口**：探测 → `unlink` → `listen` 之间微小窗口，另一进程可能抢 listen。当前被 "daemon 单实例" 约定兜住（`ProcessManager` 保证同 claw 只有一个 daemon），不额外锁定
- **`listen` 与 `close` 的 race**：`closed=true` 在 listen 回调中检查的路径已在失败语义表登记
- **`Connection` 类型与 Gateway 契约同名**：两处指同一对象；类型层共享，非运行时耦合

## 测试覆盖现状

`tests/foundation/transport.test.ts`（17 个 it）覆盖契约主要行为：listen/close idempotency、单连接往返、广播、断线、消息回调、未知 id 抛错、并发连接、stale 清理、活进程保护、chunk 分帧、close 后状态、double listen、race、回调错误隔离、空消息。

**注**：当前测试验证的是 A.1 / A.2 / A.3 的"吞没"行为（连接错误被 `console.error` 后 Transport 继续）。修复 phase 需同步补"暴露"行为的断言——新结构化事件通道的正确性。
