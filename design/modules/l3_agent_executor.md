# AgentExecutor 模块内部契约

> 本文档限本模块**内部**应然 — 8 节结构 derive 自 Module Logic Principles：§1-§4 = M#1-#4 各占一节，§5 审计 = M#3 命名空间细则，§6 层级，§7 drift = M#10/#11，§8 测试。
> 跨模块对外承诺（接口签名、生产/消费方、归本模块加不归本模块、不可消除耦合理由）见 [interfaces/l3.md](../interfaces/l3.md) AgentExecutor 节。
> 模块本质加层归属见 [architecture.md](../architecture.md)。

## 1. 职责（M#1 独立可变职责）

> 本节内容 derive 自 [architecture.md](../architecture.md) §19「AgentExecutor 本质：跑 agent 循环的算法原语 / 不持业务语义 / L3 agent 原语 ——『agent loop』」加 M#1 / M#2 / M#3 / M#5 / Design Principle「中断可恢复」加 Design Principle「智能体是决策主体」。

### 做

应用 M#1（一个模块封装一组独立可变的职责），AgentExecutor 的单一职责 = **agent 完整执行循环的算法原语 / 不持任何业务语义**：

- **跨步循环驱动**：反复调 StepExecutor.step 直到收到停止信号 / 返回 AgentResult（finalText / stepsUsed / stopReason）
- **跨步计数权威**：`ctx.stepNumber` 由 AgentExecutor 权威持有（循环开头同步 + continue 分支 incrementStep）/ StepExecutor 仅读取（见 §7.A A.invariant-1）
- **maxSteps 守卫**：达 maxSteps 抛 `MaxStepsExceededError` / 阈值由调用方注入
- **熔断判定**：连续 N 步 allParseErrors 抛 `ConsecutiveParseErrorsExceededError` / 连续 N 次 max_tokens_tool_use 抛 `ConsecutiveMaxTokensToolUseError` / 阈值应然由调用方注入（实然 import 常量违反 / 见 §7.B）
- **stepCallback hook 调度**：每步算法完成后调 callback，调用方在 callback 内决定每步副作用（如 dialog 落盘加 stream emit加 audit 写入）— 本模块不持任何业务语义（见 §7.A A.invariant-2）
- **abort 协调**：消费 `ctx.signal`（不持 AbortController）/ StepExecutor 抛 IdleTimeoutSignal / PriorityInboxInterrupt / UserInterrupt 原样上抛
- **StepResult kind 分派**：final 返回 / continue 步进 + 触发 stepCallback / max_tokens_tool_use 不计步累熔断 / context_window_exceeded 抛错
- **失败上抛**：stepCallback 抛错原样上抛（不吞）/ StepExecutor 抛错原样传播

### 不做

- **不调 LLM / 不执行工具**（归 StepExecutor）— derive 自 M#1
- **不直接调 DialogStore**（每步落盘归调用方在 stepCallback 内）— derive 自 M#1 + M#2
- **不持任何业务语义**（不知 motion / claw / sub-agent identity / inbox / turn / snapshot / dialog 持久化等业务）— derive 自 M#1 + M#2
- **不做 idle timeout**（归 Runtime / 它持 AbortController + StepCallbacks delta 维计时器）— derive 自 M#1 + M#2
- **不读写 audit.tsv**（callbacks 透传给 StepExecutor / 落 audit 归调用方 / 详 §5）— derive 自 M#1 + M#8
- **不管 turn 语义 / snapshot commit / turn counter**（归 Runtime）— derive 自 M#1 + M#2
- **不读 inbox**（step_yield 判定归调用方 Runtime / SubAgent 的 stepCallback 实现）— derive 自 M#1 + M#11 边界稳定
- **不持 AbortController**（仅消费 ctx.signal / Runtime 装配期 own）— derive 自 M#3
- **不持自有资源**（messages 是调用方传入的可变 buffer）— derive 自 M#3
- **不持业务停止信号语义**（何时发 abort 由调用方决定 / 如 Daemon 监听 SIGTERM 触发）— derive 自 M#2
- **不做跨 LLM 调用容错**（归 L2 LLMOrchestrator）— derive 自 M#1

## 2. 业务语义（M#2）

- 循环算法本身 + 停止判定（含 maxSteps + 熔断）+ stepCallback 调度
- **不持任何 agent 业务语义**（不知 motion / claw / sub-agent identity / dialog 持久化 / inbox / turn）
- 与 StepExecutor（单步执行）/ Runtime（turn 语义 + snapshot + inbox 监听）/ SubAgent（实例化 + 生命周期）正交可变
- stepCallback hook 是「不持业务语义」契约的核心实现机制 — 让循环算法跟 dialog 持久化加 agent 身份解耦

## 3. 资源（M#3）

| 资源 | 类别 | 持久化 |
|---|---|---|
| 无 | — | ✗ 模块零状态（每次 runAgent 调用独立）|

**无磁盘资源** — 模块零 own 资源。

> 注：(1) messages 是调用方传入的可变 buffer / in-place 修改（非 own 资源）/ (2) AbortController 由调用方持有 / 本模块仅消费 ctx.signal / (3) circuit breaker 计数（consecutiveParseErrors / consecutiveMaxTokensToolUse）瞬态闭包内 / 不持久 / 不跨调用（实施细节 / 非 M#3 业务资源）。

## 4. 持久化（M#4）

无磁盘布局 / 无文件格式 / 无重建语义 — 模块零状态。

每步落盘归调用方在 stepCallback 内调 DialogStore（应然 / 实然违反登记 §7.A dialog-leak）。

## 5. 审计事件清单

> AgentExecutor 不直接写 audit。所有事件经 stepCallbacks 透传 → Runtime 落 audit.tsv。

应然零自发事件 — 模块为纯决策循环 / 无信息可丢。

## 6. 层级声明

L3 agent 原语层（与 StepExecutor / SubAgent 同层）。详见 [architecture.md](../architecture.md) 加 [interfaces/l3.md](../interfaces/l3.md)。

## 7. 应然 vs 实然差距登记（M#10 / M#11）

> 原则：本节只登记**实然 ≠ 应然**的 gap（待治理或已治理的历史）+ 偏差 + 历史纪律。当前实然若与应然 align 则不在此登记。

### 7.A 必修违规（含历史已闭环）

| §A 条 | 类型 | 状态 | 触发情境 |
|---|---|---|---|
| ~~dialog-leak AgentExecutor sessionStore field 是 dead code~~ | ~~drift / 中~~ | **✅ closed phase409**（main `5113e444`）| **Path #1 实测推翻 framing**（phase409 / 2026-05-03）：实然 sessionStore field + L77-79 落盘代码是 dead code（0 caller 传 / `loop.ts:80-90` shim 注释明示「不依赖 SessionStore / 由调用方通过 onStepComplete 自己处理」）/ caller 端落盘已合规（`runtime.ts:511-512 + 786-789` onStepComplete 内 `await sessionManager.save(messages)` / `subagent/agent.ts:279-299` onStepComplete 内 step log）/ 应然边界已合规 `architecture.md §19 + interfaces/l3.md AgentExecutor「不持业务语义」` / **治理 = 删 3 处 dead code**（agent-executor.ts:11 import + :27 field + :43-49 解构 + :76-79 落盘代码块 / -6 行）/ **不是迁移业务**（caller 端落盘已合规）/ D2 不丢弃静默 偿（dead code 应然不存在的代码必删）/ Path #1 推翻 design 描述 第 N 实证 |
| A.invariant-1 ctx.stepNumber 权威归属 anchor | anchor | 防 drift（合规）| AgentExecutor 权威持有 stepNumber（循环开头同步 + continue 分支 incrementStep）/ StepExecutor 仅读取 / 不可改为 StepExecutor 自维护 / 用作 reviewer 自检 |
| A.invariant-2 落盘必走 stepCallback 不直调 DialogStore anchor | anchor | **防 drift（合规 / phase409 后）**| 应然立场登记：AgentExecutor 不持业务语义 / 落盘必走 stepCallback hook 让调用方决定 / 不可加「直调 DialogStore」back-door / 用作 reviewer 自检 / phase409 后实然 align（dead code 已删 / caller onStepComplete 已 own 落盘）|
| **A.signal-pass executeToolCalls 必传完整 ctx.signal / step-executor 不剥 signal** | drift | **✅ closed by phase 538** | 实然 `step-executor/stop-handlers.ts:38-40` abort 期 `cloneExecContext(ctx, { signal: undefined })` 剥 signal 后再 executeToolCalls / 工具内部 fs/net 调失去 abort 信号 / 长写工具不响应 user Ctrl+C / 违 D2 软降级 + M#10 不合理停下 / α 删剥 signal 分支 / 工具自治响应 abort（已 abort-aware 工具自然 throw / 不响应工具忽略自然 OK）/ derive 详 `coding plan/phase538/Phase 538 总览.md §D.1` |
| **A.stream-abort-fall-through abort 期 stream catch 不应 fall through finalize** | drift | **✅ closed by phase 538** | 实然 `step-executor/stream.ts:162-169` abort 期若 `state.stopReason === 'tool_use'` → 吞错 fall through finalize → finalizeContent 把 partial JSON `parseToolInput` 容错解析 / 进 parseErrorCalls 路径 / 工具被错参数调用（schema 严格则 reject / 不严格则副作用真发生）/ 违 D1c（abort 应丢弃 partial state 让下 turn LLM 重新生成）+ M#10 / γ：abort 期所有 stopReason 一致 throwAbortError / partial tool_use input 丢弃 / derive 详 `coding plan/phase538/Phase 538 总览.md §D.2` |
| ~~熔断抛 `Error` 字符串而非命名类~~ | ~~drift~~ | **✅ closed（phase306 / SHA `78f54d9`）** | `ConsecutiveParseErrorsExceededError` + `ConsecutiveMaxTokensToolUseError` 新建 / 2 处 throw 替换 |
| ~~`throwAbortError` 反向 import 自 step-executor~~ | ~~drift~~ | **✅ closed（phase313 / SHA `f2420b8`）** | 提升至 `src/core/react/abort-helpers.ts` |
| ~~跨模块 step-executor console.warn 协调~~ | ~~drift / framing 错位~~ | **✅ closed phase396**（main `3eeffad7`）| **phase395 derive**：命名归 agent-executor 但实然 0 命中（agent-executor.ts 0 console / §A.invariant 应然「无 console」一致 / 合规）/ 真问题在 step-executor.ts 8 console / 已迁登记 step-executor「step-executor 8 console 协调」/ **phase396 落地**：β 路径 StepCallbacks +1 onUnparseableToolUse + L165/L382 fallback + Runtime L537 wiring / **framing 错位修订-实施联动闭环模板首发** |
| ~~audit-events.ts 文件不存在~~ | ~~design-gap / 描述偏差~~ | **✅ closed**（r42 D fork） | 应然 §5 提及 agent-executor audit-events.ts / 实然无该文件 / 跨模块事件落 step-executor / runtime / 与 step-executor 同模式（callback 透传）/ 本契约 §5 已修订为「应然零自发事件 / callback 透传」 |
| **A.spec-1 应然 `interface AgentExecutor { run(messages, params) }` ↔ 实然 `runAgent(input)` 自由函数** | spec drift / 大 | **closed**（phase414c L3 audit / interfaces/l3.md align 实然自由函数 + AgentResult 返 finalText 字段 + runReact 第二 entry）+ **phase 522 ν 升级**（2026-05-07 / SHA `0f7c5219` / agent-executor module 公共 API 缩到 runReact only / runAgent 改 module internal core / cross-file export from `agent-executor.ts` 给 loop.ts internal 用 / 不进 barrel / tests 8 处改测 runReact black-box align production caller / 4 原则 cross-check 5/5 全通过 M#7+M#8+YAGNI+应然 align / 用户 A.9/A.10「runReact 旧兼容层」framing 推翻 closed / runReact 是合规 public production API）| 历史 interfaces 写应然 class-style `interface AgentExecutor` + `run(messages, params): RunResult` / 实然 = `runAgent(input: AgentInput): Promise<AgentResult>` standalone 自由函数 / `runReact(options): Promise<ReactResult>` 另一 standalone (loop.ts / Runtime + SubAgent caller-side React 装配入口) / AgentResult 返 `{finalText: string, stepsUsed, stopReason}` 而非应然 `{messages, finalStopReason, stepCount}` (caller own messages buffer / 在 stepCallbacks 内自取 / 不返 messages 数组) / 错误类名 `MaxStepsExceededError` (不是应然 `AgentExecutorMaxStepsError`) / phase414c interfaces/l3.md 修订 align 实然函数签名 + 真实错误类名 + 加 onAfterStep callback / 删 RunParams + RunResult + StopReason union 应然幻象 |
| **A.react-result-dead-literal `ReactResult.stopReason` 'max_steps' dead literal** | drift / 低 / r78 D fork phase 650 sub-1 P1.2 浮出 / r82 B fork landing | ✅ **closed by phase 656（B fork r82 / commit main `642edc43` / merge `c036e72a`）** | `loop.ts:47` ReactResult interface stopReason union 含 `'max_steps'` literal / 实然 max_steps 走 `throw MaxStepsExceededError`（agent-executor.ts:124）路径 / 不通过 stopReason 返回 / `mapStopReason` input union `'end_turn' \| 'max_tokens_text' \| 'no_tool' \| 'unknown'` 0 'max_steps' / output 同 0 / **0 caller produce + 0 caller consume**（grep 全栈 `stopReason: 'max_steps'` + `stopReason === 'max_steps'` 0 命中 verify）/ phase 656 删 'max_steps' literal / **mirror phase 640 dead literal cleanup 模板第 N=2 实证**（phase 640 + 656 / 推 r83+ ≥ 3 升格独立 feedback）|
| **A.last-assistant-toolnames-type-guard** | hygiene / 低 / r80 D fork phase 650 P2.1 浮出 / r83 C fork landing | ✅ **closed by phase 659（C fork r83 / commit `b8277902`）** | agent-executor.ts:88 `lastAssistant!.content` 非空断言（line 87 已 `Array.isArray(lastAssistant?.content)` optional 守卫 / line 88 `!.` 冗余）/ phase 659 改 type guard：抽 `lastContent` 中间变量 + `Array.isArray(lastContent)` narrow / 0 行为差 / **M#9 显式编译期可检 align** / micro-hygiene cluster batch N+1 |

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| `ctx.stepNumber` 双写源 | drift / 低 | ⚓ deviation-accepted（显式「底层消费 + 上层权威」耦合 / `ctx.stepNumber = stepCount`（循环开头）+ `ctx.incrementStep()`（continue 分支）双写 / 升档：若 ctx 被 StepExecutor 外消费方 mutate → 升 §A（phase309 复核未触发）/ phase389 anchor 标记）|
| onAfterStep 时机顺序 | ⚓ accepted-stable | **✅ closed phase 478（β'' / design only / 0 src 改 / 0 main commit）** | **β'' framing 修订**（用户拍板 / phase 478 derive 详 `coding plan/phase478/derive.md`）：原 claim「应然 §1.做 标 callback 在 consecutiveErrors 更新之前」**是应然幻象**（§1.做 line 19 实然 silent on timing / 此 claim 是 §B 期间引入 / 缺现实功能依据登记 / 违 practices.md「应然 rule 必有现实功能依据」）。**实然 timing**：onAfterStep 在 consecutive check 之后（agent-executor.ts:101 / phase409 后稳定）/ L100 注释「步进之后、熔断检查之后」。**caller 0 dependency**（Path #1 实测 main `2d4e251f`）：Runtime onStepComplete (runtime.ts:510-516) + SubAgent onStepComplete (subagent/agent.ts:296-307) 仅消费 messages buffer + inbox priority signal / 0 业务依赖 callback 看 stable vs 累加 consecutiveErrors。**应然立场修订**：应然 silent on timing（§1.做 line 19 维持 silent / 不立 timing claim）+ ⚓ anchor 实然 timing stable（实施层 timing 不可任意变 / 测试覆盖锁定 / phase389 anchor 模板复用）+ M#7 显式 align（耦合界面稳定靠 anchor + 测试锁定 / 不靠应然层凭空 claim）。**升档条件**：(1) 出现 caller 真依赖 stable consecutiveErrors（如未来 Heartbeat / Watchdog 集成等）→ 升 §A.row 重立 timing claim 含现实依据登记 / (2) 业务场景需要 callback 在 consecutive check 之前介入（如提前避熔断）→ 升回 γ 拆 callback 含 caller 用例登记 / (3) 实施层 timing 重构需要变更（如 onAfterStep 移位）→ 触发本 anchor 重审 + caller 测试同步更新。**framing 推翻形态分级第 N 实证**（Meta 31 立 / 同 phase379+388+393+414c+471 / β'' 是「应然 claim 凭空 → anchor 实然 + 升档条件」复合形态）|
| ~~circuit-breaker-thresholds 熔断阈值常量 import 而非 caller 注入~~ | ~~drift / 中~~ | **✅ closed phase409**（main `5113e444`）| 应然「阈值由调用方注入」（同 maxSteps 模式）/ 治理 = AgentInput +`maxConsecutiveParseErrors?` + `maxConsecutiveMaxTokensToolUse?` optional 字段（解构 fallback `?? MAX_CONSECUTIVE_PARSE_ERRORS` / `?? MAX_CONSECUTIVE_MAX_TOKENS_TOOL_USE` 保 import 作为默认值）/ caller 装配期注入覆盖：loop.ts ReactOptions +2 透传 / runtime.ts ClawRuntimeOptions +2 / 两处 runReact 调用注入 / subagent/agent.ts SubAgentOptions +2 / SubAgent class +2 字段 + ctor 接收 / runReact 调用透传 / M#5 align（不 import 业务阈值 / 同 maxSteps 模式）|
| ~~**L3.G1 (agent-executor)** runReact 第 2 entry 未在 arch 表 2 列~~ | **r65 cross-doc audit 浮出 / phase 522 ν closure（2026-05-07 / SHA `0f7c5219`）**：选 α / arch §19 表 2 AgentExecutor row 加「runReact React-style 公共入口（11 平铺回调 / wrap runAgent internal core）」 / agent-executor module 公共 API single entry = runReact / runAgent 改 internal core | ✅ **closed by ν（α 决策）**：arch 表 2 同步 + interfaces line 149 deprecation 注删 + module §A.spec-1 ν 注扩 + tests 8 处改测 runReact black-box（runtime.ts:407+683 + subagent/agent.ts:272 production caller 模式）|

### 7.C 应然原则对照

> 仅列应然对各原则的承诺立场 / 不写「合规✓」claims。

**Module Logic Principles**

- M#1 独立可变职责：循环算法 + 跨步计数 + 守卫 + 熔断判定 + stepCallback 调度 / 与 StepExecutor（单步执行）/ Runtime（turn / snapshot / inbox / 落盘）正交
- M#2 业务语义归属：循环算法本身（含停止判定）是本模块业务语义 / 落盘加 agent 身份等业务归调用方 / phase409 闭环（dead code 删除 / 应然边界已 align）
- M#3 资源唯一归属：messages 是调用方传入的可变 buffer / 不持自有资源
- M#4 持久化：无磁盘布局 / 持久化归调用方在 stepCallback 内
- M#5 依赖单向：L3 → L3 同层 (StepExecutor — per arch §19 表 1)（abort-helpers 是 L3 内部 helper file 不算独立模块）/ 不上引 L4+ / 应然不直接 import L2 DialogStore（落盘归调用方 stepCallback）
- M#6 依赖结构稳定：AgentInput 字段稳定（phase409 后 +2 optional thresholds 字段） / AgentResult 3 字段
- M#7 耦合界面稳定：runAgent 签名稳定 / StepResult kind union 扩展时本模块只增 switch 分支不破接口
- M#8 耦合界面最小：AgentInput 字段精选 / stepCallback 接口只传 StepMeta 不漏内部状态
- M#9 显式编译器可检：StepResult discriminated union + exhaustiveness check（switch 结尾 `_exhaustive: never`）
- M#10 不合理停下：所有失败抛错或透传 / 无吞错
- M#11 边界对不上停下：~~dialog-leak 即 phase368 风格的「实然代码持业务语义违反应然边界」案例 / 推 r61+ design phase 治理~~ / **phase409 闭环**（Path #1 实测推翻 framing：实然 sessionStore field 是 dead code / 治理 = 删 dead 不是迁业务 / 应然边界已合规）

**Design Principles**

- D1a 信息不丢失：messages in-place 持续追加 / StepMeta 传给 stepCallback / 失败抛错不吞
- D1b 状态可观察：stepCallback 透传 11 回调 / stepCallback 见 StepMeta
- D1c 中断可恢复：signal.aborted 透传为信号类 / 落盘归调用方 stepCallback 决定（崩溃后从最后完整步恢复）
- D1d 事后可审计：LLMCallInfo 经 onLLMResult 回调可落 audit
- D2 不丢弃 / 静默：熔断错误已用命名类 / 信息保留
- D3 用户可观察：同 D1b
- D4 LLM 调用恢复：循环 + caller 在 stepCallback 落盘 = 恢复机制
- D5 日志重建：caller 落盘 + StepMeta 回调足以重建
- D6 子代理后不阻塞：runAgent 是循环触发器 / LLM 决策经 executeStep 路由 / SubAgent 场景由 caller 控制（决策主体语义透 LLM 上层）
- D7 系统可信路径：ToolExecutor / Registry 透传给 StepExecutor / 不绕路
- D8 事件驱动：灰度（同步 while 循环 / 事件驱动由上层 Runtime 在入口决定）
- D9 CLI 唯一外部入口：N/A（本模块 L3 内部循环原语 / 0 外部入口）
- D10 多 claw 不隔绝：N/A（本模块循环算法 / 0 跨 claw 语义）
- D11 motion 特殊：N/A（本模块不持业务身份 / motion / claw / sub-agent identity 归调用方）

**Philosophy**

- P1 Agent 即目录：caller 在 stepCallback 内落盘把对话落盘即状态持久化
- P2 上下文工程：循环是 messages buffer + systemPrompt + tools 上下文的迭代演化
- P3 分多个智能体加分子任务：单一代码基 / 身份差异由调用方注入决定
- P4 系统为智能体服务：提供决策循环 + 熔断保护基础设施 / 不参与决策

**Path Principles（7 条）**

- **Path #1 路径规划基于规划时刻的事实**：dialog-leak + circuit-breaker-thresholds 是 r60+ 实然 vs 应然审视产物 / phase409 实测推翻 dialog-leak framing（描述「直调 dialogStore.save」/ 实然 sessionStore field 是 dead code / 0 caller 用 / 治理 = 删 dead 不是迁业务）/ Path #1 推翻 design 描述 第 N 实证
- **Path #2 实然和应然差距显式登记**：违规明文上墙（在路径规划时参考 / §7.A + §7.B）
- **Path #3 语义原子变更单元**：APPEND-only §7 不解构既有节 / phase409 单 commit 改 4 文件（agent-executor.ts + loop.ts + runtime.ts + subagent/agent.ts）+ tests / 不附带其他 refactor
- **Path #4 可回滚 + 破坏性论证**：API 改动 caller 评估 / 破坏性改动显式论证（反向测试：本模块可独立替换 StepExecutor 实现而不动 Runtime caller — M#1 ✓ / phase409 后 dialogStore 直依赖已删 / 独立性已合规）
- **Path #5 完成后复盘**：phase 收尾三维 + Path Principles 第 4 维对账
- **Path #6 冲突立即中断**：scope 模糊或决策点必停报告（冲突调整优先于强行推进）
- **Path #7 总难度路径**：实然到达应然有诸多路径 / 选择降低总难度的（步骤间有相互作用 / 总难度 ≠ 各步骤成本简单相加）

### 7.D 历史纪律

- 2026-04-21 / phase181 L3 agent_executor 契约 backfill（§7 四子节 + §8 / 0 §7.A + 3 §7.B）
- 2026-04-25 / phase302 throwAbortError 迁 `abort-helpers.ts`
- 2026-04-25 / phase306 命名 Error 类（ConsecutiveParseErrorsExceededError + ConsecutiveMaxTokensToolUseError）
- 2026-04-25 / phase309 §7.B 剩余评估 / `ctx.stepNumber` 双写源 升档条件未触发保留
- 2026-04-25 / phase313 throwAbortError 闭环（物理迁 abort-helpers.ts / agent-executor 改 import）
- 2026-04-25 / phase317 契约 drift 修订（假 SHA 修正）
- 2026-04-26 / phase325 应然 framing drift 修订（§15→§17 / r32 D 已修）
- 2026-05-01 / phase408 context_window_exceeded 处理迁离（删 agent-executor.ts:75 throw 路径 / 由 service 层 own / l2_llm_orchestrator §7.A A.6 闭环 / 治理副产品 dead 必清 / main `c1fca6ca`）
- 2026-05-03 / phase409 §7.A.dialog-leak + §7.B.circuit-breaker-thresholds 双 drift 闭环（main `5113e444`）/ Path #1 推翻 design 描述（dialog-leak 实然 sessionStore field 是 dead code / 0 caller 用 / 治理 = 删 dead 不是迁业务）/ dead code 模式 vs 边界迁移模式区分 同 phase 不同治理 / 模块边界重构阶段首 phase / Path #1 推翻 design 描述 第 N 实证
- r60+ 重编号：9 节 → 8 节 / 每节 derive 自一条 Module Logic Principle（详顶部 docblock）
- r60+ 应然 align architecture.md：原应然描述「持落盘业务语义」反 architecture.md / 修订为「不持业务语义 / 落盘归调用方 stepCallback」/ 实然 drift 登记 dialog-leak + circuit-breaker-thresholds（phase409 双闭环）
- 2026-05-04 / cross-doc audit drift 修订（§7.C P3 verbatim「分多个智能体加分子任务」/ Design Principles D6 合并 D6a+D6b + 加 D9/D10/D11 N/A 标 align principles.md / §3 资源改 table 「无」+ 注脚 align 其他模块）
- 2026-05-04 / phase 478 β'' onAfterStep 时机顺序 closed（design only / 0 src 改 / 0 main commit / r64 B fork / `coding plan/phase478/`）：substantive verify 26 条原则后 / β' 应然 silent claim 修订为 β'' 完整版（应然 silent + ⚓ anchor 实然 timing + 升档条件）/ §B row + §7.E KD + §8 测试覆盖 3 处一并 closed / framing 推翻形态分级第 N 实证（「应然 claim 凭空 → anchor 实然 + 升档条件」复合形态 / 同 phase379+388+393+414c+471 历史模板族）
- 2026-05-04 / phase437 模块物理位置拆出（main `42757245`）/ L3 react/ → step-executor/ + agent-executor/ 双 dir / git mv agent-executor.ts + loop.ts → agent-executor/ + NEW barrel @module L3.AgentExecutor / loop.ts runReact shim 归 agent-executor 保留向后兼容（M#5 单向 AE → SE / abort-helpers 归 step-executor 同模块）/ **L3 应然 align 100%（StepExecutor + AgentExecutor + SubAgent 三模块各独立 dir）** / 物理迁三模板复合 N+8 次 / 8 caller cascade 含 3 src 计划遗漏自补
- 2026-05-05 / r65 cross-doc audit 单 doc 一致性核（modules/l3_agent_executor.md vs arch §19 + 表 1/2 + interfaces/l3.md AgentExecutor 节）/ 0 derive drift / 主 derive 全 align（M#1-M#11 + Design Principle D1a-d + D2/D3/D4/D5/D6/D7/D8 + D9/D10/D11 N/A + Philosophy P1-P4 + Path #1-#7）/ 5 主能力 align arch 表 2（完整 agent 执行循环 + 跨步计数加熔断 + stepCallback hook + maxSteps 守卫 + caller 注入熔断阈值）/ 1 dep StepExecutor + caller list（Runtime + SubAgent）align arch 表 1 / phase181+306+313+396+408+409+414c+437+478 多 phase 接力清零稳态保留 / L3.G1 (agent-executor) runReact 第 2 entry 未在 arch 表 2 列 design-gap 已登记 §B（业务决策性 α/β/γ 候选）/ design only / 0 src 改
- 2026-05-10 / **phase 656 ReactResult.stopReason 'max_steps' dead literal 删**（B fork r82 / commit main `642edc43` / merge `c036e72a`）/ phase 650 sub-1 P1.2 浮出 / Path #1 实测 0 caller produce + 0 consume / β reframe 删 dead literal（mirror phase 640 dead literal cleanup 模板）/ §A.react-result-dead-literal closed by phase 656 / **「dead literal cluster cleanup」第 N=2 实证**（phase 640 + 656 / 推 r83+ ≥ 3 升格独立 feedback）/ **「fan-out review → r+1 P1 cluster fix single phase」第 4 实证累**（phase 636+646+653+656）/ 1 src + 0 NEW const + 0 NEW field + 0 NEW test / 0 行为差
- 2026-05-10 / **phase 659 r83 C fork phase 650 14 P2 batch land L1 type guard refactor**（C fork r83 / commit `b8277902`）/ agent-executor.ts:88 `lastAssistant!` 非空断言 → type guard refactor（抽 lastContent + Array.isArray narrow）/ §A.last-assistant-toolnames-type-guard closed by phase 659 / **「P2 batch land 模板 mix 多类 status」第 3 实证升格阈值达**（phase 648+656+659 / 推 Meta 45 升格独立 feedback）/ **「跨 r SHA 漂移 candidate Path #1 re-verify 真率递降」N=4 实证累**（phase 636+648+656+659）/ 1 src + 0 NEW + 0 行为差
- 2026-05-07 / **phase 522 agent-executor 公共 API 单 entry 治理**（main `0f7c5219`）/ ν 决策 / agent-executor module 公共 API 缩到 runReact only（M#8 单表面）/ runAgent 改 module internal core（仍 cross-file export from `agent-executor.ts` 给 loop.ts internal 用 / 不进 barrel）/ index.ts 删 runAgent re-export / tests/core/agent-executor.test.ts 8 处改测 runReact black-box 模式（11 平铺回调 align production caller 模式 runtime.ts:407+683 + subagent/agent.ts:272）/ 2 files +15 -17 / design 同步：interfaces/l3.md line 149 deprecation 注删 + §A.spec-1 ν 升级注 + §B L3.G1 closed by ν α 决策 + arch §19 表 2 加 runReact entry + l3_subagent §7.D 联动 milestone / 4 原则 cross-check 5/5 全通过（M#7 + M#8 + YAGNI + 应然 align）/ 用户 A.9/A.10「runReact 旧兼容层」framing 推翻 closed（runReact 是合规 public production API / 不是 deprecation 候选）/ **「公共 API 单 entry vs internal core」治理模板首发** / **「业务决策性 design-gap → 原则 derive 自决」第 3 实证**（phase 520+521+522 / 模板深度成熟极致）

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| KD（待编号）| L3 跨步循环 / 守卫 / abort 协调 vs StepExecutor 单步执行原语分工 | ✓ M#1 反向独立性强 |
| KD（待编号）| dialogStore 注入模式（应然不直依赖 / 落盘 via stepCallback） | ✅ phase409 闭环（main `5113e444`）/ dead code 删 / 实然 caller 端 onStepComplete 落盘已合规 |
| KD（待编号）| stepCallback hook 归调用方 / AgentExecutor 不持 inbox 知识 | ✓ M#11 边界稳定 |
| KD（待编号）| ctx.signal 由调用方持有 / AgentExecutor 不 new AbortController | ✓ |
| KD（r42 D 新发现）| onAfterStep 时机顺序 | ✅ closed phase 478（β'' / 应然 silent on timing + ⚓ anchor 实然 timing + 升档条件 / 详 §B row）|

## 8. 测试覆盖

应然行为（不绑定具体测试文件路径）：

- 循环终止：`kind: 'final'` 直接返回 AgentResult / stepCount 达 maxSteps 抛 MaxStepsExceededError
- 步进 + stepCallback：continue 分支 ctx.incrementStep → stepCallback 顺序 / max_tokens_tool_use 不计步不调 stepCallback
- 熔断判定：allParseErrors=true 累加 consecutiveParseErrors / 达阈值抛 ConsecutiveParseErrorsExceededError；max_tokens_tool_use 累加 consecutiveMaxTokensToolUse 不 stepCount++ / 达阈值抛 ConsecutiveMaxTokensToolUseError
- 信号透传：signal.aborted 前 / 中 / 后任一时点 → throwAbortError 分发 IdleTimeoutSignal / PriorityInboxInterrupt / UserInterrupt
- context window exceeded：抛 Error('LLM context window exceeded...')
- exhaustiveness：switch 结尾 `_exhaustive: never` 保护 StepResult union 扩展（编译期）
- stepCallback 时机：max_tokens_tool_use 不调 / continue 在 stepCount++ + maxSteps 后调 / 回调抛错原样上抛
- stepCallback 与 consecutiveErrors 更新顺序（onAfterStep 时机顺序 验证）：测试锁实然 timing（agent-executor.ts:101 onAfterStep 在 consecutive check 之后 / phase409 后稳定）/ 不靠应然 timing claim 约束（应然 silent on timing per §B row + phase 478 β'' 闭环）/ 实施层 timing 重构需变更时触发 §B anchor 重审 + 本测试同步更新
- **应然 align verification**：AgentExecutor 不直依赖 DialogStore（phase409 dead code 已删）/ 落盘 via caller onStepComplete callback（Runtime + SubAgent 已合规 / 实然路径覆盖）
- **caller 注入 thresholds**（phase409）：AgentInput +`maxConsecutiveParseErrors?` + `maxConsecutiveMaxTokensToolUse?` optional / unset 走 `constants.ts` fallback / set 测试 caller 注入路径（agent-executor.test.ts +4 测试 / `should respect caller-injected ...` × 2 + `should fallback to constants.ts default ...` × 2）
