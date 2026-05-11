# Runtime 接口契约

**应然**（2026-04-26 修订 / 跟 modules.md §22 align）：常驻 agent 事件驱动循环 / Runtime 不做装配（已独立为 Assembly L6c）/ 只接收装配好的 instances 跑循环 / 无 identity 分支（motion 差异由 Assembly 按 identity 配置注入）。依赖经 `RuntimeDependencies` 16 字段构造期注入 / 无运行期依赖变化。

**实然**：ClawRuntime 919 行 / 已消灭 MotionRuntime subclass（phase266 / 改 optional 构造参数）/ 4 处 dead imports 已清零（phase288）/ §7.A 全清零（phase178）/ 2 setter 已消除（phase182 B.p166-5）。详 §7。

归属：L5 外壳与能力。
- **应然依赖**：FileSystem（L1）、LLMService（L1）、AuditWriter（L2）、Snapshot（L2）、SessionStore（L2）、Messaging（L2 inbox/outbox）、StreamLog（L2）、Tools（L2 / ToolRegistry+ToolExecutor）、SkillSystem（L2）、ContractSystem（L4）、TaskSystem（L4）
- **实然依赖**：同应然 + ContextInjector（Runtime 内部组件）/ ExecContextImpl（L2 Tools 内部）

## 1. 所有权

### 归属层

L5（Runtime 层；phase166 首个 L5 契约，落地于 `src/core/runtime.ts` 919 行 + `src/core/motion/runtime.ts` 111 行）。

### 职责（独立可变的职责集合）

- **常驻 agent 事件驱动循环**：`processBatch` 排空自身 inbox（含高优先级中断探测）→ 构造 messages → `_runReact` 包装 LLM 调用 → audit 轮级事件
- **session 生命周期**：加载 / 保存 / 启动归档（`repairSessionIfNeeded`）/ tool 配置重建
- **turn-level audit 集成**：`turn_start` / `turn_end` / `turn_interrupted` / `turn_error` / `llm_call` / `llm_error` 在三入口（batch / message / retry）统一发出
- **三种 turn 中断响应**：`IdleTimeoutSignal` / `PriorityInboxInterrupt` / `UserInterrupt` 经 `AbortController` + `_handleTurnInterrupt` 路由
- **snapshot 轮级 commit**：每 turn 结束调 `snapshot.commit(context='turn-N')`，失败发 `snapshot_commit_failed` / `snapshot_commit_uncategorized`
- **chat 交互入口**：命令行 REPL 专用 `chat(...)`，区别于 daemon 的 `processBatch`
- **TaskSystem 生命周期调度**：`initialize()` 时调 `taskSystem.initialize()` + `startDispatch()`；失败发 `task_system_init_failed` / `task_system_start_dispatch_failed`
- **DispatchTool 注册**：`initialize` 期间构造 `DispatchTool` 并 `toolRegistry.register(...)`
- **MotionRuntime 身份注入**：override `buildSystemPrompt` 按序读入 AGENTS → USER → IDENTITY → SOUL → MEMORY → skills → contract → AUTH_POLICY；override `initialize` 后 `toolRegistry.unregister('send')`

### 资源

- **内存句柄**：`currentAbortController: AbortController | null`、`turnCount: number`、16 字段 `RuntimeDependencies` 引用（运行期不变）
- **无磁盘归属**：session 状态由 `sessionManager` 持久化（归 SessionManager 契约）；audit 由 `auditWriter` 追加（归 AuditLog 契约）；Runtime 本身无目录 / 文件
- **无独占常量**：`MOTION_CLAW_ID` / `DEFAULT_MAX_STEPS` / `DEFAULT_LLM_IDLE_TIMEOUT_MS` / `DEFAULT_MAX_CONCURRENT_TASKS` 定义于 `src/constants.ts`，跨模块共享（见 §6）

### 业务语义（由本模块主动发起）

- "一轮对话"：`processBatch` / `processWithMessage` / `retryLastTurn` / `chat`
- "运行时启动"：`initialize`
- "运行时停止"：`stop`
- "用户中断"：`abort`
- "挂起契约恢复"：`resumeContractIfPaused`

业务语义清单外即不做。边界参照：模块装配归 Assembly；LLM / tool 原子执行归 StepExecutor / ToolExecutor；任务队列调度归 TaskSystem；契约状态机归 ContractManager。

## 2. 接口

### 2.1 类型签名

#### 依赖注入

```ts
export interface RuntimeDependencies {
  // L1
  readonly systemFs: FileSystem;
  readonly clawFs: FileSystem;
  // L2
  readonly auditWriter: AuditWriter;
  readonly snapshot: Snapshot;
  readonly sessionManager: SessionManager;
  readonly inboxReader: InboxReader;
  readonly outboxWriter: OutboxWriter;
  // L3-L4
  readonly llm: LLMService;
  readonly toolRegistry: ToolRegistryImpl;
  readonly toolExecutor: ToolExecutorImpl;
  readonly skillRegistry: SkillRegistry;
  readonly contractManager: ContractManager;
  readonly taskSystem: TaskSystem;
  readonly contextInjector: ContextInjector;
  readonly execContext: ExecContextImpl;
}

export interface ClawRuntimeOptions {
  clawId: string;
  clawDir: string;
  llmConfig: LLMServiceConfig;
  dependencies: RuntimeDependencies;
  maxSteps?: number;
  toolProfile?: ToolProfile;
  toolTimeoutMs?: number;
  subagentMaxSteps?: number;
  maxConcurrentTasks?: number;
  idleTimeoutMs?: number;  // 0 = 禁用 idle 中断
}
```

#### Stream 协议（publisher-subscriber 形态 B）

```ts
export interface StreamCallbacks {
  onBeforeLLMCall?: () => void;
  onTextDelta?: (delta: string) => void;
  onTextEnd?: () => void;
  onThinkingDelta?: (delta: string) => void;
  onToolCall?: (toolName: string, toolUseId: string) => void;
  onToolResult?: (
    toolName: string, toolUseId: string,
    result: { success: boolean; content: string },
    step: number, maxSteps: number
  ) => void;
  onTurnStart?: (sources: Array<{ text: string; type: string }>) => void;
  onTurnEnd?: () => void;
  onTurnError?: (error: string) => void;
  onTurnInterrupted?: (cause: string, message?: string) => void;
  onProviderInfo?: (info: { name: string; model: string; isFallback: boolean }) => void;
  onProviderFailover?: (info: { from: string; timeoutMs: number }) => void;
  onProviderFailed?: (info: { provider: string; model: string; error: string }) => void;
}

export interface DaemonStreamCallbacks extends StreamCallbacks {
  onInboxMessages?: (messages: InboxMessage[]) => Promise<void>;
}
```

Runtime 定义协议，消费者（daemon-loop / CLI）提供实现；Runtime 不反调消费者状态。

#### ClawRuntime 公共方法（13 / 5 组）

**lifecycle**：

```ts
constructor(options: ClawRuntimeOptions);
async initialize(): Promise<void>;
async stop(): Promise<void>;
async resumeContractIfPaused(): Promise<void>;
```

**事件循环入口**（由 daemon / CLI 驱动）：

```ts
async processBatch(callbacks?: DaemonStreamCallbacks): Promise<number>;  // 返回本轮吸收的 inbox 消息数
async processWithMessage(msg: Message, callbacks?: StreamCallbacks): Promise<void>;
async retryLastTurn(callbacks?: StreamCallbacks): Promise<void>;
async chat(/* REPL 参数，详见 src/core/runtime.ts:726 */): Promise<void>;
```

**中断**：

```ts
abort(): void;  // 由外部信号（如 SIGINT）触发
```

**观察**：

```ts
getStatus(): { /* turnCount / initialized / ... */ };
getTaskSystem(): TaskSystem;
getAuditWriter(): AuditWriter;
```

**装配期回填**（publisher-subscriber 形态 B，setter 注入）：

```ts
setContractNotifyCallback(cb: (type: string, data: Record<string, unknown>) => void): void;
setParentStreamLog(sink: StreamLog): void;
```

#### MotionRuntime override

```ts
export class MotionRuntime extends ClawRuntime {
  override async initialize(): Promise<void>;
  // super.initialize() + toolRegistry.unregister('send')

  protected override async buildSystemPrompt(): Promise<string>;
  // 注入序：AGENTS → USER → IDENTITY → SOUL → MEMORY → skills → contract → AUTH_POLICY
}
```

### 2.2 前后置条件

- **`constructor(options)`**
  - 前置：`options.dependencies` 16 字段全部就绪（L1-L4 已构造）
  - 后置：`initialized = false`；未触发任何 audit；未触任何 I/O
- **`initialize()`**
  - 前置：构造已成功
  - 后置：`toolRegistry` 已注册内建工具 + DispatchTool；`taskSystem.startDispatch()` 已调；`session_loaded` + （可选）`session_repaired` 已发出
  - 失败：抛出时 `initialized` 仍可能为 false；调用方 catch 后不得再调 `processBatch` / `chat`
- **`processBatch(cb?)`** / **`processWithMessage(msg, cb?)`** / **`retryLastTurn(cb?)`** / **`chat(...)`**
  - 前置：`initialize()` 已成功返回
  - 后置：一对 `turn_start` → (`turn_end` | `turn_interrupted` | `turn_error`) audit；`turnCount++`
  - `processBatch` 返回本轮吸收的 inbox 消息数（`_drainOwnInbox` 的 `count` 字段；0 = 无消息不起 turn）
- **`abort()`**
  - 前置：任意时刻可调；无 turn 正在跑则无副作用
  - 后置：`currentAbortController.abort({ type: 'user' })`
- **`setParentStreamLog(sink)`** / **`setContractNotifyCallback(cb)`**
  - 前置：无硬时序（Runtime 内用 `?.` 防御 undefined）；约定在 `initialize()` 后调
  - 后置：订阅者接收后续事件
- **`stop()`**
  - 前置：任意时刻可调
  - 后置：`taskSystem.shutdown()` 已调；后续 `processBatch` 行为未定义
- **`resumeContractIfPaused()`**
  - 前置：`initialize()` 已成功
  - 后置：如有挂起契约，相关 stream sink 已重连

### 2.3 失败分类

- **预期失败**（调用方可 catch 的具象类型）：
  - `MaxStepsExceededError`（`src/types/errors.ts`）—— turn 超出 `maxSteps`
  - `IdleTimeoutSignal` / `PriorityInboxInterrupt` / `UserInterrupt`（`src/types/signals.ts`）—— 三种 turn 中断；由 `_handleTurnInterrupt` 翻译为 `turn_interrupted` audit 后**不再向上抛**
- **不可预期失败**：LLM 网络错误 / tool 执行异常 / fs I/O 错误 —— `_runReact` 内捕获，发 `llm_error` / `turn_error` 后决定是否继续；构造期 fs 失败抛原生 `Error`
- **软失败**（audit 登记但不中断业务）：
  - inbox 单文件 meta 读失败 → `inbox_meta_failed`，不中断批次
  - snapshot commit 失败 → `snapshot_commit_failed` / `snapshot_commit_uncategorized`，不中断 turn
  - `onInboxMessages` handler 失败 → 目前 `console.warn` 软吞（§7.A 登记）
  - 启动归档失败 → 目前 `console.warn` 软吞（§7.A 登记）
  - 错误响应 outbox 写失败 → 目前 `console.error` 软吞（§7.A 登记）

## 3. 审计事件清单

**18 条**（phase166 登记 14 条 + phase178 新增 3 条 + **phase247 新增 1 条**；`src/core/motion/runtime.ts` 零自有 audit）。载荷为 `auditWriter.write(type, ...args: string[])` 的 positional string args。

| # | type | 载荷 | 触发时机（源行号） |
|---|---|---|---|
| 1 | `assemble_failed` | `module=<name>` `phase=<init\|session_repair_save>` `reason=<err>` | `initialize()` 内 inbox_reader 失败 L196 / `repairSessionIfNeeded` 保存失败 L262 |
| 2 | `task_system_init_failed` | `reason=<err>` | `taskSystem.initialize()` 抛出，L222 |
| 3 | `task_system_start_dispatch_failed` | `reason=<err>` | `taskSystem.startDispatch()` 抛出，L228 |
| 4 | `session_loaded` | `source=<session\|snapshot\|fresh>` | 加载完成，L253 |
| 5 | `session_repaired` | `tools=<count>` | 工具配置重建成功，L265 |
| 6 | `snapshot_commit_failed` | `context=<session-repair\|turn-N>` `reason=<err>` | snapshot commit 抛出，L267 / L539 |
| 7 | `snapshot_commit_uncategorized` | `context=<...>` `exitCode=<n>` | snapshot commit 返回未分类错误，L271 / L543 |
| 8 | `turn_start` | — | 三入口轮起，L576 / L657 / L705 |
| 9 | `turn_end` | — | 三入口轮正常结束，L587 / L664 / L713 |
| 10 | `turn_interrupted` | `cause=<idle_timeout\|priority_inbox\|user_interrupt>` [`ms=<n>`] | `_handleTurnInterrupt`，L822 / L825 / L828 |
| 11 | `turn_error` | `err=<msg>` | `_handleTurnInterrupt` 兜底分支，L832 |
| 12 | `llm_call` | `<model>` `in=<tokens>` `out=<tokens>` `ms=<n>` | LLMService 成功回调，L505 / L783 |
| 13 | `llm_error` | `<model>` `err=<msg>` `ms=<n>` | LLMService 失败回调，L503 / L781 |
| 14 | `inbox_meta_failed` | `file=<name>` `kind=<err-kind>` | `_hasHighPriorityInbox` 内 meta 读失败，L850 |
| 15 | `session_archive_failed` | `reason=<err.message>` | `initialize()` step 3 `sessionManager.archive()` 非 ENOENT 失败（phase178 新增）|
| 16 | `inbox_handler_failed` | `handler=onInboxMessages` `reason=<err.message>` | `processBatch()` `callbacks.onInboxMessages(infos)` 抛错（phase178 新增）|
| 17 | `outbox_write_failed` | `context=error_response` `scenario=<max_steps_exhausted\|non_interrupt_error>` `reason=<err.message>` | `processBatch()` catch 内 `outboxWriter.write(...)` 写 error response 失败；经 `_writeErrorResponse` helper 发出（phase178 新增）|
| 18 | `runtime_process_batch_failed` | `context=Runtime.processBatch` `error=<msg>` | `processBatch()` catch 最外层 —— turn 执行本身抛错（非 outbox 写失败）；phase247 由 `monitor?.log` 迁移（`57f51be`）|

**透传字段标注**：
- `turn_interrupted.cause` 集合由本模块定义（3 值）；`ms` 来自 `IdleTimeoutSignal.timeoutMs`
- `llm_call` / `llm_error` 的 `<model>` 透传自 `LLMService.LLMInfo`，语义归 LLMService 契约

### phase178 新增 3 types 详细 schema

#### `session_archive_failed`

- **触发时机**：`Runtime.initialize()` step 3 内 `sessionManager.archive()` reject 且 err.code 非 ENOENT / FS_NOT_FOUND
- **前置条件**：sessionManager 已构造 / initialize 已进入 step 3
- **后置状态**：audit 写入 + console.warn 双写后继续执行（软吞不中断 initialize；session repair step 5 仍会执行）
- **载荷**：`reason=<err?.message>`（err 来自 any cast，message 可能 undefined）
- **与 `assemble_failed` 差异**：`assemble_failed` 属 Assembly 装配期失败或 Runtime.initialize 子模块 init 失败（如 inbox_reader / session_repair_save）；本事件属 step 3 启动归档独立语义，与装配期分离

#### `inbox_handler_failed`

- **触发时机**：`Runtime.processBatch()` 内 `callbacks.onInboxMessages(infos)` 抛错
- **前置条件**：inbox 有消息（count > 0）+ callbacks.onInboxMessages 存在
- **后置状态**：audit + console.warn 双写后继续主 turn 驱动（软吞不中断 processBatch；review_request 等 handler 失败不影响 turn）
- **载荷**：`handler=onInboxMessages`（固定字段，未来 processBatch 加其他 handler 可复用 type + handler 字段区分） / `reason=<err.message>`

#### `outbox_write_failed`

- **触发时机**：`Runtime.processBatch()` catch 分支内 `outboxWriter.write(...)` reject；经 `_writeErrorResponse` 私有 helper 发出（helper 合并 A3/A4 两分支）
- **前置条件**：turn 抛错（`MaxStepsExceededError` 或非 signal 非 MaxSteps Error）+ 分派给 sender 回写 error response 失败
- **后置状态**：audit + console.error 双写后 processBatch 继续走 `runtime_process_batch_failed` audit（L632，phase247 迁移）+ throw err 上抛
- **载荷**：`context=error_response` / `scenario=<max_steps_exhausted\|non_interrupt_error>` / `reason=<err.message>`
- **scenario 枚举**：
  - `max_steps_exhausted`：`_runReact` 抛 `MaxStepsExceededError` 后回写失败
  - `non_interrupt_error`：`_runReact` 抛非 signal / 非 MaxSteps Error 后回写失败
- **与 runtime_process_batch_failed 的关系**（phase247 更新）：L632 原 `monitor?.log('error', {...})` 已由 phase247 迁移为 `auditWriter.write(RUNTIME_PROCESS_BATCH_FAILED, ...)`；二者是不同语义：`outbox_write_failed` = "error response 写出失败"，`runtime_process_batch_failed` = "turn 执行本身抛错"

**不在本清单**（phase166 Step 1 扫描核实在 Runtime 外发出）：`inbox_inject` / `inbox_unaddressed` / `tool_result` / `cleanup_temp_files_failed` —— 由 StepExecutor / ToolExecutor / InboxReader / Assembly 各自契约 §3 登记。

## 4. 上游依赖

### 同仓

| L 层 | 模块 | 契约 / 位置 | 注入字段 |
|---|---|---|---|
| L1 | FileSystem | `design/modules/l1_filesystem.md` | `systemFs` / `clawFs` |
| L1 | LLMService | `design/modules/l1_llm_service.md` | `llm` |
| L2 | AuditLog | `design/modules/l2_audit_log.md` | `auditWriter` |
| L2 | Snapshot | `design/modules/l2_snapshot.md` | `snapshot` |
| L2 | SessionStore | `design/modules/l2_session_store.md` | `sessionManager` |
| L2 | Messaging | `design/modules/l2_messaging.md` | `inboxReader` |
| L2 | Stream | `design/modules/l2_stream.md` | setter 注入 `StreamLog`（见 §5.4） |
| L2 | Tools | `design/modules/l2_tools.md` | `toolRegistry` / `toolExecutor`（~~原表列 L3 StepExecutor / Tools r31 移 L2 后 drift~~）|
| L3 | StepExecutor | `design/modules/l3_step_executor.md` | `toolRegistry` / `toolExecutor`（同上 / Assembly 装配时 Tools→StepExecutor 传递）|
| L3 | Dialog（ContextInjector）| 内部 `src/core/dialog/injector.ts`（无独立契约）| `contextInjector` |
| L2 | ExecContext | 内部 `src/core/tools/context.ts`（无独立契约）| `execContext`（~~原表列 L3 / 实来自 Tools(L2)~~）|
| L4 | Communication | 内部 `src/core/communication/`（无独立契约）| `outboxWriter` |
| L4 | SkillRegistry | 内部 `src/core/skill/registry.ts`（无独立契约）| `skillRegistry` |
| L4 | ContractSystem | `design/modules/l4_contract_system.md` | `contractManager` |
| L4 | TaskSystem | `design/modules/l4_task_system.md` | `taskSystem` |

所有依赖经构造期 `RuntimeDependencies` 注入（单向耦合档位见 §5.1）。

### 外部（major 版本）

无直接外部 major 依赖。间接经 LLMService 依赖 Anthropic / OpenAI SDK（归 LLMService 契约）。

### 已知破坏性升级

无当前 phase。phase167+ L5 其他模块（SkillSystem / Cron / MemorySystem）契约落地时可能反向影响本契约 §4 字段映射。

## 5. 不可消除的耦合

每处登记：**方向 + 档位（类型层 / 运行时断言 / 测试锚点 / 纯文档）+ 消除路径或放弃理由**。

**消除路径首选 port pattern**（feedback_module_contract_structure r40.2）：消费方 own port + 默认实现 + assembly 注入 / phase337 (TaskScheduler) + phase335 (13 port) + phase340 (ContractVerifierScheduler) **三 phase 实证**。Runtime §5.1 RuntimeDependencies 即 13 port 注入范本（消费方 own = Runtime own / Assembly 注入）。

### 5.1 RuntimeDependencies 构造期注入

- **方向**：Runtime → L1-L4（15 个字段对应上游模块单向依赖）
- **档位**：类型层（`RuntimeDependencies` interface，16 字段全部 `readonly`；tsc 可查）
- **消除路径**：无需消除——单向注入是"不可消除耦合"的典范形态；字段增减走 `RuntimeDependencies` interface 演进

### 5.2 DispatchTool 注册闭包依赖

- **方向**：Runtime `initialize()` 内部 → `DispatchTool` 构造 → `toolRegistry.register(...)`；DispatchTool 闭包捕获 runtime-adjacent 上下文
- **档位**：纯文档
- **无法升档的理由**：闭包引用需运行期才能绑定动态状态；tsc 无法在类型层表达"闭包捕获了哪些动态字段"。**当前 Assembly 契约（`design/modules/l6_assembly.md`）尚未登记该闭包依赖**，phase166 §7.B `B.p166-1` 注记此未锚，待 phase167+ Assembly 契约补登记后本条引用升格
- **消除路径**：Assembly 层收拢（`B.p166-1`）；粗糙期不改

### 5.3 StreamCallbacks / DaemonStreamCallbacks 协议归属

- **方向**：Runtime 定义 interface → daemon-loop / CLI 消费者 implement → Runtime 在 `_runReact` 内调用回调；消费者不反调 Runtime
- **档位**：类型层（两 interface 均 `export`，消费者通过 TS 参数类型受 tsc 约束）
- **形态**：publisher-subscriber 形态 B（与 LLMService `LLMEventSink` 同型）；按 `feedback_cycle_vs_reverse_dependency` 判据：代码依赖图 Runtime → daemon-loop 仅类型 import、daemon-loop → Runtime 值 import 单向，无循环
- **消除路径**：不消除——protocol ownership 是契约正常形态；协议扩字段直接加到 interface

### 5.4 装配期 setter 注入（双阶段）

- **方向**：Assembly `assemble()` 构造 Runtime → Assembly 构造 StreamWriter / contractNotify 回调 → Assembly 调 `runtime.setParentStreamLog(...)` / `runtime.setContractNotifyCallback(...)`
- **档位**：类型层（setter 参数类型 `StreamLog` / 回调签名受 tsc 检查）+ 测试锚点（`tests/assembly/assemble.test.ts:421-439` 断言 setter 调用 + 回调语义）
- **形态**：publisher-subscriber 形态 B；Runtime 内部 `this.contractManager?.setOnNotify(cb)` / `this.taskSystem?.setParentStreamLog(sink)` 透传 delegate
- **无法全部升档到"构造期类型层"的理由**：`parentStreamLog` / `contractNotifyCb` 在 Runtime 构造**之后**由 Assembly 基于 `clawId` / `clawDir` 建成，时序锁死；合入 `RuntimeDependencies` 需重排 Assembly 第 7 / 9 步
- **消除路径**：细化期考虑（详见 §7.B `B.p166-5`）

### 5.5 MotionRuntime extends ClawRuntime 继承链

- **方向**：MotionRuntime → ClawRuntime（单向继承，子类调 `super.initialize()` + override `buildSystemPrompt`）
- **档位**：类型层（TS `class MotionRuntime extends ClawRuntime`）
- **形态**：identity 分支的继承表达；工厂 `createRuntime({ identity })` 把分支消化在入口（phase166 Step 5 落地）
- **消除路径**：不消除——继承粒度合适（2 override + 1 unregister）；细化期不拆（详见 §7.B `B.p166-2`）

## 6. 持久化

**无本模块磁盘布局**。

Runtime 是纯运行时模块，本身不拥有任何磁盘资源：

- **session 状态**：由 `sessionManager` 持久化（归 SessionStore 契约 §6）
- **audit 日志**：由 `auditWriter` 追加写（归 AuditLog 契约 §6）
- **snapshot**：由 `snapshot` 提交（归 Snapshot 契约 §6）
- **inbox / outbox**：分别由 `inboxReader` 读、`outboxWriter` 写（归 Messaging 契约 §6 / Communication 内部）

**消费常量注脚**：`MOTION_CLAW_ID` / `DEFAULT_MAX_STEPS` / `DEFAULT_LLM_IDLE_TIMEOUT_MS` / `DEFAULT_MAX_CONCURRENT_TASKS` 定义在 `src/constants.ts`，为跨模块共享 sentinel；本契约 §2.1 `ClawRuntimeOptions` 的 `maxSteps?` / `idleTimeoutMs?` / `maxConcurrentTasks?` 缺省值取自该文件。全局常量聚合归属讨论非本契约范围。

**运行时恢复语义**：`initialize()` 期内 `sessionManager.load()` 加载上一 session（加载源：`session` 文件 / `snapshot` 回放 / `fresh`，发 `session_loaded` audit）；`repairSessionIfNeeded()` 做工具配置重建（发 `session_repaired`）；Runtime 不直接触碰磁盘。

## 7. 与实然的差距

### 7.A 必修违规（phase178 全部清零）

所有 7.A 条目违反 Design Principle #2「运行中产生的任何信息，未经显式设计决策，不得丢弃或静默忽略」。phase166 粗糙期登记 → **phase178 细化期全部清零**（`f309c23`）。

~~1. **启动归档失败软吞**~~（**phase178 已清零**）
   - 原位置：`src/core/runtime.ts:211`
   - 原违反：`console.warn('[runtime] Failed to archive session on startup:', err?.message)`，无 audit
   - **phase178 落地**：新 audit type `session_archive_failed`（`reason=<err.message>`）；audit 先行 + console 保留双写

~~2. **onInboxMessages handler 失败软吞**~~（**phase178 已清零**）
   - 原位置：`src/core/runtime.ts:564`
   - 原违反：`console.warn('[runtime] onInboxMessages handler failed:', e)`
   - **phase178 落地**：新 audit type `inbox_handler_failed`（`handler=onInboxMessages`, `reason=<err.message>`）；双写

~~3. **错误响应 outbox 写失败软吞（路径 1 MaxStepsExceededError）**~~（**phase178 已清零**）
   - 原位置：`src/core/runtime.ts:609`
   - 原违反：`.catch(e => console.error('[runtime] Failed to write error response:', e))`
   - **phase178 落地**：新 audit type `outbox_write_failed`（`context=error_response`, `scenario=max_steps_exhausted`, `reason=<err.message>`）；新 `_writeErrorResponse` private helper 抽取消除 A3/A4 重复

~~4. **错误响应 outbox 写失败软吞（路径 2 非 signal / 非 MaxSteps）**~~（**phase178 已清零**）
   - 原位置：`src/core/runtime.ts:623`
   - 原违反：同条 3，另一分支
   - **phase178 落地**：复用 `_writeErrorResponse` helper（`scenario=non_interrupt_error`）；彻底消除 A3/A4 两分支 for 循环内重复 audit 集成

**清零方法**（详见 §7.Phase phase178 纪律节）：
- 4 位点 audit 双写（audit 先 / console 保留）—— phase173 确立模式第 3 次应用
- `outbox_write_failed` 单 type + `scenario` 字段区分 A3/A4 双分支（避免双 type 碎片化，D2 决策）
- `_writeErrorResponse` 私有 helper 抽取 —— **细化期 A 类清零首次引入 helper 抽取**消除 audit 集成重复（D3）
- 测试双粒度断言（type 级 + payload 级 regex；Runtime 原 `const audit: string[] + spyOn` 风格保持，D4）

§7.A phase178 后实然状态 = **无剩余必修违规**。新 3 event types schema 见 §3 末尾"phase178 新增"段。

**phase278 新增候选**：

5. **runtime.ts L31-36 dead imports（4 个 Tool 实例）**（~~待清零 phase → B.p173-1 升档~~ → **phase288 已清零**）
   - 位置：`src/core/runtime.ts:31-36`
   - 违反：`readTool / lsTool / searchTool / execTool` 4 行 import 有声明无引用（dead imports）
   - Path #1 核：`grep` 确认仅 import 行，无调用点
   - **计划 phase**：小 code phase，4 行删除；`tsc --noEmit` 验证无 ref 残留
   - **phase288 清零**：4 dead imports 删除（commit `4616d15`）/ Path #1 实然核确认无调用点

### 7.B 偏差登记（当前合理）

每条附 **owner + 计划 phase + 升档条件**。编号用 `B.p166-*` 前缀。

**type 标签**（feedback_module_contract_structure r40.3）：B 项必标 `drift` vs `design-gap` 二分。
- **drift type**：契约说应 X / 实然 Y / 修法明确（推 §7.A 必修）
- **design-gap type**：应然 silent / 实然有 / 修法不明 / 必推独立 design phase 评估（不 mechanical）

> 现有 B.p166-* / B.p173-* 历史登记 type 分类待 r43+ 应然同步 phase 批量补标（多数为 drift / B.p166-2 MotionRuntime 继承链疑 design-gap）。

#### B.p166-1 — DispatchTool 注册闭包依赖

- **现状**：`Runtime.initialize()` 内构造 `DispatchTool` 并 `toolRegistry.register(...)`；闭包捕获 runtime-adjacent 上下文，档位"纯文档"（见 §5.2）
- **为何合规**：Runtime 需在 initialize 时动态绑定 ToolExecutor + TaskSystem 到 DispatchTool；构造期注入 + initialize 挂钩 的两阶段是合理运行时模式
- **owner**：phase166（phase163 同类偏差在 Assembly 契约继承）
- **计划 phase**：phase167+ Assembly 契约补登记 DispatchTool 闭包（**未锚**：`design/modules/l6_assembly.md` 当前不含 DispatchTool 字样，Step 3 §5.2 已注记）；细化期 phase171+ 考虑 Assembly 层收拢
- **升档条件**：Assembly 契约补登记 → §5.2 档位从"纯文档"升"测试锚点"或更高
- **phase182 评估（2026-04-21）**：保留。`l6_assembly.md` 经 grep 确认零 DispatchTool 字样（`grep -n "DispatchTool\|dispatch" design/modules/l6_assembly.md → 0`）；升档条件未触发；继续等 Assembly 专项治理 phase。

#### B.p166-2 — MotionRuntime extends ClawRuntime 继承链

- **现状**：`class MotionRuntime extends ClawRuntime` 表达 identity 分支（2 override + 1 unregister，见 §2.1）
- **为何合规**：继承粒度适中；工厂 `createRuntime({ identity })` 把分支消化在装配入口（phase166 Step 6 落地）
- **owner**：phase166
- **计划 phase**：无计划拆分——粗糙期原则"MotionRuntime extends 继承关系不改"（总览 §不纳入 明列）
- **升档条件**：若未来 identity 维度超出 2（如 watchdog / cron 独立 Runtime），重议"继承 vs 组合" → 转 7.A

**drift 登记（2026-04-21 phase173，原 modules.md 决策 #24 迁入）**：MotionRuntime subclass 物化 motion 差异**违背 Decision #24 "差异由 Assembly 按 identity 分支决定"的精神**。该差异实际是"Runtime 身份配置变体"，属 Runtime 模块业务语义（原则 #2 归属），不应通过独立 subclass 物化。

**未来独立 phase 按路径 α 修复**：
- ClawRuntime 新增 `systemPromptBuilder?` + `identityToolFilter?` 2 个 optional 构造参数
- Assembly 按 identity 注入相应函数（motion 传 `buildMotionPrompt` + `(reg) => reg.unregister('send')`；claw 传默认）
- 删除 `src/core/motion/` 子目录与 `MotionRuntime` class
- ~100 行 diff，独立 phase 规模

**原则依据**：
- #1 Runtime 单一模块 + 两种 identity 配置是独立可变职责的正确切分；subclass 是过度工程
- #2 motion 差异的业务语义归 Runtime 模块（配置变体），不独立成模块
- #7 2 个注入参数是一次性抽象，不随 identity 数量变化而扩展接口
- #8 跨边界传函数（差异本身）比传 subclass 身份信息量少；subclass 把差异藏在继承里只是位置挪移不是耦合减少

**路径 β 已被驳回**（承认 subclass 调整决策表述）：保留 subclass 会永远留一条"motion 差异可独立 override"的暗线，每次新差异都诱惑加 override，是原则 #1/#2 的永久 drift 源。

**phase182 评估（2026-04-21）**：保留 + drift 重申。路径 α 独立 phase 规模 ~100 行 diff，scope 不在 phase182；drift 节（phase173 迁入）原地保留，4 条原则依据（#1/#2/#7/#8）充分，不重推。

**phase266 清零（2026-04-24）**：路径 α 实施完成。ClawRuntime 新增 `systemPromptBuilder?` + `identityToolFilter?` 2 optional 构造参数；`create-runtime.ts` motion 分支传 `buildMotionSystemPrompt` + `(r) => r.unregister('send')`；`src/core/motion/` 目录删除；`motion.test.ts` 改为 ClawRuntime + motion options 构造；**B.p166-2 清零**。

#### ~~B.p166-3~~ — `_drainOwnInbox` 直读 fs 绕过 InboxReader（**phase182 评估：实然已消除**）

**phase182 扫描发现**（Path #1 硬触发 / 2026-04-21）：契约文本落后于代码实然。

- **当前代码**（`src/core/runtime.ts:356`）：
  ```ts
  entries = await this.inboxReader.drainInbox();
  ```
  已经经 InboxReader 合规路径，不再直读 fs。
- **升档条件重新评估**：原"扩 `list({priority}) / readMeta` API" 不再适用 —— `InboxReader.drainInbox()`（L47）的消费型语义已覆盖 `_drainOwnInbox` 需求（一次性排空 + 消息移动）
- **残余同型问题**：`_hasHighPriorityInbox` 仍直读 fs，但属独立条目 B.p166-4（需要**非消费型**读取），不与本条混淆
- **历史保留**：以下原 phase166 粗糙期登记内容保留供追溯

**原登记内容**（phase166）：
- **原现状描述**：`_drainOwnInbox` 直读 `systemFs.readdir` + `readInboxFileMeta`（L848）—— **已不准确**，代码某前序 phase 改调 `inboxReader.drainInbox()` 时未回填契约
- **原升档条件**：InboxReader 扩 `list({priority}) / readMeta` API —— **已不相关**

#### B.p166-4 — `_hasHighPriorityInbox` 同型绕过

- **现状**：`src/core/runtime.ts:854-872` 内 `_hasHighPriorityInbox` 调 `fs.readdir(pendingDir)` + `readInboxFileMeta` 直绕 `InboxReader`
- **为何合规**：`_hasHighPriorityInbox` 需要**非消费型**读取（判是否触发中断，不消费消息），`InboxReader.drainInbox()` 消费型语义不适用；InboxReader 当前 API（init / drainInbox / markDone / markFailed）无"只读 meta"方法
- **owner**：phase166
- **计划 phase**：L1 messaging 模块扩 InboxReader 非消费型 API 独立 phase + Runtime 改调联动 phase
- **升档条件（2026-04-21 phase182 精化）**：
  - 旧描述"list({priority}) / readMeta 任一就绪"过宽 —— 与 B.p166-3 共用描述忽略了消费型/非消费型关键差异
  - 新描述：InboxReader 扩 **非消费型** `peekMetas({ priorityFilter? })` 或同型只读 API（与 `drainInbox` 消费型明确区分，B.p166-3 已由 drainInbox 覆盖）
- **phase182 评估（2026-04-21）**：保留。前置条件未就绪（`grep -nE "^\s*(async )?(list|peek|readMeta)" src/foundation/messaging/inbox-reader.ts → 0`）；等 L1 messaging 专项治理。

#### B.p166-6 — audit 事件回链测试间接化 / 缺失

- **现状**：§3 14 事件中 6 条（`turn_start` / `turn_end` / `turn_interrupted` / `turn_error` / `llm_call` / `llm_error`）仅由行为 callback 断言（`onTurnStart` / `onTurnEnd` / `onTurnInterrupted` / `onTurnError` / `onProviderInfo` / `onProviderFailed`）间接覆盖，无 `auditSpy.mock.calls.find(c => c[0] === '<event>')` 直接断言；1 条（`inbox_meta_failed`）零覆盖（见 §8.2 △/✗ 标注）
- **为何合规**：6 △ 条目的行为 callback 与 audit emission 是 `_runReact` / `_handleTurnInterrupt` 同点触发，代码路径必经——callback 断言跑通 → audit 也必发；契约诚实反映实然，不在粗糙期补测
- **owner**：phase166
- **计划 phase**：细化期 phase171+ 作为观察性债独立偿还（按 `feedback_observability_debt`：连续 2 次排查靠猜才升格独立 phase；当前无排查需求，登记即可）
- **升档条件**：下个 phase 出现"event 发出但测试没察觉"的 silent breakage → 本条升 7.A → 补 auditSpy 直接断言

#### ~~B.p166-5~~ — 装配期 setter 双阶段注入（**phase182 已清零**）

**phase182 清零**（2026-04-21，合入 main `6d0bdfc`）：

- **原登记**：`runtime.ts:922/926` 的 `setContractNotifyCallback` / `setParentStreamLog` 由 Assembly 在 Runtime 构造后调（见 §5.4）
- **升档条件就绪**：phase182 Step 1 扫描实测 —— streamWriter 依赖项（systemFs / auditWriter / clawId / clawDir / globalConfig.stream.retention）在 Assembly L82-150 构造序中全齐，可安全前置到 Runtime 构造之前（~L300 附近）
- **清零路径**：
  1. `RuntimeDependencies` 加 `parentStreamLog?: StreamLog` + `contractNotifyCallback?: (type, data) => void` 2 optional 字段（构造注入，Module Logic #6 精神：一次性构造依赖）
  2. Assembly 重排：streamWriter 前置至 Runtime 构造前；contractNotify closure 在 Runtime 构造前形成
  3. 删 Runtime 公共接口 2 方法：`setParentStreamLog` / `setContractNotifyCallback`（Path #4 破坏性改动，commit msg 论证："setter 是装配期工具非业务接口"；M7 耦合界面稳定灰度 + M6 依赖结构稳定 +2 字段）
- **§2 公共方法清单联动**：Runtime 公共接口 -2 setter
- **§5.4 档位表联动**：parentStreamLog / contractNotifyCallback 从"setter 双阶段"升"类型层（`RuntimeDependencies` 字段）"
- **原条目保留供历史追溯**：
  - 原现状描述：setter 在 Runtime 构造后调
  - 原"为何合规"：构造时序锁死（已由 Assembly 重排证明非必然）
  - 原升档条件："Assembly 可先构造 streamWriter / contractNotify 再构造 Runtime"—— 已达成

#### B.p173-1 — Runtime 直接 import L3 工具 builtins（绕过 tools 聚合出口）

- **现状**：`src/core/runtime.ts:31-36` 直接 import 6 个 `tools/builtins/` 具体文件：
  ```
  registerBuiltinTools (聚合函数)
  DispatchTool          (class，Runtime.initialize 注册闭包)
  readTool / lsTool / searchTool / execTool  (4 个 Tool 实例)
  ```
  **绕过 `core/tools/index.ts` 聚合出口**直接打到 L3 tools 内部文件
- **违反原则**：
  - #8 耦合界面最小 —— Runtime 不该知道 L3 tools 的内部文件布局；只通过 `core/tools/index.ts` 公开出口消费
  - Module Logic "每个模块通过对外入口间接访问" —— 当前是直接打入内部实现文件
- **Runtime 为什么要 import 这些**：
  - `registerBuiltinTools`：构造 per-subagent 工具 registry 时批量注册（`tools/index.ts` 已 re-export，可改 `from './tools/index.js'`）
  - `DispatchTool`：运行期 `Runtime.initialize` 末尾注册 `new DispatchTool(...)` 闭包（B.p166-1 已登记，此 import 保留合理但出口应经 `tools/index.ts`）
  - `readTool` / `lsTool` / `searchTool` / `execTool`：**phase278 Path #1 核确认为 dead imports**——`grep -n "readTool\|lsTool\|searchTool\|execTool" src/core/runtime.ts` 仅 L31-36 import 行，无任何调用点 → **升档 §7.A 候选**（删除 4 行 import，极小 scope）
- **owner**：phase173（drift 登记）→ **phase278 升档判定**
- **计划 phase**：两步分拆 —— (A) dead imports 删除（4 行，极小 code phase）；(B) `registerBuiltinTools` / `DispatchTool` 改走 `core/tools/index.ts` 聚合出口（独立评估）
- **升档条件**：若 L3 tools 内部文件重组 / 重命名 → Runtime 的 6 行 import 跟着漂移 → 触发本条升级为 A 类（耦合面蔓延到具体文件路径）

### 7.C 原则对照

全 26 条覆盖（Module Logic 11 + Design 11 + Philosophy 4；Design #1 展 a-d 四面、Design #6 展 a-b 二面，条目数合计 29）。深度按需：合规一行 / 灰度展开 / 违反引用 §7.A 或 §7.B。

#### Module Logic Principles（11 条）

- **M1 独立可变职责**：合规。Runtime 职责 = "常驻 agent 事件驱动循环 + session 生命周期 + turn audit + 中断响应 + snapshot 轮级 commit"，变更源（循环策略 / 中断响应 / session repair）与 L1-L4 模块不同
- **M2 业务语义归属**：合规。四入口（`processBatch` / `processWithMessage` / `retryLastTurn` / `chat`）由 Runtime 主动发起；装配 / LLM 原子执行 / 队列调度 / 契约状态机归他模块
- **M3 资源归属**：合规。Runtime 无磁盘资源（§6），session / audit / snapshot / inbox / outbox 各归其主；常量归 `src/constants.ts`（全局共享）
- **M4 持久化**：合规。运行时句柄全部在内存；session 经 `sessionManager` 从磁盘恢复（§2.2 `initialize()` 后置）
- **M5 依赖单向 / 禁循环**：合规。RuntimeDependencies 16 字段单向（§5.1）；StreamCallbacks / setter 注入按 publisher-subscriber 形态 B 合规（§5.3 / §5.4，代码依赖图无循环）
- **M6 依赖结构稳定**：合规。`RuntimeDependencies` interface 自 phase155B 冻结，运行期不变（字段 `readonly`）
- **M7 耦合界面稳定**：合规。本 phase 只加 `createRuntime` 工厂，不改 ClawRuntime / MotionRuntime 公共方法；工厂 intersection type 把 identity 约束限定在工厂入口，不污染构造器（phase166 Step 1 D1）
- **M8 耦合界面最小**：**灰度（phase182 改善）**。公共方法 13 → 11（phase182 `6d0bdfc` delete 2 setter）；仍 > 8 阈值（phase185 DaemonLoopOptions 标准）；按职责聚合成 5 组（§2.1）；phase224 M#3 Path #1 复核保留灰度（未跨越阈值 / 归属 Runtime 模块自主决策 Path #7 / 等方法粒度 refactor 独立 phase）
- **M9 显式表达编译器可检**：合规。所有 interface / setter 参数 / 工厂签名 tsc 强类型；`setContractNotifyCallback` 的 `Record<string, unknown>` 是 structural 契约（phase160 曾讨论 B.10，本模块不新增）
- **M10 不合理停下**：触发 1 次，详见 §7.Phase 纪律.1（Step 2 落笔前发现总览 §2-§6 节号错位，停下讨论并回灌）
- **M11 边界不对停下**：未触发。Runtime 边界稳定，本 phase 不改边界

#### Design Principles（11 条；#1 展 4 面、#6 展 2 面）

- **D1a 信息不丢失**：合规。session 经 sessionManager；inbox 经 drainInbox 吸收；turn 级状态经 audit
- **D1b 状态可观察**：合规。stream callbacks 透传 + audit 事件全链路（§3 14 条）
- **D1c 中断可恢复**：合规。`repairSessionIfNeeded` + 三种中断（idle / priority / user）都有 audit
- **D1d 事后可审计**：合规。§3 14 事件覆盖 session / turn / llm / snapshot / inbox_meta / assemble 全链路
- **D2 不得丢弃/静默**：**合规**（phase178 §7.A 4 条全部清零 / `f309c23` 新增 `session_archive_failed` / `inbox_handler_failed` / `outbox_write_failed` audit / audit + console 双写；phase222 G1 Path #1 复核前进）
- **D3 用户可观察**：合规。同 D1b
- **D4 LLM 调用恢复**：合规。`_runReact` 后由 `processBatch` / `retryLastTurn` 驱动恢复
- **D5 日志重建**：合规。§3 事件 + session 文件足以重建任一时刻状态
- **D6a 决策主体**：合规。Runtime 本身是决策触发器；LLM 决策经 `_runReact` 路由
- **D6b 子代理不阻塞**：合规。经 TaskSystem（phase163 文件驱动消除循环耦合）
- **D7 系统可信路径**：合规。L1-L4 受信注入，tools 经 ToolExecutor 受约束路径
- **D8 事件驱动**：合规。`processBatch` 的 inbox 排空 → turn 循环即事件驱动
- **D9 多 claw 不隔绝**：无关（跨 claw 访问归 Motion / Watchdog / Gateway 契约）
- **D10 motion 特殊**：合规。MotionRuntime override（§2.1）表达 motion 身份差异
- **D11 CLI 唯一对外**：无关（Runtime 是内部运行时，不对外）

#### Philosophy（4 条）

- **P1 Agent 即目录**：合规。Runtime 消费 `clawDir` + `systemFs` / `clawFs`，所有 agent 状态映射到目录
- **P2 上下文工程**：合规。`contextInjector` / `buildSystemPrompt` / stream callbacks 全链路是上下文流转
- **P3 多 agent 利用**：合规。TaskSystem 驱动 subagent 并行；Runtime 按 identity 复用同一代码基
- **P4 系统为智能体服务**：合规。Runtime 提供 "决策所需信息 + 基础设施"（session / tools / stream / audit）而非模拟人类组织

#### Path Principles（6 待核 / r42 audit fork 补登）

> Path 6 authoritative source 待核 / 暂列已知 4 + 待补 2（与 l4_contract_system / l4_task_system / l5_cron 同型 / r43+ Meta 30 评估时统一）

| # | 已知 | 判定 | 证据 |
|---|---|---|---|
| Path #1 | 实测核 baseline | 合规 | phase178/182/247/266/278/295 各 phase 起步 Path #1 核 / 多次推翻或验证应然 |
| Path #3 | 语义原子最小变更单元 | 合规 | phase266 motion subclass 消灭 / 单 commit / 无 caller 改 |
| Path #6 | 冲突停 | 合规 | 纪律.1 总览 vs 规范节号错位 → 停 → 用户确认 |
| Path #8 | 总难度最低 | 合规 | phase335 13 port 一次注入 vs 散点改 / 总难度最低 |
| Path #?-1 | 待核 | - | - |
| Path #?-2 | 待核 | - | - |

### 7.D 关键决策映射表（modules.md 迁移）

从 `design/modules.md` §关键设计决策章节迁移（2026-04-26 主会话；后续清理阶段重构）。原 KD 编号保留供对账。

- **KD#16（原 modules.md）事件驱动循环归 Runtime**：daemon-loop 的逻辑归 Runtime；Daemon 调 `Assembly.assemble(config)` 拿到 Instances 后调 `Runtime.start(instances)`
- **KD#25（原 modules.md）Runtime 不自建 L1-L2 实例**：构造器接收 `dependencies: RuntimeDependencies`，由 Assembly 预制所有依赖后注入；跨模块共享实例（如 Snapshot）由 Assembly 构造一次同时出现在 `Instances` 和 `RuntimeDependencies` 中

---

### 7.Phase 执行纪律

本 phase 实施过程中的非架构偏差登记（按 `feedback_module_contract_structure` §7.Phase 硬化规则）。

#### 纪律.1 — 总览与规范节号错位（Step 2 落笔前捕获）

- **触发**：Step 2 落笔前对比总览 §2 契约结构节（"§2 职责边界 / §3 接口 / §4 审计 / §6 配置常量"）与 `feedback_module_contract_structure` 规范（"§1 合所有权 / §2 接口 / §3 可观测事件 / §6 持久化"），发现节号错位 + §6 语义不同
- **违反条款**：M10 不合理停下（规范冲突未及早停）
- **纠错链路**：Step 2 计划前停下与用户确认 → 用户明示按规范走 → 回灌总览 §范围 节结构 + Step 分解（6→8→9）
- **根因**：总览起稿时未 cross-check `feedback_module_contract_structure` 规范（违反 `feedback_apply_principles_first` 开工前对照原则）
- **治理路径**：本 phase 已治理；元规则层面由 `feedback_verify_facts_before_plan` 已覆盖"清单性断言一律佐证"

#### 纪律.2 — 无 agent 越界 / 无纠错链路

本 phase 无 agent 在产品代码加 test-aware fallback / 自主扩字段等越界；无 Step 追加修（Step N → Step N-1 反向修补）；Step 2 的计划结构调整（6→8→9 步）属于 Step 1 扫描产出后"计划粒度精细化"，非纠错。

#### 纪律.3 — 计划穿透的桌面演练预告

phase166 Step 6（`createRuntime` 工厂）/ Step 7（Assembly 改造）涉及跨函数副作用（构造期 + initialize 期），落笔前将按 `feedback_test_desk_walk` 三段对账（调用链 → 产品状态机 → 断言）。粗糙期 tests 不改，桌面演练只覆盖现有 `runtime.test.ts` / `motion.test.ts` / `runtime-initialize-failures.test.ts` 回归路径不退化的预判，Step 6/7 §R 登记演练摘要。

#### 纪律.4 — D2 决策漏核循环导入（Step 6 §前置捕获）

- **触发**：Step 6 落笔前核查工厂放置位置，发现 Step 1 D2 选"工厂导出到 `runtime.ts` 末尾"会触发 ESM 循环导入——`motion/runtime.ts:12` 已 `import { ClawRuntime } from '../runtime.js'`（值 import），若 `runtime.ts` 反向 `import { MotionRuntime } from './motion/runtime.js'` 则两文件值 import 构成环
- **违反条款**：`feedback_apply_principles_first` 开工前对照原则 M5（依赖单向 / 禁循环）；Step 1 扫描 D2 决策未对目标放置位置做反向依赖图对照
- **纠错链路**：Step 6 计划 §前置 D2 修订节捕获 → 改选新文件 `src/core/create-runtime.ts`（同层独立，单向 `create-runtime.ts → runtime.ts / motion/runtime.ts`）→ Step 6 §验收 4/5 循环防御 grep 确认 0 命中 → Step 6 commit `8445792` 落地
- **根因**：Step 1 D2 评估"最小改动"时未检查文件级 import 图。M5 是原则 5 核心条款，D 节决策应直接跑 `grep -n "from.*<目标模块>"` 反向核查，而非凭"最小扰动"直觉
- **治理路径**：本 phase 已治理（改放独立文件）；元规则层面 `feedback_apply_principles_first` "漏率最高条 #5/#8/#9 开工前必查" 已覆盖原则层，但 Step 1 扫描纪律可追加"凡 X 放 Y 处的决策，必同时 grep Y→X 方向 import"作为 D 节硬产出；连续 2 phase 同型漏核则升格（按 `feedback_step_plan_structure` §升格条件）

#### phase178 纪律 — Runtime §7.A 4 条清零（细化期 A 类清零第 3 phase，2026-04-21，合入 `f309c23`）

- **scope**：承 phase173 daemon-loop / phase174 daemon-command 细化期 A 类清零模板；Runtime §7.A 4 条 console 软吞全部 audit 化
- **产出**：
  - `runtime.ts` 4 位点 audit 集成（3 新 type + 1 private helper `_writeErrorResponse`），净 +53 / -19
  - `runtime.test.ts` +5 it（双粒度断言：type 级 + payload 级 regex）
  - 本契约三节修订：§7.A 4 条划去标"phase178 已清零" + §3 扩 14→17 types + 本纪律节

- **Path Principles 6 条实践**（phase174 首次显式 + 本 phase 二次巩固）：

| Path | 本 phase 落实 |
|---|---|
| #1 规划基于规划时刻事实 | Step 1 扫描 F1-F4 含邻近代码 Read ±10 行（phase169 C1 形态变种 4 次升格硬化） |
| #2 差距显式登记 | phase166 §7.A 登记 → phase178 清零（差距→治理→关闭完整链） |
| #3 语义一致最小变更单元 | Step 2/3/4/5 单 commit 单 audit；A3/A4 先 helper 抽取再 A4 复用（非同 Step 合并） |
| #4 可回滚 + 破坏性论证 | §7.A 条目划去属破坏性改动；commit msg + 本节论证"已实然清零"；design 本地 only 可回滚 |
| #5 完成后复盘 | Step 7 三维 + Path 4 维复盘 + memory 登记 `project_phase178_runtime_audit.md` |
| #6 冲突立即中断 | 未触发（Step 1 扫描未发现 §7.A 4 条位点漂移） |

- **与 phase173/174 对比**：
  - phase173 daemon-loop §7.A1 清零（5 audit event type 集成，粒度最大）
  - phase174 daemon.ts §7.A4a/d 清零（测试补齐为主，无 audit 新增）
  - **phase178 Runtime §7.A 4 条清零**（3 新 audit type + 1 helper 抽取；粒度中等）

- **方法论贡献**：
  - audit 双写决策（audit 先 / console 保留运维可见性）—— phase173 确立，本 phase 第 3 次复用
  - helper 抽取消除重复的 audit 集成 —— **本 phase 首次落地**（`_writeErrorResponse`），可供 phase179+ 同型 A 类清零参考
  - scenario-based audit 分类模式 —— 单 type + `scenario` 字段区分同事件不同触发分支（A3/A4 共用 `outbox_write_failed`），phase173/174 未出现的新模式
  - Runtime 测试 `const audit: string[] + spyOn + regex` 风格 —— 与 phase174 daemon-command `toHaveBeenCalledWith + stringContaining` 风格并存（两种均双粒度，按模块原风格保持 Path #3）

- **升格候选**（暂不升格，观察 phase179+）：
  - B2 `_writeErrorResponse` helper 抽取消除 audit 重复 —— 首次落地，待同型验证
  - A3 scenario-based audit 分类 —— 单次识别，待模式复用后再评

#### phase182 纪律 — Runtime §7.B B.p166 5 条偏差治理评估（2026-04-21，合入 main `6d0bdfc`）

- **scope**：承 phase173 Daemon §7.A/B 治理模式；Runtime §7.B B.p166-1 至 B.p166-5 共 5 条 B 类偏差逐条评估（不含 B.p166-6 observability 债 / B.p173-1 L3 tools import）
- **决策矩阵结果**：

| # | 偏差 | 前置条件就绪 | 决策 | 代码改动 |
|---|---|---|---|---|
| B.p166-1 | DispatchTool 闭包 | 否（Assembly 契约未补）| 保留 | 无 |
| B.p166-2 | MotionRuntime subclass | 独立 phase 规模 scope 外 | 保留 + drift 重申 | 无 |
| B.p166-3 | `_drainOwnInbox` 直读 fs | **实然已消除**（Path #1 发现）| **降档** | 无 |
| B.p166-4 | `_hasHighPriorityInbox` 同型 | 否（InboxReader 缺非消费型 API）| 保留 + 升档条件精化 | 无 |
| B.p166-5 | setter 双阶段 | 是 | **升档** | ~50-80 行 + ~20-30 测试 |

- **Path Principles 6 条实践**（phase174 首次 / phase178 二次 / phase182 第 3 次）：

| Path | 本 phase 落实 |
|---|---|
| #1 规划基于规划时刻事实 | ✓✓ Step 1 扫描 5 条偏差全 Read 邻近代码 ±10 行；**发现 B.p166-3 契约文本落后实然**（关键保护，若不 Read 则决策全错） |
| #2 差距显式登记 | ✓ 决策矩阵按"前置条件 / 决策 / 理由"三字段明示 |
| #3 语义一致最小变更单元 | ✓ B.p166-5 升档单独 commit；4 条评估同契约更新；不碰 B.p166-6 / B.p173-1 |
| #4 可回滚 + 破坏性论证 | ✓ B.p166-3 划去（降档） + B.p166-5 升档删 Runtime 2 setter 均属破坏性；commit msg 论证"setter 是装配期工具非业务接口" + "契约文本应与实然一致" |
| #5 完成后复盘 | Step 5 三维 + Path 4 维复盘 + memory 登记 |
| #6 冲突立即中断 | ✓ Step 1 发现 B.p166-3 实然偏离 → 立即重评决策（原计划保留 → 改降档） |

- **方法论贡献**：
  - **B 类偏差治理评估模板**（首次实践）：§7.B 每条按"前置条件 / 决策 / 理由"三字段定期评估，不仅是"登记后置之不理"；可扩至其他模块 B 类审查
  - **契约 ↔ 实然一致性保护**：B.p166-3 发现契约文本落后实然数个月；验证 Path #1 "规划基于规划时刻事实"对契约文档本身同样适用（不仅限于代码事实）
  - **升档条件精化**（B.p166-4）：宽泛描述"list({priority}) / readMeta"（与 B.p166-3 共用忽略消费型/非消费型差异）→ 精确"非消费型 peekMetas"；减少未来升档误判
  - **setter 双阶段消除**（B.p166-5）：构造注入 > 运行时 setter，Module Logic #6 精神首次落地；未来类似"装配期 setter"可参

- **升格候选**（暂不升格，观察 phase183+）：
  - **§7.B 每 phase 收尾 Read 条目邻近代码核实文本是否与实然一致** —— 本次 B.p166-3 首次触发"契约落后实然"；连续 2 次发现即升格 feedback

#### phase266 纪律 — B.3 MotionRuntime 消灭（r20 分支 D / 2026-04-24）

- **scope**：整理债 B.3 消化；路径 α 实施；`src/core/motion/runtime.ts` 删除；ClawRuntime +2 optional params；`create-runtime.ts` motion 分支切 `ClawRuntime + buildMotionSystemPrompt`；`motion.test.ts` 重构为 ClawRuntime + motion options 构造；B.p166-2 清零
- **B.3 整理债**：**已消化**（代码组织整理债.md B.3 → 已消化 by phase266）
- **B.p166-2**：**清零**（详见 §7.B B.p166-2 节 phase266 清零块）

#### phase247 纪律 — B.2 Monitor 废止 sub-phase 3 Runtime 迁移（r15 分支 C / main `57f51be` / 2026-04-24）

- **scope**：`src/core/runtime.ts` L630 `this.monitor?.log('error', {...})` → `this.auditWriter.write(AUDIT_EVENTS.RUNTIME_PROCESS_BATCH_FAILED, ...)`；~~monitor 字段（`.close()` / 赋值）保留~~（phase297 已清零）
- **新增常量**：`RUNTIME_PROCESS_BATCH_FAILED`（`runtime_process_batch_failed`）
- **§3 同步**：18 条（+1）+ `outbox_write_failed` 后置状态描述更新
- **B.2 工程进度**：17 + 44 + 5 = 66/73；runtime.ts 剩余 `.monitor` 用法（`.close()` + 赋值）~~留全量 monitor 拆除 phase~~ → phase297 清零

#### phase278 纪律 — §7.B 系统评估（r22 分支 C / 2026-04-24，design 本地 only）

- **scope**：r22 C §7.B 全模块评估；Runtime 涉及 B.p173-1 升档判定
- **B.p173-1 dead imports 升档**：Path #1 grep 确认 `readTool/lsTool/searchTool/execTool` 4 处 import 无引用点 → 从 §7.B "疑似遗留"升格为 §7.A 待清零候选（极小 scope，4 行删除）
- **本契约变更**：§7.A 新增候选.5 dead imports 条目 + §7.B B.p173-1 升档判定标注

#### phase295 纪律 — C.1 Runtime 目录收拢（r25 分支 D / 2026-04-25 / 86683e4）

- **scope**：整理债 C.1 消化；git mv 4 files（runtime.ts / create-runtime.ts / heartbeat.ts / last-exit-summary.ts）→ `src/core/runtime/`；内部 import 深度 +1 层（~42 行）；NEW `src/core/runtime/index.ts` 聚合出口（6 re-exports）；20 外部消费者切 via index；assemble.test.ts vi.mock 路径同步
- **C.1 整理债**：**已消化**（代码组织整理债.md C.1 → 已消化 by phase295）
- **零 §7.A / §7.B 变更**：纯物理迁移，不改接口与实现，contract 无需更新

## 8. 测试覆盖

### §8.drift — 应然 framing drift（phase324 pilot 发现 / 2026-04-26）

| # | 位置 | drift 描述 | 修正 |
|---|---|---|---|
| D1 | §head | 无应然/实然 split / 仅 "> 应然承诺。实然差距见 §7" | 补全 head pattern（已执行）|
| D2 | §4 依赖表 toolRegistry/toolExecutor 行 | 原列 L3 StepExecutor / Tools r31 移 L2 后应为 L2 Tools | 新增 L2 Tools 行 + 保留 L3 StepExecutor 行 + drift 标注（已执行）|
| D3 | §4 依赖表 ExecContext 行 | 原列 L3 / `src/core/tools/context.ts` 属 Tools(L2) | 改 L2 + drift 标注（已执行）|

**framing 盲点**：L5 Runtime §4 依赖表按"消费关系"（StepExecutor 消费 ToolRegistry）映射层级，而非按"类型定义归属"（ToolRegistry 定义在 Tools L2）。r31 Tools L3→L2 后需按定义归属重新映射。

### 8.1 行为覆盖

按 §2 公共方法 5 组归类（行为路径清单，非覆盖率数字）：

- **lifecycle**
  - `initialize()` 成功路径：session_loaded audit + tool 注册 + `taskSystem.startDispatch()` 调用
  - `initialize()` 失败路径：`task_system_init_failed` / `task_system_start_dispatch_failed` / `assemble_failed`（inbox_reader）各自异常（`runtime-initialize-failures.test.ts` 专项）
  - `stop()` 调 `taskSystem.shutdown()` 清理
  - `resumeContractIfPaused()` 挂起契约恢复
- **事件循环入口**
  - `processBatch()` 无 inbox 返回 0（空 fast path）
  - `processBatch()` 有 inbox 触发 `_drainOwnInbox` + `_runReact` + turn audit pair
  - `processBatch()` 触发 `onInboxMessages` 回调
  - `processWithMessage(msg)` 合成消息单轮
  - `retryLastTurn()` 重试
  - `chat(...)` REPL 路径
- **中断**
  - `abort()` 触发 `UserInterrupt` → `onTurnInterrupted('user_interrupt')`
  - idleTimeout → `IdleTimeoutSignal` → `onTurnInterrupted('idle_timeout', ...)`
  - 高优先级 inbox → `PriorityInboxInterrupt` → `onTurnInterrupted('priority_inbox')`
  - `_handleTurnInterrupt` 三分支直测（`runtime.test.ts:1136-1155`）
- **观察 / 装配回填**
  - `getTaskSystem()` / `getAuditWriter()` / `getStatus()` 返回内部引用
  - `setContractNotifyCallback(cb)` delegate 到 `contractManager.setOnNotify`
  - `setParentStreamLog(sink)` delegate 到 `taskSystem.setParentStreamLog`
- **motion identity 配置**（phase266 起：ClawRuntime + motion options）
  - `identityToolFilter` → `toolRegistry.unregister('send')`
  - `systemPromptBuilder = buildMotionSystemPrompt` 注入序（AGENTS → USER → IDENTITY → SOUL → MEMORY → skills → contract → AUTH_POLICY）

### 8.2 §3 事件回链

覆盖档位：`✓` 测试内直接断言 audit type；`△` 行为 callback 断言（`onTurnStart` 等）存在但无 audit type 断言；`✗` 零覆盖。

| # | event type | 回链测试（文件:断言锚） | 覆盖 |
|---|---|---|---|
| 1 | `assemble_failed` | `runtime-initialize-failures.test.ts:104, 135`（`auditSpy.mock.calls.find(c => c[0] === 'assemble_failed')`） | ✓ |
| 2 | `task_system_init_failed` | `runtime.test.ts`（TaskSystem initialize 抛出路径）| ✓ |
| 3 | `task_system_start_dispatch_failed` | `runtime.test.ts`（TaskSystem startDispatch 抛出路径）| ✓ |
| 4 | `session_loaded` | `runtime.test.ts:1395-1420`（`describe('session_loaded audit timing')`）| ✓ |
| 5 | `session_repaired` | `runtime-initialize-failures.test.ts:186`（`auditSpy.mock.calls.find(c => c[0] === 'session_repaired')`） | ✓ |
| 6 | `snapshot_commit_failed` | `runtime.test.ts:1430-1456` + `runtime-initialize-failures.test.ts:145-180` | ✓ |
| 7 | `snapshot_commit_uncategorized` | `runtime.test.ts`（snapshot commit uncategorized 分支）| ✓ |
| 8 | `turn_start` | `runtime.test.ts` 28 处 `onTurnStart` 断言（行为侧覆盖，无 audit 断言）| △ |
| 9 | `turn_end` | `runtime.test.ts` `onTurnEnd` 断言（行为侧）| △ |
| 10 | `turn_interrupted` | `runtime.test.ts:1136-1155` 三分支 `onTurnInterrupted('idle_timeout'/'priority_inbox'/'user_interrupt')` | △ |
| 11 | `turn_error` | `runtime.test.ts` 17 处 `onTurnError` 断言（行为侧）| △ |
| 12 | `llm_call` | 间接：`onProviderInfo` / 17 处 provider 回调断言 | △ |
| 13 | `llm_error` | 间接：`onProviderFailed` 回调断言 | △ |
| 14 | `inbox_meta_failed` | 无测试回链 | ✗ |

6 △ + 1 ✗ 合计 7 条未直接覆盖 audit type 断言 → §7.B `B.p166-6` 登记（本 Step 同 commit 追加）。

### 8.3 回归套件归属

- `tests/core/runtime.test.ts`（1497 行，1 顶层 describe + 多子组）——主回归，覆盖 §2 全部公共方法与中断路径
- `tests/core/runtime-initialize-failures.test.ts`（192 行）——`initialize()` 失败路径专项，包含 `auditSpy` 断言 assemble_failed / session_repaired / snapshot_commit_failed（§2.2 "失败：抛出时 initialized 仍可能为 false" 的反向咬合）
- `tests/core/motion.test.ts`（~259 行）——motion identity 配置覆盖（`buildMotionSystemPrompt` 注入序 + `identityToolFilter` unregister 'send'）；**phase266 重构**：改为 ClawRuntime + motion options 构造（MotionRuntime class 已删除）
- `tests/helpers/runtime-deps.ts`（71 行）——共享测试依赖构造器（3 个测试文件复用，非行为文件）

phase166 §验收 回归：`npx vitest run tests/core/runtime tests/core/motion` 全绿不退化。§8.2 的 △ / ✗ 由下 phase（phase171+）消除，契约诚实反映实然。

---

## 9. 已知问题（2026-04-27 记录）

### 9.1 DispatchTool describing 模式消息结构错误

**问题描述**：
- dispatch describing 模式创建的子代理行为异常
- 子代理可能卡住、误解任务或 max_tokens 截断
- mining 模式正常工作

**根因**：
```typescript
// src/core/runtime/dispatch.ts:198
const lastBlock = lastMsg.content[lastMsg.content.length - 1];
if (lastBlock?.type === 'tool_use' && lastBlock.name === 'dispatch') {
  dispatchToolUseId = lastBlock.id;
}
```
- 只检查 `lastMsg.content` 的最后一个 block
- 如果 assistant 消息包含多个 tool_use blocks（并行调用），dispatch 可能不是最后一个
- `dispatchToolUseId` 为 undefined，无法正确关闭 tool_use
- 导致消息序列违反 Anthropic API 规范（tool_use 后无 tool_result）

**影响**：
- describing 模式：子代理收到非法消息序列，行为不稳定
- mining 模式：不受影响（从空白开始，不传递对话历史）

**验证**：
- mining 模式测试：✅ 正常创建契约并执行
- describing 模式测试：❌ 子代理卡住或超时

**修复建议**：
```typescript
// 应遍历所有 blocks，找到 dispatch tool_use
if (lastMsg?.role === 'assistant' && Array.isArray(lastMsg.content)) {
  for (let i = lastMsg.content.length - 1; i >= 0; i--) {
    const block = lastMsg.content[i];
    if (block?.type === 'tool_use' && block.name === 'dispatch') {
      dispatchToolUseId = block.id;
      break;
    }
  }
}
```

**优先级**：高（影响核心任务派发功能）

### 9.2 模块实现状态（2026-04-27 更新）

| 组件 | 状态 | 代码位置 | 备注 |
|------|------|----------|------|
| ClawRuntime | ✅ 已实现 | `src/core/runtime/runtime.ts` | 919 行，核心逻辑完整 |
| MotionRuntime | ✅ 已重构 | 已删除 class，改为 ClawRuntime + options | phase266 |
| DispatchTool | ⚠️ 有 bug | `src/core/runtime/dispatch.ts` | describing 模式消息结构错误 |
| ContextInjector | ✅ 已实现 | Runtime 内部组件 | system prompt 构建 |
