# LLMOrchestrator 模块内部契约

> 本文档限本模块**内部**应然 — 8 节结构 derive 自 Module Logic Principles：§1-§4 = M#1-#4 各占一节，§5 审计 = M#3 命名空间细则，§6 层级，§7 drift = M#10/#11，§8 测试。
> 跨模块对外承诺（接口签名、生产/消费方、归本模块加不归本模块、不可消除耦合理由）见 [interfaces/l2b.md](../interfaces/l2b.md) LLMOrchestrator 节。
> 模块本质加层归属见 [architecture.md](../architecture.md)。

## 1. 职责（M#1 独立可变职责）

> 本节内容 derive 自 [architecture.md](../architecture.md) §11「LLMOrchestrator 本质：LLM 调用的协议层封装 / L2 LLM 语义基础设施 / 在 L1 LLMProvider 之上把 LLM 调用的协议层处理封装成可重用基础服务 / 知 LLM 调用语义 / 不知 agent 业务」加 M#1 / M#2 / M#3 / M#4 / Design Principle「不丢弃 / 静默」。

### 做

应用 M#1（一个模块封装一组独立可变的职责），LLMOrchestrator 的单一职责 = **多 LLM provider 容错编排 + 协议层错误识别**：

- **多 provider 容错编排**：包装多个 L1 LLMProvider 实例 / primary 加 fallbacks 重试 / failover 切换。
- **circuit breaker**：连续失败达 threshold 进入 open / cooldown 后 half-open 探测 / 探测成功 closed 恢复。
- **idle timeout 触发 failover**：流式调用 idle timeout 后 abort 当前 provider 加切下一个（per-attempt `idleAbortController` + `mergeSignals` helper / user abort 立即抛）。
- **context_exceeded failover**：done chunk stopReason ∈ `CONTEXT_EXCEEDED_STOP_REASONS` set（anthropic `model_context_window_exceeded` + openai variant `context_length_exceeded`）时切下一个 provider 试更大 context window / 全 provider 都 context_exceeded 时 throw 专门 error 保「Reduce prompt...」UX 语义。
- **协议层错误识别加 typed error**：max_tokens 续写、context_exceeded、aborted 等抛 typed error 让 caller 业务级决策。
- **容错事件 audit emit**：直 import L2 AuditLog（同层）/ 12 type LLMEvent 落盘 / 详 §5。

> 具体 API 形态归 [interfaces/l2b.md](../interfaces/l2b.md) LLMOrchestrator 节。

### 不做

- **不 own 单 provider SDK 调用**（归 L1 LLMProvider）— derive 自 M#1
- **不 own dialog 持久化**（归 L2 DialogStore）— derive 自 M#1
- **不 own LLM event 流分类**（归 L2 Stream）— derive 自 M#1
- **不 own 业务级错误决策**（如何应对协议错误，归 caller / L3 AgentExecutor）— derive 自 M#2
- **不 own agent 业务策略**（重试边界、abort 时机由 caller 提供参数）— derive 自 M#2 + M#5
- **不 own messages 内容解析**（content / tool_use / tool_result 内容含义归 caller）— derive 自 M#1
- **不 own provider 配置**（构造期由 caller 装配期注入）— derive 自 M#5

## 2. 业务语义（M#2 业务语义归属）

> 应用 M#2（模块为自己的业务语义负责），LLMOrchestrator 的业务语义边界：

- **own**：多 provider 容错编排概念（primary + fallbacks、retry、breaker、failover、idle timeout、context_exceeded failover、协议层错误识别）。
- **角色定位**：LLMOrchestrator 是「**容错编排器**」非「**业务决策器**」。caller 透明看到 final response 加业务级错误（不感知协议层细节）。

## 3. 资源（M#3 资源唯一归属）

> 应用 M#3（每种资源只归属唯一模块），LLMOrchestrator 独占的资源：

- **多 provider 容错状态**：每 provider 的 circuit breaker 状态加 consecutive failures 计数 — 运行期 mem-only（重启后 stale 不持久化合理 / 详 §4）。
- **provider list**：构造期注入（primary + fallbacks）/ 运行期不变。
- **不持磁盘资源**：所有状态运行期 mem / 重启 reset。
- **占用 LLM audit 命名空间**：`LLM_AUDIT_EVENTS` const 集中定义 / 直接经 L2 AuditLog 落盘 / 详 §5。

## 4. 持久化（M#4）

> 应用 M#4（持久化一切信息到磁盘 / 运行时句柄从磁盘信息重建），LLMOrchestrator 的持久化立场：

- **circuit breaker 状态加 retry 计数不持久化**：重启后 provider 真实健康可能已变（恢复或仍坏），从磁盘恢复 stale 状态等于带着错误信息工作 / 重启视为「重新评估」是正确行为（详 practices.md「应然层资源字段与持久化判据」）。
- **provider 配置**：构造期由 caller 装配期注入 / 内部无需从磁盘恢复。
- **审计事件持久化**：via L2 AuditLog → 落盘 / 实时事件经 L2 Stream 暴露。

## 5. 审计事件清单

事件常量集中定义于 `LLM_AUDIT_EVENTS`（模块自治）。LLMOrchestrator 直 import L2 AuditLog 写事件（同层 / DIP 消解后无需 sink protocol）：

| LLMEvent type | 触发时机 | audit 载荷字段 |
|---|---|---|
| `provider_attempt_failed` | provider.call/stream 抛普通错 | `provider`, `attempt`, `error` |
| `retry_scheduled` | attempt 未耗尽 / 进入退避前 | `provider`, `attempt`, `backoffMs` |
| `provider_exhausted` | 某 provider 重试耗尽 / circuit open 跳过 | `provider`, `error` |
| `fallback_switched` | 切到下一个 provider 瞬间 | `from`, `to`, `reason` |
| `breaker_opened` | 连续失败达 threshold 进入 open | `provider`, `consecutiveFailures` |
| `breaker_half_open` | resetTimeoutMs 到期放探测 | `provider` |
| `breaker_closed` | 探测成功恢复 | `provider` |
| `healthcheck_failed` | healthCheck 抛错（捕获后）| `provider`, `error` |
| `stream_reset` | stream 已 yield 过 chunk 后失败 | `provider`, `error` |
| `stream_parse_error` | SSE parse 失败| `provider`, `raw`, `error` |
| `idle_failover_triggered` | idle timeout abort 触发 failover| `provider`, `idleTimeoutMs` |
| `context_exceeded_failover` | done chunk stopReason ∈ `CONTEXT_EXCEEDED_STOP_REASONS`| `provider`, `stopReason` |

> **错误隔离政策**：LLMOrchestrator audit emit 不抛 / 不阻塞 LLM 主路径 / 失败必须在内部消化（如 AuditLog 自身递归走 `[AUDIT CRITICAL]` 边界）。

## 6. 层级声明

L2 LLM 语义基础设施 / 多 provider 容错编排器（与 DialogStore / Stream / ToolProtocol 同层）。详见 [architecture.md](../architecture.md) 加 [interfaces/l2b.md](../interfaces/l2b.md)。

## 7. 应然 vs 实然差距登记（M#10 / M#11）

> 原则：本节只登记**实然 ≠ 应然**的 gap（待治理或已治理的历史）+ 偏差 + 历史纪律。当前实然若与应然 align 则不在此登记。

### 7.A 必修违规（含历史已闭环）

| §A 条 | 类型 | 状态 | 触发情境 |
|---|---|---|---|
| A.1 失败日志走 console.warn 非结构化（6 处 service.ts）| drift | 已闭环（phase254 / `e5ba395`）| 6 处 console → emit LLMEvent / Assembly fan-out 到 audit + stream / `LLMEventSink` 协议 wire（r61+ 拆分后 sink protocol DIP 消解 / 直 import L2 AuditLog）|
| A.3 重试退避期对调用方沉默 | drift | 已闭环| `retry_scheduled` event emit / 退避期可观察 |
| A.4 provider 异构 SSE parse 软吞（custom-anthropic + openai）| drift | 已闭环| `onStreamParseError?` 回调注入 + `stream_parse_error` LLMEvent type / providers SSE catch 路由 |
| A.5 idle timeout abort 跳 provider failover（D4 违反 + 真实事故）| drift | 已闭环（phase263 / `6e18cde`）| `LLMCallOptions.idleTimeoutMs?` / per-attempt `idleAbortController` + `mergeSignals` helper / idle abort → emit `idle_failover_triggered` → failover continue / user abort 立即抛 |
| ~~breaker 状态机 half_open + closed events 实装核~~ | drift | 已闭环（r44 A 实测确认）| service.ts:159 / 105 / 118 通过回调（transition 参数）动态 emit breaker_opened / breaker_half_open / breaker_closed 三态 / 应然 §5 11 events 全实装 / 100% 走 LLM_AUDIT_EVENTS const |
| ~~A.6 stream() done chunk `stopReason=context_exceeded` 未触发 failover~~ | ~~drift~~ | **✅ closed phase408**（main `c1fca6ca` / α-1 路径 / 跨模块协调）| **service own context failover**：`service.ts:34` `CONTEXT_EXCEEDED_STOP_REASONS` Set（anthropic `model_context_window_exceeded` + openai variant `context_length_exceeded`）+ done chunk 检查 (L361) + emit `context_exceeded_failover` event (L363) + yield reset chunk + outer loop continue 试 next provider / 全 provider 都 context_exceeded 时 throw 专门 error 保「Reduce prompt...」UX 语义 / **react 死路径删**：step-executor.ts:103 + agent-executor.ts:75 既有 throw 路径迁离（治理副产品 dead code 必清不留 ⚓）+ StepResult union 缩 / **fallback context size 异质实证锁定 α-1**（用户事实供给：fallback chain 9 provider context window 异质 / 换更大 model 真能跑通 / γ 反向决策「换 provider 也炸」论证失效）/ **行为契约变更**：caller error 信息从 react-level「LLM context window exceeded. Reduce ...」迁至 service-level「All N providers exhausted with context_window_exceeded. Reduce ...」/ 测试基线变更：删 react.test.ts + step-executor.test.ts context_window_exceeded 测试 + NEW tests/foundation/llm-service.test.ts 反向 1-3 强（failover + 全失败 throw + event emit）|
| ~~30s 上限 magic number~~ | drift | **✅ closed（phase313 / SHA `da14cce`）** | `MAX_BACKOFF_MS = 30_000` 抽常量 |

> **§7.A 6/6 全清零里程碑（A.1+A.3+A.4 phase254 / A.5 phase263 / breaker events 实装核 r44 A 核实 / A.6 phase408）**（继承 pre-split L1 LLMService §7.A 历史 / r61+ 拆分后归属本模块）。

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| `reset` chunk 显式丢弃决策 | mid-stream 已 yield 内容被调用方丢弃（provider 切换后内容不连续）/ 显式设计决策的信息丢弃路径 / 非违规 | / |
| Circuit breaker 状态仅在内存 | 短期容错控制态 / 重启重建不损失决策链路信息 / 失败链路通过 events emit 持久化 | provider 故障期间 daemon 反复重启刷爆 provider |

### 7.C 应然原则对照

> 仅列**应然**对各原则的承诺立场。

#### Module Logic Principles（11 条）

- **M1 独立可变职责**：单一职责 = 多 provider 容错编排（r61+ 拆出 L1 LLMProvider 后真合规）
- **M2 业务语义归属**：own LLM 协议层错误识别加多 provider 协调
- **M3 资源归属**：多 provider 容错状态唯一归属 / 占用 LLM audit 命名空间
- **M4 持久化**：容错状态不持久化（重启 stale 不恢复 / §7.B 论证）/ 审计经 L2 AuditLog 持久化
- **M5 单向依赖**：LLMOrchestrator → L1 LLMProvider + L2 AuditLog（同层）（per arch §11 表 1）/ 0 反向
- **M6 依赖结构稳定**：构造期 `LLMOrchestratorConfig` 注入 / 运行期不变
- **M7 耦合界面稳定**：`createLLMOrchestrator(config): LLMOrchestrator` 工厂
- **M8 耦合界面最小**：灰度（StreamChunk type 转发是 provider 异构必要面）
- **M9 显式表达编译器可检**：`LLMOrchestratorError` / `LLMAllProvidersFailedError` 命名 class / LLMEvent discriminated union
- **M10 不合理停下** / **M11 边界不对停下**：未触发

#### Design Principles（11 条 / #1 展 4 面）

- **D1a 信息不丢失**：phase254 + phase263 闭环（结构化 audit + SSE parse 软吞清零 + idle failover）
- **D1b 状态可观察**：退避期通过 `retry_scheduled` event 可观察
- **D1c 中断可恢复**：AbortError 立即抛 / `reset` chunk 通知调用方丢弃部分
- **D1d 事后可审计**：phase254 闭环 / LLM 失败日志结构化 audit 落盘
- **D2 不得丢弃/静默**：phase254 全清零（A.1 + A.4）/ 无静默丢弃路径
- **D3 用户可观察**：phase254 闭环 / 退避期状态对调用方（Runtime）可观察
- **D4 LLM 调用恢复**：**核心驱动**（failover + CB + retry 三层恢复 + phase263 idle failover 完善第三层 + phase408 context_exceeded failover）
- **D5 日志重建**：phase254 闭环 / 结构化 audit 事件可重建 LLM 调用决策链路
- **D7 系统可信路径**：受信组件
- **D8 事件驱动**：StreamChunk 流式 + LLMEvent emit
- **D6 / D9-D11**：无关

#### Philosophy（4 条）

- **P1 Agent 即目录**：无关
- **P2 上下文工程**：LLM 是上下文执行的核心
- **P3 多 agent 利用**：单一 LLMOrchestrator 代码基 / provider config 按身份注入
- **P4 系统为智能体服务**：LLMOrchestrator 提供基础设施 / 不参与决策 / 仅 call/stream 协议

#### Path Principles（6 条）

- **Path #1 实测核**：治理动作要 grep 实然代码佐证
- **Path #2 §A 显式登记**：违规明文上墙
- **Path #3 APPEND 不解构**：契约修订加节不重写
- **Path #4 破坏性论证**：API 改动 caller 评估
- **Path #5 默认拆**：能力扩展优于职责合并
- **Path #6 停下报告**：scope 模糊或决策点必停报告

### 7.D 历史纪律

详 phase251 / phase254 / phase263 / phase284 / phase313 / phase317 / phase408 各 phase 收尾报告。

关键里程碑：
- phase251 §7.A/§7.B 全核 / B.idle-failover 升 §7.A A.5
- phase254 §7.A A.1+A.3+A.4 三条清零（main `e5ba395`）/ LLMEventSink 协议 wire / Assembly `createLLMAuditSink` fan-out adapter
- phase263 §7.A A.5 idle-failover 清零（main `6e18cde`）/ §7.A 全 4 条清零里程碑
- phase284 §7.C cascade 补登记（D1a/D1b/D1d/D2/D3/D5 灰度→合规）
- phase313 30s 上限 magic number 闭环（`MAX_BACKOFF_MS = 30_000` 抽常量 / SHA `da14cce`）
- r44 A：契约结构升 9 节模板 + breaker 状态机 events 实装核登 §7.A
- phase408 §A.6 ✅ closed（α-1 service own context failover + react 死路径删 / Path #1 暴露分发表未提的 react 双路径 / 跨模块协调真决策点 / fallback context size 异质实证锁 α-1 / γ 反向决策「换 provider 也炸」论证失效 / **§7.A 6/6 全清零里程碑** / main `c1fca6ca`）
- 2026-05-03 / phase413 LLMService 拆 L2 LLMOrchestrator 落地（main `9fee6b69`）/ orchestrator.ts 533 行业务体物理迁自 src/foundation/llm/service.ts / class rename LLMServiceImpl → LLMOrchestratorImpl + interface LLMService → LLMOrchestrator + Config / 经 LLMProvider 接口消费（不直 import adapter / 删内部 createProvider）/ 20+ caller rename / 18+ tests 改 / 整模块拆出模板第 2 次复用（同 phase411）/ 模块边界重构阶段最后大候选闭环 / 1370 测试 PASS

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| KD（r61+）L2 LLMOrchestrator own 多 provider 容错编排 / 直 import L2 AuditLog（DIP 消解 sink protocol）| ✓ M#1 + M#5 真合规 |
| KD（r42 audit fork）breaker 状态机完整事件（open / half_open / closed）| ✓（r44 A 实测确认 service.ts:159/105/118 通过回调 emit 三态）|

## 8. 测试覆盖

应然行为应有测试覆盖：

- **多 provider failover 路径**：primary 失败 / fallback 试 / 全 provider 失败抛 LLMOrchestratorError
- **circuit breaker 路径**：连续失败开 / 冷却后 half-open / 探测成功关
- **idle timeout 路径**：场景 A user abort 立即抛 / B idle abort failover continue / C 多 provider 串联
- **context_exceeded failover 路径**：done chunk stopReason ∈ `CONTEXT_EXCEEDED_STOP_REASONS` → failover / 全失败抛专门 error / event emit 断言
- **指数退避 + 30s 上限**：`MAX_BACKOFF_MS` 边界
- **`reset` chunk yield**：流式中途错误后 yield reset 通知 caller
- **协议层错误识别**：typed error（context_exceeded / max_tokens / aborted）抛给 caller
- **审计事件回链**：每个 §5 LLMEvent type 触发时机+载荷断言
- **装配层 fan-out 集成**：cross-module 测试归 Assembly 装配契约（非 LLMOrchestrator 单测）
