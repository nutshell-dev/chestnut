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
  // phase 709 reframe: LLM call snapshot store / save 接受完整 snapshot / ctor 不再锁定 systemPrompt
  constructor(
    fs: FileSystem,
    dialogDir: string,
    audit: AuditLog,
    filename: string,                  // phase 450: 必填 caller 注入
    clawId?: string,                   // phase 450: 可选
    archiveDir?: string,               // phase 450: 可选 / 缺省 'archive'
  );

  // phase 709: 删除 readonly systemPrompt 字段（推翻 phase 466 instance lifetime 锁定 / regime hash detection 移 caller）

  load(): Promise<LoadResult>;

  // phase 709: save 签名扩 / 接受完整 LLM call snapshot（3 件一组同源 atomic write）
  save(snapshot: {
    systemPrompt: string;              // caller 每 turn 传 latest（不锁定）
    messages: Message[];
    toolsForLLM: ToolDefinition[];     // phase 709 NEW: LLM API call tools 参快照
  }): Promise<void>;

  archive(): Promise<void>;                                        // current → archive/<ts>.json
  restorePrefix(marker: DialogMarker): Promise<RestoreResult>;     // phase 466 / phase 709 含 toolsForLLM
  static repair(
    messages: Message[],
    opts?: { interruptionMessage?: string },
  ): { repaired: Message[]; toolCount: number };
}

export interface DialogMarker {
  clawId: string;
  toolUseId: string;
}

export interface RestoreResult {
  messages: Message[];                  // marker 时刻 messages 切片（含 marker 那条 assistant message）
  systemPrompt: string;                 // marker 时刻该 SessionData 的 systemPrompt（per-turn latest snapshot / phase 709 不再 regime lifetime 锁定）
  toolsForLLM: ToolDefinition[];        // phase 709 NEW: marker 时刻该 SessionData 的 toolsForLLM snapshot
  meta: { foundIn: 'current' | 'archive'; foundFile?: string };
}

export class MarkerNotFoundError extends Error {
  readonly clawId: string;
  readonly toolUseId: string;
}

export interface LoadResult {
  session: SessionData;
  source: 'current' | 'archive' | 'empty';
}

export interface SessionData {
  version: number;       // phase 709: bump to 2（schema 加 toolsForLLM + systemPrompt 语义变 per-turn snapshot）
  clawId?: string;       // phase 450: 可选
  createdAt: string;     // ISO 8601
  updatedAt: string;     // ISO 8601
  systemPrompt: string;  // phase 709: per-turn latest snapshot（跟随 caller 每 turn save 时传入的最新值 / 推翻 phase 466 lifetime 锁定语义）
  messages: Message[];
  toolsForLLM: ToolDefinition[];  // phase 709 NEW: per-turn latest LLM API call tools 参快照
}

// 工厂（phase 709 签名同步：删 systemPrompt 必填参）
export function createDialogStore(
  fs: FileSystem,
  dialogDir: string,
  audit: AuditLog,
  filename: string,
  clawId?: string,
  archiveDir?: string,
): DialogStore;
```

**使用语义**：

- 读失败原样抛错（fs error / JSON parse error 不裹）
- 写失败原样抛错（磁盘是权威 / 调用方必须显式处理）
- 损坏文件自动隔离到 corrupted 子目录加 audit
- `static repair(messages, opts?)` 悬空 tool_use 配对修复（纯函数 / 与 IO 解耦 / 调用方传 `interruptionMessage` 解释中断原因 / 默认「Cause unknown (no context provided to repair).」/ 返 `{ repaired, toolCount }`）
- LoadResult 包 `SessionData` 完整对象（含 version + clawId + createdAt + updatedAt + systemPrompt + messages + toolsForLLM / 不直接返 messages / phase 709 含完整 LLM call snapshot）
- `archive()` = caller 业务触发（system prompt regime 切换 / 上下文压缩 / 显式 new session 等业务决策 / DialogStore 不感知触发原因）/ current.json move → archive/<ts>.json / 新 dialog 从空起点
- `restorePrefix(marker)` 扫 current.json + archive/*.json 找含 marker.toolUseId 的 SessionData / 找到则返 `{messages: 切片(0..idx+1), systemPrompt: 该 SessionData 的, toolsForLLM: 该 SessionData 的, meta}` 完整 LLM call snapshot 前缀（3 件配对一致 / phase 709 含 toolsForLLM）/ 找不到抛 `MarkerNotFoundError`（信息不丢失原则保证 marker 找得到 / 找不到 = invariant 违反）
- **regime hash detection 归 caller**（phase 709 reframe / Runtime / ContextInjector 自己比较前后 turn systemPrompt 决定是否新 regime / DialogStore 不再暴露 readonly systemPrompt 字段 / 不再 instance lifetime 锁定）→ caller 业务决策 `dialogStore.archive()` 当前 + 装配 `new DialogStore(...)` + 业务决定继承 messages 否
- **save 接受完整 snapshot atomic write**（phase 709）：每 turn LLM call 后 caller 必传 `{systemPrompt, messages, toolsForLLM}` 完整 3 件 / DialogStore 一组 atomic write current.json / 不允许部分 update（防止 3 件不同步 drift）

> **应然立场已 align 实然（phase 444 sharpen + phase 450 落地 / SHA `38f86606`）**：DialogStore 不预设上层模块语义。`filename` 必填 caller 注入 / `clawId` 可选 caller 装配选业务关联 / `archiveDir` 可选 caller 装配（缺省 'archive' subdir 保兼容）/ SessionData.clawId 0 clawId 时 schema 不含字段。

> **✅ closed by phase 466（SHA `201bc6df`）**：DialogStore 加 ctor `systemPrompt: string` 必填 / instance lifetime 锁定不变 / SessionData 加 `systemPrompt` 字段（writeAtomic 时与 messages 一起落盘）/ **1 instance = 1 system prompt regime**（system 变 = caller 业务决策新建 instance / 0 history 数组 / 0 auto-archive on system change）/ caller 业务（Runtime / ContextInjector）检测 system 变 → archive() current → new DialogStore(..., newSystemPrompt) + 业务决定继承 messages 否。`restorePrefix(marker)` 加 method 返完整前缀 `{messages, systemPrompt, meta}` / marker = `{clawId, toolUseId}` / 找不到抛 MarkerNotFoundError / 派生消费方：r53+ spawn cluster `ask_caller` 工具（per modules/l4_task_system.md §10.2）。

> **✅ closed by phase 713（SHA `1edb41d2` / 推翻 phase 466 部分应然立场）**：DialogStore 业务语义重 frame = **LLM call snapshot store**（per-turn 持久化完整 `{systemPrompt, messages, toolsForLLM}` 3 件 LLM API call snapshot）。**推翻 phase 466 立场**：(1) 删 ctor `systemPrompt` 必填参（systemPrompt 改 save 每 turn 接受 caller 传入的 latest 值 / 不再 instance lifetime 锁定）/ (2) 删 readonly systemPrompt 字段（regime hash detection 移 caller / Runtime / ContextInjector 自比较前后 turn systemPrompt）/ (3) SessionData 加 `toolsForLLM: ToolDefinition[]` 字段（per-turn snapshot / 跟随 Motion runtime 每 turn `toolRegistry.formatForLLM()` derive 的最新值）/ (4) save 签名扩 snapshot 参（atomic write 3 件同源）/ (5) restorePrefix 返完整 snapshot 含 toolsForLLM。**触发**：r70+ ask_motion 全然一致性 reuse 业务需求（subagent 端 0 重复 build systemPrompt / 0 重复 derive tools / source 单一 = Motion runtime 实然用的值 / DialogStore per-turn 持久化）。**派生消费方**：ask_motion（subagent 内 reuse motion DialogStore latest LLM call snapshot / dispatch 时刻 ≈ Motion 最近 LLM call 时刻 / snapshot 完美匹配 ask_motion frozen 业务语义）+ r53+ spawn cluster `ask_caller`（既有 / phase 466 派生 / 继续）+ dialog replay / time-travel debugging（派生扩展）。详 modules/l2_dialog_store.md §1+§4 / phase 709 design + phase 713 code 落地。

**应然权威**：模块名 `DialogStore` align architecture.md §9 + 表 1 权威（实然 code drift 见 modules §A）。

**归本模块**：clawforum dialog（广义 = systemPrompt + messages + toolsForLLM 3 件 LLM call snapshot / phase 709 reframe）持久化的唯一入口。业务模块要持久化 dialog 必经本模块。

**不归本模块**：

- 业务内容判读（message 内的 text、tool_use 内容含义），归调用方
- agent 身份关联（哪个 claw 的 dialog、子代理 dialog），调用方决定
- 跨 dialog 关联（父代理与子代理 dialog 关系），归 L4 AsyncTaskSystem
- archive 策略（归档触发时机加保留策略），调用方决定
- 持久化文件名（current.json / messages.json 等），caller 装配选

**不可消除耦合理由**：M#3 资源唯一归属（dialog 3 件 LLM call snapshot 持久化是单一资源）加 Design Principle「磁盘即权威」加「运行中断即从最后一次完整 LLM 调用恢复状态并继续」derive — dialog 状态（含 messages + systemPrompt + toolsForLLM 3 件）必经本模块持久化。

**Design-gap（跨模块 / 应然 silent / 待用户补 / phase 444 浮出 / 0 mechanical 决定）**：

DialogStore 应然立场已 align「不预设上层模块语义」（D5 + M#1）/ 但 caller 装配 DialogStore 时的业务概念归属应然层未登记。4 design-gap 待补：

| Gap | 业务概念 | 候选 own | 触发场景 |
|---|---|---|---|
| **L2.G1** 主对话 'current.json' 文件名概念 | 文件名业务约定 | 主 claw daemon caller 装配选 / subagent caller 选 'messages.json' / 待应然层登记 caller 模块 | DialogStore filename caller 注入后 / caller 各自选业务约定 / **phase 450 落地：filename 必填 caller 注入 / DialogStore 0 own** ✅ closed (caller 装配模式落地 / 业务概念应然位置 = caller 模块 own) |
| **L2.G2** clawId ↔ dialog 业务关联 | dialog 与 agent 实例的业务绑定 | 主 claw daemon caller own / subagent 用例 0 clawId（无 claw 关联）| DialogStore clawId 退化为可选 caller 业务关联后 / 谁应然 own 「dialog ↔ claw 业务关联」概念 / **phase 450 落地：clawId 可选 / SessionData.clawId 可选** ✅ closed (caller 装配模式落地 / 业务概念应然位置 = caller 模块 own) |
| **L2.G3** archive rotation 业务策略 | archive 触发时机 / 业务条件 | 主 claw daemon caller own（轮次切换 / 上下文压缩等业务判据）| ✅ **closed by γ 决策（2026-05-07）**：rotation 触发归 Runtime startup 业务 own / 实然 1 处触发（每 startup 归档 = `runtime.ts:142` `dialogStore.archive()`）/ 业务复杂度不足以独立策略层 / per M#1 反向测试（rotation/regime/装配 三者绑定 Runtime 生命周期阶段 / 不是独立可变职责）/ 应然层登记 = `l5_runtime.md §1+§2`「session lifecycle 协调」业务条 |
| **L2.G4** 主对话 session 跨进程 lifecycle 业务概念 | session 元数据演化（version/createdAt/clawId 关联/archive lifecycle）业务概念整体 | l5_runtime own（archive on startup + regime 切换 + DialogStore 装配触发由 Assembly 完成）| ✅ **closed by γ 决策（2026-05-07）**：业务归 `l5_runtime` own / 4 候选评分 γ 5/5 全通过 / 反对 β 新立 SessionManager 模块（反 M#1 非独立可变 + M#8 新表面 / 同 phase 458 ContractStatusPort STALE 推翻判据）/ 反对 δ 归 daemon（反 M#1 混业务 + M#7 边界重画）/ 反对 α 维持现状（反 M#11 应然 vs 实然偏离 implicit → explicit 不显式登记）/ Philosophy「Clawforum 本质上下文工程」+ Design Principle「智能体决策主体 / 系统提供基础设施」cross-check 一致 / 应然层登记 = `l5_runtime.md §1+§2+§7.D` |

**真合规判定**：phase 450 落地 L2.G1+L2.G2 closed（caller 装配模式实施 / 业务概念应然位置 = caller 模块 own）/ **L2.G3+L2.G4 closed by γ 决策（2026-05-07）**：业务归 l5_runtime own（startup archive rotation + regime 切换 + DialogStore 装配触发由 Assembly 完成）/ design only / 0 代码 / 不立独立 SessionManager 模块（β 反 M#1+M#8）/ 不归 Daemon（δ 反 M#1+M#7）/ 不维持现状散布（α 反 M#11）。

**L2.G5-G7 closed by 用户 8 轮 derive（2026-05-04）**：

| Gap | 答 |
|---|---|
| **L2.G5** systemPrompt 持久化形态 | **closed**: SessionData 加 `systemPrompt: string` 单字段 / DialogStore ctor 加 `systemPrompt` 必填参 / instance lifetime 锁定不变 / 1 instance = 1 system prompt regime / **0 history 数组** / **0 auto-archive on system change**（system 变是 caller 业务 / DialogStore 不感知 / caller 显式 archive() + new instance）|
| **L2.G6** marker 类型与解析 | **closed**: marker = `{clawId, toolUseId}` / `restorePrefix(marker)` 扫 current.json + archive/*.json 找含 toolUseId 的 SessionData / 找不到抛 `MarkerNotFoundError` / 派生消费方 = ask_caller 工具 |
| **L2.G7** restorePrefix 接口形态 | **closed**: 独立 async method `restorePrefix(marker): Promise<RestoreResult>` / 返 `{messages: 切片, systemPrompt: 该 SessionData 的, meta}` 完整前缀 / 与 load() 正交 |

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
- 所有实现 Tool 协议的业务模块（type 依赖 / align arch 表 3「导出工具」9 模块）：FileTool、CommandTool、Messaging、SkillSystem、AsyncTaskSystem、ContractSystem、MemorySystem、Gateway、StatusService

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
  // phase 507+ 应然 NEW（phase 509 落地）：
  workspaceDir: string;          // 装配期 per-callerType resolve / 主代理 = `<clawDir>/clawspace/` / 子代理 = `<clawDir>/tasks/subagents/<task-id>/` / 工具默认 cwd / path 根
  syncDir: string;               // 装配级共享 scratch base = `<clawDir>/tasks/sync/` / 各工具按 use case 拼子目录（CommandTool→`exec/`, FileTool→`write/`）
  fullyReadPaths: Set<string>;   // session-scoped fully-read paths set / read 未截断时 add / write overwrite gate / phase 487 G6 (a) 锁
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
