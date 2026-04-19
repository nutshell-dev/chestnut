# LLMService 接口契约

L1 LLM 调用的统一服务。provider 管理、请求组装、KV cache 标记透传、重试 / 超时 / failover / circuit breaker。

归属：L1 原语。依赖：无（定义 `LLMEventSink` 协议，由装配层注入实现，不反向依赖 L2）。被调用：StepExecutor（唯一消费者）。定义的协议：`LLMEventSink`（失败 / 退避 / breaker 状态迁移 / failover 切换事件的发布协议）。

## 职责边界

### 做

1. `call`（一次性调用，返回 `LLMResponse`）与 `stream`（流式，吐 `StreamChunk` 序列）
2. Primary + fallbacks[] 多 provider 配置；primary 失败按 `maxAttempts` 指数退避重试（上限 30s），耗尽后顺序尝试 fallbacks
3. 可选 circuit breaker：单 provider 连续失败 ≥ threshold 进入 open，冷却 `resetTimeoutMs` 后 half-open 允许一次探测
4. 流式中途错误隔离：已 yield 过 chunk 时吐 `reset` chunk 让调用方丢弃部分内容，再切下一个 provider
5. 统一 abort：`AbortError` 不重试、原样抛出（用户中断优先于容错）
6. `getProviderInfo()`：报告当前活跃 provider 与是否为 fallback
7. `healthCheck()`：用 `maxTokens=1` 最小请求探测 primary 可达性
8. provider 异构封装：Claude SDK / Anthropic-兼容 / OpenAI / Gemini 四类 adapter；API format 通过 preset 解析

### 不做

- 不管 message 语义（assistant / tool_use / tool_result 的排列规则归 StepExecutor / Message 类型层）
- 不管 tool 执行（LLMService 只把 tool_use 作为 chunk 吐出，handler 归 StepExecutor）
- 不做 token 计费 / 预算管控
- 不做模板组装（system prompt / messages 由调用方传完整内容）
- 不持久化请求 / 响应（审计归 AuditLog，stream 事件归 L2 Stream）
- 不实现 KV cache 策略本身（`cache_control` 标记由调用方放入 messages；LLMService 只转发）

## 接口

```ts
interface LLMService {
  call(options: LLMCallOptions): Promise<LLMResponse>;
  stream(options: LLMCallOptions): AsyncIterableIterator<StreamChunk>;
  healthCheck(): Promise<boolean>;
  getProviderInfo(): { name: string; model: string; isFallback: boolean };
  close(): Promise<void>;
}

interface LLMServiceConfig {
  primary: ProviderConfig;
  fallbacks?: ProviderConfig[];              // 0..N，按顺序尝试
  maxAttempts: number;                        // primary 总尝试次数（含初次）
  retryDelayMs: number;                       // 指数退避基数；上限 30_000ms
  events: LLMEventSink;                       // 必传；装配层把事件 fan-out 到 AuditLog / Stream
  circuitBreaker?: {                          // 可选；缺省不启用
    failureThreshold: number;
    resetTimeoutMs: number;
  };
}

interface LLMEventSink {
  emit(event: LLMEvent): void;                // 非阻塞；实现方自负错误隔离
}

type LLMEvent =
  | { type: 'provider_attempt_failed'; provider: string; attempt: number; error: string }
  | { type: 'retry_scheduled'; provider: string; attempt: number; backoffMs: number }
  | { type: 'provider_exhausted'; provider: string; error: string }
  | { type: 'fallback_switched'; from: string; to: string; reason: string }
  | { type: 'breaker_opened'; provider: string; consecutiveFailures: number }
  | { type: 'breaker_half_open'; provider: string }
  | { type: 'breaker_closed'; provider: string }
  | { type: 'healthcheck_failed'; provider: string; error: string }
  | { type: 'stream_reset'; provider: string; error: string };

interface LLMCallOptions {
  messages: Message[];
  system?: string;
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  model?: string;                             // 覆盖 provider 默认
  timeoutMs?: number;
  signal?: AbortSignal;                       // abort 立即抛出不重试
}

interface StreamChunk {
  type:
    | 'text_delta' | 'thinking_delta' | 'thinking_signature'
    | 'tool_use_start' | 'tool_use_delta'
    | 'done'
    | 'reset'                                 // 中途失败，丢弃部分状态，准备切 provider
    | 'provider_failed';                      // 某 provider 彻底失败，已切下一个
  delta?: string;
  toolUse?: { id: string; name: string; partialInput?: string };
  usage?: { inputTokens: number; outputTokens: number };
  signature?: string;                         // thinking 块签名
  stopReason?: string;                        // 仅 'done' 有
  provider?: string;                          // 'reset' / 'provider_failed' 有
  timeoutMs?: number;
  error?: string;
  model?: string;
}
```

关键约定：
- `call` 与 `stream` 是两条独立路径，调用方按需选用
- `AbortError` 在任何位置都**不重试**直接抛（用户中断优先）
- `stream` **未 yield 任何 chunk 前**的错误走重试；**已 yield 过 chunk** 的错误走 failover（吐 `reset` 再切 provider）
- 实际 retry delay = `min(retryDelayMs * 2^attempt, 30_000)`
- Circuit breaker `resetTimeoutMs` 到期进入 half-open，一次探测；探测失败立即回 open

## 失败语义

| 失败源 | LLMService 行为 |
|---|---|
| Provider 抛普通错（网络/超时/5xx） | `events.emit('provider_attempt_failed')`；`attempt < maxAttempts` emit `retry_scheduled` 后指数退避重试；否则 emit `provider_exhausted` + `fallback_switched`，计入 CB 失败、切下一个 provider |
| Provider 抛 `AbortError` | 立即原样抛出，**不重试、不切 fallback**，不 emit 事件 |
| Primary 所有尝试耗尽 | `events.emit('provider_exhausted')` + `fallback_switched`，继续 fallbacks |
| Fallback 抛错 | `events.emit('provider_exhausted')` + `fallback_switched`（若有下一个），继续下一个 fallback |
| 所有 provider 失败 | 抛 `LLMAllProvidersFailedError`，携带完整 `Array<{provider, error}>`（错误列表已通过 events 连续 emit，异常仅作为最终失败信号） |
| Circuit breaker open 状态下的 provider | 跳过，计入 failures；stream 模式 yield `provider_failed` chunk（事件层在进入 open 时已 emit `breaker_opened`，跳过本身不再 emit） |
| `stream` 中途错误（已 yield 过 chunk） | `events.emit('stream_reset')` + yield `reset` chunk，**不重试**该 provider，切下一个 |
| `stream` 正常完成但 0 chunk | 视为失败（`breaker.onFailure()`），emit `provider_attempt_failed`，yield `provider_failed`，切下一个 |
| `healthCheck` 抛错 | 捕获后 `events.emit('healthcheck_failed')`，返回 `false`；不抛 |
| `close()` | 当前 fetch-based 实现 no-op |

## 事件清单（LLMEventSink）

| type | 触发时机 | 载荷字段 |
|---|---|---|
| `provider_attempt_failed` | provider.call/stream 抛普通错 | `provider, attempt, error` |
| `retry_scheduled` | attempt 未耗尽、进入退避前 | `provider, attempt, backoffMs` |
| `provider_exhausted` | 某 provider 重试耗尽 / circuit open 跳过 | `provider, error` |
| `fallback_switched` | 切到下一个 provider 瞬间 | `from, to, reason` |
| `breaker_opened` | 连续失败达 threshold 进入 open | `provider, consecutiveFailures` |
| `breaker_half_open` | resetTimeoutMs 到期放探测 | `provider` |
| `breaker_closed` | 探测成功恢复 | `provider` |
| `healthcheck_failed` | healthCheck 抛错（捕获后） | `provider, error` |
| `stream_reset` | stream 已 yield 过 chunk 后失败 | `provider, error` |

**归属**：`LLMEventSink` 协议由 LLMService 定义（承担业务语义）。装配层（Daemon）实现此协议把事件 fan-out 到 AuditLog（落盘审计）与 Stream（实时暴露），LLMService 不反向 import L2。

**错误隔离政策**：`LLMEventSink` 实现方自行保证 emit 不抛、不阻塞 LLM 主路径；若实现内部失败，必须在实现内消化（如 AuditLog adapter 走 `[AUDIT CRITICAL]` 递归边界）。

## 不可消除的耦合

- **无跨模块运行时耦合**（L1 原语，唯一消费者 StepExecutor；`LLMEventSink` 协议由本模块定义，实现由装配层注入，依赖方向仍向下）。
- **类型层共享**：`Message` / `ToolDefinition` / `LLMResponse` 定义在 `src/types/message.ts`，与上层共享类型——非运行时耦合。
- **provider 异构吸收**：四类 adapter（anthropic / custom-anthropic / openai / gemini）是"外部协议差异"这一不可消除耦合的封装点；契约层只描述行为等价性（call / stream），不暴露协议差异。

## 配置常量归属

| 常量 / 字段 | 归属 | 说明 |
|---|---|---|
| `maxAttempts` / `retryDelayMs` / `circuitBreaker.*` | `LLMServiceConfig`（调用方传入） | 装配期由 Daemon 决定 |
| 指数退避上限 30_000ms | 内部硬编码 | 保护 agent 等待上限 |
| `healthCheck` 的 `maxTokens=1` | 内部硬编码 | 最小探活请求 |

## 术语去歧义

LLMService 的 `StreamChunk` / `stream()` 属本模块内部概念（LLM 流式事件），**与 L2 Stream 模块（stream.jsonl 事件流）无直接关系**。命名相撞源于 "streaming" 一词的通用性，契约显式澄清以避免阅读者混淆。

## 与现状的差异（含 Design Principles 违规登记）

### A. 必修违规

**A.1 失败日志走 `console.warn` 非结构化**（修复方向已定，待实施）

违反原则："事后仅凭日志和记录，能完整重建任一时刻的运行状态和决策链路"。provider 失败、breaker 跳过、healthCheck 失败等关键事件仅走 `console.warn`，文本未结构化、未落盘。

**A.3 重试退避期对调用方沉默**（修复方向已定，待实施）

违反原则："用户可以观察运行过程中的所有状态"。`await delay(backoffMs)` 最长 30s 期间调用方看不到任何信号。

**A.1 + A.3 统一修复方向**

LLMService 定义 `LLMEventSink` 协议（归属承担业务语义的模块），构造期必传 `events: LLMEventSink`；事件类型见"事件清单"节。装配层（Daemon）实现此协议，把事件同时 fan-out 到 AuditLog（落盘审计，解决 A.1）与 Stream（实时暴露，解决 A.3）。`console.warn` 清零。

为何协议归 LLMService 而非直接依赖 AuditLog / Stream：L1 原语不得反向依赖 L2（违反"依赖单向，底层不预设上层语义"），协议归属定义方、实现由装配层注入，与 `ToolHandler` / `AbortSignal` / `StreamCallbacks` 归属模式一致。

### B. 偏差登记（当前合理或代价过高）

- **`reset` chunk 属显式丢弃决策**：mid-stream 已 yield 的内容被调用方丢弃（provider 切换后内容不连续）。属于**显式设计决策**的信息丢弃路径，**符合**"未经显式设计决策不得丢弃"的反面条件，不是违规。
- **Circuit breaker 状态仅在内存**：进程重启 breaker 计数归零。原则"持久化一切信息到磁盘"的语境是**可审计 / 可恢复的运行状态**（messages、stream event、审计），breaker 是短期容错控制状态，重启重建不损失决策链路信息。若未来发现 provider 故障期间 daemon 反复重启导致刷爆 provider，再评估落盘。
- **`createProvider` 双形态入参**：`if ('stream' in config && typeof config.stream === 'function') return config` 把预构建 `ProviderAdapter` 直接当 `ProviderConfig` 用（鸭子测试），轻微违反"耦合界面稳定"。当前为测试注入点；未来考虑抽独立 factory hook 或 `LLMServiceConfig.adapterFactory?` 显式化。
- **`StreamChunk.type` union 扩张原则**：近期新增 `reset` / `provider_failed`。chunk type 扩张应遵循"**非破坏加法**"——新 type 对旧消费者必须 safe-ignore，不得把新 type 作为正确性必需条件。契约登记以便未来新增 type 时遵守。
- **`healthCheck` 失败返回 false 而非抛错**：与 `call` / `stream` 语义不对称，但调用方通常是 Daemon 启动期可选探测，沉默 false 合理。
- **`LLMService` interface 位置分裂**：interface 写在 `index.ts`，`LLMServiceImpl implements LLMService` 又回 import types——历史遗留，可清理不紧急。

## 测试覆盖（验证行为契约）

- `tests/foundation/llm.test.ts`（52 `it`）：核心 request 组装 / preset 解析 / 四类 adapter（Claude SDK / Anthropic / OpenAI / Gemini）/ tool_use chunk 吐出 / AbortError 不重试 / cache_control 透传。
- `tests/foundation/llm-service.test.ts`（14 `it`）：primary + fallbacks[] 顺序 / 指数退避与 30s 上限 / breaker open→half-open→close 状态迁移 / 流式中途错误 `reset` chunk / `getProviderInfo()` / `healthCheck()` 最小探测。
- `tests/foundation/llm-presets.test.ts`（13 `it`）：preset 字段解析 / API format 分派 / 未知 preset 错误。
- `tests/foundation/anthropic-cache.test.ts`（12 `it`）：system + tools + messages 全链路 `cache_control` 透传不失真。

**覆盖缺口**（对应 A.1/A.3 修复方向）：
- `LLMEventSink.emit` 在每类失败路径的调用次数与 payload 断言（provider_attempt_failed / retry_scheduled / provider_exhausted / fallback_switched / breaker_*）。
- `healthcheck_failed` / `stream_reset` 事件断言。
- 装配层 fan-out 到 AuditLog + Stream 的集成测试（跨模块，归 Daemon 装配契约而非 LLMService 单测）。
