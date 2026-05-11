# LLMService 接口契约

L1 LLM 调用的统一服务。provider 管理、请求组装、KV cache 标记透传、重试 / 超时 / failover / circuit breaker。

归属：L1 原语。装配归属：按需（跑 agent 的 daemon 装）。依赖：无（定义 `LLMEventSink` 协议，由装配层注入实现，不反向依赖 L2）。被调用：StepExecutor（唯一消费者）。定义的协议：`LLMEventSink`（provider 失败 / 退避 / breaker 状态 / failover / healthcheck / stream_reset 事件的发布协议）。

**应然**（2026-04-26 修订 / 跟 modules.md §3 align）：
- 装配归属「按需」明记本节首段
- `LLMEventSink` 协议描述含 6 类事件（provider 失败 / 退避 / breaker 状态 / failover / healthcheck / stream_reset）/ 跟 modules.md §3「定义的协议」字段一致
- 对外能力清单跟 modules.md §3 align：一次性调用 / 流式调用 / 健康探测 / provider 状态查询 / primary+fallbacks 重试 / circuit breaker / abort / 中途失败 reset（详 §职责边界）

**实然**：协议事件 union 已覆盖（含 `idle_failover_triggered` 由 phase263 扩展 / 不在 modules.md 6 类列举但属同协议），对外能力 §职责边界 1-8 已含全部条目。**phase328（2026-04-26）物理迁移 `audit-sink.ts` → `src/assembly/llm-audit-sink.ts`：foundation/llm/ 0 反向 import L2（实然与应然「不反向依赖 L2」align）/ 详 §7.B B.p328-1 + §7.Phase phase328 纪律节。**

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

### 装配工厂（phase212 新增）

```ts
/**
 * 装配工厂（phase212）：Assembly 装配期复用 / 单参透传 / return interface 类型（不暴露 Impl class）
 *
 * 合入 main `5968b3a`（r8 分支 D / D.1 工厂批 1）
 */
function createLLMService(config: LLMServiceConfig): LLMService;
```

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

**消除路径首选 port pattern**（feedback_module_contract_structure r40.2）：消费方 own port + 默认实现 + assembly 注入 / phase337+335+340 三 phase 实证。LLMService 自身就是 port 范本（消费方 = StepExecutor / 协议 = LLMEventSink + LLMService interface / 装配层注入实现）。

- **无跨模块运行时耦合**（L1 原语，唯一消费者 StepExecutor；`LLMEventSink` 协议由本模块定义，实现由装配层注入，依赖方向仍向下）。
- **类型层共享**：`Message` / `ToolDefinition` / `LLMResponse` 定义在 `src/types/message.ts`，与上层共享类型——非运行时耦合。
- **provider 异构吸收**：四类 adapter（anthropic / custom-anthropic / openai / gemini）是"外部协议差异"这一不可消除耦合的封装点；契约层只描述行为等价性（call / stream），不暴露协议差异。
- **audit-sink 物理位置**（phase328 r34 C / main `430e342`）：LLMEventSink → audit 翻译实现物理迁 `src/assembly/llm-audit-sink.ts` / `src/foundation/llm/` 0 audit 残留 / L1 sharpen v2 真合规。

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

**A.1 失败日志走 `console.warn` 非结构化** ~~（修复方向已定，待实施）~~ **→ phase254 已清零**

违反原则："事后仅凭日志和记录，能完整重建任一时刻的运行状态和决策链路"。provider 失败、breaker 跳过、healthCheck 失败等关键事件仅走 `console.warn`，文本未结构化、未落盘。

**A.3 重试退避期对调用方沉默** ~~（修复方向已定，待实施）~~ **→ phase254 已清零**

违反原则："用户可以观察运行过程中的所有状态"。`await delay(backoffMs)` 最长 30s 期间调用方看不到任何信号。

**A.1 + A.3 统一修复方向**

LLMService 定义 `LLMEventSink` 协议（归属承担业务语义的模块），构造期必传 `events: LLMEventSink`；事件类型见"事件清单"节。装配层（Daemon）实现此协议，把事件同时 fan-out 到 AuditLog（落盘审计，解决 A.1）与 Stream（实时暴露，解决 A.3）。`console.warn` 清零。

为何协议归 LLMService 而非直接依赖 AuditLog / Stream：L1 原语不得反向依赖 L2（违反"依赖单向，底层不预设上层语义"），协议归属定义方、实现由装配层注入，与 `ToolHandler` / `AbortSignal` / `StreamCallbacks` 归属模式一致。

### B. 偏差登记（当前合理或代价过高）

**type 标签**（feedback_module_contract_structure r40.3）：B 项必标 `drift` vs `design-gap` 二分。
- **drift type**：契约说应 X / 实然 Y / 修法明确（推 §7.A 必修）
- **design-gap type**：应然 silent / 实然有 / 修法不明 / 必推独立 design phase 评估（不 mechanical）

> 现有 B 类历史登记 type 分类待 r43+ 应然同步 phase 批量补标。已知初判：
> - `reset` chunk 显式丢弃 = **design 决策已存**（非 drift / 非 design-gap）
> - Circuit breaker 状态仅在内存 = **design 决策已存**（trade-off）
> - `createProvider` 双形态入参 = **drift**（修法明确：抽 factory hook）
> - `StreamChunk.type` union 扩张原则 = **design 约束**（非违规登记）
> - `healthCheck` 失败返 false = **design 决策已存**
> - LLMService interface 位置分裂 = **drift**（修法明确：interface 抽独立 types 文件）
> - **B.p344-X breaker 状态机 half_open + closed events 缺失**（r42 D audit fork 新发现 / drift type / 推 r42 B 治理并轨候选）

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

## 7. 违规 / 偏差 / 原则对照 / 执行纪律

### 7.A ↔ §A 映射

本契约既有 "§A 必修违规" 节（L157-171）已登记 A.1 + A.3 + 统一修复方向（`LLMEventSink` 协议）。**phase187 实测复核**：

| console 位点 | 根因 | 映射 §A |
|---|---|---|
| `service.ts:197` primary 耗尽 | 应发 `provider_exhausted` 事件 | A.1 |
| `service.ts:221` fallback 耗尽 | 应发 `provider_exhausted` + `fallback_switched` | A.1 |
| `service.ts:256` CB skip | 应发 `breaker_opened`（进入瞬间）或无事件（跳过本身） | A.1 |
| `service.ts:320` stream 0-chunk | 应发 `provider_attempt_failed` | A.1 |
| `service.ts:328` mid-stream error | 应发 `stream_reset` | A.1 |
| `service.ts:370` healthCheck 失败 | 应发 `healthcheck_failed` | A.1 |
| `custom-anthropic.ts:198` SSE parse 失败 | 局部 skip，无事件 | **phase187 新识别**：provider 异构处理边界 |
| `openai.ts:283` SSE parse 失败 | 同上 | **phase187 新识别** |

**A.1 聚合登记**：6 处 `service.ts` console 软吞根因 = `LLMEventSink` 协议已定义但实现未 wire（契约 L45 `events: LLMEventSink` 必传但运行期没有接事件到 AuditLog/Stream 的 adapter）。

**phase187 补登记**：

**A.4 — provider 异构 SSE parse 失败软吞**（phase187 新识别）

- 违反原则："不得丢弃或静默忽略"
- 位点：`custom-anthropic.ts:198` + `openai.ts:283`
- 当前行为：SSE event 解析失败时 `console.warn` 后 skip 本 event（gemini.ts / anthropic.ts 无此问题因用 SDK）
- 信息去向：丢失（仅 stderr，无结构化传递上行）
- 修复方向：`ProviderAdapter` 扩展 `onStreamParseError?(event: { provider: string; raw: string; error: Error })` 回调（或走 `LLMEventSink` 新增 `stream_parse_error` type）
- 升档条件：若 SSE 异常频率 > 0.1% 引起 LLM 输出 silent 截断 → 提高优先级
- **→ phase254 已清零**（onStreamParseError? 回调注入 + stream_parse_error LLMEvent type + providers SSE catch 路由）

**A.5 — idle timeout abort 跳过 provider failover**（phase251 升档，原 B.idle-failover）

- 违反：D4 LLM 调用恢复 — 单个 provider 卡住应触发 failover，但当前直接中断整个 turn
- 位点：`service.ts:285` `stream()` 方法对 `AbortError` 立即原样抛出（不重试、不切 fallback）
- 实测事故：clawforum-arch-v2 claw step 55，kimi-k2.5 120s 无输出触发 idle timeout → abort → 直接中断 turn，已配置 7 个 fallback provider 全部未尝试
- 根因：idle timeout 复用 `AbortSignal` 与用户主动中断同通道，LLM service 无法区分语义
- 修复方向（方案待定）：(a) idle timeout 不走 AbortSignal，改独立回调让 LLM service 区分处理；(b) StepExecutor 层捕获 idle timeout 后重新发起 LLM 调用并指定跳过当前 provider
- 升档理由：D4 违反 + 真实事故级别（7 个 fallback 全未用）；B 类登记不足以跟踪
- 计划 phase：H2b（r17 后半，依赖 H2a LLMEventSink protocol 已定）
- **→ phase263 已清零**（6e18cde 2026-04-24）
  实施：`LLMCallOptions.idleTimeoutMs?` 新字段；`service.ts` per-attempt `idleAbortController` + `mergeSignals` helper；idle abort → emit `idle_failover_triggered` → failover continue；user abort（`options.signal`）→ 立即抛出；`runtime.ts` idle timer 移除（-12 行），`idleTimeoutMs` 透传至 `runReact → runAgent → executeStep → LLMCallOptions`；`LLM_IDLE_FAILOVER_TRIGGERED` 常量 + `llm-audit-sink.ts` case + 3 新 it（场景 A/B/C）

**LLMService §7.A = 全 4 条已清零（A.1+A.3 phase254 / A.4 phase254 / A.5 phase263）**。

### 7.B ↔ §B 映射

既有 "§B 偏差登记" 6 条保留（reset chunk 显式丢弃 / Circuit breaker 仅内存 / createProvider 双形态 / StreamChunk union 扩张 / healthCheck false / interface 位置分裂）。

phase187 补登记：

~~**B.idle-failover — idle timeout abort 不触发 provider failover**~~ → **升格 §7.A A.5 by phase251**（D4 违反 + 真实事故级别；详见 §7.A A.5 节）

**B.p187-1 — 指数退避 30s 上限 magic number**

- 现状：`service.ts:178-179` `min(retryDelayMs * 2^attempt, 30_000)` 硬编码
- 违反：Coding Principle 数据节"可变状态应有唯一且明确的管理者"灰度 —— 30_000 无命名常量
- 合理性：契约 L102 / L149 已说明"保护 agent 等待上限"；当前未开放 `LLMServiceConfig.maxBackoffMs?`
- owner：phase146+（LLMService 引入容错时）
- 计划 phase：低优先级 —— 若 Daemon 需要 per-claw 调整退避上限再开放配置

**phase313 消化**（2026-04-25 / SHA `da14cce`）：`service.ts` 提取 `MAX_BACKOFF_MS = 30_000`，替换两处字面量。B.p187-1 清零。

~~**B.p328-1 — `audit-sink.ts` 物理位置在 L1（`src/foundation/llm/audit-sink.ts`）反向 import L2（`AUDIT_EVENTS` + `Audit` type）**~~
→ **已修订 by phase328**（2026-04-26 / r34 C / 起步 SHA `5f6b689` / 合入 SHA `430e34249e787b73e52d9a7c8ad55433c951b165`）

**历史**：phase254 引入 `audit-sink.ts` 时 / 物理位置选 `src/foundation/llm/`（与 LLMService 同目录便于编辑）/ 但内容是「L2 audit 事件 ↔ L1 LLMEventSink 协议」的 bridge / 实质归属在 caller 装配侧（Assembly）。`l1_llm_service.md` §1 应然层一直承诺「不反向依赖 L2」/ phase326 gap audit critical leak 项识别此物理 drift。

**修订动作**（phase328 Step 1）：
- `git mv src/foundation/llm/audit-sink.ts src/assembly/llm-audit-sink.ts`
- `src/foundation/llm/index.ts` 删 `export { createLLMAuditSink } from './audit-sink.js';`
- `src/assembly/assemble.ts:15` import 路径改 `./llm-audit-sink.js`

**verify**：`grep -rn "from.*audit" src/foundation/llm/` = 0 命中 / `grep -rn "audit-sink" src/` 仅命中 `src/assembly/`

### 7.C 原则对照（32 条）

全 32 条覆盖。

#### Module Logic Principles（11 条）

- **M1 独立可变职责**：合规。provider 管理 / 请求组装 / 重试退避 / CB / failover 五组职责均在 "LLM 容错" 语义内
- **M2 业务语义归属**：合规。retry / CB 逻辑由本模块直接发起
- **M3 资源归属**：合规。无磁盘资源；CB 状态是 transient
- **M4 持久化**：合规（CB 不持久化，契约 §B 已论证）
- **M5 依赖单向**：合规。`LLMEventSink` 协议归本模块定义，装配层注入实现，依赖向下不反向
- **M6 依赖结构稳定**：合规
- **M7 耦合界面稳定**：合规（StreamChunk union 扩张规则已登记 §B；phase212 `createLLMService(config): LLMService` 工厂切换后对外接口走工厂 return interface / 不暴露 Impl class；main `5968b3a`）
- **M8 耦合界面最小**：灰度。9 种 StreamChunk type 是 provider 异构的必要封装面
- **M9 显式表达编译器可检**：合规。`LLMAllProvidersFailedError` 命名 class / StreamChunk discriminated union
- **M10 不合理停下**：未触发
- **M11 边界不对停下**：未触发

#### Design Principles（11 条）

- **D1a 信息不丢失**：合规（phase254 §7.A A.1 结构化 audit + A.4 SSE parse 软吞 全清零后信息无丢失路径；灰度消除）
- **D1b 状态可观察**：合规（phase254 §7.A A.3 退避期沉默清零后，退避期状态通过 audit 事件可观察；灰度消除）
- **D1c 中断可恢复**：合规。AbortError 立即抛；`reset` chunk 通知调用方丢弃部分
- **D1d 事后可审计**：合规（phase254 §7.A A.1 清零后，LLM 失败日志结构化 audit 落盘；灰度消除）
- **D2 不得丢弃/静默**：合规（phase254 §7.A A.1+A.4 全清零后无静默丢弃路径；灰度消除）
- **D3 用户可观察**：合规（phase254 §7.A A.3 清零后，退避期状态对调用方（Runtime）可观察；灰度消除）
- **D4 LLM 调用恢复**：合规。failover + CB + retry 三层恢复；phase263 A.5 idle-failover 清零完善第三层
- **D5 日志重建**：合规（phase254 §7.A A.1 清零后，结构化 audit 事件可重建 LLM 调用决策链路；灰度消除）
- **D6a 决策主体**：无关
- **D6b 子代理不阻塞**：合规（不阻塞由调用方通过 stream/call 选择决定）
- **D7 系统可信路径**：合规
- **D8 事件驱动**：合规（StreamChunk 流式）
- **D9 多 claw 不隔绝**：无关
- **D10 motion 特殊**：无关
- **D11 CLI 唯一对外**：无关

#### Philosophy（4 条 / 2026-04-27 r42 D 结构合规修：3→4 / 补 P4）

- **P1 Agent 即目录**：无关（LLM 是 L1 原语 / 不直接消费目录形态）
- **P2 clawforum 本质上下文工程**：合规。LLM 是上下文执行的核心
- **P3 多 agent 利用上下文窗口**：合规。单一 LLMService 代码基 / provider config 按身份注入
- **P4 系统为智能体服务**：合规。LLMService 提供基础设施 / 不参与决策 / 仅 call/stream 协议

#### Path Principles（6 条）

- **Path #1 规划基于规划时刻事实**：✓ Read 源码 2517 行 + 测试 100 it
- **Path #2 差距显式登记**：✓ §A 2 条 + phase187 A.4 + §B 6 条 + B.p187-1
- **Path #3 语义一致最小变更单元**：✓ 单一意图 = 契约 backfill
- **Path #4 可回滚 + 破坏性论证**：✓ design 本地 only
- **Path #5 完成后复盘**：将于 phase187 Step 3 产出
- **Path #6 冲突立即中断**：未触发

### 7.D 关键决策映射表（modules.md 引用 / 2026-04-27 r42 D 结构合规修：补完）

从 `design/modules.md` §关键设计决策章节迁移。原 KD 编号保留供对账。

| KD | modules.md 描述 | 本契约引用位置 | 一致性 |
|---|---|---|---|
| KD（待编号）| LLMService L1 sharpen v2「OS/external 抽象层 / no audit / no permissions / no agent tools」 | §职责边界 + §不可消除耦合 | ✓ 一致（phase328 audit-sink 物理迁后真合规）|
| KD（待编号）| LLMEventSink 协议归属 LLMService（实现由装配层注入）| §事件清单 + §不可消除耦合 | ✓ 一致 / 防 L1 反向依赖 L2 |
| KD（待编号）| provider 异构吸收（4 adapter）| §不可消除耦合 | ✓ 一致 |
| **KD（r42 audit fork 新发现）**| breaker 状态机完整事件（open/half_open/closed）| **§事件清单 L146-147 + §B（待 r42+ 治理）** | **⚠️ 部分**（half_open + closed events 未实装 / B.p344-X 推 r42 B 治理）|

### 7.Phase 执行纪律

#### phase187 纪律 — L1 LLMService backfill（2026-04-21，design 本地 only）

- **scope**：既有契约缺 §7.C + §7.Phase；phase187 同时复核 §A 位点 + 新识别 A.4（SSE parse 软吞）
- **产出**：§7.A ↔ §A 映射 + 补 A.4 + 位点表 / §7.B ↔ §B + 补 B.p187-1 / §7.C 32 条 / §7.Phase（本节）
- **对比定位**：
  - **最多 §7.A L1 模块**（2 条聚合 + 4 事件细化）
  - 根因聚合策略：6 处 `service.ts` 软吞聚合为单 §A.1（`LLMEventSink` 未 wire 根因一致），不机械列 6 条
  - 2 处 provider 异构 SSE parse 软吞聚合为 A.4（异构处理边界）
- **方法论贡献**：
  - **根因聚合登记**：多处同型软吞按根因聚合为少数 §7.A 条目（与 phase178 Runtime 4 处 audit 聚合 3 type + scenario 双值模式同构）
  - **provider 异构边界识别**：A.4 标出 SDK 与手写 SSE parser 两种 adapter 的可观测性不对称

#### phase251 纪律 — §7.A/§7.B 全核 + B.idle-failover 升档（2026-04-24，design 本地 only）

- **scope**：r16 分支 F §7.A/§7.B 全核扫描；LLMService 被识别为最多 §7.A 条目 L1 模块（9 条中的 3 条）
- **drift 核**：0 drift（§7.A A.1/A.3/A.4 状态与实然一致）
- **升档动作**：B.idle-failover → §7.A A.5（D4 违反 + 真实事故 clawforum-arch-v2 step 55 实证；B 类登记不足以跟踪事故级违规）
- **未动**：A.1/A.3/A.4/A.5 修复推 r17 H2a/H2b phase（分派清单已产出）

#### phase254 纪律 — §7.A A.1/A.3/A.4 清零（r17 分支 D / H2a / 2026-04-24 / 代码 phase / main `e5ba395`）

- **scope**：LLMService §7.A A.1（6处 service.ts console.warn）/ A.3（退避期沉默）/ A.4（SSE parse 软吞）
- **产出**：`LLMEventSink` / `LLMEvent` union 定义（types.ts）/ `stream_parse_error` 新 type / events.ts 10 个 LLM_* 常量 / service.ts emit wire / custom-anthropic + openai `onStreamParseError?` 注入 / assemble.ts `createLLMAuditSink` fan-out adapter / 3 调用点切换 / llm-service.test.ts +5 it
- **清零**：A.1 ✓ / A.3 ✓ / A.4 ✓
- **遗留**：A.5 idle-failover → H2b（等本 phase protocol 已定后独立 phase）

#### phase263 纪律 — §7.A A.5 清零（r19 分支 B / 2026-04-24 / 代码 phase / main `6e18cde`）

- **scope**：LLMService §7.A A.5 idle timeout abort 不触发 provider failover
- **产出**：`LLMCallOptions.idleTimeoutMs?` / `mergeSignals` helper / per-attempt idleAbortController / idle abort → emit `idle_failover_triggered` → failover continue / `runtime.ts` idle timer 移除 -12 行 / `LLM_IDLE_FAILOVER_TRIGGERED` 常量 + `llm-audit-sink.ts` case / 3 新 it
- **清零**：A.5 ✓ → **LLMService §7.A 全 4 条清零里程碑**

#### phase275 纪律 — G5 console 评估（r21 分支 F / 2026-04-24 / design 本地 only）

- **scope**：phase226 G5 LLMService console 全评估 / 路径事实核查
- **Path #1 实测**：foundation/llm/ 全 6 文件 0 console（phase254+263 已全清）
- **N2 drift 修正**：§7.A 节补"全 4 条已清零"汇总声明（与 l1_transport / l4_task_system 惯例一致）
- **结论**：G5 §7.A 全清零，无代码改动，无真残留

#### phase284 纪律 — §7.C cascade 补登记（r23 分支 F / 2026-04-25 / design 本地 only）

- **scope**：§7.C 全模块复核 phase284 发现；LLMService §7.A A.1/A.3/A.4（phase254）+ A.5（phase263）全清零后 §7.C cascade 遗漏补登
- **触发源**：phase279 叙述式补扫方法识别 LLMService 同属"叙述式灰度未同步"模式
- **cascade 前进 6 条**：D1a 灰度→合规 / D1b 灰度→合规 / D1d 灰度→合规 / D2 灰度→合规 / D3 灰度→合规 / D5 灰度→合规
- **保留不动**：M8 灰度（9种 StreamChunk type 结构性封装面）/ D4 合规注记扩充（phase263 A.5 idle-failover 完善）

#### phase317 纪律 — 契约 drift 修订（r30 分支 C / 2026-04-25 / design only）

- **scope**：B.p187-1 消化 SHA 修正（假 SHA `2079eba` → 正确 `da14cce` / phase302→313）

#### phase328 纪律 — L1→L2 audit-sink 物理迁移（r34 分支 C / 2026-04-26 / 代码 phase / main `430e34249e787b73e52d9a7c8ad55433c951b165`）

- **scope**：phase326 gap audit critical leak / `src/foundation/llm/audit-sink.ts` 物理位置 vs 应然层级 drift
- **触发源**：r34 分发表 Stage 2 P0 #2（B 分支 FileWatcher 解耦 pattern 候选复用）
- **产出**：`src/assembly/llm-audit-sink.ts`（新 / 内容等价）/ `src/foundation/llm/audit-sink.ts`（删）/ `src/foundation/llm/index.ts` 删 re-export 行 / `src/assembly/assemble.ts:15` import 路径调整
- **drift 核**：
  - 分发表 framing 称 caller 是 StepExecutor / 实测唯一 caller 是 `src/assembly/assemble.ts:15,151` / Step 1 §修改文件按实测 caller 操作
  - 分发表 framing 称「audit-sink 测试改为 caller 测试」/ 实测 audit-sink.ts 0 单独测试 / llm-service.test.ts 用 inline noopSink / 无测试迁移工作
- **行为变化**：0（API surface 不变 / event 触发时机/载荷不变 / vitest 全绿）
- **方法论贡献**：
  - **物理位置 vs 应然层级 drift 范本**：契约应然层 align 但物理位置 drift 的 §7.B 历史登记模板（`B.p328-1`(已修订)）
  - **B 分支 pattern 复用候选**：r34 B 分支 FileWatcher 解耦相似 pattern（caller bridge / event 命名归 caller / 物理位置归 caller 装配侧）/ B 分支若先合 / phase328 套同模式
- **未动**：events.ts 的 AUDIT_EVENTS.LLM_* 常量层级评估（仍归 L2 / 本 phase 不改）

### 7.编号 drift 表

| modules.md 应然 § | 本契约引用 § | delta | 说明 |
|---|---|---|---|
| §3 | §3 | 0 | 无 drift / LLMService 在 modules.md 中编号未受新增模块影响 |
