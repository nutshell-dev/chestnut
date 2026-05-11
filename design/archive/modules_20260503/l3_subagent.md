# SubAgent 模块内部契约

> 本文档限本模块**内部**应然 — 8 节结构 derive 自 Module Logic Principles：§1-§4 = M#1-#4 各占一节，§5 审计 = M#3 命名空间细则，§6 层级，§7 drift = M#10/#11，§8 测试。
> 跨模块对外承诺（接口签名、生产/消费方、归本模块加不归本模块、不可消除耦合理由）见 [interfaces/l3.md](../interfaces/l3.md) SubAgent 节。
> 模块本质加层归属见 [architecture.md](../architecture.md)。

## 1. 职责（M#1 独立可变职责）

> 本节内容 derive 自 [architecture.md](../architecture.md) §20「SubAgent 本质：sub-agent 实例化加生命周期管理的原语 / 持『sub-agent』业务语义 / L3 agent 原语 ——『子代理』」加 M#1 / M#2 / M#3 / M#5 / Philosophy「分多个智能体加分子任务」加 Design Principle「创建子代理后不阻塞，结果异步返回」。

### 做

应用 M#1（一个模块封装一组独立可变的职责），SubAgent 的单一职责 = **sub-agent 实例化加单实例生命周期管理的原语 / one-shot 模式**：

- **sub-agent 实例化加生命周期编排**：构造独立 dialog instance / 跑一次完整 AgentExecutor 循环 / 触发生命周期 events 加超时约束加父子上下文继承 — 这是「派一个 sub-agent 替我做事」的最小封装。
- **生命周期 events 必经 audit**：started / stopped / failed 等事件经必选 writer 留痕（M#9 编译期强制 derive — Noop 显式降级而非 optional 静默）。
- **父代理上下文继承**：messages 加 systemPrompt 加 callerType 透传父代理快照 — 让 sub-agent 在父代理上下文基础上工作。
- **失败分类**：超时 → turn_interrupted + rethrow / LLM / tool 异常 → turn_error + rethrow / non-fatal catch 走 audit 不 rethrow（D「不丢弃 / 静默」derive — 失败显式归类不静默）。
- **one-shot 模式**：单次 run 跑完即结束 / 实例不可复用（与长期循环 motion / claw 主代理区分 / M#1 derive）。

> 具体 API 形态归 [interfaces/l3.md](../interfaces/l3.md) SubAgent 节。具体实现细节（5 持久化文件加 10 类事件类型加 createSubAgent 工厂加 ensureDir resultDir 等）的存在依据是「sub-agent 实例化加生命周期管理」原语 — 实然采纳的细节差异登记 §7.B。

### 不做

- **不 own 跨 sub-agent 调度加任务队列**（pending / running 状态机加 cascade abort 加 result 投回归 L4 TaskSystem）— derive 自 M#1 独立可变职责
- **不 own 长期循环**（motion / claw 主代理事件循环归 L5 Runtime）— derive 自 M#1 + M#2
- **不 own 循环算法本身**（反复跑单步加停止判定归 L3 AgentExecutor / 本模块内部调用）— derive 自 M#1
- **不 own 单步执行**（LLM 调用加 tool 派发归 L3 StepExecutor / 透过 AgentExecutor 间接）— derive 自 M#1
- **不 own system prompt 构造**（调用方提供 systemPrompt / 怎么构造（直接写加从 skill 加载加用模板）归 caller 业务）— derive 自 M#2
- **不 own tools 子集装配**（调用方提供 tools instance / SubAgent 不挑）— derive 自 M#2
- **不 own crash recovery**（恢复机制归 L4 TaskSystem）— derive 自 M#1 + M#4
- **不 own spawn / dispatch / ask_motion 业务工具**（业务语义归 L4 TaskSystem / KD#29）— derive 自 M#1 + M#2

## 2. 业务语义（M#2 业务语义归属）

> 应用 M#2（模块为自己的业务语义负责），SubAgent 的业务语义边界：

- **own**：sub-agent 单实例生命周期概念 — 实例化 / 生命周期 events / 超时约束 / 父子关系 / 父代理上下文快照继承 / 生命周期事件审计。这些是 SubAgent 唯一懂的「业务」（sub-agent 单实例级 / 与跨 sub-agent 调度区分）。
- **角色定位**：SubAgent 是「**sub-agent 单实例编排器**」非「**任务调度器**」。one-shot 跑一次 / 跨实例编排归 L4 TaskSystem。
- **派生自 modules.md KD#5 废止教训**：执行原语 vs 生命周期管理 = 独立可变职责（不合并 / 跟 TaskSystem 拆开）。

## 3. 资源（M#3 资源唯一归属）

> 应用 M#3（每种资源只归属唯一模块），SubAgent 独占的资源：

- **sub-agent 单实例生命周期管理入口**：clawforum 内部 sub-agent 实例化加单实例运行必经 SubAgent — 是 clawforum 对「派一个 sub-agent 跑一次」的唯一调用入口。
- **运行期句柄**：执行期消费调用方提供的 input（prompt / messages / tools）+ output channel（stream / audit writer）。
- **写入区**：调用方注入的 `resultDir` 完整路径 / 本模块 0 知具体字符串约定（如 `tasks/results/<id>/`）/ 该 dir 归属归 caller（L4 TaskSystem own / SubAgent 仅是写入方）。

## 4. 持久化（M#4）

> 应用 M#4（持久化一切信息到磁盘 / 运行时句柄从磁盘信息重建），SubAgent 持久化 sub-agent 单实例的执行轨迹（4 文件）— 让事后可审计加重启可恢复 sub-agent 状态成为可能。

### 磁盘布局

caller 注入的 `<resultDir>/`（本模块 0 知字符串约定 / 路径计算归 caller / 典型为 `<clawDir>/tasks/results/<agentId>/`）：

```
<resultDir>/
├── stream.jsonl          ← turn_* / llm_* / tool_result delta（经 L2 StreamLog 写）
├── audit.tsv             ← 同上事件 audit 落盘（经 L2 AuditWriter 写）
├── steps.jsonl           ← onStepComplete 步数轨迹（经 L2 StreamLog 写）
├── messages.json         ← messages 数组持久化（经 L2 DialogStore 接口 / 实例终止后供恢复）
└── daemon.log            ← raw text log（execution narrative / 与结构化 stream.jsonl 不同业务）
```

### 文件格式

- `stream.jsonl`：每行 `{ ts, type, ...payload }`
- `audit.tsv`：tab 分隔 `<ts>\t<type>\t<args>`
- `steps.jsonl`：每行 react step 摘要
- `messages.json`：完整 Message[] 数组（DialogStore 持久化形态）
- `daemon.log`：raw text 累加（经 L1 FileSystem.append 写 / 因 raw narrative 不 structured 不适合 DialogStore/StreamLog）

### 重建语义

SubAgent 自身不恢复（一次性消费）。任务恢复归 L4 TaskSystem 状态机管理。SubAgent 仅保证写入原子（messages 经 DialogStore / 事件经 StreamLog / audit 经 AuditWriter / daemon.log 经 fs.append 各自原子）。

## 5. 审计事件清单

> 事件常量集中定义于 `SUBAGENT_AUDIT_EVENTS`（模块自治 / caller 引用 const 不硬编码字符串）。

| 事件 type | 触发时机 | 载荷 |
|---|---|---|
| `turn_start` | run 进入 try 外（保证 catch 配对）| 无 |
| `turn_end` | runReact 成功 / finally 兜底 | 无 |
| `turn_interrupted` | 捕获 `ToolTimeoutError` | `reason=system` audit / `message=Timeout after {ms}ms` stream |
| `turn_error` | 捕获其他异常 | `err={message}` |
| `llm_call` | `onLLMResult` 成功 | `model={...} in={tokens} out={tokens} ms={latency}`（仅 audit）|
| `llm_error` | `onLLMResult` 失败 | `model={...} err={...} ms={latency}`（仅 audit）|
| `tool_result` | `streamCallbacks.onToolResult` | `name={name} {toolUseId} {ok\|err} summary={oneLine}` |
| `subagent_step_complete_failed` | `onStepComplete` non-fatal catch | `agentId={id} error={msg}` |
| `subagent_persist_failed` | `persistMessages` non-fatal catch | `agentId={id} error={msg}` |
| `subagent_log_append_failed` | `appendToLog` non-fatal catch | `agentId={id} error={msg}` |

## 6. 层级声明

L3 agent 原语层（与 StepExecutor / AgentExecutor 同层）。详见 [architecture.md](../architecture.md) 加 [interfaces/l3.md](../interfaces/l3.md)。

## 7. 应然 vs 实然差距登记（M#10 / M#11）

> 原则：本节只登记**实然 ≠ 应然**的 gap（待治理或已治理的历史）+ 偏差 + 历史纪律。当前实然若与应然 align 则不在此登记。

### 7.A 必修违规（含历史已闭环）

| §A 条 | 类型 | 状态 | 触发情境 |
|---|---|---|---|
| ~~A.1 writer optional 时 8 类事件静默丢失~~ | drift / 高 | **已闭环（phase283）** | `taskStreamWriter` / `auditWriter` 改必选 / `?.write` 短路全部消除 / Noop 显式降级 / `auditWriter` 类型 `AuditWriter` → `Audit` 接口（M#8）|
| ~~A.M5-leak SubAgentOptions 含 L4 引用~~ | drift / 高 | **已闭环（phase353 / 实然 0 违规）** | 历史登记声称 `taskSystem` / `contractManager` / `outboxWriter` 含 L4 references。phase353 r47 C Path #1 实测：`taskSystem?` 实为 `import type TaskScheduler` from `core/tools/task-scheduler.ts`（L3 Tools port / structural typing）/ `contractManager?` `outboxWriter?` agent.ts grep 0 ref（phase229+phase283 已清）/ `agentId` `originClawId` 是 identifier strings 不构成依赖。**实然 0 真违规**。dispatch table 描述脱节 N+3 实证 |
| A.invariant-1 实例一次性消费不可复用 anchor | anchor | 防 drift（合规）| 单次 run / 第二次 run 行为未定义 / 不可改为「实例可复用 / 多次 run」/ 用作 reviewer 自检 |
| A.invariant-2 writer 必选编译期强制 anchor | anchor | 防 drift（合规）| `taskStreamWriter` / `auditWriter` 必选（M#9）/ 不可退化为 optional / 装配方未提供必注 Noop 显式降级 / 用作 reviewer 自检 |
| ~~KD#29 spawn/dispatch/ask_motion 业务语义归属~~ | drift | **✅ closed（phase347 + 后续 / 实然 0 残留）** | 应然：三工具业务语义归 TaskSystem(L4)。实然 4 文件（spawn.ts / dispatch.ts / ask-motion.ts / _pending-task-writer.ts）全迁至 `src/core/task/tools/` / `src/core/tools/builtins/` 0 残留 / 完成度比契约预期更完整。dispatch table 描述脱节 N+4 实证（fork agent 报告 implementation > contract claim）|
| ~~`audit?` field 短路残留~~ | drift | **✅ closed（phase366 / main `2f0548a`）** | module-level `audit?: AuditWriter` field 仍 optional / agent.ts 3 处 `this.audit?.write(...)` 短路 → phase366 audit field 必选化 + Noop 注入 / 3 处 `?.` 删（onStepComplete / persistMessages / appendToLog）/ D1 信息不丢失 / phase283 同型治理模板复用 |
| ~~契约行号引用策略~~ | drift | **✅ closed（phase372 / 真治理 + 释义豁免双轨）** | 历史契约引用具体行号 / 代码移位后 drift → Path #1 实测：历史举例 `task/system.ts:573` 已自然清理 / 18 处合规 path:linenum（12 backtick drift 描述 + 3 non-backtick drift / 3 OK changelog/历史）/ **真违规 4 行 5 refs 在 `l6_daemon.md:167-174` §3 console 清单 spec body**（行号实测全 stale）/ phase372 已治（method/symbol 名 + grep 指令）+ design/modules.md 末尾立「契约文档实践规范」footnote / **释义豁免模板第 6 次复用** |
| ~~turn-interrupted 错误信息误导性~~ | drift | **✅ closed（phase371）** | `turn_interrupted` 事件 `agent.ts` 固定显示 `Timeout after ${this.timeoutMs}ms` / 不区分实际中断原因 → phase371 makeExternalAbortError reason 结构化（`{ type: string; ms?: number }`）+ agent.ts message 区分四类（user_abort / idle_timeout / priority_inbox / signal）/ D1+D6 双原则 derive |
| **A.spec-1 应然 `interface SubAgent { run(input): Promise<SubAgentResult> }` rich types ↔ 实然 `class SubAgent` ctor 注入 + `run(): Promise<string>`** | spec drift / 大 | **closed**（phase414c L3 audit / interfaces/l3.md align 实然 class + ctor + 0 args run + return string）| 历史 interfaces 写应然 `interface SubAgent` + `run(input: SubAgentInput): SubAgentResult` rich types (SubAgentInput / SubAgentResult / SubAgentTimeouts / SubAgentIdentity / SubAgentTimeoutError 5 应然幻象 type) / 实然 = `class SubAgent` ctor 注入大 SubAgentOptions (15+ 字段) / `run()` 0 args 返 `Promise<string>` final text only / 应然 5 应然幻象 type 实然 0 实施 (timeout 走 AbortController + audit events / 不抛 SubAgentTimeoutError 类) / phase414c interfaces/l3.md 修订 align 实然 class + ctor 注入 + 0 args run + 返 string + 加 createSubAgent factory + NoopStreamWriter/NoopAuditWriter helper / 删 5 应然幻象 type |
| **A.r60+1 messages.json 直接 fs.writeAtomic 绕 DialogStore L2** | drift / 高 | open / 推 r61+ code phase（应然已 sharpen 2026-05-03）| **应然已 align 真合规立场**：§3/§4/§M#5 已修订 — messages.json 应经 DialogStore L2 接口写 / SubAgent dep DialogStore / caller 装配期注入 ephemeral DialogStore（baseDir=resultDir / filename=messages.json）。**实然 drift**：`agent.ts:324` `fs.writeAtomic(messages.json)` 直接 fs 写 / 违 M#3 + M#5 / 推 r61+ code phase 落地 caller 装配 + SubAgent 改调 `dialogStore.save(messages)`。源：r60+ user 戳「messages 资源有模块归属的吧」 |
| **A.r60+2 路径硬编码 `tasks/results/${agentId}/` 字符串约定耦合** | drift / 中 | open / 推 r61+ code phase（应然已 sharpen 2026-05-03）| **应然已 align 真合规立场**：§3 已修订「**写入区**：caller 注入的 `resultDir` 完整路径 / 本模块 0 知字符串约定」/ §4 磁盘布局 path placeholder 改 `<resultDir>/`。**实然 drift**：`agent.ts:91/171/181/295/324/391` 自构 `tasks/results/<agentId>/` 字符串硬编码 / 违 M#3 + M#9 / 推 r61+ code phase 落地 caller 注入完整 resultDir + SubAgent 删字符串拼接。源：r60+ SubAgent FileSystem dep 反思 |
| ~~A.r60+3 daemon.log raw text 应然 §4 不承认~~ | drift / 中 | **✅ closed 2026-05-03**（应然 §4 加 daemon.log 第 5 文件 + 业务定位「raw text narrative / 不 structured」/ §M#5 显式 dep L1 FileSystem 仅供 daemon.log raw append）| 选 (a) 路径：raw text log 与 structured stream/audit 业务不同 / DialogStore/StreamLog 不适合 / fs.append 直写是合理设计 / 应然层补承认 5 文件 + dep L1 显式化。源：r60+ SubAgent fs 4 处用法分类 |
| ~~A.r60+4 arch 表 1 vs module §M#5 内部 inconsistent（DialogStore dep 一方有一方无）~~ | drift / 中 | **✅ partial closed 2026-05-03**（应然层 align：§M#5 已补 DialogStore dep / 与 arch 表 1 一致 / 实然 src 0 DialogStore import 待 r61+ A.r60+1 code phase 落地后三方 align）| 应然层内部矛盾已消除（§M#5 补 DialogStore）/ 剩余三方 align gap 由 A.r60+1 实施期清。源：r60+ user 戳穿 |

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| B.1 SubAgent 双实例化路径 | drift / 中 | `createSubAgent` / `new SubAgent` 全仓 2 处：`src/core/task/subagent-executor.ts:102`（TaskSystem 主路径 / 正向 L4→L3）+ `src/core/contract/verifier-scheduler.ts:73`（ContractManager 验收路径 / L4→L3 但走第二实例化路径）/ 应然所有实例化经 L4 TaskSystem 统一管理 / 偏差理由：LLM 验收需同步 finalText / TaskSystem 当前仅异步结果（resultHandler）。升档：TaskSystem 加同步执行接口 / 或 ContractManager 改走 TaskSystem + resultHandler |
| B.3 物理位置分散 / 无统一逻辑门面 | design-gap / 低 | `src/core/subagent/index.ts` 仅 re-export class + factory / 三工具物理在 `src/core/task/tools/`（已迁 / 归 TaskSystem 模块树）/ 应然：概念聚合模块逻辑门面（不强制搬物理位置）。升档条件：若多 caller 反复 import 散点导致维护成本 → 评估 `src/core/subagent/index.ts` 加 logic-facade re-export |
| dispatch `addTaskResultHandler` callback 订阅 | drift / 低 | dispatch 工具仍调 `ctx.taskScheduler.addTaskResultHandler` 注册 callback / phase163 调度路径已消除 / 残留 callback 订阅 / handler 文件化推后独立 phase |

### 7.C 应然原则对照

> 仅列应然对各原则的承诺立场 / 不写「合规✓」claims。

**Module Logic Principles**

- M#1 独立可变职责：执行原语 vs 生命周期管理 = 独立可变职责（KD#5 废止教训 / phase173 SubAgent 下移 L3）
- M#2 业务语义归属：「一次性 ReAct 循环」业务点归本模块；spawn/dispatch/ask_motion 业务语义归 TaskSystem(L4)（KD#29）
- M#3 资源唯一归属：tasks/ 目录归 TaskSystem；本模块仅写入调用方注入路径
- M#4 持久化：stream.jsonl + audit.tsv + steps.jsonl + messages.json + daemon.log（5 文件）持久化执行轨迹 / 写入区路径由 caller 注入 resultDir
- M#5 依赖单向：L3 → L1 (FileSystem — 仅 daemon.log raw text append) + L2 (DialogStore / AuditLog / StreamLog / Tools) + L3 同层 (AgentExecutor — runReact 一次性 ReAct 循环)（per arch §20 表 1）/ LLM 调用经 AgentExecutor → StepExecutor → LLMOrchestrator transitive chain / SubAgent 不直接 dep LLMOrchestrator / 0 上引 L4+ / 0 TaskScheduler dep（**SubAgent 同步循环 0 知 TaskSystem / 异步调度归 caller 经 dispatch/spawn 工具 TaskSystem own + Assembly 装配注入 SubAgent.tools**）
- M#6 依赖结构稳定：构造期 options 固化 / 运行期不变
- M#7 耦合界面稳定：SubAgent class + createSubAgent 工厂 + SubAgentOptions interface
- M#8 耦合界面最小：跨边界传必要 options / `auditWriter: Audit` 接口（不暴露 AuditWriter class 内部）
- M#9 显式编译器可检：所有签名 type-only / writer 必选编译期强制 / NoopWriter implements 接口校验
- M#10 不合理停下：超时 / LLM 错 rethrow / non-fatal catch 走 audit 不 rethrow
- M#11 边界对不上停下：发现 SubAgentOptions 字段含 L4 引用即停下重构（phase353 / Path #1 实测推翻 framing）

**Design Principles**

- D1a 信息不丢失：phase283 writer 必选 / 8 类事件不静默丢失
- D1b 状态可观察：8 事件覆盖完整生命周期 / stream.jsonl delta 粒度
- D1c 中断可恢复：caller 注入 resultDir 写入原子 / messages.json 经 DialogStore writeAtomic 兜底（恢复主体在 L4 TaskSystem）
- D1d 事后可审计：phase283 writer 必选保证全链可审
- D2 不丢弃 / 静默：phase283 A.1 消化 / 3 个 non-fatal catch 走 audit 合规
- D3 用户可观察：stream.jsonl 可被上层 stream consumer 实时查看
- D5 日志重建：3 层日志 + messages.json + daemon.log 进程重启可重建子代理执行轨迹
- D6a 决策主体：子代理本身是执行原语 / 决策权在父代理（prompt / tools / systemPrompt 传递）
- D6b 子代理不阻塞：SubAgent 是 TaskSystem 实现 D6b 的同步执行原语 / 异步性归 caller (L4 TaskSystem) / SubAgent.run() 自身 sync 等待 finalText 返回
- D8 事件驱动：SubAgent 经 runReact 消费 LLM 工具调用事件
- D9 多 claw 不隔绝：经 caller (TaskSystem) 装配注入的 AskMotionTool 间接服务 D9 / 本模块不 own AskMotionTool（KD#29 已迁 TaskSystem）
- D10 motion 特殊：经 caller 装配注入的 AskMotionTool + motionContext 间接服务 D10 / 本模块不 own

**Philosophy**

- P1 Agent 即目录：caller 注入的 resultDir 目录持久化子代理状态
- P2 上下文工程：messages + prompt + systemPrompt + callerType 四维传递父代理上下文快照
- P3 多智能体加分子任务：**核心驱动原则**（SubAgent 是「派一个 sub-agent 替我做事」的最小封装 / 高效利用上下文窗口）/ SubAgent 单实现服务全 claw / motion 场景 / callerType 决 profile
- P4 系统为智能体服务：提供子代理实例化 + 生命周期管理 + 上下文继承基础设施

**Path Principles**

- Path #1 实然为唯一基准：审计期 framing 必先 grep 实然（phase353 推翻 dispatch table 描述）
- Path #3 语义最小变更单元：APPEND-only §7 不解构既有节
- 反向测试：本模块可独立替换 LLMOrchestrator / Tools 实现而不动 TaskSystem caller —— M#1 ✓

### 7.D 历史纪律

- 2026-04-21 / phase173 SubAgent 从 L4 SubagentSystem 下移 L3（KD#5 废止 / 执行原语 vs 生命周期管理拆分）
- 2026-04-20 / phase163 SubagentSystem ↔ TaskSystem 运行时循环消除（writePendingSubagentTaskFile 文件直写 / scheduleSubAgentWithTracking helper 删）
- 2026-04-22 / phase201 §9 物理编号 APPEND backfill（工厂未实装 / 契约行号引用策略 drift）
- 2026-04-22 / phase229 createSubAgent thin proxy 工厂实装 + 2 消费方切换（D.1 D.2 解阻塞）
- 2026-04-23 / KD#29 spawn/dispatch/ask_motion 业务语义归 TaskSystem
- 2026-04-24 / phase247 三 non-fatal catch 由 monitor.error 迁至 audit?.write
- 2026-04-24 / phase252 monitor 字段保留 SubAgent 透传 消化（ToolExecutorOptions +auditWriter 透传）
- 2026-04-25 / phase283 §7.A A.1 清零（writer 必选 + Noop 显式降级 + auditWriter 类型 Audit 接口收窄）
- 2026-04-27 / phase347 KD#29 子任务 b+c dispatch 物理迁 + profiles 类型化（spawn/dispatch/ask-motion/_pending-task-writer 4 文件全迁 `src/core/task/tools/` / `src/core/tools/builtins/` 0 残留 / fork agent r48 复核确认）
- 2026-04-27 / phase353 §7.A.M5-leak 100% 推翻（实然 0 违规 / dispatch table N+3 实证）
- r60+ 重编号：9 节 → 8 节，每节 derive 自一条 Module Logic Principle（删原 §2 接口 / §5 上游依赖 / §6 不可消除耦合 → 已并入 interfaces/l3.md / 拆原 §1 所有权 hub 为 §1 职责 + §2 业务语义 + §3 资源 + §4 持久化 / 删原 §7 内部不变式 杂物筐 → 行为级回 §1.做、anchor 性质回 §7.A）

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| KD#5（已废止）| ~~SubagentSystem 合并 TaskRunner~~ | 废止 / 执行原语 vs 生命周期管理拆分 / SubAgent 下移 L3 |
| KD#27 | Tools 声明式归属 | SubAgent 不导出业务工具 / spawn/dispatch/ask_motion 归 TaskSystem |
| KD#29 | spawn / dispatch / ask_motion 业务语义归 TaskSystem(L4)| **全闭环（phase347 + 续 / 4 文件全迁 task/tools/）** / 业务语义归属 已闭环 |

## 8. 测试覆盖

应然行为（不绑定具体测试文件路径）：

- 成功路径：runReact 完成 / turn_end 写 / persistMessages writeAtomic 落盘 / 返回 finalText
- 总超时 / idle 超时：ToolTimeoutError 捕获 → turn_interrupted 写 + rethrow
- LLM / tool 异常：catch → turn_error 写 + rethrow
- non-fatal catch（onStepComplete / persistMessages / appendToLog）：audit?.write 写 / 不 rethrow / run 仍完成
- 父代理上下文继承：messages 提供时 prompt 以 user 消息追加在末尾
- writer 必选：未注入时编译期失败（M#9）/ Noop 注入显式降级
- 8 类审计事件回链：每个事件触发时机 + 载荷断言
- onIdleTimeout 回调触发（ContractManager 验收路径用）
> AskMotionTool / DispatchTool / spawnTool 测试归 l4_task_system.md §8（KD#29 三工具业务语义已迁 TaskSystem L4 / 本模块不再覆盖）。
