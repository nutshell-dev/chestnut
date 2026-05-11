# Gateway 接口契约

L3 外部客户端 ↔ 内部系统的实时交互门面。订阅 Stream 推送事件给客户端、接收客户端信号路由到系统内部、提供 `ask_user` 工具让 agent 阻塞等待用户回复。

**控制面 vs 数据面区分**：Philosophy 规定"CLI 是 claw 和 motion 的唯一对外入口"——语境限定在**控制面**（daemon 生命周期管理：start/stop/status/init）。Gateway 承担**数据面**（运行中 agent ↔ 外部客户端的实时交互：stream 观察 / ask_user / interrupt 路由），两者并列不冲突。

**应然**（2026-04-26 修订 / 跟 modules.md §18 align）：装配「按需」——任何需要把 agent 与外部客户端实时交互桥接的 daemon 装；不预设独占某个 identity / 不预设客户端类型。
**实然**：当前默认仅 motion 装配 + offline 模式（`transport: undefined`）；ask_user 工具仅 motion 注册。详 §7。

## 1. 所有权

### 归属层

L3 执行与连接。被谁调用：Daemon（启动时创建、注入 interrupt 回调）。

**应然**（2026-04-26 修订 / 跟 modules.md §18 align）：装配「按需」——任何装 Transport 的 daemon 同时装 Gateway；不预设独占某个 identity。
**实然**：当前仅 motion 装（offline 模式）；详 §7。

### 职责（做）

1. **生命周期管理**：`start()` 绑 transport 回调 + 构造启动 StreamReader；`stop()` 取消 pending askUser → 停 reader → drop 连接 → close transport
2. **stream 订阅推送**：通过 `streamFactory` 注入 onEvent 回调，把 StreamEvent 广播给所有连接的客户端
3. **ask_user 异步状态机**：通过 `askUser(question, ctx)` 生成 pending entry，广播 `ask_user_pending` 给客户端；客户端 `ask_user_reply` 解析 / timeout / abort 走三种收口路径
4. **interrupt 路由 + debounce**：收到客户端 `interrupt` 消息后，`GATEWAY_INTERRUPT_DEBOUNCE_MS` 内重复丢弃，否则调 Daemon 注入的 `interrupt('user')` 回调
5. **连接视图派生**：`connections: Map<id, Connection>` 跟随 `transport.onConnect` / `onDisconnect` 维护；对外通过 `getActiveConnections()` 暴露只读快照
6. **online / offline 一次性定型**：`isOnlineMode = (transport !== undefined)` 启动期定，运行期不变；offline 模式下 start/stop/askUser 全部 no-op 或立即失败

### 不做

- 不解析消息业务语义（Transport 只传 opaque string，Gateway 只做 JSON parse + discriminated union dispatch）
- 不做连接鉴权 / 限流（归 Transport 或未来安全层）
- 不做客户端侧状态持久化（pending askUser / connections 全部运行时派生态）
- 不定义 StreamEvent 格式（归 Stream 模块）
- 不直接构造 StreamReader（通过 `streamFactory` 注入，避免知道 StreamReader 构造签名）
- 不自己维护 backpressure buffer（Transport 层 best-effort；Gateway 不做更高层重传）

### 业务语义

「客户端交互」这一业务语义的唯一发起点：askUser / stream 订阅 / interrupt 路由均归 Gateway。askUser 需要 ask 语义 → 由 Gateway 发起；stream 需要推送语义 → 由 Gateway 发起；interrupt 需要路由语义 → 由 Gateway 发起。

### 资源

| 资源 | 类别 | 归属位置 |
|---|---|---|
| `connections: Map<id, Connection>` | 运行时派生态（不落盘） | `gateway.ts` 实例字段 |
| `pending: Map<id, AskUserEntry>` | 运行时派生态（不落盘） | `gateway.ts` 实例字段 |
| `lastInterruptTs: number` | 运行时派生态（不落盘） | `gateway.ts` 实例字段 |
| `started: boolean` / `isOnlineMode: boolean` | 运行时派生态（不落盘） | `gateway.ts` 实例字段 |
| `GATEWAY_INTERRUPT_DEBOUNCE_MS` | 常量 | `src/constants.ts` L159（`// Gateway` 段）；不定制化 |
| `GATEWAY_ASK_USER_TIMEOUT_MS` | 常量 | `src/constants.ts` L165；默认 30 分钟；`GatewayInput.askUserTimeoutMs` 可覆盖（仅测试使用） |
| `ask_user` 工具（name / description / schema） | 工具 | `src/core/gateway/ask-user-tool.ts` 硬编码 |
| ask_user id 格式 `ask_<ts>_<counter>` | 内部编码 | `gateway.ts` 内部；对外 opaque |

## 2. 接口

### 类型签名

```ts
// 工厂（装配期入口）
export function createGateway(input: GatewayInput): Gateway;

// 装配输入
export interface GatewayInput {
  /** StreamReader 工厂；Gateway 注入 onEvent 回调后调用 start。 */
  streamFactory: (onEvent: (event: StreamEvent) => void) => StreamReader;
  /** 已处于 listening 状态的 Transport；undefined = offline 模式。 */
  transport?: Transport;
  /** Daemon 注入的 interrupt 回调。 */
  interrupt: (reason: 'user') => void;
  /** askUser 超时（缺省 GATEWAY_ASK_USER_TIMEOUT_MS = 30 分钟）。 */
  askUserTimeoutMs?: number;
}

// Gateway interface
export interface Gateway {
  /** 绑 transport 回调 + 启动 StreamReader。重复调用抛错。offline 下 no-op。 */
  start(): Promise<void>;
  /** 取消 pending → 停 reader → drop 连接 → close transport。idempotent。 */
  stop(): Promise<void>;
  /** 阻塞等待客户端 reply；offline / abort / timeout 返 failureResult。 */
  askUser(question: string, ctx: ExecContext): Promise<ToolResult>;
  /** 当前连接快照，readonly（调用方不得持有 Map 引用）。 */
  getActiveConnections(): readonly Connection[];
  /** online / offline 一次性定型；started 后立即反映实际状态。 */
  isOnline(): boolean;
}

// Client → Gateway
export type ClientMessage =
  | { type: 'interrupt'; reason: 'user' }
  | { type: 'ask_user_reply'; id: string; answer: string };

// Gateway → Client
export type ServerMessage =
  | { type: 'stream'; event: StreamEvent }
  | { type: 'ask_user_pending'; id: string; question: string }
  | { type: 'ask_user_resolved'; id: string; by: string }
  | { type: 'ask_user_cancelled'; id: string; reason: 'timeout' | 'abort' }
  | { type: 'connection_dropped'; connectionId: string; reason: string };

// ask_user 工具 wrapper
export function createAskUserTool(gateway: Gateway): Tool;
```

### 关键约定

- **start 不可重复**：`if (started) throw new Error('Gateway already started')`——启动两次是调用方 bug，抛错而非幂等
- **stop idempotent**：未 start 的 stop 直接返回；已 stopped 的 stop 再次调用 no-op
- **offline 模式行为**：start/stop 仅翻转内部 `started` 标志，不做网络操作；`askUser` 立即返回 `failureResult('未启用实时交互通道，跳过 ask_user')`
- **ask_user id 格式**：`ask_${Date.now()}_${counter}`——实现内唯一，对调用方 opaque
- **interrupt debounce**：`now - lastInterruptTs < GATEWAY_INTERRUPT_DEBOUNCE_MS` 内的 interrupt 丢弃；首次命中更新 `lastInterruptTs` 后调回调
- **ask_user_reply 幂等 drop**：已 resolved / cancelled 的 id 再次 reply，不抛错、不 drop 连接，直接丢弃（防重传）
- **cancel 互斥**：`timeout` / `abort` / 正常 `reply` 三路径通过 `pending.delete(id)` 互斥——先到先赢
- **stop 顺序的业务语义**：先 cancel pending（让等待者立刻 unblock），再停 reader（避免 stop 过程中事件仍尝试 broadcast），再 drop 连接（通知客户端 `connection_dropped`），最后 close transport
- **连接 drop 策略**：malformed JSON / unknown message type 直接 `dropConnection`；ask_user_reply 的 id 未知**不 drop**（防重复消息导致连接误杀）
- **getActiveConnections 返回派生快照**：`Array.from(connections.values())`，调用方修改不影响 Gateway 内部 Map

### 失败分类

| 失败源 | Gateway 行为 | 分类 |
|---|---|---|
| start 重复调用 | 抛 `Error('Gateway already started')` | 调用方 bug（不可预期） |
| askUser 未 start | 抛 `Error('Gateway not started')` | 调用方 bug（不可预期） |
| askUser offline 模式 | 返 `failureResult('未启用实时交互通道，跳过 ask_user')` | 软失败（调用方显式处理） |
| askUser ctx.signal 已 aborted | 返 `failureResult('ask_user 被中断取消')` | 软失败 |
| askUser 超时 | cancel(id, 'timeout') → `failureResult('用户未回复（超时 <ms>ms）')` + 广播 `ask_user_cancelled` | 预期失败（软失败） |
| askUser ctx.signal abort | cancel(id, 'abort') → `failureResult('ask_user 被中断取消')` + 广播 `ask_user_cancelled` | 预期失败（软失败） |
| askUser 正常 reply | `successResult(answer)` + 广播 `ask_user_resolved` | 成功 |
| 客户端消息 malformed JSON | `dropConnection(conn.id, 'malformed JSON')` | 预期失败（协议层） |
| 客户端消息 unknown type | `dropConnection(conn.id, 'unknown message type')` | 预期失败（协议层） |
| 客户端 ask_user_reply id 不存在 | drop 该消息（**不 drop 连接**） | 预期失败（幂等丢弃） |
| interrupt debounce 命中 | drop 该消息（**不 drop 连接，不 emit**） | 预期失败（节流） |
| transport.broadcast 抛错 | **当前**：`console.error('[Gateway] broadcast failed:', err)` 兜底——**见 §7 A.2 联动违规** | 不可预期（当前被吞） |
| handleClientMessage 外层抛错 | **当前**：`console.error('[Gateway] handleClientMessage error:', err)` 兜底——**见 §7 A.2 联动违规** | 不可预期（当前被吞） |

## 3. 审计事件清单

**phase256 实装 10 events**（原设计 11 条 / N1 合并 / N2 重命名 / 见 §7 A.3）：

| 事件名 | 触发位置 | 载荷字段 |
|---|---|---|
| `gateway_started` | `start()` 末尾（online only）| `isOnline` |
| `gateway_stopped` | `stop()` 末尾 | — |
| `gateway_ask_user_pending` | `askUser` pending.set 之后 | `id` |
| `gateway_ask_user_resolved` | 客户端 reply 到达 | `id`, `by`（connectionId） |
| `gateway_ask_user_cancelled` | timeout / abort | `id`, `reason` |
| `gateway_ask_user_reply_dropped` | 客户端 reply 的 id 不存在 | `id`, `connId` |
| `gateway_connection_dropped` | `dropConnection`（含 broadcast write failed）| `connId`, `reason` |
| `gateway_interrupt_triggered` | interrupt 通过 debounce 触发 | `connId` |
| `gateway_interrupt_debounced` | interrupt debounce 命中（drop）| `connId` |
| `gateway_transport_error` | `onTransportError` handler（替代 console.error）| `kind`, `error`/`callbackName` |

**N1**：`gateway_broadcast_failed` 删除（phase253 后 broadcast 返回 `{ failed }[]` 不 throw → failure 走 `gateway_connection_dropped` reason='broadcast write failed'）  
**N2**：`gateway_client_message_failed` 重命名为 `gateway_transport_error`（phase253 onMessage 错误经 Transport safeFire → onTransportError）

**归属原则**（与 LLMService `LLMEventSink` 同构）：Gateway 为 L3，audit 必传已在 L2 全系统落地（Phase 148），L3 可直接 `audit: Audit` 构造期注入（不需协议包装，因为 L3 依赖 L2 合规）。phase157 实施时在 `GatewayInput` 加 `audit: Audit` 必传参数。

## 4. 上游依赖

| 依赖契约 | 版本约束 | 消费面 |
|---|---|---|
| `l2_stream.md`（StreamReader / StreamEvent） | 同仓 | 通过 `streamFactory: (onEvent) => StreamReader` 注入；Gateway 不知道 StreamReader 构造签名（FileSystem / audit / path 等由装配层吸收） |
| `l1_transport.md`（Transport / Connection） | 同仓（**当前实然落后于契约 A.1-A.3**，见 §7 A.2） | `GatewayInput.transport` 可选，必须已处于 listening 状态；Gateway 只绑 onConnect/onDisconnect/onMessage 回调 + 在 stop 时调 close |
| `ExecContext`（工具层类型） | 同仓 | `askUser(question, ctx)` 消费 `ctx.signal`（abort 信号）；Gateway 不消费 `ctx` 其他字段 |
| Daemon interrupt 回调 | 同仓（反向控制流，见 §5.1） | `GatewayInput.interrupt: (reason: 'user') => void`；协议化注入，Gateway 不 import Daemon |
| 外部 npm | 无特殊版本锁 | 不直接依赖外部包（Transport 层吸收 node:net / unix-socket 等） |

## 5. 不可消除的耦合

**消除路径首选 port pattern**（feedback_module_contract_structure r40.2）：消费方 own port + 默认实现 + assembly 注入 / phase337+335+340 三 phase 实证。Gateway 的 `interrupt` 回调 + Transport interface + Stream 工厂注入即 port 范本（消费方 own / Daemon + Assembly 注入实现）。

| # | 方向 | 是否类型化 | 消除路径 / 放弃理由 |
|---|---|---|---|
| 1 | Gateway → Daemon interrupt 回调（反向控制流） | 类型化（`(reason: 'user') => void`） | 合规：Gateway 定义协议（`(reason: 'user') => void`），Daemon 装配期注入实现——**与 LLMService `LLMEventSink` / Transport `TransportErrorEvent` 同型**（底层定义协议、装配层注入实现），满足原则 #9 "显式表达优先编译器可检"。单向回调（Gateway 触发 → Daemon 消费），**不形成 A→B→A 循环**；注：phase163 消除的 SubagentSystem ↔ TaskSystem 是业务语义真循环（self-amplifying：spawn → taskSystem → SubAgent → 再调 spawn），本条形态不同 |
| 2 | Gateway → Stream 只读订阅 | 类型化（`streamFactory: (onEvent) => StreamReader`） | 放弃消除：stream → 客户端广播是 Gateway 核心职责；工厂注入已使 Gateway 不知道 StreamReader 构造签名 |
| 3 | Gateway ↔ Transport 生命周期绑定 | 类型化（Transport interface） | 放弃消除：数据面必须绑定连接层生命周期；装配层保证传入 Transport 已 listening，stop 时 Gateway 调 close |
| 4 | Gateway → Transport 连接视图派生 | 类型化（Connection interface） | 放弃消除：连接视图是 Gateway 对外承诺（getActiveConnections）；Connection id 对 Gateway opaque，不持久化 |
| 5 | Assembly → Gateway 装配 import（assemble.ts 直接 import `createGateway`） | 类型化（工厂函数 + GatewayInput 接口） | 放弃消除：Assembly 是装配胶水必须知道被装配模块工厂；与 phase155 既有 builtins / Heartbeat 等装配耦合同模式 |

详述：

1. **Gateway → Daemon interrupt 回调（反向控制流）**：Daemon 构造 Gateway 时注入 `interrupt: (reason: 'user') => void`；客户端发起 interrupt → Gateway 经 debounce 后调此回调 → Daemon 决策如何终止当前 agent 执行。控制流方向反向（L3 → L6a），通过回调协议表达，Gateway 不 import Daemon。
2. **Gateway → Stream 只读订阅**：通过 `streamFactory: (onEvent) => StreamReader` 注入工厂而非直接 import `createStreamReader`——Gateway 不知道 StreamReader 构造签名（FileSystem / audit / path 等由装配层吸收）。事件到达后 Gateway broadcast 给所有连接，**不阻塞 writer**，不做 backpressure（backpressure 由 Transport 或未来桥接层）。
3. **Gateway ↔ Transport 生命周期绑定**：`GatewayInput.transport` 若传入，**必须已经 listening**；Gateway 只绑 onConnect/onDisconnect/onMessage 回调、不调 `transport.listen()`；stop 时 Gateway 调 `transport.close()`。生命周期耦合显式登记，装配层保证传入顺序。
4. **Gateway → Transport 连接视图派生**：`connections: Map<id, Connection>` 跟随 `onConnect`/`onDisconnect` 维护；Connection id 对 Gateway opaque（由 Transport 生成）；Gateway 不持久化 connection 状态——重启后从新 onConnect 回调重建。
5. **Assembly → Gateway 装配 import**：`src/assembly/assemble.ts` 直接 `import { createGateway } from '../core/gateway/gateway.js'` + `import type { Gateway } from '../core/gateway/types.js'`。Assembly 作为装配胶水必须知道工厂签名 + 类型；不通过 deps 注入因为 Gateway 实例由 Assembly 自己构造（与 Heartbeat / CronRunner 同模式）。phase157 装配落地。

## 6. 持久化

**无磁盘资源**。Gateway 是门面派生态，持久化归下游：

| 信息 | 归属模块 | 落盘位置 |
|---|---|---|
| 对话内容（askUser 问答对） | SessionStore（L2） | `current.json` / archive |
| 事件历史（ask_user / interrupt / 连接生命周期） | AuditLog（L2） | `audit.tsv`（当前 Gateway 事件数 = 0，见 §7 A.3） |
| connections / pending / lastInterruptTs / started | Gateway 运行时派生态 | 不落盘 |

**重建语义**：

- **connections**：重启后由 Transport 新 `onConnect` 回调重建——客户端需重连
- **pending ask_user**：stop 时走 abort 收口 → audit 留痕（应然；A.3 未落地）→ 下次启动 `SessionManager.repair` 注入 synthetic tool_result（"Cause unknown ..."）让 LLM 可继续
- **lastInterruptTs / started**：运行期派生，重启归零

符合 Design 原则「持久化一切信息到磁盘，运行时句柄从磁盘信息重建」——派生态可丢弃，底层信息（对话 / 事件）已在 SessionStore + AuditLog 落盘。

> **⚠️ 当前链路断裂**（见 §7 A.3）：上表「pending ask_user 重建语义」依赖 `gateway_ask_user_cancelled` audit 事件在 stop 时写入，当前 Gateway audit 事件数 = 0，链路**应然存在、实然未落地**；phase157 A.3 实施后重建语义才真正生效。

## 7. 与实然的差距

### A 类（必修违规，phase157 scope）

~~**A.1 Gateway 装配状态**（phase156 登记，phase157 部分落地）~~ → phase261 已清零（`toolRegistry.register(createAskUserTool(gateway))`）

**phase156 登记**：
- `src/` 中零 `createGateway` / `createAskUserTool` 消费点
- ~~ask_user 工具从未注册到 agent 工具系统~~
- Gateway 代码由 phase146 4 个 commit 建成（`6edcfec` / `6fa0bf2` / `47896e6` / `9625002`），23 个 `it` 齐全但运行时未激活

**phase157 状态更新**：
- ✅ Gateway 已装配进 motion Assembly（offline 模式）：`src/assembly/assemble.ts` motion 分支调 `createGateway({ transport: undefined, ... })`
- ✅ Instances 接口加 `gateway?: Gateway` optional 字段（motion only）
- ✅ disassemble 最前位置调 `gateway?.stop()`，与 phase156 契约 §2 stop 顺序对齐
- ~~⏸️ ask_user 工具**未注册到 toolRegistry**——offline 模式下永远返 failureResult，按 Design Principle「恰好需要时提供，避免上下文负担」推迟到 phase169+ Transport 接入随激活动作一并注册~~
- ⏸️ Transport 接入留 phase169+（A.2 联动）
- ⏸️ 11 个 audit 事件接入留 phase170（A.3）
- ⏸️ claw 中介机制（claw → motion ask_user 路径）留 phase174+

**修复方向更正**（phase156 原写"motion 不启 / claw 启"）：
- **motion 启 / claw 不启**——与 `modules.md` 关键决策 #25「用户 ↔ motion ↔ claw，claw 用户交互全部经 motion 中介」一致
- 来源：phase157 Step 1 扫描发现 phase156 修复方向与 modules.md #25 冲突，按 #25 为准

违反 Philosophy 的状态：
- "用户可以观察运行过程中的所有状态"—— Gateway offline 不直接广播；当前 CLI chat-viewport 直读 stream.jsonl 满足，phase169+ Transport 接入后由 Gateway 接管
- ~~"系统为智能体服务"—— ask_user 未注册，agent 暂无询问用户能力；待 phase169+~~ → **phase261 已清零**

**→ phase261 已清零**（2026-04-24 / r19 分支 D）：
- `assemble.ts` import `createAskUserTool` + `if (isMotion)` 块内 `toolRegistry.register(createAskUserTool(gateway))`
- comment 更新：删 "ask_user 注册留 phase169+"
- 决策 #25 对齐：motion 启 / claw 不启

**A.2 console.error 2 处兜底 — ✅ phase253 联动清零**

- `gateway.ts` L55-62：broadcast 包装器改为处理 `{ failed }` 返回 / `dropConnection` 主动清理（不再 try/catch 兜底）
- `gateway.ts` L141-146：onMessage try/catch 删除 / 错误走 Transport safeFire → onTransportError
- 注册 `transport.onTransportError` interim 处理器（console.error 临时 / Gateway A.3 phase 替换为 audit）

**根因分析**（phase253 前）：违规不归 Gateway 单方，而是 Transport 契约 A.1-A.3 登记但未实施的联动结果。phase253 实施后 Transport 已暴露结构化通道，Gateway 同步联动清零。

**A.3 审计事件清单完全缺失 — ✅ phase256 已清零**

- **phase256 实施**：`GatewayInput` +`audit: AuditWriter`（必传）；10 个 GATEWAY_* 事件全量覆盖；`gateway.ts` console.error 0；main 326746e
- **N1 drift 处置**：`gateway_broadcast_failed` 合并入 `gateway_connection_dropped`（phase253 broadcast 返回 `{ failed }` 不 throw，write failure → `dropConnection(reason='broadcast write failed')`）
- **N2 drift 处置**：`gateway_client_message_failed` 重命名为 `gateway_transport_error`（onTransportError 统一处理器，phase253 架构路径改变）
- **实装 10 events**：GATEWAY_STARTED / GATEWAY_STOPPED / GATEWAY_ASK_USER_PENDING / GATEWAY_ASK_USER_RESOLVED / GATEWAY_ASK_USER_CANCELLED / GATEWAY_ASK_USER_REPLY_DROPPED / GATEWAY_CONNECTION_DROPPED / GATEWAY_INTERRUPT_TRIGGERED / GATEWAY_INTERRUPT_DEBOUNCED / GATEWAY_TRANSPORT_ERROR

<!-- A.4 Gateway → Daemon interrupt 回调循环耦合：**2026-04-20 修订判据后撤回**

初版登记：我根据"必须消除循环耦合"立场把此条升 A 类。
修订后判据：interrupt 回调是"Gateway 定义协议 + Daemon 注入实现"——与 LLMService LLMEventSink 同型，**不构成 A→B→A 循环**，是合规的反向依赖（L3 定义协议，L6 装配注入）。
phase163 消除的 SubagentSystem ↔ TaskSystem 是真循环（业务 self-amplifying）；interrupt 回调仅是**触发信号单向传递**，Daemon 不反向调 Gateway。
撤回此 A.4 条目；详 §5 #1 新措辞。-->


- **联动违规**：§2 失败表「ask_user_reply id 不存在 → drop 该消息」当前无审计事件——违反 Design Principle「运行中产生的任何信息未经显式设计决策不得丢弃或静默忽略」（drop 决策已显式，但信息被丢弃无痕）；§3 已补 `gateway_ask_user_reply_dropped` 事件，phase157 实施时一并落地

### B 类（偏差登记，当前合理）

**type 标签**（feedback_module_contract_structure r40.3）：B 项必标 `drift` vs `design-gap` 二分。
- **drift type**：契约说应 X / 实然 Y / 修法明确（推 §7.A 必修）
- **design-gap type**：应然 silent / 实然有 / 修法不明 / 必推独立 design phase 评估

> 现有 B 类历史登记 type 分类待 r43+ 应然同步 phase 批量补标。已知初判：
> - ask_user 工具同模块 = **design 决策已存**（业务语义一致）
> - getActiveConnections / isOnline 零消费 = **design 决策已存**（预留接口 / 升档条件已登）
> - askUserTimeoutMs 测试覆盖 = **design 决策已存**
> - 运行时 inert 状态 = **design 决策已存**（phase157+ 决策）
> - **r43 A audit fork 验证**：l3_gateway 实然 100% align / 0 drift（B.p344 合规反例第 3 个 / 与 messaging + session_store 同 reference 模板）

- **`ask_user` 工具与 Gateway 同模块**（`ask-user-tool.ts` 26 行）：业务语义一致（都是"与用户实时交互"），合规 #1；未来若扩多种用户交互工具（confirm / choose 等）可评估拆 `user-interaction-tools` 子模块——当前单一工具不拆
- **`getActiveConnections` / `isOnline` src 零消费**（Step 1 扫描）：**非未使用代码**，是为未来 Gateway 装配后 CLI status / 监控层预留（`clawforum status` 查在线连接数 / 监控面板查在线状态）。契约保留两个方法的应然承诺；若 phase157 装配后仍无消费方 → 升 A 类考虑移除
- **`askUserTimeoutMs` 可被 `GatewayInput` 覆盖**：仅测试使用（生产走 `GATEWAY_ASK_USER_TIMEOUT_MS` 默认 30 分钟）；保留作为契约灵活点，不构成界面泄漏
- **`GATEWAY_INTERRUPT_DEBOUNCE_MS` / `GATEWAY_ASK_USER_TIMEOUT_MS` 硬编码常量**：归属 `src/constants.ts` L159-165；不定制化
- **运行时 inert 状态（phase157 → phase169+）**：phase157 完成 motion offline 装配后，`src/` 中**零** `gateway.start()` 调用方、**零** `instances.gateway` 消费点（Daemon 不读字段）。Gateway 实例存在于 Instances 但运行时完全 inert：
  - `streamFactory` / `interrupt` 闭包永不 fire（无人调 start，watcher 不装载）
  - `isOnline()` 永远返 false（`transport: undefined` + 一次性定型）
  - disassemble 调 `gateway?.stop()` 因 `started=false` 立即 return（idempotent）
  - 内存占用：5 个 Map + 6 个 boolean / number ≈ 可忽略

  **设计意图**：phase169+ Transport 接入时改 `transport: undefined → <Transport 实例>` + Daemon 加 `await instances.gateway?.start()` 即可激活，Assembly 结构无需改动。

  **判定合规**：B 类（偏差登记，当前合理）——预备性装配换取 phase169+ 改动面最小化，权衡符合「耦合界面稳定 #7」。

### C 类（原则对照补充）

- **#1 独立可变职责 / 为何不拆 4 个子模块**（连接管理 / interrupt 路由 / stream 订阅 / ask_user）：反向测试——4 个子能力共享 `connections` / `broadcast` / Transport 单例，改任一的连接语义会动其他三个 = **一组共享资源的子能力集合，不是独立可变职责**，不拆（`feedback_m1_reverse_test`）
- **#2 业务语义归属**：askUser / stream 订阅 / interrupt 路由均归 Gateway 发起（"客户端交互"这一业务语义的唯一入口）
- **#5 底层不预设上层**：Gateway 依赖 Stream（L2）+ Transport（L1）+ ExecContext（工具层）——全下层；interrupt 回调由 Daemon 注入（控制倒置），Gateway 不 import Daemon
- **#6 依赖结构稳定**：`isOnlineMode` 启动期一次性定型，运行期不变；connections Map 运行时变但属 Gateway 内部派生态，不是"模块间依赖关系"
- **#7 耦合界面稳定**：Gateway interface 5 方法 + 4 消息类型形态固定；本 phase 不改接口
- **#8 耦合界面最小**：`streamFactory` 工厂注入而非直接 import `createStreamReader` 构造器——Gateway 不知道 StreamReader 的 FileSystem / audit / path 等构造依赖（装配层吸收）
- **#9 显式表达优先编译器可检**：`ClientMessage` / `ServerMessage` discriminated union，switch 分支穷尽 tsc 可保证
- **Philosophy "CLI 唯一对外入口" vs Gateway 存在**：区分控制面（CLI，daemon 生命周期管理）vs 数据面（Gateway，运行中 agent ↔ 客户端交互），两者并列不冲突——见头部段详述。~~**A.1 现实下数据面尚未激活**，契约同时登记应然区分 + 当前未启用~~ → **A.1 phase261 已激活**（toolRegistry.register(createAskUserTool(gateway)) / r31 主会话补 r30 E + r31 B 漏 scope）

### 7.C 原则对照（32 条，phase200 补齐）

对齐 phase187 L1 / phase193 L2 批量 backfill 模板（Module 11 + Design 11 / #1 展 4 面 + Philosophy 4 + Path 6）。与既有 C 类 7 条原则对照摘要互补：既有 C 类按深度按需展开判例；本节提供完整 32 条覆盖。合规一行按需；驱动/约束/灰度标黑。

#### Module Logic Principles（11 条）

- **M1 独立可变职责**：合规（既有 C 类 #1 详细反向测试：4 子能力共享 `connections` / `broadcast` / Transport 单例 → 不拆）
- **M2 业务语义归属**：合规（既有 C 类 #2：askUser / stream 订阅 / interrupt 路由 / 连接管理均 Gateway 发起）
- **M3 资源归属**：合规。Transport 归 Transport / Stream 归 Stream；Gateway 持引用消费。`connections` Map 归 Gateway 独占
- **M4 持久化**：合规。Gateway 纯运行时（连接状态 / interrupt 防抖 / pending ask 均内存态，重启丢失容忍）
- **M5 依赖单向**：合规（既有 C 类 #5：L3 Gateway → L2 Stream + L1 Transport + 工具层 ExecContext；interrupt 回调 Daemon 注入属控制倒置形态 B，非循环耦合——`feedback_cycle_vs_reverse_dependency` 判例）
- **M6 依赖结构稳定**：合规（既有 C 类 #6：`isOnlineMode` 启动期一次性定型）
- **M7 耦合界面稳定**：合规（既有 C 类 #7：5 方法 + 4 消息 type 固定；本 phase 不改接口）
- **M8 耦合界面最小**：合规（既有 C 类 #8：`streamFactory` 工厂注入而非直接 import 构造器）
- **M9 显式表达编译器可检**：合规（既有 C 类 #9：`ClientMessage` / `ServerMessage` discriminated union，switch 穷尽 tsc 可保证）
- **M10 不合理停下**：未触发（phase157 已实测 motion 装配落地）
- **M11 边界不对停下**：未触发

#### Design Principles（11 条 / #1 展 4 面 = 14）

- **D1a 信息不丢失**：✓（§7.A.1 phase261 + A.2 phase253 + A.3 phase256 全清零；10 audit 事件覆盖，信息无丢失路径）
- **D1b 状态可观察**：灰度（`isOnline()` / `getActiveConnections()` 可查；但 interrupt 防抖 / pending ask 状态不可外部观察——当前消费者无需求）
- **D1c 中断可恢复**：合规。`stop()` idempotent + offline 模式 no-op；重启后连接重建（pending ask 丢失属预期，消费者见 timeout 即重试）
- **D1d 事后可审计**：✓（phase256 实装 10 GATEWAY_* 事件全量覆盖；A.1 phase261 ask_user 4 audit 事件补齐）
- **D2 不得丢弃/静默**：✓（A.2 console.error 2 处 phase253 清零；`gateway_ask_user_reply_dropped` phase256 落地；drop 路径已 audit 覆盖）
- **D3 用户可观察**：**驱动原则**（Gateway 数据面核心：用户 ↔ agent 交互中介；A.1 phase261 ask_user 工具注册后已激活，完整落地）
- **D4 LLM 调用恢复**：无关（Gateway 不涉 LLM）
- **D5 日志重建**：✓（同 D1d → phase256 10 audit 事件落地；Gateway 事件轨迹可从 audit.tsv 完整重建）
- **D6 智能体决策主体**：无关（Gateway 是交互中介）
- **D7 系统可信路径**：合规（Gateway 作为受信中介组件）
- **D8 事件驱动**：**驱动原则**（Transport `onMessage` / Stream `onEvent` / interrupt 触发信号 全事件驱动）
- **D9 多 claw 不隔绝**：合规（用户 ↔ motion ↔ claw 中介：claw 用户交互全经 motion 中介，modules.md 决策 #25）
- **D10 motion 特殊**：**约束原则**（phase157 motion-only 装配；A.1 phase261 清零后 ask_user 工具注册，claw 路径通过 motion 中介）
- **D11 CLI 唯一对外**：合规（既有 C 类头部段详述：控制面 CLI / 数据面 Gateway 两者并列不冲突）

#### Philosophy（4 条）

- **P1 Agent 即目录**：合规（Gateway 本身不直接涉目录；消费 Stream 数据面走 `stream.jsonl`）
- **P2 上下文工程**：无关（Gateway 是运行时交互中介，不涉 context 构建）
- **P3 多 agent 利用**：**约束原则**（phase157 motion-only 装配支持多 claw；claw 不启交互归 motion 中介）
- **P4 系统为智能体服务**：**驱动原则**（`ask_user` 工具让 agent 能询问用户；A.1 phase261 清零后已激活，agent 可实时询问用户）

#### Path Principles（6 条）

- **Path #1 规划基于规划时刻事实**：✓ 契约 Read + 源码 334 行核 + 既有 A/B/C 类逐条核 → **无 drift 发现**（契约↔实然一致）
- **Path #2 差距显式登记**：✓ A 类 3 条真 open 保留 + 依赖 phase201+ Transport 先行
- **Path #3 语义一致最小变更单元**：✓ APPEND 子节不改既有 A/B/C 类 + modules.md 索引漂移节
- **Path #4 可回滚**：本地 only / 无破坏
- **Path #5 完成后复盘**：phase200 Step 4
- **Path #6 冲突立即中断**：触发 6 次（phase194-199 占号 → 切 200）

### 7.D 关键决策映射表（modules.md 迁移）

从 `design/modules.md` §关键设计决策章节迁移（2026-04-26 主会话；后续清理阶段重构）。原 KD 编号保留供对账。

- **KD#12（原 modules.md）Gateway 桥接 Stream 与 Transport**：订阅 Stream 变更 + 推送给客户端,接收客户端信号 + 路由到系统
- **KD#14（原 modules.md）中断信号走 Gateway → 回调**：Gateway 收到客户端中断信号后通过 Daemon 注入的回调触发 abort,不走磁盘文件
- ~~**KD#26（原 modules.md）用户 ↔ motion ↔ claw 中介模型（Gateway / Transport motion 独占）**~~：用户通过 TUI / IM bot 直连 motion（Transport + Gateway 数据面）；claw 与用户**无直连**。claw 的用户交互需求（观察 stream / ask_user / interrupt 响应）全部经 motion 中介：
    - **观察 stream**：motion 读 claw 的 `stream.jsonl`（motion 对 claw 有单向访问权），经 motion 的 Gateway 转发给 TUI
    - **ask_user**：claw 的 ask_user 需求不走 `Gateway.askUser`（claw 无 Gateway 实例）；应通过 Messaging 发给 motion → motion 的 Gateway 问用户 → 回复经 Messaging 返 claw
    - **interrupt**：用户在 TUI 触发 → motion Gateway 收到 → motion 通过 CLI / Messaging 把 interrupt 路由到 target claw
    - **装配结果**：Gateway / Transport 装配归属 = `motion` 独占；claw identity 不装。Assembly identity 分支依此执行
    - 此决策消解了"Philosophy 说 CLI 是唯一对外入口 vs Gateway 对外"的表面冲突：CLI 是控制面入口（命令、生命周期），Gateway 是数据面入口（运行时交互），两者并列；数据面**仅在 motion 层开放**，不扩散到 claw

⚠️ **drift 待治理**（V1 / 主会话 2026-04-26 识别）：「motion 读 claw stream.jsonl」违反 Philosophy 11「CLI 唯一对外入口」+ Module Logic 3「每种资源只归唯一模块对外入口」+ phase134 memory 早决「观察是 Watchdog 职责 / motion 主动查询走 exec CLI」。本条整体应重写为「motion 经 claw CLI 中介 / 不直读 fs」。drift 治理另排 phase。

**【过时】**（2026-04-26 主会话标记）：本 KD 跟当前 Philosophy 不一致 / 不再作架构权威 / 仅保留作历史登记。

**与 Philosophy 的冲突**：
- 当前 Philosophy 11「CLI 是 claw 和 motion 的唯一对外入口」+ user expectation「能像用 motion 一样用 claw」→ Transport / Gateway 应然装配「按需」/ 不预设 motion 独占
- KD#26「motion 单向访问权 / claw 无直连」过度收紧 / 把 default 配置当架构约束

**取代 framing**：
- Transport / Gateway 装配归属「按需」（任何 daemon 装配方决定）
- 用户对 motion 和 claw 等价交互（接口在两者上都可装）
- motion 仍是特殊 claw（Philosophy 4「单向访问权」）/ 但「单向访问权」是能力 / 不是排他

**V1 drift 治理仍有效**：「motion 经 claw CLI 拿 stream / 不直读 fs」/ 跟过时 framing 无关。

---

### 7.Phase 执行纪律

#### phase320 纪律 — 契约描述行 drift 修订（r30 分支 E / 2026-04-25 / design only）

- **scope**：§A 必修违规节 A.1 标题 + "从未注册"段 + "未注册到 toolRegistry"段补删除线 + 清零标（r30 C phase317 漏 scope 补救）
- **变更**：A.1 标题加 `~~...~~ → phase261 已清零（toolRegistry.register(createAskUserTool(gateway))）`；A.1 内 2 处"未注册"描述行加 `~~...~~`
- **性质**：纯 design / 本地 only / 无代码改动

#### phase317 纪律 — 契约 drift 修订核验（r30 分支 C / 2026-04-25 / design only）

- **scope**：§7.A A.1/A.2/A.3 核验 — 已标 phase261/253/256 清零 / 状态准 / 无 drift

#### phase200 纪律 — L3 Gateway backfill（2026-04-22，design 本地 only）

**scope**：承 phase187/192/193/195/196 APPEND 不解构模式；phase196 "§7 内 APPEND 子节"形态第 2 次触发（编号已占变种）

**产出**：
- 既有 `## 7. 与实然的差距` + A 类 3 / B 类 5 / C 类 7 / modules.md 索引漂移节全保留不改
- 新增 `### 7.C 原则对照（32 条）` + `### 7.Phase 执行纪律`（本节）
- 契约 +~100 行

**形态定位**：**"§7.A 真 open 保留"子形态**（与 phase196 "Path #1 drift 批量捕获"对照）：

| 维度 | phase196 L2 Snapshot | **phase200 L3 Gateway** |
|---|---|---|
| §7.A 状态 | A.6/A.7 代码已实施但契约未同步 | A.1/A.2/A.3 契约承认 open + phase157 部分落地 |
| Path #1 drift | 5 条批量捕获 | **无 drift**（契约↔实然一致）|
| 本 phase 动作 | 登记 drift + 推迟独立修订 phase | **A 类不动 + 等外部 phase 联动兑现** |
| 外部依赖 | 独立契约修订 phase | Transport 契约 A.1-A.3 先行（phase169+）|

**Path #1 drift 核结果**：**零 drift 发现**（5 点佐证）：
1. console.error 2 处 gateway.ts L60/L145 ↔ 契约 §7.A.2 一致
2. 0 audit 事件 ↔ 契约 §7.A.3 一致
3. ask_user 未注册到 toolRegistry ↔ 契约 §7.A.1 phase157 状态更新段一致
4. Transport 接入未落地 ↔ 契约 §7.A.2 根因分析段一致
5. 11 audit 事件清单未实装 ↔ 契约 §3 审计事件清单（应然）vs 实然 0 命中一致

**既有 C 类 7 条 vs 新增 §7.C 32 条定位**：
- 既有 C 类：原则对照**摘要**（深度按需展开关键判例：#1 反向测试 / #5 下行依赖 / #7 接口稳定 / Philosophy "CLI 唯一对外"辨析）
- 新增 §7.C：**完整 32 条**覆盖（驱动 / 约束 / 灰度 / 合规 / 部分违反 / 无关 六档枚举）
- 两者互补不冲突；既有摘要深度详细判例，新增枚举保证覆盖完整

**升格候选触发**：

- **"§7 内 APPEND 子节"形态第 2 次触发**（phase196 首次 / phase200 第 2 次）
  - 适用场景：既有契约 `## 7.` section 已占 + 有 §A/§B/§C 子节
  - 达 2 次阈值 → 可硬化到 `feedback_module_contract_structure` §backfill APPEND 模板节（扩展 phase194 硬化的 "APPEND 不解构"）
  - **分发给下一 Meta phase**（候选 phase205+）

**对比定位**：
- 与 phase192（SessionStore "backfill 零新增"）：本 phase **非零新增**（新增 §7.C 32 条 + §7.Phase + 0 drift）
- 与 phase193（L2 纯通用 APPEND 全新 §7 节）：本 phase **子节 APPEND**（编号已占变种）
- 与 phase195（L2 ProcessManager §9 物理编号 APPEND）：形态相近，但 phase195 APPEND 新 §9 / phase200 在 §7 内 APPEND 子节
- 与 phase196（Snapshot drift 批量捕获）：**本 phase 零 drift**（契约与实然透明一致）
- 与 phase197（L3 executor backfill 后续）：同 L3 层 backfill 批，本 phase Gateway 完成

**方法论贡献**：
1. "§7.A 真 open 保留" 子形态登记：契约承认 open + 依赖外部 phase 联动兑现 → backfill 不硬凑 §7.A 零条
2. "既有 C 类摘要 vs 新增 §7.C 完整"互补模式：既有深度判例 + 新增完整覆盖（两者共存不冲突）
3. Path #1 drift 核 5 点佐证路径：逐条既有 A 类断言 vs 实然 grep 核对

#### phase253 纪律 — Gateway Transport 联动清零（r17 分支 C / main 85d1a60）

- **scope**：Gateway §7.A A.2 联动清零（3 处：broadcast 包装 / onDisconnect 签名 / onMessage try/catch）
- **解锁**：Gateway §7.A A.3（11 audit 事件）可独立 phase 实施
- **B.2 依赖注意**：此 phase 不改 Gateway broadcast 的 audit 路径（A.3 deferred）
- **测试联动**：gateway.test.ts + gateway-ask-user.test.ts 的 createStubTransport mock 同步更新（新增 onTransportError / broadcast 返回 `{ failed: [] }`）

#### phase256 纪律 — Gateway §7.A A.3 全量 audit 集成（r18 分支 B / main 326746e / 2026-04-24）

- **scope**：`GatewayInput` +`audit: AuditWriter`（必传）；`gateway.ts` 10 处 `audit.write()`（console.error L148 替换 + 9 处新增）；`events.ts` +10 GATEWAY_* 常量；`assemble.ts` createGateway 传 audit；tests +11 it
- **N1 drift**：`gateway_broadcast_failed` 合并 → `gateway_connection_dropped`（phase253 broadcast 不 throw）
- **N2 drift**：`gateway_client_message_failed` 重命名 → `gateway_transport_error`
- **§7.A 状态**：A.3 ✅ 全清零；**Gateway §7.A A.2（phase253）+ A.3（phase256）双清零完成**；A.1 ⏸️ 仍遗留（ask_user 工具注册）
- **Transport-Gateway 阻塞链路**：phase253（Transport §7.A）+ phase256（Gateway §7.A A.3）= 阻塞链路全打通

#### phase261 纪律 — Gateway §7.A A.1 ask_user 工具注册（2026-04-24 / r19 分支 D）

- **scope**：`assemble.ts` `if (isMotion)` 块内 `toolRegistry.register(createAskUserTool(gateway))`（+3 行）+ import `createAskUserTool`（+1）+ comment 更新
- **前置条件全就绪**（phase146/156/256 接力）：`createAskUserTool` 工厂 ✓ / 4 audit 常量 ✓ / gateway.ts 4 audit 事件 ✓ / `toolRegistry.register` API ✓
- **gateway/toolRegistry 顺序**：toolExecutor L264 早于 gateway L377；ToolRegistryImpl 为动态 Map，延迟注册合法（toolExecutor 读 registry at call time）
- **§7.A 状态**：A.1 ✅ 清零；**Gateway §7.A A.1（phase261）+ A.2（phase253）+ A.3（phase256）全清零**
- **测试**：`describe('createAskUserTool')` 补 1 it（name + schema 属性 / 行为契约族三元素完整）

#### phase279 纪律 — §7.C cascade 补登记（2026-04-25，r22 分支 E）

- **scope**：r22 E phase279 §7.C 治理跟进；Gateway §7.A A.1（phase261）+ A.2（phase253）+ A.3（phase256）全清零后 §7.C cascade 补登记
- **cascade 前进 7 条**：D1a 部分违反→✓ / D1d 违反→✓ / D2 部分违反→✓ / D3 驱动原则 A.1 caveat 移除 / D5 违反→✓ / D10 约束原则 caveat 更新 / P4 驱动原则 A.1 caveat 移除
- **触发源**：phase253（A.2）+ phase256（A.3）+ phase261（A.1）三 phase 接力清零 → 本 phase cascade 登记
- **纯 design / 本地 only / 无 SHA**

### modules.md 索引漂移（本 phase Step 3 顺手修）

| 字段 | 索引现状（L184-193） | 应修正为 |
|---|---|---|
| 依赖 | `Stream, Transport(可选)` | `Stream（通过 streamFactory 注入）、Transport（可选，L1；当前实然落后于契约，Gateway 只能用 best-effort broadcast）` |
| 耦合 | `interrupt 回调（由 Daemon 注入）` | 4 条：interrupt 回调 / Stream 只读订阅 / Transport 生命周期绑定 / 连接视图派生 |
| 被谁调用 | `Daemon(启动时创建)` | 保留应然 `Daemon` + 加注`（A.1 当前未落地，待 phase157+）` |
| 导出工具 | `ask_user` | 保留应然 + 加注`（当前未注册到工具系统）` |

## 8. 测试覆盖

`tests/core/gateway.test.ts`（310 行 / 13 `it`）+ `tests/core/gateway-ask-user.test.ts`（317 行 / 10 `it`），合计 **23 个 `it`**：

| 覆盖面 | 代表断言 |
|---|---|
| 生命周期 | start 重复抛错、stop idempotent、offline 下 start/stop no-op |
| online / offline 定型 | `isOnline()` 三态（未启 / online / stopped） |
| stream 广播 | `streamFactory` 注入 onEvent → transport.broadcast 收到 `{ type: 'stream', event }` |
| 连接生命周期 | onConnect 后 `getActiveConnections` 反映；onDisconnect 后移除 |
| interrupt 路由 + debounce | 首次 trigger 调回调；窗口内第二次丢弃 |
| ask_user 三路径 | timeout / abort / 正常 reply |
| ask_user 多客户端 | 多连接同时收 pending，先到 reply 赢，其他 reply drop |
| ask_user offline | 立即返 `failureResult` |
| ask_user abort pre-start | ctx.signal 已 aborted 直接 failure |
| 消息 parse 错误 | malformed JSON → `dropConnection` |
| 消息 type 未知 | → `dropConnection` |

**缺口**：
- `broadcast_failed` / `handleClientMessage_failed` 的 console.error 路径无断言（需 audit 化后补）— ✅ **phase256 已清零**（N1/N2 drift 处置；`gateway_transport_error` 覆盖 onTransportError 路径；`gateway_connection_dropped` 覆盖 broadcast 失败）
- `gateway_connection_dropped` / `gateway_interrupt_*` audit 事件断言（phase157 补）— ✅ **phase256 已清零**（11 新 it；Step 3 覆盖 DROPPED / INTERRUPT_TRIGGERED / INTERRUPT_DEBOUNCED / TRANSPORT_ERROR / ASK_USER_* 5 事件路径）
- Assembly 装配后的 ask_user 工具注册（基础覆盖）— ✅ **phase261 清零**（createAskUserTool name/schema 断言 + execute 委托 2 it）；端到端 agent 调用链路（完整集成）— ⏸️ 留尾

**phase256 合入后**：23 → 31 `it`；console.error 0；Gateway §7.A A.2 + A.3 双清零。
