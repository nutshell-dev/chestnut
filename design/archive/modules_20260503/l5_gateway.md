# Gateway 模块内部契约

> 本文档限本模块**内部**应然 — 8 节结构 derive 自 Module Logic Principles：§1-§4 = M#1-#4 各占一节，§5 审计 = M#3 命名空间细则，§6 层级，§7 drift = M#10/#11，§8 测试。
> 跨模块对外承诺（接口签名、生产/消费方、归本模块加不归本模块、不可消除耦合理由）见 [interfaces/l5.md](../interfaces/l5.md) Gateway 节。
> 模块本质加层归属见 [architecture.md](../architecture.md)。

## 1. 职责（M#1 独立可变职责）

> 本节内容 derive 自 [architecture.md](../architecture.md) §27「Gateway 本质：外部客户端 ↔ 内部系统实时交互门面（数据面）/ L5 服务 ——『客户端交互桥接』/ 设计中先不实现」加 M#1 / M#2 / M#5。

### 做

应用 M#1（一个模块封装一组独立可变的职责），Gateway 的单一职责 = **外部客户端 ↔ 内部系统的实时交互门面**：

- **stream 订阅 + 推送**：streamFactory 注入 onEvent → transport.broadcast 收到 `{ type: 'stream', event }`
- **客户端信号路由**：interrupt 触发回 Daemon 反向控制流回调（port pattern / 与 LLMEventSink 同型）
- **ask_user 阻塞等待**：agent 发 ask_user 工具 → broadcast pending → 客户端 reply / timeout / abort 三路
- **连接生命周期**：onConnect 加入 connections Map / onDisconnect 移除 / dropConnection 主动清理（broadcast 失败 / malformed JSON / unknown type）
- **interrupt debounce**：窗口内重复 trigger drop（不 emit 不 drop 连接）
- **online / offline 一次性定型**：`isOnlineMode = (transport !== undefined)` 启动期定 / 运行期不变
- **数据面 vs 控制面分离**：CLI 唯一对外入口语境限定**控制面**（daemon 生命周期 start/stop/status/init）/ Gateway 承担**数据面**（运行中 agent ↔ 外部客户端实时交互）/ 两者并列不冲突

> 具体 API 形态归 [interfaces/l5.md](../interfaces/l5.md) Gateway 节。具体实现细节（GatewayInput 接口 + ClientMessage / ServerMessage discriminated union + ask_user 工具定义 + connections Map + pending Map + lastInterruptTs / started / isOnlineMode 等）的存在依据是「数据面交互门面」原语 — 实然采纳的细节差异（motion-only 装配 / inert 状态 / B.1-B.5 偏差）等登记 §7。

### 不做

- **不解析消息业务语义**（Transport 只传 opaque string / Gateway 只 JSON parse + discriminated union dispatch）— derive 自 M#1
- **不做连接鉴权 / 限流**（归 Transport 或未来安全层）— derive 自 M#5
- **不做客户端侧状态持久化**（pending / connections 全运行时派生态）— derive 自 M#3 + M#4
- **不定义 StreamEvent 格式**（归 Stream 模块）— derive 自 M#3
- **不直接构造 StreamReader**（通过 `streamFactory` 注入 / 不知 StreamReader 构造签名）— derive 自 M#5 + M#8
- **不维护 backpressure buffer**（Transport 层 best-effort / Gateway 不做高层重传）— derive 自 M#1
- **不预设 identity 独占**（按需装配 / 任何装 Transport 的 daemon 同时装 Gateway / 不绑死 motion）— derive 自 M#11

## 2. 业务语义（M#2 业务语义归属）

> 应用 M#2（模块为自己的业务语义负责），Gateway 的业务语义边界：

- **own**：「客户端交互」业务语义唯一发起点 — askUser / stream 订阅 / interrupt 路由 / 连接生命周期
- **角色定位**：Gateway 是「**数据面交互门面**」非「**Transport 实现**」非「**Stream 实现**」。Transport / Stream 注入 / Gateway 编排订阅与广播。
- **装配「按需」**：任何装 Transport 的 daemon 同时装 Gateway / 不预设 identity 独占（KD#26 motion 独占过时）
- **online / offline 一次性定型**：`isOnlineMode = (transport !== undefined)` 启动期定 / 运行期不变 / offline 下 ask_user 立即返 failureResult

## 3. 资源（M#3 资源唯一归属）

> 应用 M#3（每种资源只归属唯一模块），Gateway 独占的资源：

| 资源 | 类别 | 持久化 |
|---|---|---|
| `connections: Map<id, Connection>` | 派生态 | ✗ 重启从 Transport 新 onConnect 重建 |
| `pending: Map<id, AskUserEntry>` | 派生态 | ✗ 重启走 abort 收口 / DialogStore.repair 注入 synthetic tool_result |
| `lastInterruptTs` / `started` / `isOnlineMode` | 派生态 | ✗ 运行期派生 |
| `GATEWAY_INTERRUPT_DEBOUNCE_MS` / `GATEWAY_ASK_USER_TIMEOUT_MS` | 常量 | constants.ts 集中 |
| `ask_user` 工具定义 | 工具 | `ask-user-tool.ts` 硬编码 |

**无磁盘资源** — Gateway 是门面派生态。

## 4. 持久化（M#4）

> 应用 M#4（持久化一切信息到磁盘 / 运行时句柄从磁盘信息重建），Gateway 自身的持久化立场：

- **模块零状态**：Gateway 不持自有磁盘 artifact — 派生态全部为运行期内存。
- **持久化归下游**：

| 信息 | 归属 | 落盘 |
|---|---|---|
| 对话内容（askUser 问答对）| DialogStore（L2）| `current.json` / archive |
| 事件历史（ask_user / interrupt / 连接生命周期）| AuditLog（L2）| `audit.tsv` |
| connections / pending / lastInterruptTs / started | Gateway 派生态 | ✗ |

**重建语义**：connections 由新 onConnect 重建 / pending ask_user stop 时走 abort 收口 + audit 留痕 + DialogStore.repair 注入 synthetic tool_result / lastInterruptTs / started 重启归零。

## 5. 审计事件清单

> 事件常量集中定义于 `src/core/gateway/audit-events.ts` GATEWAY_AUDIT_EVENTS（模块自治 / caller 引用 const 不硬编码字符串）。

10 个 GATEWAY_* 事件：

| 事件 type | 触发时机 | 载荷 |
|---|---|---|
| `gateway_started` | `start()` 末尾 | `isOnline` |
| `gateway_stopped` | `stop()` 末尾 | — |
| `gateway_ask_user_pending` | askUser pending.set 之后 | `id` |
| `gateway_ask_user_resolved` | 客户端 reply 到达 | `id`, `by` |
| `gateway_ask_user_cancelled` | timeout / abort | `id`, `reason` |
| `gateway_ask_user_reply_dropped` | reply 的 id 不存在 | `id`, `connId` |
| `gateway_connection_dropped` | dropConnection（含 broadcast write failed）| `connId`, `reason` |
| `gateway_interrupt_triggered` | interrupt 通过 debounce | `connId` |
| `gateway_interrupt_debounced` | interrupt 命中 debounce | `connId` |
| `gateway_transport_error` | onTransportError handler | `kind`, `error` / `callbackName` |

## 6. 层级声明

L5 服务（与 Runtime / Cron 同层 / 「数据面交互门面」业务语义独立 / 与 CLI 控制面并列不冲突）。下游 Daemon（L6）通过 `createGateway` 工厂 + `interrupt` 回调注入消费 / 不直接 import L5+ 业务模块。详见 [architecture.md](../architecture.md) 加 [interfaces/l5.md](../interfaces/l5.md)。

## 7. 应然 vs 实然差距登记（M#10 / M#11）

> 原则：本节只登记**实然 ≠ 应然**的 gap（待治理或已治理的历史）+ 偏差 + 历史纪律。当前实然若与应然 align 则不在此登记。

### 7.A 必修违规（含历史已闭环）

| §A 条 | 类型 | 状态 | 触发情境 |
|---|---|---|---|
| ~~A.1 ask_user 工具未注册到 toolRegistry~~ | drift | **已闭环（phase261 / r19 D）** | `assemble.ts:402` `toolRegistry.register(createAskUserTool(gateway))` 在 `if (isMotion)` 块内 / 决策 #25 对齐（motion 启 / claw 不启）|
| ~~A.2 console.error 2 处兜底（broadcast / onMessage）~~ | drift | **已闭环（phase253 / main 85d1a60）** | broadcast 改 `{ failed }` 返回不 throw / dropConnection 主动清理 / onMessage try/catch 删除 / 错误走 Transport safeFire → onTransportError |
| ~~A.3 审计事件清单完全缺失~~ | drift | **已闭环（phase256 / main 326746e）** | `GatewayInput` +`audit: AuditWriter`（必传）/ 10 个 GATEWAY_* 事件全量实装 / N1 `gateway_broadcast_failed` 合并入 `gateway_connection_dropped` / N2 `gateway_client_message_failed` 重命名为 `gateway_transport_error` |
| **A.spec-1 应然 stub「设计中, 先不实现」 stale ↔ 实然部分实施** | spec drift / 中 | **closed**（phase414c L5 audit / interfaces/l5.md 升级 stub → 部分实施状态描述）| 应然原 interfaces/l5.md Gateway 节写「整体状态 = 设计中, 先不实现 / 接口签名待 phase 落地后稳定」/ 实然已落地 4 文件 (`src/core/gateway/gateway.ts` + `types.ts` + `ask-user-tool.ts` + `index.ts`) / `interface Gateway` + 5 method (start/stop/askUser/getActiveConnections/isOnline) + `GatewayInput` config + `createGateway` factory 全实装 / askUser 当前 Step 2 占位（抛 not-implemented）/ phase256 audit 全量实装 + phase261 motion-only 装配。phase414c interfaces/l5.md 修订升级 stub → align 实然部分实施状态 + 暴露 askUser 完整实施待后续 phase |

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| B.1 `getActiveConnections` / `isOnline` src 0 消费 | design-gap / 低 | 预留接口给未来 `clawforum status` / 监控面板查在线连接 / 升档：phase169+ Transport 接入后仍无消费方 → 升 §A 评估移除 |
| B.2 `ask_user` 工具与 Gateway 同模块（ask-user-tool.ts 26 行）| design-gap / 低 | 业务语义一致（用户实时交互）/ 单一工具不拆。升档：扩多种用户交互工具（confirm / choose）→ 评估拆 user-interaction-tools 子模块 |
| B.3 `askUserTimeoutMs` 仅测试覆盖（生产走默认 30 分钟）| drift / 低 | ⚓ accepted-stable（接口灵活点 / 不构成界面泄漏 / phase389 anchor 标记）|
| B.4 运行时 inert 状态 | design-gap / 中 | phase157 完成 motion offline 装配后 / src/ 中 0 处 `gateway.start()` 调用方 / 0 处 `instances.gateway` 消费 / Daemon 不读字段 / 内存占用可忽略。设计意图：phase169+ Transport 接入时改 `transport: undefined → <实例>` + `await instances.gateway?.start()` 即可激活 / Assembly 结构无需改动。升档：phase169+ 不接入 → 评估移除装配 |
| ~~B.5 `gateway_ask_user_reply_dropped` 未落地~~ | drift | **已闭环（phase256）** / drop 路径已 audit 覆盖 |

### 7.C 应然原则对照

> 仅列应然对各原则的承诺立场 / 不写「合规✓」claims。

**Module Logic Principles**

- M#1 独立可变职责：4 子能力（连接管理 / interrupt 路由 / stream 订阅 / ask_user）共享 connections / broadcast / Transport 单例 / 一组共享资源的子能力集合 / 不拆（反向测试）
- M#2 业务语义归属：「客户端交互」业务语义唯一发起点
- M#3 资源唯一归属：connections Map 归 Gateway 独占 / Transport 归 Transport / Stream 归 Stream
- M#4 持久化：纯运行时 / 重启从 Transport + Stream 自然重建 / 派生态丢弃容忍
- M#5 依赖单向：L5 → L1 (Transport) + L5 → L2 (Stream / Audit / Tools) + Daemon (L6) 通过 ctor 注入 `interrupt: () => void` callback function（函数类型注入 / 0 module dep / 非 port pattern）/ 不上引 L6+
- M#6 依赖结构稳定：isOnlineMode 启动期一次性定型
- M#7 耦合界面稳定：5 方法 + 4 消息 type 形态固定
- M#8 耦合界面最小：streamFactory 工厂注入而非直 import 构造器 / Connection id 对 Gateway opaque
- M#9 显式编译器可检：ClientMessage / ServerMessage discriminated union / switch 穷尽 tsc 可保证
- M#10 不合理停下：phase256 后 audit 全覆盖 / 信息无丢失
- M#11 边界对不上停下：当前 motion-only inert 状态 / 应然「按需」装配 / B.4 升档条件待 phase169+

**Design Principles**

- D1a 信息不丢失：phase256 10 audit 事件全量覆盖
- D1b 状态可观察：isOnline / getActiveConnections 可查（B.1 待消费方）
- D1c 中断可恢复：stop idempotent / offline no-op / 重启后连接重建（pending 丢失属预期）
- D1d 事后可审计：phase256 GATEWAY_* 全量覆盖
- D2 不丢弃 / 静默：A.2 phase253 + A.3 phase256 双清零 / drop 路径已 audit
- D3 用户可观察：**驱动原则**（Gateway 数据面核心 / phase261 ask_user 激活完整落地）
- D8 事件驱动：**驱动原则**（Transport onMessage / Stream onEvent / interrupt 触发信号 全事件驱动）
- D9 CLI 唯一对外：合规（控制面 CLI / 数据面 Gateway 并列不冲突）
- D10 多 claw 不隔绝：用户 ↔ motion ↔ claw 中介模式
- D11 motion 特殊：motion-only 装配 / claw 路径经 motion 中介

**Philosophy**

- P3 多 agent 利用：**约束原则**（phase261 motion-only / claw 不启交互归 motion 中介）
- P4 系统为智能体服务：**驱动原则**（ask_user 让 agent 询问用户 / phase261 已激活）

**Path Principles**

- Path #1 实然为唯一基准：phase200 Path #1 drift 核 5 点佐证 / 0 drift 发现 / r48 复核维持
- Path #3 语义最小变更单元：APPEND-only §7 不解构既有节
- 反向测试：本模块可独立替换 Transport / StreamReader 实现而不动 Daemon caller —— M#1 ✓

### 7.D 历史纪律

- 2026-04-22 / phase200 L5 Gateway backfill（§7 四子节 + §8 / 3 §7.A open + 5 §7.B / Path #1 0 drift）
- 2026-04-24 / phase253 §7.A A.2 联动清零（broadcast 改 `{ failed }` / onMessage 走 Transport safeFire）
- 2026-04-24 / phase256 §7.A A.3 全量 audit 集成（10 GATEWAY_* 事件 / N1 N2 drift 处置 / `GatewayInput` +audit 必传）
- 2026-04-24 / phase261 §7.A A.1 清零（assemble.ts:402 ask_user 注册 / motion-only 决策 #25 对齐）
- 2026-04-25 / phase279 §7.C cascade 补登记（D1a / D1d / D2 / D3 / D5 / D10 / P4 7 条前进）
- 2026-04-25 / phase317+320 契约 drift 修订（A.1/A.2/A.3 状态准化 / 描述行删除线补）
- 2026-04-26 / phase325 应然 framing drift 修订（KD#26 motion 独占过时 / 改「按需」装配）
- 2026-04-26 / phase338 H1 拆分 audit-events.ts 模块自治（GATEWAY_AUDIT_EVENTS 物理迁出全局 events.ts）
- 2026-04-27 / r43 A audit fork 验证 100% align / 0 drift（B.p344 合规反例第 3 个 / 与 messaging + dialog_store 同 reference 模板）
- r60+ 重编号：9 节 → 8 节 / 每节 derive 自一条 Module Logic Principle（删原 §2 接口 / §5 上游依赖 / §6 不可消除耦合 → 已并入 interfaces/l5.md / 拆原 §1 所有权 hub 为 §1 职责 + §2 业务语义 + §3 资源 + §4 持久化）

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| KD#12 | Gateway 桥接 Stream 与 Transport / 订阅 + 推送 + 信号路由 | ✓ |
| KD#14 | 中断信号走 Gateway → Daemon 回调 / 不走磁盘文件 | ✓ |
| ~~KD#26~~ | ~~motion 独占 Gateway / Transport / claw 无直连~~ | **过时**（2026-04-26 / Philosophy「按需」装配 / motion 仍是特殊 claw 但「单向访问权」是能力非排他）|
| ⚠ KD#26 V1 drift（保留治理）| 「motion 读 claw stream.jsonl」违反 D11 + M#3 + phase134 memory | 待治理（应改「motion 经 claw CLI 中介 / 不直读 fs」）|

## 8. 测试覆盖

应然行为（不绑定具体测试文件路径）：

- **生命周期**：start 重复抛错 / stop idempotent / offline 下 start/stop no-op
- **online / offline 定型**：`isOnline()` 三态（未启 / online / stopped）
- **stream 广播**：streamFactory 注入 onEvent → transport.broadcast 收到 `{ type: 'stream', event }`
- **连接生命周期**：onConnect 后 getActiveConnections 反映 / onDisconnect 后移除
- **interrupt 路由 + debounce**：首次 trigger 调回调 / 窗口内第二次丢弃 + audit
- **ask_user 三路径**：timeout / abort / 正常 reply
- **ask_user 多客户端**：多连接同时收 pending / 先到 reply 赢 / 其他 reply drop
- **ask_user offline**：立即返 failureResult
- **ask_user abort pre-start**：ctx.signal 已 aborted 直接 failure
- **消息 parse 错误**：malformed JSON → dropConnection + audit
- **消息 type 未知**：→ dropConnection + audit
- **审计回链**：每个 §5 GATEWAY_* 事件触发时机 + 载荷断言（10 events 全覆盖）
- **createAskUserTool**：name + schema 属性 + execute 委托 Gateway.askUser
