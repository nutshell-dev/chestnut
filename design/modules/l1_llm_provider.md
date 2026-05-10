# LLMProvider 模块内部契约

> 本文档限本模块**内部**应然 — 8 节结构 derive 自 Module Logic Principles：§1-§4 = M#1-#4 各占一节，§5 审计 = M#3 命名空间细则，§6 层级，§7 drift = M#10/#11，§8 测试。
> 跨模块对外承诺（接口签名、生产/消费方、归本模块加不归本模块、不可消除耦合理由）见 [interfaces/l1.md](../interfaces/l1.md) LLMProvider 节。
> 模块本质加层归属见 [architecture.md](../architecture.md)。

## 1. 职责（M#1 独立可变职责）

> 本节内容 derive 自 [architecture.md](../architecture.md) §3「LLMProvider 本质：单一 LLM provider 调用能力的原语 / L1 原语 / 判据『不依赖任何业务语义就能存在』」加 M#1 / M#2 / M#3 / M#5。

### 做

应用 M#1（一个模块封装一组独立可变的职责），LLMProvider 的单一职责 = **单一 LLM provider 调用能力的原语暴露加 SDK 异构吸收**：

- **单 provider 调用原语暴露**：一次性调用（`call` 返完整 response）加流式调用（`stream` 吐 chunk 序列）— 这是任何 LLM provider 调用机制的能力概念。
- **SDK 异构吸收**：吸收各 LLM provider SDK 异构（Claude SDK / Anthropic-兼容 / OpenAI / Gemini）— 调用方写一套代码经任意 provider 调（derive 自 Design Principle「分布式部署加跨平台」）。
- **abort 透传**：AbortSignal 透传到 SDK / 调用方决定何时 abort，本模块不内化 abort 策略。
- **KV cache 标记透传**：`cache_control` 标记由调用方放入 messages / 本模块原样转发给 provider — 不实现 cache 策略本身。

> 具体 API 形态归 [interfaces/l1.md](../interfaces/l1.md) LLMProvider 节。

### 不做

- **不 own 任何 clawforum 业务概念**（不知 agent / claw / motion / dialog / inbox / outbox / contract / messages 排列规则等）— derive 自 M#2 业务语义归属（LLMProvider 业务语义仅 LLM SDK 调用级）加 M#5 单向依赖
- **不 own 多 provider 协调**（primary + fallbacks 选择 / failover 切换归 L2 LLMOrchestrator）— derive 自 M#1 独立可变职责
- **不 own 重试加 backoff**（retry 加指数退避归 L2 LLMOrchestrator）— derive 自 M#1
- **不 own circuit breaker**（连续失败 / cooldown / half-open 探测归 L2 LLMOrchestrator）— derive 自 M#1
- **不 own idle timeout**（business 级 timeout 决策归 L2 LLMOrchestrator）— derive 自 M#1
- **不 own context_exceeded failover**（多 provider 切换决策归 L2 LLMOrchestrator）— derive 自 M#1
- **不 own message 语义**（assistant / tool_use / tool_result 排列规则归 L3 StepExecutor）— derive 自 M#1
- **不 own tool 执行**（tool_use 作为 chunk 吐出 / handler 归 StepExecutor）— derive 自 M#1
- **不 own KV cache 策略**（cache_control 标记由调用方放入 messages / 本模块只转发）— derive 自 M#1 + M#2
- **不 own token 计费 / 预算管控**（消费者侧业务策略）— derive 自 M#1
- **不 own 模板组装**（system prompt / messages 由调用方传完整内容）— derive 自 M#1 + M#2
- **不 own audit.write**（LLMProvider 不产生事件 / 失败抛 typed error 由 caller L2 LLMOrchestrator 决策 + emit 容错 audit）— derive 自 M#5 依赖单向

## 2. 业务语义（M#2 业务语义归属）

> 应用 M#2（模块为自己的业务语义负责），LLMProvider 的业务语义边界：

- **own**：LLM SDK 调用概念 — messages 数组加 cache_control 标记加 provider 字符串加 StreamChunk type 加 LLMResponse 等。这些是 LLMProvider 唯一懂的「业务」（LLM SDK 异构吸收级，不是 clawforum 业务级）。
- **角色定位**：LLMProvider 是「**单 provider 调用通道**」非「**容错编排器**」。仅提供单 provider 调用机制，不持容错策略加多 provider 协调（归 L2 LLMOrchestrator）。

## 3. 资源（M#3 资源唯一归属）

> 应用 M#3（每种资源只归属唯一模块），LLMProvider 独占的资源：

| 资源 | 类别 | 持久化 |
|---|---|---|
| 单一 LLM provider SDK 接入（M#5 业务模块不直 import provider SDK / 经 L2 LLMOrchestrator 间接调用）| 概念性 / 唯一入口 | — |

**LLMProvider 是 clawforum 对单 provider SDK 的唯一调用入口** — 每实例一个 provider / 多 provider 协调归 L2 LLMOrchestrator / 单 provider 调用无状态（每次 call/stream 独立）。

> 注：(1) provider 配置构造期注入 / 运行期不变（实施细节 / 非 M#3 业务资源）/ (2) 不占用 audit 命名空间（自身不发 audit / 失败抛 typed error 给 L2 LLMOrchestrator 决策 / 详 §5）。

## 4. 持久化（M#4）

> 应用 M#4（持久化一切信息到磁盘 / 运行时句柄从磁盘信息重建），LLMProvider 自身的持久化立场：

- **模块零状态**：LLMProvider 不持自有磁盘 artifact 加运行时持久状态 — 是无状态服务。
- **重建语义**：进程重启时 provider 配置由调用方装配期重新注入 / 内部无需从磁盘恢复状态。
- **无业务事件持久化**：LLMProvider 不产生事件（详 §5）/ 失败仅抛 typed error / 容错事件持久化归 L2 LLMOrchestrator。

## 5. 审计事件清单

**LLMProvider 不产生 audit 事件**（应然 / L1 不反向依赖 L2）。失败抛 typed error 给 caller（L2 LLMOrchestrator）决策。

容错事件清单（provider_attempt_failed / retry_scheduled / fallback_switched / breaker_* / idle_failover_triggered / context_exceeded_failover 等）归 [l2_llm_orchestrator.md](l2_llm_orchestrator.md) §5。

## 6. 层级声明

L1 原语 / 外部 LLM provider 异构吸收层 / 不持业务语义。详见 [architecture.md](../architecture.md) 加 [interfaces/l1.md](../interfaces/l1.md)。

## 7. 应然 vs 实然差距登记（M#10 / M#11）

> 原则：本节只登记**实然 ≠ 应然**的 gap（待治理或已治理的历史）+ 偏差 + 历史纪律。当前实然若与应然 align 则不在此登记。

### 7.A 必修违规（含历史已闭环）

> **§7.A 0 open drift**（r60 浮出 L1 LLMService M#1 violation design-gap → phase413 + phase449 闭环 / r63 D fork phase 473 double-check 复审 候选 α + δ 双合 / 详 §7.D）。

| §A 条 | 类型 | 状态 | 触发情境 |
|---|---|---|---|
| ~~audit-sink 物理位置 drift~~ | drift | **✅ closed（phase328 / SHA `430e342`）** | audit-sink 物理迁 src/foundation/llm → src/assembly |
| ~~A.1 interface 名 + signature drift / 物理迁未实施~~ | ~~drift / 高~~ | **✅ closed phase413**（main `9fee6b69`）+ **shim 收尾 phase449**（main `49aa849d`） | 物理拆 src/foundation/llm/ → src/foundation/llm-provider/（L1 / 5 adapter + presets + abort-helper + types）+ src/foundation/llm-orchestrator/（L2 / orchestrator.ts 533 行业务体 + types）/ LLMProvider interface 实装 + createLLMProvider 工厂 + LLMProviderError class / class rename LLMServiceImpl → LLMOrchestratorImpl / 接口 LLMService → LLMOrchestrator / 20+ caller files rename + import path 改 / 18+ tests/ 文件 mock + import 改 / src/foundation/llm/index.ts 留 re-export shim 向后兼容 / 反向 3 项实跑 / 1370 测试 PASS / 整模块拆出模板第 2 次复用（同 phase411 EvolutionSystem）/ **phase449 closure 兑现**：删 `src/foundation/llm/` shim（49 行 / 0 caller 实测 EXIT=1 `grep -rln "from.*foundation/llm['\"]" src/ tests/`）+ 清 5 处 stale comment（`LLMServiceImpl` 名残 × 2 + `LLMService` 名残 × 2 + `foundation/llm/abort-helper` path 残 × 1）/ **phase473 复审**（r63 D fork / design only / 0 src 改）：候选 α + δ 双合 / 进一步拆 5 adapter sub-module 或 LLMOrchestrator 4 strategy 是 over-engineering（DRY reflex 反例 + M#1 反向 / cohesive 业务概念）/ 0 r64+ code phase 启动 |
| **A.gemini-sse-callback-symmetry GeminiAdapter SSE parser 0 onStreamParseError callback 跨 provider 异质** | drift / 中 / r80 D fork phase 650 P0.1 derive | **✅ closed by phase 653**（B fork r81）| **触发**：phase 642 mirror phase 630 模板抽 SSE parser 时 5th param onStreamParseError 漏 / Gemini SSE parse error → 0 callback emit / silent X 跨 provider 异质（vs openai-sse-parser.ts:23-29 + custom-anthropic-sse-parser.ts 都含 5 params + onStreamParseError? callback / vs OpenAIAdapter line 97 onStreamParseError? field）。**phase 653 修**：α gemini-sse-parser.ts:25 加 5th param `onStreamParseError?: (event: { provider: string; raw: string; error: string }) => void` + 删 'wrong-name' debug default（providerName 改 required）+ SSE parse error catch 路径 callback emit + GeminiAdapter class 加 `onStreamParseError?` field（mirror OpenAIAdapter line 97）+ gemini.ts:133 `parseGeminiSSEStream(..., this.name, this.onStreamParseError)` 5 params。**「provider library 拆三分」phase 642 模板完整收尾**（phase 630 openai + 642 custom-anthropic+gemini 拆 + 653 Gemini callback / 跨 provider 完全一致）|
| **A.custom-anthropic-response-schema-check** | hygiene / 中 / r80 D fork phase 650 P2.9 浮出 / r83 C fork landing | ✅ **closed by phase 659（C fork r83 / commit `b8277902`）** | custom-anthropic-response-parser.ts:22 `data.content as ContentBlock[]` 强转 0 schema check / type assertion 逃逸（mirror phase 587 contract dir JSON.parse + phase 576 lock schema 同型）/ phase 659 加 inline schema check：`if (!Array.isArray(...)) throw` + 保留 cast / **「JSON.parse type assertion 逃逸 schema 校验」第 N+1 实证累**（phase 576+587+659 / Meta 41 升格 feedback 持续硬化）/ M#9+M#10 align |
| ~~**A.barrel-completeness abort helpers 未走 barrel**~~ | drift | **✅ closed by phase 683 Step G** | `llm-provider/index.ts` 加 export `classifyFetchAbortError` + `makeExternalAbortError` + `AbortReason`（3 symbol）/ `subagent/agent.ts:15-16` 改 import 路径走 barrel（`foundation/llm-provider/index.js`）/ `orchestrator.ts:29` 同模块内保留 sub-path（`../llm-provider/abort-helper.js` / 例外：同模块内不绕自家 barrel）/ 0 行为差 / `tsc+test` 全绿 |

> 容错相关 §A 历史条目（A.1 / A.3 / A.4 / A.5 / A.6 / breaker events / 30s magic）已迁 [l2_llm_orchestrator.md](l2_llm_orchestrator.md) §7.A。

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| `createProvider` 双形态入参（鸭子测试）| 测试注入点 / 轻微违反耦合界面稳定 | 抽 `LLMProviderConfig.adapterFactory?` 显式化 |
| `StreamChunk.type` union 扩张原则 | 非破坏加法 / 新 type 对旧消费者必须 safe-ignore | 引入新 type 时遵守 |
| ~~`healthCheck` 失败返 false 而非抛错~~ | ~~与 call/stream 语义不对称 / 调用方通常是 Daemon 启动期可选探测 / 沉默 false 合理~~ | **✅ closed by ε spec 修正（2026-05-07）**：描述错位 / healthCheck 是 L2 LLMOrchestrator 行为（`l2_llm_orchestrator.md §1` + audit `healthcheck_failed` line 74）/ L1 LLMProvider 0 healthCheck method（实然 interface 仅 name/model+call+stream?）/ 同 §8 修正联动 |
| `LLMProvider` interface 位置分裂 | interface 写在 index.ts / Impl 又回 import types / 历史遗留 | 清理不紧急 |
| ~~中断原因未传递~~ | ~~drift / 中~~ | **✅ closed by sweep（r64 起步前 Path #1 实测 / 同 evolution-system isProgrammingBug 同型 stale）**：实然链路 100% 实施 / `AbortReason` union 5 类（user / idle_timeout / step_yield / turn_timeout / external / abort-helper.ts:98-103）+ `makeExternalAbortError(reason?: AbortReason)` signature 已接 reason（line 112）+ 错误对象挂 `err.cause = validReason` + message tail 含 `(cause=..., ms=...)` + 6 caller 全传 reason（orchestrator.ts × 5 / anthropic.ts:94 / abort-helper.ts:89 / agent.ts:217）+ SubAgent 5 类专用 Error 分发（agent.ts:207-219 / turn_timeout → ToolTimeoutError / idle_timeout → IdleTimeoutSignal / user → UserInterrupt / step_yield → PriorityInboxInterrupt）+ catch audit 写明 cause（agent.ts:355-372）/ phase/SHA 待溯源（grep blame `AbortReason` 首引入）|
| **B.stream-cleanup-cross-provider-align** stream finally `reader.releaseLock()` cleanup catch 跨 provider 不一致（gemini console.warn vs openai+custom-anthropic silent） | r71 C fork phase 591 derive | **closed by phase 591**（main `1d5e0680` / merge `1036cd25`）| 实然 `gemini.ts:288-290` `try { reader.releaseLock(); } catch (err) { console.warn('[gemini] reader.releaseLock() failed during cleanup:', err); }` vs `openai.ts:383-387` + `custom-anthropic.ts:262-266` 都 silent + 注释「Ignore: pending read during timeout/abort; stream will be GC'd」/ **真问题**：cleanup race 是 GC 自然行为非异常 / 三 provider 同 protocol 同 cleanup 行为应统一 / gemini console.warn 违 phase 529 anchor「TUI raw mode 渲染防 console 污染」/ **phase 591 决策（28 原则核 5/5 一致 dominant 自决）**：β 删 gemini console.warn 改 silent + 注释 align openai+custom-anthropic / cleanup race silent 是 design intent（GC 自然 / 非异常 / 不需 user-visible warn）/ 跨 provider 行为统一 / α 反向 openai+custom-anthropic 加 console.warn 违 phase 529 anchor + 无价值 reject / γ NODE_ENV check 过度抽象 reject |
| B.gemini-done-marker | design intent ratify（accepted-stable / per phase 636 re-verify reframe phase 632 P1.1）| `gemini.ts:230` `if (!data \|\| data === '[DONE]') continue;` 是 dead 防御（impossible input）/ Gemini API（Google `streamGenerateContent` SSE）实然不发 `[DONE]` 终结标记 / done 信号 = `candidate.finishReason`（`gemini.ts:268` 路径 yield done correctly）/ phase 632 P1.1 「与 OpenAI.ts 不对称」framing 错（OpenAI 用 [DONE] / Gemini 用 finishReason / 各自 done 信号机制 / 无 cross-provider asymmetry）/ phase 636 Step A re-verify final = C3 likely STALE / 默 0 修 / 推 r77+ spec 引证窗复查（若 spec 引证 Gemini 偶发 [DONE] / 升 C1 真 P1）|
| **L1.G4** LLM 协议层 schema 单源 ownership 应然显式化 | **业务决策性 design-gap / r64 A 起 cross-doc audit 浮出**：interfaces/l1.md line 196-275 暴露 LLM 协议层全 type schema（Message / TextBlock / ToolUseBlock / ToolResultBlock / LLMCallOptions / LLMResponse / StreamChunk / ToolDefinition）/ 注释 line 277 自 derive「本模块 own LLM 协议层 message + IO + tool definition type 单源（provider 异构吸收的一部分）」/ 但 architecture.md §LLMProvider line 67-70 仅写「单一 LLM provider 调用能力的原语」/ **arch 未显式说 own type schema 单源** / derive 链：M#3「单一资源」+ LLM 协议层 schema 是单一资源 → 归 LLMProvider 单源（同 ToolProtocol type-only ownership 模式）| **业务决策性 / 用户拍板候选**：α arch §LLMProvider 节加一句「own LLM 协议层 message + ToolDefinition schema 单源（per M#3）」/ β arch 表 1 LLMProvider row 资源列「无」改「LLM 协议层 schema 单源（type-only / 同 ToolProtocol 模式）」/ γ 保留现状（interfaces 注释自 derive 已足够）|

> 容错相关 §B 条目（reset chunk 丢弃决策 / Circuit breaker mem-only）已迁 [l2_llm_orchestrator.md](l2_llm_orchestrator.md) §7.B。

### 7.C 应然原则对照

> 仅列**应然**对各原则的承诺立场。

#### Module Logic Principles（11 条）

- **M#1 独立可变职责**：单 provider SDK 调用原语 / 不混业务编排（拆出 L2 LLMOrchestrator 后真合规）
- **M#2 业务语义归属**：仅 LLM SDK 调用级业务语义（messages 加 cache_control 加 StreamChunk 等）/ 不持容错策略
- **M#3 资源归属**：单 provider SDK 接入 / 无磁盘资源 / 无运行期状态
- **M#4 持久化**：模块零状态 / 重启 reset
- **M#5 依赖单向**：不依赖 L2 / 失败抛 typed error / caller（L2 LLMOrchestrator）决策
- **M#6 依赖结构稳定**：构造期 `LLMProviderConfig` 注入 / 运行期不变
- **M#7 耦合界面稳定**：`createProvider(config): LLMProvider` 工厂切换 / 不暴露 Impl class
- **M#8 耦合界面最小**：灰度（9 种 StreamChunk type 是 provider 异构的必要封装面）
- **M#9 显式表达编译器可检**：`LLMProviderError` 命名 class / StreamChunk discriminated union
- **M#10 不合理停下** / **M11 边界不对停下**：未触发

#### Design Principles（11 条 / #1 展 4 面）

- **D1a 信息不丢失**：失败抛 typed error 不静默
- **D1c 中断可恢复**：AbortError 立即抛 / `reset` chunk 通知调用方丢弃部分
- **D2 不得丢弃/静默**：失败 throw / 不软吞 / SSE parse 失败回调暴露
- **D7 系统可信路径**：受信组件
- **D8 事件驱动**：StreamChunk 流式
- **D1b / D1d / D3 / D4 / D5**：归 L2 LLMOrchestrator（容错事件 / 退避状态 / failover / 日志重建）
- **D6 / D9-D11**：无关

#### Philosophy（4 条）

- **P1 Agent 即目录**：无关（LLM 是 L1 原语 / 不直接消费目录形态）
- **P2 上下文工程**：LLM 是上下文执行的核心
- **P3 分多个智能体加分子任务**：单一 LLMProvider 代码基 / provider config 按身份注入
- **P4 系统为智能体服务**：LLMProvider 提供基础设施 / 不参与决策 / 仅 call/stream 协议

#### Path Principles（7 条）

- **Path #1 路径规划基于规划时刻的事实**：治理动作要 grep 实然代码佐证（注意实施过程中实然的变化）
- **Path #2 实然和应然差距显式登记**：违规明文上墙（在路径规划时参考 / §7.A + §7.B）
- **Path #3 语义原子变更单元**：契约修订 APPEND 加节不重写 / 1 phase = 1 commit 原子
- **Path #4 可回滚 + 破坏性论证**：API 改动 caller 评估 / 破坏性改动显式论证
- **Path #5 完成后复盘**：phase 收尾三维 + Path Principles 第 4 维对账
- **Path #6 冲突立即中断**：scope 模糊或决策点必停报告（冲突调整优先于强行推进）
- **Path #7 总难度路径**：实然到达应然有诸多路径 / 选择降低总难度的（步骤间有相互作用 / 总难度 ≠ 各步骤成本简单相加）

### 7.D 历史纪律

详 phase187 / phase212 / phase251 / phase275 / phase328 各 phase 收尾报告。

关键里程碑：
- phase187 L1 LLMService 契约 backfill / §A 4 条聚合登记
- phase212 `createLLMService` 工厂引入（main `5968b3a`）
- phase251 §7.A/§7.B 全核
- phase275 G5 console 评估（0 console 全清确认）
- phase328 audit-sink 物理迁出（main `430e342`）/ L1 真合规 / r34 C / Stage 2 P0 #2
- 2026-05-03 / phase413 LLMService 拆 L1 LLMProvider + L2 LLMOrchestrator 落地（main `9fee6b69`）/ 物理拆 src/foundation/llm/ → src/foundation/llm-provider/（L1 / 5 adapter + presets + abort-helper） + src/foundation/llm-orchestrator/（L2 / orchestrator.ts 533 行业务体）/ LLMProvider interface 实装 + createLLMProvider 工厂 / 20+ caller rename + 18+ tests 改 / src/foundation/llm/index.ts 留 re-export shim 向后兼容 / 整模块拆出模板第 2 次复用 / 模块边界重构阶段最后大候选闭环 / 1370 测试 PASS / 反向 3 项实跑
- 2026-05-04 / phase449 foundation/llm/ shim 删除 + 5 stale comment 清（main `49aa849d`）/ phase413 closure 兑现 / 0 caller 实测 EXIT=1 `grep -rln "from.*foundation/llm['\"]" src/ tests/` / 删 `src/foundation/llm/index.ts`（49 行 re-export shim）+ 清 5 stale comment（`llm-provider/types.ts:152` `LLMServiceImpl` + `llm-orchestrator/types.ts:179` 同 + `llm-orchestrator/types.ts:184` `LLMService` + `llm-orchestrator/orchestrator.ts:4` 同 + `core/subagent/agent.ts:191` path 残）/ 反向 3 项 PASS（grep + tsc 兜底）/ L1-L4 cross-module 候选 #5 闭环
- 2026-05-04 / phase473 r63 D fork double-check 复审（design only / 0 src 改 / 用户拍板候选 α + δ 双合）/ Path #1 实测核：r60 浮出「L1 LLMService M#1 violation」design-gap **实然已完全闭环**（phase413 + phase449）/ §7.A 0 open drift / §7.B 5 项偏差皆有升档条件 / 当前合规。候选 β（拆 5 adapter sub-module + presets / abort-helper 独立模块）+ γ（拆 LLMOrchestrator 4 strategy file）评估为 **over-engineering**：(a) 5 adapter 共享同一 LLM 协议层吸收抽象 / 共变性强 / 拆开违 M#1 反向测试（DRY reflex 反例 / 同 phase361 parseFrontmatter 教训）(b) preset 是 adapter 配置元数据 / 与 adapter 绑定 / 独立模块化违 M#1 (c) orchestrator 容错四件套 cohesive（circuit breaker / failover / retry / idle timeout）/ 拆开违 M#1 反向。**0 r64+ code phase 启动** / D fork closed by phase413+phase449 复审确认
- r60+ 重编号：9 节 → 8 节，每节 derive 自一条 Module Logic Principle（删原 §2 接口 / §5 上游依赖 / §6 不可消除耦合 → 已并入 interfaces/l1.md / 拆原 §1 所有权 hub 为 §1 职责 + §2 业务语义 + §3 资源 + §4 持久化 / 删原 §7 内部不变式 杂物筐 → 行为级回 §1.做、anchor 性质回 §7.A）
- 2026-05-04 / cross-doc audit drift 修订（Module Logic 命名 M1-M11 → M#1-M#11 / §3 资源改 table + 注脚 align 其他模块 / 注：§7.C P3 verbatim + Design 已正确）
- r61+ L1 LLMService 拆 L1 LLMProvider + L2 LLMOrchestrator（M#1 模块边界拆分 / 容错编排迁出本模块 / 容错相关历史 phase254 / phase263 / phase313 / phase408 / r44 A breaker 已迁 [l2_llm_orchestrator.md](l2_llm_orchestrator.md) §7.D）
- 2026-05-05 / r65 cross-doc audit 单 doc 一致性核（modules/l1_llm_provider.md vs arch §3 + 表 1/2 + interfaces/l1.md LLMProvider 节）/ 0 derive drift / 主 derive 全 align（M#1-M#11 + Design Principle D1a/D1c/D2/D7/D8 + D1b/D1d/D3/D4/D5 归 L2 LLMOrchestrator + D6/D9-D11 无关 + Philosophy P2 核心 + P1/P3/P4 中性 + Path #1-#7）/ 4 主能力 align arch 表 2（call/stream + SDK 异构吸收 + abort 透传 + KV cache 透传）/ 0 dep + caller align arch 表 1 / 资源「单一 LLM provider SDK 接入」align「无磁盘」结句 / phase413+phase449+phase473 cascade 闭环 r60 浮出 L1 LLMService M#1 violation / §7.A 0 open / §7.B 5 项升档条件 + L1.G4 design-gap 业务决策性候选保留 / design only / 0 src 改
- 2026-05-07 / **§8 spec stale 修订（A.2/A.3 ε closure / design only）**：删 §8 测试覆盖列「`getProviderInfo()` 当前 provider info」+「`healthCheck()` maxTokens=1 最小探测」2 项描述 / 实然 LLMProvider interface 仅 `name/model + call + stream?`（0 method 暴露）/ 健康探测 + provider 状态查询业务归 L2 LLMOrchestrator（详 arch §3 + 表 2 line 327/335 + interfaces/l1.md:274）/ §8 末尾测试链接更新「健康探测 / provider 状态查询测试归 L2」/ ε spec 修正模板第 2 实证（同 phase 520 L2c.G1 spec 修正模式）/ Path #1 实测核浮出 modules §8 vs arch + interfaces 立场矛盾 / framing 错位 closed
- 2026-05-09 / **phase 592 LLM provider DRY helper cluster A（D fork r71 / main `f7e67a0e` / merge `ae66e0da` / 起步 SHA `7904e91e`）**（code phase / 主会话 plan + 用户 code）/ 5 files +117 -100（净 +17 / caller cascade 净 -72：custom-anthropic -27 + gemini -16 + openai -29 + helper +49 + tests +47）/ 2 高 ROI 抽（5 pattern → 2 落地 / 3 推 r72）：(α) NEW `_helpers.ts throwHttpErrorResponse(provider, response): Promise<never>` 抽 3 fetch-based adapter handleErrorResponse 22 行 byte-identical（openai+custom-anthropic 完全相同 / gemini message format 历史 drift 统一）/ 删 3 private method / 6 调用站 cascade / **gemini message format 统一**（"Server error" → "Provider gemini server error" / "Request failed" → "Provider gemini error" / 28 原则核 5/5 dominant α / M#1+M#7+D5 align）/ (β) `parseRetryAfter` NaN guard `Number.isNaN(ms) ? undefined : ms` + jsdoc revoke note phase 563 prior behavior（0 downstream consumer 用 .retryAfter / NaN type liar / D2 silent latent bug）/ NEW unit tests 5 it 覆 4xx/5xx/429 + 既有 phase 563 NaN test 改 expect undefined / 反向 3 项 PASS / **dispatch 标抽至 BaseHTTPAdapter base class method framing 推翻**（实测类继承图：BaseAnthropicAdapter 仅 anthropic family / openai+gemini 不 extend / NEW BaseHTTPAdapter 类继承重组 over-engineering 违 M#7+M#8+YAGNI）→ standalone helper in `_helpers.ts` mirror phase 563 模板 / **「dispatch site naming/scope must derive from module layer」第 N=3 实证累**（phase 563 命名 refine + 581 audit dep 层级 refine + 592 类继承 framing 推翻 → 升格独立 feedback 阈值过线）/ **shared helper 抽 cluster N=5 实证累**（phase 504+517+563+581+592）/ **「review claim 实测四态分类」第 6 phase 实证**（phase 556+563+567+581+587+592 / 模板深度成熟 / Meta 39 升格阈值）/ **「historical drift message format → 28 原则核 → 统一 dominant」首发实证**（gemini 异质消除 / 升格独立 feedback 候选累 N=1）
- 2026-05-09 / **phase 590 LLM provider tool_use_start id/name observability（B fork r71）**（main `44af894a`）/ 2 site silent → onStreamParseError + 0 NEW callback：(A) custom-anthropic.ts:207-220 content_block_start tool_use detect 空 id/name → onStreamParseError + skip yield malformed（不 emit malformed tool_use_start protocol violation）/ (B) openai.ts stream() finally 前 stream-end check loop / 任 toolCallBuffer `!buf.started && (buf.id || buf.name)` → onStreamParseError（incomplete tool_use missing id 或 name）/ 既有 onStreamParseError callback 复用（types.ts:153 + base-anthropic.ts:29 + openai.ts:102 / phase 571 模板）/ 0 NEW interface field / 2 NEW tests cover 双 site malformed observability / Path #1 实证 dispatch 5/5 真（含 1 framing refine：openai fallback init `\|\| ''` 非真 emit silent / gate 已防 emit / 真 silent = stream-end stale buffer / 修方案 site 不同）/ **「review claim 实测四态分类」N+1 实证累**（C1+b framing refine 类 / Meta 38 cluster 持续）/ **「既有 callback 复用 / 0 NEW interface field」纪律 N+1 实证**（phase 578 NEW const 0 + phase 590 NEW callback 0 / 升格独立 feedback 阈值达 N=2）/ silent X cluster 扩 LLM provider 模块（cross-cutting：dialog-store + process-manager + LLM provider / N=3 模块）
- 2026-05-10 / **phase 622 r74 J fork 5 ⚓ design ratify cluster（B fork r75 / single design phase / cross-cutting same-day）**（main `<sha 待 commit 后填>`）/ 关联 ⚓8 LLMOrchestratorError dead class（l2_llm_orchestrator §B closed by phase 622 / α 删 dominant 自决 / YAGNI + M#7 + M#8 + M#1 全 align / 推 r76+ code phase 删除 + specific error classes 重设计 / cascade catcher 强类型）/ LLM provider adapters 当前未直 throw LLMOrchestratorError / specific error classes 重设计 r76+ 影响面跨 L1+L2 / 主登记 l2_llm_orchestrator §B 3 row + l5_runtime §B + l4_memory_system §B / **「principle-derived ratify」N=3 实证升格阈值过线** / **design only 单 Step 内联模板第 9 实证累**
- 2026-05-10 / **phase 630 openai.ts 形态 A.3 4 sub-file 拆（E fork r76 / commit `3f1bc008` / 起步 SHA `c0e8e6ed` / Step B closure by phase 635 D fork r77）**（code phase / 主会话 plan + 用户 code）/ 4 sub-concern 抽：openai-message-formatter.ts (formatMessages + formatTools / 0 dep 真 pure / 111 行) + openai-sse-parser.ts (parseSSEStream / providerName + onStreamParseError? dep / 198 行) + openai-response-parser.ts (parseResponse + decodeHtmlEntities / providerName + onToolArgParseError? dep / 130 行) / 主 file 563 → 224 行（**净瘦 60.2%** / 比估算 58.6% 略好）/ OpenAIAdapter export 不变 / barrel re-export 不变 / 0 caller cascade / 0 tests cascade / 既有 black-box tests 全 PASS / **dominant 自决三层联动**（Philosophy「上下文工程」+ M#1 file 层面 4 独立演化轴 + ROI 0/3 + G5 改动频率 ≥ 70% 单 sub-concern + M#7+M#8+M#9 实测合规 / 用户问「原则能否指导决策」→ 三层联动覆盖完整 / 不需新增原则）/ **4 偏差点 G1+G2+G3+G5 实测核精修**：G1 sub-file signature 实测 0/0/2/2 dep 比原评估更轻 / G2 形态正名 A.3 single 不需 NEW 子分类 / G3 hot path = async generator 0 perf delta / G5 改动频率支持拆 / **4 候选比较矩阵**（runtime 3/3 不拆 / openai 0/3 拆 / orch 1.5/3 推后 / assemble 1/3 推后）/ **「形态 A.3 functional sub-file 抽」第 N+1 实证**（phase 491 step-executor + 630）/ **「provider library 拆 = SSE+formatter+response 三分」首发模板**（推 r77+ custom-anthropic + gemini 同型 ≥ 2 实证升格独立 feedback）/ **「拆 sub-module 起 phase 前必先核 ROI」第 N+1 实证累**（phase 489+491+493+630 / Meta 35 模板成熟）/ **「Philosophy + M#1 file 镜像 + ROI 三层联动 → dominant 自决」首发模板** / **「评估精度 4 偏差点实测核」模板**（signature + 形态 + perf + 改动频率四维实测）
- 2026-05-10 / **phase 653 phase 650 P0+P1 cluster fix（B fork r81 / 起步 SHA r80 末 / 主会话 plan + 用户 code 实施 per `feedback_plan_by_main_implement_by_user`）**/ phase 650 fan-out review round 9 spot-check 后 1 P0 + 6 P1 真候选 / 本 phase 选 3 优先 sub-fix landing（mirror phase 636+646 single phase multi sub-fix 模板）：S1 P0.1 Gemini SSE callback gap（phase 642 模板收尾 / α 加 5th param + 删 'wrong-name' default + adapter field 加 / mirror openai 模板 / **§A.gemini-sse-callback-symmetry closed by phase 653**）+ S2 P1.1 encodeInbox audit gap（α 移 encodeInbox 进 try / mirror inbox-writer.ts:47-48 async write 模板 / 0 NEW const 复用 INBOX_WRITE_FAILED / messaging 模块 row）+ S3 P1.4 step-executor callback required upgrade（mirror phase 542 模板 / types.ts onUnparseableToolUse optional → required + 删 console.warn fallback + caller cascade loop.ts forward chain + runtime.ts:503 已装配 0 改）/ 推后 P1.2/3/5/6 + 14 P2 → r82+ / 0 NEW const + 1 NEW field（GeminiAdapter onStreamParseError? optional） / 反向 3/3 PASS / **「fan-out → r+1 P1 cluster fix single phase」第 3 实证升格阈值过线**（phase 636 + 646 + 653 / Meta 44 候选独立 feedback）/ **「provider library 拆三分」phase 642 模板完整收尾候选**（跨 provider 完全一致 / N=2 → 完整）/ **silent X cluster cross-module N+2 实证**（messaging encode + step-executor callback / phase 542+591+604+611+614+615+633+646+653 cluster N+2）/ **「callback required upgrade」N+1 实证**（mirror phase 542）/ **「sub-agent 必读 phase 收官报告」SOP 纪律 N+1 实证**（phase 650 NEW SOP → phase 653 兑现 / 0 phantom 模板巩固）/ **「review claim 实测四态分类」第 N+1 实证累**（C1 VERIFIED tight 3 / 选定 sub-fix 全 tight）
- 2026-05-10 / **phase 659 r83 C fork phase 650 14 P2 batch land L2 schema check**（C fork r83 / commit `b8277902`）/ custom-anthropic-response-parser.ts:22 `as ContentBlock[]` 强转加 inline schema check throw（mirror phase 587 模板）/ §A.custom-anthropic-response-schema-check closed by phase 659 / **「JSON.parse type assertion 逃逸 schema 校验」N+1 实证累**（phase 576+587+659）/ **「P2 batch land 模板 mix 多类 status」第 3 实证升格阈值达**（phase 648+656+659）/ 1 src + 0 NEW / L2 仅 invalid response 改 throw（既有 caller catch path）
- 2026-05-10 / **phase 642 provider library 拆三分 N=2（B fork r78 / 起步 SHA `4a467299` / 主会话 plan + 用户 code 实施 per `feedback_plan_by_main_implement_by_user`）**/ mirror phase 630 模板首次复用 / **「provider library 拆 = SSE+formatter+response 三分」N=2 升格阈值过线**（phase 630 openai + 642 custom-anthropic + gemini / Meta 43 候选独立 feedback）+ **「Philosophy + M#1 file 镜像 + ROI 三层联动 → dominant 自决」N=2 升格阈值过线**（同框 dominant）/ S1 custom-anthropic.ts 296 → ~165 行（删 ~130）+ NEW custom-anthropic-sse-parser.ts ~120 行（parseSSEStream / this.name → providerName 参数化）+ custom-anthropic-response-parser.ts ~30 行 / formatMessages 继承 BaseAnthropicAdapter 不抽（DRY 既有）/ S2 gemini.ts 342 → ~160 行（删 ~180）+ NEW gemini-message-formatter.ts ~50 行 + gemini-sse-parser.ts ~95 行（this.name 参数化）+ gemini-response-parser.ts ~50 行（mirror openai 完全同型 4 sub-file pattern）/ 5 NEW sub-file / 0 caller cascade（barrel `index.ts:23-25` 仅 export adapter class）/ 0 NEW tests（既有 black-box cover）/ 反向 3/3 PASS / **「mirror phase 630 形态 A.3 functional split 模板复用」N=1 首次 mirror** / **「dispatch claim framing reframe」N+1 实证**：dispatch custom-anthropic 4 sub-file 假定 → Path #1 实测 formatMessages 继承 base / 实然 2 sub-file（推 r79+ 累）+ dispatch 估 gemini 250+ → 实然 342（体量 reframe）+ 副发现 anthropic.ts 257 行 SDK 路径异 architecture / 不纳入（推 r79+ SDK 模板独立评估）+ base-anthropic.ts 154 行 < 阈值 + DRY 共享 formatMessages + buildBaseRequestBody / 0 ROI 命中 / 不拆 / **「review claim 实测四态分类」第 N+1 实证累**（VERIFIED tight 1 + framing 不全 1 + 副发现 2）/ **「anthropic SDK 路径独立模板评估」候选首发**（推 r79+ SDK vs raw fetch architecture 区分模板）/ **「base-anthropic DRY 共享不抽」候选首发** / r74 J fork 5 ⚓ 全闭后 r78 进入大文件治理收尾期
- 2026-05-10 / **phase 635 dispatch claim STALE → reframe 至 phase 630 Step B 残留收尾（D fork r77 / design + memory only / 0 src diff / 起步 SHA `3f1bc008`）**（design phase / 主会话 own）/ r77 dispatch 表 §D「openai.ts 拆 4 sub-file」实测 95%+ STALE（phase 630 Step A `3f1bc008` 已闭 / openai.ts 224 行 + 3 sub-file 实然 / 仅 5% Step B 残留）/ Path #1 起首 grep 即捕 STALE / 收尾 3 项：l1_llm_provider §7.D 追加 phase 630+635 双 milestone（630 既由用户先入 / 635 本 phase 入）+ memory NEW project_phase630_openai_split_a3 + project_phase635_dispatch_stale_reframe + MEMORY.md 索引追加 phase 630+635 双行 / 0 src diff / **「dispatch claim 实测四态 → C4 STALE → reframe 至残留收尾」第 N=6+ 实证累**（phase 605 数字 stale + 612 行号 + 620 sweep 95% STALE + 621 0 真 drift + 629 0 真 drift + **635 整 fork scope STALE 首发**）/ **「dispatch ratio bimodal 0%-95% 二极分布」第 4 极端实证累**（phase 620 95% + 621 0% + 629 0% + 635 95%+ / Meta 41 已扩 / 阈值远过 / 推 Meta 42 升格独立 feedback「整 fork scope STALE → reframe 至残留收尾」）/ **「design closure phase 单 Step 内联」第 N=9 实证累**（phase 503+505+545+554+567+621+622+629+635 / 模板深度成熟极致）/ **「上 phase Step B 残留 → 后 phase 收尾」首发候选**（phase 630 Step A 单 commit + Step B 未做 → phase 635 = phase 630 Step B closure / 推同型 ≥ 2 实证升格）/ r77+ followup proposals: r77 dispatch 起草纪律加「Path #1 实测 phase 既往 Step A/B 闭环状态」前置 gate

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| KD（应然）LLMProvider L1 sharpen v2「OS/external 抽象层 / no audit / no permissions / no agent tools」| ✓（phase328 audit-sink 物理迁 + r61+ 拆出 LLMOrchestrator 后真合规）|
| KD（应然）provider 异构吸收（4 adapter）| ✓ |
| KD（r61+）L1/L2 拆分（LLMProvider own 单 provider SDK 调用 / LLMOrchestrator own 多 provider 容错编排）| ✓ M#1 真合规 |

## 8. 测试覆盖

应然行为应有测试覆盖：

- **核心 request 组装**：preset 解析 / 4 类 adapter（Claude SDK / Anthropic / OpenAI / Gemini）/ tool_use chunk 吐出 / AbortError 不重试 / cache_control 透传
- **abort 透传**：AbortSignal 透传 SDK / 立即 throw
- **流式中途错误**：抛 typed error 给 caller / 不内部 retry
- **SSE parse 软吞**：`onStreamParseError?` 回调暴露 raw 加 error

> 多 provider 容错编排测试（failover / breaker / idle timeout / context_exceeded）+ 健康探测 / provider 状态查询测试 归 [l2_llm_orchestrator.md](l2_llm_orchestrator.md) §8。
>
> **注**（ε spec 修正 / 2026-05-07）：原 §8 列「`getProviderInfo()` 当前 provider info」+「`healthCheck()` maxTokens=1 最小探测」2 测试项删 / 描述错位（实然 LLMProvider interface 仅 `name/model + call + stream?` / 0 method 暴露 / 健康探测 + provider 状态查询业务归 L2 LLMOrchestrator / 详 arch §3 + 表 2 line 327/335 + interfaces/l1.md:274「健康探测加 abort 编排归 L2 LLMOrchestrator / 本模块单 provider call 不持容错语义」）。
