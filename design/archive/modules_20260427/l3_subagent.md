# SubAgent 接口契约

**L3 执行与连接层**。一次性 agent 执行原语 —— 跑一次完整的 react loop 生命周期。**纯执行原语 / 不管外部排队、并发、崩溃恢复**（那些是 L4 任务调度方的事）。与 StepExecutor / AgentExecutor 同层 / 都是「agent 执行相关的 L3 原语」/ 跟 L4 任务调度方是独立可变职责（执行原语 vs 生命周期管理）。

**应然**（2026-04-26 修订 / 跟 modules.md ~~§16~~ §18 align）：消费 `prompt + 可选父上下文 messages + tools + timeouts + systemPrompt`；单次 `run()` 走 react loop 至 finalText 或超时/异常；不持上层资源句柄。
**实然**：`SubAgent` class + `SubAgentOptions` 24 字段含 L4 references（`taskSystem` / `contractManager` / `outboxWriter` / `agentId` / `originClawId`）—— 详 §7.A A.M5-leak（待 Stage 2 治理）。

归属：L3 执行与连接。
- **应然依赖**：LLMService（L1）、SkillSystem（L2）、Tools（L2）、调用方提供的 input + output channel
- **实然依赖**：+ FileSystem（L1）、AuditWriter（L2）、StreamLog（L2）、runReact（L3 同层）、TaskSystem（L4 / A.M5-leak）、ContractManager（L4 / A.M5-leak）、OutboxWriter（L2 Messaging）

## 从 L4 SubagentSystem 下移来源（2026-04-21）

原 L4 "SubagentSystem" 模块违反 meta-principle「执行原语 vs 生命周期管理 = 独立可变职责」（modules.md 关键决策 #5 已废止，见 `feedback_primitive_vs_lifecycle_split.md` + `feedback_default_split_not_merge.md`）。修正拆分：

- **SubAgent class**（本契约，L3 执行原语）
- spawn / dispatch / ask_motion 3 工具 + `writePendingSubagentTaskFile` 原语 → **未来 L3 tools 契约**（待建；本契约相关段 §2.d / §2.e 保留历史描述作上下文参考，不再是应然承诺）
- 任务排队 / 崩溃恢复 / 结果投递 → L4 TaskSystem（`l4_task_system.md`）

**本契约当前 scope**：§1 / §2.a-c / §3-§8 是 L3 SubAgent 执行原语的应然承诺；§2.d / §2.e + 物理位置清单中的 tools/builtins 4 文件是"相关上下文记录"。**phase229 已实装 `createSubAgent` thin proxy factory**（`src/core/subagent/index.ts:15`）；消费方 TaskSystem（L628）/ ContractManager（L1201）改调工厂，不再直接 `new SubAgent(...)`。

**关键决策 #29 影响**（2026-04-23）：spawn / dispatch / ask_motion 三工具的**业务语义归属**从 SubAgent(L3) 迁至 TaskSystem(L4)（modules.md 关键决策 #29）。理由：spawn/dispatch 的编排涉及 L1-L2 多模块工具注册与 SubAgent 构造，是 TaskSystem 的职责而非 L3 执行原语的职责。SubAgent 作为纯执行原语，只跑 react loop，不导出业务工具。**实然 drift**：spawn.ts / dispatch.ts / ask-motion.ts / _pending-task-writer.ts 物理上仍在 `src/core/tools/builtins/`，待代码实施 phase 迁移至 TaskSystem 模块目录。本契约 §2.d / §2.e 保留作历史参考，不再是应然承诺。

**phase159 粗糙期说明 + phase163 循环消除**（历史快照）：
phase159 首次登记时按"概念聚合模块"口径合并 SubAgent class + 3 工具。phase163（2026-04-20）消除 SubagentSystem ↔ TaskSystem 运行时循环：spawn / dispatch 调度路径改经 `writePendingSubagentTaskFile(fs, audit, args)` 直写 `tasks/pending/{id}.json`，不再调 `taskSystem.scheduleSubAgent`。helper `scheduleSubAgentWithTracking` 已删除，cron / daemon 切至文件直写。§5 循环消除后 phase173（2026-04-21）进一步从模块层级上重新定位：SubAgent 下移 L3，tools 归 L3 tools（独立模块待登记）。dispatch 残留 `ctx.taskSystem.addTaskResultHandler` 单条（B.p163-4 handler 文件化推后独立 phase）。

物理位置：
- `src/core/subagent/agent.ts`（SubAgent class，381 行；**本契约核心**）
- `src/core/subagent/index.ts`（17 行，re-export `SubAgent` + `SubAgentOptions` + `createSubAgent` 工厂（phase229 新增））
- `src/core/tools/builtins/spawn.ts` / `dispatch.ts` / `ask-motion.ts` / `_pending-task-writer.ts`（**未来 L3 tools 契约登记范围**；本契约 §2.d/§2.e 保留历史描述非应然承诺）

## 1. 所有权

### 归属层

**L3 执行与连接**（原 L4 SubagentSystem 下移 L3，2026-04-21）。**装配归属**：按需（由调用方实例化）。

**应然**（2026-04-26 修订 / 跟 modules.md ~~§16~~ §18 align）—— 被谁调用：
- **L4 任务调度方**：当前 TaskSystem 是唯一 caller / 应然作为 task executor 协议实现者 / 未来若新 task type 需 agent 执行也可调用

**实然** —— 被谁调用：

- **TaskSystem**：`src/core/task/system.ts:628` `executeTask` 主路径 `createSubAgent(...)` —— 本模块最大消费者（phase229 工厂切换）
- **ContractManager**：`src/core/contract/manager.ts:1201` `runLLMAcceptance` 路径 `createSubAgent(...)` —— 架构偏差（§7 B.1；phase229 工厂切换）
- **agent 工具层**：ReAct 中的 spawn / dispatch / ask_motion 由 SubAgent / Runtime agent 通过 ToolRegistry 调用
- **cron**（phase163 后）：`src/core/cron/jobs/random-dream.ts` 经 `writePendingSubagentTaskFile(opts.fs, motionAudit, args)` 直写 `tasks/pending/`，不再经 helper（B.2 已消除）
- **CLI daemon**（phase163 后）：`src/cli/commands/daemon.ts` retrospective 经 `writePendingSubagentTaskFile(motionFs, motionAudit, args)` 直写 `tasks/pending/`，不再经 helper（B.2 已消除）
- **ContractSystem（间接）**：创建 verifier / 复盘子代理走 ContractManager 的 LLM 验收路径
- **MemorySystem（间接）**：创建 dream 子代理走 cron 的 `writePendingSubagentTaskFile` 路径

实然偏离应然根源同 §0：ContractManager / cron / daemon 直接调 SubAgent 工厂 = M5 反向依赖 / 非 generic L4 task scheduler 路径；详 §7.B.1 + §7.A A.M5-leak。

### 职责（做）

**应然**（2026-04-26 修订 / 跟 modules.md ~~§16~~ §18 align）：
1. **一次性 agent 执行原语**：单次 `run()` 消费 `prompt + 可选 messages + tools + timeouts + systemPrompt`，走 ReAct 循环直至 finalText 或超时 / 异常
2. **父代理上下文快照继承**：通过 `messages` / `systemPrompt` 传递
3. **生命周期事件审计**：`turn_start` / `turn_end` / `turn_interrupted` / `turn_error` + `llm_call` / `llm_error` + `tool_result` 写到调用方提供的 output channel（stream.jsonl / audit.tsv）
4. **总超时与 idle 超时**

**实然**（含与应然不一致项）：
1. **一次性子代理执行器**：`SubAgent` class 单次 `run()` 消费一个任务，走 ReAct 循环直至 finalText 或超时 / 异常
2. **工具定义与入口**（**应然不属于 SubAgent**；归 L4 TaskSystem，详 §7.B.p230-1）：`spawnTool` / `DispatchTool` / `AskMotionTool` 三工具定义物理仍在 `src/core/tools/builtins/`，本契约 §2.d / §2.e 保留作历史描述
3. **父代理上下文快照继承**：通过 `SubAgentOptions.messages` / `originClawId` / `systemPrompt` 传递；dispatch / ask_motion 内部对 Motion 上下文做快照处理
4. **子代理生命周期审计**：SubAgent 自身写 8 类事件到 stream.jsonl 与 audit.tsv
5. ~~**scheduleSubAgentWithTracking helper**~~：**phase163 已删除**。spawn 工具与 cron / daemon 改经 `writePendingSubagentTaskFile(fs, audit, args)` 直写文件；默认值填充在各调用点本地完成。B.2 已消除（详 §7）

### 不做

- 不调度任务队列（归 TaskSystem；SubagentSystem 只提供"可被调度的执行器"）
- 不持有 / 不管理 `tasks/` 目录资源（归 TaskSystem；SubAgent 仅**写入** `tasks/results/{agentId}/`）
- 不直接调 LLM 服务抽象（通过 `runReact` + `AskMotionTool` 内部用 `llm.call`；LLM 服务归 LLMService）
- 不执行工具（通过 `ToolExecutor`；SubAgent 构造后 ctor 内 `new ToolExecutor`）
- 不维护父代理持续状态（实例一次性消费；不可复用）
- 不回传结果到父代理（归 Messaging / TaskSystem `resultHandler`）

## 2. 接口

**应然**（2026-04-26 修订 / 跟 modules.md ~~§16~~ §18 align）：构造仅接 `prompt + 可选 messages + tools + timeouts + systemPrompt + input/output channel`；不接 L4 references（`taskSystem` / `contractManager` / `outboxWriter` 等）；不持 `agentId` / `originClawId`（任务标识由调用方维护）。

**实然**：`SubAgentOptions` 24 字段含 L4 references + 任务标识字段（详 §2.b 表 + §7.A A.M5-leak 待 Stage 2 治理）。

### 2.a 行为契约四要素（SubAgent class）

- **输入**：`SubAgentOptions`（24 字段，见 §2.b；6 个必选、18 个可选）
- **输出**：`Promise<string>` —— 成功返回 `finalText` 或 `'[No output produced]'`（L337）；失败 rethrow
- **边界**：单次任务一次性消费；实例不可复用；`clawDir` 必须可写（SubAgent.run 开头 `ensureDir('tasks/results/{agentId}/')`，L179）
- **失败模式**：

  | 失败模式 | 审计事件 | 是否 rethrow |
  |---|---|---|
  | 外部 / 总超时 / idle 超时（`ToolTimeoutError`） | `turn_interrupted` | ✓ |
  | LLM / tool / 其他异常 | `turn_error` | ✓ |
  | `onStepComplete` steps.jsonl append 失败 | `monitor.error('SubAgent.onStepComplete')` | ✗（显式 non-fatal） |
  | `persistMessages` writeAtomic 失败 | `monitor.error('SubAgent.persistMessages')` | ✗（best-effort） |
  | `appendToLog` daemon.log 追加失败 | `monitor.error('SubAgent.appendToLog')` | ✗（non-fatal） |

### 2.b SubAgentOptions 24 字段

字段来源：`src/core/subagent/agent.ts:28-53`。增删须同步本表。

| # | 字段 | 类型 | 必选 | 用途 |
|---|---|---|---|---|
| 1 | `agentId` | `string` | ✓ | 任务 ID，决定 `tasks/results/{id}/` 目录 |
| 2 | `prompt` | `string` | ✓ | 主任务描述（若传 `messages` 则作为追加 user 消息） |
| 3 | `clawDir` | `string` | ✓ | 运行根目录 |
| 4 | `llm` | `LLMService` | ✓ | LLM 客户端 |
| 5 | `registry` | `ToolRegistryImpl` | ✓ | 工具注册表 |
| 6 | `fs` | `FileSystem` | ✓ | 文件系统 |
| ~~7~~ | ~~`monitor`~~ | ~~`Logger`~~ | — | ~~已废止（phase297）~~ |
| 8 | `maxSteps` | `number` | ✗ | 默认 `DEFAULT_MAX_STEPS=100` |
| 9 | `timeoutMs` | `number` | ✗ | 默认 `SUBAGENT_TIMEOUT_MS=300000` |
| 10 | `signal` | `AbortSignal` | ✗ | 外部中断 |
| 11 | `toolsForLLM` | `ToolDefinition[]` | ✗ | 覆盖 `registry.getAll()` 的 LLM 视图 |
| 12 | `idleTimeoutMs` | `number` | ✗ | LLM 静默超时阈值 |
| 13 | `onIdleTimeout` | `() => void` | ✗ | 静默超时回调（ContractManager 路径用于写 `acceptance_timeout` 事件） |
| 14 | `systemPrompt` | `string` | ✗ | 覆盖 `DEFAULT_SUBAGENT_SYSTEM_PROMPT` |
| 15 | `callerType` | `CallerType` | ✗ | 默认 `'subagent'`；决定 `callerTypeToProfile` |
| 16 | `taskSystem` | `TaskSystem` | ✗ | **phase163 后仅 dispatch 工具的 `addTaskResultHandler` 路径需要**（B.p163-4，handler 文件化推后）；spawn / dispatch 调度路径不再需要 TaskSystem 实例 |
| 17 | `outboxWriter` | `OutboxWriter` | ✗ | send 工具需要 |
| 18 | `contractManager` | `ContractManager` | ✗ | contract create / done 工具需要 |
| 19 | `skillRegistry` | `SkillRegistry` | ✗ | skill 工具需要 |
| 20 | `subagentMaxSteps` | `number` | ✗ | 透传给下一层 SubAgent |
| 21 | `messages` | `Message[]` | ✗ | 若提供则作为历史上下文，`prompt` 以 user 消息追加在其后 |
| 22 | `originClawId` | `string` | ✗ | 创建链路源头 |
| 23 | `taskStreamWriter` | `StreamLog` | **✓** | 写 `tasks/results/{id}/stream.jsonl`；phase283 改必选，显式降级用 `NoopStreamWriter` |
| 24 | `auditWriter` | `Audit` | **✓** | 写 `tasks/results/{id}/audit.tsv`；phase283 改必选 + 类型收窄为 `Audit` 接口（M#8）；显式降级用 `NoopAuditWriter` |
| 25 | `audit` | `AuditWriter` | ✗ | 模块级错误 audit（`subagent_*_failed` 3 events，phase247 新增）；与 #24 语义不同：#24 写任务结果流，#25 写 claw 级 audit.tsv |

### 2.c `run()` 方法

```ts
async run(): Promise<string>
```

- 创建 `tasks/results/{agentId}/` 目录（ensureDir）
- 初始化 timeout / idle 控制器；调 `Promise.race([runReact(...), timeoutPromise])`
- 成功路径：`turn_end` + `persistMessages` → 返回 `result.finalText`
- 失败路径：根据错误类型写 `turn_interrupted` / `turn_error`，rethrow
- finally：清理 timer，兜底 `turn_end`（仅当主路径未 set `turnEnded`）

### 2.d 工具定义

| 工具 | 形态 | name | 必填参数 | 装配期依赖 | readonly / idempotent |
|---|---|---|---|---|---|
| `spawnTool` | ToolDefinition 对象字面量 | `spawn` | `prompt` | **phase163：`ctx.fs` + `ctx.auditWriter`**（不再依赖 `ctx.taskSystem`）；经 `writePendingSubagentTaskFile` 直写 `tasks/pending/` | false / false |
| `DispatchTool` | class implements Tool | `dispatch` | `goal` | ctor 注入三 getter；**phase163：调度路径改经 `writePendingSubagentTaskFile`**；`ctx.taskSystem` 仅用于 `addTaskResultHandler`（改名 `taskHandlerHost`，B.p163-4） | false / false |
| `AskMotionTool` | class implements Tool | `ask_motion` | `question` | **不全局注册**；仅 `DispatchTool.execute` 于 mining 模式 `new AskMotionTool(...)` 并通过 `extraTools` 注入给 dispatcher；ctor 注入 `llm` / `getSystemPrompt` / `getToolsForLLM` / `motionContext` | false / false |

- `spawnTool.execute`（phase163 后）调 `writePendingSubagentTaskFile(ctx.fs, ctx.auditWriter, {...})` 直写 `tasks/pending/{id}.json` + 返回 `taskId`；TaskSystem 经 FileWatcher 异步拾起
- `DispatchTool.execute` 支持 `mining`（默认）/ `describing` 双模式；注册一次性 `taskHandlerHost.addTaskResultHandler` 解析子代理结果中的 `[CONTRACT_DONE]{...}[/CONTRACT_DONE]` 块，写 `clawspace/pending-retrospective/by-contract/{contractId}.json`；phase163 后 dispatcher 子代理创建经 `writePendingSubagentTaskFile` 直写文件（非 `scheduleSubAgent`）
- `AskMotionTool.execute` **不创建子代理** —— 直接调 `llm.call({ system, messages: [...motionContext, ...cloneHistory], tools })`；内部维护 `cloneHistory: Message[]` 多轮累积；返回文本即 answer

### 2.e `writePendingSubagentTaskFile`（phase163 新增；替代旧 `scheduleSubAgentWithTracking` helper）

```ts
// src/core/tools/builtins/_pending-task-writer.ts
export async function writePendingSubagentTaskFile(
  fs: FileSystem,
  audit: AuditWriter | undefined,
  args: Omit<SubAgentTask, 'id' | 'createdAt'>,
): Promise<string>
```

内部：`randomUUID()` → 构造 `SubAgentTask` → `fs.writeAtomic('tasks/pending/${id}.json', JSON.stringify(task, null, 2))` → `audit?.write('task_scheduled', id, 'kind=subagent', 'parent=${parentClawId}')` → 返回 `taskId`。**类型 import 全部 type-only**（FileSystem / AuditWriter / SubAgentTask），不构成运行时模块循环。

调用方：`spawnTool.execute`、`DispatchTool.execute`（dispatcher 嵌套）、`cron/jobs/random-dream.ts`、`cli/commands/daemon.ts`（retrospective）。默认值填充（TOOL_PROFILES / 超时 / maxSteps / idleTimeoutMs）由各调用点本地完成——与旧 helper 形态的主要差异。

## 3. 审计事件清单

SubAgent 自身在 `src/core/subagent/agent.ts` 产生以下事件。事件同时写入 `taskStreamWriter`（stream.jsonl）与 `auditWriter`（audit.tsv）。两字段 phase283 起为必选；未提供时注入 `NoopStreamWriter` / `NoopAuditWriter` 显式降级（不再静默丢失）。

| 事件 | agent.ts 行 | 载荷（audit.tsv 字面参数） | 备注 |
|---|---|---|---|
| `turn_start` | L150-151 | 无额外参数 | 在 `try` 外写，保证 catch 配对 |
| `turn_end`（正常） | L332-333 | 无额外参数 | `runReact` 成功后 |
| `turn_end`（finally 兜底） | L359-360 | 无额外参数 | 仅当主路径未 set `turnEnded` |
| `turn_interrupted` | L344-345 | `reason=system`（audit）；stream 侧 `message=Timeout after {ms}ms` | 捕获 `ToolTimeoutError` |
| `turn_error` | L347-348 | `err={message}` | 捕获其他异常；rethrow |
| `llm_call` | L267 经 `onLLMResult` | `{model} in={tokens} out={tokens} ms={latency}` | 仅 audit.tsv |
| `llm_error` | L265 经 `onLLMResult` | `{model} err={error} ms={latency}` | 仅 audit.tsv |
| `tool_result` | L239-243 经 `streamCallbacks.onToolResult` | `{name} {toolUseId} {ok|err} summary={oneLine(content)}` | audit.tsv + stream.jsonl |
| `subagent_step_complete_failed` | L298-302（phase247 新增）| `agentId=<id>` `error=<msg>` | `onStepComplete` callback 内 catch；`this.audit?.write()`（optional，non-fatal）|
| `subagent_persist_failed` | L330-334（phase247 新增）| `agentId=<id>` `error=<msg>` | `persistMessages` catch；同上 |
| `subagent_log_append_failed` | L379-383（phase247 新增）| `agentId=<id>` `error=<msg>` | `appendToLog` catch；同上 |

**注（phase247 更新）**：三处 non-fatal catch 路径（`onStepComplete` / `persistMessages` / `appendToLog`）已由 `monitor.error` 迁移至 `this.audit?.write()`（phase247，`57f51be`）。`audit` 为 optional field（见 §2.b #25），未注入时三事件 silent drop（与 A.1 writer 缺席同型，non-fatal 设计内）。

**A.1 清零（phase283）**：`taskStreamWriter` / `auditWriter` 已改必选；`?.write` 短路全部消除；未提供时装配层注入 Noop 显式降级。

## 4. 上游依赖

**应然**（2026-04-26 修订 / 跟 modules.md ~~§16~~ §18 align）：~~仅 L1/L3 同层~~ → **L1/L2 下层** —— `LLMService`（L1）+ `SkillSystem`（~~L2/L3 内部同层~~ → **L2**）+ `Tools`（~~L3 内部同层~~ → **L2**）+ 调用方提供的 `input + output channel`（无自有资源 / 不持上层资源句柄）。（Tools/SkillSystem r31 sharpening 后从 L3→L2 / SubAgent(L3) 依赖方向为 M5 合规下向）

**实然**（含 L4 反向依赖 leak / 详 §7.A A.M5-leak）：

### 模块 / 基础设施依赖（12 项）

| 项 | 来源字段 | 用途 |
|---|---|---|
| `FileSystem` | `fs` | `ensureDir` / `append` / `writeAtomic`；tasks/results/{id}/ 目录与日志 |
| `LLMService` | `llm` | 经 `runReact` 驱动 ReAct 循环；`AskMotionTool.execute` 直接 `llm.call` |
| `ToolRegistry`（`ToolRegistryImpl`） | `registry` | LLM 工具视图 + executor 消费 |
| `ToolExecutor` | 构造期 `new ToolExecutor(...)`（agent.ts:156） | 工具执行 |
| `runReact`（`src/core/react/loop.ts`） | 直接 import | ReAct 循环实现 |
| `AuditWriter` | `auditWriter` | `tasks/results/{id}/audit.tsv` |
| `StreamLog` | `taskStreamWriter` | `tasks/results/{id}/stream.jsonl` |

| `TaskSystem` | `taskSystem` | **phase163 后收窄**：仅 dispatch 工具 `addTaskResultHandler` 注册需要（B.p163-4）；spawn / dispatch 调度路径 / cron / daemon 均已改经 `writePendingSubagentTaskFile` 直写文件，不再持 TaskSystem 实例（A.p163-消除，见 l4_task_system.md §7） |
| `FileSystem`（phase163 调度路径） | `ctx.fs` | `writePendingSubagentTaskFile` 写 `tasks/pending/{id}.json`；spawn / dispatch / cron / daemon 均消费 |
| `AuditWriter`（phase163 调度路径） | `ctx.auditWriter` / 本地构造 | `writePendingSubagentTaskFile` 写 `task_scheduled` audit 事件 |
| `SkillRegistry` | `skillRegistry` | skill 工具 |
| `ContractManager` | `contractManager` | contract 工具 |
| `OutboxWriter` | `outboxWriter` | send 工具 |

### 常量依赖（见 §6）

`DEFAULT_MAX_STEPS` / `SUBAGENT_TIMEOUT_MS` / `SPAWN_DEFAULT_TIMEOUT_S` / `DEFAULT_LLM_IDLE_TIMEOUT_MS`。

## 5. 不可消除耦合

**消除路径首选 port pattern**（feedback_module_contract_structure r40.2）：消费方 own port + 默认实现 + assembly 注入 / phase337+335+340 三 phase 实证。SubAgent 当前耦合（TaskSystem 工厂调用 + ContractManager 反向 / 工具层下层依赖）评估时优先考虑 port 抽象。

### ~~SubagentSystem ↔ TaskSystem 循环~~（phase163 已消除）

**phase159 登记**（2026-04-11）：方向 A = SubagentSystem 经 `taskSystem.scheduleSubAgent` 下单；方向 B = TaskSystem.executeTask `new SubAgent({...})`。工程形态靠 `import type` 豁免编译期循环，但**运行期双向调用**的本质未被消除——phase159 §5 以"type-only 编译单向"诡辩合规化。

**phase163 升级 A 类 + 消除**（2026-04-20）：用户收紧原则 #5 判据："通过 import type 规避或 callback 注入不算合规；运行时业务语义循环 = A 类违反"。

消除措施：
- 方向 A 消除：spawn / dispatch / cron / daemon 调度路径改经 `writePendingSubagentTaskFile(fs, audit, args)` 直写 `tasks/pending/{id}.json`；helper `scheduleSubAgentWithTracking` 删除
- 方向 B 不动：TaskSystem.executeTask `new SubAgent({...})` 仍是 TaskSystem → SubagentSystem 正当向下依赖（非循环）
- TaskSystem 经 FileWatcher 订阅 pending/ 异步拾起；`_ingestPendingFile` 读文件 → push pendingQueue → `_dispatch`
- 运行期真单向依赖，告别 "import type 规避"诡辩

残留 B.p163-4（详 l4_task_system.md §7）：dispatch 工具 `ctx.taskSystem.addTaskResultHandler` 注册——callback 订阅而非调度业务语义，handler 文件化推后独立 phase。

详 `l4_task_system.md` §7 A.p163-消除条目。

### SubagentSystem ↔ ContractManager 反向依赖

**应然**（2026-04-26 修订）：本耦合**应消除** —— SubAgent 应然不持 L4 references；ContractManager 应经 L4 TaskSystem 走 task executor 协议（详 §7.A A.M5-leak）。

**实然**：
- `src/core/subagent/agent.ts:20` `import type { ContractManager }`；运行期透传给 ToolExecutor 供 contract create / done 工具消费
- 反向：`src/core/contract/manager.ts:1179` `new SubAgent(...)`（B.1 双实例化）形成第二环
- **治理**：Stage 2 内部 refactor 跟 A.M5-leak 同消化；本 phase 仅登记

### SubagentSystem → 工具层 `tools/builtins/` 的非纯下层依赖

**应然**（2026-04-26 修订 / KD#29）：三工具业务语义归 TaskSystem(L4) / SubAgent(L3) 不导出任何业务工具 / 物理位置应迁至 TaskSystem 模块目录。

**实然**：spawn.ts / dispatch.ts / ask-motion.ts / _pending-task-writer.ts 物理仍在 `src/core/tools/builtins/`（L2 Tools 层内部）/ 本契约 §2.d/§2.e 保留作历史参考非应然承诺。

- spawn / dispatch / ask_motion 三工具物理在 `src/core/tools/builtins/`，但业务语义归本模块
- 本模块 "导出"这三工具但不 re-export 自 `src/core/subagent/`（§7 B.3 登记）
- **治理**：细化期评估是否在 `src/core/subagent/index.ts` re-export 三工具以形成逻辑门面

## 6. 配置常量归属

| 常量 | 值 | 位置 | 读取方 |
|---|---|---|---|
| `DEFAULT_MAX_STEPS` | 100 | `src/constants.ts:64` | SubAgent ctor 默认 / spawnTool / DispatchTool |
| `SUBAGENT_TIMEOUT_MS` | 300000 | `src/constants.ts:67` | SubAgent ctor `timeoutMs` 默认 |
| `SPAWN_DEFAULT_TIMEOUT_S` | 300 | `src/constants.ts:70` | `scheduleSubAgentWithTracking` 默认 |
| `DEFAULT_LLM_IDLE_TIMEOUT_MS` | 60000 | `src/constants.ts:76` | SubAgent / spawnTool / DispatchTool 默认 |

四常量**语义归属 SubagentSystem**（"子代理运行时预算"）；物理集中在 `src/constants.ts`。

## 7. 与现状的差距

### A 类违规（phase283 全清零）

#### A.M5-leak — SubAgentOptions 含 L4 字段 / 反向依赖违反（2026-04-26 新增 / 待 Stage 2 治理）

**触发**：modules.md 应然层 SubAgent 重新 framing（L3 纯执行原语 / TaskSystem 是其调用方之一 / generic task type 应然）+ M5 严格执行「依赖单向 / 底层不预设上层」。

**违反**：`SubAgentOptions` 当前含以下 L4 任务调度方相关字段：
- `taskSystem?: TaskSystem`（反向依赖 L4）
- `contractManager?: ContractManager`（反向依赖 L4）
- `outboxWriter?: OutboxWriter`（间接 L4 任务结果资源）
- `agentId` / `originClawId`（任务标识 / 调用方语义）

**根因**：历史上 TaskSystem 是 generic async queue / SubAgent 跟 TaskSystem 紧绑设计 / 当时 SubAgent 的 callsite 只 TaskSystem 内部 / 反向依赖被掩盖。当前 framing 调清后 leak 暴露。

**修订方向**（待 Stage 2 内部 refactor）：
- SubAgent 构造期不接收 L4 references
- 调用方（TaskSystem 等）通过 input + output channel 跟 SubAgent 通信（task setup / 结果回传等代码推回 TaskSystem 内部）
- SubAgent 真成为 L3 纯执行原语 / 不持上层 context

**关联**：
- modules.md ~~§16~~ §18 SubAgent + ~~§19~~ §20 TaskSystem 应然 framing 修订
- Module Logic Principle M5「依赖单向 / 禁止双向 / 循环 / 底层不预设上层」
- B.1 双实例化路径登记（同一历史根源）



#### A.1 可选 writer 未注入时审计事件静默丢失 ✓ **phase283 清零**

- **历史**：`SubAgentOptions.taskStreamWriter` / `auditWriter` 为 optional；未注入时 `sw?.write(...)` / `this.auditWriter?.write(...)` optional chaining 短路，8 类事件全部静默丢失
- **清零方案（α）**（phase283）：
  - `taskStreamWriter: StreamLog`、`auditWriter: Audit` 改必选（M#9 编译器强制）
  - 装配层未提供时注入 `NoopStreamWriter` / `NoopAuditWriter` 显式降级（`contract/manager.ts` verifier SubAgent）
  - `agent.ts` 内所有 `?.write(...)` 短路全部消除；`streamCallbacks` ternary 化简为无条件对象
  - 新建 `src/core/subagent/noop-writers.ts` 提供两个 `implements` 声明的 Noop 类（tsc 接口校验）
  - 联动：`auditWriter` 类型从 `AuditWriter` 类收窄为 `Audit` 接口（M#8）；`context.ts` / `executor.ts` / `_pending-task-writer.ts` 同步

#### A.2 相邻但非本契约直辖

- `src/core/tools/builtins/dispatch.ts:172` 存在 `console.warn('[dispatch] dialogMessages not provided or empty ...')` —— 归工具层契约治理，不入本契约 A 类

#### A 类排查结论

- SubAgent class 本体三处 `.catch` 均为**显式设计的 non-fatal 路径**（`onStepComplete` / `persistMessages` / `appendToLog`），**phase247 已迁移至 `this.audit?.write()`**，**不构成 A 类**
- **§7.A 全清零**（phase283）：A.1 唯一 A 类已消化

### B 类偏差（本 phase 仅登记）

**type 标签**（feedback_module_contract_structure r40.3）：B 项必标 `drift` vs `design-gap` 二分。
- **drift type**：契约说应 X / 实然 Y / 修法明确（推 §7.A 必修）
- **design-gap type**：应然 silent / 实然有 / 修法不明 / 必推独立 design phase 评估（不 mechanical）

> 现有 B.1 / B.2 / B.3 / B.p230-1 / B.p248-1 / B.p201-* 历史登记 type 分类待 r43+ 应然同步 phase 批量补标。已知：
> - B.p201-drift = drift（行号 drift / 代码移位）
> - A.M5-leak = drift（M5 反向依赖违反 / 修法明确）
> - B.p230-1 = drift（KD#29 工具归属 / phase344 部分实施 / 物理迁移待）

#### B.1 SubAgent 双实例化路径

- **现状**：`new SubAgent` 全仓仅 2 处：
  1. `src/core/task/system.ts:573`（TaskSystem.executeTask，subagent 任务主路径）
  2. `src/core/contract/manager.ts:1179`（ContractManager.runLLMAcceptance，LLM 验收路径）
- **应然**：所有 SubAgent 实例化应经 TaskSystem 统一管理（结果持久化、生命周期追踪、崩溃恢复语义统一）
- **偏差理由**：LLM 验收需同步拿 `finalText` 判定结果；当前 TaskSystem 调度形态仅支持异步结果（inbox / resultHandler），ContractManager 若走 TaskSystem 需新增"同步执行接口"或"结果回调"
- **治理路径**：细化期增 TaskSystem 同步执行接口，或 ContractManager 改走 TaskSystem + 结果回调

#### ~~B.2 `scheduleSubAgentWithTracking` 跨层调用~~（phase163 已消除，2026-04-20）

**原登记**（phase159）：helper 被 cron / daemon 跨层 import，工具层 helper 不应被工具层外直接消费。

**phase163 消除措施**（Step 5）：
- `scheduleSubAgentWithTracking` helper 已**删除**（`src/core/tools/builtins/spawn.ts` 原 L19-48）
- cron `random-dream.ts` 改经 `writePendingSubagentTaskFile(opts.fs, motionAudit, args)` 直写文件；调用点显式填 `TOOL_PROFILES['dream'] / 3600 / 200 / DEFAULT_LLM_IDLE_TIMEOUT_MS` 等默认值
- daemon retrospective 同款改造；本地构造 `motionFs = new NodeFileSystem(...)` + `motionAudit = new AuditWriter(motionFs, ...)`
- 消除后验证：`grep -rn "scheduleSubAgentWithTracking" src/` 零命中
- cron / daemon 作为 L3+ 系统层调 fs / audit 是合规向下依赖（非循环）；"工具层 helper 跨层 import"的违规形态根除

#### B.3 物理位置分散，无统一 index

- **现状**：
  - `src/core/subagent/index.ts` 仅 5 行 re-export `SubAgent` class + `SubAgentOptions` 类型
  - 三工具散落 `src/core/tools/builtins/`
  - `scheduleSubAgentWithTracking` 在 `src/core/tools/builtins/spawn.ts`
- **应然**：概念聚合模块应有统一门面（对外接口物理收拢）
- **偏差理由**：三工具作为 ToolDefinition 有工具层归属上的合理性（ToolRegistry 注册、profile 过滤、内置工具集中）；强行收拢会破坏工具层分类
- **治理路径**：细化期评估是否在 `src/core/subagent/index.ts` re-export 三工具 + helper 形成**逻辑门面**（不搬物理位置）

#### B.p230-1 — spawn / dispatch / ask_motion 工具归属变更（关键决策 #29，2026-04-23）

- **应然**：三工具业务语义归属 TaskSystem(L4)（modules.md 关键决策 #29）
- **现状**：
  - `spawn.ts` / `dispatch.ts` / `ask-motion.ts` / `_pending-task-writer.ts` 物理仍在 `src/core/tools/builtins/`
  - 本契约 §2.d / §2.e 仍记录三工具的接口描述（历史参考，非应然承诺）
  - §1 职责(做) 第 2 条"工具定义与入口"应移出
  - §4 依赖中 `TaskSystem` 字段说明需更新
- **违反原则**：M1「独立可变职责」—— spawn/dispatch 编排是 TaskSystem 职责不应散落在 L3
- **治理路径**：代码实施 phase 将三工具迁移至 TaskSystem 模块目录

#### B.p248-1 — SubAgent `run()` 构造 `new ToolExecutor` 未传 `auditWriter`（phase248 识别 / phase252 消化）

- **实然**（phase248 识别）：`SubAgent.run()`（agent.ts L161）`new ToolExecutor({...})` 未传 `auditWriter`；`ToolExecutorOptions` 无 `auditWriter` 字段；`ToolExecutor.getExecContext()` 未将 `auditWriter` 注入 `ExecContextImpl`。导致 SubAgent 路径下 dispatch / status 工具拿到的 `ctx.auditWriter === undefined`，audit 事件静默丢失。
- **应然**：`ExecContext.auditWriter` 在所有路径（主循环 + SubAgent）均有值（已注入时）。
- **状态**：**phase252 已消化**（`executor.ts` `ToolExecutorOptions` +auditWriter / `ToolExecutor` 私有字段 + `getExecContext()` 注入 / `agent.ts` SubAgent 透传；联动 l3_tools.md B.4）

### C 类违规（本 phase 按原则逐条判定 / 旧粗糙期 7 项 / **完整 32 条原则对照见 §9.C / 本节供溯源不删**）

> **节名澄清**（2026-04-27 r42 D 结构合规修）：本节标 "C 类违规" 实是「原则部分对照」/ phase201 backfill 后真 §7.C 32 条枚举落在 **§9.C** 物理位置（APPEND 模板 §9 编号 / phase194 hardening）/ 本节保留旧 7 项做溯源 / 不再扩展。

| 原则 | 判定 | 依据 |
|---|---|---|
| #1 独立可变职责 | 合规 | 子代理执行器、三工具定义、上下文快照继承三类变更源与 TaskSystem（队列调度）、ContractSystem（契约状态机）、MemorySystem（记忆整合）独立 |
| #2 业务语义归属 | 合规 | "创建一次性子代理" / "向父代理请教" / "dispatch 下单" 三语义统一由本模块发起 |
| #3 资源归属 | 合规 | `tasks/` 归 TaskSystem；SubAgent 仅**写入** `tasks/results/{id}/`，不**拥有** |
| #5 底层不预设上层 | 合规 | 凭 §5 `import type { TaskSystem }` 的单向编译期依赖 |
| #7 耦合界面稳定 | 本 phase 不改代码 | 界面不动 |
| #8 耦合界面最小 | 合规 | 对外仅 `SubAgent` class + 3 工具 + `scheduleSubAgentWithTracking` helper |
| #11 边界不对停下 | 默认口径三条登记 | 归属口径落 §0 概念聚合；helper 归属落 §7 B.2；统一 index 落 §7 B.3 |

### §7.drift — 应然 framing drift（phase324 pilot 发现 / 2026-04-26）

| # | 位置 | drift 描述 | 修正 |
|---|---|---|---|
| D1 | §head / §1 / §2 / §4 全文 5 处 | "modules.md §16" 引用 / SubAgent 实为 §18（FileTool §14 + ShellTool §15 插入后移位）| ~~§16~~ → §18（replace_all / 已执行）|
| D2 | §4 应然依赖 | "仅 L1/L3 同层 / SkillSystem(L2/L3) / Tools(L3 同层)" / r31 sharpening 后 Tools→L2 / SkillSystem 明确 L2 / SubAgent(L3) 依赖方向为 M5 合规下向 | 修正为 "L1/L2 下层"（已执行）|
| D3 | modules.md §18 SubAgent 条目 | "依赖：LLMService、SkillSystem、Tools（L3 内部同层）" / 但 modules.md 层定义三者分属 L1/L2/L2 | **非 scope（modules.md drift）/ 登记待 D 或 modules.md 专项 phase** |
| D4 | §5 工具层依赖 section | 缺应然/实然 split / KD#29 后工具归 TaskSystem(L4) / 应然已变更 | 补 split annotation（已执行）|

**framing 盲点**：(a) per-module 依赖注 "（L3 内部同层）" 粒度不足——同一注涵盖 L1/L2/L2 三模块；(b) § numbering 无稳定机制——新增模块导致全部后移。

## 8. 测试覆盖

### 现有（`tests/core/subagent.test.ts`，169 行）

| 覆盖主题 | 锚行 | 状态 |
|---|---|---|
| `onStepComplete` steps.jsonl append 失败 → audit 记录 + run 仍完成 | L99 it | ✓ |
| `onStepComplete` 失败不 rethrow、步数继续 | L129 it | ✓ |
| 成功路径 `timeoutController.abort()` 清理（防泄漏） | L153 it | ✓ |

### 未覆盖面（登记，本 phase 不补测）

- `turn_start` / `turn_end` / `turn_interrupted` / `turn_error` 载荷断言
- `appendToLog` / `persistMessages` 静默失败的 audit 调用断言
- `messages` 继承分支（agent.ts:170-176）
- `idleTimeout` 触发 `onIdleTimeout`
- `spawnTool.execute` 除 messages 校验外的全路径（当前 `tests/core/builtins.test.ts:942-953` 仅触碰 messages 校验分支）
- `DispatchTool.execute` 全路径（mining / describing 双模式、`[CONTRACT_DONE]` 解析、`addTaskResultHandler` 注册与注销）
- `AskMotionTool.execute` 全路径（cloneHistory 累积、文本过滤、LLM 失败回滚）

治理路径：细化期为三工具补独立单测文件。

## 9. §7 四子节索引 + phase201 backfill

本节是 phase201 对既有 `## 7. 与现状的差距`（A/B/C 类）的 §7 四子节索引 + §7.C 32 条全扫补齐 + Path #1 drift 核登记 + §7.Phase 执行纪律登记。**保留既有 §7 不解构**（phase187 APPEND 模式 / phase195 "§9 物理编号 APPEND" 变种第 2 次实践）。

### 9.A ↔ §7.A 映射

既有 "§7.A 类违规（本 phase 不修，登记）" 已登 1 条（A.1 + A.2 非本契约直辖）。**phase201 实测复核**：

- `grep "console\." src/core/subagent/` → **0 命中**（agent.ts 382 + index.ts 5 = 387 行 2 文件）
- audit 写位点 2 处：`agent.ts:266` `llm_error` / `agent.ts:268` `llm_call`（via `onLLMResult` 回调）；完整 8 类事件通过 streamCallbacks / auditWriter / sw 分发（§3 表详登）
- §A.1（writer optional → 8 类事件 `?.write(...)` 短路静默丢失）→ **phase283 清零**（方案 α：改必选 + Noop 显式降级）
- §A.2（`dispatch.ts:172` `console.warn`）→ **非本契约直辖**（归 L3 Tools 契约 / r5 分支 D phase199 scope）

**§7.A phase283 全清零**（A.1 消化 / A.2 非本契约 scope）。

### 9.B ↔ §7.B 映射

既有 "§7.B 类（本 phase 仅登记）" 已登 3 条：
1. B.1 SubAgent 双实例化路径（TaskSystem + ContractManager）
2. B.2 `scheduleSubAgentWithTracking` 跨层调用 → **phase163 已消除**
3. B.3 物理位置分散 / 无统一 index

**phase201 新增 2 条**：

#### B.p201-1 — `createSubAgent` 工厂仍未实装（粗糙期注记至 phase201 未落）✅ **phase229 已消化**

- **现状（phase201）**：契约 §0（L13）注记"粗糙期，未来可加 `createSubAgent`"；`grep -rn "createSubAgent" src/` → **0 命中**（phase0 至 phase201，跨 100+ phase 未实装）
- **消化（phase229）**：`src/core/subagent/index.ts` 新增 `createSubAgent` thin proxy（+4 行）；TaskSystem L628 + ContractManager L1201 改调工厂；D.1 批 4 进度 7/10 → 8/10；D.2 阻塞解除
- **对比组**：
  - `createSkillRegistry`（phase169 / L2 SkillSystem） ✓
  - `createCronRunner`（phase170 / L5 Cron） ✓
  - `createSessionManager`（phase148 / L2 SessionStore） ✓
  - `createInboxReader` / `createOutboxWriter`（phase148 / L2 Messaging） ✓
  - `createContractManager`（phase160 / L4 ContractSystem） ✓
  - `createSubAgent`（phase229 实装） ✓
- **owner**：phase159 登记 / phase201 复核 / phase229 消化

#### B.p201-drift — 契约行号 drift（Path #1 drift 核首次应用）

- **drift 清单**（phase201 Step 1 grep 佐证）：

  | 契约位置 | 契约声称 | grep 实然 | 偏差 |
  |---|---|---|---|
  | §1 / §7.B.1 `task/system.ts:573` | L573 executeTask 主路径 | `grep "new SubAgent(" src/` → **L628** | +55 行 |
  | §1 / §7.B.1 `contract/manager.ts:1179` | L1179 runLLMAcceptance | **L1201** | +22 行 |
  | §0 物理位置 `agent.ts` 381 行 | 381 | `wc -l` → **382** | +1 行 |

- **违反原则**：Path #1 契约↔实然 drift；**行号信息 readability 代价**（新读者按行号追代码会 miss）
- **为何登记 B 类**：
  - 行号 drift 不影响行为契约正确性（§7.B.1 条目 "2 处 new SubAgent" 数量一致）
  - 就地修等同"契约基于当前 git HEAD 快照维护"—— 与现实契约活文档特性冲突（代码每 commit 都可能改 line number，契约按 commit 修不现实）
  - 登记为 drift 警示未来读者：**契约行号是概数，以 grep 实然为准**
- **修复方向（候选 α/β/γ）**：
  - α：**推迟独立 drift 修订 phase**（phase196 模板）—— 批量扫全契约 drift 后集中修
  - β：**改契约引用方式**：用方法/函数名 + grep 指令代替行号（如 `new SubAgent` in `executeTask` / `runLLMAcceptance`）；rename 时契约仍准确
  - γ：**取消行号引用**：只保留语义描述，行号由读者 grep 自行
- **owner**：phase159/163 行号写入 / phase201 drift 识别
- **计划 phase**：候选 β（改引用方式）最优 —— r6+ 契约工程整理期统一
- **升档条件**：若行号 drift 导致"误读误判"事故（如 phase 计划按错行号 scope） → 升格 7.A

### 9.C §7.C 原则对照（32 条，phase201 补全）

既有 "§7.C 类违规（本 phase 按原则逐条判定）" 仅 7 行判定表（非 phase157 升格后 32 条全扫形态）。phase201 补 32 条（Module Logic 11 + Design 11 / #1 展 4 面 + Philosophy 4 + Path 6）。深度按需。

#### Module Logic Principles（11 条）

- **M1 独立可变职责**：合规。SubAgent 职责 = "一次性 agent 执行原语"；与 TaskSystem（队列调度）+ ContractSystem（契约状态机）+ MemorySystem（记忆整合）独立可变 —— 既有 §7.C #1 已判定
- **M2 业务语义归属**：合规。"创建子代理 / 向父代理请教 / dispatch 下单"三语义由本模块发起；既有判定 ✓
- **M3 资源归属**：合规。`tasks/results/{agentId}/` 归 SubAgent 写入但不拥有；`tasks/` 整体归 TaskSystem（L4）；既有判定 ✓
- **M4 持久化**：合规。`stream.jsonl` + `audit.tsv` + `steps.jsonl` 持久化子代理执行轨迹（持久化一切 + 事后可审计）
- **M5 依赖单向**：合规。`subagent → foundation/fs + foundation/llm + core/react + core/tools/* + core/session-store（间接）`；无反向（phase163 已消除 ↔ TaskSystem 循环）
- **M6 依赖结构稳定**：合规。`SubAgent` class + `SubAgentOptions` interface 自 phase159 稳定；phase163 仅消除 `scheduleSubAgentWithTracking` helper 是非 breaking 改进
- **M7 耦合界面稳定**：✓（`B.p201-1` phase229 已消化 —— `createSubAgent` thin proxy 工厂实装 + 2 消费方切换；装配模式与同层统一）
- **M8 耦合界面最小**：**灰度**。对外 `SubAgent` class（24 字段 options）+ 3 工具（spawn/dispatch/ask_motion）+ `writePendingSubagentTaskFile` helper + 5 默认常量 —— 界面本身合理（执行原语 + 工具组 + 调度 helper 三组独立）；但 `SubAgentOptions` 24 字段超 8 阈值（参 Daemon §7.A5 phase185 拆 4 组模式）—— 候选未来 §7.A 升格条件（若字段增至 28+）
- **M9 显式表达编译器可检**：合规。`SubAgentOptions` interface 强类型；`SubAgentTask` / `ToolTask` 等 union type；`ToolTimeoutError` 命名 class 区分超时类型
- **M10 不合理停下**：合规。`turn_start` 在 `try` 外写保证 catch 配对（§3 注）；`.catch` 走 `audit?.write` non-fatal（§2.a 失败模式表登记）
- **M11 边界不对停下**：合规。LLM/tool 异常 rethrow；超时 rethrow；non-fatal（onStepComplete / persistMessages / appendToLog）走 audit 不 rethrow —— 三层分明

#### Design Principles（11 条，#1 展 4 面）

- **D1a 信息不丢失**：**合规**（phase283 清零：writer 改必选 + Noop 显式降级，8 类事件不再静默丢失）
- **D1b 状态可观察**：合规。`turn_start` / `turn_end` / `turn_interrupted` / `turn_error` + `llm_call` / `llm_error` + `tool_result` 8 事件覆盖子代理完整生命周期；`stream.jsonl` 提供 delta 粒度
- **D1c 中断可恢复**：合规（间接）。SubAgent 自身单次一次性消费不恢复；任务恢复归 L4 TaskSystem 通过 `tasks/pending/` → `tasks/running/` → `tasks/results/` 目录状态重建；SubAgent 只保证其 `tasks/results/{id}/` 写入原子 + `persistMessages` writeAtomic 兜底
- **D1d 事后可审计**：**合规**（phase283 清零：writer 必选保证全链可审）
- **D2 不得丢弃/静默**：**合规**（phase283 清零：A.1 消化；3 个 .catch non-fatal 走 audit 合规）
- **D3 用户可观察**：合规。`stream.jsonl` 可被上层 stream consumer 实时查看；audit 事件可聚合
- **D4 LLM 调用恢复**：合规。`onLLMResult` 回调区分 `llm_call` / `llm_error`；`ToolTimeoutError` 区分外部/总/idle 超时；上层 ContractManager 验收路径通过 `onIdleTimeout` 回调写 `acceptance_timeout` 事件
- **D5 日志重建**：合规。3 层日志（stream.jsonl delta / audit.tsv 事件 / steps.jsonl 步数）+ `messages` persistMessages writeAtomic → 进程重启可从目录重建完整子代理执行轨迹
- **D6a 决策主体**：合规（子代理层面）。子代理本身是"执行原语"，决策权在父代理（通过 prompt / tools / systemPrompt 传递）；SubAgent 不自主决策任务方向
- **D6b 子代理不阻塞**：**核心落实者**。SubAgent 是"子代理不阻塞父代理"的实现载体 —— 父代理通过 spawn/dispatch 下单后继续；结果经 TaskSystem `resultHandler` 或 inbox 异步回传
- **D7 系统可信路径**：合规（间接）。`clawDir` 由调用方注入，约定在 WRITABLE_PATHS 内；SubAgent 不自行跨路径
- **D8 事件驱动**：合规。SubAgent 经 `runReact` 消费 LLM 工具调用事件；父代理通过 ToolRegistry 触发工具 → 工具内 `new SubAgent(...)` → 结果回传 —— 事件驱动链
- **D9 多 claw 不隔绝**：合规（间接）。SubAgent 通过 `AskMotionTool` 打通父代理 ↔ Motion 分身上下文；通过 `spawnTool` / `DispatchTool` 跨 claw 创建子代理
- **D10 motion 特殊**：合规。`AskMotionTool` + `motionContext` 注入机制显式处理 Motion 分身独有的"快照上下文"
- **D11 CLI 唯一对外**：无关（L3 执行原语内部组件；CLI 通过 daemon / claw 命令间接触发）

#### Philosophy（4 条）

- **P1 上下文工程**：**核心落实者**。SubAgent 通过 `messages` + `prompt` + `systemPrompt` + `callerType` 四维传递父代理上下文快照 —— 子代理"继承父代理所在上下文窗口"的物理实现
- **P2 多 agent 复用**：合规。SubAgent 单实现服务全部 claw / motion 场景；`callerType` 决定 profile 支持多角色
- **P3 Agent 即目录 / 对话即状态**：合规。`tasks/results/{agentId}/` 目录持久化子代理状态；`messages` 对话历史经 persistMessages writeAtomic
- **P4 简单优先 / 持久化为主**：合规。目录 + 文件（非 DB）；ReAct 循环（非复杂 planner）；timeout race（非复杂调度）

#### Path Principles（6 条）

- **Path #1 规划基于规划时刻事实**：**部分违反**（`B.p201-drift` 契约行号 drift 登记 —— Path #1 drift 核模板第 4 次触发）；补救措施 = 本 phase Step 1 drift 清单登记；修复方向 = 候选 β 改引用方式
- **Path #2 差距显式登记**：✓ §7.A 1 条（A.1）+ §7.B 3 既有 + phase201 补 2 条（`B.p201-1` + `B.p201-drift`）
- **Path #3 语义一致最小变更单元**：✓ 单一意图 = §9 节 APPEND（既有 §7 不改）
- **Path #4 可回滚 + 破坏性论证**：✓ design 本地 only / 无破坏性 / revert = 删 §9 节
- **Path #5 完成后复盘**：phase201 Step 3 产出
- **Path #6 冲突立即中断**：未触发（r5 分支 A-E 零文件重叠）

### 9.D 关键决策映射表（modules.md 迁移）

从 `design/modules.md` §关键设计决策章节迁移（2026-04-26 主会话；后续清理阶段重构）。原 KD 编号保留供对账。

- **KD#5（原 modules.md）~~SubagentSystem 合并 TaskRunner~~ 【2026-04-21 废止】**：违反 meta-principle「执行原语 vs 生命周期管理 = 独立可变职责」。修正：SubAgent class 下移 L3（与 StepExecutor / AgentExecutor 同层），L4 保留 TaskSystem + ContractSystem。契约迁移详情 `modules/l3_subagent.md`；教训 `feedback_primitive_vs_lifecycle_split.md` + `feedback_default_split_not_merge.md`

---

### 9.Phase 执行纪律

#### phase201 纪律 — L3 SubAgent backfill（2026-04-22，design 本地 only）

- **scope**：既有 `## 7. 与现状的差距` 含 A/B/C 类但 §7.C 仅 7 行判定表（phase157 升格前形态）；phase187 APPEND 模式 / phase195 "§9 物理编号 APPEND" 变种第 2 次实践
- **产出**：§7.A 映射（0 新增 / A.1 既有索引 / A.2 非本契约 scope 说明）/ §7.B 映射 + 新 2 条（`B.p201-1` 工厂未实装 / `B.p201-drift` 行号 drift）/ §7.C 32 条全扫（补既有 7 行判定表不足）/ §7.Phase（本节）
- **对比组**：
  - L1 × 5（phase187）8 §7.A / 9 §7.B
  - L2 SessionStore（phase192）0 / 0
  - L2 Messaging（phase192）0 / 1（`B.p192-1` 字面量）
  - L2 ProcessManager（phase195）0 / 1（`B.p195-1` 单文件规模）
  - L2 纯通用 × 3（phase193）0 × 3
  - **L3 SubAgent（phase201）0 / 2（`B.p201-1` 工厂未装 + `B.p201-drift` 行号 drift）**
- **方法论贡献**：
  - **"§9 物理编号 APPEND" 第 2 次实践**（phase195 首次 / phase201 复用）—— 模式稳定，向升格迈进
  - **Path #1 drift 核模板第 4 次触发** —— phase182/191/196/201 全部用 Path #1 识别契约↔实然 drift；phase194 已硬化；本 phase 新亚型"**行号 drift**"（vs phase182/191/196 是契约字段/方法/flag drift）
  - **`B.p201-drift` 新登记形态首次** —— 将"行号 drift"作为 B 类偏差登记（候选修复方向 α/β/γ），而非就地修；候选升格 `feedback_module_contract_structure` 补"契约行号引用策略"章节
  - **"工厂未实装"跨同层对比登记**（`B.p201-1`）—— 首次在 §7.B 条目内列出"已实装工厂"对比表（5 个已装 / SubAgent 未装）；为细化期判断"是否值得补工厂"提供证据
- **升格候选**（观察 phase202+）：
  - **"行号 drift 登记为 B 类"**（本 phase 首次）—— 2 次验证后可升格 `feedback_module_contract_structure` "契约引用策略" 章节
  - **"工厂未实装跨同层对比登记"**（本 phase 首次）—— 细化期工厂统一模式
  - **"§9 物理编号 APPEND" 模式**（2 次达阈值 / phase195 + phase201）—— 可升格 `feedback_module_contract_structure` §backfill APPEND 章节补"既有 §7 被占的变通"节

#### phase247 纪律 — B.2 Monitor 废止 sub-phase 3 SubAgent 迁移（r15 分支 C / main `57f51be` / 2026-04-24）

- **scope**：`src/core/subagent/agent.ts` 3 处 `this.monitor?.log()` → `this.audit?.write()`；新增 `private audit?: AuditWriter` 字段（field #25）+ `SubAgentOptions.audit?: AuditWriter`
- **新增常量**（`src/foundation/audit/events.ts`）：`SUBAGENT_STEP_COMPLETE_FAILED` / `SUBAGENT_PERSIST_FAILED` / `SUBAGENT_LOG_APPEND_FAILED`
- ~~**monitor 字段保留**：`private monitor?: Logger` 仍存在（仍被 ToolExecutor 传参用，L162）；仅 `.log()` 调用迁移~~（phase297 已清零）
- **§3 同步**：三 non-fatal catch 路径新增到审计事件清单（#subagent_*_failed 3 rows + 注脚更新）
- **§2.b 同步**：新增 field #25 `audit?: AuditWriter`
- **§7.A 排查结论同步**：`monitor.error` → `audit?.write()` 注记
- **B.2 工程进度**：17（phase239）+ 44（phase246-B）+ 5（本 phase，含 heartbeat 1 + agent 3 + runtime 1）= 66/73

#### phase252 纪律 — B.2 Monitor 废止 sub-phase 4 B.p248-1 消化（r17 分支 B / main e15244c / 2026-04-24）

- **scope**：B.p248-1 消化：`executor.ts` `ToolExecutorOptions` +auditWriter + `ToolExecutor` 私有字段 + `getExecContext()` 注入 + `agent.ts` SubAgent 传 `auditWriter` 至 `new ToolExecutor({...})`
- **§7.B 同步**：B.p248-1 状态更新为"phase252 已消化"（联动 l3_tools.md B.4）
- **B.2 工程进度**：17（phase239）+ 44（phase248）+ 5（phase247）+ 9（本 phase）= 75/75 **完工** ✅
- **下游解锁**：B.2 整理债标完工；H.B1-notify 等下游 phase 可起步

#### phase279 纪律 — §7.C M7 cascade 补登记（2026-04-25，r22 分支 E）

- **scope**：r22 E phase279 §7.C 治理跟进；B.p201-1（createSubAgent 工厂未实装）phase229 已消化后 M7 灰度→✓ cascade 补登记
- **cascade 前进 1 条**：M7 灰度（B.p201-1）→ ✓（phase229 消化）
- **触发源**：phase229（createSubAgent thin proxy + 2 消费方切换）
- **纯 design / 本地 only / 无 SHA**

#### phase283 纪律 — SubAgent §7.A A.1 清零（r23 分支 B / 2026-04-25）

- **scope**：`SubAgentOptions.taskStreamWriter` / `auditWriter` 改必选；`agent.ts` 内 8 处 `?.write` 短路全部消除；`streamCallbacks` ternary 化简；新建 `noop-writers.ts`；`contract/manager.ts` verifier SubAgent 注入 Noop；7 处测试补齐 required 字段
- **联动修改**（M#8 cascade）：`auditWriter` 类型 `AuditWriter` → `Audit` 接口（`agent.ts` / `executor.ts` / `context.ts` / `_pending-task-writer.ts`）
- **§7.A 全清零里程碑**：A.1 唯一 A 类消化；§7.A 0/1 → 0 open
- **§7.C 前进**：D1a 部分违反→合规 / D1d 部分违反→合规 / D2 部分违反→合规（3 条前进）
- **§2.b 同步**：field #23/24 optional `✗` → required `✓`；#24 类型 `AuditWriter` → `Audit`
- **tsc 验证**：clean（`npx tsc --noEmit` 0 errors）
