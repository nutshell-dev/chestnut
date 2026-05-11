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

| 资源 | 类别 | 持久化 |
|---|---|---|
| 无 | — | ✗ 多 provider 容错状态（circuit breaker + consecutive failures 计数）运行期 mem-only / 重启 reset 合理（详 §4 论证）|

**无磁盘资源** — 所有状态运行期 mem / 重启 reset。

> 注：(1) provider list 构造期注入（primary + fallbacks）/ 运行期不变 / 非 own / (2) `LLM_AUDIT_EVENTS` const 占用 LLM audit 命名空间（直经 L2 AuditLog 落盘 / 详 §5 / 命名空间归属 M#3 体现）。

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
| `stream_idle_probe_attempted` | ⚓4 ε stream idle 触发 probe 起（per phase 637）| `provider`, `timeoutMs` |
| `stream_idle_probe_succeeded` | ⚓4 ε probe success / idle 是 transient lull / retry same provider | `provider` |
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
> **r63 D fork phase 473 复审确认**（design only / 0 src 改 / 用户拍板候选 α + δ 双合）：r60 浮出「L1 LLMService M#1 violation」design-gap 实然已完全闭环（phase413 + phase449）/ 进一步拆 4 strategy（circuit breaker / failover / retry / idle timeout）评估为 over-engineering（容错四件套 cohesive 业务概念 / circuit breaker 状态决定 failover 时机 / failover 决定 retry 起点 / idle timeout 决定 abort 路径 / 拆开违 M#1 反向测试）/ 0 r64+ code phase 启动 / 详 §7.D 行。

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| `reset` chunk 显式丢弃决策 | mid-stream 已 yield 内容被调用方丢弃（provider 切换后内容不连续）/ 显式设计决策的信息丢弃路径 / 非违规 | / |
| Circuit breaker 状态仅在内存 | 短期容错控制态 / 重启重建不损失决策链路信息 / 失败链路通过 events emit 持久化 | provider 故障期间 daemon 反复重启刷爆 provider |
| **L2b.G1 (llm-orchestrator)** arch 表 1 依赖列「LLMProvider、AuditLog」未含 events sink fan-out 模式 | **业务决策性 design-gap / r65 起 cross-doc audit 浮出**：interfaces/l2b.md ctor 通过 `LLMOrchestratorConfig.events: LLMEventSink` 装配方注入 fan-out 出口（line 334「audit + stream + UI 各自订阅」）/ arch 表 1 LLMOrchestrator row 依赖列「LLMProvider、AuditLog」直接列 audit 当依赖 / 实然 audit 是 sink fan-out 之一 / arch 与 interfaces fan-out 模式不一致 | **业务决策性 / 用户拍板候选**：α arch 表 1 依赖列改「LLMProvider」+ 耦合列加「LLMEventSink fan-out 协议（装配方注入 / audit + stream + UI 各自订阅）」/ β 保留现状（audit 是 sink default consumer / 表层依赖描述合理）|
| **L2b.G2 (llm-orchestrator)** arch 表 2「失败 audit」描述精度 | **业务决策性 design-gap / r65 起 cross-doc audit 浮出**：interfaces/l2b.md 暴露 12 类 LLMEvent + LLMEventSink fan-out / arch 表 2 LLMOrchestrator row 写「失败 audit」单 audit 视角 / 实然是「失败事件 fan-out（audit + stream + UI 各自订阅）」/ 同 G1 同型 sharpen | **业务决策性 / 用户拍板候选**：α arch 表 2 改「LLMEvent 失败事件 fan-out（12 类事件 / 装配方 sink 实现 audit + stream + UI 订阅）」/ β 保留现状 |
| **B.call-idle-mismatch 非流式 call() 路径 idleTimeoutMs 含义错配** | drift / 中 / r65 D fork derive 浮出 | **✅ closed by phase 538** | 实然 `orchestrator.ts:175-212` `call()` 路径 `idleTimer = setTimeout(() => idleCtrl.abort(), idleTimeoutMs)` 单次 set / 无 reset 机制 / 非流式 = 单 HTTP call 无 chunk 流概念 / `idleTimeoutMs` 实然 = hard timeout / vs `stream()` 路径 line 326-344 每 chunk 调 `resetIdleTimer()` 真 idle 语义 / caller（healthCheck / ask-caller / summary / dream / clone-context）传短 idleTimeoutMs（默 90s）→ 长 prompt 单次推理超时即被错杀 / 字段语义在两路径含义不同 / 违 M#7 耦合界面稳定 + M#8 跨边界只传必要信息 / ζ.2：拆 LLMCallOptions 为 `{ hardTimeoutMs?: number; streamIdleTimeoutMs?: number; idleTimeoutMs?: deprecated alias }` / call() 用 hardTimeoutMs / stream() 用 streamIdleTimeoutMs / 兼容期 1 r 后删 alias / derive 详 `coding plan/phase538/Phase 538 总览.md §D.4` / **alias 真删兑现 by phase 660**（B fork r83 / **14 r 兑现** mirror B.r68-2 8 r 模板）：L1 LLMCallOptions.idleTimeoutMs（dead literal / orchestrator 总 strip undefined）+ L2 LLMCallOptions.idleTimeoutMs（@deprecated alias）双删 / orchestrator 8 处 fallback + strip + emit 清理 / step-executor.ts:42 caller cascade（idleTimeoutMs → streamIdleTimeoutMs / mirror stream 路径语义）/ tests cascade（rename 3 + DELETE 1 alias test）/ 高层各域合法字段保留（StepInput / RuntimeOptions / SubAgentOptions / VerifierConfig / dispatch tool arg / SSE parser 内部 / 不在 deprecation 范围）/ ~-40 行 / 0 NEW / **dispatch scope reframe minimal**（dispatch 估 43 cascade → 实然 ≤ 10 真 site）|
| **B.merge-signals-leak mergeSignals listener 未 cleanup 长会话累积** | drift / 低 / r65 D fork derive 浮出 P2 | **✅ closed by phase 538** | 实然 `orchestrator.ts:514-519` `a.addEventListener('abort', abort, { once: true })` / `{ once: true }` 仅 abort fire 时移 listener / call 成功完成时 listener 不移 / parent ctx.signal 长会话累积 listener / Node 默认 MaxListenersExceeded warning at 11 / η：mergeSignals 返 `{ signal, cleanup }` / call settle finally 调 cleanup 移 listener / derive 详 `coding plan/phase538/Phase 538 总览.md §D.5` |
| **B.getProviderInfo-state-leak getProviderInfo 全失败后状态泄露** | drift / 中 / r72 G fork phase 599 ratify β / r74 K fork phase 616 落地 | **closed by phase 616**（main `a60a6995`）| 实然 `orchestrator.ts:484-498 getProviderInfo` 用 `currentProviderIndex` 决定返 primary or fallbacks[idx] / `currentProviderIndex` line 327-329 mid-stream 切换时更新 / 全失败 throw 后 `currentProviderIndex` 仍是上次失败 provider 的 index → caller `getProviderInfo()` 拿到「最后失败 provider」误以为是当前活动 provider / 状态泄露 / 违 D5 唯一权威 + D1 信息不丢失。**phase 599 ratify β + phase 616 落地决策**：β NEW field `lastSuccessProvider: { name; model; isFallback } | null`（call/stream 成功时更新 / 全失败不更新）+ getProviderInfo() return type 改 `... | null`（无成功调用时 null）+ 与 currentProviderIndex 解耦 / D1 信息不丢失 + D3 显式状态 + D5 唯一权威 + M9 编译期可检 align / α 哨兵 -2 多义违 D5 reject / γ 隐含约束违 D5 reject。**⚓ invariant（phase 616 sharpen）**：currentProviderIndex 仅 mid-stream tracking / lastSuccessProvider 仅 final success 时更新 / getProviderInfo() 返 lastSuccessProvider（无 success 时 null）|
| **B.healthCheck-primary-only-vs-service healthCheck primary-only / 与「orchestrator」名实不一致** | drift / 中 / r72 G fork phase 599 ratify α / r74 K fork phase 616 落地 | **closed by phase 616**（main `a60a6995`）| 实然 `orchestrator.ts:503-515 healthCheck` 仅探 primary / 当 primary 故障但 fallbacks 可用时返 false（误报服务不可用）/ caller 用 healthCheck 决定 dispatch 时期望「服务整体可用」/ 违 M2 业务语义归属（**「orchestrator」命名定位 = 整体编排 / 不是 primary-only**）。**phase 599 ratify α + phase 616 落地决策**：α 依次试 primary + fallbacks / 任一成功即 true / 全失败 emit healthcheck_failed for each provider + return false / M2 业务语义 derive「orchestrator」命名 = 整体可用 / 性能 N call 接受（healthCheck 频率低 / 启动期或 dispatch decision time / 不在 hot path）/ β 保持现状 + rename `primaryHealthCheck` 仅名义 align reject / γ 返 detailed `{ primary; fallbacks[] }` over-engineering 违 YAGNI reject。**⚓ invariant（phase 616 sharpen）**：healthCheck 探「服务整体可用」/ 顺序试 primary + fallbacks / 任一成功即 true / 名实 align「orchestrator」业务语义 |
| **B.json-parse-tool-args LLM provider tool args JSON.parse 失败 silent fallback** | drift / 中 / r68 B fork phase 564 derive 浮出 P1 | **✅ closed**（β-like callback 路径已落地 / `openai-response-parser.ts:63` `onToolArgParseError?: ToolArgParseErrorCallback` callback 注入 + line 92 `onToolArgParseError?.({...})` emit / phase 715 sub-A D2-P1.3 state lag fix / row 状态此次同步 closed） | 实然 `llm-provider/openai.ts:513-521` JSON.parse 失败 catch 块 fallback `input: <raw string>` / 无 audit / caller 后续 type check 失败（input expected object）/ 同型 anthropic / custom-anthropic / gemini 推 r69+ sweep / **layering 浮出**：L1 LLM provider 0 audit 依赖（ProviderConfig 无 audit/callback 字段）→ 加 audit 需跨层 / 4 候选 28 原则核：**α** ProviderConfig +`auditCallback?` 注入（M#7 接口扩 cascade 4 prov + assembly + tests）评分 2/5 / **β** 抛 typed error LLMToolArgParseError / L2 LLMOrchestrator catch + audit `LLM_TOOL_ARG_PARSE_FAILED`（M#5+M#7+M#8+YAGNI+D2 全 align）评分 **5/5 dominant** / 但语义改：lenient fallback → strict throw / **γ** L2 step-executor 间接观测 `input is string` + audit（间接 / audit 时机偏晚）评分 4/5 / **δ** console.warn（silent X anti-pattern / 反 D2）评分 2/5 reject / **拍板取舍**：lenient（α/γ 保业务容忍）vs strict（β 严格语义错错）业务方向决策性 / 推 r69+ 用户拍板后 code phase 实施 + 同步 sweep 3 同型 providers / phase 564 design only 登记不实施 |
| **B.stream-idle-failover-vs-retry-symmetry stream idle 直 failover vs call retry 对称性** | drift / 中 / r72 G fork phase 599 ratify 标 ⚓4 真业务策略 / r74 J fork 登记 / phase 622 ratify refine / **r76 D fork user ratify ε（probe-then-decide）** | **✅ ε ratified by user binary at r76 D fork**（推 r76+ code phase 落地） | 实然 `orchestrator.ts:392-405` stream 路径 idle timeout 触发 `idleCtrl.abort()` 后直走 failover（下个 fallback provider）/ 不走 retry / 对照 call 路径 `line 175-212` retry 链路（hardTimeout 错杀后 retry 同 provider）/ 两路径 idle / failure 处理语义 split / 候选历史：**α** design intent 锁 + doc invariant（reject by ratify / 误失效 risk 高 / transient burst lull 错杀）/ **β** stream idle 同走 retry 对称 call（reject by ratify / 漏检 risk 高 / 真 stuck 无快速判定）/ **ε（user binary ratified）probe-then-decide**：stream idle → minimal call probe（复用 healthCheck `messages: [{role:'user', content:'Hi'}], maxTokens:1` 模式 / probe timeoutMs 短默 5s）→ probe success（provider 活着 / idle 是 transient lull）→ retry same provider stream / probe failure（network/timeout）→ failover 下一 provider / probe auth/model 错 → throw user-facing reconfigure。**ε 28 原则 derive**：D5 冗余防御 ✓ + M#7 接口稳定（probe private / caller 透明）+ M#1 LLMOrchestrator own 容错决策（probe = 容错子动作）+ M#5 单向依赖（probe 内部走 L1 provider.call）+ YAGNI（不抽 ProbeService / 不创新概念 / 复用 minimal call pattern）/ 5/5 align。**probe 归属 L2 LLMOrchestrator** private method（不归 L1 LLMProvider 违 M#5 / 不归 caller L3+ 违 M#7）/ **DRY 候选**：抽 private `_minimalProbe(provider, timeoutMs)` helper / healthCheck + stream idle probe 双 caller 复用（推 r76+ code phase 选 derive）。**业务 derive 锚点**：「确认 provider 无法响应 call 请求」= probe failure 真信号 / 不能 stream idle 单一信号判定 stuck（idle 只是「这段时间没 chunk」/ 不等于 provider 真挂）。**新增 audit events**（推 r76+ code phase）：`stream_idle_probe_attempted`（probe 起 + provider + timeoutMs）+ probe failure → 复用 `idle_failover_triggered` 加 `reason=probe_failed`（既有 const 复用纪律 align）/ probe success → emit `stream_idle_probe_succeeded`（idle = transient lull / retry stream same provider）。**实施变更点**：orchestrator.ts:392-405 stream idle handler 加 probe 调用 + 重组 retry/failover 决策链路 / NEW const `STREAM_IDLE_PROBE_ATTEMPTED` + `STREAM_IDLE_PROBE_SUCCEEDED`（视复用判据） / probe success 后 retry stream same provider 1 次（再 idle 真出问题 / 不无限循环）/ **兑现 by phase 637**（B fork r77 / 起步 SHA `c0e8e6ed` / NEW _minimalProbe(provider, timeoutMs) private helper（DRY: healthCheck + stream idle probe 双 caller 复用 / mirror shared helper N=8+ 模板）+ healthCheck refactor 用 _minimalProbe + stream idle handler line 401-413 重组（probe success → continue retry same provider / probe network/timeout → failover next / probe auth/model → throw user-facing）+ 2 NEW LLMEvent variants（stream_idle_probe_attempted + stream_idle_probe_succeeded）+ 2 NEW LLM_AUDIT_EVENTS const + sink case + LLMCallOptions +`streamIdleProbeTimeoutMs?` optional default 5000ms / 0 caller cascade / 行为差 = stream idle transient lull recovery）|
| **B.stream-zero-chunk-breaker-sensitivity stream 0-chunk 计 breaker.onFailure 灵敏度** | drift / 中 / r72 G fork phase 599 ratify 标 ⚓5 真业务策略 / r74 J fork 登记 / phase 622 ratify refine / **r77 B fork phase 637 α default ratified（默认接受 via phase 628 dispatch + r77 B fork code 落地兑现）** | **✅ closed by phase 637**（B fork r77 / α default 兑现 / 0 code 行为差 / doc comment 加 line 451-462 / per design intent: 0-chunk → onFailure conservative miss-detect / D5 redundant defense） | 实然 `orchestrator.ts:442-453` stream 完成后若 `chunkCount === 0` 调 `breaker.onFailure()` / 触发 circuit breaker 状态机 / 候选：**α** 保持现状（保守失效优先 / D5 冗余防御 / 防 provider degradation 漏检）/ **β** 不计 onFailure / 仅 emit observability event（避免 false positive trip / 短 prompt + tool-only response 合法 0-chunk 场景）/ **γ** 区分真 0-chunk vs parser drift（M#3 单实例约束精度 / 增 metadata 字段 / over-engineering 风险）/ **phase 622 28 原则 derive**：α D5 冗余防御 dominant + YAGNI / β YAGNI + 0 误报但漏检风险 / γ over-engineering reject（反 YAGNI + M#7 元数据扩）/ **业务方向决策性**：breaker 灵敏度策略 / 误报损失（短 prompt 0-chunk 误判 trip）vs 漏检损失（silent provider stall 漏）权衡 / **默推 α 保守失效优先** / 用户 binary 拍板待 / 推 r76+ code phase 落地 |
| **B.llm-orchestrator-error-dead-class LLMOrchestratorError class dead** | drift / 低 / r72 G fork phase 599 ratify 标 ⚓8 部分可决 / r74 J fork 登记 | **✅ closed by phase 622**（B fork r75 / α 删 dominant 自决 / 28 原则 4/4 align：YAGNI + M#7 + M#8 + M#1 / 推 r76+ code phase 落地）| 实然 `index.ts:46-58` `export class LLMOrchestratorError extends Error { code: string; cause?: unknown }` / grep 全栈 0 真 caller throw 或 instanceof 检查 / dead class 占空间不带语义 / 候选：**α** 删除 + r76+ 重设计 specific error classes（YAGNI 强 / 0 真 caller / 删收紧表面）/ **β** 落地 typed throw（caller cascade 实施 + 业务决策真值 generic-vs-specific）/ **γ** 占位保留（兼容性 placeholder / 实然 0 export 引用反 placeholder 假定）/ **phase 622 28 原则 derive**：α 4 项 align（YAGNI + M#7 删 export 收紧 + M#8 最小耦合 + M#1 specific error 重设计 r76+）/ β 1 项 align / γ 0 项 align（占位无语义 reject）/ **dominant 自决 closed by phase 622** / 推 r76+ code phase 实施（α 删除 + specific error classes 重设计 / cascade catcher 强类型）/ **兑现 by phase 631**（B fork r76 / 起步 SHA `c0e8e6ed` / framing reframe：dispatch α "重设计 specific error classes" 起草未 grep types/errors.ts → Path #1 实测既存完整 LLMError hierarchy（LLMError + LLMRateLimitError + LLMTimeoutError + LLMAllProvidersFailedError）+ makeExternalAbortError + LLMEvent context_exceeded_failover 事件驱动 → α' 删 + 0 NEW（5/5 dominant 强于 α 1/5）/ Step 0 sweep 浮出 LLMProviderError sister cluster 同型 dead class N=2 / 删 ~-35 行 / 0 caller cascade / 0 NEW class / 0 NEW tests）|

### 7.C 应然原则对照

> 仅列**应然**对各原则的承诺立场。

#### Module Logic Principles（11 条）

- **M#1 独立可变职责**：单一职责 = 多 provider 容错编排（r61+ 拆出 L1 LLMProvider 后真合规）
- **M#2 业务语义归属**：own LLM 协议层错误识别加多 provider 协调
- **M#3 资源归属**：多 provider 容错状态唯一归属 / 占用 LLM audit 命名空间
- **M#4 持久化**：容错状态不持久化（重启 stale 不恢复 / §7.B 论证）/ 审计经 L2 AuditLog 持久化
- **M#5 单向依赖**：LLMOrchestrator → L1 LLMProvider + L2 AuditLog（同层）（per arch §11 表 1）/ 0 反向
- **M#6 依赖结构稳定**：构造期 `LLMOrchestratorConfig` 注入 / 运行期不变
- **M#7 耦合界面稳定**：`createLLMOrchestrator(config): LLMOrchestrator` 工厂
- **M#8 耦合界面最小**：灰度（StreamChunk type 转发是 provider 异构必要面）
- **M#9 显式表达编译器可检**：`LLMAllProvidersFailedError` 命名 class / LLMEvent discriminated union（旧 `LLMOrchestratorError` dead class 已 phase 631 删 / 复用 types/errors.ts 既有 LLMError hierarchy）
- **M#10 不合理停下** / **M#11 边界不对停下**：未触发

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
- **P3 分多个智能体加分子任务**：单一 LLMOrchestrator 代码基 / provider config 按身份注入
- **P4 系统为智能体服务**：LLMOrchestrator 提供基础设施 / 不参与决策 / 仅 call/stream 协议

#### Path Principles（7 条）

- **Path #1 路径规划基于规划时刻的事实**：治理动作要 grep 实然代码佐证（注意实施过程中实然的变化）
- **Path #2 实然和应然差距显式登记**：违规明文上墙（在路径规划时参考 / §7.A + §7.B）
- **Path #3 语义原子变更单元**：契约修订 APPEND 加节不重写 / 1 phase = 1 commit 原子
- **Path #4 可回滚 + 破坏性论证**：API 改动 caller 评估 / 破坏性改动显式论证
- **Path #5 完成后复盘**：phase 收尾三维 + Path Principles 第 4 维对账
- **Path #6 冲突立即中断**：scope 模糊或决策点必停报告（冲突调整优先于强行推进）
- **Path #7 总难度路径**：实然到达应然有诸多路径 / 选择降低总难度的（步骤间有相互作用 / 总难度 ≠ 各步骤成本简单相加）

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
- 2026-05-04 / cross-doc audit drift 修订（§7.C P3 verbatim「分多个智能体加分子任务」/ Module Logic 命名 M1-M11 → M#1-M#11 / §3 资源改 table 「无」+ 注脚 align 其他模块）
- 2026-05-04 / phase473 r63 D fork double-check 复审（design only / 0 src 改 / 用户拍板候选 α + δ 双合）/ r60 浮出「L1 LLMService M#1 violation」design-gap **实然已完全闭环**（phase413 + phase449）/ §7.A 6/6 全清零确认 / §7.B 2 项偏差（reset chunk 丢弃决策 / Circuit breaker mem-only）皆有升档条件 / 当前合规。候选 γ（拆 orchestrator.ts 520 行业务体为 circuit breaker + failover + retry + idle timeout 四 strategy file）评估为 **over-engineering**：容错四件套是 cohesive 业务概念（circuit breaker 状态决定 failover 时机 / failover 决定 retry 起点 / idle timeout 决定 abort 路径）/ 拆开违 M#1 独立可变测试 / 拆开 4 file 必 lockstep 改 / 增 inter-file dep map 违 M#8。**0 r64+ code phase 启动** / D fork closed by phase413+phase449 复审确认
- 2026-05-05 / r65 cross-doc audit 单 doc 一致性核（modules/l2_llm_orchestrator.md vs arch §11 + 表 1/2 + interfaces/l2b.md LLMOrchestrator 节）/ 0 derive drift / 主 derive 全 align（M#1-M#11 + Design Principle D1a-d + D2/D3+**D4 核心驱动**（failover+CB+retry+idle+context_exceeded）+D5/D7/D8 + D6/D9-D11 无关 + Philosophy P2+P3+P4 + Path #1-#7）/ 8 主能力 align arch 表 2 / 2 dep + caller StepExecutor align arch 表 1 / phase251+254+263+284+313+317+408（**§7.A 6/6 全清零里程碑**）+ phase413（**整模块拆出模板第 2 次复用 / 模块边界重构最后大候选闭环**）+ phase473（**业务决策性 phase 待用户拍板模板第 2 实证** / γ over-engineering 否决）多里程碑稳态保留 / L2b.G1 events sink fan-out + L2b.G2 失败 audit 描述精度 design-gap 已登记 §B（业务决策性 α/β 候选）/ design only / 0 src 改
- 2026-05-05 / **phase 498 caller DIP enforce: LLMOrchestratorImpl → LLMOrchestrator type rename**（main `b64391a1`）/ factory `createLLMOrchestrator` 返 type 改 LLMOrchestrator interface / 2 src caller cascade（assemble.ts:166 + start.ts:15+170）/ **start.ts ctor 改 factory** `new LLMOrchestratorImpl({...})` → `createLLMOrchestrator({...})` / Impl class 仍 export from barrel（备 tests white-box / `src/index.ts:20` re-export 不动）/ 0 行为差 / 1403 tests PASS / 同 phase 同治理 ToolRegistryImpl / **「caller DIP enforce cluster」累 3 实证**（phase 414b ContractManager + phase 498 LLMOrchestrator + phase 498 ToolRegistry）/ 28 条原则核：M#7+M#8 align 治理 / M#9 仍 align / tests/foundation/llm.test.ts 多处 `new LLMOrchestratorImpl({})` 保（white-box）/ scope 收紧不动 AuditWriter 35 caller（用户决策推 r+1）
- 2026-05-10 / **r76 D fork user binary ratify ε（probe-then-decide / B.stream-idle-failover-vs-retry-symmetry ⚓4）**（design only / 0 src / 0 commit src）/ phase 622 默推 α reject by user / **ε ratified**：stream idle → minimal call probe（复用 healthCheck pattern / `messages: [{role:'user', content:'Hi'}], maxTokens:1` / probe timeoutMs 默 5s）→ probe success（provider 活）→ retry same provider stream / probe failure（network/timeout）→ failover 下一 provider / probe auth/model 错 → throw user-facing reconfigure / **probe 归 L2 LLMOrchestrator** private method（M#5 单向依赖 + M#7 接口稳定 + M#1 容错 own + YAGNI 不抽 ProbeService 5/5 align）/ DRY 候选：抽 `_minimalProbe(provider, timeoutMs)` helper / healthCheck + stream idle probe 双 caller 复用（推 r76+ code phase 选 derive）/ 业务 derive 锚点：「确认 provider 无法响应 call」= probe failure 真信号 / stream idle 单一信号不能判 stuck / **「principle-derived ratify」N=4 实证累**（phase 599+603+622+本 ratify）/ **「F fork ratify → r+1 code phase 落地」三阶段链路第 N+1 实证**（J 起草 → B 622 ratify → 本 ε ratify → r76+ code）/ §B.stream-idle row close from "pending" → "ε ratified by user binary"
- 2026-05-10 / **phase 637 ⚓4 ε probe-then-decide 落地 + ⚓5 α default 兑现（B fork r77 / 起步 SHA `c0e8e6ed` / 主会话 plan + 用户 code 实施 per `feedback_plan_by_main_implement_by_user`）**/ §B.stream-idle-failover-vs-retry-symmetry ε 兑现（NEW _minimalProbe(provider, timeoutMs) helper + healthCheck refactor 用 helper + stream idle handler line 401-413 重组 + 2 NEW LLMEvent variants（stream_idle_probe_attempted + stream_idle_probe_succeeded）+ 2 NEW LLM_AUDIT_EVENTS const（STREAM_IDLE_PROBE_ATTEMPTED + STREAM_IDLE_PROBE_SUCCEEDED）+ sink case + LLMCallOptions +`streamIdleProbeTimeoutMs?` optional default 5000ms / 0 caller cascade）+ §B.stream-zero-chunk-breaker-sensitivity α default 兑现（doc comment 加 line 451-462 / 0 行为差）/ Path #1 dispatch 双 reframe：⚓4 dispatch α default → 实然 ε ratified by user binary at r76 D fork（design row line 118）+ ⚓5 dispatch α default → 实然 0 行为差兑现 / 4 src files + 1 NEW test + 1 既有 test 加 assertion / 净 ~+150 行 / 反向 3/3 PASS / **「F fork ratify → r+1 code phase 落地」三阶段链路第 5 实证（4 阶段链路）**（phase 599 起草 → 622 ratify → 628 user pick → 637 code 落地 / Meta 41 已立 / 持续硬化 N=5）/ **「dispatch claim framing reframe」N+1 实证**（同型 phase 631 dispatch α "重设计" stale 模板扩 ratify domain / 推 r78+ 升格独立 feedback）/ **「DRY helper 抽出 cluster」N+1 实证**（_minimalProbe 双 caller 复用 / shared helper N=8+ 实证扩 / phase 504+517+563+581+592+598+605+637）/ **「probe-then-decide 模板」首发**（idle event → quick check → decide retry vs failover / 推 r78+ 同型再遇升格独立 feedback）/ **「pending → default α 兑现」候选模板**（⚓5 0 code change + doc comment + design row close）/ **「review claim 实测四态分类」第 N+1 实证累**（VERIFIED framing 不全 reframe + VERIFIED tight + VERIFIED partial）/ **「既有 const/callback 复用」边界条件第 4 实证**（双向：⚓4 必 NEW 2 events + ⚓5 必 0 NEW / phase 613 audit + 619 stream + 631 error class + 637 ratify domain 四 domain 累）
- 2026-05-10 / **phase 631 LLMOrchestratorError + LLMProviderError dead class 删（B fork r76 / 起步 SHA `c0e8e6ed` / 主会话 plan + 用户 code 实施 per `feedback_plan_by_main_implement_by_user`）**/ 删 2 dead class（llm-orchestrator/index.ts:43-58 LLMOrchestratorError + llm-provider/index.ts:37-55 LLMProviderError）/ 0 caller cascade / 0 NEW class / 0 NEW tests / 净 ~-35 行 / **framing reframe**：dispatch α "重设计 specific error classes" 起草未 grep types/errors.ts → Path #1 实测既存完整 LLMError hierarchy（LLMError + LLMRateLimitError + LLMTimeoutError + LLMAllProvidersFailedError）+ makeExternalAbortError + LLMEvent context_exceeded_failover 事件驱动 + stop reason `'max_tokens'` → α' 删 + 0 NEW（5/5 dominant vs α 1/5）/ Step 0 sweep 浮出 LLMProviderError sister cluster 同型 dead class N=2 / **「F fork ratify → r+1 code phase 落地」三阶段链路完整 N=4 实证累**（phase 599 起草 → 622 ratify dominant → 631 code 兑现）/ **「dispatch claim framing reframe → α stale → α' 复用既有」首发模板**（推 r77+ ≥ 2 实证升格独立 feedback / 同根 phase 596 dispatch 标 NEW const → 实测既有可复用 / 模板扩 error class 域）/ **「dispatch 标 1 site → Step 0 sweep 扩 N site」N+1 实证累**（phase 562+568+598+619+631）/ **「既有 const/callback 复用」纪律边界条件第 3 实证**（phase 613 audit + 619 stream + 631 error class / cluster 跨三 domain）/ **「review claim 实测四态分类」第 N+1 实证累**（VERIFIED tight 1 + framing 不全 1 reframe + 副发现 1）/ **「dead error class cluster sweep」候选首发**（推 r77+ 跨模块 sweep）/ **「phase 号 race 实证累」N=10**（mkdir phase 629 输给 C fork → 顺延 phase 631）/ §B.llm-orchestrator-error-dead-class row 兑现注追加 + §7.C M#9 line 136 例子改（删 LLMOrchestratorError 引用 / 保 LLMAllProvidersFailedError + LLMEvent）/ 反向 3/3 PASS
- 2026-05-10 / **phase 634 CircuitBreaker class 抽至 circuit-breaker.ts（E fork r77 / 主会话 plan + 用户 code 实施 per `feedback_plan_by_main_implement_by_user`）**（main `6ccf0a60`）/ NEW `src/foundation/llm-orchestrator/circuit-breaker.ts` 56 行（class CircuitBreaker + 块注释 + `export` 关键字 / sharpen 块注释自描述边界 = 「Module-level state machine ... not exported from barrel (implementation detail of llm-orchestrator)」）/ orchestrator.ts 删 line 70-121（块注释 + class / 共 52 行）+ 加 1 行 `import { CircuitBreaker } from './circuit-breaker.js'` / 净瘦 563 → 511 行 / **0 行为差 / 0 接口变 / 0 caller cascade / 0 design row 改 / 0 NEW const / 0 NEW test** / 既有 1510+ tests 全 PASS（含 timeout-distinction + merge-signals-cleanup 含 breaker_half_open + breaker_closed transition cases）/ 反向 3/3 PASS / **形态 A.4 module-level state daemon 子形态**（CircuitBreaker self-contained / 4 field 全 self-contained / 0 跨 LLMOrchestratorImpl state 引用 / 内部 2 ref 点 line 140 type + 154 instantiation）/ ROI 判据 0/3 命中（method 共享 / state 体量 / 用户感知 全不命中 / per `feedback_module_split_roi_audit_first`）/ **phase 493 watchdog state daemon 抽模板 N+1 实证**（A.4 模板复用累）/ **「极保守 A.4 module-level state class 抽 / 0 export 跨 barrel」首发模板** N=1（推 r78+ ≥ 2 实证升格独立 feedback）/ **「同 file 多 fork 区间不重叠协调」第 N+1 实证累**（r73 D 先 B 后 → r77 E 先 B 后 / E line 70-121 vs B fork ⚓4+⚓5 line 392-453 / 0 重叠）/ **「review claim 实测四态分类」第 N+1 实证累**（VERIFIED tight：dispatch §E 候选 2 OpenAI orchestrator.ts CircuitBreaker 抽 实测 0 漂移 / 行号 + 净瘦估均 align）/ **「大文件治理收尾 cluster」**：phase 630 评估 → r77 D fork phase 633 openai.ts 拆 + 本 phase 634 CircuitBreaker 抽（4 候选中 2 落地 / runtime.ts + assemble.ts 推 r78+ 谨慎）
- 2026-05-10 / **phase 622 r74 J fork 5 ⚓ design ratify cluster（B fork r75 / single design phase）**（main `<sha 待 commit 后填>`）/ r74 J fork 5 ⚓ row 起草 → r75 B ratify（mirror phase 599+603 design only ratify 模板第 3 实证）/ Path #1 5/5 fresh / 28 原则 cross-check 完成 / **1 ⚓ dominant 自决 closed**（⚓8 LLMOrchestratorError dead class / α 删 / YAGNI + M#7 + M#8 + M#1 全 align / 推 r76+ code phase 删除 + specific error classes 重设计）+ **2 ⚓ pending user binary**（⚓4 stream-idle-failover-vs-retry-symmetry 默推 α design intent 锁 + ⚓5 stream-zero-chunk-breaker-sensitivity 默推 α 保守 / 业务方向真选择）/ 跨模块 cross-cutting same-day：l5_runtime §B.outbox-error-response-strategy（⚓2 默推 α）+ l4_memory_system §B.random-dream-pulse-strategy（⚓11 默推 α）/ **「principle-derived ratify」N=3 实证升格阈值过线**（phase 599 + 603 + 622 / Meta 41 加成 / 升格独立 feedback 阈值达 N=2）/ **「F fork ratify → r+1 code phase 落地」cluster 三阶段链路扩**（J fork 起草 → B fork ratify → r76+ code phase 落地）/ **design only 单 Step 内联模板第 9 实证累**（phase 503+505+545+554+560+567+599+603+622）/ §B.stream-idle + §B.0-chunk + §B.dead-class 3 row refine（dead class closed by phase 622 / 余 2 ⚓ pending refine）
- 2026-05-10 / **phase 660 P1.5 idleTimeoutMs 弃用清理（B fork r83 / 起步 SHA `c036e72a` / 主会话 plan + 用户 code 实施 per `feedback_plan_by_main_implement_by_user`）**/ phase 538 deprecated 标 → r83 phase 660 兑现（**14 r 兑现** / mirror B.r68-2 verifier-job 8 r 模板）/ §B.call-idle-mismatch row 末追加 alias 真删兑现注 / L1+L2 LLMCallOptions.idleTimeoutMs 双删（L1 dead literal + L2 @deprecated alias）+ orchestrator 8 处 fallback + strip + emit/error msg 清理 + step-executor.ts:42 caller cascade（idleTimeoutMs → streamIdleTimeoutMs / mirror stream 路径语义）+ tests cascade（rename 3 + DELETE 1 alias test）/ 高层各域合法字段保留（不在 deprecation 范围）/ ~-40 行 / 0 NEW const / 0 NEW field / 反向 3/3 PASS / **「dead literal cluster cleanup」N=3 实证升格阈值过线**（phase 640 dead error class + 656 dead literal + 660 idleTimeoutMs 双 dead / Meta 45 候选独立 feedback）/ **「dispatch claim framing reframe」N=4 实证累**（phase 631+637+642+660）/ **「dispatch claim sweep estimate vs actual scope」N+1 实证**（dispatch 43 → 实然 ≤ 10）/ **「设计 admit 升 r+1+ 多 r 轮兑现」N+1 实证**（mirror B.r68-2 8 r 模板）/ **「review claim 实测四态分类」第 N+1 实证累**（VERIFIED tight 1 + framing 不全 1 + partial reframe 1）
- 2026-05-10 / **phase 643 大文件拆续 r78 复评（E fork r78 / design only / 0 src 改 / 起步 SHA `f6bb0827`）**（design phase / 主会话 own）/ phase 630 §2.2 + phase 634（CircuitBreaker 抽 -46 行）+ phase 637（⚓4 ε probe-then-decide + ⚓5 α default 加 _minimalProbe method +33 行）后 r78 复评 / orchestrator.ts 实测 570 行（vs phase 630 估 563 / +7 = phase 637 ⚓4 加）/ Path #1 结构核：call() ~134 + stream() ~205 + updateLastSuccess + getProviderInfo + _minimalProbe + healthCheck + close 4 small helpers / 共享 ≥ 7 field（this.breakers + events + fallbacks + config + primary + currentProviderIndex + lastSuccessProvider）/ ROI 3 判据 2/3 命中（method 共享重 + class state 边缘 + 用户感知 0）/ **4 拆形态深核**：(α) 极保守抽 mergeSignals + delay + const → ~60 行净抽 / 收益 ~10% / 边际递减 / (β) 中度抽 retry-with-fallback shared helper → 接口面 ≥ 6 param + callFn call vs stream 行为差不可统一抽 / 抽象漏顶 / phase 630 §2.2 已论证 ROI 边缘 / r78 复评一致 / (γ) 激进 sub-class split → 反 phase 489 教训 state 共享强 / ROI 反向 / (**δ 不拆 推荐**) phase 634 α 已收 medium ROI / 续拆收益小风险中-高 / **推荐 δ 不拆 / 推 r79+ 视野再上移**（如未来 ≥ 1000 行 + sub-concern 边界更稳定后再评估）/ 0 code phase 落地 / **「saturate-tier 大文件持续 ROI 反向 → 推后稳态」首发模板**（升格独立 feedback 候选 N=1 / 推 r79+ 同型再遇升格）/ **「大文件拆 cluster r 接力评估」N+1 实证累**（phase 630 4 候选首发 + phase 634 α 兑现 + phase 643 r78 复评 / 升格阈值过线候选 N=2）/ **「design closure phase 单 Step 内联」第 N=10 实证累** / **「业务决策性 phase 评估呈献多候选 / 不强行 dominant 自决」首发模板**

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
