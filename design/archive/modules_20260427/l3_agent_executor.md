# AgentExecutor 接口契约

L3 完整 agent 执行驱动。反复调 StepExecutor 跑单步，每次 LLM 调用后通过 SessionStore 落盘，直到停止信号。

归属：L3 执行与连接。装配归属：按需（任何驱动常驻 agent 执行循环的 daemon 装）。依赖：StepExecutor, SessionManager（可选）。被调用：Runtime（常驻 agent）、SubagentSystem（一次性子代理）。定义的协议：`AbortSignal`（中断协议——执行器如何接收并响应外部中断；Gateway 等触发源通过此接口通知）。

**应然**（2026-04-26 修订 / 跟 modules.md ~~§15~~ §17 align）：
- 装配归属「按需」明记本节首段
- 定义的协议「AbortSignal」明记（中断协议 / 由 Daemon 注入用于外部中断）
- 对外能力清单跟 modules.md ~~§15~~ §17 align：完整 agent 执行循环 / 跨步计数与熔断（parse errors / max_tokens tool_use）/ 每步完成后落盘 / maxSteps 守卫 / 每步钩子供调用方注入 step_yield 判定（详 §职责边界 1-7）

**实然**：表述已同步；§7 不动。

## 职责边界

### 做

1. 循环调 StepExecutor，直到 `kind: 'final'` 或异常
2. 维护跨步计数：stepCount、consecutiveParseErrors、consecutiveMaxTokensToolUse
3. 若提供 sessionStore，每次 `kind: 'continue'` 后**直接调 SessionManager 落盘**（不走回调）
4. stepCount 达 maxSteps 抛 `MaxStepsExceededError`
5. 连续熔断判定（parse errors / max_tokens tool_use）
6. ctx.signal 跨步检查
7. 每步完成后调 `onAfterStep` 钩子（调用方在此注入 step_yield 判定）

### 不做

- 不调 LLM、不执行工具（归 StepExecutor）
- 不做 idle timeout（归 Runtime：它持有 AbortController，基于 StepCallbacks delta 回调维护计时器）
- 不读写 audit.tsv（调用方透传回调到 StepExecutor）
- 不管 turn 语义 / snapshot commit / turn counter（归 Runtime）
- 不读 inbox（step_yield 判定归调用方）

## 接口

### `runAgent(input: AgentInput): Promise<AgentResult>`

```ts
interface AgentInput {
  messages: Message[];              // in-place；调用方传入（通常来自 SessionManager.load）
  systemPrompt: string;
  tools: ToolDefinition[];
  executor: IToolExecutor;
  registry?: ToolRegistry;          // 可选；透传给 StepExecutor
  ctx: ExecContext;                 // signal 由调用方注入（AbortController）

  sessionStore?: SessionManager;    // 可选；不传则跳过每步落盘（SubAgent 场景）

  maxSteps?: number;                // 默认 20
  maxTokens?: number;               // 透传给 StepExecutor
  stepCallbacks?: StepCallbacks;    // 透传给 StepExecutor
  onAfterStep?: (meta: StepMeta) => void | Promise<void>;  // 每步完成（含落盘）后触发
}

interface AgentResult {
  finalText: string;
  stepsUsed: number;
  stopReason: 'end_turn' | 'max_tokens_text' | 'no_tool' | 'unknown';
}
```

### `onAfterStep` 的角色

- **时机**：`kind: 'continue'` 分支中，`sessionStore.save` **完成之后**、`stepCount++` **之后**
- **不触发时机**：`kind: 'max_tokens_tool_use'`（本步不计、不落盘）、`kind: 'final'`（直接返回）
- **用途**：Runtime 在此检查高优先级 inbox 并 `abortController.abort({ type: 'step_yield' })`
- **约束**：回调内部抛错不吞（让 AgentExecutor 抛出终止循环）；回调 abort ctx.signal 后，下一轮 step 开头会被 StepExecutor 识别并抛 `PriorityInboxInterrupt`

## 失败语义

| 触发源 | AgentExecutor 行为 |
|---|---|
| stepCount 达到 maxSteps | 抛 `MaxStepsExceededError(maxSteps)` |
| StepExecutor 抛 IdleTimeoutSignal / PriorityInboxInterrupt / UserInterrupt | 原样往上抛 |
| StepExecutor 返回 `kind: 'context_window_exceeded'` | 抛 `Error('LLM context window exceeded...')` |
| 连续 MAX_CONSECUTIVE_PARSE_ERRORS 步 allParseErrors | 抛 `Error('工具输入 JSON 连续解析失败...')` |
| 连续 MAX_CONSECUTIVE_MAX_TOKENS_TOOL_USE 次 max_tokens_tool_use | 抛 `Error('LLM 连续 ... 次 max_tokens 截断 tool_use...')` |
| SessionManager.save 抛错 | 原样抛出（落盘失败不可恢复） |
| onAfterStep 抛错 | 原样抛出 |

## StepExecutor 接合点

| StepExecutor 返回 | AgentExecutor 行为 |
|---|---|
| `kind: 'final'` | 返回 AgentResult，结束 |
| `kind: 'continue'` | sessionStore.save → stepCount++ → 检查 maxSteps → onAfterStep → 更新 consecutiveParseErrors → 下一轮 |
| `kind: 'max_tokens_tool_use'` | 不落盘、不 stepCount++、consecutiveMaxTokensToolUse++ → 检查熔断 → 下一轮 |
| `kind: 'context_window_exceeded'` | 抛错 |

`consecutiveParseErrors` 更新规则：
- `meta.allParseErrors === true` → 累加，达阈值抛错
- `meta.allParseErrors === false` → 重置为 0

## 不可消除的耦合（显式表达）

**消除路径首选 port pattern**（feedback_module_contract_structure r40.2）：消费方 own port + 默认实现 + assembly 注入 / phase337+335+340 三 phase 实证。AgentExecutor 当前通过 ctx 注入 SessionManager + ctx.signal / 与 StepExecutor IToolExecutor 注入同模式 = port 范本。

1. **AgentExecutor → SessionManager 直接依赖**（当 sessionStore 传入时）：不走回调。落盘是 AgentExecutor 业务语义的一部分（"每次 LLM 调用后通过 SessionManager 落盘"），由该模块发起（原则 2：模块为自己的业务语义负责）。
2. **onAfterStep 钩子**：step_yield 中断的触发归调用方（Runtime 知道 inbox、SubagentSystem 不关心）。这是 AgentExecutor 与上层的显式耦合点。
3. **ctx.signal 由调用方持有**：AgentExecutor 不 new AbortController。调用方（Runtime / SubagentSystem）持有 controller，注入 signal 到 ctx，控制 abort。

## 配置常量归属

`MAX_CONSECUTIVE_PARSE_ERRORS` / `MAX_CONSECUTIVE_MAX_TOKENS_TOOL_USE` 从 `constants.ts` 读，不走参数（修改频率低，跨模块共享无意义）。

## 7. 违规 / 偏差 / 原则对照 / 执行纪律

### 7.A 必修违规

**本 phase 实测零条**（`agent-executor.ts` 134 行 / grep `console\.` → 0 命中；无 audit.tsv 软吞；所有失败都抛错或透传）。

模块是纯决策循环：消费 StepExecutor 返回的 StepResult + StepMeta，按规则决定 stepCount / save / 熔断 / onAfterStep / 抛错，无信息可软吞。

### 7.B 合规偏差

**type 标签**（feedback_module_contract_structure r40.3）：B 项必标 `drift` vs `design-gap` 二分。
- **drift type**：契约说应 X / 实然 Y / 修法明确（推 §7.A 必修）
- **design-gap type**：应然 silent / 实然有 / 修法不明 / 必推独立 design phase 评估

> 现有 B 类历史登记 type 分类待 r43+ 应然同步 phase 批量补标。已知初判：
> - B.p181-* 历史登记 = 多为 drift / phase306+313 部分消化
> - **B.p344-agent-1 onAfterStep 时机顺序偏差**（r42 D fork 第 5 轮新发现）= **drift / 中严重**：应 save → stepCount++ → maxSteps检查 → onAfterStep → consecutiveErrors更新 / 实现：save → stepCount++ → consecutiveErrors更新 → onAfterStep / **熔断逻辑在 callback 中不可观测** / agent-executor.ts:82-114 / 推 r43+
> - **B.p344-agent-2 跨模块 step-executor console.warn 8 处**（r42 D fork 第 5 轮新发现）= **drift / 跨契约**：8 处 console.warn 应通过 stepCallbacks.onEmptyResponse / onUnknownStopReason / 与 step-executor B.p181-1 协调 / 推 r43+ 独立治理 phase（升格候选「跨模块 console.warn 通过 callback 收敛」）
> - **B.p344-agent-3 audit-events.ts 文件不存在**（r42 D fork 第 5 轮新发现）= **drift / 应然描述偏差**：应然 §3 提及 agent-executor audit-events.ts / 实现无该文件 / 跨模块事件落 step-executor / runtime / 与 step_executor 同模式 / 应然修订或保持



**B.p181-1 — `Error` 字符串类型用于 parse errors / max_tokens_tool_use 熔断抛出**

- 现状：`runAgent` 在两处熔断判定（`agent-executor.ts:100-102 / 119-122`）抛 `new Error('工具输入 JSON 连续解析失败 N 次...')` 与 `new Error('LLM 连续 N 次 max_tokens 截断 tool_use...')`，消息含变量插值
- 违反：Coding Principle 错误节"预期失败暴露而非吞没"合规；但未用命名 class（如 MaxStepsExceededError 那样），上层无法 instanceof 精准分支
- 风险：调用方（Runtime / SubagentSystem）只能 message 字符串匹配判定熔断类型，**硬编码中文消息耦合**
- owner：phase169 以后（粗糙期 class 体系尚未展开时的折中）
- 计划 phase：~~细化期独立 phase~~ phase306 step1 已消化
- 升档条件：若 Runtime / SubagentSystem 出现针对熔断的特殊处理逻辑（如 "parse errors 熔断退回 review_request" 场景）→ 升格 7.A（无命名 class 导致状态不可观察）

**phase306 消化**（2026-04-25 / SHA `78f54d9`）：`ConsecutiveParseErrorsExceededError` + `ConsecutiveMaxTokensToolUseError` 新建于 `src/types/errors.ts`；`agent-executor.ts` 两处 `throw new Error(中文字符串)` 替换为命名类。B.p181-1 清零。

**B.p181-2 — `ctx.stepNumber = stepCount` 与 `ctx.incrementStep()` 双重赋值**

- 现状：`agent-executor.ts:55 / 85-86` 同时做 `ctx.stepNumber = stepCount`（循环开头强制同步）+ `ctx.incrementStep(); stepCount = ctx.stepNumber`（continue 分支）
- 违反：Coding Principle 数据节"可变状态应有唯一且明确的管理者"灰度 —— `stepNumber` 有双写源（外部赋值 vs incrementStep），AgentExecutor 同时持有 `stepCount`（本地）与 `ctx.stepNumber`（共享）
- 合理性：ctx 供 StepExecutor 读取本步号（日志 / tool ctx），AgentExecutor 权威持有循环计数；双写是 "底层消费 + 上层权威" 的显式耦合
- owner：phase166 以后（ExecContext 抽象建立时）
- 计划 phase：无（合规偏差保留；除非 ctx 被 StepExecutor 外的消费方直接 mutate 导致状态失控 → 升格 7.A）

**phase309 确认保留**（2026-04-25）：r28 D §7.B 全核确认无外部 mutator — stepNumber 仍由 AgentExecutor 权威持有，ctx.stepNumber 仅 StepExecutor 读取；升档条件未触发。保留。

**B.p181-3 — `throwAbortError` 由 step-executor 导出，agent-executor 反向 import**

- 现状：`agent-executor.ts:13` import `throwAbortError from './step-executor.js'`
- 违反：Module Logic #5 "依赖单向" 语义上合规（agent-executor → step-executor），但 `throwAbortError` 本质是 signal/reason → 异常类型的通用映射，放 step-executor 导出属"位置偏差"
- 风险：若未来增加 AbortSignal 消费者（如 Runtime.abort、SubagentSystem），都要反向 import 到 step-executor
- owner：phase169 以后（signal 类型体系建立时）
- 计划 phase：低优先级独立 phase —— `throwAbortError` 提升到 `src/types/signals.ts` 或 `src/core/react/abort-helpers.ts`
- 升档条件：若出现第 3 个消费方 → 升格 7.A

**phase313 消化**（2026-04-25 / SHA `f2420b8`）：`throwAbortError` 迁移至 `src/core/react/abort-helpers.ts`；`agent-executor.ts` 改从 abort-helpers import（非 step-executor）。B.p181-3 清零。

### 7.C 原则对照

全 32 条覆盖（Module Logic 11 + Design 11 + Philosophy 4 + Path 6）。深度按需：合规一行 / 灰度展开 / 违反引用 §7.A 或 §7.B。

#### Module Logic Principles（11 条）

- **M1 独立可变职责**：合规。循环控制 + 跨步计数 + 落盘调用 + 熔断判定 + onAfterStep 调度 —— 变更源与 StepExecutor（单步执行）/ Runtime（turn 语义 / snapshot / inbox）正交
- **M2 业务语义归属**：合规。"每次 LLM 调用后通过 SessionManager 落盘" 是 AgentExecutor 业务语义（文件头注释明示），由本模块直接调 sessionStore.save 而非走回调
- **M3 资源归属**：合规。无磁盘资源；messages 是调用方传入的可变 buffer（in-place 语义显式）
- **M4 持久化**：合规。sessionStore.save 是持久化唯一出口；circuit breaker 计数（`consecutiveParseErrors` / `consecutiveMaxTokensToolUse`）是跨步瞬态，不持久化
- **M5 依赖单向 / 禁循环**：合规。agent-executor → step-executor / SessionManager / constants / types；无反向（~~B.p181-3 位置偏差不构成环~~ → phase302 已消化）
- **M6 依赖结构稳定**：合规。AgentInput 10 字段 / AgentResult 3 字段自 phase169+ 未变
- **M7 耦合界面稳定**：合规。`runAgent` 签名稳定；StepResult kind union 扩展时本模块只增 switch 分支不改接口
- **M8 耦合界面最小**：合规。AgentInput 10 字段全部有用（无"为未来保留"字段）；onAfterStep 接口只传 StepMeta 不漏内部状态
- **M9 显式表达编译器可检**：合规。StepResult discriminated union（`kind: 'final' | 'continue' | 'max_tokens_tool_use' | 'context_window_exceeded'`）+ exhaustiveness check（L129 `_exhaustive: never`）
- **M10 不合理停下**：未触发
- **M11 边界不对停下**：未触发

#### Design Principles（11 条，#1 展 4 面 / #6 展 2 面）

- **D1a 信息不丢失**：合规。messages in-place 持续追加；StepMeta 传给 onAfterStep；失败时抛错不吞
- **D1b 状态可观察**：合规。stepCallbacks 透传 9 回调（onBeforeLLMCall / onLLMResult / onTextDelta 等）；onAfterStep 见 StepMeta
- **D1c 中断可恢复**：合规。signal.aborted 透传为 IdleTimeoutSignal / PriorityInboxInterrupt / UserInterrupt；sessionStore.save 在 `continue` 分支必调，崩溃后可从最后完整步恢复
- **D1d 事后可审计**：合规。每次 save 落盘整份 messages；LLMCallInfo 经 onLLMResult 回调可落 audit
- **D2 不得丢弃/静默**：合规（B.p181-1 登记熔断错误信息用 Error 消息而非 class，但未丢失信息）
- **D3 用户可观察**：合规。同 D1b
- **D4 LLM 调用恢复**：合规。循环 + sessionStore.save 组合即恢复机制（本 phase 不讨论 provider failover，归 StepExecutor / LLMService）
- **D5 日志重建**：合规。sessionStore 落盘 + StepMeta 回调足以重建
- **D6a 决策主体**：合规。runAgent 是循环触发器；LLM 决策经 executeStep 路由
- **D6b 子代理不阻塞**：无关（SubAgent 场景由 SubagentSystem 消费本模块，阻塞 / 异步由消费方控制）
- **D7 系统可信路径**：合规。ToolExecutor / Registry 透传给 StepExecutor，不绕路
- **D8 事件驱动**：灰度。AgentExecutor 本身是同步 while 循环，"事件驱动" 由上层（Runtime.processBatch）在入口决定
- **D9 多 claw 不隔绝**：无关
- **D10 motion 特殊**：无关（identity 在 Runtime / Assembly 层分支）
- **D11 CLI 唯一对外**：无关

#### Philosophy（4 条 / 2026-04-27 r42 D 结构合规修：3→4 / 补 P4 / 同 l1_llm_service / l3_step_executor 同型 / 第 3 次实证 / 升格阈值大达）

- **P1 Agent 即目录**：合规。sessionStore.save 把对话落盘即状态持久化
- **P2 clawforum 本质上下文工程**：合规。循环是 "messages buffer + systemPrompt + tools" 上下文的迭代演化
- **P3 多 agent 利用上下文窗口**：合规。AgentExecutor 单一代码基；身份差异由调用方（Runtime / SubagentSystem）注入依赖决定
- **P4 系统为智能体服务**：合规。AgentExecutor 提供决策循环 + 熔断保护基础设施 / 不参与决策 / 仅 LLM call + tool call 编排

#### Path Principles（6 条）

- **Path #1 规划基于规划时刻事实**：合规。本 phase 契约回填前已 Read 源码 134 行 + tests 215 行
- **Path #2 差距显式登记**：合规。§7.B 3 条偏差登记（B.p181-1 熔断 Error class / B.p181-2 ctx 双写 / B.p181-3 throwAbortError 位置）
- **Path #3 语义一致最小变更单元**：合规。本 phase 单一意图 = 契约 backfill；零代码
- **Path #4 可回滚 + 破坏性论证**：合规。design 本地 only；无破坏性
- **Path #5 完成后复盘**：将于 Step 3 产出
- **Path #6 冲突立即中断**：未触发

### 7.D 关键决策映射表（modules.md 引用 / 2026-04-27 r42 D 结构合规修：补完）

从 `design/modules.md` §关键设计决策章节迁移。原 KD 编号保留供对账。

| KD | modules.md 描述 | 本契约引用位置 | 一致性 |
|---|---|---|---|
| KD（待编号）| AgentExecutor L3「跨步循环 / 熔断 / abort 协调」vs StepExecutor「单步执行原语」分工 | §职责边界 + §StepExecutor 接合点 | ✓ 一致（M#1 反向独立性强）|
| KD（待编号）| sessionStore 注入模式（可选 deps）/ 不走回调 / 业务语义自发起（M#2）| §不可消除耦合 #1 | ✓ 一致 |
| KD（待编号）| onAfterStep 钩子归调用方（Runtime / SubagentSystem）/ AgentExecutor 不持 inbox 知识 | §不可消除耦合 #2 | ✓ 一致 |
| KD（待编号）| ctx.signal 由调用方持有 / AgentExecutor 不 new AbortController | §不可消除耦合 #3 | ✓ 一致 |
| **KD（r42 D fork 新发现）**| onAfterStep 时机顺序（save → stepCount++ → maxSteps检查 → onAfterStep → consecutiveErrors更新）| **§7.B B.p344-agent-1（待 r43+ 治理）** | **⚠ drift**（实现 consecutiveErrors 在 onAfterStep 前更新 / 熔断不可观测）|

### 7.Phase 执行纪律

#### phase309 纪律 — §7.B 剩余评估（r28 分支 D / 2026-04-25 / design only）

- **scope**：r28 D §7.B 5 条评估；Path #1 全核 L3 executor 域
- **B.p181-2 保留**：升档条件未触发（无外部 ctx.stepNumber mutator）
- **B.idle-abort**：代码修复见 step2（phase309 合入 SHA `3f32314`）

#### phase306 纪律 — AgentExecutor B.p181-1 命名 Error 类（r27 分支 D / 2026-04-25 / SHA `78f54d9`）

- **scope**：r27 D §7.B B.p181-1 修复；Path #1 #14 实然核（分发表 6 条 → 本 phase 2 条）
- **改动**：types/errors.ts +ConsecutiveParseErrorsExceededError + ConsecutiveMaxTokensToolUseError；agent-executor.ts 2 处 throw new Error → 命名类
- **保留**：B.p181-2（ctx.stepNumber 双写 / 契约保留"无计划"）
- **不做**：B.idle-abort（架构性修复 / 待定 / 独立 future phase）

#### phase302 纪律 — B.p181-3 throwAbortError 位置提升（2026-04-25）

- **scope**：r26 分支 E / throwAbortError 从 step-executor 迁移至新建 abort-helpers.ts
- **产出**：`src/core/react/abort-helpers.ts`（新建）/ `agent-executor.ts` import 改 / `step-executor.ts` 函数定义移除 + import 补
- **N1**：phase36 分派表标 "L3 StepExecutor B.p181-3" 同名项实为 console tag 修正（已由 phase236 消化）；本 phase 消化的是 agent-executor 反向 import 偏差

#### phase317 纪律 — 契约 drift 修订（r30 分支 C / 2026-04-25 / design only）

- **scope**：B.p181-3 消化 SHA 修正（假 SHA `2079eba` → 正确 `f2420b8` / phase302→313）

#### phase181 纪律 — L3 agent_executor 契约 backfill（2026-04-21，design 本地 only）

- **scope**：粗糙期契约（phase169 附近建立）缺 §7 四子节 + §8；本 phase 按 `feedback_module_contract_structure` 补齐
- **产出**：§7.A（零条，实测无软吞）/ §7.B（3 条偏差）/ §7.C（32 条对照）/ §7.Phase（本节）/ §8（下节）
- **对比先例**：
  - phase172 Daemon 冻结契约 §7.A 10 条厚登记（顶层模块高 scope）
  - phase176 Watchdog 冻结契约 §7 零 §7.A（无源码）
  - phase181 AgentExecutor backfill：零 §7.A（模块纯净）+ 3 §7.B（折中登记）
- **方法论贡献**：**L3 执行原语 backfill 模板首例** —— 源码已稳定、无软吞的模块 backfill 重点在 §7.B 折中登记 + §7.C 原则合规确认，不在 A 类清零


### §7.drift — 应然 framing drift（phase325 全推 / 2026-04-26）

| # | 位置 | drift 描述 | 修正 |
|---|---|---|---|
| D1 | §head | 已有 head split + § numbering drift 修正（§15→§17 / r32 D 已修）| 无需修正 |

## 8. 测试覆盖

### 8.1 行为覆盖

按 §职责边界 归类（行为路径清单，非覆盖率数字）：

- **循环终止**
  - `kind: 'final'` 直接返回 AgentResult
  - stepCount 达 maxSteps 抛 `MaxStepsExceededError`
- **落盘 + 步进**
  - `continue` 分支：sessionStore.save → ctx.incrementStep → onAfterStep 顺序
  - 无 sessionStore 时跳过 save（SubAgent 场景）
- **熔断判定**
  - `allParseErrors=true` 累加 `consecutiveParseErrors`；达阈值抛 Error（B.p181-1 登记）
  - `kind: 'max_tokens_tool_use'` 累加 `consecutiveMaxTokensToolUse`；不 save / 不 stepCount++；达阈值抛 Error
- **信号透传**
  - signal.aborted 前/中/后任一时点 → throwAbortError 分发 IdleTimeoutSignal / PriorityInboxInterrupt / UserInterrupt
- **context window exceeded**
  - `kind: 'context_window_exceeded'` 抛 `Error('LLM context window exceeded...')`
- **exhaustiveness**
  - switch 结尾 `_exhaustive: never` 保护 StepResult union 扩展（编译期）

### 8.2 回归套件归属

- `tests/core/agent-executor.test.ts`（215 行 / 7 it）—— 主回归，直测 `runAgent`：
  - 多步循环 finalText
  - sessionStore.save 每 continue 步一次 / final 步不调
  - max_tokens_tool_use 不 save / 不 stepCount++
  - 连续 parse errors 熔断
  - 连续 max_tokens_tool_use 熔断
  - onAfterStep 在 save 后调 + meta 正确 + max_tokens_tool_use 不调
  - stepCount 达 maxSteps 抛 `MaxStepsExceededError`
- `tests/core/react.test.ts`（1097 行 / 40 it）—— 高阶 `runReact` shim 覆盖；agent-executor + step-executor 整链回归
- 共享 mock：`makeMockLLM` / `makeMockExecutor`（tests/core/agent-executor.test.ts / step-executor.test.ts 各自定义同构）

### 8.3 覆盖缺口

无显式缺口登记（§7.A 零条 → §8.2 回链表省略）；若未来 §7.A 登记 audit 事件，此处追加回链表参 `l5_runtime.md §8.2` 模板。

