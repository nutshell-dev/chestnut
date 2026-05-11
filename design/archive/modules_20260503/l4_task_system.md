# TaskSystem 模块内部契约

> 本文档限本模块**内部**应然 — 8 节结构 derive 自 Module Logic Principles：§1-§4 = M#1-#4 各占一节，§5 审计 = M#3 命名空间细则，§6 层级，§7 drift = M#10/#11，§8 测试。+ §10 工具通道（仅 own agent 工具的模块；5 维度承诺 derive 自 architecture.md 表 3）。
> 跨模块对外承诺（接口签名、生产/消费方、归本模块加不归本模块、不可消除耦合理由）见 [interfaces/l4.md](../interfaces/l4.md) TaskSystem 节。
> 模块本质加层归属见 [architecture.md](../architecture.md)。

## 1. 职责（M#1 独立可变职责）

> 本节内容 derive 自 [architecture.md](../architecture.md) §21「TaskSystem 本质：基于目录队列的通用异步任务调度服务 / L4 agent 基础设施 ——『任务调度』」加 M#1 / M#2 / M#3 / M#5 / Design Principle「磁盘即权威」加「中断可恢复」。

### 做

应用 M#1（一个模块封装一组独立可变的职责），TaskSystem 的单一职责 = **通用异步任务调度 + 崩溃恢复 + 结果持久化回传**：

- **通用 task queue**：不绑死单一 task type / 派发到对应 task type 的 executor / 实然 subagent + tool 双轨语义
- **fs-driven 调度**：外部调用方直写 `tasks/pending/` / TaskSystem 内 FileWatcher 订阅 pending/ 拾起 → 状态机流转 → 派发对应 executor → 回传父 claw
- **崩溃恢复语义**：`result.txt.sent` marker = 幂等边界 / 标记过 = 完结转 done / 缺标记 = 真崩溃转 failed
- **生命周期分离**：initialize 仅复原 / startDispatch 才驱动调度循环（避免 Runtime startDispatch 前任务启动）
- **PENDING_QUEUE_MAX 同步守卫**：队列满抛同步错 / 调用方负责捕获 / 上限值由实然常量定义
- **per-task 子审计**：每任务独立 `taskAuditWriter = AuditWriter(fs, 'tasks/results/${task.id}/audit.tsv')` 记 SubAgent 内部事件 / 主 auditWriter 只记任务级（scheduled / started / completed）/ 双层归属清晰

> 具体 API 形态归 [interfaces/l4.md](../interfaces/l4.md) TaskSystem 节。具体实现细节（scheduleSubAgent / scheduleTool / writePendingSubagentTaskFile helper / cancel / shutdown / queueLength 等）的存在依据是「目录队列 + fs-driven + 崩溃恢复」原语 — 实然采纳的 method 集合差异加内部子模块拆分等登记 §7.B。

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

> 应用 M#2（模块为自己的业务语义负责），TaskSystem 的业务语义边界：

- **own**：通用任务调度 + 崩溃恢复 + 结果回传 概念。是 L4 业务唯一入口（fs ingest 子代理任务路径 + 内存路径异步 tool 历史遗留 / 待 pendingQueue 字段保留 / async tool 双轨 收敛）。
- **角色定位**：TaskSystem 是「**通用任务调度业务流程框架**」非「**单一 task type 执行器**」。本模块对所有 task type 等价处理 / 业务语义归各 executor。
- **生命周期触发归 Runtime**（initialize / startDispatch / shutdown）/ 业务实现归本模块（与 Gateway 同模式）。

## 3. 资源（M#3 资源唯一归属）

> 应用 M#3（每种资源只归属唯一模块），TaskSystem 独占的资源：

| 资源 | 类别 | 持久化 |
|---|---|---|
| `tasks/pending/<id>.json` | 持久化目录（独占）| ✓ |
| `tasks/running/<id>.json` | 持久化目录（独占）| ✓ |
| `tasks/done/<id>.json` | 持久化目录（独占）| ✓ |
| `tasks/failed/<id>.json` | 持久化目录（独占）| ✓ |
| `tasks/results/<id>/result.txt` + `.sent` marker + `audit.tsv` | 持久化（独占）| ✓ |
| `PENDING_QUEUE_MAX` | 私有常量（队列上限）| ✗ |
| pendingQueue / running map / handlers / pendingWatcher | 派生态 | ✗ |

## 4. 持久化（M#4）

> 应用 M#4（持久化一切信息到磁盘 / 运行时句柄从磁盘信息重建），TaskSystem 的持久化立场：tasks/* 五目录磁盘是权威 / pendingQueue + running map 是运行期派生态 / 重启时 initialize 扫 running/ 恢复 / startDispatch 内 _initialScanPending 重启 pending/。

### 磁盘布局

```
tasks/
├── pending/<id>.json          ← 外部直写入口（fs-driven）/ FileWatcher 订阅
├── running/<id>.json          ← 拾起后转入 / shutdown / 崩溃后 recovery 扫
├── done/<id>.json             ← 完结 / result.txt.sent marker 存在
├── failed/<id>.json           ← 失败 / 三分决策不可恢复
└── results/<id>/
    ├── result.txt             ← 大结果 offload
    ├── result.txt.sent        ← 已通过 outbox 回传 marker（幂等边界）
    └── audit.tsv              ← per-task 子 audit / SubAgent 内部事件
```

### 文件格式

- `<id>.json`：SubAgentTask 或 ToolTask 序列化 schema（含 intent / parentClawId / payload / mainContextMarker 等）
- `result.txt`：大结果 offload（subagent final output / tool result）
- `result.txt.sent`：已 outbox 回传 marker（空文件 / 0 byte / 幂等边界）
- `audit.tsv`：per-task 子审计 / 行级 audit 事件 / SubAgent 内部 LLM call 等记录

### 重建语义

`initialize()` 扫 `tasks/running/`：
- `result.txt.sent` 存在 → 转 done（幂等）
- marker 缺 + SubAgent 未报错 → 转 failed（崩溃未完成）
- `tasks/pending/` 既有文件保留原地 / `startDispatch()._initialScanPending()` 逐文件 ingest

符合 D1c「中断即从最后一次完整 LLM 调用恢复」+ D5「日志重建决策链路」。

## 5. 审计事件清单

事件常量**应然**集中定义于 `src/core/task/audit-events.ts` `TASK_AUDIT_EVENTS`（模块自治 / caller 引用 const 不硬编码字符串）。

19 个 TASK_* 事件：

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
| `task_result_write_failed` | tasks/results/<id>/result.txt 写失败 | `taskId`, `error` |
| `task_inbox_write_failed` | OutboxWriter enqueue 失败（β 双写）| `taskId`, `error` |
| `task_shutdown_timeout` | 30s in-flight 超时（β 双写 audit + console.warn）| `taskId?` |
| `task_move_failed` | running→done / failed 文件移动失败 | `taskId`, `error` |
| `task_cancelled` | cancel 路径 | `taskId` |
| `tool_task_retry` | executeToolTask 重试 | `taskId`, `attempt` |

## 6. 层级声明

L4 agent 业务流程层（与 ContractSystem / EvolutionSystem / MemorySystem 同层 / 业务语义独立可变 / 跨进程异步任务调度）。下游 Runtime（L5）通过 `createTaskSystem` 工厂消费 + 注入 deps + 持有生命周期协调权。详见 [architecture.md](../architecture.md) 加 [interfaces/l4.md](../interfaces/l4.md)。

## 7. 应然 vs 实然差距登记（M#10 / M#11）

> 原则：本节只登记**实然 ≠ 应然**的 gap（待治理或已治理的历史）+ 偏差 + 历史纪律。当前实然若与应然 align 则不在此登记。

### 7.A 必修违规（含历史已闭环）

**§7.A 4/4 全清零里程碑（phase273）**：

| §A 条 | 类型 | 状态 | 触发情境 |
|---|---|---|---|
| ~~A.1 recoverTasks 静默 + 全部 monitor.log 44 处~~ | drift | **已闭环（phase248 / SHA `4d3ef2a`）** | 45 monitor.log 全迁 audit / 12 新常量（TASK_DISCARDED 等）/ recovery 三分决策审计回链 |
| ~~A.2 inbox 写失败 + shutdown 超时 console 兜底~~ | drift | **已闭环（phase248 + phase267）** | inbox 写失败 β 双写（phase248）/ shutdown timeout audit `TASK_SHUTDOWN_TIMEOUT` + β 双写保留 console.warn（phase267 / system.ts:535-536）|
| ~~A.3 initialize 调 ensureDir('inbox/pending') 跨模块兜底~~ | drift | **已闭环（phase273）** | 删 system.ts:151 冗余调用 / InboxWriter `write()` per-write `ensureDir` 已覆盖 / M#3 资源唯一归属合规 |
| ~~A.4 SubAgent class 双路 `new`（task + contract）~~ | drift | **已闭环（phase229 / SHA `28683c4`）** | `createSubAgent` thin proxy 工厂建成 / system.ts:551 + manager.ts:1189 均切换工厂调用 / TaskSystem 仅见工厂签名（M#8 耦合界面最小）|
| A.r53-1 spawn 工具 schema 与应然背离 + ask_caller 缺工具 | semantic drift / 高 | open | 应然 §10.1 spawn schema = 极简 3 字段（intent / timeoutMs / maxSteps）/ SubAgentTask 内部用 `mainContextMarker: { clawId, toolUseId }`（marker 模式 / 不复制 main dialog messages 进 tasks/pending）。实然：(1) spawn schema 7 字段（应然砍 `tools` / `idleTimeoutMs` / `messages` / `systemPrompt`）+ field `prompt` 应改 `intent` / `timeout` 改 `timeoutMs` ms 单位 / (2) `messages` 字段实然内部传 main dialog messages 复制 / 应然改 marker / (3) **缺 ask_caller 工具**（subagent 用 DialogStore.restorePrefix 经 marker 解析 main 当时状态 / 同步 LLM clone 模式回答 subagent 问题）/ 应加进 subagent profile + l4_task_system §10 子节登记。修复路径：r54+ 实施 phase 同步（spawn schema 重整 + ask_caller 工具新建 + DialogStore A.r53-1 接口同步）。源：r53+ §10 spawn 工具通道讨论 |
| **A.spec-1 应然 `interface TaskSystem` + generic `schedule(taskType, taskData)` ↔ 实然 `class TaskSystem` + 双 entry `scheduleSubAgent`+`scheduleTool`** | spec drift / 大 | **closed**（phase414c L4 audit / interfaces/l4.md align 实然 class + 双 entry + 实然 task type discriminated union）| 历史 interfaces 写应然 `interface TaskSystem` 抽象 + generic `schedule(taskType: string, taskData: TaskData): Promise<TaskId>` + generic `TaskData = Record<string, unknown>` / 实然 = `class TaskSystem` ctor 注入 + 双 specific entry (`scheduleSubAgent(SubAgentTask)` / `scheduleTool(ToolTask)`) + 两 discriminated union types (`SubAgentTask` `kind: 'subagent'` / `ToolTask` `kind: 'tool'`) / `addTaskResultHandler` 实然 4 参 (taskId, callerType, result: string, isError) 返 string (pipeline pattern) vs 应然 2 参 (taskId, result: TaskResult) 返 void / 应然原 `TaskResult` 类型实然 0 实施（用 raw string + isError flag） / phase414c interfaces/l4.md 修订 align 实然 class + 双 entry + handler signature + 删 generic `schedule` / `TaskData` / `TaskResult` / `TaskSystemError` / `queueLength()` 5 应然幻象 |
| **A.spec-2 TaskSystem ctor 强依赖 LLMOrchestrator + ContractSystem + OutboxWriter** | scope drift / 中 | open（phase414c L4 audit 登记 / 升档条件：依赖图复杂度增长）| 应然 silent on TaskSystem ctor 依赖具体 instance / 实然 TaskSystemOptions 必须含 `llm: LLMOrchestrator` + `contractManager: ContractManager` + `outboxWriter: OutboxWriter` (phase155C ctor 合入 / 4 setter 删) / 跨同层 dep（L4 → L4 ContractManager + L2 LLM/Outbox）/ scope 已比应然 silent 暗示的范围更宽。升档条件：未来出现 TaskSystem 不需要其中某依赖的 caller 场景 → 升档评估能否 deps 可选化 |

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| B.1 L4 归属可争议（L3 执行语义 vs L4 业务语义）| design-gap / 低 | 队列 + 崩溃恢复 + 跨进程持久化压过执行语义。升档：未来拆 subagent-queue + tool-task-queue 时重审 |
| B.2 `setParentStreamLog` 运行期替换 sink | design-gap / 低（#6 显式豁免）| parentStreamLog 是「可选输出通道」非「依赖模块」/ 与 Gateway interrupt 同模式 / 归豁免登记非违规 |
| pendingQueue 字段保留 `pendingQueue` 字段保留（async tool 路径仍依赖）| drift | open / 待 async tool 清理 phase | system.ts:114 字段 + scheduleTool push + _dispatch shift / 删除即破坏 async tool 路径 |
| `listPending()` 单源（仅返 pendingQueue.map）| drift / 低 | open | phase163 后语义收窄：subagent 文件未被 watcher 拾起前不可见 / 升档：消费方需求扩展 → `listPendingAsync()` |
| async tool 与 subagent 调度源双轨 | drift | open / 待 async tool 清理 phase | subagent 经 fs / watcher / ToolTask 经 pendingQueue 内存 / 同字段混合两类任务 |
| dispatch.ts 保留 `ctx.taskSystem.addTaskResultHandler` | drift / 低 | open | callback 订阅而非调度业务语义 / 仍是反向运行期调用。升档：handler 文件化独立 phase（dispatch 写 `tasks/handlers/{id}.json`）|
| cron `silent: true` 语义失效 | design-gap / 低 | 可接受 | random-dream 改造后不再经 helper / SubAgentTask schema 无 silent 字段 / cron 任务无 viewport 父 |
| `ExecContext.taskSystem?` 字段保留 | drift | open | 三路径各自独立 phase 清理后字段方可删除 |
| `_pending-task-writer` 不写 monitor.log（仅 audit）| drift / 低 | ⚓ accepted-stable（应然 silent / 实然偏差 / phase389 anchor 标记）|
| ~~spawn / dispatch / ask_motion 工具归属变更（KD#29）~~ | drift | **已闭环（phase287 + phase347 / 4 文件全迁 src/core/task/tools/）** |
| ~~SubAgent 下移 L3 后内部子模块化评估~~ | drift | **部分消化（phase341 / SHA `7480218`）** | (b)(c)(d)+(e) 4 子模块拆出 / standalone function pattern + deps interface / system.ts 1037→544 行 / 公共 API 0 改。剩余 (a) 调度核心不拆（反向测试 #1 共享 pendingQueue / running / shutdown）|
| ~~monitor 字段保留 SubAgent 透传~~ | drift | **已闭环（phase297 / SHA `d89e392`）** | monitor 字段链路全删 |
| ~~statusTool L2→L4 type-import drift（TaskSystem field）~~ | drift | **已闭环（phase369 / main `5374a4a`）**| **framing 精化**：TaskSystem field 0 method use / 真应然 = 删 field（非 port 化 / r51 文本错位修正）/ statusTool.taskSystem 字段直接删 / 实然任务统计经 ctx.fs.list 直读已成立 / M#1 反向测试 0 共变 |
| ~~应然 §1+§3 滞后 / phase342+ audit-events 扩展未同步~~ | ~~drift / 应然滞后~~ | **✅ closed（phase385 / 应然 stale 同步条款第 5 次 / 0 代码）** | §3 已同步至 19 events（计数权威修订 / 自报 16 → 实测 19）/ §1 「不绑死单一 task type / 派发到对应 task type 的 executor」已显式 subagent + tool 双轨语义 / 应然描述与实然 align |
| **class 工厂等价异形**（DispatchTool + AskMotionTool）| design-gap / 低 | ⚓ accepted-stable（phase398 framing 精化登记）| `class XxxTool implements Tool` + ctor 注入 deps 的 OOP 工厂模式 / 应然 silent 但实然采选 / 与 file_tool / command_tool 的 `createXxx(deps)` 函数工厂 M#1+M#3+M#7 等价（反向测试：可独立换实现不动 caller）/ 命名一致性偏离（`class XxxTool` vs `createXxxTool`）但表面稳定 / 升档条件：出现「class vs 函数工厂混用造成 caller 心智负担」/ 或团队约定统一函数工厂形态 → 升档为命名一致性治理 phase（caller 风格并轨复用） |
| ~~TaskSystem 任务工具未经工厂 export~~ ⚓ accepted-stable | drift / 中 → ⚓ accepted-stable | **⚓ accepted-stable**（phase398 / Path #1 framing 精化 / 升档条件锚定）| ~~实然：spawn / dispatch / done / ask_motion 4 工具均字面量 export（`export const spawnTool` 等）~~ → phase398 Path #1 实测 4 工具异质：(1) `spawn.ts:24` 字面量 const / 0 deps（phase163 已脱依 / 工厂封装为空 / ROI 低 / ⚓ accepted-stable）/ (2) `done.ts:19` 字面量 const + ctor 后注 `contractManager` 字段（phase360 已物理迁 ContractSystem / `assemble.ts:266` 单点后注 / 升档候选非违规）/ (3) `dispatch.ts:17` `class DispatchTool implements Tool` + ctor 注入 6 deps（**class 工厂等价已合规** / M#1+M#3+M#7 与 `createXxx()` 函数工厂等价 / 反向测试可独立换实现不动 caller ✓ / 见 §B 偏差登记「class 工厂等价异形」）/ (4) `ask-motion.ts:9` `class AskMotionTool implements Tool` + ctor 注入（**已合规**）/ class 双工具不在 drift 范围 / 字面量双工具升档条件：(a) spawn 加依赖（per-claw 差异 timeout / 异 isIdempotent 默认）/ (b) done 后注 contractManager 模式被复用第 2 处 → 推 ctor 注入 / 任一触发 → reactivate α 全工厂路径 / 见 `coding plan/phase398/overview.md` / dispatch table framing 精化第 N+? 案 |

### 7.C 应然原则对照

> 仅列**应然**对各原则的承诺立场 / 不写「合规✓」claims。

#### Module Logic Principles（11 条）

- **M#1 独立可变职责**：(a) 调度核心不拆 / (b)(c)(d)(e) phase341 已拆 4 子模块（反向测试 #1 共享 pendingQueue / running / shutdown 收口）
- **M#2 业务语义归属**：调度 / recovery / 结果回传由本模块发起 / 生命周期触发归 Runtime（与 Gateway 同模式）
- **M#3 资源唯一归属**：tasks/* 五目录独占 / phase273 inbox/ ensureDir 已删
- **M#4 持久化**：subagent fs-driven ✓ / async tool 内存主存（pendingQueue 字段保留 待迁）
- **M#5 依赖单向**：L4 → L1 (FileSystem / FileWatcher) + L2 (AuditLog / Stream / SkillSystem / Messaging / ToolProtocol) + L3 (SubAgent — 派 sub-agent 实例)（per arch §21 表 1）/ 不反向依赖 Runtime / Daemon / 下游反向 import 经 type-only + 注入豁免（详 interfaces/l4.md 不可消除耦合 #3）
- **M#6 依赖结构稳定**：TaskSystemOptions ctor 一次注入 / parentStreamLog 可选 sink 显式豁免（B.2）
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
- **D3 用户可观察**：tasks/pending|running|done|failed 目录 + audit
- **D4 中断恢复**：recoverTasks 扫 running/ + result.txt.sent / 三分决策
- **D5 日志重建**：task 级 audit + 子 audit 双层
- **D6 子代理后不阻塞**：writePendingSubagentTaskFile fire-and-forget / watcher 异步 ingest / result 经 outbox 回传
- **D7 系统可信路径**：scheduleSubAgent / scheduleTool 内部 API
- **D8 事件驱动**：FileWatcher 订阅 pending/ / 不轮询
- **D9 CLI 唯一外部入口**：外部不直调 TaskSystem
- **D10 多 claw 信息不隔绝**：tasks/results/ 跨 claw 可见

#### Philosophy（4 条）

- **P1 Agent 即目录**：tasks/<id>/ 是 task 单元目录 / fs-driven
- **P2 上下文工程**：result.txt + audit 子文件 = 子代理上下文产物
- **P3 多 agent 利用**：subagent task 派生独立窗口 / 不污染父 claw
- **P4 系统为智能体服务**：提供调度 + recovery + 结果回传基础设施

#### Path Principles（6 条）

- **Path #1 实然为唯一基准**：phase341 实测 1037 行 + 4 子关注点 / 0 推翻 SubAgent 内部子模块化评估
- **Path #3 语义最小变更单元**：phase341 单 commit 拆 4 文件 / 公共 API + caller 0 改
- **Path #6 冲突立即中断**：(a) 调度核心拆出会破 #1 反向测试 / 停 / 留 thin wrapper
- **Path #8 总难度最低**：standalone function pattern（TS 惯用）/ 非 partial class
- 反向测试：本模块可独立替换 SubAgent / OutboxWriter / FileWatcher 实现而不动 caller —— M#1 ✓

### 7.D 历史纪律

详 phase163 / phase173 / phase229 / phase248 / phase267 / phase273 / phase297 / phase324+325 / phase338 / phase341 / phase347 / phase385 各 phase 收尾报告 (`coding plan/phase<N>/`)。

关键里程碑：
- 2026-04-20 / phase163 SubagentSystem ↔ TaskSystem 运行时循环消除（writePendingSubagentTaskFile 文件直写 / scheduleSubAgentWithTracking helper 删）
- 2026-04-21 / phase173 模块层级重划（L4 SubagentSystem 废止 / SubAgent 下移 L3 / 工具归 L4 / KD#5 划线）
- 2026-04-22 / phase229 createSubAgent thin proxy 工厂建成（A.4 闭环 / SubAgent 双路 new 收窄）
- 2026-04-23 / KD#29 spawn/dispatch/ask_motion 工具归属归 TaskSystem(L4)
- 2026-04-24 / phase248 §7.A A.1 清零（45 monitor.log 全迁 audit / 12 新常量）
- 2026-04-24 / phase267 §7.A A.2 shutdown timeout 清零（TASK_SHUTDOWN_TIMEOUT audit + β 双写）
- 2026-04-24 / phase273 §7.A 4/4 全清零里程碑（A.3 删 ensureDir 冗余 + A.4 drift 修正）
- 2026-04-25 / phase297 monitor 字段链路全删
- 2026-04-26 / phase324+325 应然 framing drift 修订（§19→§20 / ToolRegistry L2 标注）
- 2026-04-27 / phase338 H1 audit-events.ts 模块自治拆分（TASK_AUDIT_EVENTS 物理迁出全局 events.ts）
- 2026-04-27 / phase341 H5 TaskSystem 单文件内部拆分（SubAgent 内部子模块化评估 部分消化 / 4 子模块 + standalone function + deps interface / M9 第 3 实证）
- 2026-04-27 / phase347 KD#29 子任务 b+c dispatch 物理迁完成 / spawn/dispatch/ask_motion 工具归属变更 闭环
- r60+ 重编号：9 节 → 8 节 / 每节 derive 自一条 Module Logic Principle（详顶部 docblock）

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| ~~KD#5~~ | ~~SubagentSystem 合并 TaskRunner~~ | 废止（phase173 / 执行原语 vs 生命周期管理拆分）|
| KD#6 | dispatch / spawn 独立工具 / 归 TaskSystem(L4) 导出 | ✓（phase347 物理迁）|
| KD#29 | spawn / dispatch / ask_motion 工具归 TaskSystem(L4)| ✓ 工具归属变更 闭环 |
| KD#30 | ContractSystem LLM 验收经 TaskSystem 调度 | 部分实施（H11 完整 / H6 异步化推 r41+ design / 见 l4_contract_system §7）|

## 8. 测试覆盖

应然行为（不绑定具体测试文件路径）：

- **scheduleSubAgent / writePendingSubagentTaskFile**：fs 直写 tasks/pending/{id}.json + audit `task_scheduled` + watcher 异步拾起
- **scheduleTool**：async tool 内存路径 + executeToolTask 重试 + sendToolResult OutboxWriter 回传
- **dispatch 主路径**：subagent fs ingest → _ingestPendingFile → push pendingQueue → _dispatch → movePendingToRunning → executeTask
- **崩溃恢复**：扫 running/ 三分决策（marker 存在转 done / 缺 marker 转 failed）+ audit 回链
- **结果持久化**：tasks/results/<id>/result.txt + .sent marker + audit.tsv 子审计
- **shutdown 超时**：30s in-flight 触发 audit `TASK_SHUTDOWN_TIMEOUT` + β 双写 console.warn
- **cancel**：单任务 cancel + audit
- **PENDING_QUEUE_MAX**：队列满抛同步错
- **生命周期分离**：initialize 仅复原 / startDispatch 才驱动调度循环（phase163 强化纪律）
- **审计回链**：每个 §5 TASK_* 事件触发时机 + 载荷断言（19 events 全覆盖）
- **per-task 子审计**：每任务独立 taskAuditWriter 写 SubAgent 内部事件
- **pendingQueue 字段保留/3/4 待清 path**：async tool 双轨 + dispatch handler 残留 / 不补测覆盖 / 待 async tool 清理 phase

## 10. 对智能体的承诺（工具通道）

> 5 维度结构（用途 / 入参 / 返回语义 / 副作用+跨通道 / profile准入+不变量）。失败语义留全工具集统一深度讨论。
> TaskSystem own 的 agent 工具：spawn / dispatch / ask_motion（L4）/ done 已迁 ContractSystem（phase360 / 不在本契约）。

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
- **timeout 单位改 ms**（`timeoutMs`）/ 跟 exec / TaskSystem 其他超时字段一致命名（实然 `timeout` 秒不一致）

**【2.1 SubAgentTask 内部字段（agent 不可见）】**

```
SubAgentTask 内部 schema 含:
- intent: string
- mainContextMarker: { clawId, toolUseId }    ← marker 模式（NEW）/ 不复制 main 整个 dialog
- timeoutMs / maxSteps / parentClawId / etc
```

**marker 模式**（替代实然 `messages` 字段复制 main dialog）：
- spawn 创建 SubAgentTask 时 / 仅记录 marker = main claw id + 当前 spawn 调用的 toolUseId
- 不复制 main dialog messages 进 tasks/pending/<id>.json（文件小 / 0 数据冗余）
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
- 创建期失败（`tasks/pending/` 写失败 / queue 满）→ `success: false` 立即返 / **不入 inbox**

**阶段 2 / 完成投递**（异步 / 经 inbox）：

| 场景 | 触发 | inbox 消息形态 |
|---|---|---|
| 自然完成 | LLM 输出 final response（不再 call tools）/ ReAct loop 终止 | `success: true` + 结论 / 大结果走 `tasks/results/<id>/result.txt` resultRef |
| timeout kill | 超 spawn 自身 timeoutMs | `success: false` + `[clawforum spawn]` 文案 + partial result + resultRef |
| maxSteps 钳制 | 用完 max steps | `success: false` + 「reached max_steps=<N>」+ partial + resultRef |
| idle timeout | LLM 不出 token 超 idleTimeoutMs（system 默认）| `success: false` + 「LLM idle timeout」+ partial + resultRef |
| LLM error | API 失败 / 网络 / 等 | `success: false` + error message |

**关键承诺**：
- **失败也走 inbox 投递**（除创建期同步失败立即返）
- **partial result 必返**（即使没完成 / 让 caller 看到 subagent 已做的）
- **error 文案 `[clawforum spawn]` prefix 明示框架触发**（跟 exec timeout 同型 / 区分 OS-level kill）
- **失败 inbox metadata 含 taskAuditPath**（指向 `tasks/results/<id>/audit.tsv`）。实然每 task 有 per-task audit subwriter 记 LLM tool call 历史 / 应然 ratify 这条路径暴露给 caller。caller 看 audit 推 partial 进度，决定续做策略。
- **partial 副作用承诺局限性**：subagent 跑到一半 crash，已做的 fs / exec 副作用不可撤销（distributed systems 难题）。clawforum 提供 audit 透明化，不提供自动 rollback。caller 收到 partial 失败应**看 audit 派精确续做 intent**（含「前任已完成 X / Y / 你从 Z 继续」），而不是简单重派同 intent（重做 sequence 整体在 fs 实然变化后可能错）。AGENTS.md 教 caller 这个 retry 模式。
- **summary 由 LLM 主动写**（不 mechanical 截前 N 字）：subagent system prompt 模板教 subagent「final response 应包含浓缩 summary 给 caller，便于 caller 不用展开 details 就能拿到结论」。result-delivery 取 LLM 写出的 summary 段当 inbox 消息内容。这样 summary 是有意识的浓缩，不是随机字符截断。具体格式约定（markdown 标题 / 显式 marker / 长度建议）由 system 模板设计，应然 silent on 文本细节。
- **maxSteps 默认 100**：实战足够，复杂任务 caller 可通过入参显式调高。
- **timeoutMs 默认值 TBD**：实然 SPAWN_DEFAULT_TIMEOUT_S=300（5min）/ 应然层难定标准（spawn 任务千差万别）/ 留实然调参 + agent 入参 override。

**【4. 副作用 + 跨通道影响】**

- **fs 写**：`tasks/pending/<id>.json`（创建即写）/ 完成时 `tasks/results/<id>/` + `.sent` marker + 子 audit
- **跨通道**：完成结果经 inbox（L2 Messaging）投递 / 大结果走 results/<id>/result.txt resultRef
- **主 claw 拿到 inbox summary 后**：
  - 默认 = summary 够用（spawn 设计本意「只要结论」/ 见 §10.1.1 用途）
  - 真要 full → **再 spawn**（不直接 read tasks/results/<id>/result.txt / 否则污染 context 违反 spawn 初衷）
- **claw 重启**：`task-recovery.ts` 扫 pending/running 恢复任务（不丢 task）
- **audit**：每次 spawn 经 L2 Tools 框架 `tool_exec` + TaskSystem 自身 `task_scheduled` / `task_started` / `task_completed` / per-task 子 audit `tasks/results/<id>/audit.tsv` 记 subagent 内部事件

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
- **任务文件通道**：spawn 创建的 SubAgentTask 落 tasks/pending/<id>.json，task-recovery / inbox 投递机制全复用，无特殊路径。

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
- 不存在「marker 找不到」失败模式（信息不丢失原则保证 DialogStore.restorePrefix 永远找得到）

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
- **marker 模式**：spawn 创建时记 `{ clawId, toolUseId }`，不复制 main dialog 进 tasks/pending。文件小，单一权威源 DialogStore。
- **依赖 DialogStore 接口**：「按 marker 恢复任意历史时刻前缀」对外能力（详 l2_dialog_store §A.r53-1 应然承诺）。
- **同 subagent 多次 ask_caller 累积 cloneHistory**：跨 ask_caller 对话连续，subagent 不用每次重述上下文。

### 10.3 dispatch / ask_motion / done（占位 / 待统一深度讨论）

- **dispatch**（TaskSystem own）：意图挖掘 + contract 创建 / 比 spawn 复杂 / 含 mining/describing 双 mode / 暴露 motion 中介概念
- **ask_motion**（TaskSystem own）：subagent → motion 沟通的特殊工具
- **done**（ContractSystem own / 已迁 phase360）：subtask 完成信号 / 触发 contract acceptance / **不在 spawn 路径**

待 dispatch / done / ask_motion 各自 §10 讨论。

### 10.4 跨工具偏好不在本节（归系统信息通道）

「何时 spawn」「spawn vs dispatch 选哪个」「spawn 后等 inbox 的工作流」等跨工具教学归 AGENTS.md / 不写 spawn schema description。
