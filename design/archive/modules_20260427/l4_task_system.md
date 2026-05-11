# TaskSystem 接口契约

L4 任务与业务层。**应然**（2026-04-26 修订 / 跟 modules.md ~~§19~~ §20 align）：通用异步任务调度 + 崩溃恢复 + 结果持久化回传——generic task queue / 不绑死单一 task type；外部调用方直写 `tasks/pending/`，TaskSystem 内 FileWatcher 订阅 pending/ 拾起 → 状态机流转 → 派发到对应 task type 的 executor → 回传父 claw。被 Runtime 构造期注入后由 Runtime 协调生命周期（initialize / startDispatch / shutdown / setParentStreamLog），业务语义（调度循环 / recovery / 结果回传）归 TaskSystem 自身实现。

**实然**：当前只装 subagent task type（spawn / dispatch / done）；历史上曾支持所有 async tool；未来若 tool async 恢复或新 task type 引入可重新支持。

**phase341 内部拆分**（r40 C / SHA `7480218` / 2026-04-27）：`system.ts` 1037 行 → 544 行（降 48%）拆 4 子模块：
- `task/result-delivery.ts`（188 行）— sendResult / sendToolResult / sendFallbackError
- `task/task-recovery.ts`（124 行）— recoverTasks
- `task/subagent-executor.ts`（175 行）— executeTask（SubAgent 创建+执行）
- `task/tool-executor.ts`（121 行）— executeToolTask（回调+重试）

system.ts 保留调度+生命周期+thin wrapper / 公共 API 0 改 / caller import 通过 `task/system.js` re-export 0 改 / 测试 0 改。详 §7 B.p173-1 + Phase 执行纪律 phase341。

归属：L4 任务与业务。
- **应然依赖**：FileSystem（L1）、LLMService（L1）、AuditLog（L2）、FileWatcher（L1）、StreamLog（L2）、SkillRegistry（L2）、OutboxWriter（L2 Messaging）、L3 执行原语接口（按 task type / 实然仅 SubAgent）
- **实然依赖**：+ ToolRegistry（L2 Tools / 内部自持）、~~ContractManager（L4 同层 / 关键决策 #30 移除中）~~

**粗糙期说明**：phase158 首次登记，按"登记现状"原则——A 类违规（recovery 静默、3 处 console、跨模块 inbox ensureDir、SubAgent class 双路 new）仅列入 §7 不修；内部实现 1122 行不动；SubAgent class 归属已由 phase173 界定（见下）。

**phase163 更新**（2026-04-20）：消除 SubagentSystem ↔ TaskSystem 运行时循环耦合。spawn / dispatch 工具改经 `writePendingSubagentTaskFile(fs, audit, args)` 直写 `tasks/pending/{id}.json`，不再调 `taskSystem.scheduleSubAgent`。TaskSystem 经 FileWatcher 订阅 pending/ 异步拾起（`_ingestPendingFile` → push pendingQueue → `_dispatch`）。运行期真单向依赖；§5 原 "B.2 / #5 反向 type-only 依赖豁免" 收窄至剩 status（只读 queueLength）/ scheduleTool（async tool）/ dispatch（addTaskResultHandler）三条。详 §7 新增"phase163"子节与 B.p163-* 清单。

**phase173 更新**（2026-04-21，模块层级重划）：
- 原 L4 SubagentSystem 模块**废止**，按 meta-principle「执行原语 vs 生命周期管理 = 独立可变职责」拆分：
  - `SubAgent` class 下移 **L3 执行原语**（`l3_subagent.md`，原 `l4_subagent_system.md` 已 rename）
  - spawn/dispatch/ask_motion 工具 + `writePendingSubagentTaskFile` 原语 → 未来 L3 tools 契约
- **TaskSystem 新邻居关系**：原"SubAgent class L4 同层"表述废止；现为 `L4 TaskSystem → L3 SubAgent`（向下依赖合规，非循环）
- A.4 修复路径更新：指向 `l3_subagent.md`（原指 `l4_subagent_system.md`）
- modules.md 关键决策 #5 已划线废止，详见 `feedback_primitive_vs_lifecycle_split.md` + `feedback_default_split_not_merge.md`

## 1. 所有权

### 归属层

L4 任务与业务。被谁调用：

- **Runtime**：构造期持有 `taskSystem: TaskSystem` 字段（runtime.ts:76 / 151 / 204）；`Runtime.initialize()` 内顺序调 `taskSystem.initialize()` + `startDispatch()`（runtime.ts:218-229）；`Runtime.stop()` 调 `taskSystem.shutdown(30_000)`（runtime.ts:280）；`setStreamCallbacks` 运行期调 `taskSystem?.setParentStreamLog(sink)`（runtime.ts:912）；对外暴露 `getTaskSystem(): TaskSystem` getter（runtime.ts:875）
- **Assembly**：`assemble.ts:211` 构造点（phase158 Step 4 改为 `createTaskSystem(...)`）；`Instances` 接口**不含** taskSystem 字段，Runtime 独占持有
- **ToolExecutor / SubAgent / CronJob**（**phase163 后收窄**）：通过 ExecContext / opts 可选注入 `taskSystem?: TaskSystem`，仅三条合法消费路径保留——
  - `status` 工具（`ctx.taskSystem.queueLength()` 只读展示）
  - `executor.ts` `scheduleTool`（async tool 路径，独立 phase 清理候选）
  - `dispatch` 工具（`ctx.taskSystem.addTaskResultHandler` 注册，B.p163-4）
  - spawn 工具 + dispatch 调度路径 + cron random-dream + daemon retrospective 均经 `writePendingSubagentTaskFile(fs, audit, args)` 直写 `tasks/pending/{id}.json`，**不再持 taskSystem 实例**
- **Daemon**：`cli/commands/daemon.ts` retrospective 调度改经 `writePendingSubagentTaskFile`（phase163）；不再经 `runtime.getTaskSystem().scheduleSubAgent`

### 职责（做）

**应然**（generic task queue / 跟 modules.md ~~§19~~ §20 align）：

1. **通用任务队列**（fs-driven）：外部调用方按 task type 直写 `tasks/pending/{id}.json`；TaskSystem `startDispatch()` 内构造 FileWatcher 订阅 pending/，新文件 add 事件触发 ingest → 状态机流转 → 按 task type 派发到对应 executor → done / failed 收口。**不绑死单一 task type**——subagent / async tool / 未来 task type 共用同一调度框架与 `tasks/` 目录结构
2. **崩溃恢复**：`initialize` 扫 `tasks/running/` 残留，按 `result.txt.sent` marker 区分"完结未清理"与"真崩溃未完成"→ 转 done/failed；`tasks/pending/` 既有文件保留原地，由 `startDispatch` 内 `_initialScanPending()` 逐文件 ingest（走 watcher 同款路径）
3. **结果持久化 + 回传**：大结果 offload 到 `tasks/results/{taskId}/result.txt` + `.sent` marker + per-task `audit.tsv` 子审计；通过 OutboxWriter 回传父 claw
4. **生命周期统一收口**：`shutdown` 通过 AbortController 取消 running、等 in-flight 或超时（默认 30s）

**实然**（当前 task type 实装范围）：

1. **subagent task type**（phase163 起 fs-driven）：外部调用方（spawn / dispatch / cron / daemon）经 `writePendingSubagentTaskFile` 写 `tasks/pending/{id}.json`；watcher add 事件触发 `_ingestPendingFile` → push pendingQueue（transient buffer）→ `_dispatch()` → `movePendingToRunning` → `executeTask` 驱 SubAgent LLM 会话 → done / failed 收口。`scheduleSubAgent` 方法仍在（内部写文件 + audit）
2. **tool task type**（内存路径 / 历史遗留）：`scheduleTool` 入 pendingQueue → `_dispatch` → `executeToolTask` 执行异步 tool（非内置同步路径）→ `sendToolResult` 通过 OutboxWriter 回调父 claw。**B.p163-1/3**：subagent 与 tool 在 pendingQueue 上双轨（subagent 文件驱动、tool 内存驱动），历史上曾支持所有 async tool / 未来若 tool async 恢复可重新支持 / 待 async tool 清理 phase 收敛
3. **executor 派发实然 hard-coded**：当前只识别 subagent / async tool 两条 executor 路径；不存在 task type registry 抽象

### 不做

- 不解析具体 task type 业务语义（应然：透传 task payload 给对应 executor；实然：只把 task.prompt / task.tools 透传给 SubAgent.run）
- 不直接调 LLM（应然：LLM 调用归各 task type 的 executor 内部；实然：通过 SubAgent class 间接，SubAgent 内部调 LLMService）
- 不维护 agent 间协作协议（dispatcher / spawn 等工具语义归各 tool / executor 实现）
- 不跨模块直接写 inbox / outbox 语义（通过 OutboxWriter 接口回调；**A.3 违规历史**：`initialize` 对 `inbox/pending` ensureDir 是跨模块兜底，phase273 已清零 / §7 登记）
- 不做任务优先级 / 配额 / 资源争用仲裁（pendingQueue FIFO + maxConcurrent 硬限，无高级调度）

### 业务语义

「通用任务调度 + 崩溃恢复 + 结果回传」业务语义唯一入口：fs ingest（应然：所有 task type / 实然：subagent）+ scheduleTool（实然：async tool）/ dispatch 循环 / recoverTasks / sendResult 全归 TaskSystem 发起。**生命周期控制（initialize/startDispatch/shutdown）触发时机归 Runtime**（与 Gateway start/stop 由 Daemon 触发同模式），但业务实现归 TaskSystem。

### 资源

| 资源 | 类别 | 归属位置 |
|---|---|---|
| `tasks/pending/<id>.json` | 持久化目录（独占） | TaskSystem 独占；`initialize():140` 创建 |
| `tasks/running/<id>.json` | 持久化目录（独占） | TaskSystem 独占；`initialize():141` 创建 |
| `tasks/done/<id>.json` | 持久化目录（独占） | TaskSystem 独占；`initialize():142` 创建 |
| `tasks/failed/<id>.json` | 持久化目录（独占） | TaskSystem 独占；`initialize():143` 创建 |
| `tasks/results/<id>/result.txt` + `result.txt.sent` marker + `audit.tsv` | 持久化目录（独占） | TaskSystem 独占；常量 `TASKS_RESULTS_DIR = 'tasks/results'` @ `src/types/paths.ts:12` |
| ~~`inbox/pending/` ensureDir~~ | ~~⚠️ 跨模块（Messaging 归属）~~ | ~~`initialize():146` 对其 ensureDir——**A 类违规**~~（§7 A.3 phase273 已清零 / 行删除）|
| `PENDING_QUEUE_MAX = 1000` | 私有常量 | `system.ts:321` `private static readonly`，TaskSystem 独占（不定制化） |
| `DEFAULT_MAX_CONCURRENT_TASKS` / `DEFAULT_LLM_IDLE_TIMEOUT_MS` | 跨模块常量 | `src/constants.ts`；TaskSystem 仅消费 |
| `pendingQueue` / `running` map / `handlers` / `registry` / `llm` / `skillRegistry` / `contractManager` / `outboxWriter` / `auditWriter` / `parentStreamLog` / `retryBaseDelayMs` / `maxConcurrent` / `pendingWatcher` | 运行时派生态 | `system.ts` 实例字段；队列状态靠 `tasks/` 目录跨进程存活，实例字段仅运行期指针。phase163 后 `pendingQueue` 对 subagent 仅为 "watcher add → _dispatch shift" 瞬时 transient buffer（文件是权威载体，B.p163-1/2）；对 ToolTask 仍为主存储（async tool 路径）。`pendingWatcher` 为 startDispatch 构造的 chokidar 句柄 |

## 2. 接口

### 类型签名

```ts
// src/core/task/system.ts:30-40
export interface TaskSystemOptions {
  maxConcurrent?: number;
  auditWriter: AuditWriter;
  retryBaseDelayMs?: number;
  parentStreamLog?: StreamLog;
  llm: LLMService;                   // phase155C: 从 setter 合入 ctor
  skillRegistry: SkillRegistry;       // phase155C
  contractManager: ContractManager;   // phase155C
  outboxWriter: OutboxWriter;         // phase155C
}

// src/core/task/system.ts:81, 119-137
export class TaskSystem {
  constructor(
    private clawDir: string,
    private fs: FileSystem,
    options: TaskSystemOptions,
  );
  async initialize(): Promise<void>;                                                    // :138
  startDispatch(): void;                                                                // :156
  setParentStreamLog(sink: StreamLog): void;                                            // :317
  async scheduleSubAgent(
    taskData: Omit<SubAgentTask, 'id' | 'createdAt'>,
  ): Promise<string>;                                                                   // :346 (phase163: 仅写 tasks/pending/{id}.json + audit；不 push/dispatch；watcher 异步拾起)
  async scheduleTool(
    toolName: string,
    input: unknown,
    parentClawId: string,
    callerId: string,
    toolCallId: string,
  ): Promise<string>;                                                                    // :375
  addTaskResultHandler(h: TaskResultHandler): () => void;                               // :103
  listRunning(): string[];                                                              // :1032
  listPending(): string[];                                                              // :1039
  async cancel(taskId: string): Promise<void>;                                          // :1046
  async shutdown(timeoutMs?: number): Promise<void>;                                    // :1099 (default 30000)
}
```

### 关键约定

- **构造期副作用**：构造函数内创建 `registry = new ToolRegistryImpl()` + `registerBuiltinTools(registry)`。工厂层（phase158 Step 3 引入的 `createTaskSystem`）透传此副作用，不做代理外加工。
- **initialize / startDispatch 分离**（phase163 强化）：`initialize()` 负责"建目录 + recovery 文件回搬"（running→pending 文件移动 + done/failed 归档）；`startDispatch()` 负责"构造 FileWatcher + `_initialScanPending` 初始扫盘 + 启动调度循环"。**初始扫描必须放 startDispatch 而非 recoverTasks 末尾**——`_ingestPendingFile` 内含 `_dispatch()` 触发，放在 initialize 期间会让任务在 Runtime `startDispatch()` 前启动，违反"initialize 仅复原 / startDispatch 才驱动"边界（Step 3-1 纠错教训，详 §7 Phase 执行纪律）。**#2 归属辨析**：调度循环 / recovery 的业务语义归 TaskSystem 内部实现（业务由该模块发起）；触发时机（start/stop）归上层协调者 Runtime。Assembly 只构造不调。
- **`PENDING_QUEUE_MAX = 1000`**：队列满抛 `pendingQueue full` 同步错误；调用方负责捕获。
- **shutdown idempotent**：再次调 shutdown 不抛；未 initialize 的 shutdown 直接 return。
- **`result.txt.sent` marker 幂等边界**：recovery 扫 `tasks/running/` 时，marker 存在 = 已通过 outbox 回传，转 done；不存在且 SubAgent 未报错 = 崩溃未完成，转 failed。

### 失败分类

| 类别 | 形态 | 例子 |
|---|---|---|
| 同步输入拒绝 | throw Error | `pendingQueue` 满（scheduleSubAgent / scheduleTool 同步路径；`TaskSystem.PENDING_QUEUE_MAX = 1000`） |
| 异步执行失败 | 内部 catch → 走 failed / audit `task_completed, err` | SubAgent.run throw / tool.execute throw |
| 回传失败 | console.error 兜底（A.2 违规，§7 登记） | sendResult / sendToolResult 内 OutboxWriter 失败（system.ts:884, 967） |
| shutdown 超时 | console.warn 兜底（A.2 违规） | 30s 仍有 in-flight（system.ts:1113） |
| recovery 路径 | 静默（A.1 违规） | recoverTasks 内三分决策（完结 / 失败 / 未知）无 audit 事件 |

## 3. 审计事件清单

TaskSystem 当前实然事件数 = **4 唯一事件名**（phase163 新增 `pending_ingest_failed`；见 §7 A.1 登记 recovery 路径静默违规）：

| 事件名 | 触发位置（行） | 载荷字段 |
|---|---|---|
| `task_scheduled` | `scheduleSubAgent` / `scheduleTool` / **`writePendingSubagentTaskFile`**（phase163 新增路径） | `taskId`, `kind=subagent\|tool`, `parent=<clawId>`, `tool=<name>`（tool 任务时） |
| `task_started` | `movePendingToRunning` 成功后 | `taskId` |
| `task_completed` | `executeTask` 成功 / 失败 / `executeToolTask` 成功 / 失败 | `task.id`, `ok\|err`, `ms=<elapsed>` |
| `pending_ingest_failed`（phase163 新增） | `_ingestPendingFile` catch | `taskId` / `<unknown>`, `path=<filePath>`, `reason=<err>` |

**缺失事件**（A 类违规登记在 §7 A.1 / A.2）：

- `task_recovery_start` / `task_recovery_complete`（`recoverTasks` 路径 system.ts:165-316 **完全静默**）—— §7.A A.1（phase248 已清零）
- `task_cancelled`（`cancel` 路径 :1046 无 audit）—— §7.A A.1（phase248 已清零）

### 子审计（per-task）

每个任务执行期构造独立 `taskAuditWriter = new AuditWriter(fs, 'tasks/results/${task.id}/audit.tsv')`（system.ts:514），记录该任务 SubAgent 内部事件；主 `auditWriter` 只记任务级事件（scheduled / started / completed），子 audit 记会话级事件。双层归属清晰——符合 Philosophy "事后仅凭日志和记录能完整重建任一时刻的运行状态和决策链路"（**除 recovery 路径外**，A.1 违规）。

## 4. 上游依赖

**应然**（generic task queue）：依赖 L1（FileSystem / LLMService）+ L2（AuditWriter / FileWatcher / StreamLog / SkillRegistry / OutboxWriter）+ **L3 执行原语接口**（按 task type 派发到对应 executor，不绑死单一 class）。

**实然**：当前 L3 executor 仅 SubAgent 一种（经 `createSubAgent` 工厂注入）；未来按 task type 扩展其他 executor 时新增依赖项。

| 依赖契约 | 消费面 |
|---|---|
| `l1_filesystem.md`（FileSystem） | ctor 注入；`tasks/` 子目录创建、task 文件读写、`result.txt` / `.sent` marker |
| `l1_llm_service.md`（LLMService） | `TaskSystemOptions.llm` 必传；**应然**：透传给各 task type executor；**实然**：透传给 SubAgent / ContractManager 子调用 |
| `l2_audit_log.md`（AuditWriter） | `TaskSystemOptions.auditWriter` 必传；主事件 + per-task 构造子 Writer |
| `l2_file_watcher.md`（FileWatcher） | `startDispatch` 内 `createWatcher(fs, TASKS_PENDING_DIR, callback, audit, { stability: 'immediate', recursive: false, persistent: true })`（phase163）；监听 pending/ 目录 add 事件驱动 ingest |
| `l2_stream.md`（StreamLog） | `TaskSystemOptions.parentStreamLog` 可选；executeTask 内把子 agent stream 事件镜像到上层（运行期可替换，见 §5 #5） |
| **L3 执行原语**（应然：按 task type / 实然：仅 SubAgent class） | **应然**：按 task type 派发到对应 executor 接口；**实然**：`createSubAgent(opts): SubAgent` 工厂调用 @ system.ts:551 作一次性 worker（phase229 工厂化清零原 `new SubAgent` 双路；**关键决策 #30 后 ContractSystem 不再直接 new SubAgent**）|
| SkillRegistry（L2） | `TaskSystemOptions.skillRegistry` 必传；透传给 SubAgent.options |
| ~~ContractManager（L4）~~ | ~~`TaskSystemOptions.contractManager` 必传；透传给 SubAgent.options~~ **关键决策 #30 移除**：done 工具由 ContractSystem 导出内部持有引用，不需 TaskSystem 透传 |
| OutboxWriter（L2 Messaging） | `TaskSystemOptions.outboxWriter` 必传；`sendResult` / `sendToolResult` 调 enqueue 回父 claw |
| ToolRegistry（L2 Tools / TaskSystem 内部自持） | ctor 内 `new ToolRegistryImpl()` + `registerBuiltinTools(registry)`——**实然**：TaskSystem 为 SubAgent 准备独立工具表；**应然**：归 task type executor 自管 |
| Monitor / JsonlLogger | ctor 构造；`logs/` 子目录（B.p248-1 / phase297 已删 monitor 字段链路） |

## 5. 不可消除的耦合

**应然**（generic task queue）：耦合面向 OutboxWriter（结果回传通道）+ L3 executor 接口（按 task type 派发）+ parentStreamLog（可选输出 sink）；不绑死单一 executor class。

**实然**：当前 L3 executor 仅 SubAgent 一种（耦合 #2 工厂值依赖 / phase229 已收窄至工厂签名）；spawn / dispatch / cron / daemon 反向引用经 phase163 收窄至三条合法非循环路径。

| # | 方向 | 是否类型化 | 消除路径 / 放弃理由 |
|---|---|---|---|
| 1 | TaskSystem → OutboxWriter（结果回传） | 类型化（OutboxWriter 接口） | 放弃消除：任务完成必须把结果回传父 claw，outbox 是唯一跨进程通道 |
| 2 | TaskSystem → SubAgent 工厂依赖（`createSubAgent({...})`） | 值依赖（`import { createSubAgent }` 工厂调用） | **phase229 已清零**（`28683c4` / 2026-04-22）：`createSubAgent` thin proxy 建成；TaskSystem 只见工厂签名，不见 SubAgent 内部字段；原 `new SubAgent` 双路改工厂 |
| 3 | ToolExecutor / SubAgent / CronJob → TaskSystem?（**phase163 后收窄**的反向 type-only 依赖） | 类型化（`taskSystem?: TaskSystem` 可选字段 + type-only import） | **#5 显式豁免 + phase163 收窄**：phase163 前 spawn / dispatch / cron / daemon 均经 `ctx.taskSystem.scheduleSubAgent` 运行期调用 TaskSystem 实例——**这是真循环耦合**（被 phase159 §5 以"import type 单向编译"诡辩合规化，phase163 用户 2026-04-20 收紧判据后升为 A 类违反）。phase163 消除：spawn / dispatch / cron / daemon 改经 `writePendingSubagentTaskFile(fs, audit, args)` 直写文件；TaskSystem 经 FileWatcher 异步拾起。**运行期真单向依赖**。当前残留三条合法反向引用：① `status.ts` 读 `queueLength()`（只读展示）；② `executor.ts:181` `scheduleTool`（async tool 路径，独立 phase 清理候选）；③ `dispatch.ts` `addTaskResultHandler`（B.p163-4，handler 文件化推后）——均非调度业务语义，不构成循环 |
| 4 | TaskSystem → `inbox/pending` ensureDir（跨模块资源） | 非类型化（直接 `fs.ensureDir` 字面量） | **phase273 已清零**：删 `system.ts:151` 冗余 ensureDir；InboxWriter per-write 自建目录 |
| 5 | TaskSystem → parentStreamLog 镜像事件（可选输出 sink，运行期可替换） | 类型化（StreamLog 接口） | 放弃消除：任务内 SubAgent stream 事件需向上传到父 claw 的 stream.jsonl；**#6 显式豁免**——sink 是"运行期注入的可选输出通道"非"依赖模块"，#6 约束的是"模块间依赖关系"不可变，不约束运行期可选输出端点；Runtime 倒置注入与 Gateway `interrupt` 回调同模式（§7 B.2 按"豁免登记"归类） |

详述：

1. **OutboxWriter 回传**：task 完结后走 outbox 是跨进程唯一通道，不走 outbox 则子 claw 结果丢失。outbox 队列本身归 Messaging 模块，TaskSystem 通过 OutboxWriter 接口间接访问，合 #3 每种资源只归属唯一模块。

2. **SubAgent 值依赖**：`new SubAgent({...})` 直接构造，TaskSystem 对 SubAgent 构造选项知识全量（options 13+ 字段）。**双重违规**：#3 单一归属（SubAgent class 被 task + contract 双路 new）+ #8 耦合界面最小（TaskSystem 需知道 SubAgent 全部构造选项）。消除路径：phase159 把 `new SubAgent` 改为注入 `createSubAgent(options): SubAgent` 工厂——TaskSystem 只见工厂签名不见内部字段。

3. **反向依赖 phase163 收窄**：phase159 §5 原登记"ToolExecutor / ToolContext / builtins / SubAgent / CronJob 全 type-only"——事实层是对的，但掩盖了**运行期 `ctx.taskSystem.scheduleSubAgent` 调用仍在**的真实循环。phase163 用户 2026-04-20 收紧原则 #5 判据："通过 import type 规避或 callback 注入不算合规；运行时业务语义循环 = A 类违反"。phase163 落地后：spawn / dispatch / cron / daemon 的调度路径改走 `writePendingSubagentTaskFile(fs, audit, args)`，不再持 TaskSystem 实例；残留三条合法反向引用（status queueLength / async tool scheduleTool / dispatch handler）均非调度业务语义，合规。

4. **inbox/pending 违规**：TaskSystem `initialize():146` 直接 `fs.ensureDir('inbox/pending')`——违 #3，已登记待修，phase170+ scope。

5. **parentStreamLog 可选（#6 显式豁免）**：Runtime 在 `setStreamCallbacks` 运行期调 `setParentStreamLog(sink)`（system.ts:317 / runtime.ts:912）。**统一口径**：sink 是"可选输出通道"而非"依赖模块"，#6 约束的是"模块间依赖关系"不可变，不约束运行期注入的可选输出端点；Runtime 倒置注入 sink 的模式等同 Gateway 的 `interrupt` 回调注入——属 #6 的显式豁免项，不是"违规 + 可接受"（§7 B.2 同按"豁免登记"归类）。

## 6. 持久化

**应然**（generic task queue）：所有 task type 状态全落 `tasks/` 五子目录（pending / running / done / failed / results）；任意 task type 文件即权威载体；运行时 `pendingQueue` / `running` map 可由目录内容重建（Philosophy "持久化一切信息到磁盘，运行时句柄从磁盘信息重建"）。

**实然**：subagent task type 完整落盘（fs-driven）；async tool task type 仍为 pendingQueue 内存主存储（B.p163-1/3 历史遗留 / 待 async tool 清理 phase 收敛）。

| 信息 | 落盘位置 | 重建语义 |
|---|---|---|
| pending 任务 | `tasks/pending/<id>.json` | phase163：`initialize` 内 `recoverTasks` 仅把 running/→pending/ 文件回搬；**不再** push pendingQueue。`startDispatch` 内 `_initialScanPending` 逐文件调 `_ingestPendingFile`（走 watcher 同款路径）；生产中 spawn / dispatch / cron / daemon 新下单也经 watcher。**subagent 文件即权威载体** |
| running 任务（崩溃时） | `tasks/running/<id>.json` | `recoverTasks` 按 `result.txt.sent` marker 三分：已完结→done、失败→failed、未知→失败标记 |
| done / failed 结果 | `tasks/done/<id>.json` / `tasks/failed/<id>.json` | 归档用，不回入队 |
| 大结果 offload | `tasks/results/<id>/result.txt` + `.sent` marker + per-task `audit.tsv` | marker 存在 = 已通过 outbox 回传；recovery 扫描时用于去重 |
| pendingQueue / running map / handlers | TaskSystem 实例字段 | 运行期派生态，不落盘；重启由 `recoverTasks` 重建 |
| parentStreamLog sink | 运行期注入 | 不落盘；重启后由 Runtime `setStreamCallbacks` 重新注入 |

**符合 Design 原则「运行中断即从最后一次完整 LLM 调用恢复」的边界**：

- `result.txt.sent` marker = 幂等边界（标记过即视为完结，不重跑）
- 但 `recoverTasks` 扫目录做三分决策时**无 audit 事件**（A.1 违规）——决策链路不可事后重建，**违反 Design Principle "事后仅凭日志和记录能完整重建任一时刻的运行状态和决策链路"**

## 7. 与实然的差距

### A 类（必修违规，待后续 phase）

| # | 违规 | 位置 | 违原则 | 修复方向 |
|---|---|---|---|---|
| A.1 | `recoverTasks` 路径 audit 静默（**含 TaskSystem 全部 monitor.log 44 处**） | system.ts:165-316 + 全文件 | Philosophy "任何信息不得丢弃" + Design Principle "事后仅凭日志和记录能完整重建任一时刻的运行状态和决策链路"（recovery 的三分决策：完结/失败/未知，全无审计痕迹，违反"决策链路可重建"） | phase170+ 补 `task_recovery_start` / `task_recovery_complete` / `task_cancelled` 事件 → **phase248 已清零**（**45 monitor calls** 全迁 audit — 44 计划 + L238 resend_result_failed 遗漏 +1 / 12 新常量 TASK_DISCARDED 等 / monitor 字段 B.p248-1 保留 SubAgent 透传 / monitor.close() 删除 / SHA `4d3ef2a`）|
| A.2 | ~~inbox 写失败 2×（system.ts L802/L872）~~ **phase248 β 双写已清**；~~shutdown 超时 1×（system.ts L1027）~~ **phase267 Step 2 已清零** | L1027 | #8 耦合界面最小（AuditLog 应唯一事件出口）| `TASK_SHUTDOWN_TIMEOUT` audit + events.ts 常量 / β 双写保留 console.warn |
| A.3 | `initialize` 调 `ensureDir('inbox/pending')` — 跨模块资源兜底 | ~~system.ts:146~~ 实测 L151（drift +5） | #3 每种资源只归属唯一模块（inbox 归 Messaging） | phase170+ 与 Messaging 协同，改由 Messaging `initialize` 负责 → **phase273 已清零**：删 `system.ts:151` 冗余调用；InboxWriter `write()` L38 per-write `ensureDir(this.inboxDir)` 已覆盖，无需 Messaging.initialize() 协同 |
| A.4 | SubAgent class 双路 `new`（task + contract），TaskSystem 持 SubAgent 构造签名全貌 | ~~system.ts:573 + contract/manager.ts:1179~~ drift：实测 L551 / L1189 | #3 单一归属（class 算资源；**phase173 归属已界定：SubAgent 是 L3 执行原语，归 `l3_subagent.md`**）+ **#8 耦合界面最小**（`new SubAgent({...})` 让 TaskSystem 需知道 SubAgent 全部构造选项，接触面最大化；应改为"注入 SubAgent 工厂函数"模式，TaskSystem 只见工厂签名不见内部字段） | 细化期转注入工厂模式：加 `createSubAgent(opts)` factory 在 `l3_subagent.md` 登记；TaskSystem / ContractManager 改调工厂，不 new class → **phase229 已清零**（`28683c4` / 2026-04-22）：`createSubAgent` 工厂建成；system.ts:551 + manager.ts:1189 均已切换工厂调用 → **phase273 drift 修正**：行号 + 清零登记追补 |

### A.p163-消除（phase163 落地，2026-04-20）

| # | 违规 | 消除证据 |
|---|---|---|
| **A.p163-消除** | SubagentSystem ↔ TaskSystem 运行时循环耦合 | phase159 §5 曾以"import type 单向编译"豁免掩盖；用户 2026-04-20 收紧原则 #5（import type 规避不算合规）后升为 A 类。phase163 落地：spawn / dispatch 工具改经 `writePendingSubagentTaskFile(fs, audit, args)` 直写 `tasks/pending/{id}.json`；TaskSystem 经 FileWatcher 订阅 pending/ 异步拾起（`_ingestPendingFile` → push pendingQueue → `_dispatch`）。**运行期真单向依赖**。`grep -rn "ctx\.taskSystem" src/core/tools/builtins/` 仅命中 `dispatch.ts`（`taskHandlerHost = ctx.taskSystem` 供 `addTaskResultHandler`，B.p163-4）+ `status.ts`（queueLength 只读）。helper `scheduleSubAgentWithTracking` 已删（Step 5）；cron / daemon 切至 `writePendingSubagentTaskFile` |

### B 类（偏差 / 豁免登记，当前合理）

| # | 登记项 | 理由 |
|---|---|---|
| B.1 | L4 归属可争议（L3 执行语义 vs L4 业务语义） | 已论证（扫描 §8）：队列 + 崩溃恢复 + 跨进程持久化压过执行语义；runtime.ts:218 "TaskSystem 业务动作"注释是既定共识；ToolExecutor(L3) 反向依赖已由 type-only 豁免消解（§5 #3 / §7 C 类 #5 豁免）；未来拆 subagent-queue + tool-task-queue 时重审 |
| B.2 | `setParentStreamLog` 运行期替换 sink（#6 显式豁免登记） | parentStreamLog 是"可选输出通道"非"依赖模块"；#6 约束"模块间依赖关系"不可变，不约束运行期可选输出 sink；Runtime 倒置注入与 Gateway `interrupt` 回调注入同模式——归**豁免登记**而非"违规可接受"；与 §5 耦合 #5 表述统一 |

### B.p248-1（monitor 字段保留 SubAgent 透传，phase248）

| 字段 | 内容 |
|-----|------|
| 编号 | B.p248-1 |
| 类型 | 装配透传偏差（inert 变种：已弃本模块用途 / 保留跨模块透传） |
| 描述 | `private monitor: JsonlLogger` 字段保留仅为 `createSubAgent`（L634）透传；TaskSystem 自身全部 `.log()` 44 处已迁 audit（phase248）；`monitor.close()` 已删 |
| Owner | phase248 |
| 计划 phase | **phase297 消化** ✓（r25 B / SHA `d89e392` / 2026-04-25）— monitor 字段链路全删；TaskSystem.monitor 私有字段 + createSubAgent 透传一并清零 |

### B.p163-*（phase163 产生 / 延续的偏差，2026-04-20）

| # | 登记项 | 理由 | 治理路径 |
|---|---|---|---|
| **B.p163-1** | `pendingQueue` 字段保留（async tool 路径仍依赖） | system.ts:114 字段声明 + scheduleTool push + _dispatch shift + cancel splice 均消费；删除即破坏 async tool 路径，超出 phase163 范围 | async tool 清理 phase 一并删除 |
| **B.p163-2** | `listPending()` 单源（仅返 `pendingQueue.map(t => t.id)`） | phase163 后语义收窄：subagent 文件未被 watcher / startDispatch 拾起前不可见；JSDoc 显式声明；欲看完整 pending 状态请直读 tasks/pending/ 目录 | async tool 清理 phase；或视消费方需求升级为 `listPendingAsync()` |
| **B.p163-3** | async tool 与 subagent 调度源双轨 | subagent 经 fs / watcher；ToolTask 经 `pendingQueue` 内存；同一 pendingQueue 字段混合两类任务 | async tool 清理 phase 统一收敛 |
| **B.p163-4** | `dispatch.ts` 保留 `ctx.taskSystem` 引用（仅用于 `addTaskResultHandler`） | dispatch.ts:87 `taskHandlerHost = ctx.taskSystem`；handler 注册是 callback 订阅而非调度业务语义，但仍是 SubagentSystem → TaskSystem 运行期调用 | handler 文件化独立 phase（dispatch 写 `tasks/handlers/{id}.json` 描述符 + TaskSystem 完成时扫描） |
| **B.p163-5** | cron `silent: true` 语义失效 | random-dream 改造后不再经 helper；SubAgentTask schema 无 silent 字段；cron 任务无 viewport 父 | 接受失效（cron 无 viewport 消费）；若日后需要，SubAgentTask 加 silent 字段 |
| **B.p163-6** | `ExecContext.taskSystem?` 字段保留 | context.ts 字段 + JSDoc 列三合法消费（status queueLength / executor scheduleTool async tool / dispatch addTaskResultHandler） | 三路径各自独立 phase 清理后字段方可删除 |
| **B.p163-7** | `_pending-task-writer` 不写 `monitor.log('subagent_scheduled')` | 仅 audit `task_scheduled`；原 `TaskSystem.scheduleSubAgent` 有该 monitor log，改造后仅保留在 `scheduleSubAgent` 方法门面调用路径 | `_ingestPendingFile` 可选补 monitor log；当前接受缺失 |

### B.p230-1（spawn / dispatch / ask_motion 工具归属变更，关键决策 #29，2026-04-23）

**应然**：spawn / dispatch / ask_motion 三工具的业务语义归属 TaskSystem(L4)（modules.md 关键决策 #29）。理由：spawn/dispatch 的编排涉及 L1-L2 多模块工具注册与 SubAgent 构造，是 TaskSystem 的职责。原 L3 SubAgent 导出这些工具违反 M1（编排是 TaskSystem 职责不应散落在 L3）和 M2（L3 不应为 L4 定义业务接口）。

**实然**：
- `spawn.ts` / `ask-motion.ts` / `_pending-task-writer.ts` 已迁 `src/core/task/tools/`（phase287）
- `dispatch.ts` 已迁 `src/core/task/tools/`（phase347）
- `ExecContext.taskSystem?: TaskSystem` 字段仍透传给 dispatch 工具消费 `addTaskResultHandler`（子任务 a 推 phase348+）
- §1 职责描述已补充"工具定义与入口"

**对 §5 耦合 #3 的影响**：原"残留三条合法反向引用（status queueLength / executor scheduleTool async tool / dispatch addTaskResultHandler）"中的 dispatch 条目将变为 TaskSystem 内部调用，不再是反向依赖。

**治理路径**：代码实施 phase 将三工具迁移至 TaskSystem 模块目录 + 重构 ExecContext 移除 taskSystem 字段。

### B.p173-1（SubAgent 下移 L3 后的内部子模块化评估，2026-04-21 / **phase341 部分消化 ✓ 2026-04-27**）

SubAgent class 下移 L3 后，TaskSystem 仍含 ~1100 行，内部可辨识 4 个子关注点：

- **(a) 调度核心**：排队 + 调度 + 并发 + 状态机
- **(b) 崩溃恢复 + 幂等**：recoverTasks / marker 判定 / running→pending 回搬 → **phase341 拆出 `task-recovery.ts` ✓**
- **(c) 结果投递管道**：`tasks/results/` 目录 + audit/stream + parent inbox 投递 + 降级通知 → **phase341 拆出 `result-delivery.ts` ✓**
- **(d) Tool 重试引擎**：async tool task 的 retry loop → **phase341 拆出 `tool-executor.ts` ✓**
- **(e) SubAgent 执行**（phase341 新识别）：executeTask / SubAgent 工厂调用+生命周期 → **phase341 拆出 `subagent-executor.ts` ✓**

**phase341 实施总结**（commit `7480218`）：
- system.ts 1037 → 544 行（降 48%）/ (a) 调度核心 + 生命周期 + thin wrapper 留在 system.ts
- 4 子模块全为 standalone function + deps interface 模式（TS 惯用 / 非 partial class）
- M9 闭包 ≥ 4 → interface 第 3 实证（subagent-executor ≥ 6 deps + recovery ≥ 4 deps）
- 公共 API 0 改 / caller import 0 改 / 测试 0 改

**剩余 (a) 调度核心不拆理由**：与 pendingQueue / running map / shutdown / startDispatch 状态强耦合 / 拆出反破 #1 反向测试。

**治理路径**：async tool 清理 phase（B.p163-1/3 一并收敛）后评估 (a) 内部进一步细化时机；目前已是良性结构。

### C 类（原则对照 — Philosophy 4 + Design 11 + Module 11 + Path 6 = 32 / 深度按需）

> Path 6 authoritative list 待核 / 后续轮 fork ack 时补完。phase341 后 4 子模块拆出 / M9 deps interface 实证。

#### Philosophy（4）

| # | 原则 | 判定 | 证据 |
|---|---|---|---|
| P1 | Agent 即目录 | 合规 | tasks/<id>/ 是 task 单元目录 / fs-driven |
| P2 | clawforum 本质上下文工程 | 合规 | result.txt + audit 子文件 = 子代理上下文产物 |
| P3 | 分智能体目的 | 合规 | subagent task 派生独立窗口 / 不污染父 claw |
| P4 | 系统为智能体服务 | 合规 | TaskSystem 提供调度 + recovery + 结果回传基础设施 |

#### Design Principles（11）

| # | 原则 | 判定 | 证据 |
|---|---|---|---|
| D1 | 信息不丢失 / 可观察 / 可恢复 / 可审计 | 合规 | 4 events + 子 audit + tasks/* 全落盘 |
| D2 | 信息未经显式设计不得静默忽略 | 合规 | recovery 静默 phase248 已清零 / 全路径 audit |
| D3 | 用户可观察所有状态 | 合规 | tasks/pending|running|done|failed 目录 + audit |
| D4 | 中断即从最后完整 LLM 调用恢复 | 合规 | recoverTasks 扫 running/ + result.txt.sent marker / 三分决策 |
| D5 | 事后仅凭日志重建决策链路 | 合规 | task 级 audit + 子 audit 双层 / phase248 后 recovery 路径全 audit |
| D6 | 子代理后不阻塞 / 异步返回 | 合规 | `writePendingSubagentTaskFile` fire-and-forget / watcher 异步 ingest / result 经 outbox 回传 |
| D7 | 系统内部走可信路径 | 合规 | scheduleSubAgent / scheduleTool 内部 API |
| D8 | 事件驱动 / 恰好需要时交付 | 合规 | FileWatcher 订阅 pending/ / 不轮询 |
| D9 | CLI 唯一外部入口 | 合规 | 外部不直调 TaskSystem |
| D10 | 多 claw 信息不隔绝 | 合规 | tasks/results/ 跨 claw 可见 |
| D11 | motion 单向访问 | N/A | 本模块不涉及 motion 边界 |

#### Module Logic（11）

| # | 原则 | 判定 | 证据 |
|---|---|---|---|
| M1 | 一组独立可变职责 | **部分豁免** | (a) 调度核心不拆 / (b)(c)(d)(e) phase341 已拆 4 子模块 ✓ |
| M2 | 业务语义自发起 | 合规 | 调度 / recovery / 结果回传由本模块发起；生命周期触发归 Runtime（同 Gateway 模式）|
| M3 | 资源唯一归属 | 合规 | tasks/* 五目录独占 / phase273 inbox/ ensureDir 已删 |
| M4 | 持久化一切信息 | 合规 | 所有 task type fs-driven（subagent ✓ / async tool 内存主存 = B.p163-1 待迁）|
| M5 | 依赖单向 / 不预设上层 | 合规 | 不反向依赖 Runtime / Daemon ✓；下游反向 import 经 type-only + 注入豁免（§5 #3 + #5 显式豁免）|
| M6 | 依赖结构稳定 | 合规 | TaskSystemOptions ctor 一次注入 / parentStreamLog 可选 sink 显式豁免（B.2）|
| M7 | 耦合界面稳定 | 合规 | 公共 11 方法形态稳定 / phase341 0 改 |
| M8 | 耦合界面最小 | 合规 | A.4 SubAgent 工厂化 phase229 已清零 / 现仅工厂签名 |
| M9 | 编译器优先 | 合规 | phase341 deps interface（subagent-executor ≥ 6 deps + recovery ≥ 4 deps）= M9 第 3 实证 |
| M10 | 反向测试 | 合规 | (a) 调度核心不拆 = #1 反向测试不独立可变 / phase173 + phase341 双次评估实证 |
| M11 | 边界与依赖对不上停下 | 合规 | phase163 收紧 #5 判据 / 升 A 类 / B.p163-1 等显式登记 |

#### Path Principles（6 待核）

| # | 已知 | 判定 | 证据 |
|---|---|---|---|
| Path #1 | 实测核 baseline | 合规 | phase341 实测 1037 行 + 4 子关注点 / 0 推翻 B.p173-1 |
| Path #3 | 语义原子最小变更单元 | 合规 | phase341 单 commit 拆 4 文件 / 公共 API + caller 0 改 |
| Path #6 | 冲突停 | 合规 | (a) 调度核心拆出会破 #1 反向测试 / 停 / 留 thin wrapper |
| Path #8 | 总难度最低 | 合规 | standalone function pattern（TS 惯用）/ 非 partial class |

---

### C 类（实施 / 命名补充）

- **#1 反向测试**：为何不拆 subagent / tool / recovery 三子模块——三者共享 `pendingQueue` / `running` map / `tasks/` 目录 / `AbortController` / `shutdown` 收口语义，改任一队列语义会动其他两个 = 一组共享资源的子能力集合，不拆（`feedback_m1_reverse_test`）
- **#2 业务语义归属**：任务调度 / recovery / 结果回传业务由 TaskSystem 发起；生命周期触发（start/stop）归 Runtime，业务实现归 TaskSystem（与 Gateway start/stop 由 Daemon 触发同模式）
- **#5 底层不预设上层**：TaskSystem 依赖全下层（FS L1 / LLM L1 / Audit L2 / Stream L2）+ 同层（SubAgent / ContractManager 待界定）；**不反向 import Runtime / Assembly / Daemon**
- **#5 反向 type-only 依赖豁免**（下游模块 import TaskSystem 类型的合规论证）：`core/tools/executor.ts`（L3）/ `core/tools/context.ts`（L3）/ `core/tools/builtins/{spawn,dispatch,status}.ts`（L3）/ `core/subagent/agent.ts`（L4 同层）/ `core/cron/jobs/random-dream.ts`（L5）均 `import type { TaskSystem }`——**全为 type-only import**，编译期仅耦合类型签名；运行期实例由 Runtime 通过 ExecContext / opts 反向注入；依赖图构造期无 L3→L4 值依赖边。合规判据：type-only + 上层注入 = "可选能力注入"模式，非"底层预设上层语义"；与 ToolExecutor `taskSystem?: TaskSystem` 可选字段形态一致
- **#6 依赖结构稳定**：TaskSystemOptions 构造期一次性注入（phase155C 已从 setter 改过），运行期不变；可选输出 sink (`setParentStreamLog`) 属 #6 显式豁免（B.2）
- **#7 耦合界面稳定**：本 phase 不改公共 11 方法形态
- **#8 耦合界面最小**：TaskSystemOptions 8 字段——`maxConcurrent` / `retryBaseDelayMs` / `parentStreamLog` 可选是"默认值存在"而非"可选依赖"；`auditWriter` / `llm` / `skillRegistry` / `contractManager` / `outboxWriter` 必传是依赖模块。**#8 违规在 SubAgent 值依赖路径**（A.4），非 Options 路径
- **私有方法命名**：`_dispatch` / `_startTask` / `_ingestPendingFile` / `_initialScanPending` 下划线前缀与其他模块不一致（C 类，phase171+ 代码清理可统一）

### Phase 执行纪律复盘（phase163，非 A/B/C）

- **B-step3-implementation-deviation**（2026-04-20 登记）：phase163 Step 3 实施过程中 agent 引入 3 处偏离（scheduleSubAgent 内 fallback hack + `pendingFileIds: Set` 字段 + `_initialScanPending` 放在 recoverTasks 末尾），Step 3-1 纠正后发现 recover 测试在新语义下仍 fail（Step 3-1 §R1 推理错误），Step 3-2 通过修测试 setup 对症（initialize + startDispatch 配对 + recover 断言改 fs.access），Step 3-3 加固断言位置消除 race-window。
- **根因双重打**：
  - 计划穿透不足：Step 3 计划未桌面演练"`_ingestPendingFile` 内含 `_dispatch`" + "位置在 recoverTasks 末尾" 合一导致 initialize 期间触发 dispatch 的穿透链条；Step 3-1 §R1"recover 测试 await initialize() 后 listPending() 自然包含恢复的 task"推理错误（忽略了 listPending 单源 + startDispatch 未调 = pendingQueue 为空）
  - agent 越界：测试环境 mock fs 缺 resolve 导致的 watcher 不构造 timeout，agent 用 production-side fallback 兜底掩盖，违反 `feedback_baseline_rigor_not_default`（"不把个人执行缺陷包装成普适原则写进公共规范"）
- **治理价值**：
  - 本 phase 首次形成"计划 → 实施 → review → 纠错 → 再 review → 修订 → 加固"六段链，为后续 phase 提供"遇到第一次意外 fail 立即声明根因归属"的实践样板
  - 纠错过程沉淀 3 条 memory 升格候选（phase 合入后 24h 评估）：
    - (a) 步骤计划落笔前必须桌面演练"测试调用链 → 产品状态机 → 断言期望"三段对账
    - (b) agent 遇测试 mock 缺陷应优先补 mock，不改产品兜底
    - (c) 计划文档 §R1 类"测试将 PASS"承诺必须指向具体断言行 + 对应产品状态机节点，不能靠推理

### 7.D 关键决策映射表（modules.md 迁移）

从 `design/modules.md` §关键设计决策章节迁移（2026-04-26 主会话；后续清理阶段重构）。原 KD 编号保留供对账。

- **KD#6（原 modules.md）dispatch 和 spawn 独立工具**：dispatch 发起 mining mode,spawn 创建通用子代理。两者归属 TaskSystem(L4) 导出（关键决策 #29）
- **KD#30（原 modules.md）ContractSystem LLM 验收经 TaskSystem 调度**（cross-ref）：详 l4_contract_system.md §7.D 主登记。本模块承担 verifier 子代理调度职责。

---

## 8. 测试覆盖

phase158 扫描 §10 统计，直接涉 TaskSystem 的测试共 **264 case**，文件清单：

| 文件 | case 数 | 类型 | 覆盖点 |
|---|---|---|---|
| `tests/core/task.test.ts` | 14 | unit | scheduleSubAgent / dispatch / recovery 基础路径 |
| `tests/core/task-system-tool.test.ts` | 37 | unit | tool task 专项（scheduleTool / executeToolTask / sendToolResult） |
| `tests/core/dispatch.test.ts` | 11 | integration | dispatch 工具 + TaskSystem 联动 |
| `tests/core/builtins.test.ts` | 77 | integration | spawn / dispatch / status 工具 |
| `tests/core/tools.test.ts` | 22 | unit | ToolExecutor + TaskSystem 注入 |
| `tests/core/runtime.test.ts` | 51 | integration | Runtime 生命周期调 TaskSystem |
| `tests/core/runtime-initialize-failures.test.ts` | 3 | failure path | initialize 失败路径 |
| `tests/core/cron/random-dream.test.ts` | 11 | integration | cron job 调 TaskSystem |
| `tests/assembly/assemble.test.ts` | 38 | integration | Assembly 装配 TaskSystem |

Helper：`tests/helpers/task-system.ts` + `tests/helpers/runtime-deps.ts`（若含直接 `new TaskSystem(...)`，Step 3 工厂落地后可选迁移，非强制；契约不约束测试内部是否经工厂）。

**缺口**（phase170+ 补）：

- recovery 路径 audit 事件断言（A.1 修复后）
- 3 处 console 替换为 audit 事件后的载荷断言（A.2 修复后）
- `inbox/pending` ensureDir 归属交接的接合测试（A.3 修复后）
- SubAgent 工厂注入模式落地后的 TaskSystem → SubAgent 构造接触面测试（A.4 修复后）

### §7.Phase 执行纪律

#### phase248 纪律 — B.2 Monitor 废止 sub-phase 2（2026-04-24，coding plan/phase248/）

- **Scope**：task/system.ts 44 monitor.log() 全迁 audit / 12 新常量（TASK_DISCARDED 等）/ B.p248-1 monitor 字段保留 SubAgent 透传
- **N1**：Step 5 recoverTasks 6 calls（超 ≤5 限制 / 语义完整性优先 / 显式豁免登记）
- **Path #6**：11 代码步 × ≤5 calls/step 严守（N1 单次显式豁免）
- **Path #7**：SubAgent monitor 依赖 → B.p248-1 登记 / 不自决归属
- **A.2 残留**（L939/1022/1189 console 违规）：本 phase scope 外 / 非 monitor 调用 / 待单独 phase
- **§7.A 形態 7 序列化质量**：全部 catch 块 `String(err)` → `JSON.stringify(err)` for non-Error 修正

#### phase267 纪律 — G4 console 评估 + §7.A A.2 shutdown 残留清零（2026-04-24，coding plan/phase267/）

- **Path #1 事实核 G4**：runtime.ts 3 / skill/registry.ts 2 / gateway.ts 0 / task/system.ts 3 = 8 console
- **N1 contract drift**：§3 缺失事件 `task_inbox_write_failed` 标缺失但 phase248 已实装（L802/L872 β 双写）→ 修正
- **N2**：§7.A A.2 "3 处全 open" → 实然 2 处已 β 双写 / 仅 L1027 shutdown timeout open → 修正
- **Step 1（非代码）**：✓ contract drift 修正（本纪律节 + §3 + §7.A A.2）
- **Step 2（代码）**：✓ events.ts `TASK_SHUTDOWN_TIMEOUT` + L1027 audit wire + 2 it → A.2 全清零

#### phase274 纪律 — TaskSystem A.2 清零后 §7.C cascade 评估（2026-04-24，r21 分支 E）

- **scope**：r20 F phase267 清零 TaskSystem A.2（shutdown timeout L1027 audit wire）后 §7.C 影响评估
- **评估结论**：§7.C 节为 phase163 旧叙述格式（无 ◐ 评级表）→ A.2 清零对 §7.C 无评级前进项
- **可观测性原则 D5/P1b/M10 影响**：旧格式 §C 未包含这些条目（与 l6_watchdog.md 新格式 ◐ 表不同）→ 无前进
- **结论**：l4_task_system.md §7.C cascade = 零；纪律登记备案

#### phase273 纪律 — §7.A A.3 清零 + A.4 drift 修正（r21 分支 D / 2026-04-24）

- **Scope**：A.3 删 system.ts:151 冗余 ensureDir（1 行）/ A.4 phase229 drift 追补 / **TaskSystem §7.A 4/4 全清零里程碑**
- **#14 第 5 形态**：分发表 "A.4 SubAgent 双路 new 待修 + A.3 Messaging 协同" → Path #1 核发现：A.4 phase229 已清零（system.ts:551 + manager.ts:1189 均为 `createSubAgent`）；A.3 InboxWriter 已 per-write ensureDir，无需 Messaging 协同；scope 双向收窄
- **N1 行号 drift**：A.3 契约 L146 → 实测 L151（+5）；A.4 契约 L573+L1179 → 实测 L551+L1189
- **TaskSystem §7.A**：A.1（phase248）/ A.2（phase267）/ A.3（phase273）/ A.4（phase229）→ **4/4 全清零**

#### phase341 纪律 — H5 TaskSystem 单文件内部拆分（r40 C / 2026-04-27 / B.p173-1 部分消化）

- **Scope**：system.ts 1037 → 544 行（降 48%）/ 拆 4 子模块（result-delivery + task-recovery + subagent-executor + tool-executor）/ standalone function pattern + deps interface
- **B.p173-1 消化**：(b)(c)(d) + 新识别 (e) SubAgent 执行全拆出 / 留 (a) 调度核心 + 生命周期 + thin wrapper
- **M9 第 3 实证**（Meta 28 硬化条 reconfirmation）：subagent-executor ≥ 6 deps + recovery ≥ 4 deps → deps interface
- **公共 API 0 改**：exported types 仍从 system.ts re-export / caller import 路径 0 改 / 8 处 caller 全保留 / 测试 0 改
- **standalone function 提取 pattern**：TS 惯用（非 partial class）/ class 方法变 thin wrapper / 待 r41+ 第 2 次升格 feedback 候选
- **B+C 弱冲串行实证**：C 先合 `7480218` / B phase340 后合 rebase 0 冲突
- **SHA**：`7480218`

#### phase297 纪律 — B.2 Monitor 废止 Phase 2（r25 分支 B / 2026-04-25）

- **Scope**：monitor 实例创建（assemble.ts + task/system.ts 各 1 处）+ lifecycle（runtime.ts `await this.monitor.close()`）+ 全字段链路（RuntimeDependencies / runtime.ts / executor.ts / context.ts / subagent/agent.ts / task/system.ts 9 处字段声明 + 6 处 import）+ 测试 4 文件清理（runtime-deps.ts / subagent.test.ts / assemble.test.ts / runtime-initialize-failures.test.ts）
- **B.p248-1 消化**：task/system.ts `private monitor: JsonlLogger` 自建字段 + createSubAgent 透传 → 全删；B-class 条目标 ✓
- **测试 -1 it**：assemble.test.ts "monitor construct failure → audit module=monitor phase=construct + throw" 整块删除（monitor 不再在 assemble.ts 中创建，场景已不存在）；总测试数 1317 → 1316
- **SHA**：`d89e392`（squash merge / r25 B）

### B.p344-4 — 应然 §1+§3 滞后 / phase342+ audit-events 扩展未同步（drift type / 推 r42）

**触发**：r41 主会话 audit fork 发现（2026-04-27）。

**应然 drift 清单**（推 r42 同步修订 / 不本 phase 改）：
1. **§3 audit events 4 → 实然 16**：应然只列 4 核心事件（task_scheduled/started/completed/pending_ingest_failed）/ 实然 audit-events.ts 已有 16（含 RECOVERY_COMPLETE / RECOVERY_FAILED / MOVE_FAILED 等 12 个 phase248+ 加的）/ 应然完整化
2. **§head 矛盾**：「当前只装 subagent task type」← phase341 后 tool task 仍并行实装（B.p163-3 已登）/ 应然头段说法应同步「subagent + tool 双轨 / tool 待 async tool 清理 phase 收敛」
3. **§4 ToolRegistry 缺 L2 标注**：应然依赖表「ToolRegistry（L2 Tools / TaskSystem 内部自持）」/ 现表中 L2 标注不一致

**owner**：TaskSystem
**计划 phase**：r42 design 同步（与 B.p344-1/2/3 contract+cron drift 并轨）
**type**：drift（应然文档滞后 / 非代码违规）

---

### §7.drift — 应然 framing drift（phase324 pilot 发现 / 2026-04-26）

| # | 位置 | drift 描述 | 修正 |
|---|---|---|---|
| D1 | §head + §1 共 2 处 | "modules.md §19" 引用 / TaskSystem 实为 §20（Gateway §19 后移位）| ~~§19~~ → §20（replace_all / 已执行）|
| D2 | §4 ToolRegistry 依赖行 | "TaskSystem 内部自持" 缺 L2 Tools 层级标注 | 补 "L2 Tools" 前缀（已执行）|
| D3 | modules.md §20 TaskSystem 条目 | 可能存在与 SubAgent 同型的 "L3 内部同层" drift（待核）| **非 scope / 登记待核** |
