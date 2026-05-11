# Runtime 模块内部契约

> 本文档限本模块**内部**应然 — 8 节结构 derive 自 Module Logic Principles：§1-§4 = M#1-#4 各占一节，§5 审计 = M#3 命名空间细则，§6 层级，§7 drift = M#10/#11，§8 测试。
> 跨模块对外承诺（接口签名、生产/消费方、归本模块加不归本模块、不可消除耦合理由）见 [interfaces/l5.md](../interfaces/l5.md) Runtime 节。
> 模块本质加层归属见 [architecture.md](../architecture.md)。

## 1. 职责（M#1 独立可变职责）

> 本节内容 derive 自 [architecture.md](../architecture.md) §25「Runtime 本质：常驻 agent 的事件驱动循环服务 / L5 服务 ——『事件驱动循环』」加 M#1 / M#2 / M#5 加 Design Principle「运行中断即从最后一次完整 LLM 调用恢复状态并继续」。

### 做

应用 M#1（一个模块封装一组独立可变的职责），Runtime 的单一职责 = **常驻 agent 事件驱动循环**：

- **事件驱动循环入口**：`processBatch` / `processWithMessage` / `retryLastTurn` / `chat` 四入口承接「等事件 → 启动一轮 AgentExecutor 执行 → 执行完成回到等待」语义
- **生命周期协调**：initialize（startup archive 上次 session / dialog 加载 / tool 注册 / DispatchTool 闭包绑 / AsyncTaskSystem.startDispatch）+ stop（AsyncTaskSystem.shutdown）+ resumeContractIfPaused（启动期挂起契约恢复）
- **session lifecycle 协调**（应然 γ 决策 / 2026-05-07 closed l2b §G3+§G4 + L5.G1-G4 closed / 2026-05-08 phase 539 sharpen identity-only diff + soft degrade）：startup archive rotation（实然 1 处触发 / `dialogStore.archive()` 每 startup 归档上次 session）+ regime 切换协调（**每 turn 末**自动检测 **identity 段**（agents + skills）变化 → archive + dialogStoreFactory 装配 new instance + per strategy 继承 messages + DialogStore.repair 修 tool_use 悬空 / 见下行）/ DialogStore 装配由 Assembly 完成（dialogStoreFactory callback 注入）/ Runtime 不 own 装配 const / rotation 触发策略业务复杂度不足以独立策略层（per M#1 反向测试 / 同根 phase 458 STALE 推翻判据）

**立场（phase 539 sharpen / identity 层 vs 动态层）**：system prompt 分两层：
- **identity 层**：agents（AGENTS.md）+ skills 元数据（智能体是谁 + 能做什么）
- **动态层**：memory（MEMORY.md）+ active contract（智能体在同一 regime 内自然演进的内容 / 子任务进度 / 学到了什么）

regime switch 仅由 identity 段改触发（identityHash 变 = 真 regime change）；动态层任改不触发（同 regime 内 turn 间自更新）。派生 = Philosophy「Agent 即目录」（agent 身份 ≡ 目录配置 / 跨多 contract 稳定）+ M#7（identity 定义不应随外部模块 schema 细分变）+ D6「智能体是决策主体 / 系统提供基础设施」（contract 切换清旧 messages 走 CLI 显式命令路径 / 系统不自动判定上下文边界）。
- **turn 边界 audit**：每轮 turn 写一对 `turn_start → (turn_end | turn_interrupted | turn_error)` audit 加 turnCount++
- **三种中断响应**：`IdleTimeoutSignal` / `PriorityInboxInterrupt` / `UserInterrupt` 经 AbortController + `_handleTurnInterrupt` 路由 turn_interrupted audit
- **inbox metadata 检测 + PriorityInboxInterrupt 触发**（phase 477 sharpen / cross-ref l2_messaging §10.2 notify_claw interrupt mechanism）：step 间隙读 inbox metadata（frontmatter）/ 检测含 `interrupt: true` 的 pending 文件 → 触发 PriorityInboxInterrupt → step 完成后 abort react 循环 / mechanism 跨 messaging（写 metadata）+ runtime（读 metadata + 触发 interrupt）双模块协议 / audit `turn_interrupted cause=priority_inbox`（既存）
- **轮级 snapshot commit**：每 turn 结束 `snapshot.commit(context='turn-N')` 让中断可恢复
- **dialog 落盘协调**：每次 LLM 调用后必通过 DialogStore 落盘 **完整 dialog snapshot**（systemPrompt + messages + toolsForLLM 3 件 / phase 709 reframe / 透过 stepCallback hook 调 DialogStore.save({systemPrompt, messages, toolsForLLM})）/ 这是 Design Principle「运行中断即从最后一次完整 LLM 调用恢复状态并继续」+「全然一致性」（phase 709 / 派生消费方 ask_motion 全然一致性 reuse Motion 实然 LLM call snapshot）的实现机制
- **system prompt 变更检测加 regime 切换协调**（应然 phase 457 sharpen + L2 接口前置 ✅ phase 466 / Runtime 业务 drift 待 phase 467+ code phase）：检测 system prompt 变化（业务条件 design-gap 待 derive / 候选触发：每 turn 起 invoke systemPromptBuilder 比对前次值 / 或显式 trigger）→ system 变 → 触发 `dialogStore.archive()` 当前 + 装配 `new DialogStore(..., newSystemPrompt)` + 业务决定 messages 是否继承 / derive 自 l2_dialog_store §A.r53-1 应然立场（DialogStore 1 instance = 1 system prompt regime / caller own regime 切换业务）
- **callbacks 透传 observability**：StreamCallbacks / DaemonStreamCallbacks 协议本模块定义 / caller 提供实现（StreamCallbacks 13 + DaemonStreamCallbacks 扩 onInboxMessages = 14 callbacks 总 / onBeforeLLMCall / onTextDelta / onToolCall / onTurnInterrupted / onProviderInfo 等）
- **identity 透明**：Runtime 内部无身份分支 / motion 与 claw 差异由 Assembly 注入 systemPromptBuilder + identityToolFilter 2 optional params

> 具体 API 形态归 [interfaces/l5.md](../interfaces/l5.md) Runtime 节。具体实现细节（_runReact / _drainOwnInbox / _handleTurnInterrupt / repairDialogIfNeeded / DispatchTool 注册闭包 / 15+2 RuntimeDependencies 字段 / ContextInjector 内部组件等）的存在依据是「常驻 agent 事件驱动循环」原语 — 实然采纳的细节差异加 DispatchTool 注册闭包结构性循环依赖等登记 §7。

### 不做

- **不做模块装配**（L1-L4 instances 构造），归 L6 Assembly — derive 自 M#1 独立可变职责
- **不维护 motion / claw 身份分支**（Assembly 注入 systemPromptBuilder + identityToolFilter / Runtime 内部无 if isMotion 分支）— derive 自 M#2 + Design Principle D10
- **不 own system prompt 内容生成**（systemPromptBuilder 是 Assembly 注入 callable / Runtime 仅 invoke + 检测变更触发 regime 切换 / 不知 prompt 内容业务）— derive 自 M#2 + D10
- **不做单步执行算法**（一次 LLM 调用加 tool 派发），归 L3 StepExecutor — derive 自 M#1
- **不做 agent 完整循环算法**（多步调度加停止判定），归 L3 AgentExecutor（Runtime 是 caller / 写 stepCallback）— derive 自 M#1
- **不做异步任务调度**，归 L4 AsyncTaskSystem — derive 自 M#1 + M#5
- **不做契约状态机**（生命周期管理加验收加重试），归 L4 ContractSystem — derive 自 M#1
- **不做单步 LLM 调用容错**（重试加 failover 加协议错误识别），归 L2 LLMOrchestrator — derive 自 M#5
- **不做工具实现加权限校验**，归 L2 Tools — derive 自 M#5
- **不直接磁盘 I/O**（dialog / audit / snapshot / inbox / outbox / fs 全经 L1/L2 注入接口）— derive 自 M#3 + M#5

## 2. 业务语义（M#2 业务语义归属）

> 应用 M#2（模块为自己的业务语义负责），Runtime 的业务语义边界：

- **own**：「常驻 agent 事件驱动循环」业务语义唯一发起点 — turn 边界加中断响应加轮级 commit 加 dialog 落盘协调加 session lifecycle 协调（startup archive rotation + regime 切换 / DialogStore 装配由 Assembly 完成 / Runtime 不 own 装配）加 AsyncTaskSystem 生命周期协调。这些是 Runtime 唯一懂的「业务」（long-running service 级）。
- **角色定位**：Runtime 是「**事件驱动 long-running service**」非「**装配器**」非「**循环算法器**」。Assembly 给注入 instances + identity / Runtime 跑循环 + 协调生命周期。
- **identity 透明**：Runtime 不分 motion / claw 身份 / 同一代码基复用（Philosophy「motion 加 claw 是 agent 的两种 identity」derive）。Assembly 装配期注入 identity 差异（systemPromptBuilder + identityToolFilter）。

## 3. 资源（M#3 资源唯一归属）

> 应用 M#3（每种资源只归属唯一模块），Runtime 独占的资源：

| 资源 | 类别 | 持久化 |
|---|---|---|
| `currentAbortController` / `turnCount` | 派生态 | ✗ |

**无磁盘资源** — Runtime 仅持运行期内存句柄。dialog / audit / snapshot / inbox / outbox 全归 L2 各模块。

> 注：常量（`MOTION_CLAW_ID` / `DEFAULT_MAX_STEPS` 等）集中 `src/constants.ts` / RuntimeDependencies 15+2 字段详 [interfaces/l5.md](../interfaces/l5.md) Runtime 节（注入引用非 M#3 业务资源）/ 内部组件 ContextInjector + DispatchTool 注册闭包归 §1.做 实施细节（非 M#3 资源 / DispatchTool 闭包结构性循环依赖见 §7.B closed 行）。

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

22 RUNTIME_* + 1 sub（13a `llm_unparseable_tool_use`）+ 1 HEARTBEAT_* = 24 events 总（**phase 521 +1 `regime_switch` / phase 539 +1 `regime_switch_failed`**）：

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
| 21 | `regime_switch` | _runReact 末检测 **identity 段**变化（phase 521 立 / phase 539 sharpen identity-only）/ archive + new instance + per strategy 继承 messages + DialogStore.repair 修 tool_use 悬空 后 | `strategy=<all\|none\|last-turn>` `inherited=N` `discarded=N` |
| 22 | `regime_switch_failed` | _checkRegimeSwitch 内 _performRegimeSwitch throw（phase 539 / soft degrade / lastIdentityHash 不更新 → 下 turn 重试自愈 / D7+D2）后 | `reason=<error message>` |
| H1 | `heartbeat_fire_failed` | Heartbeat tick 触发失败 | `reason` |

每任务独立子 audit 由 AsyncTaskSystem 写 / 本模块仅写 turn 级 + 生命周期事件。

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
| ~~**A.spec-1 13 port types 应然 silent ↔ 实然 RuntimeDependencies 全 port 化**~~ | ~~spec drift / 大~~ | **✅ closed**（phase 429 / `62e10d55` / 13 port cluster 全清）| **完整闭环路径**：(1) phase414c L5 audit interfaces/l5.md 临时 align 实然 13 port + 标 STALE 推翻 candidate / (2) phase 424 删 TaskLifecyclePort（5 caller 直 dep AsyncTaskSystem）/ (3) **phase 429 删整 `runtime-ports.ts` (~140 行 / 11 余 ports：AuditPort / SnapshotPort / SessionStorePort / InboxPort / OutboxPort / ToolRegistryPort / ToolExecutorPort / ContextInjectorPort / ExecContextPort / ContractManagerPort / SkillRegistryPort）/ Runtime 直 dep concrete L1-L5 模块** / (4) 2026-05-04 重审同步 interfaces/l5.md 删 12 port interface 应然描述 + RuntimeDependencies 字段 type 全改 concrete + 注 phase 429 cluster 收 / **同 `feedback_governance_workaround_smell §5 cluster 7 全闭环` Runtime 11 余 ports 行**（净 -104 行 / 1373+ tests PASS / 0 行为改）|
| ~~**A.cross-layer-up Runtime → Assembly 反向 import**~~ | ~~drift / 中~~ | **✅ closed (phase 454 / `638e6b37`)** | Path #1 实测核 grep 浮出 / 不在原 §A 表（用户问「除了 spawn schema + ask_caller 没别的了吗」触发深核）/ runtime.ts:29 + last-exit-summary.ts:16 import ASSEMBLY_AUDIT_EVENTS / 5 处 const ref（runtime.ts L204+L276 写 ASSEMBLE_FAILED + last-exit-summary.ts L88-92 case DAEMON_*）。phase 454 落地：(1) RUNTIME_AUDIT_EVENTS +2 events（INBOX_INIT_FAILED + SESSION_REPAIR_FAILED）替代 Runtime 借 ASSEMBLE_FAILED / (2) last-exit-summary 改字符串字面量匹配 'daemon_stop' / 'daemon_crash' / 'daemon_unclean_exit' / 跨进程 audit.tsv 字符串契约模式（同 phase 393 cross-check 设计）/ (3) 删 2 import / Runtime 全 dir 0 反向 import Assembly / 4 files +18 -19 / **计划遗漏 tests/core/runtime-initialize-failures.test.ts assertions / 用户 grep 自补**（同 phase 432/438/443/450 同型 N+4 实证 / Step 0 grep scope 完整性纪律）/ M#5 单向依赖 align ✓ / `feedback_governance_workaround_smell §1 cross-layer-up 必反向消除` 实证累 N+1 |
| **A.regime-switch-audit-field-symmetry phase=save_and_dump 缺 recovery_path** | sweep hygiene / 低 / r78 D fork phase 641 P1.1 derive | **✅ closed by phase 646（C fork r79 / commit main `40ff2f95` / merge `4f1ebb52`）** | runtime.ts:983-1000 regime_switch_failed audit phase=save 含 `recovery_path=${recoveryPath}` (line 986) 但 phase=save_and_dump 缺（phase 600 δ 决策实施时 field 复制不全 / hygiene 残留）/ phase 646 加 recovery_path 入 save_and_dump 分支（1 行）/ 0 NEW const / 0 行为差仅 audit observability + log 查询友好 / **「audit field schema 一致性」N=1 实证**（推 r80+ 同型 ≥ 2 升格独立 feedback）|
| **A.regime-switch-atomicity `_performRegimeSwitch` step 5+6 顺序 race / inherited 数据丢失** | drift / 中 / r72 H fork phase 600 derive | **closed by phase 600**（main `205f9824` / merge `e9c75832`）| 实然 `runtime.ts:936-964` `_performRegimeSwitch` step 5 替换 `this.sessionManager` 为 new instance 后 / step 6 `newSessionManager.save(repaired)` 抛（disk full / IO error / EACCES）→ outer `_checkRegimeSwitch:927` catch audit `regime_switch_failed` + lastIdentityHash 不更新 → 下 turn 重 trigger / 但 step 2 archive 已 fs mutate（current.json mv 走）→ 下 turn step 1 load() 经 loadLatestArchive 拿到旧 / step 2 archive() 抛 ENOENT → loop / **inherited 永久丢失** / 违 D1 信息不丢失 + D5 日志重建。**dispatch 三方案实测 reframe**：α rollback this.sessionManager 仅 internal 指针 / archive 已 fs mutate / 不彻底；β hash 提前更新永久丢更差 reject；γ 二阶段 commit 方向对但仅 reorder step 5+6 不解决 archive 已发生后 inherited 丢。**phase 600 决策（28 原则核 5/5+ 一致 dominant 自决 / 类 phase 586 audit fallback dump 模板）**：NEW δ = (D1.reorder) step 5+6 调换 prepare → save → commit + (D2.path) catch 内 dump inherited 到 `<dialogDir>/regime-switch-recovery-<ts>.json`（不进 archive dir / 不被 normal load 触动 / Watchdog 可观察）+ (D3.schema) JSON `{systemPrompt, repaired, original, strategy, timestamp, reason}` + (D4.audit) 复用 `REGIME_SWITCH_FAILED` 多参 `phase= recovery_path= inherited_count=` 子场景（0 NEW const align phase 541+591 模板）+ throw 保 outer catch lastIdentityHash 不更新 D7 自愈 / dump 失败 final fallback audit only。**⚓ invariant**：dialogStoreFactory ctor must not fs-mutate（verified store.ts:29-41 / 仅赋值字段 / 防 prepare 阶段意外 mutate fs 破坏 atomicity）。**known limitation**：archive idempotent 与 daemon 启动期 recovery file 自动 import 推 r+1 评估 |
| **A.bypass-1 last-exit-summary.ts 直 import `node:fs`（fd 模式）** | M#5 弱违反 / 中 | **✅ closed**（phase460 / main `d21df6c7`）| L5 Runtime last-exit-summary.ts 直 import OS sync API 绕 FileSystem L1 / 7 fsNative calls 全清：(1) existsSync / statSync / readFileSync / openSync(fd) / readSync(fd, buf, len, offset) / closeSync(fd) → `fs.{existsSync, statSync, readSync, readBytesSync(start, end)}` (2) **fd 模式 → `readBytesSync` 一次到位替代**（FS abstraction 一等接口 / 1 syscall 替原 3 syscall fd-open-read-close 三件套 / 比 phase455 Step E appendSync 多次模式更优 / 因为 readBytesSync(start, end) 直接覆盖 tail bytes 语义）(3) file 头部 L10-12 注释 claim 推翻（原说「读尾部 N 字节语义不在 FileSystem 接口范围内」是 stale 错认知 / readBytesSync 实然存在 types.ts:162 + node-fs.ts:328）/ caller cascade（runtime.ts:265 + 2 tests 12 用例）/ 行为 0 改 / 同 phase434+436+439+455 bypass cluster 模板 / **bypass cluster 6/6 全闭里程碑** |
| **A.r57-1 system prompt 变更检测加 regime 切换协调实然 0 实施** | feature gap / 中 | **✅ closed by phase 521 / SHA `65e8fdd3` + 修正 by phase 539 / SHA `81765e72`**（identity-only diff + soft degrade / design+code 联动 **5 阶段**闭环：phase 457 design + phase 466 L2 前置 + L5.G1-G4 closure 2026-05-07 + phase 521 src 落地 + phase 539 缺陷修 ζ）| **应然 sharpen by phase 457 + L5.G1-G4 closed 2026-05-07**（per §1 「做」+ §2 own + l2_dialog_store §A.r53-1 应然立场 + interfaces/l5.md Design-gap 段 4 决策）：Runtime 每 turn 末检测 system prompt 变化 → `dialogStore.archive()` + `new DialogStore(..., newSystemPrompt)` + messages 继承 strategy（default 'all' 全继承 / `regimeSwitchStrategy?: 'all' \| 'none' \| 'last-turn'` 枚举 caller override）。**实然 drift**：Runtime 装配期一次性 `systemPromptBuilder()` 拿 system / 0 检测变更 / 0 regime 切换协调 / DialogStore lifetime 跨整个进程 1 instance / 与「1 instance = 1 system prompt regime」立场不 align。**真合规修复**（phase 467+ code phase / 全前置就位）：(1) RuntimeOptions +`regimeSwitchStrategy?: 'all' \| 'none' \| 'last-turn'` 字段 default 'all' / (2) Runtime 每 turn 末自动检测（_runReact 末用 turn 起 build 的 systemPrompt 比对 lastSystemPrompt / 不重调）/ (3) 变更触发 `dialogStore.archive()` + `dialogStoreFactory(newSystemPrompt)` + per strategy 决定 messages 继承 + 复用 `DialogStore.repair` 修 tool_use 悬空 / (4) RuntimeDependencies +`dialogStoreFactory: (systemPrompt: string) => DialogStore` callback / Assembly 装配期注入（M#2 装配业务归 Assembly own）。**前置 ✅**：DialogStore code phase 完成 by phase 466 / SHA `201bc6df` + L5.G1-G4 design closed by 原则 derive 2026-05-07（用户拍板 (a)(a)(a)(a) 全 (a) / G2 反 over-engineering 同 phase 458 模板）。**L5.G1-G4 决策详 interfaces/l5.md Runtime 节 Design-gap 段**：G1 messages 继承 default `'all'` 全继承（D1c+D2+D6+Philosophy 上下文工程）/ G2 接口形态枚举字符串（M#9+M#8+反 over-engineering）/ **G3 触发时机每 turn 末自动检测**（turn 末优势：regime change turn 内 0 LLM latency 阻塞 + agent 体验平滑 + 冷启动 0 额外 + 实施简单 / 详 interfaces/l5.md G3 注）/ G4 tool_use corner case 自动 repair 复用 DialogStore.repair（D1c+D2+M#7+D5）|

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
| **L5.G1 (runtime)** RuntimeDependencies 字段名 `sessionManager` + `contractManager` + `skillRegistry` stale post phase 423 + 416 + 420 rename | **业务决策性 design-gap / r65 起 cross-doc audit 浮出 / `feedback_design_doc_sync_after_phase_closure` 第 N+6 实证累**：interfaces/l5.md RuntimeDependencies line 53 `readonly sessionManager: DialogStore` + line 60 `readonly skillRegistry: SkillSystem` + line 64 `readonly contractManager: ContractSystem` 三联同型自标「字段名 rename align canonical 推 r+1 phase」/ phase 423 (DialogStore rename / SHA `5e4dc48b`) + phase 420 (SkillRegistry → SkillSystem rename / SHA `2b1f717c`) + phase 416 (ContractSystem rename / SHA `e2389021`) class/工厂/audit 全 rename 但 RuntimeDependencies 字段名 stale / 涉 caller cascade（Assembly 装配点 + Runtime 内部所有 `this.sessionManager` / `this.skillRegistry` / `this.contractManager` use site）/ r65 cross-doc audit 补登记第 3 字段 `skillRegistry` | **业务决策性 / 用户拍板候选 + r+1 code phase 推**：α 推 r+1 code phase rename `sessionManager` → `dialogStore` + `skillRegistry` → `skillSystem` + `contractManager` → `contractSystem` + caller cascade（同 phase 416/417/418/420/421/423 反向 rename 模板族）/ β 保留现状（字段名 stale 但 type 已 align / 注 line 53+60+64 自标 stale）/ γ arch §M#9 同一概念同一名字 升档为 §A 必修 |
| **L5.G2 (runtime)** ContextInjector + ExecContext 字段在 RuntimeDependencies 暴露 / arch 表 1 不列 | **业务决策性 design-gap / r65 起 cross-doc audit 浮出**：interfaces/l5.md RuntimeDependencies line 61-62 暴露 `readonly contextInjector: ContextInjector` + `readonly execContext: ExecContext` 2 字段 / arch 表 1 Runtime row 依赖列「FileSystem、LLMOrchestrator、AuditLog、Snapshot、DialogStore、Messaging、Tools (Registry+Executor)、SkillSystem、ContractSystem、AsyncTaskSystem」10 dep 不含 ContextInjector + ExecContext / arch 注 §14 SkillSystem 标「Runtime（含内部 ContextInjector 组件）」/ ContextInjector 是 Runtime 内部组件 vs DI 暴露不一致 | **业务决策性 / 用户拍板候选**：α arch 表 1 Runtime row 依赖列加 ContextInjector + ExecContext / β interfaces RuntimeDependencies 把 contextInjector + execContext 改 internal 不暴露（Runtime 自构造）/ γ 保留现状（ContextInjector 装配期注入 vs 内部组件灰色 / 不影响 caller derive）|
| **B.outbox-error-response-strategy `_writeErrorResponse` outbox 写失败 sender 链路策略** | drift / 中 / r72 G fork phase 599 ratify 标 ⚓2 部分可决 排除 / r74 J fork 登记 / **phase 622 ratify refine** / **closed by phase 633 (r77 C fork) / β reframe 0 NEW const** | ✅ **closed by phase 633（α dominant / β reframe 0 NEW const / main `92b99776` / merge `bc7128f7`）** | 实然 `runtime.ts:820-842 _writeErrorResponse` 已实施 silent + audit（既有 `RUNTIME_AUDIT_EVENTS.OUTBOX_WRITE_FAILED` 100% 覆盖 / context=error_response + scenario + reason 子场景区分）/ phase 633 加 method jsdoc design intent comment / **0 NEW const**（β reframe per `feedback_zero_new_interface_field_reuse` N=7 实证累 578+590+596+607+611+614+633）/ **「principle-derived ratify cluster 三阶段链路」N=4 实证累**（599 起草 → 622 ratify → 628 user 默推 → 633 code 落地 / 跨 J→D→C fork 三 r 轮）/ **「dispatch claim sweep 100% 既有覆盖 → β reframe 0 NEW」首发模板** |
| **B.inbox-unaddressed-dlq** runtime.ts:316-336 unaddressed 消息（`to=otherClaw`）audit `INBOX_UNADDRESSED` ✓ 但与 addressed 一并 markDone → 永入 done/ / 0 retry / 0 DLQ / 0 redirect / sender 误投后无自动恢复路径 | **✅ closed by phase 565 / γ ⚓ accepted-stable**（用户主动提议原则 derive → 主会话原则严格核 / phase 554 β framing 错估修正）| **closed by phase 565（γ 6/6 全 align + β framing 拆解修正）**：γ ⚓ accepted-stable closed。**Path #1 加深核（phase 554/560 漏）**：inbox-reader.ts:103-120 `markDone = fs.move pending → done/` 文件名加 `<ts>_<uuid8>_<原名>` 前缀 / **消息全文完整保留 / 不删 / done/ 已是 effective DLQ**。**γ 6/6 全 align**：D1 信息不丢失 ✓（done/ 全文保留）+ D2 不丢弃 ✓（audit + done/ 双保险）+ D5 重建链路 ✓（audit `INBOX_UNADDRESSED` 含 from+to + done/ 全文 grep）+ D7 受信路径 ✓（不自动救 sender 决策错误）+ M#7 耦合稳定 ✓ + M#8 耦合界面最小 ✓。**β framing 错估修正（phase 554 → phase 565）**：β 拆 β1+β2 二件不同事：β1 = 「DLQ 储存（不自动处理）」→ done/ 已实现 / NEW DLQ 路径 0 收益 / 反 M#8 耦合界面最小 / 排除；β2 = 「DLQ + motion handler 自动 review」→ 自动 review 错投 = 系统替智能体救决策错误 = **反 D7「智能体是决策主体 / 系统内部走可信路径」**（同 α 排除根）/ 排除。phase 554 β「dominant 8/11」标错（未拆 storage vs 自动处理 / Path #1 markDone 未深核 done/ 已是 effective DLQ）/ phase 565 加深拆解后全 β branch 应排除。**δ（audit `reason=` 字段）派生 hygiene 推 r+1+ 顺手清独立 phase**：1 字段加 / 边际 D5 增强 / 与 γ 不冲突 / 0 业务决策。 ~~open / 待用户拍板（r67 G fork phase 554 起草）~~ | **触发**：r67 ⚠️ unverified review。**Path #1 实测核**：runtime.ts:296-302 分流 ✓ + line 316-323 audit `INBOX_UNADDRESSED` 含 `from / to` ✓ + line 326 一并 markDone（addressed + unaddressed）/ 0 DLQ 路径 / 0 redirect handler / done/ 文件可手 grep 还原但运行期 0 自动恢复。**候选**：(α) runtime 自动 redirect 投正确 claw inbox — **反 D7 受信路径**（误投意味 sender 写错 / 自动 redirect 掩盖 sender bug）/ ML 4/11 / 反 M#5（runtime 跨 claw 写）/ 排除；(β) **motion DLQ**（unaddressed 写 motion DLQ 目录 + motion handler 后台 review）— ML 7/11（M#2+M#3+D11+M#10）+ DP 8/11（D1+D1d+D2+D5+D11）+ Philosophy 3/4（P3+P4 align）/ **业务决策**（NEW DLQ 路径 + motion 后台 review handler）/ 推 r68+ messaging L2 + motion L5 联合 phase；(γ) 现状 ⚓ accepted-stable 显式登记 — D1d 已部分满足（audit 含 to / done/ 文件可 grep）/ ML 6/11 弱 / DP 5/11 / **兜底 fallback**；(δ) audit 加 `reason=redirect_or_review_required` 字段 — 1 字段加 / D1d 边际 align / 6/11 ML / 派生 hygiene；(ε) unaddressed 不 markDone 保留 pending — **反 D2 软降级**（inbox 爆炸）/ 排除。**dominant**：β 强 dominant（DP 8/11）但属 NEW 业务决策性 / 不归 dominant 自决 / γ 兜底 fallback。**拍板待**：(1) β 拍板 → r68+ messaging L2 + motion L5 联合 code phase（NEW DLQ 路径 + motion handler）/ (2) γ 拍板 → row ⚓ accepted-stable 显式登记 done/ 可 grep 还原是 D1d 完整满足 / (3) δ 独立 1 字段加（与 β/γ 不冲突）。**升档条件**：β → r68+ NEW DLQ phase / γ → row ⚓ stable 锁。**反向纪律 align**：feedback `business_decision_phase_user_ratify §反向纪律` 起草「待拍板」前先核原则 derive / β 真业务方向（NEW DLQ 业务）/ γ 真合规候选 / 双有效不入「唯一答案不入待拍板」反 framing |

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
- D6 子代理后不阻塞：经 AsyncTaskSystem（phase163 文件驱动消除循环耦合）
- D7 系统可信路径：L1-L4 受信注入 / tools 经 ToolExecutor 受约束路径
- D8 事件驱动：processBatch 的 inbox 排空 → turn 循环即事件驱动
- D9 CLI 唯一对外：N/A（Runtime 内部服务 / 由 Daemon 装配 / 不直接对外）
- D10 多 claw 不隔绝：经 Messaging inbox/outbox 跨 claw 通信
- D11 motion 特殊：systemPromptBuilder + identityToolFilter 注入 motion 身份差异

**Philosophy**

- P1 Agent 即目录：消费 clawDir + systemFs / clawFs / agent 状态映射目录
- P2 上下文工程：contextInjector + buildSystemPrompt + stream callbacks 全链路是上下文流转
- P3 分多个智能体加分子任务：AsyncTaskSystem 驱动 subagent 并行 / Runtime 按 identity 复用同一代码基
- P4 系统为智能体服务：提供决策所需信息 + 基础设施（dialog / tools / stream / audit）

**Path Principles（7 条）**

- **Path #1 路径规划基于规划时刻的事实**：phase178/182/247/266/278/288/295/351 各 phase 起步 Path #1 核 / `_drainOwnInbox` 直读 fs 契约文本落后实然首次发现（注意实施过程中实然的变化）
- **Path #2 实然和应然差距显式登记**：违规明文上墙（在路径规划时参考 / §7.A + §7.B）
- **Path #3 语义原子变更单元**：phase266 motion subclass 消灭单 commit / 无 caller 改 / 1 phase = 1 commit 原子
- **Path #4 可回滚 + 破坏性论证**：API 改动 caller 评估 / 破坏性改动显式论证（反向测试：本模块可独立替换 DialogStore / Snapshot / AsyncTaskSystem 实现而不动 Daemon caller —— M#1 ✓）
- **Path #5 完成后复盘**：phase 收尾三维 + Path Principles 第 4 维对账
- **Path #6 冲突立即中断**：纪律.1 总览 vs 规范节号错位 → 停 → 用户确认（冲突调整优先于强行推进）
- **Path #7 总难度路径**：实然到达应然有诸多路径 / 选择降低总难度的（步骤间有相互作用 / 总难度 ≠ 各步骤成本简单相加）/ ~~phase335 13 port 一次注入是「总难度最低」叙事~~ ⚠ STALE 推翻 → ✅ phase 429 全清 (`62e10d55`) / 13 port cluster 全反向 / Runtime → Tools L5→L2 顺向直 dep 完全合 M#5 / 详 feedback_governance_workaround_smell §5 cluster 7 全闭环

> 注：原 §7.C「Path #8 总难度最低」是 Path #7 mis-numbered（canonical Path Principles 7 条 / 第 8 条不存在）/ 已修订为 Path #7「总难度路径」verbatim + 保留 phase335 STALE 推翻历史作为派生应用。

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
- 2026-04-27 / phase335 13 port 注入化（H7+H8）+ DispatchTool 物理迁 ⚠ STALE 推翻 → ✅ **phase 429 cluster 全清**（`62e10d55` / 删整 runtime-ports.ts 11 余 ports + phase 424 删 TaskLifecyclePort + DispatchTool 同期同型治理 / 累 13 全反向）/ Runtime 直 dep concrete L1-L5 模块 / `feedback_governance_workaround_smell §5 cluster 7 全闭环` Runtime 11 余 ports 行 + TaskLifecyclePort 行
- 2026-04-27 / phase336+phase338 H1 audit-events.ts 模块自治拆分（RUNTIME_AUDIT_EVENTS + HEARTBEAT_AUDIT_EVENTS 物理迁）
- 2026-04-27 / phase347 KD#29 dispatch 物理迁 → `src/core/task/tools/dispatch.ts`
- 2026-04-27 / phase351 A.r43-1 DispatchTool describing 模式 multi tool_use 防御性遍历闭环
- 2026-05-01 / phase396 RUNTIME_AUDIT_EVENTS +1 `LLM_UNPARSEABLE_TOOL_USE`（step-executor 8 console 协调 β 路径落地 / runtime.ts:537 wiring 仅主路径 _runReact / chat path 不扩散 / main `3eeffad7`）
- 2026-05-01 / phase405 audit 事件回链测试 7 事件 auditSpy 直接断言补（main `34f7027c`）
- 2026-05-03 / phase410 §7.B `_hasHighPriorityInbox` 同型绕过 InboxReader 闭环（main `129e8505`）/ InboxReader 扩 peekMetas 非消费型 API + Runtime 改调（删 fs.readdir + InboxWriter.readMeta 双依赖）/ ~~port pattern 第 N+1 次复用~~ ⚠ STALE：peekMetas 是 method addition 不是 port pattern / 标错 / 同 phase 与 l6_assembly LockConflictError 归 PM 治理（C 类小颗粒批量 / 模块边界重构阶段第 2 phase）
- r60+ 重编号：9 节 → 8 节 / 每节 derive 自一条 Module Logic Principle（删原 §2 接口 / §5 上游依赖 / §6 不可消除耦合 → 已并入 interfaces/l5.md / 拆原 §1 所有权 hub 为 §1 职责 + §2 业务语义 + §3 资源 + §4 持久化 / 删原 §10 已知问题补充 → dispatch describing 根因链已经 phase351 闭环）
- 2026-05-04 / phase460 fsNative bypass 治理（main `d21df6c7`）/ last-exit-summary.ts 7 calls + fd 模式 → readBytesSync / **bypass cluster 6/6 全闭里程碑**（phase434 ContractSystem manager 5 + phase436 ContractSystem jobs 8 + phase439 ProcessExec/PM + phase455 memory×2+cron+evolution+task 34 + 本 phase 7 = 累 60+ calls）/ file 头部 stale claim 推翻（「读尾部 N 字节语义不在 FileSystem 接口范围内」错认知 / readBytesSync 实然存在）
- 2026-05-04 / cross-doc audit drift 修订（§7.C P3 verbatim「分多个智能体加分子任务」/ §3 资源粒度 align arch 表 1 = 仅派生态 currentAbortController + turnCount / 注入引用 + 内部组件 + 常量降为 §3 注脚）
- 2026-05-04 / **phase 454 cross-layer-up Runtime → Assembly 反向 import 治理**（`638e6b37`）/ runtime.ts + last-exit-summary.ts 删 ASSEMBLY_AUDIT_EVENTS import / RUNTIME_AUDIT_EVENTS +2 events（INBOX_INIT_FAILED + SESSION_REPAIR_FAILED）替代 Runtime 借 ASSEMBLE_FAILED / last-exit-summary switch case 改字符串字面量 'daemon_stop' / 'daemon_crash' / 'daemon_unclean_exit'（跨进程 audit.tsv 字符串契约模式 / 同 phase 393 cross-check 设计）/ Runtime 全 dir 0 反向 import Assembly / **M#5 单向依赖 align** / `feedback_governance_workaround_smell §1 cross-layer-up 必反向消除` 实证累 N+1 / Path #1 实测核浮出（不在原 §A 表 / 用户问触发深核）
- 2026-05-05 / r65 cross-doc audit 单 doc 一致性核（modules/l5_runtime.md vs arch §25 + 表 1/2 + interfaces/l5.md Runtime 节）/ 0 derive drift / 主 derive 全 align（M#1-M#11 + Design Principle D1-D11 + Philosophy P1-P4 + Path #1+#3+#6+#8）/ 修 §7.E KD#29「ask_motion」stale → 「ask_caller」(per arch 表 3 + phase 470 spawn cluster 收尾 SHA `a6b99f18`)/ 7 abilities 全 align arch 表 2 + phase 477 inbox metadata + phase 457 system prompt regime 切换 sharpen 保留 / phase178 + phase 429 + phase 454 + phase 460 多里程碑稳态保留 / design only / 0 src 改
- 2026-05-07 / **session lifecycle 协调业务显式登记**（design only / 0 src）/ §1 +「session lifecycle 协调」业务条 + §2 own 列加该业务 / closure l2b §G3+§G4 design-gap by γ 决策（l2b.md G3+G4 标 closed）/ 4 候选评分 γ 5/5 全通过：α 反 M#1+M#11（implicit 散布）/ β 反 M#1+M#8（非独立可变 + 新表面 / 同 phase 458 STALE 推翻判据）/ δ 反 M#1+M#7（混 daemon 业务 + 边界重画）/ γ 满足 M#1+M#2+M#7+M#8+M#11 + Philosophy「Clawforum 本质上下文工程」+ Design Principle「智能体决策主体 / 系统提供基础设施」cross-check 一致 / 实然 archive 触发 1 处 = `runtime.ts:142` startup / 业务复杂度不足以独立策略层 / **应然 vs 实然 align（implicit → explicit）**
- 2026-05-07 / **L5.G1-G4 regime 切换 4 design-gap closure by 原则 derive**（design only / 0 src）/ 用户拍板 (a)(a)(a)(a) 全 (a) / G1 messages 继承 default 'all' 全继承（D1c+D2+D6+Philosophy 上下文工程）/ G2 接口形态枚举字符串 `'all' \| 'none' \| 'last-turn'`（M#9 编译器优先 + M#8 最小表面 + YAGNI 反 over-engineering / 反对 callback (b) 1 impl + 0 ROI 同 phase 458 STALE 推翻判据 / 反对混合 (c) 双表面 / 未来真出现 caller 需 callback 时升档 per M#11）/ **G3 触发时机每 turn 末自动检测**（用户提议 turn 末优于 turn 起：regime change turn 内 0 LLM latency 阻塞 + agent 体验平滑 + 冷启动 0 额外 + 实施简单 _runReact 末 1 处 check / 4 turn entry 自动 cover）（D8 事件驱动 + M#1 业务归 Runtime own + M#8 0 新表面）/ G4 tool_use 悬空 corner case 自动 repair 复用 DialogStore.repair（D1c+D2+M#7 模板复用+D5）/ interfaces/l5.md RuntimeOptions +`regimeSwitchStrategy?: 'all' \| 'none' \| 'last-turn'` 字段（default 'all'）+ RuntimeDependencies +`dialogStoreFactory` callback（M#2 装配业务归 Assembly）/ §A.r57-1 update 触发条件齐全 / phase 467+ code phase 落地待启 / **「业务决策性 design-gap → 原则 derive 自决」模板首次大规模应用**（4 gap 全由 Philosophy + Design Principles + Module Logic Principles cross-check 导出 / 不靠主会话猜偏好 / 实施细节用户提议 turn 末迭代调整）
- 2026-05-07 / **phase 521 Runtime regime 切换协调实施**（main `65e8fdd3`）/ L5.G1-G4 src 落地：6 files +442 -1 / RuntimeOptions +`regimeSwitchStrategy?: 'all' \| 'none' \| 'last-turn'` field（default 'all'）+ RuntimeDependencies +`dialogStoreFactory: (systemPrompt: string) => DialogStore` callback / Runtime +`lastSystemPrompt?: string` field + `_checkRegimeSwitch` + `_performRegimeSwitch` method + `extractLastTurn` helper（'last-turn' strategy）+ audit `regime_switch` event +1 / chat() path 也触发 regime check（4 turn entry 自动 cover）/ Assembly closure-captures 5 const（systemFs / DIALOG_DIR / auditWriter / 'current.json' / clawId）+ initial sessionManager 保留（line 354 不动）/ tests/helpers/runtime-deps.ts mock dialogStoreFactory（per phase 450 教训 tests/helpers 必扫）/ 7 NEW tests cover G1-G4 + 冷启动 + audit / 1428 + 7 = 1435+ tests PASS / 0 行为差 main claw（首 turn 冷启动 0 archive / lastSystemPrompt undef → 跳过 → set / 既有 turn pipeline 0 改）/ §A.r57-1 ✅ closed / **r62 design closure → r62+ code phase 落地完整链路第 2 实证**（phase 520 第 1 / phase 521 第 2）/ design+code 联动 4 阶段闭环（design 457 + L2 前置 466 + L5.G1-G4 closure 2026-05-07 + code 521）/ 应然 phase 457「1 instance = 1 system prompt regime」立场首次 src 实证
- 2026-05-08 / **phase 539 Runtime regime switch 缺陷修**（main `81765e72`）/ phase 521 实施层 3 处 P0 / Bug 1（比对粒度过粗 dynamic 段误触发）+ Bug 3（chat() switch throw 整 turn 报错）+ Bug 2 phantom（dangling messages ref / Path #1 实证 grep 0 跨 turn reader / 不修）/ **β' + η + Bug 2 not-fix**：4 files +402 -36 / `ContextInjector.buildSystemPromptForRegime(): {full, identityHash}` 加（identity = agents + skills 拼接 / dynamic memory + contract 不入）/ Runtime `lastSystemPrompt` → `lastIdentityHash` rename / `_checkRegimeSwitch(systemPrompt, identityHash)` 双参 + 整段 try/catch + lastIdentityHash 不更新自愈（D7+D2 软降级）/ audit event +1 `regime_switch_failed`（23 → 24 events）/ 自定义 systemPromptBuilder fallback 走整段比对（兼容 phase 521 / U3 (a) 0 caller YAGNI）/ 7 既有 phase 521 tests 调整 mock buildSystemPromptForRegime + 8 NEW tests（identity-only / dynamic-only / failure recovery / fallback）= 15 PASS / **identity 层 vs 动态层立场首次显式登记**（U1 (a) 整段 dynamic 派生 = Philosophy「Agent 即目录」+ M#7 + D6 三联）/ §A.r57-1 ✅ 修正 closed / **design+code 联动 5 阶段闭环模板首发**（phase 457+466+ε+521+539）/ **「原则不点名 ≠ 原则定不了 / 严格组合 cross-check 才是判据」模板**首次实证（U1/U2/U3 三 undecidable 全经原则严格 cross-check 派生 (a) 三联 / 不靠用户拍板）/ 「直觉 bug 经 Path #1 实证为 phantom」候选 feedback（Bug 2 案例 / 推累 ≥ 2 升格）
- 2026-05-05 / **phase 489 runtime.ts 极保守 types + helper 抽出**（main `bc8dcdc8`）/ runtime.ts 924 → 835 行（净 -89）/ +2 NEW sub-file（types.ts 97 / utils.ts 20）/ Runtime class 14 method + 15+ class field 主体 0 改 / 4 turn pipeline（processBatch / processWithMessage / retryLastTurn / chat）+ _runReact 共享 0 切 / 仅抽 4 interface（RuntimeDependencies / RuntimeOptions / StreamCallbacks / DaemonStreamCallbacks）+ formatTimeAgo helper / runtime/index.ts barrel re-export 4 type（+1 DaemonStreamCallbacks 统一对外）/ create-runtime.ts:3 import path 调 1 行 / 5 caller cascade 0 改（cli + assembly + daemon + tests/helpers + create-runtime）/ 1370 tests PASS / 0 行为差 / **「模块内重构形态分类」第 3 形态首发 = 极保守整理性**（vs phase 480/486 激进式 / phase 484 保守式 / **N=3 阈值彻底达**）/ 决策依据：Runtime 是 instance bag + cohesive turn pipeline / 4 turn method 共享 _runReact / class state 15+ field / 拆 sub-module ROI 反向 / 仅类型 + 1 helper 可 100% 安全分离 / **「整理性 phase」非真重构**（净瘦 9.6% vs 形态 A 60-90% / 形态 B 20-25%）/ 关键纪律候选：拆 sub-module 起 phase 前必先核 ROI（4 turn method 共享 + class state 多 + 用户感知风险 → ROI 反向 → 形态 C 而非强套 A/B 模板）/ 推 r+ Meta 必硬化「模块内重构 3 形态分类」独立 feedback
- 2026-05-08 / phase 554 G fork r67 design only / 起草新 §B row「B.inbox-unaddressed-dlq」/ 0 src 改 / open 待用户拍板 / 候选 β motion DLQ 业务决策性强 dominant 8/11（NEW DLQ 路径推 r68+ 联合 phase）+ γ ⚓ accepted-stable 兜底 fallback / α 反 D7 排除 + ε 反 D2 排除 / dispatch 5 项 stale ratio 40%（r66+r67 累 N+1 实证 / disk-monitor + interfaces 副发现 STALE）/ phase 545 G fork r66 design only 单 Step 模板第 N 实证累 / **「业务决策性 → 28 原则核 derive → β + γ 双有效不入唯一答案反 framing」`feedback_business_decision_phase_user_ratify §反向纪律` align**
- 2026-05-09 / phase 565 G fork r68 design only / **§B.inbox-unaddressed-dlq closed by γ ⚓ accepted-stable**（用户主动提议原则 derive → 主会话严格核）/ **Path #1 加深核 inbox-reader.ts:103-120 markDone = `fs.move` pending → done/ 文件全文保留**（done/ 已是 effective DLQ / phase 554 + 560 漏核）/ γ 6/6 全 align（D1 信息不丢失 + D2 不丢弃 + D5 重建链路 + D7 受信路径 + M#7+M#8 耦合最小）/ **phase 554 β framing 错估修正**：β 拆 β1（DLQ 储存 / 0 收益 反 M#8 / done/ 已实现）+ β2（DLQ + 自动 review / 反 D7 同 α 根 / 系统替智能体救决策错误）/ 全 β branch 应排除 / phase 554「β dominant 8/11」标错（未拆 storage vs 自动处理 / Path #1 markDone 未深核）/ δ（audit `reason=` 字段）派生 hygiene 推 r+1+ 顺手清独立 / **phase 554 起草 + phase 560 reaffirm + phase 565 close 三阶段闭环模板首发** / 「phase 起草 framing 错估 → 后续 phase 加深拆解修正」模板首发 / 「业务决策性 → 原则 derive → dominant 自决」累 N=9
- 2026-05-09 / phase 560 G fork r68 design only / **reaffirm §B.inbox-unaddressed-dlq** still open / 待用户拍板 / Path #1 实测核 runtime.ts:316-336 unaddressed silent markDone 路径 phase 554 后未变（line 296-302 分流 + 316-323 audit + 326 一并 markDone 全 align）/ motion handler 现状跨模块集成核推 r69+（β 候选实施前置）/ dispatch 3 项 stale ratio 33%（§B.7 streamReader teardown STALE 推翻 closed by phase 558 Step D / r66+r67+r68 累 N=6 实证）/ β + γ 双有效 / 主会话 0 自决空间 / **「phase N 起草 → phase N+M reaffirm」模板首发**（design only / 业务决策跨多 r 待拍板时主会话定期 reaffirm + 加深 cross-check 不重 derive）/ 「design closure phase 单 Step A 形态」累 N=5（503+505+545+554+560）
- 2026-05-09 / **phase 557 paths.ts CLAW_SUBDIRS 名实修（B fork r67 / micro-hygiene）**（main `25915113`）/ phase 544 引入副作用前向修：CLAW_SUBDIRS 列表 line 85 误含 `CLAWS_DIR='claws'`（顶层容器）→ 每 claw 创建多生 `<claw>/claws/` 幻象空目录（`mkdir({recursive:true})` 静默幂等隐藏 bug / runtime.ts:855 + claw-create.ts:25 双 consumer 同型受影响）/ paths.ts -1 行 list + CLAWS_DIR/CLAW_SUBDIRS 双向注释 sharpen 命名空间区隔（CLAWS_DIR = 顶层容器 / CLAW_SUBDIRS = per-claw 内子目录列表）+ 1 NEW test `tests/cli/claw-create-subdirs.test.ts`（3 case：幻象目录不存在 + list 不含 CLAWS_DIR 运行+编译双核 + 既有期望 subdir 存在回归核）/ 反向 3 项 PASS / 0 行为差（除幻象目录消失）/ Path #1 实证 dispatch claim 4/4 真（**「直觉 bug → Path #1 实证 phantom」反命题实证 / dispatch ratio 既可 stale 也可全真 / 不预设 prior** / vs phase 539 Bug 2 phantom + phase 541 4 stale + phase 544 2 stale 形成平衡 cluster）/ **「phase N 副作用 → phase N+M 前向修而非 revert」模板第 N 实证**（同型 phase 540 D fork Step B 接力 / phase 544 → phase 557）/ micro-hygiene cluster N+1 实证累
- 2026-05-09 / **phase 596 hygiene cluster A（B fork r72）**（main `a7b938c8`）/ 3 site hygiene + 0 NEW const：(R72-P0-1) `runtime-audit-events.ts:29` 删 dead const `INBOX_META_FAILED`（grep 0 caller / 同名 const messaging/audit-events.ts:19 own actual usage / 跨进程 audit.tsv 字符串契约保）/ (R72-P0-2) `runtime.ts:31` 删 dead import `MOTION_CLAW_ID`（runtime.ts 内 0 usage / start.ts + tools/context.ts 仍 ref / 仅本模块清）/ (R72-P1-2) `runtime.ts:212` repairSessionIfNeeded `.catch(() => null)` → `.catch((err) => audit.write(SESSION_REPAIR_FAILED, context=load_skipped, reason=formatErr(err)); return null)` / **0 NEW const**（既有 `RUNTIME_AUDIT_EVENTS.SESSION_REPAIR_FAILED` 复用 + context=load_skipped 区分子场景 vs 既有 line 226 save 失败 / dispatch 标 NEW SESSION_LOAD_FAILED → Path #1 实测既有可复用）/ 1 NEW test cover load 失败 → audit / Path #1 dispatch 5/5 真（4 VERIFIED + 1 framing refine）/ **「既有 const/callback 复用 / 0 NEW interface field」纪律 N=3 实证累**（phase 578 NEW const 0 + phase 590 NEW callback 0 + phase 596 NEW const 0 / 升格独立 feedback 阈值远超 N=2 / Meta 40 加成）/ **「review claim 实测四态分类」N+1 实证累**（C1+b framing refine 类）/ **「dispatch 标 NEW const → Path #1 实测既有复用」模板首发**（治理首选 SOP）/ micro-hygiene cluster N+1 实证累
- 2026-05-10 / **phase 622 r74 J fork 5 ⚓ design ratify cluster（B fork r75 / single design phase / cross-cutting same-day）**（main `<sha 待 commit 后填>`）/ §B.outbox-error-response-strategy ⚓2 phase 622 ratify refine / 业务方向决策性 / ⚓ pending user binary（默推 α silent + audit）/ 28 原则 derive：α D2 软降级+YAGNI+M#7 简单稳定 / β M#10+M#11 caller 决策权 + caller cascade 中等成本 / γ D5+observability+DLQ 业务复杂度高反 YAGNI / 主登记 l2_llm_orchestrator §B 3 row（⚓4+⚓5+⚓8 dead class closed）+ l4_memory_system §B（⚓11 默推 α）+ l1_llm_provider 关联 ⚓8 / **「principle-derived ratify」N=3 实证升格阈值过线**（phase 599+603+622 / Meta 41 加成）/ **「F fork ratify → r+1 code phase 落地」cluster 三阶段链路扩** / **design only 单 Step 内联模板第 9 实证累**
- 2026-05-10 / **phase 633 J fork ⚓2 outbox-error-response-strategy α 落地**（C fork r77 / 三阶段链路第 4 实证 / main `92b99776` / merge `bc7128f7`）/ runtime.ts:_writeErrorResponse jsdoc 加 design intent comment / 0 src 行为差 / **0 NEW const**（既有 RUNTIME_AUDIT_EVENTS.OUTBOX_WRITE_FAILED 100% 覆盖 / β reframe per `feedback_zero_new_interface_field_reuse` N=7 实证累 578+590+596+607+611+614+633）/ §B.outbox-error-response-strategy closed by phase 633 / **「principle-derived ratify cluster 三阶段链路」N=4 实证累**（599→622→628→633 / 跨 J→D→C fork 三 r 轮联动 / 与 ⚓11 真 α 实施异质双 row close 同 phase）/ **「dispatch claim sweep 100% 既有覆盖 → β reframe 0 NEW」首发模板**（推 r78+ ≥ 2 实证升格独立 feedback）
- 2026-05-10 / **phase 646 phase 641 P1.1 audit field symmetry 落地**（C fork r79 / commit main `40ff2f95` / merge `4f1ebb52`）/ runtime.ts:992-998 regime_switch_failed phase=save_and_dump 加 recovery_path field（phase=save 既有 line 986 / 对称化 hygiene）/ 0 NEW const / 0 行为差仅 audit observability + log 查询友好 / §A.regime-switch-audit-field-symmetry closed by phase 646 / **「audit field schema 一致性」N=1 实证**（推 r80+ 同型 ≥ 2 升格独立 feedback）/ phase 600 δ 决策实施时 field 复制不全 hygiene 残留 / r78 D fork phase 641 fan-out review round 8 浮出 / 「fan-out review → r+1 P1 cluster fix single phase」N=2 升格阈值达（phase 636+646）

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| KD#16 | 事件驱动循环归 Runtime / Daemon 调 Assembly.assemble + Runtime.start | ✓ |
| KD#24 | identity 差异由 Assembly 按配置注入 / Runtime 内部无身份分支 | ✓（phase266 闭环 / +2 optional params 注入）|
| KD#25 | Runtime 不自建 L1-L2 实例 / 经 RuntimeDependencies 注入 | ✓ |
| KD#29 | spawn / dispatch / ask_caller 工具归 AsyncTaskSystem(L4)| ✓（phase347 dispatch 物理迁 / phase 470 ask_caller spawn cluster 收尾 SHA `a6b99f18` / arch 表 3 同步）|

## 8. 测试覆盖

应然行为（不绑定具体测试文件路径）：

- **lifecycle**：initialize 成功路径（dialog_loaded audit + tool 注册 + taskSystem.startDispatch 调用）+ 失败路径（task_system_init_failed / task_system_start_dispatch_failed / assemble_failed 各异常）
- **stop / resumeContractIfPaused**：taskSystem.shutdown 清理 / 挂起契约恢复
- **事件循环入口**：processBatch 无 inbox 返 0（空 fast path）/ 有 inbox 触发 _drainOwnInbox + _runReact + turn audit pair / processBatch 触发 onInboxMessages 回调 / processWithMessage 合成消息单轮 / retryLastTurn 重试 / chat REPL 路径
- **中断三路**：abort → UserInterrupt → onTurnInterrupted('user_interrupt')；idleTimeout → IdleTimeoutSignal → onTurnInterrupted('idle_timeout', ms)；高优先级 inbox → PriorityInboxInterrupt → onTurnInterrupted('priority_inbox')
- **观察 / 装配回填**：getAsyncTaskSystem / getAuditWriter / getStatus 返内部引用 / phase182 后 setContractNotifyCallback / setParentStreamLog 已删（构造期注入）
- **motion identity 配置**（phase266）：identityToolFilter → toolRegistry.unregister('send')；systemPromptBuilder = buildMotionSystemPrompt 注入序（AGENTS → USER → IDENTITY → SOUL → MEMORY → skills → contract → AUTH_POLICY）
- **审计回链**（phase178 后双写 / phase405 测试断言强化）：19 + 1（heartbeat）events 全覆盖（phase396 +1 `llm_unparseable_tool_use`）/ phase405 后 7 事件（turn_* + llm_call/error + inbox_meta_failed）补 auditSpy 直接断言 / callback 间接断言全保留双断言并存
- **DispatchTool describing 模式**（phase351）：multi tool_use blocks 倒序遍历 / dispatchToolUseId 正确捕获 / mining 模式与 last block = dispatch 时行为 0 改
