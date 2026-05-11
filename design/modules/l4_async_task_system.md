# AsyncTaskSystem 模块内部契约

> 本文档限本模块**内部**应然 — 8 节结构 derive 自 Module Logic Principles：§1-§4 = M#1-#4 各占一节，§5 审计 = M#3 命名空间细则，§6 层级，§7 drift = M#10/#11，§8 测试。+ §10 工具通道（仅 own agent 工具的模块；5 维度承诺 derive 自 architecture.md 表 3）。
> 跨模块对外承诺（接口签名、生产/消费方、归本模块加不归本模块、不可消除耦合理由）见 [interfaces/l4.md](../interfaces/l4.md) AsyncTaskSystem 节。
> 模块本质加层归属见 [architecture.md](../architecture.md)。

## 1. 职责（M#1 独立可变职责）

> 本节内容 derive 自 [architecture.md](../architecture.md) §21「AsyncTaskSystem 本质：基于目录队列的通用异步任务调度服务 / L4 agent 基础设施 ——『任务调度』」加 M#1 / M#2 / M#3 / M#5 / Design Principle「磁盘即权威」加「中断可恢复」。

### 做

应用 M#1（一个模块封装一组独立可变的职责），AsyncTaskSystem 的单一职责 = **通用异步任务调度 + 崩溃恢复 + 结果持久化回传**：

- **通用 task queue**：不绑死单一 task type / 派发到对应 task type 的 executor / 实然 subagent + tool 双 type 单轨调度（phase432 后两类任务都经 fs `tasks/queues/pending/` + watcher → `_ingestPendingFile` → 统一 `pendingQueue` 内存调度）
- **fs-driven 调度**：外部调用方直写 `tasks/queues/pending/` / AsyncTaskSystem 内 FileWatcher 订阅 pending/ 拾起 → 状态机流转 → 派发对应 executor → 回传父 claw
- **崩溃恢复语义**：`result.txt.sent` marker = 幂等边界 / 标记过 = 完结转 done / 缺标记 = 真崩溃转 failed
- **生命周期分离**：initialize 仅复原 / startDispatch 才驱动调度循环（phase163 强化纪律 / 避免 Runtime startDispatch 前任务启动）
- **PENDING_QUEUE_MAX = 1000 同步守卫**：队列满抛同步错 / 调用方负责捕获
- **per-task 子审计**：每任务独立 `taskAuditWriter = AuditWriter(fs, 'tasks/queues/results/${task.id}/audit.tsv')` 记 SubAgent 内部事件 / 主 auditWriter 只记任务级（scheduled / started / completed）/ 双层归属清晰
- **OS 资源访问权限继承**（per Design Principle「智能体创建的临时子代理完全继承调用方的OS资源访问权限」/ 2026-05-07 加 / 2 轮 src 实测核 align）：本模块 subagent-executor 实然是**所有走 writePendingSubagentTaskFile 子代理调度的统一执行点**（含 spawn/dispatch 智能体工具触发 + retro 经 EvolutionSystem + random_dream 经 MemorySystem 系统调度）/ 不区分 caller 类型。机制：(1) `registry.getForProfile('subagent')` 派生 per-task registry (subagent-executor.ts:71-78) / **Tool instances module-level const 同源 reuse**（FileTool 6 工具 + CommandTool exec 全 module-level const / 不是 closure 复制）(2) caller.clawDir → SubAgent ctor → ToolExecutor ctor → ExecContext.clawDir 透传 (3) tool 执行时 `getChecker(ctx.clawDir)` 查 module-level Map cache 拿同 PermissionChecker / sandbox 形状由 `claw-permissions.ts` hardcoded SYSTEM_PATHS+WRITABLE_PATHS derive（非 caller 配置 list）→ OS 边界 100% 隐式 align / 非「字段透传」机制 / 0 drift。例外：ContractSystem.verifier-job 不走本模块（直 `createSubAgent` + `createToolRegistry()` empty + reportTool only / 0 OS 工具 / 不存在继承语义）/ 不违此原则。**应然 silent on caller 局部更窄 sandbox**：实然 sandbox 形状是 module-level hardcoded const / 不可 caller 配置 / 未来需要更窄 sandbox 是 `claw-permissions.ts` 模块改造或 PermissionChecker factory 接受额外配置参 / 不是 ExecContext 加 override 字段也不是 SubAgentTask schema 加字段（per Path #1 实测核 / 之前预留方向 stale）。

> 具体 API 形态归 [interfaces/l4.md](../interfaces/l4.md) AsyncTaskSystem 节。具体实现细节（scheduleSubAgent / writePendingSubagentTaskFile helper / writePendingToolTaskFile helper / cancel / shutdown / queueLength 等）的存在依据是「目录队列 + fs-driven + 崩溃恢复」原语 — 实然采纳的 method 集合差异加内部 4 子模块拆分（phase341 task-recovery / subagent-executor / tool-executor / result-delivery）等登记 §7.B。phase432 后 scheduleTool callback API 删 / ToolTask 路径改 caller 直 `writePendingToolTaskFile` 统一 fs-driven。

### 不做

- **不解析具体 task type 业务语义**（透传 task payload 给对应 executor）— derive 自 M#1 + M#2
- **不直接调 LLM**（LLM 调用归各 task type 的 executor 内部）— derive 自 M#1
- **不维护 agent 间协作协议**（dispatcher / spawn 等工具语义归各 tool 实现）— derive 自 M#1 + M#2
- **不跨模块直接写 inbox / outbox 语义**（通过 OutboxWriter 接口回调）— derive 自 M#5
- **不做任务优先级 / 配额 / 资源争用仲裁**（pendingQueue FIFO + maxConcurrent 硬限）— derive 自 M#1
- **不 own agent 执行循环**（归 L3 AgentExecutor / 透过 SubAgent 内部链）— derive 自 M#1
- **不 own 子代理实例化加生命周期管理**（单 sub-agent 启动加跑加超时加 abort 响应加 parentContext inherit 归 L3 SubAgent；本模块 own 跨实例调度业务，含决定 parentContext 内容、result 投递、cascade abort、crash recovery）— derive 自 M#1 + M#2
- **不 own 系统级长期循环**（motion 加 claw 主代理事件循环归 L5 Runtime）— derive 自 M#1
- **不 own 同步工具调用调度**（归 L2 Tools router）— derive 自 M#1

## 2. 业务语义（M#2 业务语义归属）

> 应用 M#2（模块为自己的业务语义负责），AsyncTaskSystem 的业务语义边界：

- **own**：通用任务调度 + 崩溃恢复 + 结果回传 概念。是 L4 业务唯一入口（phase432 后 subagent + tool 任务都经 fs `tasks/queues/pending/` 统一调度路径 / 历史「内存路径异步 tool」双轨已收敛）。
- **角色定位**：AsyncTaskSystem 是「**通用任务调度业务流程框架**」非「**单一 task type 执行器**」。本模块对所有 task type 等价处理 / 业务语义归各 executor。
- **生命周期触发归 Runtime**（initialize / startDispatch / shutdown）/ 业务实现归本模块（与 Gateway 同模式）。

## 3. 资源（M#3 资源唯一归属）

> 应用 M#3（每种资源只归属唯一模块），AsyncTaskSystem 独占的资源：

| 资源 | 类别 | 持久化 |
|---|---|---|
| `tasks/queues/pending/<id>.json` | 持久化目录（独占）| ✓ |
| `tasks/queues/running/<id>.json` | 持久化目录（独占）| ✓ |
| `tasks/queues/done/<id>.json` | 持久化目录（独占）| ✓ |
| `tasks/queues/failed/<id>.json` | 持久化目录（独占）| ✓ |
| `tasks/queues/results/<id>/result.txt` + `.sent` marker + `audit.tsv` + 4 lifecycle 文件（stream/steps/messages/daemon.log）| 持久化（独占 / 子代理不可见）| ✓ |
| pendingQueue / running map / handlers / pendingWatcher | 派生态 | ✗ |

> **不含 `tasks/sync/`**：装配级共享 scratch（exec/write 子目录）+ sync caller subagent lifecycle（spawn 子目录）/ 由装配方 own lifecycle / 与 AsyncTaskSystem 业务无关。
> **不含 `tasks/subagents/<task-id>/`**：subagent 临时工作区 / 由 Assembly 装配 workspaceDir / 子代理 cwd / 不归本模块 own。
> `tasks/` 物理父目录是约定 / 非单一模块 own 资源（M#3 资源唯一归属指**业务资源**单源 / 非物理路径独占）/ 本模块 own `tasks/queues/` 全子树。

> 注：常量 `PENDING_QUEUE_MAX = 1000` 集中 `src/core/async-task-system/constants.ts`（实施细节归 §1.做 私有同步守卫 / 非 M#3 业务资源）。

## 4. 持久化（M#4）

> 应用 M#4（持久化一切信息到磁盘 / 运行时句柄从磁盘信息重建），AsyncTaskSystem 的持久化立场：tasks/queues/* 五目录磁盘是权威 / pendingQueue + running map 是运行期派生态 / 重启时 initialize 扫 queues/running/ 恢复 / startDispatch 内 _initialScanPending 重启 queues/pending/。

### 磁盘布局（phase 507 应然 / phase 510-511 实施）

```
tasks/
└── queues/
    ├── pending/<id>.json          ← 外部直写入口（fs-driven）/ FileWatcher 订阅
    ├── running/<id>.json          ← 拾起后转入 / shutdown / 崩溃后 recovery 扫
    ├── done/<id>.json             ← 完结 / result.txt.sent marker 存在
    ├── failed/<id>.json           ← 失败 / 三分决策不可恢复
    └── results/<id>/              ← async subagent lifecycle（子代理不可见）
        ├── result.txt             ← 大结果 offload
        ├── result.txt.sent        ← 已通过 outbox 回传 marker（幂等边界）
        ├── audit.tsv              ← per-task 子 audit / SubAgent 内部事件
        ├── stream.jsonl           ← turn_*/llm_*/tool_result delta
        ├── steps.jsonl            ← onStepComplete 步数轨迹
        ├── messages.json          ← DialogStore 持久化
        └── daemon.log             ← raw text execution narrative
```

> 注 1：sync 路径子代理 lifecycle 落 `tasks/sync/spawn/<agentId>/`（不归本模块 / 由 sync caller 装配 resultDir）/ 应然 separation 见 [l3_subagent.md](l3_subagent.md) §A.invariant-3。
> 注 2：subagent 临时工作区 `tasks/subagents/<task-id>/` 由 Assembly 装配 workspaceDir 注入（不归本模块）。
> 注 3：phase 510 已落地 / 实然 align 应然（`tasks/queues/{pending,running,done,failed}/<id>.json` + `tasks/queues/results/<id>/`）。

### 文件格式

- `<id>.json`：SubAgentTask 或 ToolTask 序列化 schema（含 intent / parentClawId / payload / mainContextMarker 等）
- `result.txt`：大结果 offload（subagent final output / tool result）
- `result.txt.sent`：已 outbox 回传 marker（空文件 / 0 byte / 幂等边界）
- `audit.tsv`：per-task 子审计 / 行级 audit 事件 / SubAgent 内部 LLM call 等记录

### 重建语义

`initialize()` 扫 `tasks/queues/running/`：
- `result.txt.sent` 存在 → 转 done（幂等）
- marker 缺 + SubAgent 未报错 → 转 failed（崩溃未完成）
- `tasks/queues/pending/` 既有文件保留原地 / `startDispatch()._initialScanPending()` 逐文件 ingest

符合 D1c「中断即从最后一次完整 LLM 调用恢复」+ D5「日志重建决策链路」（phase248 后 recovery 路径全 audit）。

## 5. 审计事件清单

事件常量**应然**集中定义于 `src/core/async-task-system/audit-events.ts` `TASK_AUDIT_EVENTS`（模块自治 / phase338 H1 拆分 / phase 508 dir rename / caller 引用 const 不硬编码字符串）。

19 个 TASK_* 事件（phase248 +12 扩展 / phase267 +SHUTDOWN_TIMEOUT / phase341 unchanged / phase385 计数权威修订 16 → 19）：

| 事件 type | 触发时机 | 关键载荷 |
|---|---|---|
| `task_scheduled` | scheduleSubAgent / scheduleTool / writePendingSubagentTaskFile | `taskId`, `kind=subagent\|tool`, `parent=<clawId>`, `tool=<name>` |
| `task_started` | movePendingToRunning 成功后 | `taskId` |
| `task_completed` | executeTask / executeToolTask 成功 / 失败 | `task.id`, `ok\|err`, `ms=<elapsed>` |
| `pending_ingest_failed` | _ingestPendingFile catch | `taskId` / `<unknown>`, `path=<filePath>`, `reason=<err>` |
| `task_pending_watcher_failed` | FileWatcher onError context='watch' | `path`, `reason` |
| `task_pending_watcher_callback_failed` | FileWatcher onError context='callback' | `path`, `type`, `reason` |
| `task_discarded` | recoverTasks 三分决策为「未知 / 不可恢复」 | `taskId`, `reason` |
| `task_recovered` | recoverTasks 转回 pending / done / failed | `taskId`, `from`, `to` |
| `task_recovery_complete` | recoverTasks 末尾 | `count` |
| `task_recovery_failed` | recoverTasks 自身 catch | `error` |
| `task_start_failed` | movePendingToRunning 失败 | `taskId`, `error` |
| `task_stream_failed` | parentStreamLog 写失败 | `taskId`, `error` |
| `task_handler_failed` | resultHandler callback throw | `taskId`, `error` |
| `task_result_write_failed` | tasks/queues/results/<id>/result.txt 写失败 | `taskId`, `error` |
| `task_inbox_write_failed` | OutboxWriter enqueue 失败（β 双写）| `taskId`, `error` |
| `task_shutdown_timeout` | 30s in-flight 超时（β 双写 audit + console.warn）| `taskId?` |
| `task_move_failed` | running→done / failed 文件移动失败 | `taskId`, `error` |
| `task_cancelled` | cancel 路径 | `taskId` |
| `tool_task_retry` | executeToolTask 重试 | `taskId`, `attempt` |

## 6. 层级声明

L4 agent 业务流程层（与 ContractSystem / EvolutionSystem / MemorySystem 同层 / 业务语义独立可变 / 跨进程异步任务调度）。下游 Runtime（L5）通过 `createAsyncTaskSystem` 工厂消费 + 注入 deps + 持有生命周期协调权。详见 [architecture.md](../architecture.md) 加 [interfaces/l4.md](../interfaces/l4.md)。

## 7. 应然 vs 实然差距登记（M#10 / M#11）

> 原则：本节只登记**实然 ≠ 应然**的 gap（待治理或已治理的历史）+ 偏差 + 历史纪律。当前实然若与应然 align 则不在此登记。

### 7.A 必修违规（含历史已闭环）

**§7.A 4/4 全清零里程碑（phase273）**：

| §A 条 | 类型 | 状态 | 触发情境 |
|---|---|---|---|
| ~~A.1 recoverTasks 静默 + 全部 monitor.log 44 处~~ | drift | **已闭环（phase248 / SHA `4d3ef2a`）** | 45 monitor.log 全迁 audit / 12 新常量（TASK_DISCARDED 等）/ recovery 三分决策审计回链 |
| ~~A.2 inbox 写失败 + shutdown 超时 console 兜底~~ | drift | **已闭环（phase248 + phase267）** | inbox 写失败 β 双写（phase248）/ shutdown timeout audit `TASK_SHUTDOWN_TIMEOUT` + β 双写保留 console.warn（phase267 / system.ts:535-536）|
| ~~A.3 initialize 调 ensureDir('inbox/pending') 跨模块兜底~~ | drift | **已闭环（phase273）** | 删 system.ts:151 冗余调用 / InboxWriter `write()` per-write `ensureDir` 已覆盖 / M#3 资源唯一归属合规 |
| ~~A.4 SubAgent class 双路 `new`（task + contract）~~ | drift | **已闭环（phase229 / SHA `28683c4`）** | `createSubAgent` thin proxy 工厂建成 / system.ts:551 + manager.ts:1189 均切换工厂调用 / AsyncTaskSystem 仅见工厂签名（M#8 耦合界面最小）|
| ~~A.r53-1 spawn 工具 schema 与应然背离 + ask_caller 缺工具~~ | semantic drift / 高 | **✅ closed (phase 470 / SHA `a6b99f18` / merge `f8b00074`)** | phase 470 实施（r62 E fork / commit `a6b99f18` / merge `f8b00074`）：(1) **spawn schema 7→3 字段**（intent + timeoutMs + maxSteps / 删 tools+idleTimeoutMs+messages+systemPrompt）/ (2) **SubAgentTask** prompt→intent + timeout→timeoutMs + 加 `mainContextSnapshot: {clawId, toolUseId}` marker / (3) **SubAgentOptions** 加 mainDialogStore + mainContextSnapshot / 删 phase 438 deprecated taskSystem / (4) **NEW ask_caller 工具**（subagent profile only / `src/core/task/tools/ask-caller.ts` 61 行 / 含 placeholder LLM clone call wrapper / 实施期 derive）/ (5) **ExecContext** 扩 mainDialogStore + mainContextSnapshot + currentToolUseId / (6) **Assembly** setMainDialogStore inject AsyncTaskSystem / (7) caller cascade（dispatch + retro-scheduler + random-dream + 6 tests）/ 20 files +214 -227 / 1353 tests PASS（3 removed: spawn messages validation 不再有）/ tsc 0 错。**r53+ spawn cluster 完整闭环**（phase 444 design + phase 450 code α + phase 466 code β + phase 470 spawn 4 phase 跨 r 完整闭环）。源：r53+ §10 spawn 工具通道讨论 + phase 456 DialogStore 应然 sharpen + r62 E fork |
| **A.spec-1 应然 `interface AsyncTaskSystem` + generic `schedule(taskType, taskData)` ↔ 实然 `class AsyncTaskSystem` + 双 entry `scheduleSubAgent`+`scheduleTool`** | spec drift / 大 | **closed**（phase414c L4 audit / interfaces/l4.md align 实然 class + 双 entry + 实然 task type discriminated union）| 历史 interfaces 写应然 `interface AsyncTaskSystem` 抽象 + generic `schedule(taskType: string, taskData: TaskData): Promise<TaskId>` + generic `TaskData = Record<string, unknown>` / 实然 = `class AsyncTaskSystem` ctor 注入 + 双 specific entry (`scheduleSubAgent(SubAgentTask)` / `scheduleTool(ToolTask)`) + 两 discriminated union types (`SubAgentTask` `kind: 'subagent'` / `ToolTask` `kind: 'tool'`) / `addTaskResultHandler` 实然 4 参 (taskId, callerType, result: string, isError) 返 string (pipeline pattern) vs 应然 2 参 (taskId, result: TaskResult) 返 void / 应然原 `TaskResult` 类型实然 0 实施（用 raw string + isError flag） / phase414c interfaces/l4.md 修订 align 实然 class + 双 entry + handler signature + 删 generic `schedule` / `TaskData` / `TaskResult` / `AsyncTaskSystemError` / `queueLength()` 5 应然幻象 |
| **A.spec-2 AsyncTaskSystem ctor 强依赖 LLMOrchestrator + ContractSystem + OutboxWriter** | scope drift / 中 | open（phase414c L4 audit 登记 / 升档条件：依赖图复杂度增长）| 应然 silent on AsyncTaskSystem ctor 依赖具体 instance / 实然 AsyncTaskSystemOptions 必须含 `llm: LLMOrchestrator` + `contractManager: ContractManager` + `outboxWriter: OutboxWriter` (phase155C ctor 合入 / 4 setter 删) / 跨同层 dep（L4 → L4 ContractManager + L2 LLM/Outbox）/ scope 已比应然 silent 暗示的范围更宽。升档条件：未来出现 AsyncTaskSystem 不需要其中某依赖的 caller 场景 → 升档评估能否 deps 可选化 |
| **A.bypass-1 AsyncTaskSystem subagent-executor.ts 直 import `node:fs`（fd 模式）** | M#5 弱违反 / 中 | **✅ closed**（phase455 / main `f619b303`）| L4 AsyncTaskSystem 1 file 直 import OS sync API 绕 FileSystem L1 / 4 fsSync calls + fd-based stream 模式：`subagent-executor.ts` (1) mkdirSync → `fs.ensureDirSync` (2) openSync('a') + writeSync(fd) + closeSync 三件套 → **改用 `fs.appendSync` 多次替代**（FS abstraction 0 fd API / 性能可接受 / NodeFileSystem.appendSync 内部 atomic open-write-close fused）+ 删 taskStreamFd 状态 + closeTaskStream helper / 行为 0 改 / 同 phase434+436 bypass cluster 模板 / **fd 模式特殊处理首例**（推 r+1 加 fd-based API 评估若 perf regression 显著）|
| **A.invariant-6 D6.1 隐式 inheritance 机制 anchor**（2026-05-07 / 3 轮 src 实测核 / Design Principle「智能体创建的临时子代理完全继承调用方的OS资源访问权限」derive）| anchor | 防 drift（合规）| **核心判据**：spawn/dispatch/retro/random_dream 子代理 OS 边界继承 caller 实然 = **3 机制偶然合力副作用**（非显式实施）：(1) Tool instances **module-level const**（FileTool 6 工具 + CommandTool exec / `getForProfile` 是 filter+share / 不 deep copy）/ (2) **ctx.clawDir 透传链** subagent-executor:46 deps.clawDir → SubAgent.clawDir → ToolExecutor.clawDir → ExecContext.clawDir = caller.clawDir / (3) **PermissionChecker per-clawDir cache**（permission-context.ts module-level Map）+ **sandbox 形状 hardcoded const**（claw-permissions.ts SYSTEM_PATHS+WRITABLE_PATHS / 非 caller 配置）→ 同 clawDir → 同 checker → 同 sandbox 边界 / 任意 1 机制 refactor 都可能破继承（per-task FileTool instance / per-caller PermissionChecker / Task schema 加 sandbox 字段独立配置 / ToolRegistry deep copy 模式 等）/ reviewer 改任一机制时必同步评估对原则继承的影响 / 当前 0 active drift / 用作防 drift sentinel。**reading C 锁定**（per principles.md「权限"指 sandbox 边界 / 不指工具入口数」）：subagent profile 多 edit/multi_edit 入口不违反原则（同 sandbox 边界 / 工具入口数差不算权限差）/ phase 492 G1 决策与新原则不冲突 |
| ~~A.ingest-concurrent-double-push `_ingestPendingFile` await 后仅 cancellingIds re-check / 未覆 runningTasks + pendingQueue / 双 push 风险~~ | ~~drift / 中（P1 race）~~ | **✅ closed**（phase 612 / main `b3d77709` / merge `ac7746e6`）| **应然**：concurrent ingest 同 taskId（chokidar 重 add event / `_initialScanPending` + watcher concurrent 等）必由 await 后 re-check 三 set（runningTasks + cancellingIds + pendingQueue）拦截 / 不仅 cancellingIds（phase 556 β fix scope 仅覆 cancel race）。**实然漂移**：phase 606 已抽 `_isDuplicate(taskId)` sub-fn 联合三 set / 但 `_ingestPendingFile` line 323 await 后 re-check 仍仅 cancellingIds.has（phase 556 β fix 残留）/ T1 ingest A 通过 sync gate → await `_loadPendingTask` / T2 ingest B 同 taskId concurrent → 通过 sync gate（A 未 push）→ await / T3 A resume / `cancellingIds.has` false / push + dispatch / T4 B resume / `cancellingIds.has` 仍 false / 双 push → pendingQueue 内同 taskId 双条目 / `_dispatch` 顺序 shift / 第二条 `runningTasks.set` 覆盖第一条 abortController → 行为半 silent。~~实然偏离~~ → phase 612 修：line 323 `cancellingIds.has(taskId)` → `_isDuplicate(taskId)` 三 set 全核（superset of cancellingIds / 行为 0 退化 / 仅扩 race window 防御）。**「phase X β fix 仅覆 1 set → phase Y 升级三 set 全核」首发模板**（phase 556 cancellingIds-only β race fix → phase 612 _isDuplicate 三 set 全核 / 升格独立 feedback 候选累 N=1）。同根 phase 556 cancel race row（line 159）/ 缺口本 phase β2 闭 |
| ~~A.dead-letter-retry-pending-silent-drop `_recoverWithResult` retryCount<MAX 时 fall-through to move DONE / 静默 drop / 下次启动 0 retry~~ | ~~drift / 高（D1+D5 silent drop）~~ | **✅ closed**（phase 612 / main `b3d77709` / merge `ac7746e6`）| **应然**：recovery sendResult 失败时 retry counter 写盘是为下次启动再 try / counter <MAX 时应保 running/ 等下次 recovery / 不应 move DONE（DONE 不再 trigger recovery / counter 永不被读）。**实然漂移**：`task-recovery.ts:118-148 _recoverWithResult` else 分支 retryCount++ + persist + check MAX / **retryCount < MAX 时 fall-through 到 line 130 move running→DONE**（与 success path 同代码路径） → silent drop（resultSent=false 但移 DONE / parent 永不收 result / 下次启动 0 retry / counter 写盘后永不被读 = 无意义）/ 违 D1a 信息不丢失 + D5 事后可重建。~~实然偏离~~ → phase 612 修：retryCount<MAX 加 audit `RECOVERY_FAILED context=retry_pending` + `return 0`（不 fall-through）/ 保 running/ / 下次启动 `recoverTasks` 再 trigger _recoverWithResult / counter 持久 / 累至 MAX 自动 dead-letter（同 phase 556 dead-letter 路径不变）。**0 NEW audit const**（复用 RECOVERY_FAILED + context=retry_pending / mirror phase 541 模板 N+1 实证）。**dispatch reframe**：dispatch 标 α "移 PENDING（保留下次启动重试）" / 实测 reframe 保 running/（不绕过 _ingestPendingFile fresh path / M#7 align / 行为差与 α 等价）/ 「dispatch α reframe → 简洁 path 选择」N+1 实证 |
| ~~**A.12 spawn 子代理工具注册缺失（functional gap / 高）**~~ | ~~functional gap / 高~~ | **✅ closed（phase475 / main `805983ba`）** | ~~AsyncTaskSystem 构造函数创建空 registry（`new ToolRegistryImpl()` + `registerBuiltinTools` 调用）/ phase 360+416+428+440+442+446 业务工具迁 owner module 后 / `registerBuiltinTools` 实然变 no-op 空函数 / AsyncTaskSystem.registry 永远空 / subagent-executor 用空 registry 过滤 subagent profile → effectiveRegistry 空 / `toolsForLLM = []` 给 LLM / spawn / dispatch / verifier 子代理体系全 0 tool_use / 完全失效~~ → phase475 根治：(1) `AsyncTaskSystemOptions +registry: ToolRegistryImpl` 必填 / ctor 改 `this.registry = options.registry`（删 `new ToolRegistryImpl()` + `registerBuiltinTools` 调用 + import）/ (2) Assembly 装配期 createAsyncTaskSystem 注入 toolRegistry（Runtime 共用同一已填充 registry）/ (3) `registerBuiltinTools` no-op 函数 + 整 `src/foundation/tools/builtins/` dir 删（dead code 清 / 5+ caller cascade）/ M#3 资源唯一归属 align（ToolRegistry 是 L2 资源 / AsyncTaskSystem L4 借用不 own）/ M#5 单向依赖 align（L4 接 L2 注入 / 不自建 L2 资源）/ **subagent 0 tool_use bug 根治** / **起源**：Motion spawn 测试 session 实测 3/3 subagent 0 tool_use → 自 grep 出 AsyncTaskSystem 空 registry → 用户驱动起 phase475 / 主会话独立验证 + 起草根治计划 |
| ~~A.cancel-ingest-race-after-await `_ingestPendingFile` await 后未 re-check cancellingIds~~ | ~~drift / 高（P0 race）~~ | **✅ closed**（phase 556 / main `226ed24d` / merge `c5994414`）| **应然**：cancel 报告与实然 dispatch 必一致（D1a 信息不丢失 + D2 不静默）。`_ingestPendingFile` line 261-263 sync gate 仅捕获 pre-await race / line 265 `await fs.read` 期间 cancel 可入 `cancellingIds.add(taskId) → fs.move pending→failed → cancellingIds.delete` 整段 sync 完成报 CANCELLED / 但 ingest resume 后无条件 push pendingQueue → ghost dispatch / cancel 报告与实然不一致。~~实然漂移~~ → phase 556 β 修：line 270 await 之后 / push 之前加 `if (this.cancellingIds.has(taskId)) return;` re-check。**关键不变量**：re-check 与 push 之间无 await yield → JS 单线程 cancel 整段 sync 段必先于 ingest resume → cancellingIds.has 必为 true → return / 0 push。**「phase 536 α 主线 reorder 修不到 await window 缺口」实证**（α reorder 仅修 cancel 入口先加 set / 但 watcher 已通过 sync gate / β re-check 才是真闭环）。同根 §B line 185 phase 536 closed row → partial closed → 缺口本 phase β 闭。NEW test：`tests/core/async-task-system/race-deadletter.test.ts` 含 cancel-during-ingest-await 场景反向 |
| ~~A.dead-letter-cleanup retryPath leak + dead-letter / done 双 silent catch~~ | ~~drift / 中（D5 信息洁癖 + D2 不静默）~~ | **✅ closed**（phase 556 / main `226ed24d` / merge `c5994414`）| **应然**：dead-letter 转 failed 后 retry counter file 必清（D5 防 stale counter 在异常 fs 恢复 / 测试夹具复活下重激）+ move 失败必 audit（D2 / 0 silent）+ inner delete 失败必 audit（D2 / 0 silent）。~~实然漂移（3 site）~~ → phase 556 修：(a) `task-recovery.ts:102-110` dead-letter 路径加 `await fs.delete(retryPath).catch(audit context=dead_letter_retrypath_cleanup_failed)` cleanup（C2.a）/ (b) dead-letter move catch 改 audit `RECOVERY_FAILED context=dead_letter_move_failed` + inner delete catch audit `context=dead_letter_delete_failed`（C2.b）/ (c) `task-recovery.ts:114-116` 正常 move running→done 双 catch 改 audit `context=done_move_failed` / `context=done_delete_failed`（C2.c）。**0 NEW audit event const**（复用 RECOVERY_FAILED + 4 NEW context= 区分子场景 / align phase 541 silent X cluster 模板）。**phase 541 silent X cluster 跨模块 N+1 实证**（phase 541 治 alreadysent block 漏 task-recovery dead-letter + done 双路径 / 本 phase 接力闭）。同根 §B line 186 phase 536 result delivery row → partial closed → 缺口本 phase 闭 |
| ~~**A.verifier-toolset-mismatch verifier 子代理工具集与 system prompt 失配（registry 仅 reportTool / prompt 指示 read+ls+search）**~~ | ~~drift / 高（P0 业务失效 / contract acceptance 验收完全失效 / verifier 陷入循环 100 步内调用 40+ 次 report_result）~~ | **✅ closed**（phase 704 / SHA `e87bae44` / merge `2211fd5a`）| **应然**：subagent 工具集必与 system prompt 指令 align（M#7 耦合界面稳定 / 不可指示用 X 但 0 X 工具）/ verifier 应然工具集 = `readonly` profile（read + ls + search + status + memory_search） + reportTool（特殊验收工具）。**实然漂移**：`src/core/contract/verifier-job.ts:22-24` 仅 `createToolRegistry()` + `register(reportTool)` / **0 FileTool 注入** / 但 `CONTRACT_VERIFIER_SYSTEM_PROMPT`（`src/prompts/subagent.ts:11`）明确指示「Use the available tools (read, ls, search) to inspect the evidence and artifacts described in the prompt」/ LLM 想 inspect 文件但 0 可用工具 → 陷入循环反复调 report_result（实测 100 步调用 40+ 次）/ **contract acceptance 验收完全失效**（同 phase 475 subagent 0 tool_use 类型 / functional gap）。**修复方向（α / 真合规）**：(1) `VerifierConfig` +`toolRegistry: ToolRegistry` 必填字段（assemble 装配期注入 main toolRegistry / 同 phase 475 AsyncTaskSystem 注入模板 N+1 实证）+ (2) `verifier-job.ts` 内部 `toolRegistry.getForProfile('readonly')` 派生 readonly 工具子集 + register reportTool / (3) caller cascade：`acceptance.ts:503` `runContractVerifier` call + `manager.ts:435` `_runVerifierSubagent` 透传 / `assemble.ts` createContractManager 注入 toolRegistry。**反模式（β / 不是真合规）**：verifier-job.ts 内部直 import + new 各 FileTool class（leak L2 dep 到 L4 / 违 M#5 / 同 phase 475 教训反例）/ 或 verifier 用 'verifier' NEW profile（YAGNI / `readonly` profile 已 align prompt 指令 / 不需 NEW profile）。**「subagent 0 tool_use bug 治理」第 2 实证**（phase 475 AsyncTaskSystem 空 registry + 本 row verifier-job 0 FileTool / 同根：subagent 创建 0 注入工具集 / functional gap）。**「应然 prompt 与实然工具集 align 必修纪律」首发 case**（推 r+ ≥ 2 实证升格独立 feedback「subagent prompt 工具指令必 cross-check 工具集」）。**framing 同步**：user 2026-05-08 §B line 195 自登记 + 实测「100 步内调用 40+ 次 report_result」业务后果具体 / 主会话 Path #1 实测核（grep registry + prompt 内容对照 + TOOL_PROFILES.readonly 含 read+ls+search 完美 align）确认 100% 真 drift / 0 framing 错位 / 直接升 §A。**§B line 195 row 同步 closed by 升 §A** |
| ~~**A.askmotioncontext-snapshot-reframe phase 699 askMotionContext snapshot 模型 phase 709 reframe 推翻**~~ | ~~design framing 推翻 / 中~~ | **✅ closed**（phase 713 / SHA `1edb41d2`）| **应然 phase 709 reframe**：ask_motion 业务语义 = dispatch 时刻 Motion snapshot（保留 phase 699 frozen 语义）/ 但 snapshot source 应改为 **Motion runtime DialogStore 持久化的 LLM call snapshot**（per-turn / phase 709 DialogStore reframe）/ 不是 dispatch 端 await snapshot 然后 push 到 task。**全然一致性**原则：subagent 端 ask_motion 0 重复 build systemPrompt / 0 重复 derive tools / source 单一 = Motion runtime 实然用的值（per phase 709 全然一致性原则首发）。**实然漂移**（phase 699 snapshot 模型）：(1) `SubAgentTask.askMotionContext` 含 3 件 dispatch 端 await snapshot push 到 task / 真合规应推翻：删 `askMotionContext` 字段 / 加 `motionClawDir?: string` / (2) `dispatch.ts` 删 await 3 dep snapshot / 仅 push motionClawDir / (3) `subagent-executor.ts` 装配 AskMotionTool 注入 motionDialogStore（据 task.motionClawDir 构造）/ (4) `ask-motion.ts` ctor 简化 4 → 2 dep（llm + motionDialogStore）/ execute 内部 read motionDialogStore.load() 拿 snapshot。**phase 713 落地**（SHA `1edb41d2`）：DialogStore reframe code α+β 同 commit / SessionData v2 +toolsForLLM / save 签名扩 snapshot 参 / load + restorePrefix v1→v2 兼容 read / Motion runtime 9 处 save call 扩 snapshot / regime hash detection 移 Runtime in-memory state / SubAgentTask schema 删 askMotionContext +motionClawDir / dispatch.ts 简化 / ask-motion.ts ctor 4→2 dep / subagent-executor 装配 motionDialogStore inject / 29 files changed / 155 test files PASS / 1698 tests PASS / tsc 0 errors / **design+code 联动 3 阶段第 2 实证完整闭环**（phase 444+450+453 第 1 + phase 709+713 第 2）/ **全然一致性原则首发实证落地** / **historical design intent 推翻规范首发落地**（推翻 phase 466 instance lifetime 锁定）。|
| ~~**A.extratools-class-instance-json-loss extraTools 类实例方法 JSON 序列化丢失**~~ | ~~drift / 高（P0 业务失效 / mining 第一阶段意图挖掘失败 / ask_motion 工具完全失效）~~ | **✅ closed**（phase 699 / SHA `75c260fa` / **phase 709 design reframe**：phase 699 snapshot 模型推翻 / 推 code phase 710+ 实施真合规 reuse motionDialogStore / 详 §A `A.askmotioncontext-snapshot-reframe` row）| **应然**：跨 fs/进程 boundary 传递的 task payload 必为纯数据 schema（per phase 432+438 fs-driven 模板 / `feedback_governance_workaround_smell §callback closure 元判据` 已硬化 Meta 33）/ 类实例方法不可 JSON.stringify 序列化 / cross-process 必走 schema lookup + instantiate 路径。**实然漂移**：`dispatch.ts` 通过 `SubAgentTask.extraTools` 传 `AskMotionTool` 类实例 / `writePendingSubagentTaskFile` 调 `JSON.stringify(task)` / 类实例 method（`execute`）在序列化中丢失 / subagent ingest 反序列化后 `tool.execute is not a function` / **ask_motion 工具完全失效 / mining 流程业务断**（实测：返 `[TypeError] 工具执行失败: tool.execute is not a function`）。**修复（α / 真合规 per 元判据）**：`SubAgentTask` schema 删 `extraTools?: Tool[]` / 加 `askMotionContext?: { motionSystemPrompt: string; motionToolsForLLM: ToolDefinition[]; motionMessages: Message[] }` 纯数据 / `dispatch.ts` await snapshot push pure data / `subagent-executor.ts` 按 `askMotionContext` 重建 `AskMotionTool` 实例 / 与 phase 432+438 fs-driven schema 模板同型。**「callback closure 是 cross-process design smell」第 3 实证落地**（phase 432 pendingCallbacks Map closure / phase 438 dispatch handler closure / 本 phase extraTools 类实例 method 同根 / 元判据 N+1 实证落地 case）。**framing 同步**：用户 2026-05-08 同时报「mining systemPrompt 跨 contract claw 边界」/ 主会话 Path #1 实测核确认那是设计意图（contract claw 启动经 `buildMotionSystemPrompt` 内置 contract context / `ContractYaml` 0 systemPrompt field / 是 mining → contract 两 phase 语义分离）/ 推翻 framing / 本 row 是真 drift 仅此一例。**§B line 195 row 同步 closed by phase 699** |
| ~~A.systemPrompt-passthrough subagent-executor + 3 caller systemPrompt 透传缺口~~ | ~~semantic drift / 高（P0 业务影响 / 契约创建流程失败）~~ | **✅ closed**（phase 546 / main `2da74c88` / merge `94cfa64d`）| **应然**：`SubAgentTask` internal schema 应含 `systemPrompt?: string` 字段（agent 不可见 / 与 phase 470 砍 agent-facing spawn schema 不冲突 / phase 470 line 343-347 锁「internal only / agent 不该传」/ 此处加 internal field 满足 caller-side specialized prompt 透传）/ `subagent-executor.ts` 注入逻辑应 `task.systemPrompt ?? DEFAULT_SUBAGENT_SYSTEM_PROMPT`（caller 优先 / fall-back DEFAULT 兼容旧 task / 0 破坏）。~~实然漂移（3 site）~~ → phase 546 Step B 实施：(a) `system.ts SubAgentTask` interface +`systemPrompt?: string` internal field（α 决策 5/5 原则一致）(b) `subagent-executor.ts:89` 改 `${promptPrefix}\n\n${task.systemPrompt ?? DEFAULT_SUBAGENT_SYSTEM_PROMPT}` (c) `dispatch.ts:176+` writePendingSubagentTaskFile call 加 `systemPrompt`（mining + describing 双 mode 共用 line 97 局部 var）(d) `random-dream.ts:240+` writePendingSubAgentTask call 加 `systemPrompt: RANDOM_DREAM_SYSTEM_PROMPT`（δ 决策 5/5 原则一致 / dead import → live use）。**不动 caller**：spawn agent-facing schema（phase 470 锁 / DEFAULT by design）/ retro-scheduler（推后单独 design 决策）/ deep-dream（直 LLMService.call / 不是 subagent 路径）/ verifier-job sync（已正确）。**「dead import / dead variable cluster 治理」3 同型 D2 违反 cluster 全闭** / **「dispatch / 用户 framing 错位 → 主会话 Path #1 实测重 frame」第 N 实证** |

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| ~~B.1 L4 归属可争议（L3 执行语义 vs L4 业务语义）~~ | ~~design-gap / 低~~ | **✅ closed (phase 502 / 用户判据 reframe)** | **「争议」framing stale**：用户判据「**异步调用子代理都走 AsyncTaskSystem / 同步才不走**」明确 AsyncTaskSystem L4 业务语义 = **异步子代理生命周期管理**（队列 + 持久化 + 崩溃恢复 + result 回传 = 真 L4 业务概念 / 非 L3 执行原语包装）。phase 432 后 async tool 合入同调度路径强化 L4 业务边界。同根 cross-ref：l3_subagent §A.invariant-3 anchor (async/sync path 分流判据) |
| ~~B.2 `setParentStreamLog` 运行期替换 sink~~ | ~~design-gap / 低（#6 显式豁免）~~ | **⚓ accepted-stable (phase 505 / 28 原则核)** | parentStreamLog 是「可选输出通道」非「依赖模块」/ 与 Gateway interrupt 同模式 / 不违 M#6（运行时**依赖**关系不可变 / sink 注入非 dep）/ M#9 装配期一次性 setter / D7 系统内部走可信路径 / 实测 1 caller (runtime.ts:99) 装配期注入 |
| ~~pendingQueue 字段保留（async tool 路径仍依赖）~~ | drift | **✅ closed (phase432 / 重审 phase438 收尾)** | phase432 后 `pendingQueue` 语义已 align 为「fs ingest 后内存等 _dispatch 的统一调度队列」/ 不再是 async tool 内存遗留 / scheduleTool callback API 删 / ToolTask 也经 `_ingestPendingFile` push 入队 / `pendingQueue` 是合理派生态（已登记 §3 资源表 = 派生态）|
| ~~`listPending()` 单源（仅返 pendingQueue.map）~~ | ~~drift / 低~~ | **⚓ accepted-stable (phase 505 / 28 原则核)** | phase163 后语义收窄：任务文件（subagent + tool 双 type）未被 watcher / `_initialScanPending` 拾起前不可见。phase432 后 ToolTask 也走 fs / 同 listPending 含义自然扩展含 tool 任务。M#3 资源唯一归属：pendingQueue 派生态 + fs 权威单源 / D5 信息不丢失 align（重启 watcher 重建）/ 实测 0 src caller 升档条件「消费方需求扩展 → `listPendingAsync()` 直读 fs」未触发 |
| ~~async tool 与 subagent 调度源双轨~~ | drift | **✅ closed (phase432)** | phase432 双轨消解：scheduleTool 内存 callback path 删 / ToolTask 改 `writePendingToolTaskFile` 直写 fs / 与 SubAgentTask 同经 watcher → `_ingestPendingFile` → `pendingQueue` 单一调度路径 / 「同字段混合两类任务」语义已 align（M#1 通用 task queue 真合规）|
| ~~dispatch.ts 保留 `ctx.taskSystem.addTaskResultHandler`~~ | drift / 低 | **✅ closed (phase438)** | phase438：addTaskResultHandler API 删 / postProcessor declarative schema 替代 / dispatch-contract-extract standalone function / closure 50 行 logic 移 `src/core/task/post-processors/` / 重启可恢复 |
| ~~**L4.G1 (task-system)** AsyncTaskSystemOptions 不显式列 FileWatcher / SkillSystem / SubAgent / ToolProtocol cross-module dep~~ | ~~业务决策性 design-gap~~ | **✅ closed (phase 505 / β dominant / 用户判据 derive)** | **β「模块内部直 import / 不经 ctor inject」是合规模式**：用户判据「调 L3 原语 = L4 内部」derive 模块内部 dep 不需 ctor inject。FileWatcher (L1 OS 抽象) + SubAgent (L3 原语) + ToolProtocol (L2b type-only) 全是模块内部细节 / SkillSystem 装配期注入 prompt（已经 ctor）/ ctor inject 仅用于跨 lifecycle 注入（runtime / 装配期可变 / 测试需替换）/ M#7 耦合界面稳定 + M#8 耦合界面最小 align（ctor inject 4 dep 暴露不必要装配负担）/ Step A 落地：interfaces/l4.md AsyncTaskSystemOptions 注释明确「模块内部直 import / 不暴露」|
| **L4.G2 (task-system)** spawn / dispatch / ask_caller 工具 export 现状 | **partial closed (phase 505) / ask_caller 调试中 partial open** | **实测分流**：(1) `spawnTool` 已实然 register `assembly/assemble.ts:189` / 装配期 register 模式（同 done/skill/send/status）/ (2) `dispatchTool` 实然 register `runtime/runtime.ts:177`（per-Runtime 实例化 / `new DispatchTool(...)` 闭包 dep）/ (3) **`askCallerTool` 0 register 站**（实然 ask-caller.ts:13 export const + profiles.ts:49 subagent profile 列名 / 但从未 instantiated 进 ToolRegistry）— **用户明示「ask_caller 调试中先不加」/ functional gap WIP / 不立 fix phase**。interfaces export 决策推 r+1+ 等 ask_caller 调试完后统一评估（α partial / β / γ 各候选）。phase 442「业务工具归 owner module」模板已 spawn/dispatch 应用 / interfaces export declaration 形态待 ask_caller 实装后再统一 |
| ~~cron `silent: true` 语义失效~~ | ~~design-gap / 低~~ | **✅ closed (phase 505 / row stale)** | 实测 SubAgentTask schema (interfaces/l4.md:64-81) 已无 `silent` 字段 / random-dream 改造后不再经 helper / cron 子代理无 viewport 父 / 应然 row 历史 schema 残留语义已 sunset / `grep "silent\??:" src/core/task interfaces/l4.md` EXIT=1 |
| ~~`ExecContext.taskSystem?` 字段保留~~ | drift | **✅ closed (phase438)** | phase438 cascade clean：ToolExecutorImpl + SubAgent + DispatchTool taskSystem field 全删 / 三路径全清（phase432 async tool + phase438 dispatch handler + KD#29 phase347 spawn/dispatch tools）|
| `_pending-task-writer` 不写 monitor.log（仅 audit）| drift / 低 | ⚓ accepted-stable（应然 silent / 实然偏差 / phase389 anchor 标记）|
| ~~spawn / dispatch / ask_motion 工具归属变更（KD#29）~~ | drift | **已闭环（phase287 + phase347 / 4 文件全迁 src/core/task/tools/）** |
| ~~SubAgent 下移 L3 后内部子模块化评估~~ | drift | **部分消化（phase341 / SHA `7480218`）** | (b)(c)(d)+(e) 4 子模块拆出 / standalone function pattern + deps interface / system.ts 1037→544 行 / 公共 API 0 改。剩余 (a) 调度核心不拆（反向测试 #1 共享 pendingQueue / running / shutdown）|
| ~~monitor 字段保留 SubAgent 透传~~ | drift | **已闭环（phase297 / SHA `d89e392`）** | monitor 字段链路全删 |
| ~~statusTool L2→L4 type-import drift（AsyncTaskSystem field）~~ | drift | **已闭环（phase369 / main `5374a4a`）**| **framing 精化**：AsyncTaskSystem field 0 method use / 真应然 = 删 field（非 port 化 / r51 文本错位修正）/ statusTool.taskSystem 字段直接删 / 实然任务统计经 ctx.fs.list 直读已成立 / M#1 反向测试 0 共变 |
| ~~应然 §1+§3 滞后 / phase342+ audit-events 扩展未同步~~ | ~~drift / 应然滞后~~ | **✅ closed（phase385 / 应然 stale 同步条款第 5 次 / 0 代码）** | §3 已同步至 19 events（计数权威修订 / 自报 16 → 实测 19）/ §1 「不绑死单一 task type / 派发到对应 task type 的 executor」已显式 subagent + tool 双轨语义 / 应然描述与实然 align |
| **class 工厂等价异形**（DispatchTool + AskMotionTool）| design-gap / 低 | ⚓ accepted-stable（phase398 framing 精化登记）| `class XxxTool implements Tool` + ctor 注入 deps 的 OOP 工厂模式 / 应然 silent 但实然采选 / 与 file_tool / command_tool 的 `createXxx(deps)` 函数工厂 M#1+M#3+M#7 等价（反向测试：可独立换实现不动 caller）/ 命名一致性偏离（`class XxxTool` vs `createXxxTool`）但表面稳定 / 升档条件：出现「class vs 函数工厂混用造成 caller 心智负担」/ 或团队约定统一函数工厂形态 → 升档为命名一致性治理 phase（caller 风格并轨复用） |
| ~~AsyncTaskSystem 任务工具未经工厂 export~~ ⚓ accepted-stable | drift / 中 → ⚓ accepted-stable | **⚓ accepted-stable**（phase398 / Path #1 framing 精化 / 升档条件锚定）| ~~实然：spawn / dispatch / done / ask_motion 4 工具均字面量 export（`export const spawnTool` 等）~~ → phase398 Path #1 实测 4 工具异质：(1) `spawn.ts:24` 字面量 const / 0 deps（phase163 已脱依 / 工厂封装为空 / ROI 低 / ⚓ accepted-stable）/ (2) `done.ts:19` 字面量 const + ctor 后注 `contractManager` 字段（phase360 已物理迁 ContractSystem / `assemble.ts:266` 单点后注 / 升档候选非违规）/ (3) `dispatch.ts:17` `class DispatchTool implements Tool` + ctor 注入 6 deps（**class 工厂等价已合规** / M#1+M#3+M#7 与 `createXxx()` 函数工厂等价 / 反向测试可独立换实现不动 caller ✓ / 见 §B 偏差登记「class 工厂等价异形」）/ (4) `ask-motion.ts:9` `class AskMotionTool implements Tool` + ctor 注入（**已合规**）/ class 双工具不在 drift 范围 / 字面量双工具升档条件：(a) spawn 加依赖（per-claw 差异 timeout / 异 isIdempotent 默认）/ (b) done 后注 contractManager 模式被复用第 2 处 → 推 ctor 注入 / 任一触发 → reactivate α 全工厂路径 / 见 `coding plan/phase398/overview.md` / dispatch table framing 精化第 N+? 案 |
| **AskMotionTool.cloneHistory cross-await race latent**（phase 682 / r91 D fork 登记） | drift / 低（latent / 当前 0 触发场景） | ⚓ accepted-stable（phase 682 / r89 fan-out Sub-C C-4 framing 登记 / 推 user 拍板 β 实施） | `src/core/async-task-system/tools/ask-motion.ts:44` push（await 前）+ `62/67/72` pop（错误路径 / await 后）/ 同实例 AskMotionTool 并发 execute 时（第二次 execute 在第一次 llm.call await 期间触发）→ 两次 push → cloneHistory 状态混乱 / **当前业务语义**：ReAct loop 单线程 sequential / 同实例 AskMotionTool 0 并发 execute caller / 0 实际触发场景（参见 §10.2 ask_caller / §10.3 cloneHistory 累积同 subagent 内 sequential by 业务约束）/ **升档条件**：(a) 出现并发 execute caller（如多 tool concurrent dispatch 框架）/ (b) cloneHistory 跨 await 多消费者 → α: 加 `running` flag guard 拒绝并发 + audit 写 `ASK_MOTION_REENTRY_REJECTED` / β: design 业务约束注「AskMotionTool 不可重入 / caller 显式 sequential 约束」/ 推 user 拍板 / β 实施推后 / r91 D fork 整 fork scope STALE 推翻 N=7 实证扩副发现（详 `coding plan/phase682/Phase 682 总览.md` §2 / Sub-C report C-4） |
| ~~**子代理目录路径硬编码（`tasks/results` 21 处）**~~ | ~~drift / 中~~ | **✅ closed (phase 510)** | phase 510 const rename + caller cascade：`TASKS_RESULTS_DIR` → `TASKS_QUEUES_RESULTS_DIR` ('tasks/queues/results') / 全 21+ 处字符串字面量替换为 const ref（async-task-system / claw-permissions / status-tool / subagent-executor / result-delivery / task-recovery 等）/ phase 511 sync 路径 verifier-job 改 `TASKS_SYNC_SPAWN_DIR` / phase 512 加 `TASKS_SUBAGENTS_DIR` / 5 NEW const + 集中管理生效 |
| ~~**全仓路径硬编码蔓延（`paths.ts` 常量定义与实然使用脱节）**~~ | ~~drift / 中~~ | **✅ closed (phase 510-512 cluster)** | phase 510 全仓 audit + cascade：`TASKS_PENDING_DIR` → `TASKS_QUEUES_PENDING_DIR` etc. / 9 NEW const 集中管理（5 queues + 3 sync + 1 subagents）/ caller 全用 const ref / `tasks/failed` 字符串字面量加 `TASKS_QUEUES_FAILED_DIR` const / paths.ts 唯一路径源原则恢复 / 推 r+1+ CI 加硬编码路径检测仍 open（design 决策性 / 不在 phase 510-513 cluster scope）|
| ~~**cancel pending race（`system.ts:434-462`）**~~ | ~~drift / 高（P0）~~ | **✅ closed (phase 536 主线 α + phase 556 β 缺口闭 / main `d78ee8c9` + `226ed24d`)** | cancel `fs.exists(pending)` → `fs.move(pending → failed)` 之间 3+ await 窗口 / watcher `_ingestPendingFile` 可在间隙 ingest 同一文件 / cancel 报 CANCELLED 但 task 实际运行 / 违反 D1a 信息不丢失 + D2 不静默 / **α: in-memory `cancellingIds` Set + cancel 先加 set + ingest 检 set skip**（phase 536）/ Path #1 实测核确认（phase 536 Step 0）/ **缺口**：α 仅捕获 pre-await race / `_ingestPendingFile` 在 `await fs.read` 之后未 re-check cancellingIds → cancel 报告与实然 dispatch 不一致 → **β by phase 556（详 §A.cancel-ingest-race-after-await row）**：await 后 push 前加 re-check / 真闭 race 窗口 |
| ~~**result delivery 无限循环（`task-recovery.ts:46-74`）**~~ | ~~drift / 中（P1）~~ | **✅ closed (phase 536 主线 δ + phase 556 cleanup 缺口闭 / main `d78ee8c9` + `226ed24d`)** | sendResult 失败 → sentMarker 不写 → move running→done 失败 → task 留 running/ → 下次重启重试 → 无限循环 / **δ: retry counter marker + 超 N 次 dead-letter 转 failed + audit `recovery_dead_letter`**（phase 536）/ Path #1 实测核确认（phase 536 Step 0）/ **缺口**：dead-letter 路径未清 retryPath counter file（leak / D5）+ dead-letter / done 双 move catch silent（D2）→ **by phase 556（详 §A.dead-letter-cleanup row）**：retryPath cleanup + 4 silent catch 改 audit RECOVERY_FAILED context= 区分 |
| ~~**WRITABLE_PATHS 缺 sync 子目录 + syncDir 硬编码（`claw-permissions.ts` + 4 处装配）**~~ | ~~drift / 低（P1 / 运行时 0 影响）~~ | **✅ closed (phase 536 / main `d78ee8c9`)** | phase 511 立 `TASKS_SYNC_{EXEC,WRITE,SPAWN}_DIR` 但 WRITABLE_PATHS 缺 EXEC+WRITE+SPAWN / checkWritePermission default allow = 运行时 0 影响 / 列表不完整 = 代码准确性 drift / **ζ: WRITABLE_PATHS 加 3 常量** + **θ: paths.ts 加 `TASKS_SYNC_DIR` + 4 处 `path.join(..., 'tasks', 'sync')` 改用常量** / Path #1 实测核确认（phase 536 Step 0）|
| ~~全路径 systemPrompt 未传递至 subagent（mining + spawn + retro + random-dream）~~ → **3 真 drift + 2 设计选择 + 1 sync 架构差**（phase 546 Path #1 实测重 frame）| drift / 高 | **升 §A by phase 546** → 详 §A `A.systemPrompt-passthrough` row | **phase 546 重 frame**（r66 / 2026-05-08）：原 framing「5 路径全 drift」实测核后 scope 收紧。 — **真 drift（3 路径 / 升 §A）**：(1) dispatch mining（dispatch.ts:97 `buildMinerSystemPrompt()` 局部变量 dead / 业务后果：mining 子代理 0 调 ask_motion / 契约创建流程失败）/ (2) dispatch describing（dispatch.ts:99 `await this.getSystemPrompt()` dead variable）/ (3) random-dream（random-dream.ts:12 `import { RANDOM_DREAM_SYSTEM_PROMPT }` 0 use **dead import** / 同 memory module 内 deep-dream 直 LLMService.call({system}) 已正确 = 双路径架构不一致 silent drift）。 — **不是 drift（设计选择 / 不在本 phase scope）**：(4) spawn 路径（agent 不计算 specialized / phase 470 应然锁「systemPrompt internal only / agent 不该传」/ DEFAULT 是 spec）/ (5) retro-scheduler（grep 全栈 0 RETRO_SYSTEM_PROMPT 常量 / specialized 经 `intent` user message embed / 是设计选择 / 是否分轨为 system+user 单独 design 决策推后 / 用户明示「最后再做」）。 — **架构差（不参与对比）**：(6) deep-dream 直 `llmService.call({system: DEEP_DREAM_SYSTEM_PROMPT})` 路径（不是 subagent 路径）/ (7) verifier-job sync 直 `createSubAgent({systemPrompt: CONTRACT_VERIFIER_SYSTEM_PROMPT})` 路径（不经 pending file watcher / 已正确）。 — **修复方案**：见 `§A.systemPrompt-passthrough` row（升 §A 因 P0 严重 / 业务后果 = 契约创建流程失败）。**「dispatch / 用户 framing 错位 → 主会话 Path #1 实测重 frame」模板**（同 phase 458 STALE + phase 522 framing 推翻）|
| ~~verifier-job 工具集缺失 FileTool（read/ls/search）~~ | ~~drift / 高~~ | **✅ closed by phase 704（升 §A → §A row 本身已 ✅ closed phase 704 / SHA `e87bae44`）** | 起源 §B row（user 自登记 / 实测 P0：100 步调用 40+ 次 report_result / 验收完全失效）/ 升 §A 因业务后果 = contract acceptance 验收完全失效 / 同 phase 699 extratools 升 §A 模板 / 真合规修复方向归 §A row（α 注入 toolRegistry + getForProfile('readonly') + reportTool / 同 phase 475 模板）/ 「subagent 0 tool_use bug 治理」第 2 实证（phase 475 + 本 row 同根） |
| ~~extraTools 类实例 JSON 序列化丢失方法~~ | ~~drift / 高~~ | **✅ closed by phase 699（升 §A → §A row 本身已 ✅ closed phase 699 / SHA `75c260fa`）** | 起源 §B row（应然 silent → 业务实测断 P0）/ 升 §A 因业务后果 = mining 流程完全失效 / 同 phase 546 systemPrompt-passthrough row 升 §A 模板 / 真合规修复方向归 §A row（α 纯数据 schema + subagent-executor 重建 instance / 同 phase 432+438 fs-driven 模板）/ feedback_governance_workaround_smell §callback closure 元判据第 3 实证 |
| **B.flaky-1 `tests/core/task.test.ts` workspace cleanup 异步竞态** | **flaky test / 低** | **open / 2026-05-09 phase562 发现** | `tests/core/task.test.ts > Task System + SubAgent > AsyncTaskSystem > subagent workspaceDir defaults to clawspace (shared with caller / phase 518)` 及相关 workspace cleanup 断言偶发 `expect(workspaceExists).toBe(false)` 失败 / 根因：subagent workspace `tasks/subagents/<task-id>/` 异步清理（`fs.rmSync` 与 `mockFs.exists` 之间竞态窗口）/ test teardown 与 subagent 内部 shutdown cleanup 时序不确定 / **与 phase562 修改无关**（phase562 只触及 `src/cli/` + `src/daemon/daemon.ts` heartbeat cleanup，0 触及 async-task-system）/ 升档条件：复现频率 >10% 或 CI 阻塞 → 治理（test 加 `await` 稳定轮询 或 teardown 前置强制 cleanup）|
| **B.flaky-2 `tests/core/task.test.ts` ENOTEMPTY cleanup 竞态** | **flaky test / 低** | **open / 2026-05-09 phase586 发现** | 全量运行时偶发 1 失败（1562 tests 中 1 failed），单独运行 `npx vitest run tests/core/task.test.ts` 时 24/24 PASS / stderr: `[test cleanup] Failed to remove /var/folders/.../clawforum-test-...: ENOTEMPTY: directory not empty` / 根因：test teardown 与 subagent 内部 shutdown cleanup 时序竞态 / **与 phase586 修改无关**（phase586 只触及 `src/foundation/audit/writer.ts` + `tests/foundation/audit/writer-fallback.test.ts`，0 触及 async-task-system）/ 升档条件：复现频率 >10% 或 CI 阻塞 → 治理 |
| **B.flaky-3 `tests/core/task.test.ts > should deliver subagent result to inbox/pending/*.md (bypass transport)` waitFor timeout** | **flaky test / 低** | **open / 2026-05-09 phase587 发现** | 全量运行时偶发 1 失败（1568 tests 中 1 failed），单独运行 `npx vitest run tests/core/task.test.ts` 时 24/24 PASS / Error: `waitFor timed out after 5000ms` / 根因：subagent 异步结果投递 + inbox 轮询时序不确定 / **与 phase587 修改无关**（phase587 只触及 `src/core/contract/` schema sweep，0 触及 async-task-system）/ 升档条件：复现频率 >10% 或 CI 阻塞 → 治理（test 加 poll 超时重试 或 inbox 轮询间隔调优）|
| **B.flaky-4 `tests/core/task.test.ts > should write task_completed err to audit when subagent times out`** | **flaky test / 低** | **open / 2026-05-09 phase597 发现 / 2026-05-10 phase633 复现 / 2026-05-10 phase651 复现 / 2026-05-10 phase675 复现 / 2026-05-10 phase682 复现** | 全量运行时偶发 1 失败（1594 tests 中 1 failed），单独运行 `npx vitest run tests/core/task.test.ts` 时 24/24 PASS / 失败点：`expect(workspaceExists).toBe(false)` 得到 `true` / 根因：subagent workspace `tasks/subagents/<task-id>/` 异步清理与 test teardown 时序竞态（同 B.flaky-1 根因）/ **与 phase597 修改无关**（phase597 只触及 `src/core/memory/` random-dream + deep-dream，0 触及 async-task-system）/ **phase633 复现确认**（main `6ccf0a60` 基 / worktree `92b99776` / 1668 tests 中 1 failed / 单独重跑 24 PASS）/ **phase651 复现确认**（worktree `phase651` / 1678 tests 中 1 failed / `expected true to be false` / 单独重跑 24 PASS / 与 phase651 修改无关：phase651 只触及 `src/cli/commands/chat-viewport.ts` + `src/daemon/daemon-loop.ts` + `src/core/memory/random-dream.ts`，0 触及 async-task-system）/ **phase675 复现确认**（main `0ffb9f35` 基 / worktree `phase675` / 1676 tests 中 1 failed / `expected true to be false` / 单独重跑 24 PASS / 与 phase675 修改无关：phase675 只触及 6 个测试文件 mock/spy lifecycle，0 触及 async-task-system）/ **phase682 复现确认**（main `45289e1a` 基 / worktree `phase682` / 1676 tests 中 1 failed / `expected true to be false` / 单独重跑 24 PASS / 与 phase682 修改无关：phase682 为 0 file edit 验证步骤，0 触及 async-task-system）/ 升档条件：复现频率 >10% 或 CI 阻塞 → 治理（test teardown 前置强制 cleanup 或加 await 稳定轮询）|
| **B.flaky-5 `tests/core/task-system-tool.test.ts > should queue multiple tasks and dispatch in FIFO order` waitFor timeout** | **flaky test / 低** | **open / 2026-05-09 phase597 发现** | 全量运行时偶发 1 失败（1595 tests 中 1 failed），单独运行 `npx vitest run tests/core/task-system-tool.test.ts` 时 37/37 PASS / Error: `waitFor timed out after 5000ms` / 根因：pending queue dispatcher 异步调度 + 轮询时序不确定 / **与 phase597 修改无关**（phase597 只触及 `src/core/memory/` random-dream + deep-dream，0 触及 async-task-system）/ 升档条件：复现频率 >10% 或 CI 阻塞 → 治理（test 加 poll 超时重试 或 dispatcher 轮询间隔调优）|
| **B.flaky-6 `tests/core/task.test.ts > AsyncTaskSystem > should not throw when shutdown times out with null auditWriter` ENOTEMPTY cleanup stderr** | **flaky test / 低** | **open / 2026-05-10 phase619 发现** | 全量运行时在 stderr 中偶发 `[test cleanup] Failed to remove ... ENOTEMPTY: directory not empty, rmdir '.../tasks/queues/results/<uuid>'` / 测试本身 PASS（ cleanup 阶段失败不影响断言结果）/ 根因：test teardown 与 subagent 内部 shutdown cleanup 时序竞态 / tasks/queues/results/ 子目录残留导致 fs.rm 递归清理失败 / **与 phase619 修改无关**（phase619 只触及 `src/core/evolution-system/` + `src/core/async-task-system/stream-events.ts`，0 触及 task 调度核心）/ 升档条件：复现频率 >10% 或 CI 阻塞 → 治理（test teardown 前置强制 cleanup 或加 await 稳定轮询）|
| **B.flaky-7 `tests/core/task.test.ts > AsyncTaskSystem > should write TASK_SHUTDOWN_TIMEOUT audit event when shutdown times out` ENOTEMPTY cleanup stderr** | **flaky test / 低** | **open / 2026-05-10 phase627 发现** | 全量运行时在 stderr 中偶发 `[test cleanup] Failed to remove ... ENOTEMPTY: directory not empty, rmdir '.../tasks/queues/results/<uuid>'` / 测试本身 PASS（cleanup 阶段失败不影响断言结果）/ 根因：同 B.flaky-6，test teardown 与 subagent 内部 shutdown cleanup 时序竞态 / tasks/queues/results/ 子目录残留导致 fs.rm 递归清理失败 / **与 phase627 修改无关**（phase627 只触及 `src/foundation/audit/` index.ts + writer.ts，0 触及 async-task-system）/ 升档条件：复现频率 >10% 或 CI 阻塞 → 治理（test teardown 前置强制 cleanup 或加 await 稳定轮询）|
| **B.flaky-8 `tests/core/task-system-tool.test.ts > should fall back to full content in inbox when results/ write fails` frontmatter parse null** | **flaky test / 低** | **open / 2026-05-11 phase694 发现** | 全量运行时偶发 1 失败（1676 tests 中 1 failed），单独运行 `npx vitest run tests/core/task-system-tool.test.ts` 时 37/37 PASS / 失败点：`tests/core/task-system-tool.test.ts:891` `expect(match).toBeTruthy()` 得到 `null` / 根因：inbox 文件 frontmatter 解析正则 `/---\n([\s\S]*?)\n---\n\n([\s\S]*)/` 未匹配 / 异步结果投递与 inbox 轮询时序不确定，导致 inbox 文件内容格式不完整（缺 frontmatter 或换行符漂移）/ **与 phase694 修改无关**（phase694 只触及 `tests/core/gateway-ask-user.test.ts` + `tests/core/dialog/injector-context-load-audit.test.ts`，0 触及 async-task-system）/ 升档条件：复现频率 >10% 或 CI 阻塞 → 治理（test 加 inbox 文件内容 guard 或 frontmatter 解析容错）|

### 7.C 应然原则对照

> 仅列**应然**对各原则的承诺立场 / 不写「合规✓」claims。

#### Module Logic Principles（11 条）

- **M#1 独立可变职责**：(a) 调度核心不拆 / (b)(c)(d)(e) phase341 已拆 4 子模块（反向测试 #1 共享 pendingQueue / running / shutdown 收口）
- **M#2 业务语义归属**：调度 / recovery / 结果回传由本模块发起 / 生命周期触发归 Runtime（与 Gateway 同模式）
- **M#3 资源唯一归属**：tasks/* 五目录独占 / phase273 inbox/ ensureDir 已删
- **M#4 持久化**：subagent + tool 任务皆 fs-driven ✓（phase432 ToolTask 文件化 / pendingQueue 是合理派生态 / 重启 recoverTasks 经 fs 恢复）
- **M#5 依赖单向**：不反向依赖 Runtime / Daemon / 下游反向 import 经 type-only + 注入豁免（详 interfaces/l4.md 不可消除耦合 #3）
- **M#6 依赖结构稳定**：AsyncTaskSystemOptions ctor 一次注入 / parentStreamLog 可选 sink 显式豁免（B.2）
- **M#7 耦合界面稳定**：公共 9 方法形态稳定（initialize / startDispatch / schedule / cancel / shutdown / addResultHandler / listRunning / listPending / queueLength）/ phase341 0 改
- **M#8 耦合界面最小**：A.4 SubAgent 工厂化 phase229 已清零 / 现仅工厂签名
- **M#9 显式编译器可检**：phase341 deps interface（subagent-executor ≥ 6 deps + recovery ≥ 4 deps）= M9 第 3 实证
- **M#10 不合理停下**：(a) 调度核心拆出会破 #1 反向测试 / 停 / 留 thin wrapper
- **M#11 边界对不上停下**：phase163 收紧 #5 判据 / 升 A 类 / 待清 path 显式登记

#### Design Principles（11 条 / #1 展 4 面）

- **D1a 信息不丢失**：phase248 后 recovery 路径全 audit / 19 events
- **D1b 状态可观察**：tasks/* 五目录 + audit.tsv 主 + per-task 子
- **D1c 中断可恢复**：result.txt.sent marker 幂等边界 + recoverTasks 三分决策
- **D1d 事后可审计**：phase248 后全路径审计回链
- **D2 不丢弃 / 静默**：phase248 + phase267 + phase273 三 phase 接力清零
- **D3 用户可观察**：tasks/queues/{pending,running,done,failed,results} 目录 + audit
- **D4 中断恢复**：recoverTasks 扫 running/ + result.txt.sent / 三分决策
- **D5 日志重建**：task 级 audit + 子 audit 双层
- **D6 子代理后不阻塞**：writePendingSubagentTaskFile fire-and-forget / watcher 异步 ingest / result 经 outbox 回传
- **D6.1 智能体创建子代理 OS 资源权限继承**（2026-05-07 加 / 2 轮 src 实测核 align）：本模块 subagent-executor 是**所有 writePendingSubagentTaskFile 调度统一执行点**（spawn/dispatch + retro/random_dream 同此路径）→ getForProfile 派生 + Tool module-level const reuse + ctx.clawDir 透传 → 同 PermissionChecker → OS 边界 100% 隐式 align caller / 非字段透传 / 0 drift / verifier-job 不走本模块例外（empty registry + reportTool only / 0 OS 工具）/ 详 §1.做 OS 资源访问权限继承
- **D7 系统可信路径**：scheduleSubAgent / scheduleTool 内部 API
- **D8 事件驱动**：FileWatcher 订阅 pending/ / 不轮询
- **D9 CLI 唯一外部入口**：外部不直调 AsyncTaskSystem
- **D10 多 claw 信息不隔绝**：tasks/queues/results/ 跨 claw 可见

#### Philosophy（4 条）

- **P1 Agent 即目录**：tasks/<id>/ 是 task 单元目录 / fs-driven
- **P2 上下文工程**：result.txt + audit 子文件 = 子代理上下文产物
- **P3 分多个智能体加分子任务**：subagent task 派生独立窗口 / 不污染父 claw
- **P4 系统为智能体服务**：提供调度 + recovery + 结果回传基础设施

#### Path Principles（7 条）

- **Path #1 路径规划基于规划时刻的事实**：phase341 实测 1037 行 + 4 子关注点 / 0 推翻 SubAgent 内部子模块化评估（注意实施过程中实然的变化）
- **Path #2 实然和应然差距显式登记**：违规明文上墙（在路径规划时参考 / §7.A + §7.B）
- **Path #3 语义原子变更单元**：phase341 单 commit 拆 4 文件 / 公共 API + caller 0 改 / 1 phase = 1 commit 原子
- **Path #4 可回滚 + 破坏性论证**：API 改动 caller 评估 / 破坏性改动显式论证（反向测试：本模块可独立替换 SubAgent / OutboxWriter / FileWatcher 实现而不动 caller —— M#1 ✓）
- **Path #5 完成后复盘**：phase 收尾三维 + Path Principles 第 4 维对账
- **Path #6 冲突立即中断**：(a) 调度核心拆出会破 #1 反向测试 / 停 / 留 thin wrapper（冲突调整优先于强行推进）
- **Path #7 总难度路径**：实然到达应然有诸多路径 / 选择降低总难度的（步骤间有相互作用 / 总难度 ≠ 各步骤成本简单相加）/ standalone function pattern（TS 惯用）/ 非 partial class

> 注：原 §7.C Path #8「总难度最低」是 Path #7 mis-numbered（canonical Path Principles 7 条 / 第 8 条不存在）/ 已修订为 Path #7「总难度路径」verbatim + 保留 standalone function pattern 注作为派生应用。

### 7.D 历史纪律

详 phase163 / phase173 / phase229 / phase248 / phase267 / phase273 / phase297 / phase324+325 / phase338 / phase341 / phase347 / phase385 各 phase 收尾报告 (`coding plan/phase<N>/`)。

关键里程碑：
- 2026-04-20 / phase163 SubagentSystem ↔ AsyncTaskSystem 运行时循环消除（writePendingSubagentTaskFile 文件直写 / scheduleSubAgentWithTracking helper 删）
- 2026-04-21 / phase173 模块层级重划（L4 SubagentSystem 废止 / SubAgent 下移 L3 / 工具归 L4 / KD#5 划线）
- 2026-04-22 / phase229 createSubAgent thin proxy 工厂建成（A.4 闭环 / SubAgent 双路 new 收窄）
- 2026-04-23 / KD#29 spawn/dispatch/ask_motion 工具归属归 AsyncTaskSystem(L4)
- 2026-04-24 / phase248 §7.A A.1 清零（45 monitor.log 全迁 audit / 12 新常量）
- 2026-04-24 / phase267 §7.A A.2 shutdown timeout 清零（TASK_SHUTDOWN_TIMEOUT audit + β 双写）
- 2026-04-24 / phase273 §7.A 4/4 全清零里程碑（A.3 删 ensureDir 冗余 + A.4 drift 修正）
- 2026-04-25 / phase297 monitor 字段链路全删
- 2026-04-26 / phase324+325 应然 framing drift 修订（§19→§20 / ToolRegistry L2 标注）
- 2026-04-27 / phase338 H1 audit-events.ts 模块自治拆分（TASK_AUDIT_EVENTS 物理迁出全局 events.ts）
- 2026-04-27 / phase341 H5 AsyncTaskSystem 单文件内部拆分（SubAgent 内部子模块化评估 部分消化 / 4 子模块 + standalone function + deps interface / M9 第 3 实证）
- 2026-04-27 / phase347 KD#29 子任务 b+c dispatch 物理迁完成 / spawn/dispatch/ask_motion 工具归属变更 闭环
- 2026-05-03 / phase432 async tool 路径 fs-driven 化（ToolTask schema +args+parentClawDir / scheduleTool callback API 删 / writePendingToolTaskFile helper / TaskScheduler L3 port 推翻 / `feedback_governance_workaround_smell` 7 实证全闭环）
- 2026-05-03 / phase438 dispatch handler 文件化（addTaskResultHandler API 删 / postProcessor declarative schema + registry / `src/core/task/post-processors/` standalone function / dead taskSystem field cascade 全清）
- 2026-05-03 / async tool cluster 收尾 design 重审：phase432+438 后 §B 3 子条 (pendingQueue / 双轨 / 待清 path) 全 closed / pendingQueue 重定义为「fs ingest 后内存等调度的派生态统一队列」/ subagent + tool 双 type 单轨调度成立
- r60+ 重编号：9 节 → 8 节 / 每节 derive 自一条 Module Logic Principle（详顶部 docblock）
- 2026-05-04 / cross-doc audit drift 修订（§7.C P3 verbatim「分多个智能体加分子任务」/ §3 PENDING_QUEUE_MAX 常量行降注脚 align arch 表 1 业务资源粒度）
- 2026-05-04 / phase455 fsSync bypass 治理（main `f619b303`）/ subagent-executor.ts 4 sync calls 全切 fs.appendSync 模式 / 删 fd 状态 + closeTaskStream helper / fd-based stream 改 appendSync 多次 / FS abstraction fd API 缺口推 r+1
- 2026-05-04 / phase462 barrel hygiene Tier 1（main `aaa91f39`）/ caller barrel-bypass 修正（runtime.ts:42 + src/index.ts:28 改用 task/index.js barrel / `import type { AsyncTaskSystem }`）/ task/index.ts barrel 现有 export 已 align 不需 expand / M#7 耦合界面稳定 align / assembly/assemble.ts:28 装配期 reach 内部不改（合规 pattern）
- 2026-05-04 / phase475 §A.12 spawn 子代理工具注册缺失根治（main `805983ba`）/ AsyncTaskSystem 不再 own ToolRegistry / `AsyncTaskSystemOptions +registry: ToolRegistryImpl` 必填 / ctor 改 options.registry / Assembly 装配期注入 / `registerBuiltinTools` no-op 函数 + 整 `src/foundation/tools/builtins/` dir dead code 删（5+ caller cascade）/ **M#3+M#5 align**（ToolRegistry L2 资源 / AsyncTaskSystem L4 借用不 own / 不自建 L2 资源）/ **subagent 0 tool_use 根治 / spawn / dispatch / verifier 子代理体系恢复** / 起源：Motion spawn 测试 session 实测 + 自 grep 登记 A.12（用户驱动证据链）
- 2026-05-05 / r65 cross-doc audit 单 doc 一致性核（modules/l4_task_system.md vs arch §21 + 表 1/2/3 + interfaces/l4.md AsyncTaskSystem 节）/ 0 derive drift / 主 derive 全 align（M#1-M#11 + Design Principle D1-D10 + Philosophy P1-P4 + Path #1+#3+#6+#8）/ 5 主能力 align arch 表 2（异步任务调度 + 崩溃恢复 + 大结果 marker 幂等 + 取消 + 优雅关停）/ 资源 `tasks/*` 5 目录 + 派生态 align arch 表 1「目录队列」/ 修 §7.E KD#29「ask_motion」stale → 「ask_caller」(per arch 表 3 r65 修订 + phase 470 spawn cluster 收尾)/ ask_motion 历史名保留 timeline 2026-04-23 entry / phase273 §7.A 全清零 + phase432+438 async tool cluster + phase 470 spawn cluster 4 phase + phase475 spawn 工具注册根治多里程碑稳态保留 / design only / 0 src 改
- 2026-05-07 / **新原则「智能体创建的临时子代理完全继承调用方的OS资源访问权限」加 principles.md（reading C 锁定 = sandbox 边界 / 非工具入口数）**+ §1.做 OS 资源访问权限继承 + §7.C D6.1 + **§7.A.invariant-6 anchor 登记** / 3 轮 src 实测核驱动 / 第 1 轮 grep 拿框架 / 第 2 轮逐文件追 propagation 链 / 第 3 轮反证穷举 caller 路径 / 累浮 8 处 framing 偏差完整修订 / 0 active drift（implicit inheritance 机制 = 3 偶然合力副作用 / anchor 防未来 refactor 破原则）/ 同步 6 modules（l3_subagent + l4_async_task_system + l4_evolution_system + l4_memory_system + l2_file_tool + l2_command_tool）/ feedback `feedback_design_derive_multipass_src_verify` 升格 A 类（multi-pass src 实测核纪律）
- 2026-05-08 / **phase 541 silent catch cluster 修 + 4 stale claim 实证**（main `8fcc4cdb`）/ r66 C fork / 3 真 silent site 修：(S1) `task-recovery.ts:57-59` alreadySent 路径 `move().catch(() => fs.delete().catch(() => {}))` 嵌套 silent → audit `RECOVERY_FAILED context=alreadysent_move_failed` + `context=alreadysent_delete_failed` / (S2) `result-delivery.ts:80-82` inline-fallback inbox write 失败 silent → audit `INBOX_WRITE_FAILED context=inline_fallback_failed`（D5 冗余防御 / 与既有主路径 audit line 87 双 audit 反映 2 失败点 / 信息保真）/ (S3) `system.ts:175` watcher `void this._ingestPendingFile(event.path)` fire-and-forget → `.catch((err) => audit.write(PENDING_INGEST_FAILED context=watcher_async ...))` / **0 NEW audit event const**（复用既有 `RECOVERY_FAILED` + `INBOX_WRITE_FAILED` + `PENDING_INGEST_FAILED` / context= 字符串区分子场景）/ 4 files +279 -7 / 4 NEW tests + 反向 3 项 PASS / 1509 tests PASS / **Path #1 实证 4 dispatch claim stale**（推 r67+ 候选）：(a) `task-recovery.ts:73` fallbackError 已 audit `RECOVERY_FAILED` / (b) `daemon-loop.ts:297` heartbeat.fire() 内部已 try-catch (heartbeat.ts:52-79) / (c) `assemble.ts:443-445` cleanupOrphanedTemp 已 audit `CLEANUP_TEMP_FILES_FAILED` / (d) `daemon-loop.ts:330-382` interruptPoller try/finally + catch 双路径已清 / **「直觉 bug 经 Path #1 实证为 phantom」第 2 实证累 → 升格独立 feedback 候选**（phase 539 Bug 2 dangling messages + phase 541 4 stale claim = 2 实证 / Meta 37+ 候选硬化「dispatch claim 起草不可信任 / Path #1 实测必先核」）/ **micro-hygiene cluster 第 12 实证累**（phase 504+520+523+524+526+527+528+529+530+531+539+541）/ silent X cluster feedback N+1 实证累
- 2026-05-08 / **phase 544 path literal const 化（micro-hygiene cluster N+1 / cross-cutting memory + async-task-system + contract）**（main `339edada`）/ r66 E fork / `CLAWS_DIR='claws'` const NEW（paths.ts + CLAW_SUBDIRS list）+ 4 file 10 处 literal 替换：`memory/random-dream.ts:131,137,139`（3 处）/ `memory/deep-dream.ts:263,265,266,275`（4 处）/ `async-task-system/system.ts:503`（1 处 'clawspace'）/ `contract/jobs/contract-observer.ts:29,42`（2 处 / dispatch 漏 sweep 加入）/ 5 files +17 -12 / 0 NEW tests（const 替换语义等价 / 既有 cover）/ 反向 3 项 PASS / 1514 tests PASS / **Path #1 实证 2 dispatch claim stale**（推 r67+ 不修）：(a) `assemble.ts:108` `// phase430:` 注释描述当前架构事实（PermissionChecker removed from NodeFileSystem ctor / claw-space boundary enforced by L4 caller / phase 标号 traceback 非 stale 信息）/ (b) `tests/core/dispatch.test.ts:4` randomUUID import 实然 used（line 8 import + line 24 用）/ **「直觉 bug 经 Path #1 实证为 phantom」第 3 实证累 → 升格独立 feedback 阈值再过**（phase 539 Bug 2 + phase 541 4 stale + phase 544 2 stale = 3 实证 / Meta 37+ 评估强化「dispatch claim 起草不可信任 / Path #1 实测必先核」）/ **「dispatch 列表 stale ratio ≥ 40%」N=2 实证累**（phase 541 4/7=57% + phase 544 2/5=40%）→ 候选 feedback「fork 起首必 Path #1 全表核」/ **micro-hygiene cluster 第 13 实证累**（phase 504+520+523+524+526+527+528+529+530+531+539+541+544）/ caller 风格统一并轨 feedback 第 N 实证累
- 2026-05-09 / **phase 556 async-task-system race + dead-letter cluster 缺口闭**（main `226ed24d` / merge `c5994414` / r67 E fork / 起步 SHA `dd711474` / 主会话 plan + 用户 code 实施 per `feedback_plan_by_main_implement_by_user`）/ §A 加 2 NEW row（`A.cancel-ingest-race-after-await` + `A.dead-letter-cleanup`）+ §B line 185+186 phase 536 closed row refine 为「主线 + 缺口闭」/ 4 dispatch claim Path #1 实测分类四态：(C1) cancel race VERIFIED 但 framing 不全 — α reorder 不修 race / β re-check after await 才真修 / (C2) dead-letter VERIFIED 部分 — retryPath leak + silent catch 真问题 / 「双 move」framing 不准 / (C3) retryCount off-by-one **STALE / phantom 推翻** — maxRetries=0 走 fallback 分支不进 retry 消息 / maxRetries≥1 时消息准确（initial + N retries = N+1 attempts）/ (C4-extra) phase 541 silent X cluster 漏的 task-recovery dead-letter + done 双 catch — Path #1 浮出真 silent / 实施 4 site 改：system.ts:270 ingest β re-check / task-recovery.ts:102-110 dead-letter retryPath cleanup + 4 silent catch 改 audit `RECOVERY_FAILED` + 4 NEW context= 区分（dead_letter_move/delete/retrypath_cleanup_failed + done_move/delete_failed）/ 0 NEW audit event const（复用既有 / 同 phase 541 模板）/ 3 files +282 -4（system.ts +5 / task-recovery.ts +43 -4 / NEW race-deadletter.test.ts 238 行）/ 反向 3 项 PASS / **「review claim Path #1 实测分类四态」模板首发**（VERIFIED tight + VERIFIED framing 不全 + VERIFIED 部分 + STALE phantom 齐全 / 升格独立 feedback 候选）/ **「直觉 bug 经 Path #1 实证为 phantom」第 4 实证累**（phase 539 Bug 2 + phase 541 4 stale + phase 544 2 stale + phase 556 C3 = 4 实证 / Meta 37+ 触发硬化）/ **「dispatch stale ratio ≥ 33-57%」N=3 实证**（phase 541 4/7=57% + phase 544 2/5=40% + phase 556 1/3=33% / fork 起首必 Path #1 全表核 候选 feedback 实证累）/ **silent X cluster 跨模块 N+1 实证**（phase 523 chat-viewport + phase 531 tools strict + phase 541 task-recovery alreadysent + phase 552 cron late error + phase 556 task-recovery dead-letter+done = 同根 cluster 5 实证 / 升格阈值早过）/ **「同根 cluster 跨多 phase 接力」模板**：phase 536 主线 α + phase 541 silent X 部分 + phase 556 race + dead-letter 缺口 = 同模块 3 phase 接力闭环
- 2026-05-10 / **phase 612 async-task race + dead-letter fix（D fork r74 / main `b3d77709` / merge `ac7746e6` / 起步 SHA `f4581dff` / 主会话 plan + 用户 code 实施 per `feedback_plan_by_main_implement_by_user`）**/ §A 加 2 NEW row（`A.ingest-concurrent-double-push` + `A.dead-letter-retry-pending-silent-drop`）/ async-task module 第 5 phase 实证累（phase 536 主线 α + 556 β cancel race + 601 system 拆 + 606 T6 cap+sub-fn + 612 race full + dead-letter）/ 2 P1 dispatch claim Path #1 实测：(C1 P1.7 race) VERIFIED + 行号 reframe（phase 606 抽 _isDuplicate sub-fn / 真 site _ingestPendingFile line 311-329）/ (C2 P1.8 dead-letter) VERIFIED tight（_recoverWithResult line 121-128 fall-through silent drop）/ 实施 2 site：system.ts:323 cancellingIds.has → _isDuplicate 三 set 全核（升级 phase 556 β fix scope from cancellingIds-only to runningTasks+cancellingIds+pendingQueue / superset / 行为 0 退化）/ task-recovery.ts:121-128 retryCount<MAX 加 audit `RECOVERY_FAILED context=retry_pending` + return 0（不 fall-through 到 line 130 move DONE / 保 running/ / 下次启动 _recoverWithResult 真 retry / 累至 MAX 自动 dead-letter）/ **0 NEW audit const**（复用 RECOVERY_FAILED + context=retry_pending / mirror phase 541 模板 N+1 实证）/ NEW concurrent ingest race + retry pending tests / 反向 3/3 PASS / **「phase X β fix 仅覆 1 set → phase Y 升级三 set 全核」首发模板**（phase 556 cancellingIds-only β race fix → phase 612 _isDuplicate 三 set 全核 / 升格独立 feedback 候选累 N=1）/ **「dispatch α reframe → 简洁 path 选择」N+1 实证**（dispatch 标 α 移 PENDING / reframe 保 running/ 等价 + path isolated + M#7 align）/ **「dispatch claim 行号 reframe」N+1 实证累**（phase 600 行号 STALE refactor 偏移 + phase 612 phase 606 sub-fn 拆分后位移 / Meta 40 已立扩 N+1）/ **「同根 cluster 跨多 phase 接力」async-task 第 5 phase 实证累**（536+556+601+606+612 / 升格独立 feedback 阈值远超 / Meta 41 加成）/ **silent X cluster 跨模块 第 N+1 实证累**（P1.8 dead-letter silent drop 修）/ **「review claim 实测四态分类」第 9 phase 实证**（556+563+567+581+587+592+598+605+612 / Meta 40 升格阈值过线）/ **audit injection α 模板 N+1 实证累**（P1.8 复用 RECOVERY_FAILED + context=retry_pending / phase 541 模板）
- 2026-05-10 / **phase 619 stream-events.ts module-self const file（hygiene cluster N+1 / 副 cluster S2）**（r75 E fork / 起步 SHA `dfc593ce` / 主会话 plan + 用户 code 实施 per `feedback_plan_by_main_implement_by_user`）/ NEW `src/core/async-task-system/stream-events.ts` module-self const file（mirror audit-events.ts H1 模块自治 / phase 338 模板扩 stream domain）/ NEW `STREAM_TASK_EVENTS` 2 const（TASK_STARTED + TASK_ATTEMPT_START）+ comment「字符串值 + 模块自治 const 集合 / 0 漂移 / 仅含 task lifecycle 事件 / chat message + tool_use 等 LLM SDK schema 出 scope 推 r76+」/ 2 site 字面量 → const refs：system.ts:298（parentStreamLog `type: 'task_started'`）+ subagent-executor.ts:67（taskStreamWriter `type: 'task_attempt_start'`）/ **0 字符串值漂移**（既有 stream reader / chat-viewport / watchdog / parentStreamLog consumer 0 影响）+ 2 file NEW import / 1 NEW file ~12 行 + 2 src ~3 行 / 0 NEW tests（const refs 替换语义等价 / 既有 cover）/ 反向 3 项 PASS / 同 phase 含 S1 evolution-system caller-DIP enforce（详 l4_evolution_system §7.D phase 619 row）+ S3 audit critical fallback caller 层扩展 STALE 推翻（phase 604 N=2 实证保持）/ **「stream event payload type 字段 const化 module-self」首发**（mirror phase 613 audit-events 模板扩 stream domain / 推 r76+ 同型再遇升格独立 feedback）/ **「既有 const/callback 复用」纪律边界条件第 2 实证**（phase 613 audit domain + 619 stream domain / 既有 stream type 字段无 const 集 / 必 NEW / 复用错位违 M#1）/ **「review claim 实测四态分类」第 N+1 实证累**（VERIFIED tight 2 + STALE 推翻 1 / S3）/ **「dispatch 数字 stale → reframe」第 N=4 实证累**（phase 605+587+613+619 / Meta 41 升格阈值远过）/ **「业务模块内 dynamic L1-L4 instantiation → factory injection」N=2 升格阈值过线**（phase 609 + 619 同 phase S1 / Meta 41 候选独立 feedback）/ micro-hygiene cluster N+1 实证累
- 2026-05-10 / **phase 613 audit event const cluster（hygiene cluster N=20+ 实证累）**（r74 E fork / 起步 SHA `f4581dff` / 主会话 plan + 用户 code 实施 per `feedback_plan_by_main_implement_by_user`）/ audit-events.ts NEW 3 const（TASK_STARTED + TASK_COMPLETED + TASK_SCHEDULED）+ comment 扩「字符串值 + 模块自治 const 集合 / 0 漂移」/ 8 site 字面量 → const refs：system.ts:232+418（task_scheduled + task_started）/ subagent-executor.ts:141+170（task_completed×2）/ tool-executor.ts:53+114（task_completed×2）/ tools/_pending-task-writer.ts:33（task_scheduled）/ tools/_pending-tool-task-writer.ts:33（task_scheduled）/ stream event payload `system.ts:298 type: 'task_started'` 显式 out-of-scope 保留（走 parentStreamLog 非 audit）/ **0 字符串值漂移**（既有 audit assertion test 0 影响）/ **3 file NEW import**（subagent-executor + 2 writers）+ system.ts/tool-executor.ts 既有 import 复用 / 6 files +~15 -8 / 0 NEW tests（const refs 替换语义等价）/ 反向 3 项 PASS / **「dispatch 数字 stale → reframe」第 N=3 实证累**（phase 605 首发 + 587 + 613 / Meta 41 升格阈值过线 / dispatch 原 claim 6 site → Path #1 实测 8 site / 行号 system.ts:384 STALE → 实然 418 / phase 593+594 refactor 行号偏移 per phase 600 实证）/ **「review claim 实测四态分类」第 N 实证**（VERIFIED tight 7 + VERIFIED framing 不全 1 行号 STALE + STALE 推翻 1 dispatch 漏 system.ts:418 + 副发现 1 stream event out-of-scope）/ **「既有 const/callback 复用」纪律边界条件首发**（既有 19 const 中无 STARTED/COMPLETED/SCHEDULED / 必 NEW 3 const / 复用错位语义违 M#1 业务唯一 / 推 Meta 41 加成 rule 子节）/ **「stream event payload type 字段 const 化」候选首发**（system.ts:298 / 推 r75+ 跨模块 stream type union sweep）/ **micro-hygiene cluster 第 N=20+ 实证累**（phase 504+520+523+524+526+527+528+529+530+531+539+541+544+556+595+596+598+602+606+613）
- 2026-05-08 / phase 546 §A.systemPrompt-passthrough subagent systemPrompt 透传 closed（main `2da74c88` / merge `94cfa64d` / r66 / 起步 SHA `ca1ca1d0` / 主会话 Step A design + user Step B+C code）/ §B 既有 row 187（5 路径全 drift framing）refine：drift 数 5→3 + 3 真 drift（dispatch mining + dispatch describing + random-dream）+ 2 设计选择（spawn by design phase 470 锁 / retro 推后）+ 1 sync 架构差（verifier-job）+ 1 不同架构（deep-dream 直 LLMService.call）/ §A NEW row「A.systemPrompt-passthrough」（升 §A 因 P0 业务影响 = 契约创建流程失败 / mining 子代理 0 调 ask_motion 实证 search/read 273 vs 0）/ Step B 改 4 site（system.ts SubAgentTask +`systemPrompt?: string` internal field / subagent-executor.ts:89 注入改 task.systemPrompt ?? DEFAULT / dispatch.ts mining+describing 透传 / random-dream.ts dead import 活化 RANDOM_DREAM_SYSTEM_PROMPT）/ 2 决策点（DEC-1 α SubAgentTask internal field 5/5 + DEC-2 δ random-dream 实施 specialized 5/5）全 5/5 原则一致 / 不动 4 路径（spawn by design / retro 推后 / deep-dream 架构差 / verifier-job sync 已正确）/ **「dead import / dead variable cluster 治理」第 N 实证**（dispatch dead var × 2 + random-dream dead import × 1 = 3 同型 D2 违反 cluster 全闭）/ **「dispatch / 用户 framing 错位 → 主会话 Path #1 实测重 frame」第 N 实证**（同 phase 458 STALE + phase 522 framing 推翻 + phase 545 dispatch P0 STALE）/ **「业务决策性 → 28 原则核 5/N derive → dominant 自决」累 8**（phase 520+521+522+531+537+542+545+546）
- 2026-05-11 / **phase 699 extraTools 类实例 → askMotionContext 纯数据 schema**（cross-process design smell 元判据第 3 实证落地 / phase 432 pendingCallbacks + phase 438 dispatch handler closure + 本 phase）/ Step A schema 变更：`system.ts` 删 `extraTools?: Tool[]` / 加 `askMotionContext?: { motionSystemPrompt; motionToolsForLLM; motionMessages }` / Step B `dispatch.ts` 删 `new AskMotionTool(...)` closure / 改 await snapshot pure data push / `ask-motion.ts` export `ASK_MOTION_TOOL_DESCRIPTION` + `ASK_MOTION_TOOL_SCHEMA` const / Step C `subagent-executor.ts` 按 `askMotionContext` 重建 `AskMotionTool(llm, snapshot, snapshot, snapshot)` / 4 files / ~60 行 / 单 commit / 1676 tests PASS / tsc 0 errors / `extraTools` src+tests 0 命中 / **「callback closure 是 cross-process design smell」元判据第 3 实证落地**（phase 432 + 438 + 699 = 3 实证累达模板深度成熟）/ **「Path #1 实测核浮出 hidden drift」第 5 实证**（phase 454 + 458 + 461 + 464 + 699）/ **「dispatch / 用户 framing 错位 → 主会话 Path #1 实测重 frame」第 N 实证**（同 phase 458 ContractStatusPort + phase 546 systemPrompt-passthrough + 本次 mining systemPrompt 跨 contract claw 边界推翻 framing）
- 2026-05-11 / **phase 704 verifier-job toolRegistry 注入**（同 phase 475 AsyncTaskSystem 注入 toolRegistry 模板 N+1 实证 / readonly profile 派生 read+ls+search+status+memory_search + register reportTool）/ caller cascade 6 层：assemble.createContractSystem +toolRegistry → ContractSystem.ctor +toolRegistry → _acceptanceCtx() 透传 → AcceptanceContext +toolRegistry → acceptance.ts:503 runContractVerifier call +toolRegistry → VerifierConfig +toolRegistry / verifier-job.ts:22 getForProfile('readonly') loop + register reportTool / 6-8 files / 1676 tests PASS / **「subagent 0 tool_use bug 治理」第 2 实证**（phase 475 + 704 同根模板 / 推 Meta 升格独立 feedback）/ **「应然 prompt 与实然工具集 align 必修纪律」首发**（推 ≥ 2 实证升格）

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| ~~KD#5~~ | ~~SubagentSystem 合并 TaskRunner~~ | 废止（phase173 / 执行原语 vs 生命周期管理拆分）|
| KD#6 | dispatch / spawn 独立工具 / 归 AsyncTaskSystem(L4) 导出 | ✓（phase347 物理迁）|
| KD#29 | spawn / dispatch / ask_caller 工具归 AsyncTaskSystem(L4)| ✓ 工具归属变更 闭环（phase347 dispatch 物理迁 + phase 470 ask_caller spawn cluster 收尾 SHA `a6b99f18` / arch 表 3 r65 修订同步 / ask_motion 历史名见 timeline 2026-04-23 entry）|
| KD#30 | ContractSystem LLM 验收经 AsyncTaskSystem 调度 | 部分实施（H11 完整 / H6 异步化推 r41+ design / 见 l4_contract_system §7）|

## 8. 测试覆盖

应然行为（不绑定具体测试文件路径）：

- **scheduleSubAgent / writePendingSubagentTaskFile**：fs 直写 tasks/queues/pending/{id}.json + audit `task_scheduled` + watcher 异步拾起
- **ToolTask 路径**：caller 调 `writePendingToolTaskFile` 直写 `tasks/queues/pending/{id}.json` (kind: 'tool') → watcher / `_initialScanPending` 拾起 → `_ingestPendingFile` push → `_dispatch` → `_startTask` 'tool' 分支 `buildToolTaskExecContext` + `executeToolTask` 重试 + `sendToolResult` OutboxWriter 回传（phase432 后 callback API 删）
- **dispatch 主路径**：subagent + tool fs ingest → _ingestPendingFile → push pendingQueue → _dispatch → movePendingToRunning → executeTask（phase432 后两类任务共享同路径）
- **崩溃恢复**：扫 running/ 三分决策（marker 存在转 done / 缺 marker 转 failed）+ audit 回链
- **结果持久化**：tasks/queues/results/<id>/result.txt + .sent marker + audit.tsv 子审计
- **shutdown 超时**：30s in-flight 触发 audit `TASK_SHUTDOWN_TIMEOUT` + β 双写 console.warn
- **cancel**：单任务 cancel + audit
- **PENDING_QUEUE_MAX**：队列满抛同步错
- **生命周期分离**：initialize 仅复原 / startDispatch 才驱动调度循环（phase163 强化纪律）
- **审计回链**：每个 §5 TASK_* 事件触发时机 + 载荷断言（19 events 全覆盖）
- **per-task 子审计**：每任务独立 taskAuditWriter 写 SubAgent 内部事件
- ~~**pendingQueue 字段保留/3/4 待清 path**~~：phase432（async tool fs-driven）+ phase438（dispatch handler 文件化）+ phase432 cluster 收尾 design 重审 = async tool cluster 全闭环 / 单轨调度成立 / 0 待清 path

## 10. 对智能体的承诺（工具通道）

> 5 维度结构（用途 / 入参 / 返回语义 / 副作用+跨通道 / profile准入+不变量）。失败语义留全工具集统一深度讨论。
> AsyncTaskSystem own 的 agent 工具：spawn / dispatch / ask_motion（L4）/ done 已迁 ContractSystem（phase360 / 不在本契约）。

### 10.1 spawn

**【1. 用途】**

> **意图执行通道** —— motion 或 claw 表达 want，系统派 disposable 子代理完成，仅结论带回上层 context。

**架构定位（三层意图传达 / 统一 context 节省机制）**：

clawforum 跨三层用同一种 intent 沟通模式：
- 用户 → motion：用户表达 want，省事，不写完整 plan
- motion → dispatch：motion 表达 want，保 motion 当前 context（中间过程不污染）
- motion / claw → spawn：表达 want，保上层 context（disposable 子任务不污染）

spawn 是其中第三层。统一原理：context 是跨层稀缺资源，意图传达是 context 优化的核心机制。

**设计意图**：

- caller 心智 = 「我有个意图，系统帮我搞定」。caller 是 LLM 但**不需要思考 prompt eng**（不需要把意图改写成「给另一个 LLM 的指令」），因为这种沟通模式在三层都一致，是智能体对智能体（或对人）的自然表达，不是 prompt eng。
- caller context window = 稀缺资源；subagent disposable，内部 token 任意花。
- **判据 ≠ 任务复杂度**，而是「caller 是否需要看 step-by-step trail」（否 → spawn）。
- AGENTS.md 教 agent 三问反射：(1) 我需要中间步骤吗？(2) 中间产物会进我 context 吗？(3) 主任务跟用户对话强相关吗？任一答 No 倾向 spawn。
- intent 不够清楚的兜底：subagent 跑起来发现需要细节，用 **ask_caller** 问 caller 的 clone（详 §10.2）。这是 intent 沟通的「澄清回路」，跟 dispatch mining mode 同 spirit。

**派生场景（spawn 高频触发）**：

- exec 截断后读全 output（避免污染 caller context）
- 大文件 read 后提炼关键观点
- 精确编辑（edit / multi_edit 给 subagent，caller 不持这两工具）
- 探索性任务（不确定 token 消耗，失败也不污染 caller）

**【2. 入参 schema（极简 P3 / YAGNI）】**

```
- intent        (string, required)    我想要的事情（不是 prompt for LLM / 不需 prompt eng）
- timeoutMs     (number, optional)    超时毫秒 / 默认 system const（不写量化数字）
- maxSteps      (number, optional)    ReAct 最大步数 / 默认 system const
```

**关键决策**：
- **极简 3 字段** / 反向 phase163 当前 7 字段 schema（应然砍 `tools` / `idleTimeoutMs` / `messages` / `systemPrompt`）
- **`prompt` → `intent`**：字段命名转 framing / claw 表达 want / 不写 prompt
- `tools` 字段砍：默认走 subagent profile / agent 不需要选 / 想限制行为用 intent 教学（soft constraint）/ 想精确限制 → 未来 design phase 再加
- `idleTimeoutMs` 砍：agent 不会调 / 系统默认管
- `messages` / `systemPrompt` 砍：internal only / agent 不该传 / 实然为内部调用预留接口（应然 schema 不暴露）
- **timeout 单位改 ms**（`timeoutMs`）/ 跟 exec / AsyncTaskSystem 其他超时字段一致命名（实然 `timeout` 秒不一致）

**【2.1 SubAgentTask 内部字段（agent 不可见）】**

```
SubAgentTask 内部 schema 含:
- intent: string
- mainContextMarker: { clawId, toolUseId }    ← marker 模式（NEW）/ 不复制 main 整个 dialog
- timeoutMs / maxSteps / parentClawId / etc
```

**marker 模式**（替代实然 `messages` 字段复制 main dialog）：
- spawn 创建 SubAgentTask 时 / 仅记录 marker = main claw id + 当前 spawn 调用的 toolUseId
- 不复制 main dialog messages 进 tasks/queues/pending/<id>.json（文件小 / 0 数据冗余）
- subagent 内 ask_caller 工具按需用 marker 解析 → 调 DialogStore.findDialogByToolUseId
- 信息保真：DialogStore 单一权威源 / current.json + archive/ 永远找得到（信息不丢失原则）

**【3. 返回语义】**

```
ToolResult { success: boolean, content: string, metadata?: { taskId } }
```

**两阶段返回**：

**阶段 1 / 立即返**（创建期）：
```
ToolResult {
  success: true,
  content: 'Subagent created. Task ID: <task_id>. Result will be delivered to inbox when complete.',
  metadata: { taskId: <task_id> }
}
```
- 创建期失败（`tasks/queues/pending/` 写失败 / queue 满）→ `success: false` 立即返 / **不入 inbox**

**阶段 2 / 完成投递**（异步 / 经 inbox）：

| 场景 | 触发 | inbox 消息形态 |
|---|---|---|
| 自然完成 | LLM 输出 final response（不再 call tools）/ ReAct loop 终止 | `success: true` + 结论 / 大结果走 `tasks/queues/results/<id>/result.txt` resultRef |
| timeout kill | 超 spawn 自身 timeoutMs | `success: false` + `[clawforum spawn]` 文案 + partial result + resultRef |
| maxSteps 钳制 | 用完 max steps | `success: false` + 「reached max_steps=<N>」+ partial + resultRef |
| idle timeout | LLM 不出 token 超 idleTimeoutMs（system 默认）| `success: false` + 「LLM idle timeout」+ partial + resultRef |
| LLM error | API 失败 / 网络 / 等 | `success: false` + error message |

**关键承诺**：
- **失败也走 inbox 投递**（除创建期同步失败立即返）
- **partial result 必返**（即使没完成 / 让 caller 看到 subagent 已做的）
- **error 文案 `[clawforum spawn]` prefix 明示框架触发**（跟 exec timeout 同型 / 区分 OS-level kill）
- **失败 inbox metadata 含 taskAuditPath**（指向 `tasks/queues/results/<id>/audit.tsv`）。实然每 task 有 per-task audit subwriter 记 LLM tool call 历史 / 应然 ratify 这条路径暴露给 caller。caller 看 audit 推 partial 进度，决定续做策略。
- **partial 副作用承诺局限性**：subagent 跑到一半 crash，已做的 fs / exec 副作用不可撤销（distributed systems 难题）。clawforum 提供 audit 透明化，不提供自动 rollback。caller 收到 partial 失败应**看 audit 派精确续做 intent**（含「前任已完成 X / Y / 你从 Z 继续」），而不是简单重派同 intent（重做 sequence 整体在 fs 实然变化后可能错）。AGENTS.md 教 caller 这个 retry 模式。
- **summary 由 LLM 主动写**（不 mechanical 截前 N 字）：subagent system prompt 模板教 subagent「final response 应包含浓缩 summary 给 caller，便于 caller 不用展开 details 就能拿到结论」。result-delivery 取 LLM 写出的 summary 段当 inbox 消息内容。这样 summary 是有意识的浓缩，不是随机字符截断。具体格式约定（markdown 标题 / 显式 marker / 长度建议）由 system 模板设计，应然 silent on 文本细节。
- **maxSteps 默认 100**：实战足够，复杂任务 caller 可通过入参显式调高。
- **timeoutMs 默认值 TBD**：实然 SPAWN_DEFAULT_TIMEOUT_S=300（5min）/ 应然层难定标准（spawn 任务千差万别）/ 留实然调参 + agent 入参 override。

**【4. 副作用 + 跨通道影响】**

- **fs 写**：`tasks/queues/pending/<id>.json`（创建即写）/ 完成时 `tasks/queues/results/<id>/` + `.sent` marker + 子 audit
- **跨通道**：完成结果经 inbox（L2 Messaging）投递 / 大结果走 results/<id>/result.txt resultRef
- **主 claw 拿到 inbox summary 后**：
  - 默认 = summary 够用（spawn 设计本意「只要结论」/ 见 §10.1.1 用途）
  - 真要 full → **再 spawn**（不直接 read tasks/queues/results/<id>/result.txt / 否则污染 context 违反 spawn 初衷）
- **claw 重启**：`task-recovery.ts` 扫 pending/running 恢复任务（不丢 task）
- **audit**：每次 spawn 经 L2 Tools 框架 `tool_exec` + AsyncTaskSystem 自身 `task_scheduled` / `task_started` / `task_completed` / per-task 子 audit `tasks/queues/results/<id>/audit.tsv` 记 subagent 内部事件

**【5. profile 准入 + 不变量】**

profile 准入（实然 + 应然 ratify）：
- ✓ `full`（main claw）含 spawn
- ✗ `subagent` 不含 spawn → **递归 1 层硬约束**（subagent 不能再 spawn）
- ✗ `miner` / `dream` / `verifier` 也不含

不变量：
- **递归 1 层**：main claw 是唯一编排者 / subagent 完全 sync 执行
- **subagent async 禁用**：`executor.ts` 检查 `ctx.callerType === 'claw'` / subagent 走 `async: true` 直接拒绝
- **subagent 钳制三重**：maxSteps + timeoutMs + idleTimeoutMs 任一触发即终止
- **A 类 inherently async 工具**：spawn 调用即返 schedule / 不接受 `async: true` meta（设了也无效）

**【8. 预制 subagent recipe 组织（跨通道协作）】**

预制 subagent 不引入新机制，复用 skill 工具 + nested skill 模式。多个 recipe 不污染 motion / claw 的顶层 skill 视野。

**组织形态**（skill 套娃）：

```
clawDir/skills/
├── <motion / claw 自用 skill A>
├── <motion / claw 自用 skill B>
└── spawn_recipes/                ← 单一总入口（顶层只占 1 个 entry）
    ├── SKILL.md                  ← 索引（motion 看 description 知道这是预制 recipe 库）
    ├── crash_diagnosis/
    │   ├── SKILL.md
    │   └── ...
    ├── dependency_audit/
    │   └── ...
    └── ...
```

motion 视野：list skill 看到「spawn_recipes」一个 entry，N 个 recipe 都藏在内部，顶层池子不随 recipe 数膨胀。

**跨通道协作**：

- **工具通道**（skill 工具 + spawn 工具）：
  - motion 想用预制 recipe → 用 skill 工具 read `spawn_recipes/SKILL.md` 看索引 → read 具体 recipe SKILL.md → 派 spawn 调用，intent 含 recipe path reference
  - subagent 起步后用 skill 工具 load 那个 recipe → progressive disclosure 进入子文件
- **系统提示词通道**：subagent system prompt = 系统模板 + caller intent（intent 含 recipe path）。系统模板教 subagent「intent 含 skill reference 时优先 load 那个 skill」，不需要 spawn schema 加 recipe 字段。
- **inbox 消息通道**：系统（Watchdog 等）detect 触发事件（claw 崩 / 测试失败 / etc）时，主动推 motion inbox 消息含**完整可复制的 spawn 调用模板**（含 recipe path + 必要 context），motion 决定是否 spawn。
- **任务文件通道**：spawn 创建的 SubAgentTask 落 tasks/queues/pending/<id>.json，task-recovery / inbox 投递机制全复用，无特殊路径。

**应然不引入新机制**：
- spawn 工具 schema 不加 `recipe` 字段（intent 自然 reference recipe path）
- skill 工具不加 visibility / namespace（套娃自然解 motion 视野污染）
- recipe 是 skill 内部 nested 模式 / 不是单独 concept
- 系统主动推送是 inbox 通道现有能力的应用 / 不引入新工具

### 10.2 ask_caller（spawn 配套，subagent profile only）

> subagent 向 main claw 克隆查询的通道。spawn 出的 subagent 用 ask_caller 拿 main 在 spawn 时刻的认知（不是 live main）。

**【1. 用途】**

main claw 用 spawn 时不需要写完整指令，仅表达 intent。子代理跑起来发现需要更多上下文时，通过 ask_caller 查 main 当时的认知。系统通过 marker 调用 DialogStore，还原 main 在 spawn 那一刻的 messages 和 system prompt，用 LLM-clone 模式同步回答。

**【2. 入参 schema】**

```
- question  (string, required)   subagent 想问 main claw 的具体问题
```

**【3. 返回语义】**

- 成功：`{ success: true, content: '<clone 的回答>' }`
- LLM 失败或网络错误：`{ success: false, content: '<error>' }`
- marker 找不到（DialogStore.restorePrefix 抛 `MarkerNotFoundError`）：corner case（如 archive 损坏 / 跨进程 race / toolUseId 异常）/ ask_caller 兜 fallback：返 `{ success: false, content: 'marker not found: <toolUseId>' }` / 信息不丢失原则保证主路径常找得到 / phase 457 应然 align（同 l2_dialog_store §1「历史时刻前缀恢复」+ interfaces/l2b.md MarkerNotFoundError）

**【4. 副作用 + 跨通道影响】**

- 每次 ask_caller 触发一次同步的 LLM call。subagent 阻塞等待 LLM 返回，受 subagent 自己 idleTimeoutMs 和 signal 钳制。
- 同一 subagent 内多次 ask_caller 共享 cloneHistory（in-memory 累积），让 clone 跨 ask_caller 有对话连续性。subagent 终止时 cloneHistory 销毁，不持久化，不跨 subagent 共享。
- cloneHistory 累积保持 Anthropic API 合法性（assistant tool_use 后必有匹配 tool_result）。clone 返 tool_use 块那一轮的 user question 不入 cloneHistory，避免 unresolved tool_use 污染下次 LLM call。subagent 在重问的 question 文本里 narrate 之前的工具建议和执行结果（如「按你建议 read 了 foo.md，内容是 ...，现在请回答原问题」），clone 通过文字理解因果。具体累积策略是实然内部细节，应然 silent。
- 0 fs 副作用，0 inbox，0 audit（跟普通 LLM call 同型，框架 `tool_exec` 兜底）。

**【5. profile 准入 + 不变量】**

- ✓ subagent profile（spawn 出的子代理标配）
- ✗ main claw（full），不需要，自己问自己无意义
- ✗ miner / verifier / dream / readonly

不变量：
- **clone 是 main 在 spawn 时刻的快照**。不是 live main，spawn 后 main 又跑了几 turn 跟 clone 无关。
- **subagent 只看得见创建它那刻的 main**：subagent 持有的 marker 唯一指向创建它那次 spawn 调用的 toolUseId，clone 还原的就是 main 在那一刻的快照。spawn 之后 main 又跑了几 turn 看不到，别的 spawn 创建的 subagent 也用不了这个 marker。marker 在 spawn 创建时一次性传入工具实例，运行期不变。
- **clone 持工具声明，期望文本回答**：LLM call 的 `tools` 字段保留 main 当时的工具列表（保 Anthropic prompt cache 命中，否则 prefix hash 不一致每次重填 cache，token 浪费）。系统 prompt augmentation 指示 clone「答文本，不调工具」。clone 不实际跑 work，守 spawn 设计本意。
- **clone 偶发 tool_use 转意图反馈**：如果 clone 偏要返 tool_use 块（认为需要工具结果才能回答），ask_caller 不直接拒绝，而是把 tool_use intent 转成自然语言反馈给 subagent，例如「Clone 需要 <tool_name>(<args>) 的结果才能回答，请取得后再问」。subagent 自己决定：执行那个工具拿结果再 ask 一轮，或改写 question 重问，或放弃。subagent 是 work 实际执行者，clone 只给意图建议。

**【6. clone 心智上下文设计理念】**

clone 必须知道（应然承诺信息项，具体 prompt 文本由实现期填）：
1. **它是 main claw 在本次 spawn 调用时刻的快照**。不是 live，不是任意 spawn 的 main，是这一次 spawn 那刻。
2. **当前提问者是本次 spawn 出来的那个 subagent**。不是别的 spawn 出来的，不是别的 claw。
3. **本次 spawn 的 intent**。让 clone 理解 subagent 在做什么，给出 contextually 有效的回答。

实现路径：通过 system prompt augmentation 注入这 3 项。具体文本应然 silent，实现期决定。

**【7. 关键设计决策】**

- **LLM-clone 模式**：每次 ask_caller 触发 subagent 内部一次同步 LLM call。system 部分 = main 系统提示词（marker 解析）+ wrapper（含 6 节 3 项信息）。tools 部分 = main 当时的工具声明（保 prompt cache 命中）。messages 部分 = main 历史前缀 + cloneHistory + 当前 question。
- **marker 模式**：spawn 创建时记 `{ clawId, toolUseId }`，不复制 main dialog 进 tasks/queues/pending。文件小，单一权威源 DialogStore。
- **依赖 DialogStore 接口**：「按 marker 恢复任意历史时刻前缀」对外能力（详 l2_dialog_store §A.r53-1 应然承诺 / **应然 sharpen 完成 by phase 456** / restorePrefix(marker) 接口已 phase 466 落地 (SHA 201bc6df) / L2.G5-G7 closed）。
- **同 subagent 多次 ask_caller 累积 cloneHistory**：跨 ask_caller 对话连续，subagent 不用每次重述上下文。

### 10.3 dispatch / ask_motion / done（占位 / 待统一深度讨论）

- **dispatch**（AsyncTaskSystem own）：意图挖掘 + contract 创建 / 比 spawn 复杂 / 含 mining/describing 双 mode / 暴露 motion 中介概念
- **ask_motion**（AsyncTaskSystem own）：subagent → motion 沟通的特殊工具
- **done**（ContractSystem own / 已迁 phase360）：subtask 完成信号 / 触发 contract acceptance / **不在 spawn 路径**

待 dispatch / done / ask_motion 各自 §10 讨论。

### 10.4 跨工具偏好不在本节（归系统信息通道）

「何时 spawn」「spawn vs dispatch 选哪个」「spawn 后等 inbox 的工作流」等跨工具教学归 AGENTS.md / 不写 spawn schema description。
