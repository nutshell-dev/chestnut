# Assembly 模块内部契约

> 本文档限本模块**内部**应然 — 8 节结构 derive 自 Module Logic Principles：§1-§4 = M#1-#4 各占一节，§5 审计 = M#3 命名空间细则，§6 层级，§7 drift = M#10/#11，§8 测试。
> 跨模块对外承诺（接口签名、生产/消费方、归本模块加不归本模块、不可消除耦合理由）见 [interfaces/l6.md](../interfaces/l6.md) Assembly 节。
> 模块本质加层归属见 [architecture.md](../architecture.md)。

## 1. 职责（M#1 独立可变职责）

> 本节内容 derive 自 [architecture.md](../architecture.md) §32「Assembly 本质：模块装配根 / L6 进程边界 ——『装配根』」加 M#1 / M#2 / M#3 加 M#5「底层模块不预设上层模块语义」加 Design Principle「事后可审计」。

### 做

应用 M#1（一个模块封装一组独立可变的职责），Assembly 的单一职责 = **模块装配根**：

按装配三段：

**构造期**：
- 按 identity（motion / claw）union type 分支决定启哪些模块（cronRunner / heartbeat 仅 motion 装）
- L1-L2 预制：`systemFs`（enforcePermissions=false）+ `clawFs`（enforcePermissions=true）/ 两者 baseDir=clawDir
- 调各 L1-L5 模块 createX 工厂构造 instances
- 跨模块回调注入（caller 类型 universe → Tools / gitignore content → Snapshot / Skill multi-source dirs → SkillSystem / 执行过程事件回调 / interrupt / Cron handler / TransportErrorEvent fan-out / LLM 业务事件审计 / StatusService status 工具 → Tools 注册等）
- Snapshot 单实例约束（保证唯一 Snapshot 对象 / 同时出现在 Instances.snapshot + RuntimeDependencies.snapshot）

**装后期**：
- 经 RuntimeDependencies 字段一次性注入 Runtime（parentStreamLog + contractNotifyCallback 经字段注入而非 setter 双阶段）
- `acquireLock` 拿 lockfile / 冲突时 audit `assemble_lock_conflict` + 抛 `LockConflictError`
- audit `daemon_started`（clawId + pid）

**关停期**：
- `disassemble(instances, signal)` 反向拓扑调各模块 close/stop
- 任一步抛错 audit `disassemble_step_failed` + 继续下一步（全序继续）
- 末尾 audit `daemon_stop`（signal）/ AuditWriter 不在 disassemble 内 close（TSV 追加写无 close 义务 / 保证 daemon_stop 写入磁盘）

> 具体 API 形态归 [interfaces/l6.md](../interfaces/l6.md) Assembly 节。具体实现细节（assemble / disassemble / Identity union / AssembleConfig / Instances 接口 / LockConflictError 等）的存在依据是「模块装配根」原语 — 实然采纳的细节差异加跨模块回调注入清单加构造顺序拓扑等登记 §7.B。

### 不做

- **不做模块内部初始化**（init() / loadAll() / archive() 等归各模块自身业务语义 / 由 createX 工厂内部完成）— derive 自 M#1 + M#2
- **不做 Runtime 业务动作**（session repair / resumeContractIfPaused 由 Daemon 调 / Assembly 仅装配 / 不参与 runtime）— derive 自 M#1
- **不做错误回滚**（构造途中失败抛错 / 由 Daemon catch + process.exit / OS 回收资源 / 不调 disassemble 回滚）— derive 自 M#1 + M#10
- **不做长期运行 service**（Assembly 是 init-time function / assemble 加 disassemble 调完即结束 / 不持续运行）— derive 自 M#1
- **不做 agent 业务流程**（归 L3-L5 各模块）— derive 自 M#1 + M#5
- **不允许 Instances 字段重新赋值**（readonly + tsc 编译期保证 / Daemon 仅读字段或调字段对象方法）— derive 自 M#7
- **不 own LockConflictError 失败语义本质**（归 L2 ProcessManager / B.4 边界违规登记 / 长期治理 / 当前 Assembly 沿用 PM 抛通用 Error 现状加 re-throw）— derive 自 M#3

## 2. 业务语义（M#2 业务语义归属）

> 应用 M#2（模块为自己的业务语义负责），Assembly 的业务语义边界：

- **own**：「装配 + 拆装」业务语义唯一发起点 — identity 分支 / 跨模块回调注入 / Instances 句柄集构造 / 反向拓扑关停 / Snapshot 单实例约束 / lockfile 冲突识别 / gitignore content 加 caller universe 加权限矩阵组装注入。这些是 Assembly 唯一懂的「业务」（装配根级）。
- **角色定位**：Assembly 是「**装配胶水 + 跨模块回调注入终点**」非「**长期运行 service**」非「**业务模块**」。Assembly 装好 instances + 注入跨模块回调 + 经 RuntimeDependencies 一次性透传 / Daemon 拿 Instances 后驱动 Runtime / 关停时按依赖拓扑反向调各模块 close/stop。
- **业务语义动词集**：
  - 「装配」：`assemble(config)` → `Instances`
  - 「拆装」：`disassemble(instances, signal)` → 反向拓扑关停
- **装配「按需」**（任何 daemon 进程入口需要装配模块图时调用）
- **Snapshot 单实例约束**：唯一 `Snapshot` 对象 / 同时出现在 `Instances.snapshot` + `RuntimeDependencies.snapshot` / 双实例 = `recovery-snapshot` audit 重复 bug
- **identity 分支**：cronRunner / heartbeat 仅 motion 装 / claw 不装 / Instances 字段 readonly + tsc 编译期保证

## 3. 资源（M#3 资源唯一归属）

> 应用 M#3（每种资源只归属唯一模块），Assembly 独占的资源：

| 资源 | 类别 | 持久化 |
|---|---|---|
| 无（Assembly 本身无状态 / 不持磁盘或进程级资源）| 派生态 | ✗ |
| `assemble()` / `disassemble()` 调用期局部引用 | 派生态 / 调用期短生命周期 | ✗ |

**无磁盘资源** — Assembly 是装配胶水 / 持久化归各被装配模块（fs / audit / snapshot / session 等各归其主）。

## 4. 持久化（M#4）

> 应用 M#4（持久化一切信息到磁盘 / 运行时句柄从磁盘信息重建），Assembly 自身的持久化立场：

- **模块零状态**：Assembly 不持自有磁盘 artifact — 装配胶水 / 持久化归各被装配模块（fs / audit / snapshot / session 等各归其主）
- **持久化归下游**：

| 信息 | 归属 | 落盘 |
|---|---|---|
| audit 事件 | AuditWriter（L2）| `audit.tsv` |
| snapshot | Snapshot（L2）| git repo |
| dialog | DialogStore（L2）| `current.json` / archive |
| inbox / outbox | Messaging（L2）| 各 claw inbox/outbox 目录 |
| lockfile | ProcessManager（L2 / 经 acquireLock）| `<dir>/status/pid` |

**重建语义**：进程重启 → Daemon 调 assemble → 各模块按 identity 分支重建实例 / 内部状态从磁盘加载（归各模块）/ Assembly 本身重启归零（运行期派生态 / 调用期短生命周期）。

## 5. 审计事件清单

> 事件常量集中定义于 `src/assembly/audit-events.ts` `ASSEMBLY_AUDIT_EVENTS`（模块自治 / caller const 引用）+ `src/assembly/llm-audit-events.ts` `LLM_AUDIT_EVENTS`（与 caller llm-audit-sink.ts 同目录）。

ASSEMBLY_AUDIT_EVENTS 6 个事件：

| 事件 type | 触发位置 | 载荷 |
|---|---|---|
| `daemon_started` | assemble() 末尾 | `clawId`, `pid` |
| `daemon_stop` | disassemble() 末尾 | `signal` |
| `daemon_unclean_exit` | assemble() 进入时 detectUncleanExit | `last_ts` |
| `assemble_failed` | assemble() 任一构造步骤失败 | `module`, `phase`, `reason` |
| `assemble_lock_conflict` | `processManager.acquireLock` 失败 | `clawId` |
| `disassemble_step_failed` | disassemble() 任一步抛错 | `step`, `reason` |

外加 LLM_AUDIT_EVENTS（模块自治 / 11 个事件）：

| 事件 type | 触发位置 | 载荷 |
|---|---|---|
| `llm_provider_attempt_failed` / `llm_retry_scheduled` / `llm_provider_exhausted` / `llm_fallback_switched` / `llm_breaker_opened` / `llm_breaker_half_open` / `llm_breaker_closed` / `llm_healthcheck_failed` / `llm_stream_reset` / `llm_stream_parse_error` / `llm_idle_failover_triggered` | `src/assembly/llm-audit-sink.ts` 经 LLMEventSink 注入 sink fan-out | LLMOrchestrator 契约 §5 透传 |

> 11 个 LLM_AUDIT_EVENTS 由 Assembly 装配 LLMEventSink 后 fan-out 写 / 物理位置 `src/assembly/llm-audit-events.ts` 与 caller llm-audit-sink.ts 同目录。

**关键约束**：audit 是观察通道 / 不是失败处理通道。assemble 不可预期失败必须抛给 Daemon 决策（process.exit）；disassemble 失败不抛（关停过程已无消费者可决策）/ AuditWriter 不在 disassemble 内 close（TSV 追加写无 close 义务 / 保证 daemon_stop 写入磁盘）。

## 6. 层级声明

L6 进程边界（与 L6 Daemon / L6 Watchdog / L6 CLI 同层 / 「装配模块图」业务语义独立可变 / 装配根角色 / 在所有 L1-L5 之上）。下游 Daemon（L6）通过 `assemble` / `disassemble` 函数式调用。上游 L1-L5 各模块的 createX 工厂 / 不上引 L6+。详见 [architecture.md](../architecture.md) 加 [interfaces/l6.md](../interfaces/l6.md)。

## 7. 应然 vs 实然差距登记（M#10 / M#11）

> 原则：本节只登记**实然 ≠ 应然**的 gap（待治理或已治理的历史）+ 偏差 + 历史纪律。当前实然若与应然 align 则不在此登记。

### 7.A 必修违规（含历史已闭环）

**§7.A 6/6 全清零里程碑**（phase154-158 接力）：

| §A 条 | 类型 | 状态 | 触发情境 |
|---|---|---|---|
| ~~A.1 Assembly 模块不存在~~ | drift | **已闭环（phase154）** | `src/assembly/` 落地 + assemble() / disassemble() 导出 / 装配代码搬出 daemon.ts |
| ~~A.2 Instances 接口不存在~~ | drift | **已闭环（phase154）** | interface Instances readonly 字段集 / tsc 编译期保证 |
| ~~A.3 AsyncTaskSystem setter 注入~~ | drift | **已闭环（phase157）** | constructor 重排 + 4 setter 删除 / 顺序 toolRegistry → skillRegistry → contractManager → outboxWriter → taskSystem |
| ~~A.4 Runtime.initialize() 混合装配与业务~~ | drift | **已闭环（phase156/157）** | 构造搬 Assembly / 业务（session repair）留 Runtime |
| ~~A.5 各模块 createX 工厂缺失~~ | drift | **已闭环（phase155）** | L1-L5 各模块导出 createX(config) 工厂 / Assembly 改调工厂 |
| ~~A.6 周边装配未纳入~~ | drift | **已闭环（phase158）** | createStreamCallbacks + waitForInbox 内 FileWatcher 装配 / watchdog 装配段收拢 Assembly |
| ~~A.retro-trigger-npe-guard `assemble.ts:288 evolutionSystem!.runRetroForContract` cron callback NPE 风险~~ | ~~drift / 中（race window 极窄）~~ | **✅ closed**（phase 620 / main `935956a1`）| **应然**：cron callback closure 跨长生命周期 / motion claw 装配期 evolutionSystem 失败但 contractManager.onContractCompleted 已注册 → contract 完成时 callback fire / evolutionSystem null → NPE / 防御性 guard align phase 607 dream-trigger memorySystem! 模板。**实然漂移**：line 286-289 `contractManager.onContractCompleted(async (contractId) => { await evolutionSystem!.runRetroForContract(contractId, motionReviewContext); });` / 非空断言无 guard / race window 极窄但真存。~~实然偏离~~ → phase 620 修：line 287 加 `if (!evolutionSystem) return;` + 删非空断言（`evolutionSystem!.X` → `evolutionSystem.X`）/ silent return 模式 align phase 607 dream-trigger（production 路径 evolutionSystem 必装配 / 0 audit / race window 极窄）。**「assemble.ts NPE assertion 模板复用」第 N=2 实证**（phase 607 dream-trigger memorySystem! → phase 620 retro-trigger evolutionSystem! / 升格独立 feedback 候选累 N=1 / 推 r76+ ≥ 2 实证升格）。**「dispatch sweep 95% STALE → 1 真修」首发模板**（dispatch ratio bimodal 0%-95% 二极分布扩展 / Meta 38 已立扩 / 与 r71 E fork 0% phantom 模板对照）：r75 dispatch 全栈 grep `[a-zA-Z_]+!\.[a-zA-Z]` 浮 20 site / Path #1 全核四态分类：(VERIFIED tight) 1 真 NPE = 本 row / (STALE × 19) 4 类细分：switch case TS narrow 限制 (step-executor/stream.ts:131 + agent-executor.ts:88) / ternary guard (async-task/dispatch.ts:165 + assemble.ts:165+168+169+172 clawConfig! + orchestrator.ts:192+266+359 hardCtrl!/idleCtrl!) / framework guarantee (gateway.ts:213 transport! + custom-anthropic+openai+gemini.ts response.body! / fetch standard) / runtime invariant (subagent/agent.ts:155 this.signal! + config.ts:259+293+296 fallbacks!) / **0 修 19 STALE sites**（不浪费 src 改面 / TS narrow + framework guarantee + ternary guard + runtime invariant 全 design intent / 推 r76+ TS hygiene 单独评估）。**「装配期资源泄漏 cluster」STALE 推翻**（phase 607 副发现）：phase 607 已实施 outer try-catch + lockAcquired flag + releaseLock cleanup chain (line 652-665) / 其他 partial assembly state 不 cleanup 是 design intent（assemble.ts §1.不做 line 41 明示「不做错误回滚 / Daemon catch + process.exit / OS 回收资源」/ derive M#1 + M#10）/ 0 真 drift。NEW unit test cover guard branch + regression / 0 NEW audit const / mirror phase 607 silent return 模板 |

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| ~~B.1 Instances 接口字段增长（phase154→phase155-157+ 扩展）~~ | ~~design-gap / 设计意图~~ | **⚓ accepted-stable (phase 503 / 28 原则核)** | 非 M#7 违反（M#7 约束「对外表面不随**外部模块**增减传染」/ Assembly Instances 增长是自身 scope 演进非外部传染）/ 每次扩展须同步本契约 §1 加 [interfaces/l6.md](../interfaces/l6.md) Assembly 接口定义 / **未来 Instances 接口形态独立业务决策性 design phase**（DI container reframe）推 r+1+ M#10 触发候选 |
| ~~B.2 recovery-snapshot 失败不抛~~ | ~~design-gap / 显式决策~~ | **⚓ accepted-stable (phase 503 / 28 原则核)** | best-effort 软降级模式 N=4+ 实证（feedback Meta 34）/ D2 失败进 audit 不 silent + D5 log 留痕 / 启动期已有失败累积保护 / recovery 失败不应级联 block daemon 启动 |
| ~~B.3 构造顺序拓扑当前隐式表达（靠代码行顺序）~~ | ~~drift / 中~~ | **✅ closed (2026-05-03 design 重审 / framing 推翻 / 不是 drift)** | **原 framing 错 — 显式 DAG 是 governance work-around**：(1) tsc closure capture 已编译期 enforce dep 顺序（`const a = createA(); const b = createB(a)` / 缺 var 立 `Cannot find name`）/ (2) assemble.ts 30 factory 严格线性 / 0 multi-path / 0 cyclic / 非 DAG 场景 / (3) disassemble 实然只 stop 6 项有 stop method（gateway/cron/runtime/stream/lock/audit）/ 0 反向 cascade 风险 / (4)「出错风险随依赖项增多而上升」是 hypothetical / phase154-158 接力至今 0 顺序错。**真合规 = 当前实然**（行顺序 + tsc closure capture + 6 步显式 disassemble 列）/ 0 governance 需。同 `feedback_governance_workaround_smell` 模式第 8 实证（phase422 WatchdogPort + phase424 TaskLifecyclePort + phase426 RetroScheduler + phase427 VerifierScheduler + phase429 Runtime 11 ports + phase430 PermissionChecker + phase432 TaskScheduler + 本 B.3 显式 DAG）|
| ~~B.4 LockConflictError 是 Assembly 专属类型~~ | ~~drift / 边界违规~~ | **✅ closed phase410**（main `129e8505`）| 治理 = LockConflictError 类物理迁 process-manager + 合并 LockHeldError → LockConflictError（rename / 单一错误类型 / `clawId` 字段保留）+ ProcessManager.acquireLock 直接抛 LockConflictError + Assembly assemble.ts catch + audit + 直接 `throw e`（不 wrap）+ assembly/index.ts re-export（向后兼容）+ daemon.ts import 改 `../foundation/process-manager/index.js` / M#3 align（LockConflictError 资源唯一归属 PM）/ M#5 align（Assembly L6 不 own L2 失败类型）/ 物理迁模板第 N+1 次复用（同 phase303）|
| ~~B.5 phase155B Snapshot 单实例约束~~ | ~~design-gap / 显式~~ | **⚓ accepted-stable (phase 503 / 28 原则核)** | M#3 资源唯一归属（Snapshot 是物理资源 git repo / 单实例约束保 audit 1 条契约 / 重复 new Snapshot = audit `recovery-snapshot` 2 条 bug 风险）/ 防御性设计意图 |
| ~~B.6 phase155B Runtime 精确 audit + Daemon 兜底 audit 幂等共存~~ | ~~design-gap / 显式~~ | **⚓ accepted-stable (phase 503 / 28 原则核)** | D5 冗余 audit 强 align（精确粒度 + 笼统兜底同时存在是设计意图 / 同失败可能写两条 assemble_failed 是 D5「日志重建任一时刻」derive）/ M#8 耦合界面最小（不引入 AssembleFailedError 类避免异常体系扩散超 scope）|
| **B.llm-audit-sink-recursion-boundary llm-audit-sink.ts 内 catch silent** | drift / 低 / r73 C fork phase 604 derive | **closed by phase 604**（main `8508a17f`）| 实然 `src/assembly/llm-audit-sink.ts:60-62` `catch { /* Error isolation: audit failure must not interrupt LLM path */ }` silent / sink 调用 audit.write 抛错时 silent 吞 / dev 失可见性 / 注释 intent 正确（防 LLM path 中断 / recursion 边界 / audit 自身故障路径不能再 audit）/ 但 silent 0 dev 可观察 / 与 phase 586 audit/writer.ts critical fallback `console.error('[AUDIT CRITICAL]')` 模板不一致。**phase 604 决策（28 原则核 5/5+ 一致 dominant 自决）**：α catch 加 `console.error('[LLM AUDIT SINK CRITICAL]', ...)` fallback / silent isolation 仍保（不 throw 防 LLM path 中断）+ dev 可见 / 同 phase 586 [AUDIT CRITICAL] 模板 align / Assembly L6 装配层 console 安全（phase 529 TUI 防污染 anchor 不涉 raw mode 渲染路径）/ 0 NEW const（audit 自身故障 / 不能再 audit 防 recursion）/ β silent 保留违 D2 reject / γ sink 内部错误计数 NEW state 违 M#7+M#8+YAGNI reject。**audit.write 实然 verified**：phase 586 audit writer 已 try/catch 全包 → audit.write 永不抛 → 实然 silent catch 几乎不触发 / 但作为防御性 console.error 加可观察。**同 §A 历史 Audit Critical 模板**：与 l2_audit_log §7.A.1 closed by phase 586 + ⚓ invariant「[AUDIT CRITICAL] console fallback」一致 / 这里是 caller 层（sink）的 mirror 实证 / 候选独立 feedback「audit critical 兜底 console.error 模板 caller 层扩展」推 r+ 升格 |
| ~~assembly audit event 字符串硬编码~~ | ~~drift~~ | **✅ closed phase386**（main `ae9ca839`）| disassemble.ts 3 caller 改 ASSEMBLY_AUDIT_EVENTS.DISASSEMBLE_STEP_FAILED const ref / 字符串值完全等价 / 收尾（assembly 内 caller 风格并轨）|
| ~~daemon_started 归属错配~~ | ~~drift~~ | **✅ closed（phase385 / 同根 cross-ref l6_daemon daemon_started 归属错配 row）** | r42 D fork 发现 / 实由 Assembly assemble.ts:108 发（DAEMON_START）/ 本契约 §5 已显式列 / l6_daemon §5 已 phase385 同步移除 daemon_start 描述 / 双侧应然 align |
| DispatchTool 闭包注册结构性循环依赖（B 类偏差登记）| design-gap / 显式 | 不修 | Runtime initialize 期 DispatchTool 闭包绑（this.buildSystemPrompt / this.toolRegistry.formatForLLM）/ Assembly 构造期 Runtime 尚未 new / register 必须留 Runtime 内 / 实然 runtime.ts:242-254 注释已标「候选 γ：结构性循环依赖妥协」/ phase385 应然 sharpen 同步登记（cross-ref l5_runtime DispatchTool 注册闭包依赖 ✅ closed）/ 升档：若未来 Assembly 重构允许两阶段构造 |

### 7.C 应然原则对照

> 仅列应然对各原则的承诺立场 / 不写「合规✓」claims。

**Module Logic Principles**

- M#1 独立可变职责：装配逻辑（identity 分支 + 跨模块回调注入 + 关停拓扑）vs Daemon 进程生命周期（信号处理 + 主事件循环）= 完全不同关注点 / 合并即违 M#1
- M#2 业务语义归属：「装配 + 拆装」业务语义由本模块发起 / 各模块内部初始化由各模块自身负责
- M#3 资源唯一归属：Assembly 无资源 / 各被装配模块持各自资源 / Snapshot 单实例约束保证唯一性
- M#4 持久化：无 / 装配胶水
- M#5 依赖单向：L6 → L1-L5 / 不反向依赖 / readonly Instances 防 Daemon 反向修改字段引用
- M#6 依赖结构稳定：identity union type 编译期穷尽 / 构造顺序经 tsc closure capture 编译期 enforce（B.3 显式 DAG 是 governance work-around / 2026-05-03 framing 推翻 closed）
- M#7 耦合界面稳定：对外仅 assemble + disassemble 两动作 / Instances 字段增长非 M#7 违反（B.1 自身 scope 演进）
- M#8 耦合界面最小：Daemon 仅消费 Instances readonly 字段 + 调方法 / 不见装配内部
- M#9 显式编译器可检：identity union + readonly Instances 字段 / assembly audit event caller 字符串硬编码 ✅ closed phase386
- M#10 不合理停下：phase155 6 phase 接力 / phase328 audit-sink 物理迁 / ~~phase335 13 port 注入化~~ ✅ **phase 429 反向收**（`62e10d55`）/ ~~phase340 verifier port 立~~ ✅ phase 427 反向收（`8458bfa0`）/ 各 phase 都遵循「停下重构」纪律（port pattern cluster 7 全闭环 2026-05-03 完成 / 详 feedback_governance_workaround_smell §5）
- M#11 边界对不上停下：A.1-A.6 显式登记 + 接力清零 / B.3 顺序拓扑 framing 推翻 closed（不强行 mechanical）

**Design Principles**

- D1 信息不丢失 / 可观察 / 可恢复 / 可审计：6+11 events 全覆盖 + Runtime 精确 audit + Daemon 兜底 audit 幂等共存（B.6）
- D2 不丢弃 / 静默：assemble 失败 + recovery 失败 + lockfile 冲突 + disassemble 失败 全 audit 留痕
- D3 用户可观察：audit.tsv 全链路覆盖 / `daemon_started` / `daemon_stop` / `assemble_failed` 经 `clawforum status` 可读
- D4 中断恢复：disassemble 反向拓扑 + 全序继续 / Daemon 信号处理保证关停最末写 daemon_stop
- D5 日志重建：每个装配步骤 audit + module + phase + reason 三字段 / 故障复盘可重建 assemble 链路
- D6 子代理后不阻塞：Assembly 是同步装配 / 业务异步归各模块（AsyncTaskSystem 等）
- D7 系统可信路径：受信注入 deps / 非 caller 持有引用决定权
- D8 事件驱动：事件由 Daemon 调 assemble / 不轮询
- D9 CLI 唯一对外：Assembly 不与外部交互 / 由 Daemon 经 CLI 触发
- D10 多 claw 不隔绝：identity 分支区分 motion / claw / 装配差异在 Assembly 内集中
- D11 motion 特殊：cronRunner / heartbeat 仅 motion 装 / identity 分支显式

**Philosophy**

- P3 分多个智能体加分子任务：identity 分支装配 motion + claw 不同 instances
- P4 系统为智能体服务：提供「装配 + 拆装」基础设施

**Path Principles（7 条）**

- **Path #1 路径规划基于规划时刻的事实**：phase154-158 接力清零 / phase328 物理迁 / phase335 注入化 / phase340 port 立 / 各 phase Path #1 核（治理动作要 grep 实然代码佐证）
- **Path #2 实然和应然差距显式登记**：违规明文上墙（在路径规划时参考 / §7.A + §7.B）
- **Path #3 语义原子变更单元**：每 phase 单一 scope（A.1-A.6 各自独立 / 不混合）/ 1 phase = 1 commit 原子
- **Path #4 可回滚 + 破坏性论证**：API 改动 caller 评估 / 破坏性改动显式论证（反向测试：本模块可独立替换 identity 配置而不动 Runtime —— M#1 ✓）
- **Path #5 完成后复盘**：phase 收尾三维 + Path Principles 第 4 维对账
- **Path #6 冲突立即中断**：r42 D 结构合规复盘 / 发现 8 节模板 vs 实然结构脱节 / 停下补完（冲突调整优先于强行推进）
- **Path #7 总难度路径**：实然到达应然有诸多路径 / 选择降低总难度的（步骤间有相互作用 / 总难度 ≠ 各步骤成本简单相加）

### 7.D 历史纪律

- 2026-03 / phase154 A.1+A.2 清零（Assembly 模块落地 + Instances 接口）
- 2026-03 / phase155 A.5 清零（L1-L5 各模块 createX 工厂 + RuntimeDependencies 16 字段定义）
- 2026-03 / phase155B Snapshot 单实例约束 + Runtime 精确 audit + Daemon 兜底 audit 设计决策
- 2026-03 / phase156+phase157 A.3+A.4 清零（Runtime.initialize 装配 vs 业务拆分 + AsyncTaskSystem setter 删 + constructor 重排）
- 2026-03 / phase158 A.6 清零（周边装配收拢）
- 2026-04-21 / phase182 setter 双阶段升级（装配期 setter 双阶段注入 / Runtime 公共接口 -2 setter / 改 RuntimeDependencies 字段注入）
- 2026-04-26 / phase328 LLMService（pre-split / r61+ 现 L1 LLMProvider）L1→L2 audit-sink 物理迁移（`src/assembly/llm-audit-sink.ts`）
- 2026-04-26 / phase335 H7+H8 13 port 注入化（Runtime DispatchTool 物理迁）⚠ STALE 推翻 → ✅ **phase 429 全清**（`62e10d55` / 删整 runtime-ports.ts 11 余 ports + phase 424 删 TaskLifecyclePort + DispatchTool 同期 / 累 13 全反向 / Runtime 直 dep concrete L1-L5 模块）/ feedback_governance_workaround_smell §5 cluster 7 全闭环 Runtime 11 余 ports 行
- 2026-04-27 / phase336+phase338 H1 audit-events.ts 模块自治拆分（LLM_AUDIT_EVENTS 物理迁 `src/assembly/llm-audit-events.ts`）
- 2026-04-27 / phase340 ContractVerifierScheduler port 注入（H6+H11）⚠ STALE 2026-05-03 推翻：同层单向 over-engineering / ContractSystem 直 dep AsyncTaskSystem 完全合 M#5 / 详 feedback_governance_workaround_smell / **✅ closed by phase 427**（main `8458bfa0`）/ DELETE 整 verifier-scheduler.ts 112 行 + inline `_runVerifierSubagent` 私有 method 回 ContractManager / cluster 第 4 例闭
- 2026-04-27 / phase344 types/contract.ts 按语义域拆 3 文件
- 2026-04-27 / r42 D 结构合规复盘（§7→§8 编号修订 + Path 6 待补）
- 2026-05-03 / phase410 B.4 LockConflictError 归 PM 闭环（main `129e8505`）/ 物理迁 LockConflictError → process-manager + 合并 LockHeldError → LockConflictError + Assembly 不 wrap re-throw + daemon.ts import path 改 / 同 phase 与 l5_runtime _hasHighPriorityInbox port 治理 / 模块边界重构阶段第 2 phase
- 2026-05-03 / B.3 显式 DAG 装配 framing 推翻 closed（design 重审 / 0 代码 / 实测核 tsc closure capture 已编译期 enforce dep 顺序 + 30 factory 严格线性非 DAG + disassemble 显式 6 步 0 cascade / 真合规 = 当前实然 / 0 governance 需）/ `feedback_governance_workaround_smell` 模式第 8 实证（同 phase422-432 7 cluster + 本 B.3）
- 2026-05-04 / **phase 454 Runtime → Assembly cross-layer-up 治理**（`638e6b37`）/ Assembly 自身 0 改（ASSEMBLY_AUDIT_EVENTS 9 events 保 / 仅 Assembly 内部用）/ Runtime 端删 import + 改用 RUNTIME_AUDIT_EVENTS 自 own + last-exit-summary 改字符串字面量跨进程匹配 / **Assembly 模块对外 audit event 命名空间纯净化**（仅 Assembly 自身写 ASSEMBLE_FAILED 等 / 不再有 L5 caller 借用）/ `feedback_governance_workaround_smell §1 cross-layer-up 必反向消除` 实证累 N+1
- r60+ 重编号：9 节 → 8 节 / 每节 derive 自一条 Module Logic Principle（删原 §1 所有权 hub / §2 接口 / §5 上游依赖 / §6 不可消除耦合 → 已并入 interfaces/l6.md / 拆原 §1 为 §1 职责 + §2 业务语义 + §3 资源 + §4 持久化）
- 2026-05-05 / r65 cross-doc audit 单 doc 一致性核（modules/l6_assembly.md vs arch §32 + 表 1/2 + interfaces/l6.md Assembly 节）/ 0 derive drift / 主 derive 全 align（M#1-M#9 + Design Principle 事后可审计）/ 修 SHA placeholder `<MERGE_SHA>` → `ae9ca839` + 补 phase340 entry ✅ closed by phase427 标 + 升 §7.E port pattern KD ⚠ STALE → ✅ closed by cluster 6/6（phase422-430 全闭环 / 累 ~270 行 net delete）/ design only / 0 src 改
- 2026-05-09 / **phase 605 hygiene cluster B（D fork r73 / main `ca317315` / merge `ac5539e8` / 起步 SHA `e9c75832`）**（code phase / 主会话 plan + 用户 code）/ r72 F fork 视野再上移 fan-out 7 hygiene candidate Path #1 实测：4 VERIFIED + 1 reframe + 1 STALE 推翻 + 1 design only / **dispatch stale ratio 14% (1/7)** 与 r71 E fork 0% 模板靠近 / 5 真修 site：(C1) status.ts 抽 inline helper `findOrphanProcesses(pm, entryPath, excludePids)` + 2 caller cascade（DRY 双 try/catch ProcessListUnavailable handling）/ (C3) claw.ts barrel 注释 sharpen（claw-shared.ts 标记 helper / 非 command）/ (C4) contract.ts notifyContractCreated audit 加 `contractId` 字段（observability sharpen）/ (C5) assemble.ts inline arrow `makeDialogStore(systemPrompt)` + line 351 + 438-440 cascade（**reframe** dispatch Partial factory framing → phase 489 极保守整理性 inline arrow 模板 / dispatch 标 4 次实测 2 次 数字 stale）/ (C6) assemble.ts:95 console.warn → `auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, module=detect_unclean_exit, phase=detect, reason=...)` align line 89 pattern / 0 NEW audit const（复用 ASSEMBLE_FAILED + module/phase/reason 字段 mirror phase 541）/ STALE 推翻：C2 claw-health.ts unused systemAudit phantom（line 65 真用 getLastActiveMs caller）/ design only：C7 runtime.getTaskSystem 跨层注释 sharpen 推 §B row 不入 src（装配方 reach Runtime 已有 instance 是合理 M#5/M#7 align / 不立 row）/ NEW unit tests cover 4 真修 site / 反向 3/3 PASS / **「dispatch 数字 stale → Path #1 实测 reframe」首发模板**（dispatch 标 4 次 → 实测 2 次 / 升格独立 feedback 候选累 N=1）/ **「同文件 inline helper 抽 vs Partial factory over-engineering」判据 refine**（phase 461 inline 反例 + 489 极保守 + 605 inline arrow 模板成熟）/ **「dispatch site naming/scope must derive from module layer」第 N=4 实证累**（phase 563+581+592+605）/ shared helper 抽 cluster N=7 实证累 / micro-hygiene cluster N=33+ 实证扩 / **「review claim 实测四态分类」第 8 phase 实证**（556+563+567+581+587+592+598+605 / Meta 40 升格阈值过线）
- 2026-05-10 / **phase 620 NPE cluster sweep + retro-trigger guard（D fork r75 / main `935956a1` / 起步 SHA `dfc593ce`）**（code phase / 主会话 plan + 用户 code）/ r73 phase 607 副发现「假装非空断言 instance!.method() 类 NPE cluster」首发兑现 + 「装配期资源泄漏 cluster」首发兑现 / dispatch 全栈 grep `[a-zA-Z_]+!\.[a-zA-Z]` 浮 20 site / **dispatch stale ratio 95% (19/20)** 与 r71 E fork 0% 模板对照另一极端 / **dispatch ratio bimodal 0%-95% 二极分布持续**（Meta 38 已立扩）/ Path #1 全核四态分类：(VERIFIED tight) 1 真 NPE = `assemble.ts:288 evolutionSystem!.runRetroForContract` cron callback / (STALE × 19) 4 类：switch case TS narrow 限制 + ternary guard + framework guarantee + runtime invariant / **装配期资源泄漏 cluster 完全 STALE 推翻**（phase 607 lockfile 已闭 + 其他 partial state 不 cleanup 是 design intent / assemble.ts §1.不做 line 41 明示 M#1+M#10）/ 实施 1 site：line 287 加 `if (!evolutionSystem) return;` + 删非空断言（`evolutionSystem!.X` → `evolutionSystem.X`）/ silent return mirror phase 607 dream-trigger memorySystem! 模板 / 0 NEW audit const / NEW unit test cover guard branch + regression / 反向 3/3 PASS（含 grep sweep 完整性反向监控）/ §A.retro-trigger-npe-guard closed by phase 620 / **「assemble.ts NPE assertion 模板复用」第 N=2 实证累**（phase 607 dream-trigger + phase 620 retro-trigger / 升格独立 feedback 候选累 N=1 / 推 r76+ ≥ 2 实证升格）/ **「dispatch sweep 95% STALE → 1 真修」首发模板**（dispatch ratio bimodal 0%-95% 二极分布扩展 / 升格独立 feedback 候选累 N=1）/ **「装配期资源泄漏 cluster STALE 推翻 / design intent vs drift 区分」首发模板**（升格独立 feedback 候选「sweep 副发现 cluster 必 Path #1 实测 design intent vs drift 区分」）/ **「review claim 实测四态分类」第 10 phase 实证**（556+563+567+581+587+592+598+605+612+620 / Meta 41 升格阈值过线）
- 2026-05-09 / **phase 607 assembly P0 双修（B fork r73 / lockfile + dream-trigger NPE）**（main `f4581dff`）/ r72 F fork sub-2 双 P0 落地 / 主会话 spot-check 已 verify / **γ dominant 自决（28 原则核 6/6）**：(F-r72-asm-P0-1) `assemble.ts:135-140` acquireLock 装配失败不释放 → outer try-catch 包整段装配 line 142-620 + lockAcquired flag + cleanup chain releaseLock + inner try-catch audit fail-soft + rethrow 原 cause / α Daemon 双层 2/6 + β isLocked check 2/6 + γ Assembly try-catch 包整段 6/6 dominant（M#1 Assembly 拿锁=放 + M#7 0 接口改 + M#8 内自洽 + M#11 显式 cleanup）/ (F-r72-asm-P0-2) `assemble.ts:587-593` dream-trigger handler `memorySystem!` 非空断言无守卫 → 1 行 `if (!memorySystem) return;` + 删双非空断言 / 部署期非 motion claw 误开 dream_trigger.enabled=true 防 NPE / **0 NEW audit const**（复用 ASSEMBLE_FAILED + LOCK_RELEASED）/ 2 NEW tests / Path #1 dispatch 4/4 真 / **「既有 const/callback 复用 / 0 NEW interface field」纪律 N=4 实证累**（phase 578 + 590 + 596 + 607 / Meta 41 加成 / 升格独立 feedback 阈值持续硬化）/ **「F fork ratify → r+1 code phase 落地」首发实证**（G fork ratify 模板扩 F / `feedback_g_fork_ratify_next_round_code` cluster N+1）/ **「业务决策性 phase 但 28 原则核 6/6 dominant 自决」第 N 实证**（不入 G fork / SOP 持续）/ §A.acquire-lock-cleanup + §A.dream-trigger-npe-guard 双 closed by phase 607 / 副发现：「假装非空断言 instance!.method() 类 NPE cluster」首发（推 r74+ sweep cron handler / event handler / callback）+「装配期资源泄漏 cluster」首发（推 r74+ partial assembly failure cleanup pattern）
- 2026-05-10 / **phase 643 assemble.ts 拆 r78 复评（E fork r78 / design only / 0 src 改 / 起步 SHA `f6bb0827`）**（design phase / 主会话 own）/ phase 630 §2.4 medium-low ROI（接口面爆炸）+ phase 619 + 620 后小幅增 / r78 实测 679 行（同 phase 630）/ Path #1 结构核：detectUncleanExit (~36) + assemble() **~565 行单一函数**（line 105-670）+ formatNotifyData (~6) + errMsg (~3) / 0 class field / assemble() 函数体内 ≥ 10+ 局部 var 跨 step 共享（fs / clawDir / globalConfig / auditWriter / providers / contractManager / runtime / cronRunner / watchdog / dialogStore / + 子 instance）/ ROI 3 判据 1/3（var 共享变种）/ **3 拆形态深核**：(α) 抽 phase helper（assemble-llm-config + assemble-runtime + assemble-cron + assemble-watchdog）→ 每 helper signature ≥ 7-10 param / **接口面比 body 还重** / 违 M#7 + M#8 + YAGNI / phase 630 §2.4 + r78 双复评一致 ROI 反向 / (β) 改造为 AssemblyContext class with field（Builder pattern）→ 装配单次执行引入 class state 用于 1 次操作 = YAGNI 反例 / over-engineering / (**γ 不拆 推荐**) phase 630 + r78 复评一致 / 接口面爆炸风险不可缓解 / **推荐 γ 不拆 / 推 r79+ 重评估**（如未来 assemble 增至 ≥ 1000 行 + 装配 step 边界更稳定 + 局部 var ≤ 5 后再评估）/ 0 code phase 落地 / **「saturate-tier 大文件持续 ROI 反向 → 推后稳态」第 N=2 实证累**（与 orchestrator.ts 同 phase 643 双实证 / 升格阈值过线候选 N=2）
- 2026-05-10 / **r86 D fork assemble.ts 拆 r86 复评（design only / 0 src / 0 phase 号 / 起步 SHA `6997cf57`）**（design phase / 主会话 own）/ phase 643 r79+ followup proposals 阈值复核 / r86 实测 676 行（-3 微减 vs phase 643 的 679）/ assemble() ~563 行 / 10 局部 var / r79+ followup 阈值 0/3 达成（行数≥1000 ❌ / 局部 var≤5 ❌ / step 边界稳定 ❌）/ ROI 3 判据复核同 phase 643（1/3 命中 / 拆形态 ROI 反向 0% 改善）/ **用户 ratify γ 不拆**（per `feedback_business_decision_phase_user_ratify`）/ 0 code phase 落地 / 推 r87+ 持续监测（触发条件：assemble ≥ 1000 行 OR 局部 var ≤ 5 OR 装配 step 边界稳定）/ **「saturate-tier 大文件跨 r 持续 ROI 反向 → 推后稳态」跨 r 复评 N=2 实证累**（phase 643 首发 + r86-D 复评 = 同 file 跨 r 模板成熟 / 推 r87+ 升格独立 feedback）/ **与 dispatch_whole_fork_scope_stale_reframe 互补**（dispatch STALE→reframe N=5 vs saturate-tier 跨 r 复评→推后稳态 N=2 = dispatch 起草纪律双向 SOP）

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| KD#15 | Assembly 独立成 L6 | ✓ phase154 落地 |
| KD#23 | 装配职责三分（Assembly + Daemon + Runtime）| ✓ phase156-158 接力实施 |
| KD#25 | Runtime 不自建 L1-L2 / 经 RuntimeDependencies 注入 | ✓ phase155B 落地 |
| KD#28 | LLM audit-sink 装配层 fan-out（phase328 物理迁 / r61+ pre-split LLMService → L1 LLMProvider + L2 LLMOrchestrator）| ✓ phase328 物理迁 |
| KD（待编号）| port pattern 三 phase 实证（phase337+335+340）| **✅ closed by cluster 6/6 全闭环**（2026-05-03 完成）/ 5 实例真用 M#5 + M#1 + M#2 核 = 5/5 design debt 已闭：phase 422 WatchdogPort + phase 424 TaskLifecyclePort + phase 426 RetroScheduler + phase 427 ContractVerifierScheduler + phase 429 Runtime 11 ports + phase 430 PermissionChecker / 累 ~270 行 net delete / 详 feedback_governance_workaround_smell + project_phase427_429_port_cluster_close |

## 8. 测试覆盖

应然行为（不绑定具体测试文件路径）：

- **assemble 成功路径**：所有模块构造 + 跨模块回调注入 + acquireLock + daemon_started audit
- **identity 分支**：motion 装 cronRunner + heartbeat / claw 不装 / Instances 字段 readonly + 编译期保证
- **lockfile 冲突**：assemble_lock_conflict audit + LockConflictError 抛
- **某模块构造失败**：assemble_failed（module + phase + reason）+ Error(cause) 抛 + Daemon process.exit
- **snapshot 失败二分**：init 失败抛 / recovery-commit 失败不抛（B.2 显式决策）
- **runtime.initialize 后置失败**：assemble_failed（module='runtime', phase='post_assemble_init'）+ Daemon 兜底
- **Snapshot 单实例**：双视角共享同一对象 / 重复 new = recovery-snapshot audit 重复 bug 防御测试
- **Runtime 精确 audit + Daemon 兜底 audit 幂等共存**：同一失败两条 assemble_failed 不重复触发关键路径
- **disassemble 全序继续**：某步抛错 disassemble_step_failed audit + 继续下一步
- **disassemble 末尾**：daemon_stop 写入磁盘（AuditWriter 不 close）
- **identity 分支穷尽**：tsc 保证 union type 不漏分支
- **审计回链**：6 ASSEMBLY_* + 11 LLM_AUDIT_EVENTS 全覆盖（phase386 const 引用合规）
- **detectUncleanExit**：daemon_unclean_exit audit + 不影响 assemble 继续
