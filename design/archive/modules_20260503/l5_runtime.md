# Runtime 模块内部契约

> 本文档限本模块**内部**应然 — 8 节结构 derive 自 Module Logic Principles：§1-§4 = M#1-#4 各占一节，§5 审计 = M#3 命名空间细则，§6 层级，§7 drift = M#10/#11，§8 测试。
> 跨模块对外承诺（接口签名、生产/消费方、归本模块加不归本模块、不可消除耦合理由）见 [interfaces/l5.md](../interfaces/l5.md) Runtime 节。
> 模块本质加层归属见 [architecture.md](../architecture.md)。

## 1. 职责（M#1 独立可变职责）

> 本节内容 derive 自 [architecture.md](../architecture.md) §25「Runtime 本质：常驻 agent 的事件驱动循环服务 / L5 服务 ——『事件驱动循环』」加 M#1 / M#2 / M#5 加 Design Principle「运行中断即从最后一次完整 LLM 调用恢复状态并继续」。

### 做

应用 M#1（一个模块封装一组独立可变的职责），Runtime 的单一职责 = **常驻 agent 事件驱动循环**：

- **事件驱动循环入口**：`processBatch` / `processWithMessage` / `retryLastTurn` / `chat` 四入口承接「等事件 → 启动一轮 AgentExecutor 执行 → 执行完成回到等待」语义
- **生命周期协调**：initialize（dialog 加载 / tool 注册 / DispatchTool 闭包绑 / TaskSystem.startDispatch）+ stop（TaskSystem.shutdown）+ resumeContractIfPaused（启动期挂起契约恢复）
- **turn 边界 audit**：每轮 turn 写一对 `turn_start → (turn_end | turn_interrupted | turn_error)` audit 加 turnCount++
- **三种中断响应**：`IdleTimeoutSignal` / `PriorityInboxInterrupt` / `UserInterrupt` 经 AbortController + `_handleTurnInterrupt` 路由 turn_interrupted audit
- **轮级 snapshot commit**：每 turn 结束 `snapshot.commit(context='turn-N')` 让中断可恢复
- **dialog 落盘协调**：每次 LLM 调用后必通过 DialogStore 落盘 messages 数组（透过 stepCallback hook 调 DialogStore）/ 这是 Design Principle「运行中断即从最后一次完整 LLM 调用恢复状态并继续」的实现机制
- **callbacks 透传 observability**：StreamCallbacks / DaemonStreamCallbacks 协议本模块定义 / caller 提供实现（StreamCallbacks 13 + DaemonStreamCallbacks 扩 onInboxMessages = 14 callbacks 总 / onBeforeLLMCall / onTextDelta / onToolCall / onTurnInterrupted / onProviderInfo 等）
- **identity 透明**：Runtime 内部无身份分支 / motion 与 claw 差异由 Assembly 注入 systemPromptBuilder + identityToolFilter 2 optional params

> 具体 API 形态归 [interfaces/l5.md](../interfaces/l5.md) Runtime 节。具体实现细节（_runReact / _drainOwnInbox / _handleTurnInterrupt / repairDialogIfNeeded / DispatchTool 注册闭包 / 15+2 RuntimeDependencies 字段 / ContextInjector 内部组件等）的存在依据是「常驻 agent 事件驱动循环」原语 — 实然采纳的细节差异加 DispatchTool 注册闭包结构性循环依赖等登记 §7。

### 不做

- **不做模块装配**（L1-L4 instances 构造），归 L6 Assembly — derive 自 M#1 独立可变职责
- **不维护 motion / claw 身份分支**（Assembly 注入 systemPromptBuilder + identityToolFilter / Runtime 内部无 if isMotion 分支）— derive 自 M#2 + Design Principle D10
- **不做单步执行算法**（一次 LLM 调用加 tool 派发），归 L3 StepExecutor — derive 自 M#1
- **不做 agent 完整循环算法**（多步调度加停止判定），归 L3 AgentExecutor（Runtime 是 caller / 写 stepCallback）— derive 自 M#1
- **不做异步任务调度**，归 L4 TaskSystem — derive 自 M#1 + M#5
- **不做契约状态机**（生命周期管理加验收加重试），归 L4 ContractSystem — derive 自 M#1
- **不做单步 LLM 调用容错**（重试加 failover 加协议错误识别），归 L2 LLMOrchestrator — derive 自 M#5
- **不做工具实现加权限校验**，归 L2 Tools — derive 自 M#5
- **不直接磁盘 I/O**（dialog / audit / snapshot / inbox / outbox / fs 全经 L1/L2 注入接口）— derive 自 M#3 + M#5

## 2. 业务语义（M#2 业务语义归属）

> 应用 M#2（模块为自己的业务语义负责），Runtime 的业务语义边界：

- **own**：「常驻 agent 事件驱动循环」业务语义唯一发起点 — turn 边界加中断响应加轮级 commit 加 dialog 落盘协调加 TaskSystem 生命周期协调。这些是 Runtime 唯一懂的「业务」（long-running service 级）。
- **角色定位**：Runtime 是「**事件驱动 long-running service**」非「**装配器**」非「**循环算法器**」。Assembly 给注入 instances + identity / Runtime 跑循环 + 协调生命周期。
- **identity 透明**：Runtime 不分 motion / claw 身份 / 同一代码基复用（Philosophy「motion 加 claw 是 agent 的两种 identity」derive）。Assembly 装配期注入 identity 差异（systemPromptBuilder + identityToolFilter）。

## 3. 资源（M#3 资源唯一归属）

> 应用 M#3（每种资源只归属唯一模块），Runtime 独占的资源：

| 资源 | 类别 | 持久化 |
|---|---|---|
| `currentAbortController` / `turnCount` | 派生态 | ✗ |
| 15+2 字段 RuntimeDependencies 引用（15 必传 + 2 可选 parentStreamLog? + contractNotifyCallback?）| 注入 / 运行期不变 | ✗ |
| 内部组件 ContextInjector / DispatchTool 注册闭包 | 派生态 | ✗ |
| `MOTION_CLAW_ID` / `DEFAULT_MAX_STEPS` 等常量 | 跨模块共享 / `src/constants.ts` | — |

**无磁盘资源** — Runtime 仅持运行期内存句柄。dialog / audit / snapshot / inbox / outbox 全归 L2 各模块。

## 4. 持久化（M#4）

> 应用 M#4（持久化一切信息到磁盘 / 运行时句柄从磁盘信息重建），Runtime 自身的持久化立场：

- **模块零状态**：Runtime 不持自有磁盘 artifact — 运行期内存句柄全部为派生态。
- **持久化归下游**：

| 信息 | 归属 | 落盘 |
|---|---|---|
| dialog 状态 | DialogStore（L2）| `current.json` / archive |
| audit 事件 | AuditWriter（L2）| `audit.tsv` |
| snapshot | Snapshot（L2）| git repo |
| inbox / outbox | Messaging（L2）| 各 claw inbox/outbox 目录 |

**重建语义**：initialize() 经 dialogStore.load() 加载上一 dialog（dialog 文件 / snapshot 回放 / fresh）/ repairDialogIfNeeded() 工具配置重建 / Runtime 不直接触碰磁盘。AbortController / turnCount 重启归零（运行期派生态丢弃容忍）。

## 5. 审计事件清单

> 事件常量集中定义于 `src/core/runtime/runtime-audit-events.ts` `RUNTIME_AUDIT_EVENTS` + `heartbeat-audit-events.ts` `HEARTBEAT_AUDIT_EVENTS`（模块自治）。

20 RUNTIME_* + 1 sub（13a `llm_unparseable_tool_use`）+ 1 HEARTBEAT_* = 22 events 总：

| # | 事件 type | 触发时机 | 载荷 |
|---|---|---|---|
| 1 | `assemble_failed` | initialize 内 inbox_reader 失败 / repairDialogIfNeeded 保存失败 | `module=<name>` `phase=<init\|dialog_repair_save>` `reason` |
| 2 | `task_system_init_failed` | `taskSystem.initialize()` 抛出 | `reason` |
| 3 | `task_system_start_dispatch_failed` | `taskSystem.startDispatch()` 抛出 | `reason` |
| 4 | `dialog_loaded` | 加载完成 | `source=<dialog\|snapshot\|fresh>` |
| 5 | `dialog_repaired` | 工具配置重建成功 | `tools=<count>` |
| 6 | `snapshot_commit_failed` | snapshot commit 抛出 | `context=<dialog-repair\|turn-N>` `reason` |
| 7 | `snapshot_commit_uncategorized` | snapshot commit 返未分类错 | `context` `exitCode` |
| 8 | `turn_start` | 三入口轮起 | — |
| 9 | `turn_end` | 三入口轮正常结束 | — |
| 10 | `turn_interrupted` | `_handleTurnInterrupt` | `cause=<idle_timeout\|priority_inbox\|user_interrupt>` `[ms]` |
| 11 | `turn_error` | `_handleTurnInterrupt` 兜底 | `err` |
| 12 | `llm_call` | LLMOrchestrator 成功回调 | `<model>` `in=<tokens>` `out=<tokens>` `ms` |
| 13 | `llm_error` | LLMOrchestrator 失败回调 | `<model>` `err` `ms` |
| 13a | `llm_unparseable_tool_use` | LLM 返 tool_use stop_reason 但 0 parseable tool calls | `stop_reason=` |
| 14 | `inbox_meta_failed` | `_hasHighPriorityInbox` meta 读失败 | `file` `kind=<err-kind>` |
| 15 | `dialog_archive_failed` | initialize 步 3 dialogStore.archive 非 ENOENT 失败 | `reason` |
| 16 | `inbox_handler_failed` | processBatch 内 callbacks.onInboxMessages 抛错 | `handler=onInboxMessages` `reason` |
| 17 | `outbox_write_failed` | processBatch catch 内 outbox 写 error response 失败 | `context=error_response` `scenario=<max_steps_exhausted\|non_interrupt_error>` `reason` |
| 18 | `runtime_process_batch_failed` | processBatch catch 最外层 turn 执行抛错 | `context=Runtime.processBatch` `error` |
| 19 | `llm_empty_response` | LLM 返空 content（StepExecutor onEmptyResponse 回调）| `provider` `model` |
| 20 | `llm_unknown_stop_reason` | unknown stop_reason（StepExecutor onUnknownStopReason 回调）| `stopReason` |
| H1 | `heartbeat_fire_failed` | Heartbeat tick 触发失败 | `reason` |

每任务独立子 audit 由 TaskSystem 写 / 本模块仅写 turn 级 + 生命周期事件。

## 6. 层级声明

L5 服务（与 Cron / Gateway 同层 / 「常驻 agent 事件循环驱动」业务语义独立可变）。下游 Daemon（L6）通过 `createRuntime` 工厂消费 + 装配 deps + 持有生命周期协调权。详见 [architecture.md](../architecture.md) 加 [interfaces/l5.md](../interfaces/l5.md)。

## 7. 应然 vs 实然差距登记（M#10 / M#11）

> 原则：本节只登记**实然 ≠ 应然**的 gap（待治理或已治理的历史）+ 偏差 + 历史纪律。当前实然若与应然 align 则不在此登记。

### 7.A 必修违规（含历史已闭环）

**§7.A phase178 全部清零里程碑**（细化期 A 类清零第 3 phase / `f309c23`）：

| §A 条 | 类型 | 状态 | 触发情境 |
|---|---|---|---|
| ~~A.1 启动归档失败软吞~~ | drift | **已闭环（phase178）** | runtime.ts:211 console.warn → audit `dialog_archive_failed` + 双写 |
| ~~A.2 onInboxMessages handler 失败软吞~~ | drift | **已闭环（phase178）** | runtime.ts:564 console.warn → audit `inbox_handler_failed` + 双写 |
| ~~A.3 错误响应 outbox 写失败软吞 (MaxStepsExceededError)~~ | drift | **已闭环（phase178）** | runtime.ts:609 console.error → audit `outbox_write_failed` `scenario=max_steps_exhausted` |
| ~~A.4 错误响应 outbox 写失败软吞 (非 signal / 非 MaxSteps)~~ | drift | **已闭环（phase178）** | runtime.ts:623 同型 / 复用 `_writeErrorResponse` private helper（A 类清零首次引入 helper 抽取）|
| ~~A.5 dead imports（4 个 Tool 实例）~~ | drift | **已闭环（phase288 / SHA `4616d15`）** | runtime.ts:31-36 `readTool / lsTool / searchTool / execTool` 4 行 dead imports 删除 |
| ~~A.r43-1 DispatchTool describing 模式消息结构错误~~ | drift / 高优 | **已闭环（phase351 / SHA `e8b9590`）** | dispatch.ts:197-204 单点查 last block → 倒序遍历找 first dispatch tool_use + break / multi tool_use blocks 时 dispatchToolUseId 正确捕获 / mining 模式 0 改 / +3 case |
| ~~A.naming-1 code class 名 `ClawRuntime` ↔ 应然 `Runtime`~~ | naming drift / 大 | **✅ closed（phase418 / SHA `76af56d7`）** | phase418 实施：1 source + 12 caller + 2 design 同 commit / shim 三阶段 / 0 行为改 / 1370+ 测试 PASS。实然已 align：(1) `Runtime` class 名 (src/core/runtime/runtime.ts:133) (2) `RuntimeOptions` (3) `createRuntime` factory ✓ aligned / `@module L5.Runtime` 注解 align ✓。**第 7 例 ShellTool-style naming drift 实证闭环**（CommandTool→ShellTool / Audit→AuditLog / FileWatcher@L2 / DialogStore→SessionManager / SkillSystem→SkillRegistry / ContractSystem→ContractManager / Runtime→ClawRuntime→Runtime）/ 命名权威源自审纪律 7+ 实证累积 / r+1 Meta 33 必硬化 feedback。 |
| **A.spec-1 13 port types 应然 silent ↔ 实然 RuntimeDependencies 全 port 化** | spec drift / 大 ⚠ STALE | **closed**（phase414c L5 audit / interfaces/l5.md align 实然 13 port types + STALE 推翻标记）| 历史 interfaces 写应然 RuntimeDependencies 用 concrete types (DialogStore / InboxReader / AuditWriter 等) / 实然 phase335 H7+H8 Runtime 注入化将所有依赖 port 化（13 port types in runtime-ports.ts: AuditPort / SnapshotPort / SessionStorePort / InboxPort / OutboxPort / ToolRegistryPort / ToolExecutorPort / ContextInjectorPort / ExecContextPort / ContractManagerPort / TaskLifecyclePort / SkillRegistryPort）/ phase414c interfaces/l5.md 修订 align 实然 + 13 port types 显式登记 / **⚠ port pattern 应然推翻 candidate** (详 `feedback_governance_workaround_smell` 5 实证 STALE) / 推 r+1 反向 design phase 评估 13 port 是否真 design debt（消费方 own port 反原则 / Runtime 应直 dep concrete L2/L4 模块）|

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| ~~DispatchTool 注册闭包依赖~~ | ~~drift / 低~~ | **✅ closed（phase385 / 应然 sharpen + l6_assembly §8.B 同步登记）** | runtime.ts:242-254 注释已标「候选 γ：结构性循环依赖妥协 / 登记为 B 类偏差：design/modules/l6_assembly.md §7」/ 应然方向：Runtime initialize 期 DispatchTool 闭包绑（this.buildSystemPrompt / this.toolRegistry.formatForLLM）= **结构性循环依赖妥协**（Assembly 构造期 Runtime 尚未 new / register 必须留 Runtime 内）/ phase385 同步 l6_assembly §8.B 加 DispatchTool 闭包注册结构性循环依赖 登记 / 应然层显式 acknowledge / 与代码注释 align |
| ~~MotionRuntime extends ClawRuntime 继承链~~ | drift | **已闭环（phase266）** | 路径 α 实施 / ClawRuntime +2 optional params (systemPromptBuilder + identityToolFilter) / `src/core/motion/` 删除 / motion.test.ts 重构 |
| ~~`_drainOwnInbox` 直读 fs~~ | drift | **已闭环（phase182 实然已消除）** | `inboxReader.drainInbox()` 已合规 / 契约文本 phase182 同步 |
| ~~`_hasHighPriorityInbox` 同型绕过（非消费型）~~ | ~~drift~~ | **✅ closed phase410**（main `129e8505`）| 治理 = InboxReader 扩 `peekMetas(filter?: { priority? }): Promise<InboxMessageMeta[]>` 非消费型 API（不删 / 不移）+ Runtime `_hasHighPriorityInbox` 简化为 `await this.inboxReader.peekMetas({ priority: ['high', 'critical'] }).then(arr => arr.length > 0)`（删内部 fs.readdir + InboxWriter.readMeta 双依赖 + 删 fs import）/ M#5 align（Runtime 经 InboxReader 受信路径 / 不绕 L2）/ M#8 align（单一 InboxReader.peekMetas 依赖）/ ~~port pattern 第 N+1 次复用~~ ⚠ STALE：peekMetas 是 method addition 不是 port pattern / 标错 / 详 feedback_governance_workaround_smell |
| ~~装配期 setter 双阶段注入~~ | drift | **已闭环（phase182 / `6d0bdfc`）** | `RuntimeDependencies` 加 parentStreamLog? + contractNotifyCallback? optional 字段 / Assembly 重排前置构造 / Runtime 公共接口 -2 setter |
| ~~audit 事件回链测试间接化 / 缺失~~ | ~~observability-debt / 低~~ | **✅ closed（phase405 / main `34f7027c`）** | tests/core/runtime.test.ts 扩 7 事件 auditSpy 直接断言（_handleTurnInterrupt 4 sub-it + turn_start/end + llm_call/error + inbox_meta_failed 零覆盖补）/ callback 间接断言全保留（双断言并存）/ 0 src 改（附 paths.ts 循环依赖 unblock fix）/ 测试黑盒契约模板延伸（phase392 反向 / callback + audit 双断言）/ auditSpy 基础设施复用（17 use site 模板成熟）|
| ~~Runtime 直接 import L3 工具 builtins~~ | drift | **部分闭环（phase288 dead 删除）** | runtime.ts:31-36 dead 4 imports 清零 / `registerBuiltinTools / DispatchTool` 仍直 import 待 phase347 后 / 改走 `core/tools/index.ts` 聚合出口（独立评估）|
| **`RUNTIME_AUDIT_EVENTS.SNAPSHOT_COMMIT_FAILED` caller 视角本地 alias**（字符串值 'snapshot_commit_failed' 与 `l2_snapshot` `SNAPSHOT_AUDIT_EVENTS.COMMIT_FAILED` 共享）| 跨 vantage point 同事件 / runtime.ts:283 + 544 `.commit().catch()` 承接 snapshot.ts:147 重抛的未分类 git 失败 + programmer-throw / payload `context=` `reason=` 反映 caller 视角 | ⚓ accepted-stable（phase391 / β-final / 详 `coding plan/phase391/`）| 参 `l2_snapshot` 同根 row 升档条件 |

### 7.C 应然原则对照

> 仅列应然对各原则的承诺立场 / 不写「合规✓」claims。

**Module Logic Principles**

- M#1 独立可变职责：常驻 agent 事件循环 + dialog 生命周期 + turn audit + 中断响应 + snapshot 轮级 commit / 变更源与 L1-L4 模块不同
- M#2 业务语义归属：四入口（processBatch / processWithMessage / retryLastTurn / chat）由本模块发起 / 装配 / LLM 原子 / 队列 / 契约状态机归他模块
- M#3 资源唯一归属：无磁盘资源 / dialog / audit / snapshot / inbox / outbox 各归其主
- M#4 持久化：运行时句柄全部内存 / dialog 经 dialogStore 从磁盘恢复
- M#5 依赖单向：RuntimeDependencies 15+2 字段单向 / StreamCallbacks 形态 B 合规 / 无循环
- M#6 依赖结构稳定：RuntimeDependencies 自 phase155B 冻结 / 字段 readonly / 运行期不变
- M#7 耦合界面稳定：createRuntime 工厂 + Runtime 公共方法稳定 / phase266 消灭 MotionRuntime subclass 不破接口
- M#8 耦合界面最小：phase182 公共方法 13 → 11（-2 setter）/ 仍 > 8 阈值（灰度 / 按职责聚合 5 组 / 等方法粒度 refactor 独立 phase）
- M#9 显式编译器可检：所有 interface / 工厂签名 tsc 强类型
- M#10 不合理停下：phase178 4 软吞清零 / phase351 dispatch describing bug 闭环
- M#11 边界对不上停下：DispatchTool 注册闭包依赖 显式登记 / ~~`_hasHighPriorityInbox` 同型绕过~~ phase410 闭环（InboxReader.peekMetas + Runtime 改调）

**Design Principles**

- D1a 信息不丢失：phase178 全闭环 / 19+1 events 全链路
- D1b 状态可观察：stream callbacks 透传 + audit 事件全链路
- D1c 中断可恢复：repairDialogIfNeeded + 三种中断都有 audit
- D1d 事后可审计：phase178 + phase351 + phase405 三闭环 / 19+1 events 全覆盖
- D2 不丢弃 / 静默：phase178 §7.A 4 条全闭环 / `f309c23` audit + console 双写
- D3 用户可观察：同 D1b
- D4 LLM 调用恢复：_runReact 后由 processBatch / retryLastTurn 驱动恢复 / 每次 LLM 调用后 dialog 落盘
- D5 日志重建：19+1 events + dialog 文件足以重建任一时刻
- D6 子代理后不阻塞：经 TaskSystem（phase163 文件驱动消除循环耦合）
- D7 系统可信路径：L1-L4 受信注入 / tools 经 ToolExecutor 受约束路径
- D8 事件驱动：processBatch 的 inbox 排空 → turn 循环即事件驱动
- D9 CLI 唯一对外：N/A（Runtime 内部服务 / 由 Daemon 装配 / 不直接对外）
- D10 多 claw 不隔绝：经 Messaging inbox/outbox 跨 claw 通信
- D11 motion 特殊：systemPromptBuilder + identityToolFilter 注入 motion 身份差异

**Philosophy**

- P1 Agent 即目录：消费 clawDir + systemFs / clawFs / agent 状态映射目录
- P2 上下文工程：contextInjector + buildSystemPrompt + stream callbacks 全链路是上下文流转
- P3 多 agent 利用：TaskSystem 驱动 subagent 并行 / Runtime 按 identity 复用同一代码基
- P4 系统为智能体服务：提供决策所需信息 + 基础设施（dialog / tools / stream / audit）

**Path Principles**

- Path #1 实然为唯一基准：phase178/182/247/266/278/288/295/351 各 phase 起步 Path #1 核 / `_drainOwnInbox` 直读 fs 契约文本落后实然首次发现
- Path #3 语义最小变更单元：phase266 motion subclass 消灭单 commit / 无 caller 改
- Path #6 冲突立即中断：纪律.1 总览 vs 规范节号错位 → 停 → 用户确认
- Path #8 总难度最低：phase335 13 port 一次注入 vs 散点改 / 总难度最低 ⚠ STALE 2026-05-03 推翻：13 port 是 over-engineering / Runtime → Tools L5→L2 顺向直 dep 完全合 M#5 / 详 feedback_governance_workaround_smell
- 反向测试：本模块可独立替换 DialogStore / Snapshot / TaskSystem 实现而不动 Daemon caller —— M#1 ✓

### 7.D 历史纪律

- 2026-04-21 / phase173 模块层级重划 KD#5 划线 / Runtime drift 重申（MotionRuntime subclass 违 KD#24）
- 2026-04-21 / phase178 §7.A 4 条全清零（细化期 A 类清零第 3 phase / `_writeErrorResponse` helper 抽取首次）
- 2026-04-21 / phase182 `_drainOwnInbox` 实然消除 + 装配期 setter 升档清零（公共接口 -2）
- 2026-04-22 / phase228 PID 公共 API（间接 / 影响 ProcessManager 但 Runtime 维持稳定）
- 2026-04-24 / phase247 monitor.log → audit `RUNTIME_PROCESS_BATCH_FAILED` 迁移
- 2026-04-24 / phase266 MotionRuntime extends ClawRuntime 路径 α 清零（subclass 消灭 / +2 optional params）
- 2026-04-24 / phase278 Runtime 直 import L3 builtins dead imports 升档判定（4 dead imports）
- 2026-04-25 / phase288 Runtime 直 import L3 builtins dead imports 清零（`4616d15`）
- 2026-04-25 / phase295 C.1 Runtime 目录收拢（`86683e4` / 4 files git mv → `src/core/runtime/`）
- 2026-04-25 / phase297 monitor 字段链路全删（B.2 sub-phase Phase 2）
- 2026-04-26 / phase324 应然 framing drift 修订（§4 依赖表 ToolRegistry/Executor L3 → L2）
- 2026-04-27 / phase335 13 port 注入化（H7+H8）+ DispatchTool 物理迁 ⚠ STALE 2026-05-03 推翻：13 port over-engineering / 详 feedback_governance_workaround_smell
- 2026-04-27 / phase336+phase338 H1 audit-events.ts 模块自治拆分（RUNTIME_AUDIT_EVENTS + HEARTBEAT_AUDIT_EVENTS 物理迁）
- 2026-04-27 / phase347 KD#29 dispatch 物理迁 → `src/core/task/tools/dispatch.ts`
- 2026-04-27 / phase351 A.r43-1 DispatchTool describing 模式 multi tool_use 防御性遍历闭环
- 2026-05-01 / phase396 RUNTIME_AUDIT_EVENTS +1 `LLM_UNPARSEABLE_TOOL_USE`（step-executor 8 console 协调 β 路径落地 / runtime.ts:537 wiring 仅主路径 _runReact / chat path 不扩散 / main `3eeffad7`）
- 2026-05-01 / phase405 audit 事件回链测试 7 事件 auditSpy 直接断言补（main `34f7027c`）
- 2026-05-03 / phase410 §7.B `_hasHighPriorityInbox` 同型绕过 InboxReader 闭环（main `129e8505`）/ InboxReader 扩 peekMetas 非消费型 API + Runtime 改调（删 fs.readdir + InboxWriter.readMeta 双依赖）/ ~~port pattern 第 N+1 次复用~~ ⚠ STALE：peekMetas 是 method addition 不是 port pattern / 标错 / 同 phase 与 l6_assembly LockConflictError 归 PM 治理（C 类小颗粒批量 / 模块边界重构阶段第 2 phase）
- r60+ 重编号：9 节 → 8 节 / 每节 derive 自一条 Module Logic Principle（删原 §2 接口 / §5 上游依赖 / §6 不可消除耦合 → 已并入 interfaces/l5.md / 拆原 §1 所有权 hub 为 §1 职责 + §2 业务语义 + §3 资源 + §4 持久化 / 删原 §10 已知问题补充 → dispatch describing 根因链已经 phase351 闭环）

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| KD#16 | 事件驱动循环归 Runtime / Daemon 调 Assembly.assemble + Runtime.start | ✓ |
| KD#24 | identity 差异由 Assembly 按配置注入 / Runtime 内部无身份分支 | ✓（phase266 闭环 / +2 optional params 注入）|
| KD#25 | Runtime 不自建 L1-L2 实例 / 经 RuntimeDependencies 注入 | ✓ |
| KD#29 | spawn / dispatch / ask_motion 工具归 TaskSystem(L4)| ✓（phase347 dispatch 物理迁）|

## 8. 测试覆盖

应然行为（不绑定具体测试文件路径）：

- **lifecycle**：initialize 成功路径（dialog_loaded audit + tool 注册 + taskSystem.startDispatch 调用）+ 失败路径（task_system_init_failed / task_system_start_dispatch_failed / assemble_failed 各异常）
- **stop / resumeContractIfPaused**：taskSystem.shutdown 清理 / 挂起契约恢复
- **事件循环入口**：processBatch 无 inbox 返 0（空 fast path）/ 有 inbox 触发 _drainOwnInbox + _runReact + turn audit pair / processBatch 触发 onInboxMessages 回调 / processWithMessage 合成消息单轮 / retryLastTurn 重试 / chat REPL 路径
- **中断三路**：abort → UserInterrupt → onTurnInterrupted('user_interrupt')；idleTimeout → IdleTimeoutSignal → onTurnInterrupted('idle_timeout', ms)；高优先级 inbox → PriorityInboxInterrupt → onTurnInterrupted('priority_inbox')
- **观察 / 装配回填**：getTaskSystem / getAuditWriter / getStatus 返内部引用 / phase182 后 setContractNotifyCallback / setParentStreamLog 已删（构造期注入）
- **motion identity 配置**（phase266）：identityToolFilter → toolRegistry.unregister('send')；systemPromptBuilder = buildMotionSystemPrompt 注入序（AGENTS → USER → IDENTITY → SOUL → MEMORY → skills → contract → AUTH_POLICY）
- **审计回链**（phase178 后双写 / phase405 测试断言强化）：19 + 1（heartbeat）events 全覆盖（phase396 +1 `llm_unparseable_tool_use`）/ phase405 后 7 事件（turn_* + llm_call/error + inbox_meta_failed）补 auditSpy 直接断言 / callback 间接断言全保留双断言并存
- **DispatchTool describing 模式**（phase351）：multi tool_use blocks 倒序遍历 / dispatchToolUseId 正确捕获 / mining 模式与 last block = dispatch 时行为 0 改
