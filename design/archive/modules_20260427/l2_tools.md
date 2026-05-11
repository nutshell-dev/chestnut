# Tools 接口契约

**L2 基础设施层（agent 语义）**。工具框架 —— 为 agent 调用工具提供机制层基础设施：`Tool` interface + `ToolRegistry`（注册表）+ `ToolExecutor`（超时/async 路由/审计）+ `ExecContext`（执行上下文）+ `CallerType` + `TOOL_PROFILES` 权限系统。**本模块不拥有任何业务工具的业务语义；各业务工具的归属由各业务模块自行声明**（M5 / KD#27）。

> **应然 / 实然 split**（2026-04-26 / r31 框架重定位 L3→L2 / drift 标记）：
>
> **应然**：
> - **L2 agent 语义** / framework only / **不持任何具体工具实现**
> - 各业务模块（FileTool / ShellTool / Messaging / SkillSystem / TaskSystem / ContractSystem 等）own 自己工具 + 装配期注册到 `ToolRegistry`
> - Tools own：Tool 协议 + 注册表 + dispatcher + 全部 cross-cutting 机制（caller 权限矩阵 / 调用 audit / 超时 / signal / 并行优化）
> - **应然依赖**：AuditLog（dispatcher generic 调用 audit）
>
> **实然**（2026-04-26）：
> - 当前位于 `src/core/tools/`（L3 物理位置 / 待重组）
> - `builtins/` 目录集中所有工具源码：`read` / `write` / `search` / `ls` / `exec` / `send` / `skill` / `done` / `status` / `memory_search` 等
> - **Tools 模块跨业务持有所有工具 = leak 待 §7 治理**：业务工具应物理迁移到各自业务模块（FileTool / ShellTool / Messaging / SkillSystem 等）
> - **实然依赖**：FileSystem + LLMService + AuditLog（ExecContext 句柄）—— 包含 FileSystem / LLMService 是因 builtins 中工具消费这些底层；framework-only 应然下该依赖剥离归各业务模块
>
> 本次 split 仅做框架重定位 + drift 登记，§7 / §8 内容保持不动；后续物理迁移路径详 §7.Phase 与下方 α.1 / α.2 决策。

**应然定位 α.1（声明式归属）**（2026-04-21 phase173 决策，modules.md KD#27）：

- 本模块**仅拥有工具框架 + 协议**，不拥有任何具体业务工具的语义、不预设业务工具到业务模块的映射
- 业务语义由各业务模块自行声明其拥有的 Tool 对象（装配期由 Assembly 注册到 `ToolRegistry`）
- `ReportResultTool` 例外：作为 verifier 子代理结构化返回的**通用机制层工具**（防 JSON 文本 parse 脆弱），归 tools 自身

**实然物理位置**（2026-04-26 / 详 §7）：

- `src/core/tools/executor.ts`（含 `Tool` / `ToolRegistry` / `IToolExecutor` / `ExecContext` 接口 + `ToolExecutorImpl` + `ToolExecutor`）
- `src/core/tools/registry.ts`（`ToolRegistryImpl`）
- `src/core/tools/context.ts`（`ExecContextImpl`）
- `src/core/tools/caller-type.ts`（`CallerType` + `isDispatchCaller` + `callerTypeToProfile`）
- `src/core/tools/profiles.ts`（`TOOL_PROFILES` 白名单）
- `src/core/tools/report-result.ts`（`ReportResultTool`，verifier 专用）
- `src/core/tools/index.ts`（对外导出）
- `src/core/tools/builtins/`（业务工具物理位置 / 业务语义归各模块 / 非本契约 scope；α.2 物理搬迁作为远期优化不做）

## 1. 所有权

### 归属层

L3 执行与连接。**装配归属**：按需（任何执行 agent 工具调用的 daemon 装 / 应然 / 跟 modules.md §17 align）。**被谁调用**：

- **L3 StepExecutor**：通过 `IToolExecutor.execute` 驱动工具调用；消费 `ExecContext` / `ToolRegistry`
- **L3 AgentExecutor**：透传 ctx.signal / stepNumber
- **L3 SubAgent**：构造 per-subagent `ToolExecutor` + registry 过滤
- **L4 TaskSystem**：构造按 callerType profile 过滤后的 effective registry 传给 SubAgent
- **L4 ContractSystem**：装配 verifier registry + 注入 `ReportResultTool`
- **L5 Runtime**：注册运行期专用工具
- **L6c Assembly**：装配期从各业务模块拉取 Tool 对象注册到 `ToolRegistry`

### 职责（做）

1. **Tool 协议定义**：`Tool` interface（name / description / schema / readonly / idempotent / supportsAsync / execute）作为所有工具实现的形状契约
2. **工具注册表**：`ToolRegistryImpl` 提供 register / unregister / get / has / getAll / getForProfile（profile 过滤）/ formatForLLM（LLM API schema 转换）
3. **工具执行器**：`ToolExecutorImpl.execute` 负责 schema 校验 → async 路由（supportsAsync + async=true 走 TaskSystem.scheduleTool）→ 超时控制（`Promise.race` + `AbortController`）→ signal 合并 → 统一错误包装为 `ToolResult` → audit 留痕
4. **并行优化**：`executeParallel` 过滤 readonly 工具批量并发（StepExecutor 在 readonly+sync 时调用）
5. **执行上下文**：`ExecContextImpl` 承载 caller 身份（clawId / clawDir / callerType / profile / stepNumber / signal）+ 基础设施依赖句柄（fs / llm / auditWriter）；**不预设业务模块依赖句柄**（应然 / phase289 移除 taskSystem / outboxWriter / contractManager / skillRegistry 4 字段后达成；业务工具自行通过属性注入消费上层依赖）
6. **权限 profile**：`TOOL_PROFILES` 定义按 CallerType 划分的工具白名单集合；`callerTypeToProfile` 做 CallerType → Profile 映射（具体白名单的工具名清单是由各业务模块声明的 Tool 名汇总而成 / 应然不预设业务工具枚举）
7. **Verifier 返回工具**：`ReportResultTool` 提供结构化 `{passed, reason, issues}` 返回，替代 LLM 文本 + JSON 正则 parse 的脆弱路径

### 不做

- **不拥有任何业务工具的语义**（按 α.1 决策 / KD#27）：业务工具的归属由各业务模块自行声明；框架不预设业务工具到模块的映射、不预设业务工具枚举（实然 builtins 物理位于 `core/tools/builtins/` 详 §7）
- **不直接执行工具业务**（`Tool.execute` 由各业务实现，tools 框架只调用）
- **不持久化注册表**（ToolRegistry 是运行期派生态，每次装配重建；不落盘）
- **不管工具使用审计的写入**（只负责调用 ctx.auditWriter?.write，具体审计归属各工具）
- **不负责 LLM 交互**（tools 只提供工具定义格式 `formatForLLM` 转换，不调 LLM）

### 业务语义

「agent 用工具操作系统」这一业务语义的**机制层**归属点。具体"做什么"归各业务模块；"怎么注册、怎么调用、怎么过滤、怎么超时、怎么审计"归 tools。

### 资源

无自有磁盘资源。运行期派生态：
- `ToolRegistryImpl.tools: Map<string, Tool>` —— 实例内存，不落盘
- `ToolExecutorImpl.defaultTimeoutMs` —— 常量
- `ExecContextImpl.startTime` —— 实例启动时间戳

## 2. 接口

### 2.a `Tool` interface

```ts
interface Tool {
  name: string;
  description: string;
  schema: JSONSchema7;
  readonly: boolean;
  idempotent: boolean;        // 幂等（多次调用结果相同；只读工具均为 true）
  supportsAsync?: boolean;    // 是否支持 async=true 路由（走 TaskSystem.scheduleTool）
  execute(args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult>;
}
```

**前置条件**：
- `name` 在 ToolRegistry 中唯一（后注册覆盖先注册）
- `schema.properties` 与 `schema.required` 由 `ToolExecutorImpl.validateArgs` 做基础类型检查
- `execute` 必须处理 `ctx.signal.aborted` 提前退出

**失败分类**：
- 工具内部抛错 → `ToolExecutor.execute` catch 转成 `ToolResult { success: false, content: err.message }`（不 rethrow，保证 agent 能继续）
- `ToolTimeoutError`（超时）→ 同上，包成 `ToolResult`
- Schema 校验失败 → 抛 `ToolInvalidInputError`（rethrow，调用方决定）
- Tool not found → 抛 `ToolNotFoundError`（rethrow）

### 2.b `ToolRegistry` interface

```ts
interface ToolRegistry {
  register(tool: Tool): void;
  unregister(name: string): void;
  get(name: string): Tool | undefined;
  has(name: string): boolean;
  getAll(): Tool[];
  getForProfile(profile: ToolProfile): Tool[];
  formatForLLM(tools: Tool[]): Array<{
    name: string;
    description: string;
    input_schema: JSONSchema7;
  }>;
}
```

**关键约定**：
- `getForProfile` 按 `TOOL_PROFILES[profile]` 白名单过滤（**工具名必须在白名单，否则不返回**）
- `formatForLLM` 只做格式转换，不过滤

### 2.b.1 装配工厂（phase212 新增）

```ts
/**
 * 装配工厂（phase212）：无参构造 / return interface 类型
 * Assembly 主 registry（L164）+ verifier registry（L189）各 1 处消费
 *
 * 合入 main `5968b3a`（r8 分支 D / D.1 工厂批 1 / Assembly 4 处 new → createX 切换）
 */
function createToolRegistry(): ToolRegistry;
```

### 2.c `IToolExecutor` interface

```ts
interface IToolExecutor {
  execute(options: ExecuteOptions): Promise<ToolResult>;
  executeParallel(
    batch: Array<{ toolName: string; args: Record<string, unknown> }>,
    ctx: ExecContext
  ): Promise<ToolResult[]>;
  validateArgs(toolName: string, args: Record<string, unknown>): { valid: boolean; errors?: string[] };
}

interface ExecuteOptions {
  toolName: string;
  args: Record<string, unknown>;
  ctx: ExecContext;
  timeoutMs?: number;
  async?: boolean;       // true 时走 TaskSystem.scheduleTool 异步路径
  toolUseId?: string;    // LLM 生成的 tool_use block id（audit 链路追踪用）
}

interface ToolResult {
  success: boolean;
  content: string;
  error?: string;
  metadata?: { filesAffected?: string[]; durationMs?: number; [k: string]: unknown };
}
```

**async 路由约束**：
- `ctx.callerType !== 'claw'` → 返 `{success: false, content: 'Async mode is not available for subagents.'}`
- `ctx.taskSystem` 未注入 → 返 `{success: false}`
- `tool.supportsAsync !== true` → 返 `{success: false}`
- 以上全满足 → 调 `ctx.taskSystem.scheduleTool(toolName, callback, ctx.clawId, {...})`，返回 `{success: true, content: 'Async task queued...', metadata: {taskId, async: true}}`

**超时 + signal 合并**：
- `AbortSignal.any([ctx.signal, timeoutController.signal])` 合并上游中断 + 内部超时
- `Promise.race([executionPromise, timeoutPromise])` 保证任一先发生则立即抛出 `ToolTimeoutError`
- `executionPromise.catch(() => {})` 对不响应 signal 的工具保底

### 2.c.1 装配工厂（phase217 新增）

```ts
/**
 * 装配工厂（phase217）：thin proxy / 对齐 ctor 签名
 * Assembly L264 `new ToolExecutorImpl(...)` → `createToolExecutor(...)` 切换
 *
 * 合入 main `b93d00a`（r9 分支 C / D.1 工厂批 2 / Assembly 3 处 new → createX 切换：ContextInjector/ToolExecutor/Heartbeat）
 */
function createToolExecutor(
  registry: ToolRegistryImpl,
  timeoutMs?: number,
): ToolExecutorImpl;
```

### 2.d `ExecContext` interface

**应然**（2026-04-26 / 跟 modules.md §17 align / phase289 KD#29 归零后）：仅承载 caller 身份 + 基础设施句柄，不含任何业务模块依赖字段。

```ts
interface ExecContext {
  // caller 身份
  clawId: string;
  clawDir: string;
  callerType: CallerType;
  profile: ToolProfile;
  contractId?: string;

  // 步数 / 中断
  stepNumber: number;
  maxSteps: number;
  subagentMaxSteps?: number;
  signal?: AbortSignal;

  // 基础设施依赖句柄（L1-L2 向下）
  fs: FileSystem;
  llm?: LLMService;
  auditWriter?: AuditWriter;

  // 上下文消息（agent 执行期需要）
  dialogMessages?: Message[];
  originClawId?: string;
  readonly isMotionChain: boolean;

  // helpers
  getElapsedMs(): number;
  incrementStep(): void;
}
```

**应然不含**：`taskSystem` / `outboxWriter` / `contractManager` / `skillRegistry`（业务模块依赖；业务工具自行通过工具属性注入消费 / phase289 KD#29 归零）。

**实然**：上述 4 字段已于 phase289 从代码中移除（SHA `9013f2b`）；详 §7.A A.1 闭环 + §7.D KD#29。

### 2.e `CallerType` + `TOOL_PROFILES`

**应然**（2026-04-26 / 跟 modules.md §17 align）：`CallerType` 枚举 caller 身份；`TOOL_PROFILES` 是 caller 身份 → 工具白名单的映射契约（白名单内容是装配期由各业务模块声明的 Tool 名汇总而成 / 框架层不预设业务工具枚举）。

```ts
type DispatchCallerType = 'dispatcher' | 'describer' | 'miner';
type CallerType = 'claw' | 'subagent' | DispatchCallerType;

type ToolProfile = 'full' | 'readonly' | 'subagent' | 'miner' | 'dream' | 'verifier';

// 应然：白名单内容由装配期汇总各业务模块声明的 Tool 名构成；框架层只定义 profile 维度
declare const TOOL_PROFILES: Record<ToolProfile, string[]>;
```

**实然**（详 §7）：`core/tools/profiles.ts` 经 `ToolName` union type + `*_TOOL_NAME` const 引用定义 6 profile 白名单（phase347 完成），编译期可检；框架层仍预设业务工具枚举（应然由装配期收集组装未变）。详 §7.B B.1。

### 2.f `ReportResultTool`

```ts
class ReportResultTool implements Tool {
  name = 'report_result';
  readonly = false;
  idempotent = true;  // 覆盖性结构化返回，多次调用取最后一次
  capturedResult?: { passed: boolean; reason: string; issues?: string[] };
  async execute(args): Promise<ToolResult> { ... }
}
```

**用途**：contract verifier 子代理通过此工具返回 `{passed, reason, issues}` 结构；ContractManager.runLLMAcceptance 调用后读 `reportTool.capturedResult`，避开文本 JSON 正则 parse 的脆弱路径。

## 3. 审计事件清单

**应然**（2026-04-26 / 跟 modules.md §17 align）：框架层只产生 2 个通用执行事件（`tool_exec` / `tool_async_start`）；具体业务工具的 audit 事件归各业务模块契约登记，物理路由经 `ctx.auditWriter`（框架透传 / 不预设事件名）。

**实然**（详 §7 / 下表保留）：

| 事件 | 写入点 | 归属 |
|---|---|---|
| `tool_exec` | `ToolExecutorImpl.execute` L250-256 `ctx.auditWriter?.write('tool_exec', toolName, ok/err, ms, summary)` | **通用工具执行事件**，归 tools 框架（本条为 tools 模块唯一自发事件）|
| `tool_async_start` | `ToolExecutorImpl.execute` L196 async 路径触发 | 同上（async 路由事件）|
| 各工具业务事件（如 `contract_created` / `inbox_written` / `spawn_scheduled` 等） | 各工具 `execute` 内部 | 业务工具所属模块（各业务契约登记）|
| `dispatch_load_skills_failed` / `dispatch_contract_done_not_found` / `dispatch_contract_done_parse_failed` / `dispatch_contract_done_missing_fields` / `dispatch_write_by_contract_failed` / `dispatch_no_dialog_context` | `dispatch.ts`（6 事件，phase252 新增）| 业务归 SubAgent / agent 协作子模块（α.1 决策 #29）；物理在 `core/task/tools/dispatch.ts`；via `ctx.auditWriter?.write()` |
| `status_contract_error` / `status_task_pending_error` / `status_task_running_error` | `status.ts`（3 事件，phase252 新增）| 业务归 CLI/Daemon；物理在 `core/tools/builtins/status.ts`；via `ctx.auditWriter?.write()` |

**总计**：本契约登记 2 个自发事件（`tool_exec` / `tool_async_start`）；phase252 新增 9 个透传事件（dispatch × 6 / status × 3，业务归各自模块，物理路由经 `ctx.auditWriter`）。

## 4. 上游依赖

**应然**（2026-04-26 / 跟 modules.md §17 align）：仅依赖 L1-L2 基础设施 type，不依赖任何 L4+ 业务模块。

| 项 | 来源 | 用途 |
|---|---|---|
| `FileSystem` type | `foundation/fs/types.ts` | ExecContext.fs |
| `LLMService` type | `foundation/llm/index.ts` | ExecContext.llm（可选）|
| `AuditWriter` type | `foundation/audit/writer.ts` | ExecContext.auditWriter（可选 / 框架自身 + 业务工具均用）|
| `Message` / `JSONSchema7` type | `types/message.ts` | schema / dialogMessages |
| `ToolProfile` | `types/config.ts` | profile 类型 |
| `MOTION_CLAW_ID` / `DEFAULT_MAX_STEPS` | `constants.ts` | ExecContextImpl 默认值 / isMotionChain 判定 |

**应然不依赖**：`TaskSystem` / `OutboxWriter` / `ContractManager` / `SkillRegistry` 等任何 L4+ 业务模块（KD#29 移除 capability 协议机制后；phase289 已落地）。

## 5. 不可消除的耦合

**消除路径首选 port pattern**（feedback_module_contract_structure r40.2）：消费方 own port + 默认实现 + assembly 注入 / phase337+335+340 三 phase 实证。Tools 当前耦合（ExecContext 4 字段注入 + ToolRegistry interface）已是 port 范本（消费方 own / runtime 注入）。

### 5.1 ~~Tools → 业务模块（经 capability 协议）~~ 已废止 ✓ **phase289 删除**

capability 协议清单（`ITaskScheduler` / `IContractQuery` / `ISkillLibrary` / `IOutboxSink`）已于 phase289 代码实施时一并删除。废止理由及决策详见 modules.md 关键决策 #29。

### 5.2 Tools → L1-L2 基础设施 type 依赖

- FileSystem / LLMService / Logger / AuditWriter / Message / JSONSchema7 —— 跨层向下 type 依赖，合规（L3 → L1/L2）

### 5.3 Tools 框架 ↔ 各业务工具物理位置

**应然**：Tools 框架与业务工具间无强耦合 —— 业务工具按 `Tool` interface 自定义实现，Assembly 装配期通过 `ToolRegistry.register` 接入；框架不预设业务工具的物理位置。

**实然**（详 §7）：业务 builtins 物理位于 `src/core/tools/builtins/`（α.1 代码组织）但业务语义归各模块；消费者 import path 在多处写死；α.2 物理搬迁作为远期优化。

## 6. 持久化

**无磁盘资源**。`ToolRegistry` / `ExecContext` 全是运行期派生态，进程重启时由 Assembly 装配过程重新注册各业务模块声明的 Tool 对象重建。

**重建语义**：进程重启后工具名集合、profile 白名单、schema 恒定（代码定义），不涉及磁盘状态恢复。

## 7. 与现状的差距

### A 类违规（本 phase 不修，登记）

#### A.1 ~~capability interfaces 尚未落地代码~~ → 已决定移除（关键决策 #29）

**应然变更**（2026-04-23）：modules.md 关键决策 #29 决定移除全部 capability 协议机制（`TaskScheduler` / `ContractQuery` / `OutboxSink`）。原 §5.1 声明的 4 个 interface 予以废止。理由：

- **TaskScheduler 不需要**：spawn/dispatch 工具的编排涉及 L1-L2 多模块工具注册与 SubAgent 构造，是 L4 TaskSystem 的职责。spawn 归 TaskSystem 导出，工具内部直接调 `writePendingSubagentTaskFile`，无 L3→L4 跨层依赖
- **ContractQuery 不需要**：verifier 子代理可通过 `read` 工具自读 `contract/active/{id}/progress.json`，或由 ContractSystem 创建时将验收信息写入 context/prompt
- **OutboxSink 不需要**：SubAgent 执行结果由 TaskSystem 拾起后写入 outbox，SubAgent 作为纯执行原语不涉及回传
- **ISkillLibrary 不需要**：skill 工具直接消费 SkillRegistry（已在 L2，无跨层问题）

**违反原则**（原 A.1 登记的反面）：M2「模块为自己的业务语义负责」—— L3 Tools 不应为 L4 定义业务接口；M5「底层不预设上层语义」—— L3 不应预设 L4 的 TaskScheduler 语义。

**实然 drift**（phase289 代码实施后更新）：
1. `ExecContext.taskSystem?: TaskSystem` — **phase289 Step 6 移除**（executor.ts async 路径改 `this.taskSystem`；dispatch.ts 工具属性注入）
2. `ExecContext.outboxWriter?: OutboxWriter` — **phase289 Step 5 移除**（send.ts 工具属性注入）
3. `ExecContext.contractManager?: ContractManager` — **phase289 Step 4 移除**（ExecContextImpl only，非公开接口）
4. `ExecContext.skillRegistry?: SkillRegistry` — **phase289 Step 4 移除**（同上）
5. §2.d ExecContext interface 中 `taskSystem` / `outboxWriter` 字段 — **phase289 Step 5/6 同步**
6. §4 "跨层 type-only 依赖" 段落已过时 — **phase289 Step 7 同步**
7. §5.1 整段 capability 协议清单 — **phase289 Step 7 已删除**（本 phase design 部分直接实施）

**修复方向**（独立 phase）：
1. ~~spawn/dispatch 工具物理迁至 TaskSystem 模块目录~~ **→ Step A: phase287 已实施**（`src/core/task/tools/`）
2. ~~ExecContext 移除 4 字段~~ **→ Step B: phase289 已完成**（SHA `9013f2b`）
3. ~~删除 §5.1 capability 协议清单~~ **→ phase289 design 部分已实施**

### B 类偏差（本 phase 仅登记）

**type 标签**（feedback_module_contract_structure r40.3）：B 项必标 `drift` vs `design-gap` 二分。
- **drift type**：契约说应 X / 实然 Y / 修法明确（推 §7.A 必修）
- **design-gap type**：应然 silent / 实然有 / 修法不明 / 必推独立 design phase 评估

> 现有 B.1-B.4 历史登记 type 分类待 r43+ 应然同步 phase 批量补标。已知初判：
> - B.1 TOOL_PROFILES 字符串硬编码 = **drift**（修法明确：const union type）
> - B.2 L3 tools SkillRegistry value-import = **drift**
> - B.3 ReportResultTool 归属讨论 = **design-gap**（应然 silent / 推 design phase 评估）
> - B.4 已 phase252 消化 = **drift / 已闭环**
> - ~~**B.p344-tools-1 KD#29 `taskSystem` 字段未清理**~~ **→ phase350 撤销错误登记（registration error / 非 drift）**：r42 D 第 5 轮误判 `ToolExecutorImpl.taskSystem` 字段为 KD#29 violation / 实然 §1 ¶3 应然显式 endorse「ToolExecutorImpl.execute 负责 ... async 路由（supportsAsync + async=true 走 TaskSystem.scheduleTool）」/ 持 TaskScheduler 引用是应然要求 / 与 phase289 移除的 ExecContext 4 业务字段无关（ExecContext interface ≠ ToolExecutorImpl class）。phase347 r43 总览 §1.2 实测推翻率 ~50% 直接溯源此条登记错误向上游 dispatch table 传播。phase350 修订：撤销本条 B.p344-tools-1 + 标注「dispatch table 描述脱节实然」根因之一。
> - ~~**B.p344-tools-2 dispatch 工具物理位置**~~ **→ phase347 已修复**：`src/core/runtime/dispatch.ts` → `src/core/task/tools/dispatch.ts`（与 spawn/ask-motion KD#29 一致）
> - ~~**B.p344-tools-3 profiles.ts 字符串硬编码**~~ **→ phase347 已修复**：`*_TOOL_NAME` const 自治（tool-names.ts 集中定义）+ `ToolName` union type / profiles.ts 编译期可检 / caller 风格统一并轨第 2 次复用（phase345 模板 1:1）

#### B.1 TOOL_PROFILES 工具名字符串硬编码

**现状**：`TOOL_PROFILES` 6 个 profile 的工具清单用字符串字面量 `['read', 'write', ...]`，tsc 无法在工具改名 / 删除时告警。

**偏差理由**：类型化需要把所有工具名做成 `const` union type（如 `type ToolName = 'read' | 'write' | ...`），一次性改动面大。

**治理路径**：细化期做，或等 α.2 物理搬迁顺带。

#### B.2 L3 tools SkillRegistry value-import 治理（dispatch / skill）

**历史现状**（phase199 backfill 时）：
- `core/task/tools/dispatch.ts:4` `import { SkillRegistry }` value import（构造自定义 dispatch-skills 目录的独立 SkillRegistry 实例）
- `core/tools/builtins/skill.ts:9` 同上（支持 custom skillsDir 参数）
- 登记时 SkillSystem 为 L5；L3 tools value-import L5 违反 #5「底层不预设上层语义」

**状态**：**phase285 已清零**（r23 分支 E）

- phase180 SkillSystem rename L5→L2 后层级违反已消除；工厂迁移补齐耦合规范
- `dispatch.ts`：`import { createSkillRegistry } from '../../skill/index.js'` + `createSkillRegistry(ctx.fs, 'clawspace/dispatch-skills')`
- `skill.ts`：`import { createSkillRegistry, type SkillRegistry } from '../../skill/index.js'` + `createSkillRegistry(ctx.fs, ...)`；type annotation 保留 inline type
- ISkillLibrary.forDir 方案放弃（phase180 rename 后无跨层问题；工厂模式统一）

#### B.3 `ReportResultTool` 归属讨论

**现状**：`ReportResultTool` 在 `core/tools/report-result.ts`，被 ContractManager.runLLMAcceptance 构造 verifier registry 时注册。本契约 §1 将其归 tools 模块（verifier 机制层工具）。

**偏差理由**：`ReportResultTool` 的业务是"让 verifier 子代理以结构化格式返回"—— 可以视为 verifier 机制（归 tools）或 ContractSystem 业务工具（归 contract）。当前归 tools 是因为它封装了"防止脆弱 JSON 正则 parse"的通用 verifier 机制，与 contract 具体语义无关。

**治理路径**：细化期争议可升级讨论；当前归 tools 合理。

#### B.4 ToolExecutor.getExecContext() 未注入 auditWriter（phase252 发现即清零）

**实然**（phase248 识别 / B.p248-1）：`ToolExecutor.getExecContext()` 构造 `ExecContextImpl` 时遗漏 `auditWriter: this.auditWriter`；`ToolExecutorOptions` 亦无 `auditWriter` 字段。导致 SubAgent 路径下 dispatch / status 工具拿到的 `ctx.auditWriter` 恒为 `undefined`，audit 事件静默丢失。

**应然**：`ExecContext.auditWriter` 在所有路径（主循环 + SubAgent）均有值（已注入时）。

**登记**：phase252 发现即清零（phase248 B.p248-1 → phase252 消化链路 / l3_subagent.md B.p248-1 联动）。

**状态**：**phase252 发现即清零**（`ToolExecutorOptions` +auditWriter / `ToolExecutor` 私有字段 + `getExecContext()` 注入 / `SubAgent` 透传；见 Step 2 chain-B-executor-agent.md）

### C 类（原则对照补充）

| 原则 | 判定 | 依据 |
|---|---|---|
| #1 独立可变职责 | 合规 | tools 框架 = "工具运行机制"（独立于任何具体工具的业务语义）；tsc + capability 协议变更源独立于任何业务模块 |
| #2 业务语义归属 | 合规 | 框架层不持有业务语义；所有具体工具业务归各自业务模块（α.1 决策 #27） |
| #3 资源归属 | 合规 | 无自有资源 |
| #5 依赖单向 | 合规（A.1 修复后更清晰）| L3 tools 只 type 向下依赖 L1-L2；capability 协议让 L4/L5 向 L3 实现而非反向 import |
| #7 耦合界面稳定 | 合规 | Tool interface / ToolRegistry API 方法集稳定；新增工具不改框架 |
| #8 耦合界面最小 | 合规 | 框架接口只暴露必需方法；capability 协议按工具消费切面设计 |
| #9 显式表达优先编译器可检 | ~~**A.1 登记**~~ → **合规**（KD#29 + phase289 §5.1 capability 协议物理删除 / r31 主会话补 r30 E + r31 B 漏 scope）| ~~capability interface 尚未落地代码~~ → 已显式废止 |

### 7.C.2 全 32 条原则对照补全（phase199 APPEND）

按 `feedback_apply_principles_first` 全 32 条扫描（Module Logic 11 + Design 11（#1 展 a-d、#6 展 a-b 合计 14 条目）+ Philosophy 4 + Path 6）。现有 §7.C 表（上方）保留，本节补 25 条未列条目 + 重述关键条目以完整对照。

#### Module Logic 11 条

- **M#1 独立可变职责**：合规（现有 §7.C 已列；变更源独立于任何业务模块）
- **M#2 业务语义归属**：合规（现有）
- **M#3 资源归属**：合规（现有 / 无自有磁盘资源）
- **M#4 持久化**：合规（新增 / 工具执行状态内存；持久化归业务模块）
- **M#5 依赖单向 / 禁循环**：合规（现有 / A.1 修复后更清晰）；B.2 value-import phase285 已清零（createSkillRegistry 工厂化）
- **M#6 依赖结构稳定**：合规（新增 / Tool interface + ToolRegistry API 稳定；`feedback_tool_layer_complexity` 认可 fan-out 结构性特征）
- **M#7 耦合界面稳定**：合规（现有 / 新增工具不改框架核心接口；phase212 `createToolRegistry()` 工厂切换 + phase217 `createToolExecutor(registry, timeoutMs?)` 工厂切换 / Assembly 4 处 tool-layer new 均走工厂 return interface；main `5968b3a` + `b93d00a`）
- **M#8 耦合界面最小**：合规（现有；引用 `feedback_tool_layer_complexity` —— 工具是 agent 触碰世界的触点，fan-out 不可避免，**非违反，结构性特征**）
- **M#9 显式表达编译器可检**：**合规**（phase289 移除 capability 协议机制，改为工具属性注入模式；tsc 可检工具层所有依赖）
- **M#10 不合理停下**：未触发（本 phase backfill 无触发）
- **M#11 边界不对停下**：未触发

#### Design 11 条（#1 展 a-d / #6 展 a-b）

- **D1a 信息不丢失**：合规（Tool result 经 `onToolResult` callback 传上游；audit 归各业务模块契约）
- **D1b 状态可观察**：合规（profile 白名单 + executor 内部状态明确）
- **D1c 中断可恢复**：合规（`signal` 合并 + `toolTimeoutMs` 见 §2.c）
- **D1d 事后可审计**：合规（`tool_result` audit 归各业务模块；tools 框架不产独立 audit）
- **D2 不得丢弃/静默**：合规（框架层不软吞；工具业务错经 `{ success: false, content }` 显式上抛）
- **D3 用户可观察**：合规（同 D1b）
- **D4 LLM 调用恢复**：无关（归 StepExecutor / Runtime）
- **D5 日志重建**：合规（工具执行经 `tool_result` + stream 事件重建）
- **D6a 决策主体**：合规（工具是 agent 触碰世界的触点；P2 上下文工程对应）
- **D6b 子代理不阻塞**：合规（经 async/await + signal 合并）
- **D7 系统可信路径**：合规（profile 白名单按 CallerType 限定工具可见面）
- **D8 事件驱动**：合规（框架本身被动；调用方 StepExecutor 驱动）
- **D9 多 claw 不隔绝**：无关（工具执行局限当前 agent）
- **D10 motion 特殊**：合规（MotionRuntime override `unregister('send')`）
- **D11 CLI 唯一对外**：无关（工具非对外接口）

#### Philosophy 4 条

- **P1 Agent 即目录**：合规（工具经 ExecContext 消费 `clawDir` / `motionDir`）
- **P2 上下文工程**：合规（工具结果进入 agent 上下文）
- **P3 多 agent 利用**：合规（dispatch / spawn 工具支持子代理）
- **P4 系统为智能体服务**：合规（工具是 agent 能力载体）

#### Path Principles 6 条

- **Path #1 规划基于规划时刻事实**：合规（phase199 backfill drift 核 4 条 A/B 条目全一致，无 drift）
- **Path #2 差距显式登记**：合规（§7.A / §7.B 显式登记）
- **Path #3 语义一致最小变更单元**：合规（本 phase APPEND 不解构）
- **Path #4 可回滚 + 破坏性论证**：合规（本 phase 非破坏性 / 纯 design 本地 only）
- **Path #5 完成后复盘**：合规（Step 4 三维 + Path 4 维复盘）
- **Path #6 冲突立即中断**：合规（phase198 已占分支 A → 顺延 phase199）

#### 32 条分档统计

- 合规：30
- 部分违反：1（M#9 引 A.1）
- 无关：4（D4 / D9 / D11 + M#10/M#11 未触发）
- **非合规合计**：1 部分违反 + 结构性灰度说明

### 7.D 关键决策映射表（modules.md 迁移）

从 `design/modules.md` §关键设计决策章节迁移（2026-04-26 主会话；后续清理阶段重构）。原 KD 编号保留供对账。

- **KD#1（原 modules.md）工具 handler 装配期注入 StepExecutor**：各模块导出工具定义 → Daemon 注入  
  关联模块：l3_step_executor.md（cross-ref / 主登记在本模块）
- **KD#20（原 modules.md）工具实现可走进程内 CLI 调用**：跨模块聚合信息的工具（如 status）背后调用 CLI 命令处理函数,不 spawn 子进程,不直接依赖多个业务模块
- **KD#27（原 modules.md）Tools α.1 声明式归属**：Tools 模块只定义工具框架，不拥有业务工具的业务语义。业务工具归各自业务模块（详见 #17 Tools "不导出业务工具"）；builtins 物理位置 `src/core/tools/builtins/` 是代码组织选择，不改变业务归属。α.2 物理搬迁作为远期优化不做
- **KD#29（原 modules.md）移除 capability 协议机制**（2026-04-23）：Tools 模块定义的 3 个 capability 协议（`TaskScheduler` / `ContractQuery` / `OutboxSink`）全部不必要，予以移除。原因分析：
    1. **TaskScheduler 不需要**：spawn/dispatch 工具的编排涉及 L1-L2 多模块工具注册，是 L4 TaskSystem 的职责而非 L3 SubAgent 的职责。spawn 工具应归 TaskSystem(L4) 导出，工具内部直接调 `writePendingSubagentTaskFile`，无 L3→L4 跨层依赖问题
    2. **ContractQuery 不需要**：verifier 子代理可通过 `read` 工具自读 `contract/active/{id}/progress.json`，或由 ContractSystem 创建时将验收信息写入 context/prompt
    3. **OutboxSink 不需要**：SubAgent 执行结果由 TaskSystem 拾起后写入 outbox，SubAgent 作为纯执行原语不涉及回传
    4. **原则依据**：M1（spawn 编排是 TaskSystem 的职责不应散落在 L3）、M2（L3 不应为 L4 定义业务接口）、M5（L3 不应预设 L4 语义）；与"目录驱动化"演进方向一致——工具 + 磁盘目录已天然解耦，协议中间层是过度抽象

---

### 7.Phase 执行纪律

#### 纪律.1 — phase155D CLI 工厂收拢（tools 注册面关联）

- CLI `cli-factories.ts` 工厂收拢与 tools 注册面间接关联（motion / claw 装配时用不同 profile 注册工具）
- 本契约 §2.e `CallerType` + `TOOL_PROFILES` 与 cli-factories 装配序契约化
- 相关纪律在 `project_phase155d_cli_factories.md`

#### 纪律.2 — phase163 `scheduleSubAgentWithTracking` helper 消除

- 原 `src/core/tools/builtins/spawn.ts` L19-48 含 helper 被 cron / daemon 跨层 import
- phase163 Step 5 消除 helper，消费者改 TaskSystem 直调
- 本契约 §7.B 曾登记 ~~B.2~~（相邻 subagent 契约的 B.2，已 phase163 消除）—— tools 侧 B.2 `value-import SkillRegistry` 是另一条目未消除
- 相关纪律在 `l3_subagent.md` §7 / phase163 纪律

#### 纪律.3 — phase169 SkillSystem 重构（dispatch.ts / skill.ts import 边界）

- phase169 SkillSystem 粗糙重构 + `createSkillRegistry` 工厂首次落地
- daemon.ts 主路径经 phase177 `createSkillRegistry` 消化
- **tools 侧 B.2 `import { SkillRegistry }` value import 仍在**（dispatch.ts L4 / skill.ts L9） —— 独立 phase 治理（把"构造特定目录的 skill registry"能力上移到 SkillSystem `ISkillLibrary.forDir(dir)`）
- 相关纪律在 `project_phase169_skill_system.md` / `project_phase177_daemon_A6.md`

#### 纪律.4 — phase177 createSkillRegistry 工厂（daemon.ts 侧清零，tools B.2 未消化）

- phase177 daemon.ts:179 改调 `createSkillRegistry(...)` 工厂；SkillSystem B.p169-1 从 4 处消化为剩余 3 处（dispatch.ts / skill.ts / tests/helpers/runtime-deps.ts）
- tools 侧 B.2 原本属 SkillSystem B.p169-1 的一部分（`dispatch.ts` + `skill.ts` 两处）
- 本契约 §7.B B.2 保留等待下次 tools → SkillSystem 协议上移 phase

#### 纪律.5 — phase199 §7.C 扩 + §7.Phase 新增（本 phase）

- **scope**: §7.C 现有 7 条补全全 32 条 + §7.Phase 新增节
- **APPEND 不解构**（phase187/193/196 模式）：§7.A / §7.B / 现有 §7.C 7 条不动；仅追加 §7.C.2 子节 + §7.Phase 节
- **Path #1 drift 核 4 条 A/B 条目**（A.1 / B.1 / B.2 / B.3）：**drift = 0，契约与实然一致**
- **Path Principles 第 7 次实践**（phase174/178/182/189/190/197/199）
- **方法论贡献**：
  - phase196 §7 内 APPEND 子节模板第 2 次复用（编号 §7.C.2 承 phase196 §9 变种）
  - Path #1 drift 核模板（phase196 升格）在 backfill 阶段首次实证"0 drift"结果
  - §7.C 非合规条目仅 1（M#9 引 A.1）+ 4 无关 + 30 合规 —— 证明 tools 框架层治理已相当成熟
- **升格候选**（观察）：
  - L3 §7 格式两套并存（phase197 识别 / phase199 补全 §7.C 后进度前推）
  - §7 内 APPEND 子节变种（phase196 §9 物理编号 / phase199 §7.C 补全 —— 2 次复用达阈值候选）

#### 纪律.6 — phase252 B.2 Monitor 废止 sub-phase 4 最终一击（r17 分支 B / main e15244c / 2026-04-24）

- **scope**：`dispatch.ts` 5 `ctx.monitor?.log` + 1 `console.warn`（业务降级，§7.A型① 强制 audit）→ `ctx.auditWriter?.write()`；`status.ts` 3 `ctx.monitor?.log` → `ctx.auditWriter?.write()`；`events.ts` +9 常量（DISPATCH_*×6 / STATUS_*×3）；`executor.ts` `ToolExecutorOptions` +auditWriter + `ToolExecutor` 私有字段 + `getExecContext()` 注入（B.4 发现即清零）；`agent.ts` SubAgent → ToolExecutor 透传（B.p248-1 消化）
- **Path #6 豁免**：dispatch.ts Step 共 6 calls，援引 phase248 recoverTasks 语义内聚豁免先例
- **N1 偏差**：dispatch.ts 实测 6 calls（分发表估 5）；L173 `console.warn` 属业务降级警告 §7.A型① 纳入
- **N3 澄清**：executor.ts L21 已有 `import type { AuditWriter }`（phase248 新增），Step 2 不需新增 import
- **B.2 工程完工**：17（phase239）+ 44（phase248）+ 5（phase247）+ 9（本 phase）= 75/75 ✅
- **B.2 Phase 2 完工**：monitor 实例创建 + lifecycle + 全字段链路（executor/context/subagent/task/system/runtime）—— phase297 SHA `d89e392`
- **测试新增**：`tests/core/dispatch.test.ts` +6 it / `tests/core/builtins.test.ts` +3 it

#### 纪律.7 — phase285 B.2 SkillRegistry value-import 治理（r23 分支 E / 2026-04-25）

- **scope**：`dispatch.ts:4` + `skill.ts:9` `import { SkillRegistry }` value import → `createSkillRegistry` 工厂 import
- `dispatch.ts`：`import { createSkillRegistry } from '../../skill/index.js'`；`new SkillRegistry(ctx.fs, 'clawspace/dispatch-skills')` → `createSkillRegistry(...)`
- `skill.ts`：`import { createSkillRegistry, type SkillRegistry } from '../../skill/index.js'`；`new SkillRegistry(ctx.fs, String(args.skillsDir))` → `createSkillRegistry(...)`；type annotation（L16 / L56）自动复用 inline type
- **layer context**：phase180 SkillSystem rename L5→L2；本 phase 到工厂迁移时层级已合规；工厂化补齐耦合规范
- **B.p169-1 进展**：phase169 识别（4 处）→ phase177 daemon.ts 清零 → phase285 dispatch + skill 清零 → 剩余 2 处（contract/manager.ts:1345 + tests/helpers/runtime-deps.ts:48）待 r25 消化。phase285 原声称"完全闭环"不准（N1：漏核 contract/manager.ts），phase289 修正。

#### 纪律.8 — phase287 Tools A.1 Step A 4 文件物理迁移（r23 分支 C / main 11c9aec / 2026-04-25）

- **scope**：`spawn.ts` / `dispatch.ts` / `ask-motion.ts` / `_pending-task-writer.ts` 从 `src/core/tools/builtins/` 迁至 `src/core/task/tools/`；内部 import 路径更新（8 处）；外部调用方 5 文件更新（`runtime.ts` / `contract/manager.ts` / `cron/jobs/random-dream.ts` / `assemble.ts` / `builtins/index.ts`）；测试 import 4 文件更新
- **M5 修复**：dispatch.ts L3→L4 越层依赖消除（`'../../task/system.js'` → `'../system.js'`，同层 L4 内部依赖合规）
- **M2 归位**：spawn/dispatch 业务语义物理位置与 TaskSystem 语义归属对齐
- **M8 改善**：builtins/index.ts 不再导出 spawnTool（spawn 不是 tools 框架层公开接口）
- **子代理设计对齐**：spawnTool 从 registerBuiltinTools 移除 → task/system.ts 子代理注册点不再获得 spawn，符合 `prompts/subagent.ts` "You CANNOT spawn other subagents" 约束
- **assemble.ts 显式注册**：主 toolRegistry.register(spawnTool) 由 assemble.ts 显式调用，保持主代理 spawn 能力
- **A.1 进度**：修复方向 1 完成（Step A phase287）；修复方向 2/3 完成（Step B phase289 SHA `9013f2b`）；修复方向 3 design 部分完成（§5.1 删除 phase289）

#### 纪律.9 — phase289 Tools A.1 Step B ExecContext 4 字段清理 + §5.1 删除（r24 分支 B / 2026-04-25）

- **scope**：ExecContext 移除 `taskSystem` / `outboxWriter` / `contractManager` / `skillRegistry`（Steps 2-6 代码等用户实施）；§5.1 capability 协议清单删除（本条 design 直接实施）
- **Path #1 N 类偏差**：N1（send.ts 仍在 builtins / outboxWriter 依赖未消除）/ N2（done/status/skill 仍通过 ctx cast 读 L4 字段）/ N3（executor.ts async 路径仍持 ctx.taskSystem）
- **4 字段消费实然**：`contractManager` / `skillRegistry` 不在公开 ExecContext 接口（只在 ExecContextImpl）；`outboxWriter` / `taskSystem` 在公开接口
- **修复策略**：工具属性注入模式（doneTool / skillTool 已有属性，statusTool / sendTool / dispatchTool 补属性）+ executor.ts async 路径改 `this.taskSystem`
- **§5.1 已删除**（本 phase design 直接实施）；§7.A A.1 drift 列表更新
- **代码 SHA**：`9013f2b`
- **§7.C cascade**：M#9（框架耦合防护）灰度→✓；M#5（依赖单向）灰度→✓
- **§7.A A.1 闭环**：Step B 完成，全部 3 个修复方向已闭环

#### 纪律.10 — phase296 B.p169-1 剩 2 处 SkillRegistry value-import 消化（r25 分支 C / 已合入 `fb024ca`）

- **scope**：`src/core/contract/manager.ts:28+1345` + `tests/helpers/runtime-deps.ts:11+48` 共 4 行 → value import 改 `createSkillRegistry` 工厂
- **B.p169-1 闭环**：phase169 识别 4 处 → phase177 daemon.ts 清零 → phase285 dispatch+skill 清零 → phase296 contract/manager + runtime-deps 清零 = **全仓产品代码 `new SkillRegistry` 归零**（跨 r9-r25 / 4 phase 接力）
- **代码已合入** / 计划见 `coding plan/phase296/`

#### 纪律.11 — phase301 cross-layer-up 实然核 + 极小修复（r26 分支 D / 2026-04-25 / c15f794）

- **scope**：r26 D cross-layer-up 治理；Path #1 核后 #14 scope 收窄
- **#14 发现**：分发表估 7 条违规 / 实然 4 条（全 type-only）
  - `skill.ts`：SkillSystem 已是 L2（phase180 rename）→ L3→L2 向下依赖，非违规；l3_tools.md §7.B B.2 记"phase285 清零 + rename 消除层级违反" ✓
  - `done.ts`：modules.ts 归属 ContractSystem(L4) → 同层引用，非违规
  - `executor.ts` ContractManager + SkillRegistry：DEAD type imports（全文无引用）
- **代码改动**：executor.ts 删 2 死 type import / status.ts taskSystem 属性注入替代 ctx 强转 bug / assemble.ts 追加 `statusTool.taskSystem = taskSystem` / modules.ts Runtime 路径修正（`src/core/runtime/` / phase295 C.1 后过时）
- **接受为 type-only**：executor.ts TaskSystem / status.ts ContractManager + TaskSystem 保留（import type = 无运行时依赖 / M#5 不适用）
- **cross-layer-up 计数**：4 → 3（删 1 dead ContractManager）

## 8. 测试覆盖

### 现有

- `tests/core/tools/registry.test.ts` —— ToolRegistryImpl register / unregister / getForProfile / formatForLLM 基本行为
- `tests/core/tools/executor.test.ts` —— ToolExecutorImpl.execute 超时 / async 路由 / signal 合并（待查验覆盖率）
- `tests/core/tools/builtins/` —— 12 个 builtins 各自单测（属各业务模块契约的测试归属，非本契约 scope）

### 未覆盖面（登记，本 phase 不补测）

- `ReportResultTool.execute` 参数校验 + capturedResult 覆写语义
- `executeParallel` readonly 过滤 + 并发行为
- `TOOL_PROFILES` 白名单对工具名改名的 drift 检查（B.1 相关，测试层兜底直到类型化落地）
- capability interface 已废止（关键决策 #29）；`implements` 契约测试不再需要（A.1 修复方向变更为工具属性注入 + ExecContext 精简）
