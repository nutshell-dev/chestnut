# Interfaces L2b — LLM 协议层基础设施接口

4 模块：DialogStore、Stream、LLMOrchestrator、ToolProtocol。

模板加字段说明见主索引 [interfaces.md](../interfaces.md)。

---

## 共享 type 定义

LLM 协议层 type（Message / TextBlock / ToolUseBlock / ToolResultBlock / LLMCallOptions / LLMResponse / StreamChunk / ToolDefinition）**归 L1 LLMProvider own**（provider 异构吸收的一部分 / 详 [interfaces/l1.md](./l1.md#llmprovider-capability-di) LLMProvider 节）。

L2 模块（DialogStore + Stream + LLMOrchestrator）+ L3 模块（StepExecutor + AgentExecutor + SubAgent）均 import L1 LLMProvider type。

---

## DialogStore [capability, DI]

**生产方**：`l2_dialog_store`

**消费方**：

- `l3_agent_executor`（DI，每次 LLM 调用后落盘加启动期恢复）

**接口签名**：

```ts
export class DialogStore {
  constructor(fs: FileSystem, dialogDir: string, audit: AuditLog, clawId: string);
  load(): Promise<LoadResult>;
  save(messages: Message[]): Promise<void>;
  archive(): Promise<void>;
  static repair(
    messages: Message[],
    opts?: { interruptionMessage?: string },
  ): { repaired: Message[]; toolCount: number };
}

export interface LoadResult {
  session: SessionData;
  source: 'current' | 'archive' | 'empty';
}

export interface SessionData {
  version: number;
  clawId: string;
  createdAt: string;     // ISO 8601
  updatedAt: string;     // ISO 8601
  messages: Message[];
}

// 工厂
export function createDialogStore(
  fs: FileSystem,
  dialogDir: string,
  audit: AuditLog,
  clawId: string,
): DialogStore;
```

**使用语义**：

- 读失败原样抛错（fs error / JSON parse error 不裹）
- 写失败原样抛错（磁盘是权威 / 调用方必须显式处理）
- 损坏文件自动隔离到 corrupted 子目录加 audit
- `static repair(messages, opts?)` 悬空 tool_use 配对修复（纯函数 / 与 IO 解耦 / 调用方传 `interruptionMessage` 解释中断原因 / 默认「Cause unknown (no context provided to repair).」/ 返 `{ repaired, toolCount }`）
- LoadResult 包 `SessionData` 完整对象（含 version + clawId + createdAt + updatedAt + messages / 不直接返 messages）

**应然权威**：模块名 `DialogStore` align architecture.md §9 + 表 1 权威。**实然 code 用 `SessionManager` 名（src/foundation/session-store/store.ts:22 / `session-store/` 目录 / `@module L2.SessionStore`）**：登记 code drift / 详 [modules/l2_dialog_store.md](../modules/l2_dialog_store.md) §A。

**归本模块**：clawforum messages 数组持久化的唯一入口。业务模块要持久化 dialog 必经本模块。

**不归本模块**：

- 业务内容判读（message 内的 text、tool_use 内容含义），归调用方
- agent 身份关联（哪个 claw 的 dialog、子代理 dialog），调用方决定
- 跨 dialog 关联（父代理与子代理 dialog 关系），归 L4 TaskSystem
- archive 策略（归档触发时机加保留策略），调用方决定

**不可消除耦合理由**：M#3 资源唯一归属（messages 数组持久化是单一资源）加 Design Principle「磁盘即权威」加「运行中断即从最后一次完整 LLM 调用恢复状态并继续」derive — dialog 状态必经本模块持久化。

---

## Stream [capability, DI]

**生产方**：`l2_stream`

**消费方**：所有需要发布或订阅或回放执行过程事件的模块（写侧加读侧）

**接口签名**（实然结构性拆分：Writer + Reader + readAll）：

```ts
// 写侧
export interface StreamLog {
  write(event: StreamEvent): void;
}

export class StreamWriter implements StreamLog {
  constructor(fs: FileSystem, audit: AuditLog, retention?: StreamRetentionOptions);
  open(): void;        // 启动期归档旧文件 + prune
  write(event: StreamEvent): void;
  close(): void;       // idempotent
}

export interface StreamRetentionOptions {
  maxFiles?: number | null;
  maxDays?: number | null;
}

// 读侧
export interface StreamReader {
  start(): void;       // throws if already started
  stop(): Promise<void>;  // idempotent
  isActive(): boolean;
}

export function createStreamReader(
  fs: FileSystem,
  streamPath: string,
  onEvent: (event: StreamEvent) => void,
  audit: AuditLog,
  options?: { persistent?: boolean },
): StreamReader;

// 一次性历史读
export function readAll(
  fs: FileSystem,
  streamPath: string,
  audit: AuditLog,
): Promise<StreamEvent[]>;

// 工厂
export function createStreamWriter(
  fs: FileSystem,
  audit: AuditLog,
  retention?: StreamRetentionOptions,
): StreamWriter;

// 事件 schema
export interface StreamEvent {
  ts: number;            // unix ms timestamp
  type: string;
  [key: string]: unknown;  // payload 平铺（不嵌套 payload field）
}

// 常量
export const STREAM_FILE: string;          // 'stream.jsonl' 相对路径
export const LLM_OUTPUT_EVENTS: ReadonlySet<string>;  // {'thinking_delta','text_delta','tool_call'} / Watchdog + chat-viewport 用
```

**使用语义**：

- StreamWriter `open()` 启动期归档旧 `stream.jsonl` → `logs/stream/stream.<ts>.jsonl` + prune (maxFiles/maxDays) + 失败写 `session_boundary` event
- StreamWriter `write()` 必须先 `open()` 否则抛错；写失败 best-effort 转 audit `STREAM_APPEND_FAILED`
- StreamReader `createStreamReader` 工厂 = 订阅模式：FileWatcher (stability='immediate') + 字节安全增量读 + StringDecoder 跨 chunk UTF-8 边界 + 连续 parse 失败 ≥ 5 次 / 10 次窗口失败比 > 50% 触发 `STREAM_READER_CORRUPT` 自动停
- 历史读用 `readAll(fs, path, audit)` 一次性 (parse failures audit + skip / read failures audit + throw)
- 事件追加写不可篡改（已写事件不可修改或删除）
- 跨进程订阅者用 `createStreamReader` (内部 own FileWatcher) / 不暴露 parseBytes 公共 API（StringDecoder 字节安全在 reader 内部封装）

**应然 silent on `parseBytes` 公共方法**（应然幻象 / 实然不暴露 / 字节安全 parse 仅 reader 内部用）/ **`StreamError` 应然幻象 / 实然不存在**（read/parse 失败走 audit + error throw）/ **`Subscription` 类型应然幻象**（实然 stop()/isActive() 在 StreamReader 上）。

**归本模块**：clawforum 执行过程事件流持久化加订阅加回放的唯一入口。业务模块要发布或订阅执行过程事件必经本模块。

**不归本模块**：

- 业务 event 语义（哪个 event 表示什么业务状态），归各调用方自治
- agent 身份关联（事件归属哪个 claw），调用方决定
- 跨 stream 关联（父代理与子代理 stream 关系），归调用方

**不可消除耦合理由**：M#3 资源唯一归属（执行过程事件流是单一资源）加 Design Principle「状态可观察」加「事后可审计」derive — 执行过程事件必经本模块统一格式让跨进程消费者可订阅加回放。

---

## LLMOrchestrator [capability, DI]

**生产方**：`l2_llm_orchestrator`

**消费方**：

- `l3_step_executor`（DI，单步 LLM 调用）

**接口签名**：

```ts
export interface LLMOrchestrator {
  call(options: LLMCallOptions): Promise<LLMResponse>;
  stream(options: LLMCallOptions): AsyncIterableIterator<StreamChunk>;
  healthCheck(): Promise<boolean>;
  getProviderInfo(): { name: string; model: string; isFallback: boolean };
  close(): Promise<void>;
}

// LLMCallOptions 来自 L1 LLMProvider（详 interfaces/l1.md / LLMOrchestrator 透传给 underlying LLMProvider.call/stream）

export interface LLMOrchestratorConfig {
  primary: ProviderConfig;
  fallbacks?: ProviderConfig[];
  maxAttempts: number;     // 含初始调用 + retry
  retryDelayMs: number;    // exponential backoff base
  events: LLMEventSink;
  circuitBreaker?: { failureThreshold: number; resetTimeoutMs: number };
}

export interface ProviderConfig {
  name: string;
  apiKey: string;
  baseUrl?: string;
  model: string;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  thinking?: boolean;
  thinkingBudgetTokens?: number;
  thinkingMode?: 'adaptive' | 'enabled';
  thinkingEffort?: 'low' | 'medium' | 'high';
  reasoningEffort?: 'low' | 'medium' | 'high';
  extraHeaders?: Record<string, string>;
  dropThinkingBlocks?: boolean;
  apiFormat: ApiFormat;    // 来自 L1 LLMProvider presets
}

// StreamChunk 来自 L1 LLMProvider（详 interfaces/l1.md / LLMOrchestrator 透传 underlying LLMProvider.stream() chunk）

// LLM 事件协议（结构化 observability / 装配方 inject sink 实现 fan-out 到 audit + stream + UI）
export type LLMEvent =
  | { type: 'provider_attempt_failed'; provider: string; attempt: number; error: string }
  | { type: 'retry_scheduled'; provider: string; attempt: number; backoffMs: number }
  | { type: 'provider_exhausted'; provider: string; error: string }
  | { type: 'fallback_switched'; from: string; to: string; reason: string }
  | { type: 'breaker_opened'; provider: string; consecutiveFailures: number }
  | { type: 'breaker_half_open'; provider: string }
  | { type: 'breaker_closed'; provider: string }
  | { type: 'healthcheck_failed'; provider: string; error: string }
  | { type: 'stream_reset'; provider: string; error: string }
  | { type: 'stream_parse_error'; provider: string; raw: string; error: string }
  | { type: 'idle_failover_triggered'; provider: string; ms: number }
  | { type: 'context_exceeded_failover'; provider: string; stopReason: string };

export interface LLMEventSink {
  emit(event: LLMEvent): void;  // implementations 不能抛错
}

// 工厂
export function createLLMOrchestrator(config: LLMOrchestratorConfig): LLMOrchestrator;

// 错误类
export class LLMOrchestratorError extends Error {
  readonly code: 'all_providers_failed' | 'context_exceeded' | 'max_tokens' | 'aborted' | 'unknown';
}

export class LLMAllProvidersFailedError extends Error {
  readonly failures: Array<{ provider: string; error: string }>;
}

export class LLMTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly provider: string;
}
```

注：`LLMResponse` / `Message` / `ToolDefinition` / `StreamChunk` / `LLMCallOptions` 来自 [L1 LLMProvider](./l1.md#llmprovider-capability-di)（LLM 协议层 type 单源 / provider 异构吸收的一部分）。`ApiFormat` 同来自 L1 LLMProvider presets。

**使用语义**：

- 协议层错误（如 max_tokens 续写、context_exceeded 等）由本模块识别 + 触发 failover / context_exceeded_failover event
- 全 provider 失败抛 `LLMAllProvidersFailedError` (含 failures 数组)
- 单 provider 超时抛 `LLMTimeoutError`
- `healthCheck()` 简化返 boolean（应然 silent on rich `HealthStatus` 类型 / impl 实然只需「primary 可用与否」）
- `close()` 释放底层 provider 资源 (HTTP keepalive 等)
- `getProviderInfo()` 返当前正在用的 provider 信息（fallback 后会变）
- 调用方看到 final response 加业务级错误（不感知协议层 noise）
- LLMEventSink 是装配期注入的 fan-out 出口（audit + stream + UI 各自订阅）

**归本模块**：clawforum LLM 调用协议层封装的唯一入口。业务模块调 LLM 必经本模块（调用方看到的是协议层 noise 已隔离的结果）。

**不归本模块**：

- LLM 内容解析（messages 加 tool_use 加 token 内容），归调用方
- 业务级错误决策（如何应对协议错误），归调用方（如 L3 AgentExecutor）
- agent 业务策略（重试边界、abort 时机），调用方提供参数
- dialog 持久化，归 L2 DialogStore
- 事件分类，归 L2 Stream

**不可消除耦合理由**：M#1 单一职责（容错协调跟 provider 调用是不同职责）加 M#3 资源唯一归属（多 provider 协调加协议层错误识别是单一职责）。

---

## ToolProtocol [type-only]

**生产方**：`l2_tool_protocol`

**消费方**：

- `l2_tools`（type 依赖，注册加派发）
- 所有实现 Tool 协议的业务模块（type 依赖）：FileTool、CommandTool、Messaging、SkillSystem、TaskSystem、ContractSystem、Gateway、MemorySystem、CLI

**接口签名**：

```ts
export interface Tool {
  name: string;
  description: string;
  schema: JSONSchema7;
  readonly: boolean;             // 只读工具（无副作用 / 可批量并发）
  idempotent: boolean;           // 多次调用结果相同（只读工具均为 true / 写工具可独立标记）
  supportsAsync?: boolean;       // 是否支持异步调用模式（默认 false）
  execute(args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult>;
}

export interface ToolResult {
  success: boolean;
  content: string;
  error?: string;                // 失败原因 (success=false 时 caller 用)
  metadata?: {
    filesAffected?: string[];
    durationMs?: number;
    [key: string]: unknown;
  };
}

// 执行上下文 — 应然非 generic / 装配期固定字段集（L4+ 业务工具 caller universe 共享）
export interface ExecContext {
  clawId: string;
  clawDir: string;
  contractId?: string;
  callerType: CallerType;
  fs: FileSystem;
  llm?: LLMOrchestrator;
  profile: ToolProfile;
  stepNumber: number;
  maxSteps: number;
  signal?: AbortSignal;
  subagentMaxSteps?: number;     // 派 subagent 时透传
  dialogMessages?: Message[];    // dispatch 工具读 (Runtime._runReact 注入)
  originClawId?: string;         // 创建链路源头 (motion 直创 = 'motion')
  readonly isMotionChain: boolean;
  getElapsedMs(): number;
  incrementStep(): void;
  auditWriter?: AuditLog;
}

export type CallerType = string;          // 装配期定义 caller universe (实然 'motion' | 'claw' | 'subagent' | 'verifier' | 'miner' 等)
export type ToolProfile = string;         // 装配期定义 profile universe (实然 'full' | 'subagent' | 'miner' | 'verifier' 等)
export type JSONSchema7 = Record<string, unknown>;  // JSON Schema Draft 7
```

注：`Message` / `ToolDefinition` 来自 [L1 LLMProvider](./l1.md#llmprovider-capability-di)（LLM 协议层 type 单源）。

**使用语义**：

- 纯 type-only schema，无 runtime
- 业务模块 own 自己工具的 execute 实现
- ExecContext 字段集由 L6 Assembly 装配期固定（不是 generic Record / 实然有强类型字段集）
- Tool 元数据 `readonly` + `idempotent` + `supportsAsync` 用于派发优化（readonly 工具批量并发 / supportsAsync 路由）
- `schema` field（不是 `inputSchema` / 应然 align 实然名）
- ToolResult 加 `error?` field 给失败诊断

**归本模块**：clawforum LLM 工具调用协议 schema 的唯一定义方。所有业务工具实现此协议接入。

**不归本模块**：

- 工具注册管理（runtime 注册表），归 L2 Tools
- caller 权限决策（哪个 caller 能用哪个工具），归 L6 Assembly 装配期 own 加注入 L2 Tools
- 调用派发（tool_use 派发到 handler 加超时加 audit），归 L2 Tools
- 业务工具实现，归各业务模块

**不可消除耦合理由**：M#3 资源唯一归属（LLM tool calling 协议是单一 schema）加 M#7 耦合界面稳定（业务模块加 Tools 框架都依赖此 schema 形状）derive — schema 单源 own 让业务模块可独立实现。
