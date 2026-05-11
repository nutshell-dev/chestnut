# StepExecutor 模块内部契约

> 本文档限本模块**内部**应然 — 8 节结构 derive 自 Module Logic Principles：§1-§4 = M#1-#4 各占一节，§5 审计 = M#3 命名空间细则，§6 层级，§7 drift = M#10/#11，§8 测试。
> 跨模块对外承诺（接口签名、生产/消费方、归本模块加不归本模块、不可消除耦合理由）见 [interfaces/l3.md](../interfaces/l3.md) StepExecutor 节。
> 模块本质加层归属见 [architecture.md](../architecture.md)。

## 1. 职责（M#1 独立可变职责）

> 本节内容 derive 自 [architecture.md](../architecture.md) §18「StepExecutor 本质：agent 单步执行的原语 / L3 agent 原语 ——『单步 LLM 调用』」加 M#1 / M#2 / M#3 / M#5。

### 做

应用 M#1（一个模块封装一组独立可变的职责），StepExecutor 的单一职责 = **agent 单步执行原语：一次 LLM 调用加随之的 tool 派发**：

- **单步 LLM 调用加 tool 派发**：调用一次 LLM / 若返回 tool_use 派发工具 / 追加 assistant + tool_result 到 messages — 这是 agent 循环的最小单元。
- **纯函数式调用语义**：调用方提供 messages / 本模块 in-place 追加 / 返回 StepResult — 不持 session 状态（M#1 derive 加 architecture.md 显式约束）。
- **结构化返回**：StepResult discriminated union（final / continue / 等）让调用方按 kind 分派（M#9 编译期可检 derive）。
- **错误统一**：LLM provider 错原样抛 / 工具内部抛错转结构化 ToolResult{success:false} / 空响应加未知 stop_reason 降级 — 让循环可继续（D「不丢弃 / 静默」derive — 错误信息全保留）。
- **callbacks 透传 observability**：经 callback 把执行过程事件传给调用方 / 不直接写 audit（M#1 + M#8 derive — 不持业务事件命名空间）。
- **abort 透传**：signal 检查派生 IdleTimeoutSignal / PriorityInboxInterrupt / UserInterrupt — 让上层区分中断原因。

> 具体 API 形态归 [interfaces/l3.md](../interfaces/l3.md) StepExecutor 节。具体实现细节（tool_use 三分组执行加 max_tokens_tool_use 修复加 11 callbacks 加 safe-wrap 策略加 parse error 元数据链等）的存在依据是「单步 LLM 调用 + tool 派发」原语 — 实然采纳的细节差异登记 §7.B。

### 不做

- **不 own 跨步循环加停止判定**（stepCount / consecutiveParseErrors / maxSteps 守卫归 L3 AgentExecutor）— derive 自 M#1 独立可变职责
- **不 own session 状态**（messages 是调用方传入的可变 buffer / ToolRegistry / IToolExecutor 由调用方注入）— derive 自 M#3 + architecture.md 约束
- **不 own dialog 持久化**（落盘归调用方在 stepCallback 内调 L2 DialogStore）— derive 自 M#1 + M#2
- **不 own LLM 协议层细节**（重试加 failover 加协议错误识别归 L2 LLMOrchestrator / 应然 split 后）— derive 自 M#5 + M#1
- **不 own 工具实现加权限校验加 tool 调用 audit**（归 L2 Tools 框架）— derive 自 M#1 + M#5
- **不 own turn 语义**（轮级 commit 加 inbox drain 等归 L5 Runtime）— derive 自 M#1
- **不 own idle timeout 计时**（每 chunk idle 探测由 LLM 层 own / 总 idle 由 Runtime own AbortController）— derive 自 M#1
- **不 own audit.write**（callbacks 透传 / 落 audit 归调用方）— derive 自 M#1 + M#8 耦合界面最小
- **不 own agent 业务身份**（motion / claw / sub-agent identity 归调用方）— derive 自 M#2

## 2. 业务语义（M#2 业务语义归属）

> 应用 M#2（模块为自己的业务语义负责），StepExecutor 的业务语义边界：

- **own**：「单步 LLM 调用加 tool 派发」概念 — LLM 调用加 tool_use 执行加 messages 追加加 max_tokens 修复加 context_window 识别。这些是 StepExecutor 唯一懂的「业务」（单步原语级）。
- **角色定位**：StepExecutor 是「**纯函数式单步执行**」非「**循环算法**」。每次调用独立 / 不跨调用持状态 / 与 AgentExecutor（跨步循环）/ Runtime（turn 语义）/ SubAgent（一次性 react）正交可变。
- **工具协议归属**：`Tool` / `ToolResult` 协议 schema 归 L2 ToolProtocol（不归本模块）/ 本模块仅经 caller 注入的 `IToolExecutor` 接口派发到 handler / 不 own 协议定义。

## 3. 资源（M#3 资源唯一归属）

> 应用 M#3（每种资源只归属唯一模块），StepExecutor 独占的资源（应然 L3 单步原语 only）：

| 资源 | 类别 | 持久化 |
|---|---|---|
| 无 | — | ✗ 单步执行无状态（每次调用独立）|

**无磁盘资源** — 模块零状态。

> 注：(1) 运行期参数：messages 是调用方传入的可变 buffer / in-place 修改 / ToolRegistry / IToolExecutor 由调用方装配期注入（非 own 资源）/ (2) type-level：StepResult discriminated union + StepCallbacks interface 归本模块 type 输出（非 M#3 业务资源 / 实施细节）/ (3) 工具协议（Tool / ToolResult）归 L2 ToolProtocol 不归本模块。

## 4. 持久化（M#4）

> 应用 M#4（持久化一切信息到磁盘 / 运行时句柄从磁盘信息重建），StepExecutor 自身的持久化立场：

- **模块零状态**：StepExecutor 不持自有磁盘 artifact 加运行期持久状态 — 单步执行无状态（每次调用独立）。
- **重建语义**：进程重启时无需从磁盘恢复 / 调用方下次 step 即得新执行。
- **dialog 持久化归调用方**：落盘归调用方在 stepCallback 内调 L2 DialogStore（应然 / AgentExecutor 不直调 DialogStore 同型 derive）。

## 5. 审计事件清单

> StepExecutor 不直接写 audit。所有 audit 落盘走 callbacks 透传 → Runtime 落 audit.tsv。

应然事件（callback 触发 → caller 落 audit）：

| 事件 type | 触发时机 | callback |
|---|---|---|
| `LLM_EMPTY_RESPONSE` | LLM 返回空 content | `onEmptyResponse` |
| `LLM_UNKNOWN_STOP_REASON` | stop_reason 不在白名单 | `onUnknownStopReason` |
| `LLM_RESET` | mid-stream provider failover | `onReset` |
| `LLM_PROVIDER_FAILED` | provider failover chunk | `onProviderFailed` |
| `LLM_UNPARSEABLE_TOOL_USE` | tool input 非法 JSON fallback | `onUnparseableToolUse` |

## 6. 层级声明

L3 agent 原语层（与 AgentExecutor / SubAgent 同层）。详见 [architecture.md](../architecture.md) 加 [interfaces/l3.md](../interfaces/l3.md)。

## 7. 应然 vs 实然差距登记（M#10 / M#11）

> 原则：本节只登记**实然 ≠ 应然**的 gap（待治理或已治理的历史）+ 偏差 + 历史纪律。当前实然若与应然 align 则不在此登记。

### 7.A 必修违规（含历史已闭环）

| §A 条 | 类型 | 状态 | 触发情境 |
|---|---|---|---|
| ~~A.1 LLM 错误 fallback 序列化丢失信息~~ | drift / 高 | **已闭环（phase236）** | 历史 LLM 错抛非 Error 对象时 fallback 输出 `[object Object]` 丢失 `code` / `errno` / `syscall` 字段。phase236 改 `Object.getOwnPropertyNames` 序列化 / 空对象输出 `{}` |
| A.invariant-1 safe-wrap 策略不可逆 anchor | anchor | 防 drift（合规）| I/O 边界回调（onBeforeLLMCall / onToolCall / onToolResult）try/catch warn 不抛 / 流内热路径（onTextDelta 等）裸调异常冒泡终止 step / 不可改为「全部裸调」或「全部包裹」/ 用作 reviewer 自检 |
| A.invariant-2 messages in-place 不可改为不可变 anchor | anchor | 防 drift（合规）| 调用方 own buffer / executeStep in-place 追加 / 改为返回新数组破坏调用方语义 / 用作 reviewer 自检 |
| ~~console.warn 作为 observability 下限~~ | drift | **✅ closed（phase306 + phase309）** | empty / unknown / mid-stream failover 三事件经 callback 落 audit |
| ~~console tag `[loop]` 不一致~~ | drift | **✅ closed（phase236）** | 改 `[step-executor]` 同步 react.test 断言 |
| ~~no_tool 降级无信号~~ | drift | **✅ closed（phase313）** | no_tool 分支 +1 console.warn |
| ~~B.idle-abort tool_use 已就绪 abort 跳过 executeToolCalls~~ | drift | **✅ closed（phase309）** | catch block stopReason guard 修复 |
| ~~phase333 13 helper 物理拆分宣称 vs 实然~~ | ~~drift / 低~~ | **✅ closed（phase385 / δ 释义豁免 / 0 代码 / 0 应然修订）** | **应然 contract 0 处宣称「13 文件物理拆分」** / phase333 self-report「13 helper」实指函数级 helper（react/step-executor.ts 单文件内 + 4 同层文件）/ 与实然 react/ 5 .ts 文件（abort-helpers/agent-executor/index/loop/step-executor）0 矛盾 / drift 登记本身是 phase333 over-claim 残留 / 释义豁免模板第 7 次复用 |
| ~~step-executor 8 console 协调（β 路径锁定 phase395）~~ | ~~drift / 中~~ | **✅ closed phase396**（main `3eeffad7`）| **β 路径落地**：StepCallbacks +1 `onUnparseableToolUse`（step-executor.ts:41）+ L165 改 fallback（同 L90/L110 phase306 模板）+ L382 改 callback-priority fallback（保留 `resetState→onReset` 顺序 / advisor 修订）/ loop.ts ReactOptions passthrough（L38/57/77）/ runtime-audit-events.ts NEW `LLM_UNPARSEABLE_TOOL_USE: 'llm_unparseable_tool_use'`（L16）/ runtime.ts L537-538 wiring（仅主路径 _runReact / chat path L762 不扩散 / 与 phase306 既有不扩散决策一致）/ 8 console 终态：4 fallback（L90/L110/L165 audit-接 + L382 业务 callback-接 onReset）+ 4 ⚓（L239/L244 safeCallback wrapper + L273/L586 ToolResult 透传）/ phase306 fallback 三件套 → 四件套延续 / observability 债偿还（D1d 弱观察 → 强观察）|
| **A.spec-1 应然 `interface StepExecutor { step(messages, params) }` ↔ 实然 `executeStep(input)` 自由函数** | spec drift / 大 | **closed**（phase414c L3 audit / interfaces/l3.md align 实然自由函数 + 12 细粒度回调 + 3 态 StepResult discriminated union）| 历史 interfaces 写应然 class-style `interface StepExecutor` + `step(messages, params)` 单 method / 实然 = `executeStep(input: StepInput): Promise<StepResult>` standalone 自由函数 / 0 类抽象 / 0 instance 概念 / StepInput rich type (10 字段) vs 应然 StepParams (5 字段) / StepResult 实然 3 态 discriminated union (`final`/`continue`/`max_tokens_tool_use`) vs 应然 simple `{messages, stopReason}` / StepCallbacks 12 细粒度 vs 应然 `onEvent` 单一 / phase414c interfaces/l3.md 修订 align 实然 + 删 StepEvent + StopReason union 应然幻象（实然分散在 StepResult 各 kind） |
| ~~A.location-1 模块物理位置 `src/core/react/`~~ | naming concern / 低 | **✅ closed（phase437 / main `42757245`）** | 应然 = StepExecutor + AgentExecutor 各独立 dir。phase437 实施 4 阶段同 commit：(1) mkdir 2 NEW dir + git mv 5 file（step-executor.ts + abort-helpers.ts → step-executor/ / agent-executor.ts + loop.ts → agent-executor/）+ rmdir react/ (2) NEW barrel × 2（@module L3.StepExecutor / L3.AgentExecutor）(3) 内部 cross-dir import 修（agent-executor → step-executor 路径）(4) 8 caller cascade（5 tests + **3 src 计划遗漏**：src/core/index.ts + runtime.ts + subagent/agent.ts / agent 实施期补修登 dev log）/ 0 行为改 / 1366 测试 PASS / **L3 应然 align 100%（StepExecutor + AgentExecutor + SubAgent 三模块各独立 dir）**/ 物理迁三模板复合 N+8 次 / abort-helpers 归 step-executor (M#5 单向 AE→SE) / loop.ts runReact shim 归 agent-executor 保留向后兼容 |
| **A.tool-input-parse-error-audit** | sweep / 中 | **✅ closed（phase 614 / main `59dd8515` / merge `54c81a77`）** | `core/step-executor/tool-execution.ts:174-180` `executeSingleTool` __parseError short-circuit 历史 0 audit / 既有 success path tool_exec audit 在 L2 IToolExecutor.execute 内（executor.ts:140-146）/ parseError 短路绕过 audit / phase 614 加 `tool_input_parse_failed` inline event + reason=parse_error + escapeForLog(__raw) 摘要 / 0 NEW const file 沿既有 inline 模式 / silent X cluster + audit_injection_alpha 模板 N+1 实证 / D2「不丢弃/静默」+ M#10「不合理停下」对齐 |

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| `__parseError` 双下划线惯例 | drift / 低 | ⚓ deviation-accepted（升档条件清晰 / 跨 StepExecutor → executeSingleTool / parallel 分支 → AgentExecutor 三次传递 / 以双下划线惯例区分用户工具参数 / 升档：工具生态出现 `__` 开头合法参数 → 改 Symbol 或 `#internal` 命名空间 / phase389 anchor 标记）|
| **L3.G1 (step-executor)** arch 表 2「tool_use 分组并行执行」interfaces 不显式提及 | **业务决策性 design-gap / r65 起 cross-doc audit 浮出**：arch 表 2 StepExecutor row 「单次 LLM 调用、tool_use 分组并行执行、messages 追加、max_tokens 截断修复、停止信号」5 能力 / interfaces/l3.md 暴露 executeStep + 12 callbacks + StepResult 三态 / 未显式提「tool_use 分组并行执行」（implicit via L2 IToolExecutor.executeParallel readonly 工具批量并发）/ 描述精度 derive 链不 explicit | **业务决策性 / 用户拍板候选**：α interfaces 注释加「tool_use 分组并行执行经 L2 IToolExecutor.executeParallel（readonly 工具批量并发）」/ β arch 表 2 改「单次 LLM 调用 + tool_use 派发（并行经 L2 Tools）」明示分工 / γ 保留现状（implicit derive 已合理）|

### 7.C 应然原则对照

> 仅列应然对各原则的承诺立场 / 不写「合规✓」claims。

**Module Logic Principles**

- M#1 独立可变职责：单步 LLM 调用 + tool_use 编排 / 与 AgentExecutor（跨步循环）/ Runtime（turn 语义）/ SubAgent（一次性 react）正交可变
- M#2 业务语义归属：LLM 调用 / tool_use 执行 / messages 追加 / max_tokens 修复 / context_window 识别 由本模块直接发起
- M#3 资源唯一归属：messages 是调用方传入的可变 buffer / 不持自有资源
- M#4 持久化：无关（落盘归 AgentExecutor）
- M#5 依赖单向：L3 → L2 (LLMOrchestrator / Tools) + L3 → L3 同层 (abort-helpers) / 不上引 L4+ / ToolResult 经 IToolExecutor 接口 transitive expose / 不算 ToolProtocol 直接 dep
- M#6 依赖结构稳定：StepInput 10 字段（含 llm + idleTimeoutMs）+ StepResult 4 kind 自 phase169+ 稳定 / 11 callbacks（含 phase306 +2）
- M#7 耦合界面稳定：StepResult discriminated union 扩展新 kind 不破 executeStep 签名 / StepCallbacks 扩展新可选回调不破旧消费者
- M#8 耦合界面最小：StepCallbacks 11 回调精选 / 无冗余 / 不直 inject AuditWriter（callback 透传）
- M#9 显式编译器可检：StepResult discriminated union + safe-wrap 策略表显式标哪些回调裸调 / 哪些包裹
- M#10 不合理停下：无吞错 / **8 console** 全部信息保留（结构化返回或 callback 透传）/ 实然终态详 §7.A「step-executor 8 console 协调」（4 fallback callback-priority + 4 ⚓ / phase395 derive + phase396 落地）
- M#11 边界对不上停下：发现 StepInput 字段需 L4 引用即停下重构（保持 L3 纯执行原语）

**Design Principles**

- D1a 信息不丢失：empty content / unknown stop_reason / tool_use 0 calls 全部降级到 final + extractText / context_window_exceeded 保留 thinking + text
- D1b 状态可观察：11 回调覆盖 LLM / tool / stream / reset / provider failed / empty / unknown 全链
- D1c 中断可恢复：signal abort 转 IdleTimeoutSignal / PriorityInboxInterrupt / UserInterrupt / phase309 catch block stopReason guard 完成已就绪 tool_use
- D1d 事后可审计：phase306 后 LLM_EMPTY_RESPONSE / LLM_UNKNOWN_STOP_REASON 落 audit / mid-stream failover 经 onReset
- D2 不丢弃 / 静默：**8 console** 全部结构化处理（4 fallback callback-priority + 4 ⚓ / phase396 β 路径落地 / 详 §7.A「step-executor 8 console 协调」）
- D3 用户可观察：onTextDelta / onThinkingDelta 流式暴露
- D4 LLM 调用恢复：mid-stream reset 清状态 + onReset 回调 / provider_failed chunk 经 onProviderFailed 暴露
- D5 日志重建：phase306 落 audit 后可重建 step-level 异常事件
- D6 子代理后不阻塞：N/A（StepExecutor 仅单步原语 / 不发起子代理 / LLM 决策经 stream stop_reason 分支回到本模块 / 决策主体语义透 LLM 上层）
- D7 系统可信路径：ToolExecutor 校验 signal / readonly+sync 并行优化有 __parseError 过滤保护
- D8 事件驱动：stream chunk switch 即事件驱动
- D9 CLI 唯一外部入口：N/A（本模块 L3 内部原语 / 0 外部入口）
- D10 多 claw 不隔绝：N/A（本模块单步执行 / 0 跨 claw 语义）
- D11 motion 特殊：N/A（本模块单步执行 / 0 motion 边界 / identity 透传归 caller）

**Philosophy**

- P1 Agent 即目录：messages in-place 演化即对话状态 / 落 agent dir 归 AgentExecutor / SubAgent
- P2 上下文工程：executeStep 把 messages + systemPrompt + tools 上下文送入 LLM 并演化一步
- P3 分多个智能体加分子任务：单一代码基无 identity 分支 / 多 agent 复用同代码基
- P4 系统为智能体服务：StepExecutor 提供单步执行原语 / 不参与决策

**Path Principles（7 条）**

- **Path #1 路径规划基于规划时刻的事实**：审计期 framing 必先 grep 实然（phase333 13 helper 物理拆分宣称 13→5 helper 实测 / 注意实施过程中实然的变化）
- **Path #2 实然和应然差距显式登记**：违规明文上墙（在路径规划时参考 / §7.A + §7.B）
- **Path #3 语义原子变更单元**：APPEND-only §7 不解构既有节 / 1 phase = 1 commit 原子
- **Path #4 可回滚 + 破坏性论证**：API 改动 caller 评估 / 破坏性改动显式论证（反向测试：本模块可独立替换 LLMOrchestrator / IToolExecutor 实现而不动 AgentExecutor caller —— M#1 ✓）
- **Path #5 完成后复盘**：phase 收尾三维 + Path Principles 第 4 维对账
- **Path #6 冲突立即中断**：scope 模糊或决策点必停报告（冲突调整优先于强行推进）
- **Path #7 总难度路径**：实然到达应然有诸多路径 / 选择降低总难度的（步骤间有相互作用 / 总难度 ≠ 各步骤成本简单相加）

### 7.D 历史纪律

- 2026-04-21 / phase181 L3 step_executor 契约 backfill（§7 四子节 + §8 / 0 §7.A 清零 + 4 §7.B）
- 2026-04-22 / phase236 §7.A A.1 清零（LLM error fallback `Object.getOwnPropertyNames` / 顺手 console tag `[loop]` 不一致 清）
- 2026-04-25 / phase302 no_tool 降级无信号 路径警告 + throwAbortError 函数迁 abort-helpers.ts
- 2026-04-25 / phase306 console.warn 作为 observability 下限 部分消化（onEmptyResponse / onUnknownStopReason 可选回调 + Runtime 接线落 audit）
- 2026-04-25 / phase309 console.warn 作为 observability 下限 关闭 + B.idle-abort 修复（catch block stopReason guard）
- 2026-04-25 / phase313 no_tool 降级无信号 清零（no_tool 分支 +1 warn）
- 2026-04-25 / phase317 契约 drift 修订（假 SHA 修正）
- 2026-04-26 / phase325 应然 framing drift 修订（§14→§16 / r32 D 已修）
- 2026-04-26 / phase333 StepExecutor 函数拆分 + 测试补齐（M#5 内部重构 / 测试码比 0.61→≥1.0 / fidelity 主题第 2 轮）
- 2026-04-29 / phase395 跨模块 console.warn 协调 design（agent-executor「跨模块 step-executor console.warn 协调」framing 错位修订 + step-executor 8 console NEW 实然分类 + M#10/D2 6 → 8 同步 / β 路径锁定推 r55+ / advisor 主会话自评豁免三件齐 / design only / 0 commit）
- 2026-05-01 / phase396 step-executor 8 console 协调 β 路径落地（StepCallbacks +1 onUnparseableToolUse + L165 fallback + L382 callback-priority fallback / loop.ts passthrough + runtime.ts L537 wiring + LLM_UNPARSEABLE_TOOL_USE NEW const / advisor 三点修订 L382 顺序+行为契约描述+L762 不扩散 / phase306 fallback 三→四件套延续 / agent-executor framing 错位修订-实施联动闭环 / main `3eeffad7`）
- 2026-05-01 / phase408 context_window_exceeded 路径迁离（删 step-executor.ts:103 识别 + StepResult union 缩 / 由 service 层 own / l2_llm_orchestrator §7.A A.6 闭环 / 治理副产品 dead 必清 / main `c1fca6ca`）
- r60+ 重编号：9 节 → 8 节，每节 derive 自一条 Module Logic Principle（删原 §2 接口 / §5 上游依赖 / §6 不可消除耦合 → 已并入 interfaces/l3.md / 拆原 §1 所有权 hub 为 §1 职责 + §2 业务语义 + §3 资源 + §4 持久化 / 删原 §7 内部不变式 杂物筐 → 行为级回 §1.做、anchor 性质回 §7.A）
- 2026-05-04 / cross-doc audit drift 修订（§7.C P3 verbatim「分多个智能体加分子任务」/ Design Principles D6 合并 D6a+D6b + 加 D9/D10/D11 N/A 标 align principles.md / §3 资源改 table 「无」+ 注脚 align 其他模块）
- 2026-05-04 / phase437 模块物理位置拆出（main `42757245`）/ L3 react/ → step-executor/ + agent-executor/ 双 dir / git mv 5 file（step-executor.ts + abort-helpers.ts → step-executor/ / agent-executor.ts + loop.ts → agent-executor/）+ rmdir react/ / NEW barrel × 2（@module L3.StepExecutor / L3.AgentExecutor）+ 内部 cross-dir import 修 + 8 caller cascade（5 tests + 3 src 计划遗漏自补）/ **L3 应然 align 100%（StepExecutor + AgentExecutor + SubAgent 三模块各独立 dir）** / 物理迁三模板复合 N+8 次 / abort-helpers 归 step-executor (M#5 单向 AE→SE) / loop.ts runReact shim 归 agent-executor 保留向后兼容
- 2026-05-05 / r65 cross-doc audit 单 doc 一致性核（modules/l3_step_executor.md vs arch §18 + 表 1/2 + interfaces/l3.md StepExecutor 节）/ 0 derive drift / 主 derive 全 align（M#1-M#11 + Design Principle D1a-d + D2/D3/D4/D5/D7/D8 + D6/D9/D10/D11 N/A + Philosophy P1-P4 + Path #1-#7）/ 5 主能力 align arch 表 2（单次 LLM 调用 + tool_use 分组并行执行 + messages 追加 + max_tokens 截断修复 + 停止信号）/ 2 dep + caller AgentExecutor align arch 表 1 / phase236+306+309+313+333+395+396+408+414c+437 多 phase 接力清零稳态保留 / L3.G1 (step-executor) tool_use 分组并行执行 interfaces 不显式 design-gap 已登记 §B（业务决策性 α/β/γ 候选）/ design only / 0 src 改
- 2026-05-05 / **phase 491 step-executor.ts 完整 6 sub-file 拆分**（main `efb26059` / merge `15609d54`）/ step-executor.ts 630 → 100 行（净 -530 / 净瘦 84%）/ +6 NEW sub-file（types.ts 57 + utils.ts 71 + stream.ts 171 + tool-execution.ts 196 + stop-handlers.ts 91 / 总 586 行 NEW）/ 全 functional / 0 class / 0 闭包 / 0 状态切割 / step-executor/index.ts barrel re-export type 路径 from ./types.js / 5 caller 经 barrel 0 改（src/core/index.ts:11 + agent-executor.ts:13+14 + loop.ts:15 + 3 tests）/ 1370 tests + 3 step-executor 相关 tests PASS / 0 行为差 / 7 files +603 -547 / **「模块内重构形态分类」A 激进式 functional 子形态首发**（A.1 backend 服务 phase 480 + A.2 CLI dispatch phase 486 + **A.3 functional phase 491 / 最安全的 A 形态**）/ N=5 实证 + A 形态 3 子分类（决策判据：state + sub-concern + ctx 注入需求 3 维度区分）/ 拓扑严格单向 types ← utils ← stream + tool-execution ← stop-handlers ← step-executor / 0 import 循环 / 推 r+ Meta **必硬化**独立 feedback「模块内重构 4 形态完整分类（A.1/A.2/A.3/B/C）」
- 2026-05-10 / **phase 614 step-executor parseError audit**（r74 F fork / main `59dd8515` / merge `54c81a77`）/ `tool-execution.ts:174-180` __parseError short-circuit 加 audit `tool_input_parse_failed` + reason=parse_error + escapeForLog(__raw) 摘要 / 1 src + 1 NEW test（`tests/core/step-executor/tool-input-parse-error-audit.test.ts`）/ 0 NEW const file 沿既有 inline 模式 / §A.tool-input-parse-error-audit closed by phase 614 / silent X cluster + audit_injection_alpha 模板 N+1 实证（同 phase 614 l2_tools §A.async-path-silent-rejection-audit + §B.8 同 fork 双闭环）

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| KD#4 | StepExecutor 只跑一步 / 循环归 AgentExecutor / 每步之间落盘 | ✓ |
| KD#1 | 工具 handler 装配期注入 StepExecutor | ✓ / 详 l2_tools.md §7.D 主登记 |

## 8. 测试覆盖

应然行为（不绑定具体测试文件路径）：

- **kind: 'final'**：end_turn 纯文本 / tool_use 但 0 tool 降级 no_tool / max_tokens 无 tool_use 截断 / unknown 降级
- **kind: 'continue'**：tool_use 成功执行 / appendAssistantMessage / executeToolCalls / appendToolResults / StepMeta 返回
- **kind: 'max_tokens_tool_use'**：每个 tool_use 补 `[TRUNCATED]` tool_result（is_error=true）
- **kind: 'context_window_exceeded'**：保留 thinking + text / 过滤 tool_use 防孤儿 assistant
- **signal abort 三阶段**：LLM 调用前 / stream 中（每 chunk）/ 工具执行后 / Provider Error('Execution aborted') 经 signal.reason 重派生信号类
- **safe-wrap 策略**：I/O 边界（onBeforeLLMCall / onToolCall / onToolResult）try/catch warn 不抛 / 流内热路径裸调异常冒泡终止 step
- **parse error 元数据链**：tool input 非法 JSON → `{ __parseError: true, __raw }` → ToolResult.metadata.parseError=true → StepMeta.parseErrorCount++ / parallel 分支 __parseError 过滤防元数据泄漏
- **readonly+sync 并行 vs 串行三分组**：readonly+sync 并行 / readonly+async 串行 / write 串行
- **observability 回调回链**：onEmptyResponse / onUnknownStopReason / onReset / onProviderFailed 触发时机 + 载荷断言
- **phase309 idle-abort 修复**：tool_use 已就绪时 abort 仍完成 executeToolCalls 后再抛 abort 信号
