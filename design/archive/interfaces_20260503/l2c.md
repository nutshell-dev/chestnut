# Interfaces L2c — agent 业务概念基础设施接口

5 模块：Messaging、SkillSystem、Tools、FileTool、CommandTool。

模板加字段说明见主索引 [interfaces.md](../interfaces.md)。

---

## Messaging [capability, DI]

**生产方**：`l2_messaging`

**消费方**：

- `l5_runtime`（DI，每轮收件箱排空）
- `l4_task_system`（DI，任务派发加结果回送）
- `l4_contract_system`（DI，契约通知）
- `l4_memory_system`（DI，跨 claw dream 通知）
- `l6_cli`（DI，CLI 向 claw 发送消息）

**接口签名**（实然结构性拆分：3 class 各 own 子能力 + helpers）：

```ts
// 写侧 — 投自己 outbox（claw 视角 / motion 异步 pull）
export class OutboxWriter {
  constructor(clawId: string, clawDir: string, fs: FileSystem, audit: AuditLog);
  write(options: OutboxWriteOptions): Promise<string>;  // 返 messageId
}

export interface OutboxWriteOptions {
  type: string;
  body: string;
  meta?: Record<string, string>;
}

// 写侧 — 投他人 inbox（motion 视角 / D11 单向访问 / motion-only profile）
export class InboxWriter {
  constructor(targetClawDir: string, fs: FileSystem, audit: AuditLog);
  write(msg: InboxMessage, extraFields?: Record<string, string>): Promise<void>;
}

export interface InboxMessageOptionsBase {
  type: string;
  body: string;
  priority?: 'low' | 'normal' | 'high' | 'critical';
}

export type InboxMessageMeta = Record<string, string>;

// 读侧 — 排空 + peek + 归档
export class InboxReader {
  constructor(pendingDir: string, doneDir: string, failedDir: string, fs: FileSystem, audit: AuditLog);
  init(): Promise<void>;                                // 启动期 ensureDir 三子目录
  drainInbox(): Promise<InboxEntry[]>;                  // 排空 pending → 返 entries
  peekMetas(filter?: { priority?: ('critical' | 'high' | 'normal' | 'low')[] }): Promise<InboxMessageMeta[]>;
  markDone(filePath: string): Promise<void>;            // pending → done
  markFailed(filePath: string): Promise<void>;          // pending → failed
}

export interface InboxEntry {
  filePath: string;
  meta: Record<string, string>;
  body: string;
}

// 工厂
export function createInboxReader(fs: FileSystem, audit: AuditLog, baseDir: string): InboxReader;
export function createOutboxWriter(clawId: string, clawDir: string, fs: FileSystem, audit: AuditLog): OutboxWriter;

// 跨进程通知 helpers (standalone 函数 / 不持状态)
export function notifyInbox(targetClawDir: string, fs: FileSystem, audit: AuditLog, message: InboxMessageOptionsBase): Promise<void>;
export function notifySystem(systemDir: string, fs: FileSystem, audit: AuditLog, message: InboxMessageOptionsBase): Promise<void>;

// 错误类
export class InboxListFailed extends Error {
  readonly cause: unknown;
}

export class InboxMoveFailed extends Error {
  readonly op: InboxMoveOp;
  readonly filePath: string;
  readonly cause: unknown;
}

export type InboxMoveOp = 'mark_done' | 'mark_failed';
export type InboxMetaError = { filePath: string; reason: string };
```

**使用语义**：

- 实然不立单一 `Messaging` interface / 按读写双侧 + 写自己 vs 写他人 拆 3 class（消费方按需 inject 子集 / 不必全 inject）
- `OutboxWriter` 写自己 outbox / claw 视角 / motion 异步 pull
- `InboxWriter` 写他人 inbox / motion 视角 / D11 单向访问 / motion-only profile
- `InboxReader` 排空 / peek / 归档 / 任何 daemon 自身收件箱
- `peekMetas` 非消费型读取（不删 / 不移文件 / 仅 frontmatter parse）
- `drainInbox` 按到达顺序排空 / caller 自治 priority 排序
- `markDone` / `markFailed` mv pending 文件 → done / failed 子目录（不删除 / 按大小归档）
- 跨进程通知用 `notifyInbox` / `notifySystem` standalone 函数（不需 instance）
- 损坏消息（meta parse 失败 / 路径越界）失败返 InboxMetaError 数组（drainInbox 部分成功）

**归本模块**：clawforum 跨 agent 文件通信持久化的唯一入口。业务模块要做跨 agent 通信必经本模块。

**不归本模块**：

- 业务消息语义（消息内容含义、业务路由），归各调用方
- 实时通道（在线送达、连接管理），归 L1 Transport
- agent 身份解析（target id 怎么映射到目录），调用方装配期决定
- 优先级策略（哪类消息优先），调用方提供排序参数

**不可消除耦合理由**：M#2 业务语义归属（跨 agent 持久化通信加投递语义归本模块）加 M#3 资源唯一归属（inbox 加 outbox 文件目录是单一磁盘资源）derive 自 Design Principle「磁盘即权威」加 D10「多个 claw 智能体的信息不应当隔绝」— 跨 agent 通信必经本模块文件持久化让收件人离线时不丢消息。

---

## SkillSystem [capability, DI]

**生产方**：`l2_skill_system`

**消费方**：

- `l6_assembly`（DI，装配期扫描加注入）
- `l5_runtime`（DI，每轮 dispatch 上下文摘要 / ContextInjector 内部组件）
- `l4_task_system`（DI，任务执行期加载 skill 内容）
- `l4_evolution_system`（DI，retro 完成后调 reload 触发 rescan）
- `l3_sub_agent`（DI，子代理装配期上下文摘要）
- `l2_skill_tool`（DI，skill 工具按名加载完整内容）

**接口签名**：

```ts
export class SkillSystem {
  constructor(fs: FileSystem, skillsDir: string, audit?: AuditLog);
  loadAll(): Promise<void>;                            // 启动期扫描 skillsDir 加载所有元信息（caller 必须 await）
  register(skillDir: string): Promise<SkillMeta>;      // 手动注册单个技能
  listMeta(): SkillMeta[];                             // 同步返当前注册表元信息
  loadFull(name: string): Promise<string>;             // 按名加载完整 SKILL.md 内容（返 raw markdown）
}

export interface SkillMeta {
  name: string;
  description: string;
  version: string;
  skillDir: string;     // 绝对路径
}

// 工厂
export function createSkillSystem(
  fs: FileSystem,
  skillsDir?: string,    // 默认 SKILLS_DIR_DEFAULT
  audit?: AuditLog,
): SkillSystem;

export const SKILLS_DIR_DEFAULT: string;  // 默认 skillsDir 相对路径
```

注：scan / parse 失败走 audit + skip（best-effort / 单 skill 损坏不阻 others）/ 应然不立 `SkillSystemError` class（实然走 `ToolError` 通用 / 装配方接 `LOAD_FAILED` audit event 决策）。

**使用语义**：

- ctor 仅构造 / `loadAll()` 必须显式 await 调（启动期 cold start scan）
- 渐进式披露：启动 `loadAll` 仅元信息 / `loadFull(name)` 调用时再读完整 SKILL.md 内容
- 单 skill 加载失败 audit `LOAD_FAILED` + skip（不阻 others / best-effort / 不抛）
- `register(skillDir)` 手动注册单个 / 用于 retro skill 沉淀后调（EvolutionSystem.reload 间接经此）
- `listMeta()` 同步返派生态 Map / 启动期 loadAll 后稳定 / 调用 register 增量更新
- 元信息表是运行期派生态（启动期重建 / 无需持久化）
- `loadFull` 返 raw markdown string（含 frontmatter + 正文 / caller 自决策 parse 用途）

**应然权威**：模块名 `SkillSystem` align architecture.md §14 + 表 1 权威 / 实然 code 命名 `SkillRegistry`（src/core/skill/registry.ts:22）/ 同 ShellTool 同型命名 drift 第 5 实证 / 详 [modules/l2_skill_system.md](../modules/l2_skill_system.md) §A。**实然位置**：`src/core/skill/` (L4 location for L2 module / cross-layer location drift / 推 r+1 物理迁 to `src/foundation/skill-system/`).

**归本模块**：clawforum 技能元信息注册加内容加载的唯一入口。业务模块要查或加载 skill 必经本模块。

**不归本模块**：

- skill 业务语义（skill 用途、何时调用、正文怎么用作 prompt），归各调用方业务
- 上下文摘要的注入位置加渲染策略（什么时候把 summary 拼到 prompt 哪段），归各调用方装配期决定
- agent 身份关联（哪些 skills 属于哪个 agent），调用方装配期决定

**不可消除耦合理由**：M#2 业务语义归属（技能元信息聚合加渐进式披露语义归本模块）加 M#7 耦合界面稳定（本模块 own 内部聚合算法加上下文摘要 string 形态稳定，调用方不感知聚合细节）derive 自 Philosophy「clawforum 本质是上下文工程」— 技能元信息必经本模块单源 own 让多调用方共享同一聚合视图。

---

## Tools [capability, DI]

**生产方**：`l2_tools`

**消费方**：

- `l3_step_executor`（DI，单步 tool 派发）
- `l3_agent_executor`（DI，每轮 tool 调用编排）
- `l3_sub_agent`（DI，子代理工具调用）
- `l4_task_system`（DI，任务执行期 tool 调用）
- `l4_contract_system`（DI，契约执行期 tool 调用）
- `l5_runtime`（DI，运行时 tool dispatch）
- `l6_assembly`（DI，装配期注册工具加权限矩阵）

**接口签名**（实然结构性拆分：注册表 + 派发器 双 interface）：

```ts
// 注册表 — own 工具 instances + profile 准入查询
export interface ToolRegistry {
  register(tool: Tool): void;                          // 应然 silent on 权限 / 权限走 readonly + idempotent + profile + caller filter 模型
  unregister(name: string): void;
  get(name: string): Tool | undefined;
  has(name: string): boolean;
  getAll(): Tool[];
  getForProfile(profile: ToolProfile): Tool[];         // 按 profile filter (full/subagent/miner/verifier 等)
  formatForLLM(tools: Tool[]): Array<{                 // 转 LLM tool_use schema 形态
    name: string;
    description: string;
    input_schema: JSONSchema7;
  }>;
}

export class ToolRegistryImpl implements ToolRegistry { /* ... */ }

// 派发器 — 单工具调用 + 批量并发 + 验参
export interface IToolExecutor {
  execute(options: ExecuteOptions): Promise<ToolResult>;
  executeParallel(
    batch: Array<{ toolName: string; args: Record<string, unknown> }>,
    ctx: ExecContext,
  ): Promise<ToolResult[]>;                            // readonly 工具批量并发优化
  validateArgs(toolName: string, args: Record<string, unknown>): { valid: boolean; errors?: string[] };
}

export class ToolExecutor implements IToolExecutor {
  constructor(registry: ToolRegistry, audit: AuditLog, options?: ToolExecutorOptions);
}

export interface ExecuteOptions {
  toolName: string;
  args: Record<string, unknown>;
  ctx: ExecContext;
  timeoutMs?: number;
  async?: boolean;                                      // true = 走异步路径（spawn/dispatch 等支持）
  toolUseId?: string;                                   // LLM 生成的 tool_use block id
}

export interface ToolExecutorOptions {
  defaultTimeoutMs?: number;
  // 装配期注入字段（详 src/core/tools/executor.ts:334）
}

// 工厂
export function createToolRegistry(): ToolRegistryImpl;
export function createToolExecutor(registry: ToolRegistry, audit: AuditLog, options?: ToolExecutorOptions): ToolExecutor;

// 错误类（位置 cross-cutting `src/types/errors.ts`）
export class ToolNotFoundError extends Error {
  readonly toolName: string;
}

export class ToolTimeoutError extends Error {
  readonly toolName: string;
  readonly timeoutMs: number;
}
```

注：`Tool` / `ToolResult` / `ExecContext` / `ToolProfile` / `JSONSchema7` 来自 [L2 ToolProtocol](./l2b.md#toolprotocol-type-only)（cross-ref interfaces/l2b.md）。

**使用语义**：

- 实然不立单一 `Tools` interface / 拆 `ToolRegistry` (注册表) + `IToolExecutor` (派发器) 双 interface（消费方按需 inject 子集）
- 权限模型 = `Tool` 元数据 (`readonly` + `idempotent` + `supportsAsync`) + `ToolProfile` filter (装配期 register 时 tool 含 profile 信息) + `ExecContext.callerType` 运行期检查（不是应然原 `allowedCallers: string[]` per-register-call 模型）
- 调用未注册工具抛 `ToolNotFoundError`
- 工具执行抛错原样传播（本模块不吞）
- 超时抛 `ToolTimeoutError`
- `executeParallel` readonly 工具批量并发优化（M#1 readonly 工具是 idempotent 子集）
- `validateArgs` JSON Schema 验参 (返 valid + errors)
- 调用前后 audit 写 L2 AuditLog（事件命名空间归本模块 / events 见 src/core/tools/audit-events.ts）

**应然权威**：模块名 `Tools` align architecture.md §15 + 表 1 权威。**实然位置**：`src/core/tools/` (L4 location for L2 module / 同 SkillSystem cross-layer location drift / 推 r+1 物理迁 to `src/foundation/tools/`).

**应然 silent on `ToolPermissionError`**：实然 0 PermissionError class / 权限不通过返 `ToolResult { success: false, error }` / 不抛异常 / 应然 rule 必有现实功能依据反向 / 删 `ToolPermissionError` 应然幻象。

**归本模块**：clawforum 工具注册表加派发机制的唯一入口。业务模块要调工具必经本模块。

**不归本模块**：

- tool schema 定义（type-only），归 L2 ToolProtocol
- 业务工具实现（execute 逻辑），归各业务模块
- caller 类型 universe（哪些 caller 存在），归 L6 Assembly 装配期 own
- 权限矩阵（哪个 caller 能用哪个工具），归 L6 Assembly 装配期 own 加注入
- tool_use 解析（从 LLM 响应提取），归调用方

**不可消除耦合理由**：M#1 单一职责（工具注册派发跟工具实现是独立可变职责）加 M#2 业务语义归属（工具调用统一派发加权限校验加审计语义归本模块）derive — 工具调用必经本模块单一入口让权限校验加审计集中。

---

## FileTool [capability, DI]

**生产方**：`l2_file_tool`

**消费方**：

- `l6_assembly`（DI，装配期注册到 L2 Tools）

**接口签名**：

```ts
export function createFileTools(options: FileToolOptions): Tool[];

export interface FileToolOptions {
  allowedRoots: string[];
}
```

注：`Tool` 来自 [L2 ToolProtocol](./l2b.md#toolprotocol-type-only)（cross-ref interfaces/l2b.md）。整体状态【应然 / 实然未独立目录】见 [modules/l2_file_tool.md](../modules/l2_file_tool.md) §A.1（4 工具源码当前在 `src/core/tools/builtins/{read,write,search,ls}.ts` / 应然独立目录 + `createFileTools` 工厂）。**应然 silent on `FileToolError` 错误类**（实然 0 FileToolError class / 失败返结构化 ToolResult `{ success: false, error }` / 不抛异常 / 应然 rule 必有现实功能依据反向 / 删 FileToolError 应然幻象）。

**使用语义**：

- 路径越界返 ToolResult `{ success: false, error: 'path_traversal' }` 不暴露 OS 文件错误细节给 LLM
- 目标不存在返 ToolResult（success: false，agent 可读 error 信息）
- 越界守护本模块自治（路径解析后必在 allowedRoots 内）
- 工具 schema 加 execute 实现 own 在本模块

**归本模块**：clawforum agent 文件工具的唯一定义方。文件 I/O expose 给 agent 必经本模块。

**不归本模块**：

- 文件 I/O 能力原语（read 加 write 加 list），归 L1 FileSystem
- caller 权限（哪个 caller 能用 FileTool），归 L6 Assembly 装配期 own
- 工具注册（注册到 L2 Tools 加注入派发器），归 L6 Assembly
- LLM 调用编排（tool_use 解析加调度），归 L3 StepExecutor
- 上下文 budget 加截断阈值常量（READ_MAX_LINES、WRITE_SIZE_LIMITS、版本保留份数等）来源，归 L6 Assembly 装配期 own 加注入

**不可消除耦合理由**：M#1 单一职责（agent 文件工具的上下文工程加沙盒约束加 Tool 协议封装跟 OS 文件 I/O 能力跟工具派发是独立可变职责）加 M#2 业务语义归属（OS 文件 I/O 能力翻译为 agent 工具调用的语义归本模块，含输出截断分页加大小约束加路径沙盒加 Motion 单向跨 claw 访问权加版本化备份）derive 自 Philosophy「clawforum 本质是上下文工程」加「系统为智能体服务」。

---

## CommandTool [capability, DI]

**生产方**：`l2_command_tool`

**消费方**：

- `l6_assembly`（DI，装配期注册到 L2 Tools）

**接口签名**：

```ts
export function createCommandTools(options: CommandToolDeps): CommandToolModule;

export interface CommandToolModule {
  exec: Tool;
  // 后续可扩 allowList / denyList enforcement 工具
}

export interface CommandToolDeps {
  processExec?: unknown;       // L1 ProcessExec interface 注入
  allowList?: ReadonlyArray<string>;   // 命令白名单
  denyList?: ReadonlyArray<string>;    // 命令黑名单
  defaultTimeoutMs?: number;            // 默认超时
}
```

注：`Tool` 来自 [L2 ToolProtocol](./l2b.md#toolprotocol-type-only)（cross-ref interfaces/l2b.md）。本模块不抛 CommandToolError class — blacklist 命中 + 子进程非零退出都返 ToolResult `{ success: false, error }` / 不抛异常。

**使用语义**：

- 命令黑名单命中返 ToolResult `{ success: false, error: 'command_blacklisted' }`
- 子进程非零退出返 ToolResult（success: false，含 stdout 加 stderr 加 exitCode）
- 超时抛 ToolTimeoutError（来自 L1 ProcessExec / cf interfaces/l1.md）
- shell mode 跨 OS 风险由调用方承担（来源：L1 ProcessExec 调用约束）
- 工具 schema 加 execute 实现 own 在本模块
- allowList / denyList enforcement 应然装配期注入 / 命中拒绝软失败返 ToolResult

**归本模块**：clawforum agent 命令工具的唯一定义方。命令能力 expose 给 agent 必经本模块。

**不归本模块**：

- OS 进程能力原语（exec），归 L1 ProcessExec
- caller 权限（哪个 caller 能用 CommandTool），归 L6 Assembly 装配期 own
- 工具注册（注册到 L2 Tools 加注入派发器），归 L6 Assembly
- 上下文 budget 加截断阈值常量（EXEC_MAX_STDOUT、EXEC_MAX_STDERR 等）来源，归 L6 Assembly 装配期 own 加注入
- 命令黑白名单 const（如有），归 L6 Assembly 装配期 own 加注入

**不可消除耦合理由**：M#1 单一职责（agent 命令工具的上下文工程加 Tool 协议封装跟 OS 进程能力跟工具派发是独立可变职责）加 M#2 业务语义归属（OS 进程 exec 能力翻译为 agent 工具调用的语义归本模块，含输出截断加 cwd hint 防 LLM 幻觉）derive 自 Philosophy「clawforum 本质是上下文工程」加「系统为智能体服务」。
