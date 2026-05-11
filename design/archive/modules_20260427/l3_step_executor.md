# StepExecutor 接口契约

L3 单步执行器。调用一次 LLM，若返回 tool_use 则执行工具，把消息追加到会话，返回停止信号 + 可观测元数据。

归属：L3 执行与连接。装配归属：按需（随 AgentExecutor 装配 / 单步执行原语）。唯一消费者：AgentExecutor。定义的协议：`ToolHandler`（工具调用协议，各模块导出的工具是协议实现者；装配方注入工具 map）。

**应然**（2026-04-26 修订 / 跟 modules.md ~~§14~~ §16 align）：
- 装配归属「按需」明记本节首段
- 定义的协议「ToolHandler」明记（工具 handler 协议）
- 对外能力清单跟 modules.md ~~§14~~ §16 align：单次 LLM 调用 / tool_use 分组并行执行（readonly+sync）/ messages in-place 追加 / max_tokens 截断修复 / context window 识别 / 停止信号（详 §职责边界 1-5 + §接口 StepResult）

**实然**：表述已同步；§7 不动。

## 职责边界

### 做

1. 调用一次 LLM（流式，含 thinking/text/tool_use 事件）
2. 若 LLM 返回 `tool_use`：按 readonly/sync 分组执行工具（readonly+sync 并行，其余串行）
3. 把 assistant 消息（含 tool_use）与 tool_result 追加到 messages（in-place）
4. 处理 `max_tokens` 截断 tool_use 的修复（补 `[TRUNCATED]` tool_result）
5. 返回本步结果信号 + 可观测元数据

### 不做

- 不维护跨步计数器（stepCount / consecutiveParseErrors / consecutiveMaxTokensToolUse）
- 不做落盘（SessionStore 由 AgentExecutor 调）
- 不处理 MaxStepsExceeded（归 AgentExecutor）
- 不读写 audit.tsv（归 AuditLog；回调透传）

## 接口

### `StepInput`

```ts
interface StepInput {
  messages: Message[];              // in-place 修改
  systemPrompt: string;
  tools: ToolDefinition[];
  executor: IToolExecutor;
  registry?: ToolRegistry;          // 可选；缺省时放弃 readonly+sync 并行优化，全部走 sequential
  ctx: ExecContext;                 // 含 signal、stepNumber（由 AgentExecutor 同步）
  maxTokens?: number;               // 默认 REACT_DEFAULT_MAX_TOKENS
  callbacks?: StepCallbacks;        // 聚合回调对象（可选）
}
```

11 个平铺回调收敛成单一 `StepCallbacks` 对象。

### `StepCallbacks`

```ts
interface StepCallbacks {
  onBeforeLLMCall?: () => void;
  onLLMResult?: (info: LLMCallInfo) => void;
  onTextDelta?: (delta: string) => void;
  onTextEnd?: () => void;
  onThinkingDelta?: (delta: string) => void;
  onToolCall?: (toolName: string, toolUseId: string) => void | Promise<void>;
  onToolResult?: (toolName: string, toolUseId: string, result: ToolResult) => void;
  onReset?: (provider: string, timeoutMs: number) => void;
  onProviderFailed?: (provider: string, model: string, error: string) => void;
}
```

- 不含 `onStepComplete`（落盘归 AgentExecutor）
- `onToolResult` 不带 step/maxSteps 参数（循环语义归 AgentExecutor）
- 回调 safe-wrap 策略（I/O 边界包裹，流内热路径裸调）：

| 回调 | safe-wrap | 说明 |
|---|---|---|
| `onBeforeLLMCall` | ✅ | I/O 边界；warn 不抛 |
| `onToolCall` | ✅ | I/O 边界；warn 不抛 |
| `onToolResult` | ✅ | I/O 边界；warn 不抛 |
| `onLLMResult` | ❌ 裸调 | 观察性回调；异常冒泡终止 step |
| `onTextDelta` / `onTextEnd` / `onThinkingDelta` | ❌ 裸调 | 流内热路径；异常冒泡终止 step |
| `onReset` / `onProviderFailed` | ❌ 裸调 | 流内告警；异常冒泡终止 step |

取舍：流式 chunk 每次触发的回调不 safe-wrap，避免每 chunk try/catch 的性能与语义噪音；跨 I/O 边界的回调必须 safe-wrap，防止上层回调 bug 污染工具执行流程。

### `StepResult`

```ts
type StepResult =
  | { kind: 'final'; stopReason: 'end_turn' | 'max_tokens_text' | 'no_tool' | 'unknown'; finalText: string }
  | { kind: 'continue'; meta: StepMeta }
  | { kind: 'max_tokens_tool_use'; meta: StepMeta }    // 补了 TRUNCATED tool_result，不计 step
  | { kind: 'context_window_exceeded' };               // AgentExecutor 抛错

interface StepMeta {
  toolCallCount: number;
  parseErrorCount: number;         // 供 AgentExecutor 做 consecutiveParseErrors 判定
  allParseErrors: boolean;         // 等价 toolCallCount>0 && parseErrorCount===toolCallCount
  llm: LLMCallInfo;
}
```

- `kind: 'continue'` vs `'max_tokens_tool_use'` 拆开：AgentExecutor 据此决策是否累 stepCount、是否 onStepComplete
- `allParseErrors` 是跨模块耦合元数据，显式放入 meta
- `context_window_exceeded` 由 StepExecutor 识别，AgentExecutor 决定抛什么错

## 失败语义

| 失败源 | StepExecutor 行为 |
|---|---|
| signal.aborted（LLM 调用前/中/工具执行后） | 抛 `IdleTimeoutSignal` / `PriorityInboxInterrupt` / `UserInterrupt`（从 signal.reason 派生） |
| LLM provider 抛错 | 回调 onLLMResult（带 error），原样抛出 |
| 工具内部抛错 | 吞掉转成 `ToolResult { success: false, content: "[ErrorType] ..." }`（不抛） |
| 工具输入 JSON parse 失败 | 返回 `metadata.parseError=true` 的 ToolResult，计入 parseErrorCount |
| LLM 返回空 content | console.warn，按 stop_reason 分支处理 |

## 不可消除的耦合（显式表达）

**消除路径首选 port pattern**（feedback_module_contract_structure r40.2）：消费方 own port + 默认实现 + assembly 注入 / phase337+335+340 三 phase 实证。StepExecutor 当前耦合（IToolExecutor + LLMService 注入）已是 port 范本（消费方 own = StepExecutor own / runtime 注入实现）。

1. **跨步计数元数据**：`StepMeta.parseErrorCount` / `allParseErrors` 是 AgentExecutor 做 consecutive 判定的输入。parse error 的判定必须基于单步 ToolResult.metadata，只有 StepExecutor 能看见；熔断决策必须跨步，只有 AgentExecutor 能做。
2. **max_tokens + tool_use 双重职责**：StepExecutor 负责"补 TRUNCATED tool_result"的单步动作，AgentExecutor 负责"不累 stepCount、连续熔断"的循环决策。`kind` 字段作为显式边界。
3. **ctx.signal 双向**：AgentExecutor 持有 AbortController，StepExecutor 消费 ctx.signal；StepExecutor 不调 `ctx.incrementStep()`（由 AgentExecutor 负责）。

## 7. 违规 / 偏差 / 原则对照 / 执行纪律

### 7.A 必修违规

**本 phase 实测零条**。模块有 6 处 `console.warn` / `console.error`，逐一判据（是否丢失信息）：

| 位点 | 调用 | 场景 | 信息去向 | 判据结论 |
|---|---|---|---|---|
| L110 | `console.warn` | LLM 返回 empty content | response 仍按 stop_reason 处理，后续 content.length===0 降级 | **合规**（信息性警告，无丢失） |
| L201 | `console.warn` | Unknown stop_reason | 降级为 `kind: 'final', stopReason: 'unknown'` + extractText | **合规**（降级处理，信息保留到 finalText） |
| L221 | `console.warn` | safeCallback sync 回调异常 | I/O 边界保护；异常经 warn 保留 | **合规**（显式 "safe-wrap 策略" §接口节，上层回调 bug 不污染 step 热路径） |
| L226 | `console.warn` | safeCallback async 回调异常 | 同上 | **合规** |
| L322 | `console.warn` | Mid-stream provider failover | 信息经 `onReset` 回调暴露（StepCallbacks.onReset） | **合规**（信息保留到回调） |
| L528 | `console.error` | 工具内部抛错 | 转 `ToolResult { success: false, content: '[ErrorType] ...' }` 返回 | **合规**（信息转为结构化失败返回） |

**L246 `console.error`**（tool input JSON parse 失败）：信息转 `{ __parseError: true, __raw }` 塞入 toolCall.input，后续 `executeSingleTool` L510 读 __parseError 返回结构化 `ToolResult.metadata.parseError=true`，进入 AgentExecutor 的 `consecutiveParseErrors` 熔断路径 —— **合规**。

~~**A.1 — LLM 错误 fallback 序列化丢失信息**（2026-04-22 phase175 会话后实测升格自 B.p181-1）~~

**phase236 已清零**（2026-04-22 / SHA `2737d47`）

- 位置：`step-executor.ts:95`（改后）`error: err instanceof Error ? err.message : (typeof err === 'object' && err !== null ? JSON.stringify(err, Object.getOwnPropertyNames(err)) : String(err))`
- 修复：`Object.getOwnPropertyNames` 保留非 Error 对象全部字段（含不可枚举属性如 `code`/`errno`/`syscall`）；空对象输出 `"{}"` 优于 `"[object Object]"`
- 测试佐证：`step-executor.test.ts` 新增 it"onLLMResult.error contains JSON fields when LLM throws a non-Error object" / `mockRejectedValueOnce({ code: 'ECONNRESET' })` → `results[0].error` contains `'ECONNRESET'` ✓

§7.A 当前实然状态 = **0 条必修**；6 console 调用合规 + A.1 已消化（phase236）。

### 7.B 合规偏差

**type 标签**（feedback_module_contract_structure r40.3）：B 项必标 `drift` vs `design-gap` 二分。
- **drift type**：契约说应 X / 实然 Y / 修法明确（推 §7.A 必修）
- **design-gap type**：应然 silent / 实然有 / 修法不明 / 必推独立 design phase 评估

> 现有 B 类历史登记 type 分类待 r43+ 应然同步 phase 批量补标。已知初判：
> - B.p181-1 console.warn 作为 observability 下限 = **drift**（已部分消化 / phase306 加可选回调 / fallback 待全清）
> - **B.p333-drift phase333 13 helper 物理拆分未严格执行**（r42 D fork 新发现）= **drift**（实际内聚优先 / 5 .ts 文件 / 接口契约稳定 / 应然描述 13 helper 与实然不一致 / 推 r43+ 应然同步 / 或 cleanup phase 物理拆分）
> - **D7 StepInput +llm/+idleTimeoutMs**（应然 8 → 实然 10 字段 / 扩展 / 非 breaking）= **drift**（应然滞后）
> - **D2 audit events 落盘时序**（应然 StepExecutor 落 audit / 实然 callback 透传 + Runtime 层落 audit）= **design 决策已存**（M8 耦合界面最小 / 不算 drift）

**B.p181-1 — console.warn 作为 observability 下限**

- 现状：L110 / L201 / L322 console.warn 同时没有 audit.tsv 落盘
- 违反：D1d 事后可审计灰度 —— empty response / unknown stop_reason / mid-stream failover 三事件运维期需要事后追溯，console.warn 依赖 stderr 抓取
- 合理性：本模块设计为 "纯函数式单步执行，观察性由回调外包"；若升格为 audit 集成需 StepExecutor 依赖 AuditWriter，违反 M8 耦合界面最小（当前 StepInput 不含 auditWriter 字段）
- owner：phase169 以后（StepExecutor 从 loop.ts 抽离时）
- 计划 phase：低优先级独立 phase —— 在 `StepCallbacks` 加 `onEmptyResponse` / `onUnknownStopReason` / `onProviderReset` 专用回调，由调用方（Runtime）落 audit；不把 AuditWriter 作为 StepInput 字段
- 升档条件：若运维期连续 3 次因 empty response / unknown stop_reason 排查靠猜 → 升格 7.A，按 `feedback_observability_debt` 独立 phase 治理
- **2026-04-22 部分升档记录**：LLM error fallback 序列化丢失信息子项已具化升 §7.A A.1（clawforum-architecture-analyzer claw audit 连 2 次 `err=[object Object]` 实测；`feedback_observability_debt` 判据满足）；empty response / unknown stop_reason 部分保留本 B 条继续观察

**phase306 消化**（2026-04-25 / SHA `78f54d9`）：`StepCallbacks` 加 `onEmptyResponse` / `onUnknownStopReason` 可选回调；step-executor.ts L116 / L207 两处 console.warn 改为 callback-or-fallback；audit/events.ts +LLM_EMPTY_RESPONSE / LLM_UNKNOWN_STOP_REASON；runtime.ts 接线 → auditWriter.write()。empty / unknown stop_reason 两事件落 audit.tsv。mid-stream failover 已有 onReset callback。B.idle-abort 独立 future phase。B.p181-1 部分消化（empty/unknown 两路径改善）。

**phase309 关闭 B.p181-1**（2026-04-25）：mid-stream failover 已有 `onReset` callback（→ Runtime `onProviderFailover` 链）；empty/unknown 两路径 phase306 已落 audit.tsv；B.p181-1 全部覆盖。B.p181-1 清零。

**B.p181-2 — 工具 parse error 跨模块元数据约定（显式耦合合规，但未类型化）**

- 现状：`{ __parseError: true, __raw }` 双下划线字段跨 StepExecutor（生成）→ executeSingleTool（识别）传递；ToolResult.metadata.parseError=true 跨 StepExecutor → AgentExecutor 传递
- 违反：Coding Principle 命名节"名字准确反映意图"合规；但 `__parseError` / `__raw` 使用双下划线惯例而非 `symbol` / 枚举常量
- 合理性：双下划线 + `__parseError: true` 显式表达 "此键不是用户工具参数"（防与工具实际 input 冲突）；`parseError` 在 metadata 下是 discriminated 键
- owner：phase169 以后（consecutive parse errors 熔断设计时）
- 计划 phase：无（保留；除非工具生态出现以 `__` 开头的合法参数 → 升格改用 `Symbol` 或 `#internal` 命名空间）

**B.p181-3 — `collectStreamResponse` 内 `console.error` 在 parse tool input 分支**

~~- 现状：`step-executor.ts:246` `console.error('[loop] Failed to parse tool input for ...')`；日志 tag 是 `[loop]` 而非 `[step-executor]`（其他 5 处是 `[step-executor]`）~~

**phase236 顺手清理**（2026-04-22 / SHA `2737d47`）：`[loop]` → `[step-executor]`；`react.test.ts` 对应断言同步更新。

**B.idle-abort — abort 打断已完整 tool_use 的执行路径**

- 现状：`callLLM` 的 `for await` 循环（L256）在每个 chunk 间检查 `signal.aborted`（L258）。当 idle timeout 触发 abort 时，即使最后一个 `tool_use_delta` chunk 已到达（tool_use 完整），abort 仍会在等待下一个 chunk 时抛出 `throwAbortError`，跳过 L365-381 的"保存最后的 blocks"和 `executeToolCalls`。结果：dialog 中出现无 `tool_result` 的孤立 `tool_use`（系统重启时由 session repair 补 error tool_result）。
- 实测案例：clawforum-arch-v2 claw step 55，kimi-k2.5 生成 write 工具（大 JSON，`__parseError`），idle timeout 120s 后 abort，write 的 tool_use 写入 dialog 但无 tool_result。用户发"继续"两次均再次 idle timeout（dialog 末尾孤立 tool_use 导致 LLM 无法正常响应）。
- 违反：D1c 中断可恢复 — abort 在 LLM stream 结束后的"工具执行"阶段不应打断已就绪的 tool_use。
- 合理性：当前 abort 粒度以整个 `callLLM` 为边界，未区分"LLM 还在输出"和"LLM 已完成，等待工具执行"两个阶段。
- 修复方向：在 `callLLM` catch 块中，若 `currentToolUse` 非空（或 `contentBlocks` 含 tool_use），先完成 tool_use 保存和 `executeToolCalls`，再抛 abort 信号。
- 计划 phase：phase309 step2（代码 / catch block stopReason guard / user 实施）

**B.p181-4 — `extractText` 在 stop_reason='no_tool' 降级时调用**

- 现状：`step-executor.ts:117-119` 当 `response.stop_reason === 'tool_use'` 但 `extractToolCalls` 返回 0 时，降级为 `kind: 'final', stopReason: 'no_tool'`；此时 `extractText` 从 content 拉文本
- 违反：M9 显式表达合规；但 "tool_use 返回 0 tool" 是 LLM 异常，应同时在 onLLMResult 带警告或 audit
- 合理性：当前经 onLLMResult 回调带 LLMCallInfo（model / tokens / latencyMs）但不带 "degenerate stop_reason" 信号；B.p181-1 升级时顺带覆盖
- owner：phase169+
- 计划 phase：与 B.p181-1 合并

**phase313 消化**（2026-04-25 / SHA `d3c05cb`）：`step-executor.ts:120-125` no_tool 分支 +1 console.warn 信号。B.p181-4 清零。

### 7.C 原则对照

全 32 条覆盖（Module Logic 11 + Design 11 + Philosophy 4 + Path 6）。深度按需：合规一行 / 灰度展开 / 违反引用 §7.A 或 §7.B。

#### Module Logic Principles（11 条）

- **M1 独立可变职责**：合规。单步 LLM 调用 + tool_use 执行 + messages 追加 + max_tokens 修复 + context_window 识别；职责均为"一步内"，与 AgentExecutor（跨步循环）/ Runtime（turn 语义）正交
- **M2 业务语义归属**：合规。LLM 调用 / tool_use 执行 / messages 追加由本模块直接发起（不走回调代发起）
- **M3 资源归属**：合规。无磁盘资源；messages 是调用方传入的可变 buffer；ToolRegistry / IToolExecutor 由调用方注入
- **M4 持久化**：无关（落盘归 AgentExecutor）
- **M5 依赖单向 / 禁循环**：合规。step-executor → LLMService / IToolExecutor / ToolRegistry / types / signals / constants；无反向
- **M6 依赖结构稳定**：合规。StepInput 8 字段 / StepResult 4 kind 自 phase169+ 未变
- **M7 耦合界面稳定**：合规。StepResult discriminated union 扩展新 kind 不改 executeStep 签名；StepCallbacks 扩展新回调为可选不破旧消费者
- **M8 耦合界面最小**：合规。StepCallbacks 9 回调精选（onBeforeLLMCall / onLLMResult / onTextDelta / onTextEnd / onThinkingDelta / onToolCall / onToolResult / onReset / onProviderFailed）；无冗余
- **M9 显式表达编译器可检**：合规。StepResult discriminated union + safe-wrap 策略表（§接口节）明示哪些回调裸调 / 哪些包裹
- **M10 不合理停下**：未触发
- **M11 边界不对停下**：未触发

#### Design Principles（11 条，#1 展 4 面 / #6 展 2 面）

- **D1a 信息不丢失**：合规。empty content / unknown stop_reason / tool_use 0 calls 全部降级到 final + extractText；context_window_exceeded 保留 thinking / text（L191-196）
- **D1b 状态可观察**：合规。9 回调覆盖 LLM / tool / stream / reset / provider failed 全链
- **D1c 中断可恢复**：合规。signal abort 转 IdleTimeoutSignal / PriorityInboxInterrupt / UserInterrupt；LLM stream 异常经 throwAbortError 转信号类；mid-stream failover 经 reset chunk 清状态 + onReset 回调
- **D1d 事后可审计**：灰度（B.p181-1 登记）—— console.warn 三处无 audit 落盘
- **D2 不得丢弃/静默**：合规（6 console 调用全部结构化处理，见 §7.A 表）
- **D3 用户可观察**：合规。onTextDelta / onThinkingDelta 流式暴露
- **D4 LLM 调用恢复**：合规。mid-stream reset 清状态 + onReset 回调；provider_failed chunk 经 onProviderFailed 暴露
- **D5 日志重建**：灰度（同 D1d）
- **D6a 决策主体**：合规。LLM 决策经 stream 经 stop_reason 分支回到本模块
- **D6b 子代理不阻塞**：无关
- **D7 系统可信路径**：合规。ToolExecutor 执行工具时校验 signal；readonly+sync 并行优化有 __parseError 过滤（L441-447）保护
- **D8 事件驱动**：合规。stream chunk switch 即事件驱动
- **D9 多 claw 不隔绝**：无关
- **D10 motion 特殊**：无关
- **D11 CLI 唯一对外**：无关

#### Philosophy（4 条 / 2026-04-27 r42 D 结构合规修：3→4 / 补 P4 / 同 l1_llm_service 同型）

- **P1 Agent 即目录**：合规。messages in-place 演化即对话状态 / 落 agent dir
- **P2 clawforum 本质上下文工程**：合规。executeStep 把 "messages + systemPrompt + tools" 上下文送入 LLM 并演化一步
- **P3 多 agent 利用上下文窗口**：合规。单一代码基无 identity 分支 / 多 agent 复用同代码基
- **P4 系统为智能体服务**：合规。StepExecutor 提供单步执行原语 / 不参与决策 / 仅执行 LLM call + tool call 编排

#### Path Principles（6 条）

- **Path #1 规划基于规划时刻事实**：合规。本 phase backfill 前已 Read 源码 578 行 + tests 297+1097+407 行
- **Path #2 差距显式登记**：合规。§7.B 4 条偏差登记（console observability / parse error 元数据 / console tag 不一致 / no_tool 降级信号）
- **Path #3 语义一致最小变更单元**：合规。本 phase 单一意图 = 契约 backfill；零代码
- **Path #4 可回滚 + 破坏性论证**：合规。design 本地 only；无破坏性
- **Path #5 完成后复盘**：将于 Step 3 产出
- **Path #6 冲突立即中断**：未触发

### 7.D 关键决策映射表（modules.md 迁移）

从 `design/modules.md` §关键设计决策章节迁移（2026-04-26 主会话；后续清理阶段重构）。原 KD 编号保留供对账。

- **KD#4（原 modules.md）StepExecutor 只跑一步**：循环归 AgentExecutor,每步之间落盘
- **KD#1（原 modules.md）工具 handler 装配期注入 StepExecutor**（cross-ref）：详 l3_tools.md §7.D 主登记。本模块作为被注入对象，承担接收并执行工具 handler 的职责。

---

### 7.Phase 执行纪律

#### phase309 纪律 — B.p181-1 关闭 + B.idle-abort 修复（r28 分支 D / 2026-04-25 / SHA `3f32314`）

- **scope**：r28 D §7.B 5 条评估 + B.idle-abort 代码修复
- **B.p181-1 关闭**：mid-stream failover onReset callback 足够；empty/unknown phase306 落 audit；B.p181-1 全覆盖
- **B.p181-2 保留**：__parseError 双下划线工具生态无冲突
- **B.idle-abort**：catch block stopReason guard 修复（+4/-2 行）；executeStep L139 现有 post-tool abort 路径消化
- **"1 条其他"**：L3 executor 域 0 条额外 §7.B

#### phase306 纪律 — StepExecutor B.p181-1 console.warn → audit（r27 分支 D / 2026-04-25 / SHA `78f54d9`）

- **scope**：r27 D §7.B B.p181-1 修复；Path #1 #14 实然核（分发表 6 条 → 本 phase 2 条）
- **改动**：StepCallbacks +onEmptyResponse / +onUnknownStopReason 可选回调；audit/events.ts +LLM_EMPTY_RESPONSE / LLM_UNKNOWN_STOP_REASON；runtime.ts 接线 → auditWriter.write()
- **保留**：B.p181-2（__parseError 字段 / 契约保留"无计划"）；B.idle-abort（待定 / 独立 phase）
- **B.p181-1 状态**：部分消化（empty/unknown 两路径改善 / mid-stream failover onReset 已有 / B.idle-abort 待后续）

#### phase302 纪律 — B.p181-4 no_tool 路径警告（2026-04-25）

- **scope**：r26 分支 E / no_tool 降级分支 +1 console.warn
- **产出**：`step-executor.ts` no_tool 分支 +1 warn / throwAbortError 函数定义移至 abort-helpers.ts
- **B.p181-1 关联**：no_tool warn 采用 console 形态（与 B.p181-1 三处 warn 同级）；B.p181-1 升格 audit 时顺带消化 B.p181-4

#### phase236 纪律 — StepExecutor §7.A A.1 清零（2026-04-22 / SHA `2737d47`）

- **scope**：r13 分支 C / §7.A A.1 LLM error fallback 序列化修复 + B.p181-3 顺手清理
- **N1 drift**：r13 分发表 "G2 SubAgent ~20 console" → 实测 0 console（SubAgent 全用 monitor.log）/ 接替 phase226 实际 G2 = StepExecutor
- **产出**：step-executor.ts +4 行（L95 fallback 改 JSON.stringify + L247 tag 改）/ step-executor.test.ts +1 it（非 Error LLM throw 路径）/ react.test.ts 1 断言同步 / §7.A A.1 清零 / §7.B B.p181-3 清零
- **Path #7 归属**：修在 step-executor 内部 / 不动 StepInput 接口 / 不扩 B.p181-1 scope
- **测试**：11 it pass（含新增）/ react.test.ts 40 it pass（断言同步）

#### phase181 纪律 — L3 step_executor 契约 backfill（2026-04-21，design 本地 only）

- **scope**：粗糙期契约（phase169 附近建立）缺 §7 四子节 + §8；本 phase 按 `feedback_module_contract_structure` 补齐
- **产出**：§7.A（零条，6 console 全部合规）/ §7.B（4 条偏差）/ §7.C（32 条对照）/ §7.Phase（本节）/ §8（下节）
- **对比先例**：
  - phase178 Runtime §7.A 4 条清零（audit 化治理）
  - phase181 StepExecutor backfill：零 §7.A 清零（合规即止）+ 4 §7.B 登记（observability 债 + 细节折中）
- **方法论贡献**：**"console.X 是否构成 §7.A" 判据表首次实践** —— 按"信息是否被结构化路径或回调保留"而非"有 console 即违规"判定，与 phase173/178 的"软吞 audit 化"模板形成双判据（软吞=必修；有回调/结构化返回=合规）

#### phase317 纪律 — 契约 drift 修订（r30 分支 C / 2026-04-25 / design only）

- **scope**：B.p181-4 消化 SHA 修正（假 SHA `2079eba` → 正确 `d3c05cb` / phase302→313）

### 7.Drift §编号漂移

| 位置 | 原引用 | 修正 | 原因 |
|---|---|---|---|
| head 应然 | modules.md §14 | modules.md ~~§14~~ §16 | modules.md 序号重排（Tools 独立后 StepExecutor 从 §14→§16） |
| head 能力清单 | modules.md §14 | modules.md ~~§14~~ §16 | 同上 |

### §7.drift — 应然 framing drift（phase325 全推 / 2026-04-26）

| # | 位置 | drift 描述 | 修正 |
|---|---|---|---|
| D1 | §head | 已有 head split + § numbering drift 修正（§14→§16 / r32 D 已修）| 无需修正 |

## 8. 测试覆盖

### 8.1 行为覆盖

按 §职责边界 归类：

- **kind: 'final'**
  - stop_reason=end_turn：纯文本返回
  - stop_reason=tool_use 但 extractToolCalls=0：降级 no_tool + extractText
  - stop_reason=max_tokens 且无 tool_use：stopReason='max_tokens_text' + content 尾追加 '[Response truncated due to length limit]'
  - stop_reason=unknown：降级 stopReason='unknown' + extractText
- **kind: 'continue'**
  - tool_use 成功执行：appendAssistantMessage + executeToolCalls + appendToolResults + StepMeta 返回
  - readonly + sync 并行路径（executeParallel）/ readonly + async 串行 / write 串行 三分组
- **kind: 'max_tokens_tool_use'**
  - stop_reason=max_tokens + 有 tool_use：每个 tool_use 补 `[TRUNCATED]` tool_result（is_error=true）
- **kind: 'context_window_exceeded'**
  - stop_reason in {model_context_window_exceeded, context_length_exceeded}
  - 保留 thinking / text 到 messages；过滤 tool_use（避免孤儿 assistant）
- **signal abort**
  - LLM 调用前：throwAbortError
  - LLM stream 中（每 chunk）：throwAbortError
  - 工具执行后：throwAbortError
  - Provider 抛 Error('Execution aborted') 时经 signal.reason 重新派生正确信号类
- **safe-wrap 策略**
  - I/O 边界（onBeforeLLMCall / onToolCall / onToolResult）：try/catch warn 不抛
  - 流内热路径（onTextDelta / onLLMResult / onReset / onProviderFailed / onThinkingDelta / onTextEnd）：裸调，异常冒泡终止 step
- **parse error 元数据链**
  - tool input 非法 JSON → `{ __parseError: true, __raw }` → ToolResult.metadata.parseError=true → StepMeta.parseErrorCount++
  - parallel 分支的 __parseError 过滤（L441-447）防元数据泄漏

### 8.2 回归套件归属

- `tests/core/step-executor.test.ts`（297 行 / 10 it）—— 主回归，直测 `executeStep`：
  - 4 kind 各自路径（final / continue / max_tokens_tool_use / context_window_exceeded）
  - meta.allParseErrors 正确
  - parallel 分支 parseError 仍计数熔断
  - mid-stream tool_use parse 失败不崩
  - context_window_exceeded 三子路径（两种 stop_reason 变体 + tool_use filter + 纯 tool_use content 不 append）
- `tests/core/react.test.ts`（1097 行 / 40 it）—— `runReact` shim 覆盖；AgentExecutor + StepExecutor 整链回归
- `tests/core/react-parallel.test.ts`（407 行 / 5 it）—— readonly sync 并行优化专项（readonly/sync 分组决策 + 并行 __parseError 过滤 + 写工具不并行）

### 8.3 覆盖缺口

- `onReset` / `onProviderFailed` 回调路径（L320-335）目前由 `react.test.ts` 的 provider failover 场景覆盖；无专项直测
- §7.B B.p181-1 升格为 §7.A 时需补：`onEmptyResponse` / `onUnknownStopReason` / `onProviderReset` 三事件回链测试

