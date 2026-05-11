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

- 无自有磁盘 / 进程 / 句柄资源 / 无独占目录 — 模块零 own 资源
- messages 是调用方传入的可变 buffer（in-place 修改）
- AbortController 由调用方持有 / 仅消费 ctx.signal
- circuit breaker 计数（consecutiveParseErrors / consecutiveMaxTokensToolUse）瞬态闭包内 / 不持久 / 不跨调用

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
| ~~熔断抛 `Error` 字符串而非命名类~~ | ~~drift~~ | **✅ closed（phase306 / SHA `78f54d9`）** | `ConsecutiveParseErrorsExceededError` + `ConsecutiveMaxTokensToolUseError` 新建 / 2 处 throw 替换 |
| ~~`throwAbortError` 反向 import 自 step-executor~~ | ~~drift~~ | **✅ closed（phase313 / SHA `f2420b8`）** | 提升至 `src/core/react/abort-helpers.ts` |
| ~~跨模块 step-executor console.warn 协调~~ | ~~drift / framing 错位~~ | **✅ closed phase396**（main `3eeffad7`）| **phase395 derive**：命名归 agent-executor 但实然 0 命中（agent-executor.ts 0 console / §A.invariant 应然「无 console」一致 / 合规）/ 真问题在 step-executor.ts 8 console / 已迁登记 step-executor「step-executor 8 console 协调」/ **phase396 落地**：β 路径 StepCallbacks +1 onUnparseableToolUse + L165/L382 fallback + Runtime L537 wiring / **framing 错位修订-实施联动闭环模板首发** |
| ~~audit-events.ts 文件不存在~~ | ~~design-gap / 描述偏差~~ | **✅ closed**（r42 D fork） | 应然 §5 提及 agent-executor audit-events.ts / 实然无该文件 / 跨模块事件落 step-executor / runtime / 与 step-executor 同模式（callback 透传）/ 本契约 §5 已修订为「应然零自发事件 / callback 透传」 |
| **A.spec-1 应然 `interface AgentExecutor { run(messages, params) }` ↔ 实然 `runAgent(input)` 自由函数** | spec drift / 大 | **closed**（phase414c L3 audit / interfaces/l3.md align 实然自由函数 + AgentResult 返 finalText 字段 + runReact 第二 entry）| 历史 interfaces 写应然 class-style `interface AgentExecutor` + `run(messages, params): RunResult` / 实然 = `runAgent(input: AgentInput): Promise<AgentResult>` standalone 自由函数 / `runReact(options): Promise<ReactResult>` 另一 standalone (loop.ts / Runtime + SubAgent caller-side React 装配入口) / AgentResult 返 `{finalText: string, stepsUsed, stopReason}` 而非应然 `{messages, finalStopReason, stepCount}` (caller own messages buffer / 在 stepCallbacks 内自取 / 不返 messages 数组) / 错误类名 `MaxStepsExceededError` (不是应然 `AgentExecutorMaxStepsError`) / phase414c interfaces/l3.md 修订 align 实然函数签名 + 真实错误类名 + 加 onAfterStep callback / 删 RunParams + RunResult + StopReason union 应然幻象 |

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| `ctx.stepNumber` 双写源 | drift / 低 | ⚓ deviation-accepted（显式「底层消费 + 上层权威」耦合 / `ctx.stepNumber = stepCount`（循环开头）+ `ctx.incrementStep()`（continue 分支）双写 / 升档：若 ctx 被 StepExecutor 外消费方 mutate → 升 §A（phase309 复核未触发）/ phase389 anchor 标记）|
| onAfterStep 时机顺序 | drift / 中 | **fork r48 实证确认（agent-executor.ts:82-113）**：实然 `L82-85 save → L88-89 stepCount++ → L92-108 consecutiveErrors 更新 → L110-113 onAfterStep`。应然契约 §1.做 标 「consecutiveErrors 更新之前」（让 callback 决策不被本步熔断累加干扰）。实然 callback 在 consecutive 更新之后触发 / callback 看到的是包含本步累加后的状态。L110 注释 `// 4. onAfterStep（save 之后、熔断检查之后）` 与契约描述脱节。升档：r43+ 决策应然方向（callback 前 vs 后 / 各有合理性）→ 修代码 OR 修契约 |
| ~~circuit-breaker-thresholds 熔断阈值常量 import 而非 caller 注入~~ | ~~drift / 中~~ | **✅ closed phase409**（main `5113e444`）| 应然「阈值由调用方注入」（同 maxSteps 模式）/ 治理 = AgentInput +`maxConsecutiveParseErrors?` + `maxConsecutiveMaxTokensToolUse?` optional 字段（解构 fallback `?? MAX_CONSECUTIVE_PARSE_ERRORS` / `?? MAX_CONSECUTIVE_MAX_TOKENS_TOOL_USE` 保 import 作为默认值）/ caller 装配期注入覆盖：loop.ts ReactOptions +2 透传 / runtime.ts ClawRuntimeOptions +2 / 两处 runReact 调用注入 / subagent/agent.ts SubAgentOptions +2 / SubAgent class +2 字段 + ctor 接收 / runReact 调用透传 / M#5 align（不 import 业务阈值 / 同 maxSteps 模式）|

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
- D6a 决策主体：runAgent 是循环触发器 / LLM 决策经 executeStep 路由
- D6b 子代理不阻塞：无关（SubAgent 场景由 caller 控制）
- D7 系统可信路径：ToolExecutor / Registry 透传给 StepExecutor / 不绕路
- D8 事件驱动：灰度（同步 while 循环 / 事件驱动由上层 Runtime 在入口决定）

**Philosophy**

- P1 Agent 即目录：caller 在 stepCallback 内落盘把对话落盘即状态持久化
- P2 上下文工程：循环是 messages buffer + systemPrompt + tools 上下文的迭代演化
- P3 多智能体加分子任务：单一代码基 / 身份差异由调用方注入决定
- P4 系统为智能体服务：提供决策循环 + 熔断保护基础设施 / 不参与决策

**Path Principles**

- Path #1 实然为唯一基准：dialog-leak + circuit-breaker-thresholds 是 r60+ 实然 vs 应然审视产物 / phase409 实测推翻 dialog-leak framing（描述「直调 dialogStore.save」/ 实然 sessionStore field 是 dead code / 0 caller 用 / 治理 = 删 dead 不是迁业务）/ Path #1 推翻 design 描述 第 N 实证
- Path #3 语义最小变更单元：APPEND-only §7 不解构既有节 / phase409 单 commit 改 4 文件（agent-executor.ts + loop.ts + runtime.ts + subagent/agent.ts）+ tests / 不附带其他 refactor
- 反向测试：本模块可独立替换 StepExecutor 实现而不动 Runtime caller — M#1 ✓ / phase409 后 dialogStore 直依赖已删 / 独立性已合规

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

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| KD（待编号）| L3 跨步循环 / 守卫 / abort 协调 vs StepExecutor 单步执行原语分工 | ✓ M#1 反向独立性强 |
| KD（待编号）| dialogStore 注入模式（应然不直依赖 / 落盘 via stepCallback） | ✅ phase409 闭环（main `5113e444`）/ dead code 删 / 实然 caller 端 onStepComplete 落盘已合规 |
| KD（待编号）| stepCallback hook 归调用方 / AgentExecutor 不持 inbox 知识 | ✓ M#11 边界稳定 |
| KD（待编号）| ctx.signal 由调用方持有 / AgentExecutor 不 new AbortController | ✓ |
| KD（r42 D 新发现）| onAfterStep 时机顺序 | ⚠ 待 Path #1 实证（onAfterStep 时机顺序 row）|

## 8. 测试覆盖

应然行为（不绑定具体测试文件路径）：

- 循环终止：`kind: 'final'` 直接返回 AgentResult / stepCount 达 maxSteps 抛 MaxStepsExceededError
- 步进 + stepCallback：continue 分支 ctx.incrementStep → stepCallback 顺序 / max_tokens_tool_use 不计步不调 stepCallback
- 熔断判定：allParseErrors=true 累加 consecutiveParseErrors / 达阈值抛 ConsecutiveParseErrorsExceededError；max_tokens_tool_use 累加 consecutiveMaxTokensToolUse 不 stepCount++ / 达阈值抛 ConsecutiveMaxTokensToolUseError
- 信号透传：signal.aborted 前 / 中 / 后任一时点 → throwAbortError 分发 IdleTimeoutSignal / PriorityInboxInterrupt / UserInterrupt
- context window exceeded：抛 Error('LLM context window exceeded...')
- exhaustiveness：switch 结尾 `_exhaustive: never` 保护 StepResult union 扩展（编译期）
- stepCallback 时机：max_tokens_tool_use 不调 / continue 在 stepCount++ + maxSteps 后调 / 回调抛错原样上抛
- stepCallback 与 consecutiveErrors 更新顺序（onAfterStep 时机顺序 验证）：应然 stepCallback 在 consecutiveErrors 更新之前 / 实然如有 drift 升 §A
- **应然 align verification**：AgentExecutor 不直依赖 DialogStore（phase409 dead code 已删）/ 落盘 via caller onStepComplete callback（Runtime + SubAgent 已合规 / 实然路径覆盖）
- **caller 注入 thresholds**（phase409）：AgentInput +`maxConsecutiveParseErrors?` + `maxConsecutiveMaxTokensToolUse?` optional / unset 走 `constants.ts` fallback / set 测试 caller 注入路径（agent-executor.test.ts +4 测试 / `should respect caller-injected ...` × 2 + `should fallback to constants.ts default ...` × 2）
