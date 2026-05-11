# Daemon 接口契约

**应然**（2026-04-26 修订 / 跟 modules.md §26 align）：进程生命周期管理。main 入口、信号处理、按 Assembly 返回的 Instances 触发 shutdown。装配职责已独立为 Assembly，Daemon 不知道被启的模块内部细节，只对 Instances 调反向清理。

**实然**：落地于 `src/daemon/daemon.ts` + `src/daemon/daemon-loop.ts` + `src/daemon-entry.ts` shim。daemon-loop 事件循环 driver 在 Daemon / state 在 Runtime（publisher-subscriber 形态 B，B.p172-1 登记）。§7.A 10/10 全清零（phase191 里程碑）。§7.B 4 条偏差保留。

归属：L6a 进程入口。
- **应然依赖**：Assembly（通过 Instances 接收装配好的模块）；Runtime 公共 API 消费仅 3 方法
- **实然依赖**：Assembly, Runtime, SkillSystem（类型）, ContractSystem（类型）, FileSystem, AuditLog, Stream, FileWatcher, types/config/prompts/utils/共享常量, node 内置

> ~~应然承诺。实然差距见 §7。~~
>
> **方法论定位**：冻结契约登记（phase172 2026-04-21，L6a 进程入口）——按 `feedback_top_module_freeze_window`，顶层模块在下层契约未稳时抢跑建立后"冻结 + 未来稳定化 phase"。本契约只登记现状与偏差清单，**不修代码**；§7.A 列为未来稳定化 phase 的基线 scope。

## 1. 所有权

### 归属层

L6a 进程入口（phase172 L6 首契约，与 Assembly 契约 `l6_assembly.md` 同层异类；落地于 `src/cli/commands/daemon.ts` 296 行 + `src/cli/commands/daemon-loop.ts` 370 行 + `src/daemon-entry.ts` 12 行 shim）。

### 职责（按生命周期三段）

**启动期**：
- lockfile 单实例保护（写 `status/pid`，冲突时由 Assembly 抛 `LockConflictError`）
- 调 `assemble(config)` 取得 `Instances`（含 runtime / auditWriter / streamWriter / snapshot / heartbeat）
- 装后初始化：`daemon_start` audit + snapshot commit（context=daemon-start）
- 装配失败时发 `assemble_failed`（module=runtime / phase=post_assemble_init）后上抛退出

**运行期**：
- 启动事件循环 `startDaemonLoop(options)` 驱动 Runtime：
  - 主路径：`runtime.processBatch(callbacks)` 拉 inbox 驱动 turn
  - 中断：`runtime.abort()` 响应用户信号
  - 重试：`runtime.retryLastTurn(callbacks)` 做 LLM error 指数 backoff
  - 阻塞：`waitForInbox(fs, audit, dir, timeout)` 基于 fs.watch + fallback
- review_request 路径（motion 独有，daemon.ts:118-245）：读 by-contract index → 加载 dispatch-skills → 加载 contract YAML + mining task → 注入 retro prompt → 经 TaskSystem 派发 subagent

**关停期**：
- 安装信号 handler：`SIGTERM` / `SIGINT` → `shutdown(signal)` 闭包
- `shutdown` 调 `disassemble(instances, signal)` 让各模块按拓扑反向清理
- unlink `status/pid`（若 pid 匹配当前进程）
- 发 `daemon_crash` audit（若异常退出）

业务语义清单外即不做。边界参照：模块装配归 Assembly；事件循环内部状态归 Runtime；子代理派发归 TaskSystem；审计落盘归 AuditLog；技能加载归 SkillSystem（review_request 路径 phase177 改调 `createSkillRegistry` 工厂，`B.p169-1` daemon.ts 分项已清零）。

### 资源

**磁盘归属**：
- `status/pid` lockfile（`path.join(dir, 'status', 'pid')`）—— Daemon 独占，启动写 / 关停删；冲突由 Assembly 的 `LockConflictError` 上游感知

**进程句柄**：
- `process.on('SIGTERM' | 'SIGINT')` signal handler（daemon.ts:286-287）
- `process.on('uncaughtException')` + `process.on('unhandledRejection')` **双层兜底**：
  - daemon-entry.ts shim（L1-L8，简单 console.error + exit）
  - daemon.ts 内部（L251 / L255，在 daemonCommand 内后装）
  - 双层现象详见 §7.A7 登记

**无内存状态**：Daemon 本身不持长态；`instances` 是 Assembly 返回的不可变引用，生命周期随进程。

### 业务语义（由本模块主动发起）

- "进程启动"：`daemonCommand(name)`
- "事件循环驱动"：`startDaemonLoop(options)` → Runtime（driver 在 Daemon / state 在 Runtime，`B.p172-1` 登记）
- "inbox 阻塞等待"：`waitForInbox(...)`
- "进程关停"：`shutdown(signal)` 闭包 + `disassemble`
- "review_request 整合"（motion 独有）：加载 contract + dispatch-skills + mining task → 派发 retro subagent

## 2. 接口

### 2.1 启动期 — daemonCommand

```ts
export async function daemonCommand(name: string): Promise<void>;
```

行为承诺：
- 计算 `dir = clawforumDir / name` 并确保 `status/` 子目录存在
- 写 pid 到 `status/pid`（冲突由 Assembly 的 `LockConflictError` 上抛）
- 调 `await assemble({ name, dir, ... })` 得 `Instances`
- 装后初始化：`daemon_start` audit + 起始 snapshot commit
- 启动 `startDaemonLoop({ runtime, ... })`（motion 额外传 `onInboxMessages`）
- 注册 `SIGTERM` / `SIGINT` / `uncaughtException` / `unhandledRejection` handler（§7.A7 登记双层）
- 返回后进程驻留直至 `shutdown`

消费方：`src/daemon-entry.ts` **独一处**（进程 main）。

### 2.2 运行期 — startDaemonLoop + DaemonLoopOptions

```ts
export function startDaemonLoop(options: DaemonLoopOptions): {
  promise: Promise<void>;
  stop: () => void;
};
```

**DaemonLoopOptions 4 组结构**（phase185 由 11 平铺拆分）：

```ts
export interface DaemonInboxConfig {
  pendingDir: string;
  fallbackTimeoutMs?: number;
}

export interface DaemonMotionExtensions {
  heartbeat?: Heartbeat;
  onInboxMessages?: (messages: InboxMessage[]) => Promise<void>;
}

export interface DaemonLoopOptions {
  // 核心驱动（5 必填平铺）
  runtime: ClawRuntime;
  agentDir: string;
  clawId: string;
  label: string;
  audit: Audit;

  // inbox 配置（必填子组）
  inbox: DaemonInboxConfig;

  // motion 扩展（可选子组；claw 整体省略）
  motion?: DaemonMotionExtensions;

  // 流式 / 回调（2 可选平铺）
  streamWriter?: StreamWriter;
  onBatchComplete?: () => Promise<void>;
}
```

**顶层字段表**（9 visible，子对象算 1）：

| # | 字段 | 类型 | 必填 | 组 | 用途 |
|---|---|---|---|---|---|
| 1 | `runtime` | `ClawRuntime` | 是 | 核心驱动 | 事件循环驱动对象 |
| 2 | `agentDir` | `string` | 是 | 核心驱动 | agent root 目录 |
| 3 | `clawId` | `string` | 是 | 核心驱动 | agent id（kebab-case） |
| 4 | `label` | `string` | 是 | 核心驱动 | log 前缀 |
| 5 | `audit` | `Audit` | 是 | 核心驱动 | audit sink（createWatcher 用） |
| 6 | `inbox` | `DaemonInboxConfig` | 是 | inbox 配置 | `{ pendingDir; fallbackTimeoutMs? }` |
| 7 | `motion` | `DaemonMotionExtensions` | 否 | motion 扩展 | `{ heartbeat?; onInboxMessages? }`；claw 整体省略 |
| 8 | `streamWriter` | `StreamWriter` | 否 | 流式/回调 | 流式事件写入 |
| 9 | `onBatchComplete` | `() => Promise<void>` | 否 | 流式/回调 | 链式响应完成回调 |

**字段分组合规** —— phase185 清零 §7.A5（11 平铺 > 8 阈值 → 9 顶层 + 2 子组，M#8 耦合界面最小合规）。publisher-subscriber 形态保留为 B 类偏差（§7.B.p172-2）。

### 2.3 运行期 — waitForInbox

```ts
export function waitForInbox(
  fs: FileSystem,
  audit: Audit,
  inboxPendingDir: string,
  timeoutMs: number,
): Promise<void>;
```

行为承诺：
- 通过 `createWatcher` 监听 `inboxPendingDir` 任何新文件
- 新文件到达或 `timeoutMs` 到期任一触发 resolve
- **永不 reject**（`ensureDirSync` 失败也 resolve）
- `settled` 状态机确保重复触发只 resolve 一次

### 2.4 runtime 公共 API 消费面（耦合窄化）

daemon-loop 对 Runtime **仅调用 3 个公共方法**（M#8 耦合界面最小证据）：

```ts
runtime.processBatch(callbacks);   // 主循环 + 链式响应
runtime.retryLastTurn(callbacks);  // LLM error 指数 backoff 重试
runtime.abort();                   // 用户中断信号响应
```

Runtime 其他公共方法（`getTaskSystem` / `getAuditWriter` / `chat` / `initialize` / `stop` / `setContractNotifyCallback` / `setParentStreamLog` 等）由 Assembly 调，**不经 Daemon 路径**。

**耦合面维度不对称**：options 11 字段（driver 入参，环境注入一次）vs runtime 3 API（循环调用，核心 coupling）—— 维度不同非对称非对齐问题。

### ~~2.5 review_request 特殊路径（motion 独有）~~（**phase188 B-3 清理删除，归属迁移链路 4/4 完成**）

> **phase188 注记**：本章节原 daemon.ts L139-256 review_request 分发逻辑 118 行已删除；归属迁移链路 4/4 完成（phase174 应然 / phase175 实装 / phase184 切换 / phase188 清理）。实然入口归 `ContractManager.handleReviewRequest`（`l4_contract_system.md §2.b.1`）；daemon.ts L115-138 顶层 4 字段构造 + L130-138 onInboxMessages 转调 3 行为完整接触面（零 review_request 业务代码）。历史代码见 git history / phase184 切换 commit `25f9707` / phase188 清理 commit `db42781`。

## 3. 审计事件清单

### 3.1 daemon.ts 自产事件（2 个新 type）

| event type | 位置 | 语境 | 载荷 |
|---|---|---|---|
| `daemon_start` | daemon.ts:101 | 启动期 prompt hash 记录 | `sha256:<hash>` |
| `daemon_crash` | daemon.ts:248 | 异常退出前 | `err=<message>` |

### 3.2 daemon.ts 复用事件（3 个 type，载荷特化）

| event type | 位置 | 归属契约 | 特化字段 |
|---|---|---|---|
| `assemble_failed` | daemon.ts:75 | Assembly 契约 `l6_assembly.md` §3 | `module=runtime` / `phase=post_assemble_init` |
| `assemble_failed` | daemon.ts:59-61（phase189 新增）| Assembly 契约 + Daemon pre-assemble | `module=lockfile` / `phase=preconstruct` —— LockConflictError 分支 |
| `assemble_failed` | daemon.ts:63-64（phase189 新增）| Assembly 契约 + Daemon pre-assemble | `module=pre_assemble` / `phase=preconstruct` —— 其他 assemble 失败 |
| `snapshot_commit_uncategorized` | daemon.ts:106 | Runtime 契约 `l5_runtime.md` §3 | `context=daemon-start` |
| `snapshot_commit_failed` | daemon.ts:110 | Runtime 契约 `l5_runtime.md` §3 | `context=daemon-start` |

### 3.3 daemon-loop.ts 自产事件（phase173 落地 5 类）

phase173 集成 5 类 audit 事件（8 触发点），覆盖 daemon-loop 运行期的循环节奏 + 服务降级决策。与 Runtime 14 个 event type 零重复（`daemon_loop_*` 前缀专属）。

#### 3.3.1 `daemon_loop_iteration`

- **触发时机**：`processBatch` 调用返回后（chain 完成或 empty 决定 wait 之前）
- **前置条件**：本轮非 `llmRetryPending` 路径（retry 路径见 §3.3.3）
- **后置状态**：
  - 若 `injected > 0` 链式响应全部完成，进入 reset state + `onBatchComplete` 回调
  - 若 `injected === 0` 进入 `waitForInbox`
- **载荷**：
  - `type=chain`：chain reaction 完成 → `injected=<N>` / `chain_total=<M>`（M = 首次 injected + 每轮 chain 累计）
  - `type=wait`：empty → `injected=0`
- **与 Runtime 差异**：Runtime `turn_start` / `turn_end` 是 turn 粒度；本事件是 **batch 粒度**（Daemon-loop 独有的"循环迭代节奏"维度）

#### 3.3.2 `daemon_loop_interrupt`

- **触发时机**：catch 块识别三种 signal 之一后，`setTimeout` 之前
- **前置条件**：`processBatch` / `retryLastTurn` 抛 `IdleTimeoutSignal` / `UserInterrupt` / `PriorityInboxInterrupt`
- **后置状态**：
  - idle/user → `setTimeout(INTERRUPT_RECOVERY_DELAY_MS=1000)` 后进入下一轮
  - priority → 直接下一轮（无 delay）
- **载荷**：`cause=idle_timeout|user_interrupt|priority_inbox` / `recovery_delay_ms=1000|0`
- **与 Runtime 差异**：Runtime `turn_interrupted\tcause=X` 是"signal 传递"（由 processBatch / retryLastTurn via callbacks 触发）；本事件是 **daemon-loop 的反应决策**（含 recovery_delay）；两事件在审计链连续出现互补

#### 3.3.3 `daemon_loop_llm_retry`

- **触发时机**：catch 块识别可重试 LLM error（`llmRetryCount < LLM_MAX_RETRIES`）；在 `llmRetryCount++` 之后 / `console.warn` 之前
- **前置条件**：`err instanceof Error && LLM_ERROR_PATTERN.test(err.message) && llmRetryCount < LLM_MAX_RETRIES`
- **后置状态**：
  - `llmRetryCount++`（audit 中 attempt = 递增后值，与 console.warn `(X/N)` 同口径）
  - `setTimeout(llmRetryDelayMs)` 等待
  - `llmRetryDelayMs = Math.min(*2, LLM_RETRY_MAX_DELAY_MS=300000)` 指数退避
  - `llmRetryPending = true`（下轮 while 将调 `retryLastTurn`）
  - `saveLlmRetryState` 持久化到 `status/llm-retry-state.json`（跨进程恢复）
- **载荷**：`attempt=<N>` / `max=<M>` / `delay_ms=<D>`（本次 delay，非下次 update 后）/ `err=<msg>`
- **与 Runtime 差异**：Runtime `llm_error\tmodel=X\terr=Y\tms=Z` 是"provider 调用失败"；本事件是 **daemon-loop 退避决策**（含 attempt / delay）

#### 3.3.4 `daemon_loop_fatal`

- **触发时机**：catch 块 fatal 分支（非 signal / 非 retryable LLM error）；在 state reset 之后 / `console.error` 之前
- **前置条件**：`err` 非三种 signal + 非可重试 LLM（`llmRetryCount >= LLM_MAX_RETRIES` 或非 LLM pattern）
- **后置状态**：
  - `llmRetryCount = 0` / `llmRetryDelayMs = LLM_RETRY_INITIAL_DELAY_MS` / `saveLlmRetryState`
  - `waitForInbox` 降级等待（循环不终止但进入 degraded）
- **载荷**：`reason=max_retries_exhausted|non_llm_error` / `err=<msg>`
- **与 Runtime 差异**：Runtime 不发；daemon-loop 独有"循环降级"事件

#### 3.3.5 `daemon_loop_interrupt_poller_disabled`

- **触发时机**：interrupt poller 连续 20 次错误触发 circuit breaker 停用时；`clearInterval` 之前
- **前置条件**：`interruptErrCount >= 20`（200ms × 20 次累计非 ENOENT 错误）
- **后置状态**：`clearInterval(interruptPoller)` + `interruptPoller = null`；interrupt 文件不再被消费（**一次性状态迁移**：active → disabled）
- **载荷**：`err_count=<N>` / `last_err=<msg>`（记录触发停用的最后一次错误，非累计 20 次摘要）
- **与 Runtime 差异**：Runtime 不发；daemon-loop 独有
- **注意**：停用后用户 Ctrl-C 等 interrupt 信号失效；本事件提供观察点，未来可基于此事件做 re-enable / 告警

#### 3.3.6 保留 console 清单（phase173 + phase189 + phase191 决策）

部分 console 保留不升 audit（审计层由 §3.3 5 事件 + §3.2 启动失败 3 事件承载，console 保留运维可见性；§7.A2 16 → 0 消化轨迹见该节）：

| 位置 | 级别 | 决策 | 理由 | phase |
|---|---|---|---|---|
| `daemon-loop.ts:278` | warn | 保留 | interrupt poll transient error（每 5 次一报，throttled 低价值） | 173 |
| `daemon-loop.ts:281` | error | 双写（+ §3.3.5 audit） | poller 停用运维可见 + 审计 | 173 |
| `daemon-loop.ts:347` | warn | 双写（+ §3.3.3 audit） | LLM retry 运维可见 + 审计 | 173 |
| `daemon-loop.ts:358` | error | 双写（+ §3.3.4 audit） | fatal 运维可见 + 审计 | 173 |
| `daemon-loop.ts:360` | error | 保留 | max retries exhausted 独立日志行增强运维清晰性；审计由 §3.3.4 `reason=max_retries_exhausted` 覆盖 | 173 |
| `daemon.ts:62` | error | 双写（+ §3.2 `assemble_failed module=lockfile`） | LockConflictError 运维可见 + 审计 | 189 |
| `daemon.ts:66` | error | 双写（+ §3.2 `assemble_failed module=pre_assemble`） | assemble 失败运维可见 + 审计 | 189 |
| `daemon.ts:79` | error | 双写（+ §3.2 `assemble_failed module=runtime`） | runtime init 失败运维可见 + 审计 | 189 |
| `daemon.ts:94` | warn | 保留 | heartbeat 清理 best-effort（启动期非关键；non-ENOENT 才报，低频） | 191 |
| `daemon.ts:185` | warn | 保留 | pid 清理 best-effort（shutdown 期；failure 后 `process.exit(0)` 继续；下次启动 ProcessManager 重写） | 191 |
| `daemon.ts:193` | log | 保留 | `${label} Started` 人眼运维 checkpoint；审计语义由 §3.2 `daemon_start sha256:...` 承载（L106） | 191 |

### 3.4 review_request 路径自产事件

**当前：无**（phase188 B-3 清理后 daemon.ts 零 review_request 业务代码；原 130 行 console.warn 随代码删除；§7.A4c 已清零）。

**细化期应新增**（预估）：
- `review_request_received`（消息到达 + contractId）
- `review_request_skipped`（by-contract 索引异常三种：非 JSON / 格式错 / targetClaw 非法）
- `review_request_dispatched`（subagent 派发成功 + taskId）
- `review_request_failed`（dispatch 失败 / cleanup 失败）

### 3.5 daemon-entry.ts + daemon.ts 双层 handler 事件（phase189 清零）

**phase189 清零路径**（2026-04-21 合入 `af6f03a`）：保留双层 handler + audit 双发（phase172 §7.A7 方向 B）。

**双层职能**：
- `daemon-entry.ts` shim handler（极早期 import 阶段兜底）
- `daemon.ts` 内部 `writeCrash` handler（运行期兜底）

**事件清单**：

| event type | 位置 | 触发阶段 | 载荷 |
|---|---|---|---|
| `daemon_uncaught_exception` | `daemon-entry.ts` shim | 极早期（daemon.ts 未入）| `err=<err.message>\n<err.stack>` |
| `daemon_unhandled_rejection` | `daemon-entry.ts` shim | 极早期 | `err=<reason 字符串化>` |
| `daemon_crash` | `daemon.ts:248` 内部 handler | 运行期（daemon.ts 已启动）| `err=<message>` |

**语义区分**：shim 新 type 明确区分 "极早期 import 崩溃" vs "运行期崩溃"；审计 TSV 可见"何时何处崩"完整信息。

**shim 三层兜底**（phase189 新模板）：
1. `shimAudit` 构造失败（NodeFileSystem / createSystemAudit 抛） → 回退 null + handler 内 `?.` 防御
2. `shimAudit.write` 调用抛 → handler try/catch 静默
3. 全部失败 → fallback console.error + process.exit(1)，保 exit 语义不变

---

## 4. 上游依赖

### 4.1 L1 — FileSystem

- `import { NodeFileSystem } from '../../foundation/fs/node-fs.js'`（daemon.ts:15 / daemon-loop.ts:8）
- `import type { FileSystem } from '../../foundation/fs/types.js'`（daemon-loop.ts:9）

调用面：`NodeFileSystem` 构造（motion fs）+ `fs.ensureDirSync` + `fs.exists` 等通用 IO。

### 4.2 L2 — AuditLog / Stream / FileWatcher

- `import { AuditWriter } from '../../foundation/audit/writer.js'`（daemon.ts:16；运行时实例由 Assembly 经 `Instances.auditWriter` 提供，daemon.ts 仅用类型）
- `import type { StreamWriter, StreamLog } from '../../foundation/stream/index.js'`（daemon-loop.ts:12）
- `import { createWatcher } from '../../foundation/file-watcher/index.js'`（daemon-loop.ts:13；`waitForInbox` 用）
- `import type { Watcher } from '../../foundation/file-watcher/types.js'`（daemon-loop.ts:14）
- `import type { Audit } from '../../foundation/audit/index.js'`（daemon-loop.ts:15）

### 4.3 L5 — Runtime（类型 + 公共 API）

- `import type { ClawRuntime, StreamCallbacks } from '../../core/runtime.js'`（daemon-loop.ts:10）

调用面（§2.4 已列）：`runtime.processBatch / retryLastTurn / abort` 共 3 方法；`StreamCallbacks` 协议由 Runtime 定义（phase166 `l5_runtime.md` §2.1），Daemon 消费（publisher-subscriber 形态 B）。

### 4.4 L5 — SkillSystem（仅 review_request 临时实例）

- `import { SkillRegistry } from '../../core/skill/registry.js'`（daemon.ts:17）

调用面：**仅** daemon.ts:179 `createSkillRegistry(motionFs, 'clawspace/dispatch-skills')` 一处（phase177 改调工厂），§2.5 review_request 路径；phase169 `l2_skill_system.md` `B.p169-1` daemon.ts 分项已清零（契约 phase180 rename）。

### 4.5 L5 — ContractSystem（仅 review_request）

- `import { ContractManager } from '../../core/contract/manager.js'`（daemon.ts:18）

调用面：daemon.ts:171 附近加载 contract YAML；临时消费不持久化实例。

### 4.6 L6c — Assembly（核心上游）

- `import { assemble, disassemble, LockConflictError } from '../../assembly/index.js'`（daemon.ts:24）
- `import type { Instances } from '../../assembly/index.js'`（daemon.ts:25）

调用面：
- `assemble(config): Promise<Instances>` — 启动期唯一装配入口
- `disassemble(instances, signal): Promise<void>` — 关停期清理
- `LockConflictError` — 锁冲突上游协议（Assembly 抛，Daemon 感知）
- `Instances` 结构 — 含 `runtime / auditWriter / streamWriter / snapshot / heartbeat`（Daemon 按字段解构使用，§5.2 登记耦合）

### 4.7 跨模块协议（types 共享）

- `import type { InboxMessage } from '../../types/contract.js'`（daemon.ts:13 / daemon-loop.ts:11）
- `import type { Message } from '../../types/message.js'`（daemon.ts:21）
- `import { IdleTimeoutSignal, PriorityInboxInterrupt, UserInterrupt } from '../../types/signals.js'`（daemon-loop.ts:30）

### 4.8 工具与辅助

按功能分组：

- **prompts 构造**：`import { buildRetroPrompt } from '../../prompts/index.js'`（daemon.ts:22；review_request 路径构造 retro prompt）
- **subagent 派发**：`import { writePendingSubagentTaskFile } from '../../core/tools/builtins/_pending-task-writer.js'`（daemon.ts:20；review_request 派发 subagent）
- **CLI 基础**：`import { CliError } from '../errors.js'`（daemon.ts:23）
- **CLI config**：`import { loadGlobalConfig, loadClawConfig, getClawDir, getMotionDir } from '../config.js'`（daemon.ts:12）
- **inbox 通知**：`import { notifyInbox } from '../../utils/notify.js'`（daemon-loop.ts:29；投递时通知 watcher）
- **字符串 util**：`import { oneLine } from '../../types/utils.js'`（daemon-loop.ts:16；phase203 搬迁）
- **motion-only 心跳**：`import type { Heartbeat } from '../../core/heartbeat.js'`（daemon-loop.ts:18）

### 4.9 共享常量

- `import { DEFAULT_MAX_STEPS, DEFAULT_MAX_CONCURRENT_TASKS, DEFAULT_LLM_IDLE_TIMEOUT_MS } from '../../constants.js'`（daemon.ts:19）
- `import { LLM_MAX_RETRIES } from '../../constants.js'`（daemon-loop.ts:25）

### 4.10 node 内置

- `import * as path from 'path'` / `import * as fsNative from 'fs'` / `import * as fsAsync from 'fs/promises'` / `import { createHash } from 'node:crypto'`

### 4.11 依赖层级合规

| 本模块层 | 依赖 | 被依赖层 | 合规 |
|---|---|---|---|
| L6a Daemon | Assembly | L6c | ✓ 横向（同 L6 不同类）|
| L6a Daemon | Runtime / SkillSystem / ContractSystem（类型 + 单入口消费）| L5 | ✓ 下行 |
| L6a Daemon | FileSystem / AuditLog / Stream / FileWatcher | L1-L2 | ✓ 下行 |
| L6a Daemon | types / config / prompts / utils / 共享常量 | 共享 | ✓ 横向 |

**无上行依赖，无循环**，符合 M#5 依赖单向。

## 5. 不可消除耦合

**消除路径首选 port pattern**（feedback_module_contract_structure r40.2）：消费方 own port + 默认实现 + assembly 注入 / phase337+335+340 三 phase 实证。Daemon 当前耦合（driver/state 分离 / Assembly 装配根 / Runtime callbacks 反向触发）评估时优先考虑 port 抽象。

### 5.1 driver / state 分离（daemon-loop 驱动 / Runtime 持态）

daemon-loop.ts 调 `runtime.processBatch(callbacks)` 驱动事件循环；循环内部状态（turn 计数 / inbox 状态 / abort controller）由 Runtime 持有。

**形态**：driver 在 Daemon，state 在 Runtime；分离是 phase155D 抢跑遗留。

**为什么不可消除**（冻结期判定）：
- Daemon 需要控制"进程级生命周期事件" × "循环迭代节奏"两维，合并进 Runtime 会让 Runtime 背上进程入口职责
- Runtime 需要隔离于进程机制（为未来 CLI / chat 等非 daemon 入口复用）

**偏差登记**：`B.p172-1` —— driver / state 分离合规但需显式承认边界模糊；未来稳定化 phase 可讨论合并或清晰化边界。

### 5.2 Instances 结构依赖（Assembly 返回不可变引用）

daemon.ts:67 `const { runtime, streamWriter, snapshot, auditWriter, heartbeat } = instances;` 解构使用。

**耦合面**：`Instances` 字段集合（由 Assembly 定义在 `assembly/index.ts`），Daemon 按字段解构；新增 Assembly 模块会扩 `Instances` 字段，Daemon 视需求按名解构。

**为什么不可消除**：Daemon 是 `Instances` 的主消费方（除 Assembly 自身），字段耦合是装配模式的必然。

### 5.3 signal handler 全局进程级

`process.on('SIGTERM' | 'SIGINT' | 'uncaughtException' | 'unhandledRejection')` 4 个 handler 安装在进程全局。

**耦合面**：进程级全局副作用；安装后不可卸载（测试必须 mock `process` 或隔离在 child process）。

**为什么不可消除**：L6a 进程入口的本质 —— Daemon 存在的理由就是管理进程生命周期，signal handler 是履职手段。

**双层现象**：daemon-entry.ts shim 装 2 个（uncaughtException / unhandledRejection）+ daemon.ts 内装 2 个同名 handler —— §7.A7 登记是否冗余。

### 5.4 DaemonLoopOptions publisher-subscriber 形态 B

`DaemonLoopOptions` 顶层 9 字段 + 2 子组（phase185 由 11 平铺重构）由 Daemon 注入 daemon-loop；daemon-loop 通过 callbacks（`onBatchComplete` / `motion?.onInboxMessages`）反向触发 Daemon 侧逻辑。

**形态**：Daemon 定义注入协议（`DaemonLoopOptions`）+ daemon-loop 消费；daemon-loop 通过 callback 回传事件 —— 符合 publisher-subscriber 形态 B（`feedback_cycle_vs_reverse_dependency`）。

**为什么不可消除**：driver / state 分离（§5.1）的必然副作用 —— driver 需向 state 传运行环境（runtime handle + 配置 + audit sink），state 需向 driver 通告事件（`onBatchComplete` 等）。

**偏差登记**：`B.p172-2` —— 11 字段超 §7.A5 阈值但形态合规；未来稳定化 phase 收敛字段职责（拆 runtime handle / inbox config / motion-only 三组）。

### ~~5.5 review_request 跨模块编排（motion 独有）~~（**phase188 B-3 清理删除，归属归 ContractSystem**）

> **phase188 注记**：本章节原"Daemon 承担跨 5 模块编排"的登记已随 phase188 清理失效。review_request 5 跨模块动作现统归 `ContractManager.handleReviewRequest`（`l4_contract_system.md §2.b.1`）。Daemon 侧零 review_request 业务代码；仅保留 L115-138 顶层 4 字段构造 + onInboxMessages 转调。

**偏差登记**：`B.p172-3`（**phase188 4/4 完成，全链路闭合**）—— 归属链路从登记 → 升档 → 切换 → 清理四段完成；详见 §7.B `B.p172-3` 终态登记。

## 6. 配置常量归属

### 6.1 Daemon 独占常量

| 常量 | 位置 | 值 / 默认 | 归属 |
|---|---|---|---|
| `statusDir` | daemon.ts:40 | `path.join(dir, 'status')` | Daemon 独占（局部变量） |
| `pidFile` | daemon.ts:41 | `path.join(statusDir, 'pid')` | Daemon 独占（局部变量） |
| `fallbackTimeoutMs` 默认 | `DaemonLoopOptions` 字段默认（见 §2.2）| `30000` ms | Daemon 独占 |
| 信号清单 | daemon.ts:286-287 | `SIGTERM` / `SIGINT` | Daemon 独占 |
| process 级 handler 集 | daemon.ts:251 / 255 / 286 / 287 | 4 handler | Daemon 独占 |

### 6.2 消费常量（来自 `src/constants.ts` 共享）

| 常量 | 定义位置 | 用途 |
|---|---|---|
| `DEFAULT_MAX_STEPS` | `constants.ts`（phase166 `l5_runtime.md` §6 已登）| 装配 Runtime 时透传 |
| `DEFAULT_MAX_CONCURRENT_TASKS` | `constants.ts` | 装配 Runtime 时透传 |
| `DEFAULT_LLM_IDLE_TIMEOUT_MS` | `constants.ts` | 装配 Runtime 时透传 |
| `LLM_MAX_RETRIES` | `constants.ts:180`（= 3）| daemon-loop.ts:342 LLM error retry 阈值 |

### 6.3 未抽常量登记（§7.B 候选）

- `'clawspace/dispatch-skills'` 字面量（daemon.ts:179）—— 与 phase169 `B.p169-2` 同根；本 phase 不重复登记，指向 SkillSystem 契约
- `'by-contract'` 目录名（review_request 路径）—— 字面量散在 daemon.ts 内部；未抽常量；§7.B 候选但非强制
- LLM backoff 指数 base / 延迟公式（daemon-loop.ts 内部）—— 硬编码未抽，细化期抽

## 7. 实然差距

### 7.A 必修违规（未来稳定化 phase 的基线 scope）

本契约 §7.A 是 Daemon **冻结期偏差清单**（非粗糙期"待细化期清零"）：
- 每条列 位置 / 违反 / 修正方向（不含具体修复方案）
- 未来稳定化 phase 启动时以此清单为 scope 基线
- 粗糙重构期原则"不碰模块内部"在冻结期等价为"登记即止"

违反条款集中在 Design #1d（事后可审计）/ Design #2（信息不得丢弃/静默）/ M#8（耦合界面最小）/ 测试验证行为契约。

#### ~~A1~~ — daemon-loop.ts 370 行运行时零 audit（**phase173 清零**）

phase173 Step 2-5 集成 5 类 audit（iteration / interrupt / llm_retry / fatal / interrupt_poller_disabled），详见 §3.3。daemon-loop 运行期零 audit 状态已实然消化，条目**删除**（契约 §7.A 只登记待修条目；清零动作登记在 §7.Phase 纪律.4）。

#### ~~A2~~ — console 16 处无 audit 跟进（**phase191 已清零（16 → 0 闭环）**）

**消化轨迹** 16 → 0（分 4 phase 消化）：
- phase173 ✓ daemon-loop 5 处 → 5 audit（§3.3）+ §3.3.6 保留 console 清单
- phase188 ✓ review_request 10 处 → B-3 链路清理随代码删（`l4_contract_system.md §2.b.1`）
- phase189 ✓ 启动失败 3 处 → audit + console 双写（L60 `module=lockfile` / L65 `module=pre_assemble` / L77 `module=runtime`；§3.2 module/phase 双字段）
- **phase191 ✓ 残余 3 处** → 全登记"保留 console 清单 best-effort 运维可见"（§3.3.6 扩；β/β/γ 决策）：
  - `daemon.ts:94` heartbeat 清理失败（启动期 best-effort；non-ENOENT 才报）
  - `daemon.ts:185` pid 清理失败（shutdown 期 best-effort；failure 后 `process.exit(0)`）
  - `daemon.ts:193` `${label} Started`（L106 `daemon_start` audit 已承载审计语义；console.log 是人眼 checkpoint）

**Design #2 对照**：3 处保留 console 属"运维可见保留"而非"信息丢弃"—— 有人眼可见通道 + best-effort 语义非审计必要（与 §3.3.6 daemon-loop `daemon-loop.ts:278/360` 纯保留先例同型）。

#### ~~A3~~ — assemble 失败路径的 audit 覆盖不全（**phase189 已清零**）

**phase189 清零**（2026-04-21 合入 `af6f03a`）：

- **清零路径**：
  - daemon.ts L37 后引入 `preAssembleAudit = createSystemAudit(new NodeFileSystem({baseDir: dir}), dir)` 预构造 pre-assemble audit sink
  - L59-61 `LockConflictError` 分支 → `preAssembleAudit.write('assemble_failed', 'module=lockfile', 'phase=preconstruct', reason=...)`
  - L63-64 其他 assemble 失败 → `preAssembleAudit.write('assemble_failed', 'module=pre_assemble', 'phase=preconstruct', reason=...)`
  - 与 L75 `module=runtime phase=post_assemble_init` 并列；module / phase 双字段承载 pre/post-assemble 二维状态（§3.2 已登记）
- **测试**：`daemon-command.test.ts` it #3（LockConflictError）/ it #4（其他 assemble 失败）断言翻转 —— 原 `not.toHaveBeenCalled` → 断 audit 调用 payload
- **方法论贡献**：与 §7.A7 同根（pre-assemble 阶段 auditWriter 未构造）同治（createSystemAudit 预构造），**合并 phase189 单 commit 清零**（同根同治合并 phase 首次实践）

**历史登记原状**（phase173 事实纠正）：
- phase172 §7.A3 原描述"双路径"（console + audit 重复处理同事件）为误判
- phase173 纠正为"缺 audit 分支"（LockConflictError L60 直接 exit 跳过 L75 audit）
- 根因：`auditWriter` 从 `instances` 解构（L67），pre-assemble 阶段未就位；直接 `auditWriter.write` 不可行（句柄不存在）
- 修正方向登记：引入 `createSystemAudit(fs, baseDir)` helper（phase148 已有）+ daemon.ts 启动流程早期预构造 audit sink

#### A4 — 测试覆盖缺口（拆 4 子条）

##### ~~A4a~~ — daemonCommand 入口全路径单测（**phase174 已清零**）

**phase172/173 事实漏登核正**：原方向"新建 `tests/cli/daemon.test.ts`"**文件名误登** —— 实测 `tests/cli/daemon.test.ts` 已被 **ProcessManager.acquireLock** 测试占用（phase133/152 历史，10 it）。

phase174 新建 `tests/cli/daemon-command.test.ts`（378 行 / 4 describe / 11 it）覆盖：
- 启动期 7 it：assemble 成功（claw + motion）/ LockConflictError / 其他失败 / runtime.initialize 失败 / snapshot uncategorized / snapshot rejection
- 关停期 4 it：SIGTERM / SIGINT / uncaughtException / unhandledRejection（合 A4d）

daemon.ts 5 audit 事件回链全 ✓（详见 §8.2）。phase172/173 事实漏登作为 phase169 C1 形态变种第 2 次登记在 §7.Phase 纪律.7。

##### ~~A4b~~ — waitForInbox 无直接单测（**phase183 已清零**）

phase183 在 `tests/cli/daemon-loop.test.ts` 新增 `describe('waitForInbox')` 共 4 it 覆盖三路径 + settled guard：
- 新文件到达：mock `createWatcher` 捕获 callback 手动触发 → `done()` → resolve + `watcher.close()` 调用
- 超时：`vi.advanceTimersByTime(timeoutMs+1)` → `done()` → resolve
- `ensureDirSync` 抛错：catch → `void done()` → 立即 resolve（无需 advance timer）
- settled guard：callback + timeout 并发触发，`close()` 只调一次（fix 7 验证）

合入 main `37e8bcc`。零产品代码改动。

##### ~~A4c~~ — review_request 130 行路径零测试（**phase188 已清零（代码已迁 ContractManager）**）

phase188 B-3 清理删除 daemon.ts L139-256 旧 118 行实现；review_request 归 `ContractManager.handleReviewRequest`（`l4_contract_system.md §2.b.1`）。测试覆盖由下游模块承担：
- `tests/core/contract-review-request.test.ts` 8 it（phase175 实装）覆盖 handleReviewRequest 全路径（1 happy + 7 best-effort）
- `tests/cli/daemon-command.test.ts` +4 it（phase184）覆盖 onInboxMessages → handleReviewRequest 集成（happy / 非 review_request / 多条 / ctx 字段断言）

daemon.ts 自身零 review_request 业务代码需直测；§8.3 测试缺口同步清零。

##### ~~A4d~~ — shutdown 信号处理单测（**phase174 已清零**）

phase174 在 `tests/cli/daemon-command.test.ts` `A4d shutdown signal` + `A4d crash handler` 两 describe 合 4 it 覆盖：
- SIGTERM / SIGINT → `shutdown` 闭包 → `disassemble` → pid unlink → `process.exit(0)`
- uncaughtException / unhandledRejection → `writeCrash` → `daemon_crash` audit → `process.exit(1)`

process mock 策略：`vi.spyOn(process, 'on')` 捕获 handler + `vi.spyOn(process, 'exit')` throw ProcessExitError（详见 phase174 Step 1 D4）。

#### ~~A5~~ — DaemonLoopOptions 11 字段超阈值（**phase185 已清零**）

phase185 `daemon-loop.ts` `DaemonLoopOptions` 11 平铺 → 4 组结构（详 §2.2 字段表）：
- **核心驱动**（5 平铺）：`runtime` / `agentDir` / `clawId` / `label` / `audit`
- **inbox 配置**（必填子对象 `DaemonInboxConfig`）：`pendingDir` / `fallbackTimeoutMs?`
- **motion 扩展**（可选子对象 `DaemonMotionExtensions`）：`heartbeat?` / `onInboxMessages?` —— claw 整体省略
- **流式/回调**（2 平铺可选）：`streamWriter?` / `onBatchComplete?`

顶层 visible 9（子对象算 1）；M#8 耦合界面最小合规。call-site 同步：`daemon.ts` 1 处 + `tests/cli/daemon-loop.test.ts` × 8 处 + `tests/cli/daemon-command.test.ts` 1 处断言（4 文件 / -42 +55 / 单 commit）。合入 main `79c2a9c`。

#### ~~A6~~ — review_request `new SkillRegistry` 临时实例化（**phase177 已清零**）

phase177 daemon.ts:179 `new SkillRegistry(...)` → `createSkillRegistry(...)` 工厂调用；import 改走 `src/core/skill/index.js`。SkillSystem `B.p169-1` 从 4 处消化为剩余 3 处（dispatch.ts / skill.ts / tests/helpers/runtime-deps.ts）。合入 main `91e8f64`。

#### ~~A7~~ — daemon-entry shim 双层 handler 的 audit 缺口（**phase189 已清零**）

**phase189 清零**（2026-04-21 合入 `af6f03a`）：

- **决策**：保留双层 handler + audit 双发（phase172 §7.A7 方向 B） —— 不删 shim，shim 与 daemon.ts 内部 handler 并存各自发 audit
- **清零路径**：
  - `src/daemon-entry.ts` top-level import `NodeFileSystem` + `createSystemAudit` + `getClawDir/getMotionDir`
  - 构造 `shimAudit` sink（try/catch 兜底 null）
  - handler 双写（audit 先 / console 保留 phase173 模式）：
    - `unhandledRejection` → `shimAudit?.write('daemon_unhandled_rejection', err=...)`
    - `uncaughtException` → `shimAudit?.write('daemon_uncaught_exception', err=...)`
  - audit 写入抛 try/catch 静默（shim 最外层兜底不可再抛）
- **新 audit type**（§3.5 已登记）：
  - `daemon_uncaught_exception`（shim 层，独立于 daemon.ts `daemon_crash`）
  - `daemon_unhandled_rejection`（shim 层）
- **双层语义区分**：shim handler 极早期（daemon.ts 未入）/ daemon.ts 内部 handler 运行期；同事件 Node.js 全部触发，审计 TSV 可见"极早期 vs 运行期"崩溃完整信息
- **shim 三层兜底模板**（phase189 新）：构造失败 null / write 抛 try/catch / 全 fallback console+exit
- **测试**：`tests/cli/daemon-entry.test.ts` 新建覆盖 shim audit + 构造失败 fallback + write 抛静默
- **方法论贡献**：与 §7.A3 同根（pre-assemble 阶段 auditWriter 未构造）同治（createSystemAudit 预构造），**合并 phase189 单 commit 清零**

**历史登记原状**（phase173 事实纠正）：
- phase172 §7.A7 原描述"行为待核 — 可能发 `daemon_crash`"模糊
- phase173 实测：daemon.ts 内部 `writeCrash` 已发 `daemon_crash` audit 合规（§3.1 已列）；**不合规的只有 daemon-entry.ts shim**
- shim 位置：daemon-entry.ts:1-8；运行时 `auditWriter` 未构建（结构限制）
- 双层 handler 执行顺序（Node.js）：shim 先注册（top-level）→ daemon.ts 后注册（`daemonCommand` 内）
- 治理路径登记：同 A3 `createSystemAudit` 预构造（独立 phase 规模 → phase189 合并清零）

### 7.B 偏差登记（当前合理）

每条附 **owner + 计划 phase + 升档条件**。编号用 `B.p172-*` 前缀。

**type 标签**（feedback_module_contract_structure r40.3）：B 项必标 `drift` vs `design-gap` 二分。
- **drift type**：契约说应 X / 实然 Y / 修法明确（推 §7.A 必修）
- **design-gap type**：应然 silent / 实然有 / 修法不明 / 必推独立 design phase 评估

> 现有 B.p172-* 历史登记 type 分类待 r43+ 应然同步 phase 批量补标。已知初判：
> - B.p172-1 driver/state 分离 = **design 决策已存**（冻结期判定 / Runtime 复用未来 CLI 入口）
> - B.p172-2 publisher-subscriber 形态 B = **design 决策已存**
> - **B.p344-W daemon_started 归属错配**（r42 D fork 新发现）= **drift**（实由 Assembly assemble.ts:508 发 / 应在 l6_assembly.md §3 audit events 列出 + 本契约 §3.1 移除「daemon_start」描述如不准确 / 参 l6_assembly.md §7.B 已登记）
> - **B.p344-V ProcessManager 调用未在 §4 登记**（r42 D fork 新发现）= **drift**（daemon.ts:47 selfWritePid + L185 selfRemovePid / §4 依赖节缺 ProcessManager / 推 r43+ 应然同步）

#### B.p172-1 — driver / state 分离（daemon-loop 驱动 / Runtime 持态）

- **现状**：daemon-loop.ts 调 `runtime.processBatch(callbacks)` 驱动循环；循环内部状态由 Runtime 持有（§5.1 展开）
- **为何合规**：Daemon 需控制"进程级生命周期 × 循环迭代节奏"两维；Runtime 隔离于进程机制（为未来 CLI / chat 等非 daemon 入口复用）
- **owner**：phase172（冻结期登记）
- **计划 phase**：未来 Daemon / Runtime 稳定化 phase 重议
- **升档条件**：出现"driver 行为依赖 state 内部细节" / "Runtime 内部状态改动波及 daemon-loop 测试"等信号 → 转 7.A 讨论合并或 API 重议

#### B.p172-2 — DaemonLoopOptions publisher-subscriber 形态 B（phase185 4 组结构）

- **现状**：phase185 重构后顶层 9 字段（5 核心平铺 + `inbox` 必填子组 + `motion?` 可选子组 + 2 平铺可选），publisher-subscriber 形态保留
- **为何合规**：publisher-subscriber 形态 B（`feedback_cycle_vs_reverse_dependency`）——Daemon 定义 options + daemon-loop 消费 + callback 回传；phase185 分组后职责边界清晰（`motion?.onInboxMessages` 明示 motion 独有回调）
- **owner**：phase172（冻结期登记）/ phase185（A5 清零后保留 B 类偏差）
- **计划 phase**：phase185 同步（A5 已清零）/ phase238 确认仍保留（MotionExtensions 2 字段 < 5 阈值 / 无 non-motion caller 使用 motion? 扩展）
- **升档条件**：子组字段数增至 5+ / motion 子组出现 non-motion caller 使用 → 评估进一步拆分

#### B.p172-3 — review_request 跨模块编排归属迁移（**phase188 4/4 完成，全链路闭合**）

**迁移链路 4/4 完成**：
- phase174 ✓ 契约调整（`l4_contract_system.md §2.b.1` 应然接口登记）
- phase175 ✓ `ContractManager.handleReviewRequest` 实装 + 8 it 测试（main `b087e89`）
- phase184 ✓ Daemon `onInboxMessages` 调用方切换（daemon.ts +38 行新路径 + gate 短路保留旧代码；main `25f9707`）
- **phase188 ✓ B-3 清理**（daemon.ts -124 行 / §2.5 / §5.5 整章删 / §7.A4c 清零；main `db42781`）

**实然**（phase188 合入后）：
- daemon.ts 零 review_request 业务代码
- 仅保留 L115-123 顶层 4 字段构造 + L130-138 onInboxMessages 转调 3 行接触面
- review_request 完整归 ContractSystem；经由 `contractManager.handleReviewRequest(contractId, reviewCtx)` 单入口

**归属判定依据**（原始登记保留）：按 M1 独立可变职责 / M2 业务语义归属 / M3 资源归属 三原则，review_request 本质是 **"contract 完成后的后置动作"**（主要资源 by-contract 索引 + contract YAML 归 ContractSystem；语义是 contract 生命周期延续），均指向 ContractSystem。归 Daemon 是实然妥协不是应然合规。

**两步法非破坏性归属迁移范式**（phase184 + phase188 首次实践）：
- Step N（phase184 非破坏）：新路径 + 旧代码 gate 短路保留，revert 单 commit 即回归
- Step N+K（phase188 破坏）：删旧代码 + 删契约章 + 清零登记；Path #4 commit msg 五要素论证（前置链路 / 等价性 / 破坏范围 / revert 路径 / 功能影响）

**闭环后引用清单**（原"相关偏差"）：
- Daemon §2.5 / §5.5：章节整体删除（phase188）
- ContractSystem §1 / §2.b.1：应然 → phase175 实装 → phase184 切换完成 → phase188 闭环打 ✓
- modules.md #19：已含 "review_request 整合" 归属（phase174 起同步）

#### B.p172-4 — 字面量未抽常量（轻度）

- **现状**：
  - `'clawspace/dispatch-skills'`（**phase238 drift 修订**：原 daemon.ts:179 / 已移出 daemon.ts；当前在 `contract/manager.ts:1411` + `dispatch.ts:65` = 2 处，< 3 处升档阈值）— 与 phase169 `B.p169-2` 同根
  - `'by-contract'` 目录名（`contract/manager.ts:1334` 1 处）
  - ~~LLM backoff 指数 / 延迟公式~~（**已消化**：daemon-loop.ts 已 import `LLM_RETRY_INITIAL_DELAY_MS` / `LLM_RETRY_MAX_DELAY_MS` from `constants.ts`）
- **为何合规**：字面量语义稳定，当前无跨位置同步修改需求
- **owner**：phase172
- **计划 phase**：合 phase169 `B.p169-2` 同期细化
- **升档条件**：字面量在 ≥ 3 处被引用 / 或 typo 导致 runtime bug → 抽常量

### 7.C 原则对照

全 **32 条**覆盖（Module Logic 11 + Design 11 其中 #1 展 4 面 + Philosophy 4 + Path 6 = 32）。**2026-04-27 r42 D 结构合规修：29→32 补 Path 6（在 Philosophy 节后）**。

#### Module Logic Principles（11 条）

- **M1 独立可变职责**：合规。Daemon 职责 = 进程生命周期（启动/关停/信号）。变更源（进程启停策略 / 信号语义 / lockfile 机制）与 L5 Runtime 事件循环不同
- **M2 业务语义归属**：**灰度**。启动 / 关停由 Daemon 发起；daemon-loop 事件循环 driver 在 Daemon、state 在 Runtime → §7.B1 `B.p172-1` 登记
- **M3 资源归属**：合规。`status/pid` lockfile + process signal handler 归 Daemon 独占（§1 资源节）
- **M4 持久化**：合规。lockfile 磁盘即权威；`instances` 是 Assembly 返回的不可变引用
- **M5 依赖单向**：合规。Daemon → Assembly / Runtime / SkillSystem / ContractSystem（§4.11 合规表）；无上行依赖 / 无循环
- **M6 依赖结构稳定**：合规。启动期 `assemble` 一次性注入 Instances，运行期 readonly
- **M7 耦合界面稳定**：**灰度**。`DaemonLoopOptions` 4 组结构（phase185）；`StreamCallbacks` 结构较大保留
- **M8 耦合界面最小**：合规（phase185 清零后）。`daemonCommand(name)` 单参最小 ✓；`DaemonLoopOptions` 顶层 9 字段（5 平铺 + 2 子组 + 2 可选平铺）≤ 8 阈值软合规，§7.A5 已清零；daemon-loop 对 Runtime 只调 3 方法 ✓
- **M9 显式表达编译器可检**：合规。TypeScript 强类型贯穿；`DaemonLoopOptions` / `Instances` 接口强制
- **M10 不合理停下**：未触发（本 phase 是冻结契约登记，不触发"模块设计不合理"条件）
- **M11 边界不对停下**：未触发。Daemon 边界清晰（进程入口）

#### Design Principles（11 条；#1 展 4 面）

- **D1a 信息不丢失**：**合规**（Daemon §7.A 10/10 全清零里程碑 phase191；§A2 phase191 16→0 闭环 / 3 处 β/γ 保留 console 属运维可见非信息丢弃；§A3 LockConflictError phase189 `af6f03a` preAssembleAudit 覆盖；§A7 shim 缺口 phase189 同根同治清零；phase240 F4 L1 复核前进 / drift 修订）
- **D1b 状态可观察**：**合规（phase173 大幅改善）**。装配期 audit（§3.1 / §3.2）+ daemon-loop 5 事件（§3.3）覆盖 batch / interrupt / retry / fatal / poller_disabled 全维度
- **D1c 中断可恢复**：合规。SIGTERM/SIGINT 触发 `disassemble`，按拓扑反向清理
- **D1d 事后可审计**：**合规**（Daemon §7.A 10/10 全清零里程碑 phase191；§A1 phase173 / §A2 phase191 / §A3 + §A7 phase189 `af6f03a` / §A4a-c 各自清零 / §A5 phase185 / §A6 phase177；phase224 M#4 Path #1 复核前进 / drift 修订）
- **D2 不得丢弃/静默**：**合规**（§7.A1 daemon-loop 清零 / §7.A2 phase191 16→0 闭环 / 3 处保留 console 属运维可见非静默丢弃（`af6f03a` §7.A2 节详解）；phase240 F5 L2 复核前进 / drift 修订）
- **D3 用户可观察**：合规（间接）。console 输出 + Runtime stream callbacks 传达给用户
- **D4 LLM 调用恢复**：合规（phase173 强化）。daemon-loop LLM error retry（指数 backoff）+ max retries 终止；**phase173 加 `daemon_loop_llm_retry` audit** 让退避决策可审计（§3.3.3）
- **D5 日志重建**：**合规（phase173 改善 / 缺口 phase188/189/191 全清零）**。daemon-loop 5 事件足以从日志重建循环轨迹；review_request 链路 phase188 归 ContractSystem / LockConflictError 分支 phase189 preAssembleAudit 覆盖 / §7.A2 16→0 phase191；完整 daemon 轨迹可从 audit.tsv 重建
- **D6 智能体决策主体**：无关（Daemon 是基础设施，非决策主体）
- **D7 系统可信路径**：合规。Daemon 作为进程入口，Assembly/Runtime 经受信注入消费
- **D8 事件驱动**：合规。daemon-loop 用 inbox watcher + timeout 组合实现事件驱动（`waitForInbox`）
- **D9 多 claw 不隔绝**：合规（间接）。motion daemon + claw daemon 共享 daemonCommand；review_request 路径是 motion 对 claw 的整合动作
- **D10 motion 特殊**：合规。motion 走 review_request + heartbeat（motion-only 字段），§2.5 / §5.5 登记
- **D11 CLI 唯一对外**：合规。Daemon 经 daemon-entry.ts 作为进程 main，是外部启动入口；与 CLI 其他 command 共享 `src/cli/commands/` 目录

#### Philosophy（4 条）

- **P1 Agent 即目录**：合规。`name` 参数决定 agent 目录（`dir = path.join(clawforumDir, name)`）
- **P2 上下文工程**：无关（Daemon 是基础设施）
- **P3 多 agent 利用**：合规。同一 daemonCommand 支持 motion + claw 两身份
- **P4 系统为智能体服务**：合规。Daemon 提供"进程常驻 + 信号处理 + review_request 编排（motion）"基础设施

#### Path Principles（6 待核 / 2026-04-27 r42 D 结构合规修：29→32 补 Path 6）

> Path 6 authoritative source 待核 / 暂列已知 4 + 待补 2

| # | 已知 | 判定 | 证据 |
|---|---|---|---|
| Path #1 | 实测核 baseline | 合规 | phase173/188/189/191/240/224 各 phase 起步 Path #1 复核 / 多次推翻或验证 |
| Path #3 | 语义原子最小变更 | 合规 | §7.A 10/10 全清零分 4 phase 接力（173/188/189/191）/ 每 phase 单一 scope |
| Path #6 | 冲突停 | 合规 | phase172 冻结期决策 / 不强行重构 |
| Path #8 | 总难度最低 | 合规 | A1 等大条分 phase 消化 / 不堆 |

### 7.D 关键决策映射表（modules.md 迁移）

从 `design/modules.md` §关键设计决策章节迁移（2026-04-26 主会话；后续清理阶段重构）。原 KD 编号保留供对账。

- **KD#15（原 modules.md）Assembly 是装配汇聚点，Daemon 只做进程生命周期**（cross-ref）：详 l6_assembly.md §7.D 主登记。本模块承担「进程生命周期」职责，不参与任何模块装配。

---

### 7.Phase 执行纪律

本 phase 实施过程中的非架构偏差登记（按 `feedback_module_contract_structure` §7.Phase 硬化规则）。

#### 纪律.1 — 冻结契约登记方法论首用（新定位）

- **触发**：phase172 起步前识别 Daemon 属 L6a 顶层模块（`feedback_top_module_freeze_window`），不适用粗糙重构四动作；方法论退化为 A + D 两动作 + §7.A 厚登记
- **违反条款**：无（识别后转为合规新形态）
- **纠错链路**：总览 §方法论定位节明示"冻结契约登记 ≠ 粗糙重构"；四动作定位表对比两模板差异；Step 4 §7.A 10 条作为 phase 重头戏
- **根因**：phase166/169/170 粗糙重构模板不能机械套用到顶层模块
- **治理路径**：本 phase 产出"冻结契约"模板可复用（phase173+ 同型如 CLI / Watchdog 可直接套）；元规则层面 `feedback_top_module_freeze_window` 已覆盖

#### 纪律.2 — 事实核查节附命中行号（phase169 C4 硬化实践）

- **触发**：总览 §事实核查节每条 grep 附命中行号（非只列命令），承接 phase169 C4 硬化需求
- **违反条款**：无（首次实践，预防 C1 反复违反）
- **纠错链路**：总览 §背景节 daemon.ts 顶层结构用 L32 / L294 行号佐证；§事实核查节每 grep 附命中摘录；Step 1 F15 6 项复核全 ✓ / 4 项"补充事实"登记新发现（N1-N3）
- **根因**：phase169 C1 指出事实核查缺失是 P0 反复违反，总览模板硬化后本 phase 验证
- **治理路径**：本 phase 证明硬化有效 —— F15 复核发现 N1 双层 handler 现象，若不实测仅凭记忆会漏；继续维持该模板

#### 纪律.3 — 用户规则"非代码步骤写完直接执行"的落实

- **触发**：本 phase 全 Step（1-7）都无代码改动，按用户规则 Step 1 → Step 2 → ... 每步写完即执行
- **违反条款**：无
- **纠错链路**：Step 1 扫描 + Step 2-5 契约 + Step 6 modules.md + Step 7 验收合入，每步写计划 + 立即执行 + 验收
- **根因**：与 phase169 每步等用户确认的节奏不同，冻结契约期都是非代码可自动推进
- **治理路径**：建立"冻结契约 phase 全自动推进"工作流模板

#### 纪律.4 — phase173 清零 §7.A1 / §7.A2（部分）

**（phase173 新增）** — 细化期 A 类清零首例。

- **触发**：phase173 Step 2-5 在 daemon-loop.ts 集成 5 类 audit；Step 6 补测试断言双粒度（4 现有 it 扩展 + 4 新 it）；Step 7 本条 + §3.3 / §7.A 契约回写
- **成果**：
  - §7.A1 条目**删除**（daemon-loop 370 行零 audit 消化为 §3.3 5 事件）
  - §7.A2 子条"daemon-loop 5 处 console"删除（纳入 5 类 audit 双写 / 保留 console 决策，见 §3.3.6）
  - daemon.ts 16 处 console 保留（未来独立 phase 做）
  - §7.A3 / §7.A7 **phase172 漏核纠正**（见 §7.A3 / §7.A7 + 纪律.5）
- **方法论贡献**：细化期 A 类清零**首次落地**（本项目首个）；模板：单 phase 清一个模块的一组 A 条（按事件类型拆 Step 2-5 + Step 6 专补测试 + Step 7 回写契约）；升格候选 `feedback_refinement_a_clearance` 待 phase174+ 同型 phase 验证

#### 纪律.5 — phase172 §7.A3 / §7.A7 事实漏核纠正（phase169 C1 形态变种）

**（phase173 新增）** — 事实核查粒度升级。

- **触发**：phase173 Step 1 扫描 F15 发现 phase172 §7.A3（"双路径"）/ §7.A7（"行为待核"）两条描述与实测不符
  - §7.A3：实测是"缺 audit 分支"（LockConflictError L60 直接 exit 跳过 L75 audit），非"双路径"
  - §7.A7：实测 daemon.ts L245-258 `writeCrash` 已发 `daemon_crash` audit（合规）；不合规的只有 shim
- **违反条款**：`feedback_verify_facts_before_plan`（清单性断言一律佐证）的**形态变种**
  - phase169 C1 原教训："未 grep 佐证即下断言"
  - phase172 新形态："grep 了行号但未 Read ±10 行邻近代码即下断言"
- **纠错链路**：Step 1 扫描文档 §phase172 事实漏复盘 → Step 7 §7.A3 / §7.A7 措辞修正（本条落地）
- **根因**：phase172 §7.Phase 纪律.2 自述"事实核查附命中行号"仅硬化到 grep 位置，未核邻近代码行为；粗扫 + 推断下结论
- **治理路径**：
  - phase173 总览 §事实核查节强化"对'未核/待核/可能发'等模糊措辞必须 Read ±10 行邻近区间后下判"
  - 本纪律登记为 phase169 C1 形态变种；phase 起步 checklist 加一行"grep 只核位置 / Read 才核行为"
  - **元规则迭代候选**：若 phase174+ 再犯则升格硬化到 `feedback_verify_facts_before_plan.md`（当前 1 犯 + 1 纠未达 ≥ 2 次）

#### 纪律.6 — 无 agent 越界 / 无纠错链路追加修

本 phase 无 agent 在产品代码加 test-aware fallback / 自主扩字段等越界；phase173 Step 2-5 代码合入链各自独立 commit（无 Step N → Step N-1 反向修补）。

#### 纪律.7 — phase172/173 §7.A4a 文件名误登（phase169 C1 形态变种第 2 次）

**（phase174 新增）** — Step 1 扫描发现并纠正。

- **触发**：phase174 Step 1 扫描发现 `tests/cli/daemon.test.ts` 实为 **ProcessManager.acquireLock** 测试（10 it / phase133/152 历史），与 phase172/173 §7.A4a 描述"零覆盖 / 新建该文件"矛盾
- **违反条款**：`feedback_verify_facts_before_plan` 形态变种 ——
  - phase169 C1 原："未 grep 佐证即下断言"
  - phase172/173 形态："grep 了文件名 ls 确认存在 / 但未 Read 内容"
- **纠错链路**：phase174 Step 1 F6 完整 Read daemon.test.ts 144 行 → 发现 ProcessManager scope → scope 调整为新建 `tests/cli/daemon-command.test.ts`
- **根因**：phase172/173 Step 1 扫描时未 Read 该文件内容，仅根据"§7.A4a 列了 daemon.test.ts"假设其为 daemon 测试模板，未实测内容
- **治理路径**：本 phase §7.A4a / §7.A4d 措辞已修正（划去 + "phase174 已清零" + ProcessManager 占用注记）

#### 纪律.8 — phase169 C1 形态变种第 3 次（本会话 principles.md Read 前 Write 复发）

**（phase174 新增）** — Path Principles 落地动作自身触发 → 升格 feedback。

- **触发**：phase174 讨论中加 Path Principles 一章到 `clawforum/design/principles.md`，agent 仅 `ls` 确认文件路径返回，未 Read 文件内容就准备 Write —— 用户实时 Path #1 中断
- **违反条款**：Path #1「基于规划时刻的事实」 + phase169 C1 形态变种第 3 次（最讽刺的复发：**在落地 Path Principles 的当下违反 Path #1**）
- **纠错链路**：用户中断 → Read principles.md 全 71 行 → 发现实然与假设完全不同（已存在 Philosophy / Coding 两章 + Design / Module Logic 已精简版）→ 改用 Edit 加一章 Path Principles 而非 Write 整体
- **根因**：agent "ls 看到路径返回 = 文件存在 → 直接 Write" 的推断；从未 Read 内容
- **治理路径**：本 Step 6 升格 `feedback_verify_facts_before_plan.md` 加硬化条款"ls / grep 只核位置，必 Read 内容"
- **意义**：3 次同型触发（phase172 §7.A3/A7 + phase174 §7.A4a / daemon.test.ts + 本会话 principles.md）**远超** `feedback_rules_iteration_on_phase_close` ≥ 2 次升格阈值 → 硬化落地

#### 纪律.9 — phase177 daemon.ts:179 改调 createSkillRegistry 工厂（A6 清零）

**（phase177 新增）** — 细化期 A 类清零第 3 phase，scope 最小（2 行代码改动）。

- **触发**：承 phase173 / phase174 细化期模板，消化 Daemon §7.A6 条目
- **Path 对照**：
  - Path #1 规划时刻事实 ✓（Step 1 扫描 daemon.ts 2 处 + 工厂签名 + 契约 4 处引用；Read 邻近代码 L170-190）
  - Path #2 差距登记 ✓（phase169 `B.p169-1` 已登 4 处 / Daemon §7.A6 指向 `createSkillRegistry` 治理）
  - Path #3 最小变更单元 ✓（2 行代码 + 4 处契约文本 + SkillSystem `B.p169-1` 4→3）
  - Path #4 可回滚 + 破坏性改动论证 ✓（diff 2+ 2- 单 commit；工厂内部 `return new SkillRegistry(fs, skillsDir)` 等价）
  - Path #5 完成后复盘 + 实践反馈规则 ✓（Step 4 登记）
  - Path #6 无冲突触发
- **成果**：
  - §7.A6 清零（~~A6~~ 划去）
  - SkillSystem `B.p169-1` 从 4 处 → 3 处（daemon.ts 从清单移除）
  - daemon.ts 零 `new SkillRegistry`
  - 合入 main `91e8f64`
- **与 phase173 / 174 对比**：phase173 清零 A1/A2/A3/A7；phase174 清零 A4a/A4d；本 phase 清零 A6 —— §7.A 累计清 6 条（A5 / A4b / A4c 剩）

#### 纪律.10 — phase183 waitForInbox 直测（A4b 清零）

**（phase183 新增）** — 细化期 A 类清零第 4 phase，scope 极小（0 产品代码 + 4 it 测试）。

- **触发**：承 phase173/174/177 细化期模板，消化 Daemon §7.A4b 条目
- **Path 对照**：
  - Path #1 规划时刻事实 ✓（Step 1 Read `daemon-loop.ts` L111-141 完整函数体 + 现有 test mock 模式 + `createWatcher` 签名）
  - Path #2 差距登记 ✓（§7.A4b "三路径无直接断言" 自 phase172 登记至今）
  - Path #3 最小变更单元 ✓（单 describe + 4 it / 0 产品代码；diff +101 行测试）
  - Path #4 可回滚 ✓（纯测试增量单 commit）
  - Path #5 完成后复盘 ✓（Step 4 登记）
  - Path #6 无冲突触发
- **成果**：
  - §7.A4b 清零（~~A4b~~ 划去）
  - §8.1 §2.2 / §2.3 / §8.3 同步更新（4 处）
  - fix 7 settled guard 首次有显式 regression test
  - 合入 main `37e8bcc`
- **与 phase173/174/177 对比**：phase173 A1/A2 部分/A3/A7；phase174 A4a/A4d；phase177 A6；**phase183 A4b** —— §7.A 累计清 7 条（A5 / A4c / A2 残余 剩）

#### 纪律.11 — phase184 Daemon review_request 调用方切换（B.p172-3 链路第 3 步）

**（phase184 新增）** — B 类升档归属迁移链路第 3 步；非破坏性改动 + 旧代码 gate 短路保留。

- **触发**：B.p172-3 升档链路（phase174 应然 / phase175 实装 / **phase184 切换** / phase18x B-3 清理）
- **违反条款**：无（正向 M#2 业务语义归属正本清源）
- **Path 对照**：
  - Path #1 ✓ Step 1 扫描 F1-F9 + Read daemon.ts L114-241 / manager.ts L1271-1393 / 测试
  - Path #2 ✓ B.p172-3 升档登记是 scope 起点
  - Path #3 ✓ scope 严限 onInboxMessages 新路径；旧代码保留（D4 γ.2 gate 短路）；B-3 独立 phase
  - Path #4 ✓ 非破坏性；revert 单 commit 即回归旧行为
  - Path #5 ✓ 本登记
  - Path #6 ✓ **4 次触发**（并行 phase 号 180/181/182/183 占用 → 本分支顺延至 184）
- **F8 N2 登记**：daemon.ts 原不持顶层 contractManager 实例；Step 2 实施时新构造 motion-scoped `new ContractManager(dir, 'motion', motionFs)` + `motionFs` + `clawsBaseDir`（+3 行顶层构造）
- **F9 决策调整**：总览估计 mock 复用度 ≥ 80% → 实测 ~70% 临界；Step 1 D3 决策倾向 β（新建独立文件），但用户实施时选 **α（扩 daemon-command.test.ts）** —— 复用度判断在实施时更准，决策修订合规
- **成果**：
  - §7.B.p172-3 状态更新为 "调用方已切换，代码 B-3 清理"
  - §2.5 / §5.5 加 phase184 注记横幅（不删 chapter，B-3 scope）
  - daemon.ts +38 行（新路径 block + 4 字段构造 + gate 短路）/ daemon-command.test.ts +95 行 +4 it
  - 合入 main `25f9707`
- **与链路前置 phase 对比**：phase174 契约应然 0 代码 / phase175 实装 387 行 manager.ts + 337 行测试 / **phase184 调用方切换 38 + 95 行** / phase18x B-3 清理（估 -130 行旧代码 + chapter 删）
- **剩余 B-3 scope**：
  - daemon.ts L139-240 130 行旧实现删
  - daemon.ts 顶层构造保留（motionFs / contractManager / clawsBaseDir / reviewCtx 仍活跃）
  - §2.5 / §5.5 chapter 删
  - daemon.ts 原 review_request 专用 import 清理（writePendingSubagentTaskFile / buildRetroPrompt / createSkillRegistry 若仅被 dead 代码引用）

#### phase189 纪律 — Daemon §7.A3 + §7.A7 pre-assemble audit sink（2026-04-21，合入 `af6f03a`）

- **scope**：承 phase173/174/178/179/180 细化期 A 类清零模板；Daemon §7.A3（LockConflictError / pre-assemble 失败零 audit）+ §7.A7（shim 2 handler 零 audit）**同根同治合并清零**
- **同根同治**：两条根因同一（pre-assemble 阶段 `auditWriter` 未构造），治理路径同一（`createSystemAudit` 预构造 audit sink），合并单 phase 首次实践
- **决策**：保留双层 handler + audit 双发（phase172 §7.A7 方向 B）；不删 shim

- **产出**：
  - `src/cli/commands/daemon.ts` L37 后引入 `preAssembleAudit` sink；L59-61 LockConflictError audit + L63-64 其他 assemble 失败 audit（+15/-5）
  - `src/daemon-entry.ts` 引入 `shimAudit` + 2 handler 双写（audit 先 / console 保留）+ 三层兜底（+15/-5）
  - 新 audit：`assemble_failed module=lockfile|pre_assemble phase=preconstruct`（复用 type 扩 module/phase）+ `daemon_uncaught_exception` + `daemon_unhandled_rejection`（新 type × 2）
  - §7.A3 + §7.A7 划去 + §3.2 / §3.5 登记 + 本纪律节

- **Path Principles 6 条实践**（phase174 首次 / phase178 二次 / phase182 三次 / phase189 第 4 次）：

| Path | 本 phase 落实 |
|---|---|
| #1 规划基于规划时刻事实 | ✓ Step 1 扫描 daemon.ts L37-80 + daemon-entry.ts 10 行 + createSystemAudit 签名 ±10 行 Read；phase169 C1 形态变种 4 次硬化持续生效 |
| #2 差距显式登记 | ✓ phase172/173 §7.A3 / §7.A7 登记 → phase189 清零（差距→治理→关闭完整链）|
| #3 语义一致最小变更单元 | ✓ §7.A3 + §7.A7 同根同 commit；不混 §7.A2 / §7.A4c / §7.A5 |
| #4 可回滚 + 破坏性论证 | ✓ 本 phase **非破坏性**（新增 audit / 不改公共接口）；shim 行为改变 commit msg 论证"audit 双写先于 console" |
| #5 完成后复盘 | ✓ Step 5 三维 + Path 4 维复盘 + memory 登记 |
| #6 冲突立即中断 | ✓ Step 1 扫描 F5 并行分支冲突预查（分支 A/B/C/E 均无冲突区段）；phase 号因 phase188 已被分支 A 占顺延至 189 |

- **方法论贡献**：
  - **同根同治合并 phase 模板首次实践** —— §7.A3 + §7.A7 在 phase172 登记起就共认根因 + 治理路径，本 phase 首次合并 clearance；未来同型可参
  - **shim 三层兜底模板** —— 构造失败 null / write 抛 try/catch / 全 fallback console+exit；shim 作为最外层兜底不可再抛的工程化表达
  - **audit module/phase 双字段分层** —— `assemble_failed` type 的 `module` + `phase` 字段承载 pre/post-assemble × lockfile/runtime/pre_assemble 二维状态；减少 type 爆炸

- **与 phase173/174/178/179/180 对比**：

| phase | scope | 代码改动 | 方法论 |
|---|---|---|---|
| 173 | daemon-loop §7.A1 | 5 audit | 双写首立 |
| 174 | daemon.ts §7.A4a/d | 0 产品代码（测试补齐）| process mock |
| 178 | Runtime §7.A 4 条 | 3 audit + helper 抽取 | scenario-based |
| 179 | Cron §7.A | 2 audit | 双参必填 |
| 180 | SkillSystem §7.A | 3 audit + 契约 rename | 破坏性 rename |
| **189** | **Daemon §7.A3 + §7.A7（合并）** | **2 new type + 1 扩展 + shim 重构** | **同根同治合并 phase** |

- **升格候选**（观察 phase190+）：
  - **同根同治合并 phase 模板** —— 条件：两条 A 类偏差登记即明示同根因 + 同治理路径 → 合并单 phase；连续 2 次实践后升格 feedback
  - **shim 三层兜底模板** —— 最外层兜底代码不可再抛的工程化表达

#### 纪律.12 — phase188 Daemon review_request B-3 清理（归属迁移链路 4/4 收尾）

**（phase188 新增）** —— review_request 4 phase 迁移链路 4/4 完成；破坏性改动；Path #4 commit msg 五要素论证首次完整实践。

- **触发**：B.p172-3 升档链路第 4 步（phase174/175/184 完成 → phase188 收尾清理）
- **违反条款**：无（正向 M#2 业务语义归属正本清源）
- **Path 对照**：
  - Path #1 ✓ Step 1 F1-F8 事实核查 + Read daemon.ts 死代码区间 L139-256 + 两契约章锚点
  - Path #2 ✓ phase184 复盘"剩余 B-3 scope"清单是 scope 起点
  - Path #3 ✓ scope 严限 118 行 + 6 import + 两契约章；不动顶层构造 / 新路径 / tests
  - Path #4 ✓ **破坏性 commit msg 五要素**（前置链路 phase174/175/184/188 / 等价性 phase184 7 维 + 8 it / 破坏范围 118 行 + 6 import / revert 回 phase184 gate 短路版 / 功能影响 zero）
  - Path #5 ✓ 本登记
  - Path #6 ✓ **3 次触发**（phase 号 185 分支 C / 186 分支 B / 187 分支 E 占用 → 顺延 188）
- **N1 顺手清理**：`DEFAULT_MAX_CONCURRENT_TASKS` phase184 前遗留 dead import 一并删
- **成果**：
  - daemon.ts **-124 行**（118 行死代码 + 6 import）；main `db42781`
  - §2.5 / §5.5 整章删（零外链）+ §7.A4c 划去清零 + §7.B.p172-3 标 4/4 全链路闭合
  - §3.1 L239 引用同步 "phase188 已清零"
  - l4_contract_system.md §2.b.1 状态表 4/4 打 ✓
- **与 phase184 对比**（两步法非破坏性迁移范式首次实践）：
  - phase184 **+38 行**（非破坏：保留旧代码 gate 短路）
  - **phase188 -124 行**（破坏：清理死代码 + import）
  - 两步法价值：N 保留让切换可测试验证，N+K 破坏性清理等价性已验证 —— 避免一步到位的风险
- **升格候选**（未硬化，观察 phase190+）：
  - **两步法非破坏性归属迁移范式**（phase184 + phase188 首次实践；观察下一次归属迁移）
  - **Path #4 破坏性 commit msg 五要素**（phase188 首次完整；候选硬化入 `feedback_pr_one_commit_rule`）
  - **B 类终态闭环**（B.p172-3 从"登记 → 升档 → 切换 → 清理"完整 lifecycle）

#### 纪律.13 — phase185 DaemonLoopOptions 11 字段拆 4 组（A5 清零）

**（phase185 新增）** — 细化期 A 类清零第 5 phase；接口破坏性改动（11 平铺 → 4 组）+ 9 call-site 同步；并行分支 C；合入 main `79c2a9c`。

- **触发**：承 phase173/174/177/183 细化期模板，消化 Daemon §7.A5 条目（phase172 登记至 phase185 兑现，历时 13 phase）
- **Path 对照**：
  - Path #1 规划时刻事实 ✓（Step 1 Read `DaemonLoopOptions` L94-106 完整接口 + 1 产品 call-site + 8 测试 call-site + 内部 `options.xxx` 访问 L151/152/248/249/257/258）
  - Path #2 差距登记 ✓（§7.A5 phase172 登记"字段 11 > 8 阈值"）
  - Path #3 最小变更单元 ✓（单 commit；4 文件 -42 +55 / interface + 2 call-site + 内部解构 + 1 测试断言调整）
  - Path #4 可回滚 + **破坏性改动论证** ✓（commit msg 完整 before/after 字段分布 + 受影响 call-site 清单）
  - Path #5 完成后复盘 ✓（Step 4 登记）
  - Path #6 冲突触发 ✓（ff merge 失败 → 发现 phase188 并行先合入 → rebase 后重跑验收）
- **成果**：
  - §7.A5 清零（~~A5~~ 划去）+ §2.2 4 组结构字段表重构 + §5.4 publisher-subscriber 描述更新
  - §7.B.p172-2 现状 "11 字段" → "phase185 4 组结构"；升档条件更新（子组字段数阈值）
  - §7.C M#8 从"部分违反"→"合规"
  - 新增导出类型：`DaemonInboxConfig` / `DaemonMotionExtensions`（模块边界语义显式化）
  - claw / motion 调用形态通过 `motion?` 可选整体省略显式区分
  - 合入 main `79c2a9c`
- **与 phase173/174/177/183 对比**：
  - phase173 A1/A2 部分/A3/A7 纠正 / phase174 A4a/A4d / phase177 A6 / phase183 A4b / phase184 B-2 / phase188 B-3 (A4c) / phase189 A3+A7 / **phase185 A5**
  - §7.A 累计清 **8 条 A 类**（+ phase188 A4c + phase189 A3+A7 合计 11 条）；剩 A2 残余
- **合入协议实战**：
  - 主会话 `git merge --ff-only phase185` 失败 → 诊断 main 已前进至 phase188 → 识别为"需 rebase"事件
  - **首次触发** `feedback_rebase_is_code_change`：rebase / 非 ff merge 属"改代码"留用户实施；主会话仅诊断 + 写合并计划
  - 合并计划冲突评估准确（文件仅 daemon.ts 重叠；行区间独立 → rebase 自动成功）
- **升格候选**（观察 phase190+）：
  - **接口重构 phase 的 Path #4 five-element commit msg 模板**（phase188 + phase185 2 次实践；可升格 `feedback_pr_one_commit_rule`）
  - **`rebase 是改代码` 留用户实施**（phase185 首次触发；feedback 已落）

#### 纪律.13 — phase191 Daemon §7.A2 残余清零（16 → 0 闭环收尾）

**（phase191 新增）** —— §7.A2 console 清单自 phase172 登记以来 4 轮消化闭环；**零代码改动路径**（契约回写 only）。

- **触发**：r3 分发表分支 A 认领 §7.A2 残余清零
- **消化轨迹** 16 → 0：
  - phase173 ✓ daemon-loop 5 处 → 5 audit + §3.3.6 保留 console 清单
  - phase188 ✓ review_request 10 处 → B-3 链路清理随代码删
  - phase189 ✓ 启动失败 3 处 → audit + console 双写（module/phase 双字段）
  - **phase191 ✓ 残余 3 处** → 全登记保留 console（β/β/γ 决策）
- **Path 对照**：
  - Path #1 ✓ Step 1 扫描 Read ±10 行 + 契约滞后证据核（§7.A2 "16 处" vs 实然 3）
  - Path #2 ✓ §7.A2 原登记是 scope 起点；4 phase 消化轨迹显式登记
  - Path #3 ✓ scope 严限 Daemon §7.A2；不涉 Watchdog / Runtime / 其他 console
  - Path #4 ✓ 非破坏性（零代码改动；§3.3.6 扩而非重构）
  - Path #5 ✓ 本登记
  - Path #6 ✓ **1 次触发**（phase190 分支 D 占用 → 顺延 191）
- **决策依据** D1/D2/D3 β/β/γ：
  - D1 L94 heartbeat 清理：best-effort 启动期 / 与 `daemon-loop.ts:278` 同型（纯保留先例）
  - D2 L185 pid 清理：best-effort shutdown 期 / failure 后 `process.exit(0)` 不阻塞
  - D3 L193 `Started`：L106 `daemon_start` audit 已承载；console.log 是人眼 checkpoint
- **成果**：
  - §7.A2 16 → 0 完全清零（划去 + 注记）
  - §3.3.6 扩清单 5 → 11 行（daemon-loop 5 + daemon.ts 启动双写 3 + daemon.ts 残余保留 3）
  - 零 commit / 零代码 / 零测试改动；design 本地 only
- **工作流特性**：
  - 全程非代码路径 —— agent 一次会话内完整实施（扫描 + 契约回写 + 复盘 + memory）
  - 与 phase181/186/187/190 同型（本地 only 规划 / 契约 / 元规则 phase）
- **方法论贡献**（升格候选）：
  - **§7.A 消化轨迹表模板**：条目历经多 phase 分批消化时契约登记必须带轨迹表（否则契约滞后实然的 drift 风险）；phase191 §7.A2 消化轨迹表首次成型
  - **零代码清零路径**：扫描发现"契约滞后 + 残余属运维保留"时可一次性 β/γ 决策 + 契约回写闭环；与 phase179 纯 audit 集成 / phase185 接口拆分等代码型清零互补
- **Daemon §7.A 清零状态**：
  - 清零条目：A1 ✓ A2 ✓ A3 ✓ A4a ✓ A4b ✓ A4c ✓ A4d ✓ A5 ✓ A6 ✓ A7 ✓
  - **§7.A 10/10 全清零**（phase173/174/177/183/184/185/188/189/**191** 九 phase 接力）
  - 剩余条目：无（A 类清零彻底闭环）
- **升格候选**（观察未来 phase）：
  - **§7.A 消化轨迹表模板**（phase191 首次成型）—— 条件：下一多 phase 消化条目再次实践 → 硬化入 `feedback_module_contract_structure`
  - **零代码清零路径**（phase181/191 等 design only 类型）—— 已在 `feedback_refinement_a_clearance` phase186 升格时登记 5 形态之一

### §7.drift — 应然 framing drift（phase325 全推 / 2026-04-26）

| # | 位置 | drift 描述 | 修正 |
|---|---|---|---|
| D1 | §head | 缺 head 应然/实然 split（原仅 `> 应然承诺。实然差距见 §7。`）| 补全（已执行）|

## 8. 测试覆盖

### 8.1 行为覆盖

按 §2 五子节归类（现有测试 `tests/cli/daemon-loop.test.ts` 覆盖路径，冻结期无新增）：

- **§2.1 daemonCommand（启动期）**
  - **零覆盖**（§7.A4a）—— 新建 `tests/cli/daemon.test.ts` 需求已登
- **§2.2 startDaemonLoop（运行期主路径）**
  - `tests/cli/daemon-loop.test.ts` 现有 4 it（interrupt poller circuit breaker / LLM retry / max retries / non-LLM error）**phase173 扩展 audit 断言双粒度**
  - **phase173 新增 4 it**（event-driven 覆盖）：
    - `IdleTimeoutSignal` → `daemon_loop_interrupt cause=idle_timeout`
    - `UserInterrupt` → `daemon_loop_interrupt cause=user_interrupt`
    - `PriorityInboxInterrupt` → `daemon_loop_interrupt cause=priority_inbox / recovery_delay_ms=0`
    - chain reaction → `daemon_loop_iteration type=chain / chain_total=<M>`
  - **覆盖状态**：5 类 daemon-loop audit 事件全 ✓（§8.2）；`waitForInbox` 直接单测 ✓（phase183 4 it 覆盖三路径 + settled guard，§7.A4b 已清零）
- **§2.3 waitForInbox**
  - **✓ phase183 4 it 直测**（`tests/cli/daemon-loop.test.ts` `describe('waitForInbox')`）覆盖新文件到达 / 超时 / ensureDirSync 抛错三路径 + settled guard；原 `startDaemonLoop` 间接覆盖保留
- **§2.4 runtime 公共 API 消费面**
  - 间接覆盖（daemon-loop.test.ts 通过 mock Runtime 测试）
- **§2.5 review_request 特殊路径**
  - **零覆盖**（§7.A4c）—— 130 行最复杂路径完全依赖生产环境日志调试

### 8.2 §3 事件回链（phase173 更新）

覆盖档位：`✓` type + payload 双粒度断言 / `△` 行为 callback 断言但无 audit type 断言 / `✗` 零覆盖。

| # | event type | 回链测试 | 覆盖 |
|---|---|---|---|
| 1 | `daemon_start` | daemon-command.test.ts it #1 / #2（claw + motion）| **✓** |
| 2 | `daemon_crash` | daemon-command.test.ts it #10（uncaught）/ #11（rejection）| **✓** |
| 3 | `assemble_failed`（module=runtime / phase=post_assemble_init） | daemon-command.test.ts it #5（runtime.initialize 失败）| **✓** |
| 4 | `snapshot_commit_uncategorized`（context=daemon-start） | daemon-command.test.ts it #6 | **✓** |
| 5 | `snapshot_commit_failed`（context=daemon-start） | daemon-command.test.ts it #7 | **✓** |
| 6 | `daemon_loop_iteration`（type=chain / type=wait） | daemon-loop.test.ts chain reaction it + interrupt poller it | **✓** |
| 7 | `daemon_loop_interrupt`（3 cause） | daemon-loop.test.ts × 3 新 it（idle / user / priority） | **✓** |
| 8 | `daemon_loop_llm_retry` | daemon-loop.test.ts LLM retry + max retries it | **✓** |
| 9 | `daemon_loop_fatal`（2 reason） | daemon-loop.test.ts max retries（max_retries_exhausted）+ non-LLM（non_llm_error）| **✓** |
| 10 | `daemon_loop_interrupt_poller_disabled` | daemon-loop.test.ts 独立 poller_disabled it（mock fs）| **✓** |
| – | review_request 路径自产事件 | §3.4 "当前：无"（未来 phase 补） | – |
| – | 双层 handler 事件 | §3.5 "当前：无"（未来 phase 补） | – |

**phase173 清零**：daemon-loop 5 事件全 ✓。
**phase174 清零**：daemon.ts 5 事件全 ✓（A4a + A4d 合入 daemon-command.test.ts 11 it）。
**累计 §8.2 10/10 实现事件全 ✓**；review_request / 双层 handler 事件仍 n/a（§3.4 / §3.5 "当前：无"，独立 phase 补）。

### 8.3 测试缺口说明（phase173 + phase174 清零后）

**phase174 清零**：A4a + A4d 合入 `tests/cli/daemon-command.test.ts` 11 it。

**§7.A4 剩余**（phase188 清零 A4c 后）：
- ~~A4b~~（phase183 已清零，daemon-loop.test.ts 扩展 4 it）
- ~~A4c~~（**phase188 已清零（代码已迁 ContractManager）**；测试由 `tests/core/contract-review-request.test.ts` 8 it + `tests/cli/daemon-command.test.ts` +4 it 覆盖）

**未来稳定化 phase 补缺规划**：
- ~~扩 `tests/cli/daemon-loop.test.ts`（A4b `waitForInbox` 直测）~~（phase183 已落）
- ~~新建 `tests/cli/daemon-review-request.test.ts`（A4c）~~（phase188 清零；代码已迁 ContractManager，无需新建）

#### phase238 纪律 — Daemon §7.B 治理评估（2026-04-22，design 本地 only）

- **scope**：r14 分支 E / §7.B 4 条逐条 Path #1 核 + 决策
- **产出**：B.p172-2 计划 phase 措辞更新 / B.p172-4 2 处 drift 修订（`dispatch-skills` 位置漂移 + LLM backoff 已消化标注）
- **保留观察**：B.p172-1（driver/state 分离稳定）/ B.p172-2（MotionExtensions 2 字段 < 5 阈值）/ B.p172-4 `by-contract` 1 处
- **无需改动**：B.p172-3（phase188 全链路闭合终态）
- **起步 SHA**：`2737d47` / design 本地 only / 零 git

#### phase303 纪律 — C.3 Daemon 物理迁移（2026-04-25 / SHA `171f3dc`）

- **scope**：r27 分支 E / `cli/commands/daemon.ts` + `daemon-loop.ts` → `src/daemon/`
- **变更量**：git mv ×2 / daemon.ts 内部 9 路径 / daemon-loop.ts 内部 12 路径 / daemon-entry.ts 1 路径 / 测试 3 处
- **零逻辑变更**：纯物理迁移 / tsc 验证完备
- **N1（整理债 drift）**：`process-manager-factory.ts` 保留在 `cli/commands/`（被 cli/index、assembly 等多方消费）；daemon.ts 改为跨目录引用 `../cli/commands/process-manager-factory.js`
