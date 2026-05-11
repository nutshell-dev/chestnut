# Gateway 模块内部契约

> 本文档限本模块**内部**应然 — 8 节结构 derive 自 Module Logic Principles：§1-§4 = M#1-#4 各占一节，§5 审计 = M#3 命名空间细则，§6 层级，§7 drift = M#10/#11，§8 测试。
> 跨模块对外承诺（接口签名、生产/消费方、归本模块加不归本模块、不可消除耦合理由）见 [interfaces/l5.md](../interfaces/l5.md) Gateway 节。
> 模块本质加层归属见 [architecture.md](../architecture.md)。

## 1. 职责（M#1 独立可变职责）

> 本节内容 derive 自 [architecture.md](../architecture.md) §27「Gateway 本质：外部客户端 ↔ 内部系统实时交互门面（数据面）/ L5 服务 ——『客户端交互桥接』/ 设计中先不实现」加 M#1 / M#2 / M#5。

### 做

应用 M#1（一个模块封装一组独立可变的职责），Gateway 的单一职责 = **外部客户端 ↔ 内部系统的实时交互门面**（顶层 4 项 align arch 表 2）：

- **stream 订阅 + 推送**：streamFactory 注入 onEvent → transport.broadcast `{ type: 'stream', event }`
- **客户端信号路由**：interrupt 触发回 Daemon 反向控制流回调（port pattern / 与 LLMEventSink 同型）
  - sub: interrupt debounce — 窗口内重复 trigger drop（不 emit 不 drop 连接）
- **ask_user 阻塞等待**：agent 发 ask_user 工具 → broadcast pending → 客户端 reply / timeout / abort 三路
- **连接生命周期 + 视图派生**：onConnect 加入 connections Map / onDisconnect 移除 / dropConnection 主动清理（broadcast 失败 / malformed JSON / unknown type）/ getActiveConnections 派生快照
  - sub: online / offline 一次性定型 — `isOnlineMode = (transport !== undefined)` 启动期定 / 运行期不变
  - sub: 数据面 vs 控制面分离 — CLI 唯一对外入口语境限定**控制面**（daemon 生命周期 start/stop/status/init）/ Gateway 承担**数据面**（运行中 agent ↔ 外部客户端实时交互）/ 两者并列不冲突

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

**无磁盘资源** — Gateway 是门面派生态。

> 注：常量（`GATEWAY_INTERRUPT_DEBOUNCE_MS` / `GATEWAY_ASK_USER_TIMEOUT_MS`）集中 `constants.ts` / `ask_user` 工具定义集中 `ask-user-tool.ts` — 实施细节归 §1.做 / 非 M#3 业务资源。

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
| ~~**B.6 streamReader 启动期跳过未结束 turn 的 events**~~（同 chat-viewport spinner bug 同型）| ~~drift / 中~~ | **✅ closed（phase 558 Step A+B / main `159ddffc`）**：(1) `findRecentTurnStartOffset` helper 提到 `foundation/stream/turn-start-offset.ts` 共用模块（chat-viewport-utils.ts 删 + chat-viewport.ts import 改源 + foundation/stream/index.ts 加 export）/ (2) GatewayInput +`getInitialOffset?: () => number` callback / assembly 闭包绑 fs / gateway.ts streamReader.start(initialOffset) / 同 chat-viewport phase 522 fix 模板 N+1 实证扩 gateway / 「helper 物理迁 + 接口 callback 注入」共用模式 | **2026-05-07 浮出 / chat-viewport spinner bug 修复后同型 sweep**：`gateway.ts:166` `streamReader.start()` 0 参 / fallback to file size tail 模式 / daemon 重启时上次未结束 turn 的 events 在 stream.jsonl / gateway 跳过 / web client 重连 / broadcast 空 / 客户端看不到 daemon 当前 turn 状态。**真合规修复**：(1) `findRecentTurnStartOffset` helper 提取到 `foundation/stream/` 模块（chat-viewport 已实施 in `chat-viewport-utils.ts`） / (2) `gateway.ts:166` 改 `streamReader.start(findRecentTurnStartOffset(systemFs, STREAM_FILE))` / 同型 fix 模板。**影响**：Medium（仅影响 web client 重连 UX / 不影响 daemon 行为）。同 chat-viewport main reader (line 373) bug / 已 fix（phase 后续 / SHA 待回填）|
| ~~**B.7 streamReader teardown 顺序 race window**~~ | ~~dominant γ + α 复合~~ | **✅ closed（phase 558 Step D / main `159ddffc`）**：α 落地 — reader.ts:224 unlink handler 加 `if (!active) return;` guard（与 line 140 readIncrement guard 一致 pattern）+ audit READER_UNLINKED 仍 fire（observability 优先 / audit 后 return）/ γ effectively safe by guard 验证 / β STREAM_READER_STOPPED audit 0 落地（YAGNI / 单独评估推 r+1+ if 真需）| **触发**：r67 ⚠️ unverified review。**Path #1 实测核**：(1) readIncrement (reader.ts:140) 已有 `if (!active) return` guard 防 ghost emit / (2) unlink handler (reader.ts:222-231) 0 active guard / 但 stop() (reader.ts:256-264) 已置 active=false / w.close() 期间 unlink 仅 mutate 死状态（offset=0 / pending=''）/ 0 broadcast 路径 / (3) chokidar v4+ close() Promise contract 承诺 resolve 即 flush 所有 pending callbacks。**候选**：(α) unlink handler 加 `!active` guard 1 行 hygiene — ML 8/11 align / DP 7/11 / 反向测试 align / 0 行为差 / 候选 micro-hygiene cluster N+1 实证；(β) stop() 加 STREAM_READER_STOPPED audit 事件 — 1 NEW const / D1d align / 7/11 ML / 7/11 DP；(γ) 不动 effectively closed — 0 src 改 / row ⚓ accepted-stable — ML 7/11 弱 / DP 6/11 / 实然 effectively safe；(δ) chokidar close 后 verify watcher.events.length===0 — 反 YAGNI / 排除（chokidar 文档承诺 close resolve 即 flush）。**dominant**：γ 主导（实然 effectively safe / 0 行为差）+ α hygiene 派生（unlink mutate 死状态非 D5 真违 / 但 1 行加 guard 0 ROI 损失）/ β 单独评估（new audit event 是否过度）。**拍板待**：(1) γ ⚓ stable + α 顺手清 r68+ micro-hygiene phase / (2) γ only / (3) γ + β 联合 hygiene phase。**升档条件**：chokidar 升级或重写 → 重核 close Promise contract / α 顺手清 → 闭环。**与 §B.6 区别**：§B.6 是 streamReader **启动期** tail mode 跳过未结束 turn events（chat-viewport spinner 同型）/ §B.7 是 **关闭期** teardown 顺序 race / 不同关键路径，独立 row 不复用 |

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

- P1 Agent 即目录：**中性**（数据面交互门面 / 不直接 own agent 目录抽象）
- P2 上下文工程：**中性**（不直接做上下文压缩 / 仅传递 stream events）
- P3 分多个智能体加分子任务：**约束原则**（phase261 motion-only / claw 不启交互归 motion 中介）
- P4 系统为智能体服务：**驱动原则**（ask_user 让 agent 询问用户 / phase261 已激活）

**Path Principles（7 条）**

- **Path #1 路径规划基于规划时刻的事实**：phase200 Path #1 drift 核 5 点佐证 / 0 drift 发现 / r48 复核维持（治理动作要 grep 实然代码佐证）
- **Path #2 实然和应然差距显式登记**：违规明文上墙（在路径规划时参考 / §7.A + §7.B）
- **Path #3 语义原子变更单元**：APPEND-only §7 不解构既有节 / 1 phase = 1 commit 原子
- **Path #4 可回滚 + 破坏性论证**：API 改动 caller 评估 / 破坏性改动显式论证（反向测试：本模块可独立替换 Transport / StreamReader 实现而不动 Daemon caller —— M#1 ✓）
- **Path #5 完成后复盘**：phase 收尾三维 + Path Principles 第 4 维对账
- **Path #6 冲突立即中断**：scope 模糊或决策点必停报告（冲突调整优先于强行推进）
- **Path #7 总难度路径**：实然到达应然有诸多路径 / 选择降低总难度的（步骤间有相互作用 / 总难度 ≠ 各步骤成本简单相加）

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
- 2026-05-04 / cross-doc audit drift 修订（§7.C Philosophy verbatim P3 + 加 P1/P2 立场 / §3 资源粒度 align arch 表 1 / §1.做 顶层条目 align arch 表 2 / interfaces 装配归属修「按需」实然 motion-only）
- 2026-05-05 / r65 cross-doc audit 单 doc 一致性核（modules/l5_gateway.md vs arch §27 + 表 1/2/3 + interfaces/l5.md Gateway 节）/ 0 derive drift / 主 derive 全 align（M#1-M#11 + Design Principle D1a/b/c/d + D2/D3/D8/D9/D10/D11 + Philosophy P1+P2+P3+P4）/ 4 主能力 align arch 表 2 自标 / 资源派生态 3 类 align arch 表 1 / ask_user 工具 align arch 表 3 / 2026-05-04 修订后稳态保留 / KD#26 V1 drift（motion 读 claw stream.jsonl）仍 open 治理候选推 r+1 / design only / 0 src 改
- 2026-05-09 / phase 558+559 gateway P1+P2 cluster 全闭（main `159ddffc`+`1bf85d81`）/ phase 558（4 step / P1）：Step A `findRecentTurnStartOffset` 提 `foundation/stream/turn-start-offset.ts` 共用 + Step B §B.6 streamReader initialOffset（GatewayInput +`getInitialOffset` callback / assembly 闭包绑 fs）+ Step C G2/G3/G4（start() try/catch + STARTUP_FAILED audit + askUser broadcast try + ASK_USER_BROADCAST_FAILED audit + signal addEventListener 后 robust check）+ Step D §B.7 α reader.ts unlink !active guard / phase 559（5 step / P2）：connect/disconnect audit + INTERRUPT_DEBOUNCED window sampling + STOP_NOOP audit + unknown msg type drop reason 加详情 + transport! destructure once / **chat-viewport spinner bug fix 模板 N+1 实证扩 gateway**（phase 522 → phase 558 / 跨模块同型）/ §B.6+§B.7 双 closed / **「helper 物理迁 + 接口 callback 注入」共用模式首发** / micro-hygiene cluster N+2 实证累（phase 504+520+523+524+526+527+528+529+530+531+532+541+544+547+549+553+557+558+559 = 19 实证 / 跨 chat-viewport+file-tool+tools+gateway+stream 5 模块）/ NEW audit consts: STARTUP_FAILED + ASK_USER_BROADCAST_FAILED + CONNECTION_ACCEPTED + CONNECTION_DISCONNECTED + STOP_NOOP（5 NEW const）
- 2026-05-08 / phase 554 G fork r67 design only / 起草新 §B row「B.7 streamReader teardown 顺序 race window」/ 0 src 改 / open 待用户拍板 / 候选 γ effectively closed by guard dominant + α 1 行 unlink handler hygiene 派生 / 与 §B.6 startup tail mode 不同 issue 独立 row / dispatch 5 项 stale ratio 40%（r66+r67 累 N+1 实证）/ phase 545 G fork r66 design only 单 Step 模板第 N 实证累

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
