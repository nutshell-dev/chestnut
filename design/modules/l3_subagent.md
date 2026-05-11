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
- **OS 资源访问权限继承**（per Design Principle「智能体创建的临时子代理完全继承调用方的OS资源访问权限」/ 2026-05-07 加 / 2 轮 src 实测核 align）：实然边界按**执行路径**分类（非「智能体 vs 系统创建」表面分类）：
  - **走 AsyncTaskSystem subagent-executor 路径**（spawn / dispatch 工具触发（ask_caller 不调度子代理 / 是子代理内部用 DialogStore.restorePrefix + LLM clone call 询问 main caller 的工具） + retro 经 EvolutionSystem.writePendingSubagentTaskFile + random_dream 经 MemorySystem.writePendingSubagentTaskFile / 全跑 `subagent-executor.ts:71-105` 同 path）：caller 经 `main registry.getForProfile('subagent')` 派生 per-task registry / **Tool instances 是 module-level const 同源 reuse**（FileTool 6 工具 + CommandTool exec 全 module-level const / `for (const t of registry.getForProfile(p)) r.register(t)` 把同一 instance 注入子 registry）+ **ctx.clawDir 透传**（subagent-executor → SubAgent ctor → ToolExecutor ctor → ExecContext.clawDir = caller.clawDir）→ tool execute 时 `getChecker(ctx.clawDir)` 查 module-level cache 拿同 PermissionChecker / sandbox 形状由 `claw-permissions.ts` hardcoded SYSTEM_PATHS+WRITABLE_PATHS derive（非 caller 配置 list）→ OS 边界 100% 隐式 align caller / 非字段透传机制
  - **走 ContractSystem.verifier-job 直 createSubAgent 路径**（仅 verifier / `createToolRegistry()` 新空 registry + 仅 reportTool / 0 FileTool 0 CommandTool）：不存在「OS 资源继承」语义（0 OS 工具）/ 不违原则
  - **不创 SubAgent**（deep_dream 直 `llmService.call(...)` 处理 dialog archive 文本）：N/A 不在 SubAgent 讨论范围
- **失败分类**：超时 → turn_interrupted + rethrow / LLM / tool 异常 → turn_error + rethrow / non-fatal catch 走 audit 不 rethrow（D「不丢弃 / 静默」derive — 失败显式归类不静默）。
- **one-shot 模式**：单次 run 跑完即结束 / 实例不可复用（与长期循环 motion / claw 主代理区分 / M#1 derive）。

> 具体 API 形态归 [interfaces/l3.md](../interfaces/l3.md) SubAgent 节。具体实现细节（5 持久化文件加 10 类事件类型加 createSubAgent 工厂加 ensureDir resultDir 等）的存在依据是「sub-agent 实例化加生命周期管理」原语 — 实然采纳的细节差异登记 §7.B。

### 不做

- **不 own 跨 sub-agent 调度加任务队列**（pending / running 状态机加 cascade abort 加 result 投回归 L4 AsyncTaskSystem）— derive 自 M#1 独立可变职责
- **不 own 长期循环**（motion / claw 主代理事件循环归 L5 Runtime）— derive 自 M#1 + M#2
- **不 own 循环算法本身**（反复跑单步加停止判定归 L3 AgentExecutor / 本模块内部调用）— derive 自 M#1
- **不 own 单步执行**（LLM 调用加 tool 派发归 L3 StepExecutor / 透过 AgentExecutor 间接）— derive 自 M#1
- **不 own system prompt 构造**（调用方提供 systemPrompt / 怎么构造（直接写加从 skill 加载加用模板）归 caller 业务）— derive 自 M#2
- **不 own tools 子集装配**（调用方提供 tools instance / SubAgent 不挑）— derive 自 M#2
- **不 own crash recovery**（恢复机制归 L4 AsyncTaskSystem）— derive 自 M#1 + M#4
- **不 own spawn / dispatch / ask_motion 业务工具**（业务语义归 L4 AsyncTaskSystem / KD#29）— derive 自 M#1 + M#2

## 2. 业务语义（M#2 业务语义归属）

> 应用 M#2（模块为自己的业务语义负责），SubAgent 的业务语义边界：

- **own**：sub-agent 单实例生命周期概念 — 实例化 / 生命周期 events / 超时约束 / 父子关系 / 父代理上下文快照继承 / 生命周期事件审计。这些是 SubAgent 唯一懂的「业务」（sub-agent 单实例级 / 与跨 sub-agent 调度区分）。
- **角色定位**：SubAgent 是「**sub-agent 单实例编排器**」非「**任务调度器**」。one-shot 跑一次 / 跨实例编排归 L4 AsyncTaskSystem。
- **派生自 modules.md KD#5 废止教训**：执行原语 vs 生命周期管理 = 独立可变职责（不合并 / 跟 AsyncTaskSystem 拆开）。

## 3. 资源（M#3 资源唯一归属）

> 应用 M#3（每种资源只归属唯一模块），SubAgent 独占的资源：

| 资源 | 类别 | 持久化 |
|---|---|---|
| 无 | — | ✗ 执行期消费调用方提供的 input + output channel |

**无磁盘资源** — SubAgent 仅持运行期句柄。

> 注：(1) sub-agent 单实例生命周期管理入口是概念归属（clawforum 内部 sub-agent 实例化必经 SubAgent / 非 M#3 业务资源）/ (2) 运行期句柄消费 caller 提供 input（prompt / messages / tools）+ output channel（stream / audit writer）/ 非 own / (3) 写入区 `resultDir` 由 caller 注入：async caller (AsyncTaskSystem) → `tasks/queues/results/<task-id>/` / sync caller (ContractSystem verifier-job) → `tasks/sync/spawn/<agentId>/` / SubAgent 仅写入方（lifecycle 子代理不可见 / 子代理 cwd 在 `tasks/subagents/<task-id>/` 独立工作区）/ 5 文件磁盘布局详 §4。

## 4. 持久化（M#4）

> 应用 M#4（持久化一切信息到磁盘 / 运行时句柄从磁盘信息重建），SubAgent 持久化 sub-agent 单实例的执行轨迹（4 文件）— 让事后可审计加重启可恢复 sub-agent 状态成为可能。

### 磁盘布局

caller 注入的 `<resultDir>/`（本模块 0 知字符串约定 / 路径计算归 caller / 应然典型路径：async caller → `<clawDir>/tasks/queues/results/<task-id>/` / sync caller → `<clawDir>/tasks/sync/spawn/<agentId>/` / phase 510-511 落地前实然仍 `tasks/results/<id>/`）：

```
<resultDir>/
├── stream.jsonl          ← turn_* / llm_* / tool_result delta（经 L2 StreamLog 写）
├── audit.tsv             ← 同上事件 audit 落盘（经 L2 AuditWriter 写）
├── steps.jsonl           ← onStepComplete 步数轨迹（经 L2 StreamLog 写）
├── messages.json         ← dialog 持久化（systemPrompt + messages + toolsForLLM 3 件同源 / 经 L2 DialogStore 接口 / 实例终止后供恢复 / phase 709 reframe / 文件名仍 'messages.json' 保兼容）
└── daemon.log            ← raw text log（execution narrative / 与结构化 stream.jsonl 不同业务）
```

### 文件格式

- `stream.jsonl`：每行 `{ ts, type, ...payload }`
- `audit.tsv`：tab 分隔 `<ts>\t<type>\t<args>`
- `steps.jsonl`：每行 react step 摘要
- `messages.json`：完整 Message[] 数组（DialogStore 持久化形态）
- `daemon.log`：raw text 累加（经 L1 FileSystem.append 写 / 因 raw narrative 不 structured 不适合 DialogStore/StreamLog）

### 重建语义

SubAgent 自身不恢复（一次性消费）。任务恢复归 L4 AsyncTaskSystem 状态机管理。SubAgent 仅保证写入原子（messages 经 DialogStore / 事件经 StreamLog / audit 经 AuditWriter / daemon.log 经 fs.append 各自原子）。

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

> **§7.A 全清里程碑（phase 453 / 2026-05-04 / `0bab36ca`）**：A.r60+1（messages.json → DialogStore L2）+ A.r60+2（路径硬编码）+ A.r60+3（daemon.log 应然不承认）+ A.r60+4（三方 align 完整）+ A.naming-1（SessionManager → DialogStore）+ A.spec-1（应然幻象）累 6 项全 closed / **L3 §A 0 残留** / L3 模块边界重构基本收尾。


| §A 条 | 类型 | 状态 | 触发情境 |
|---|---|---|---|
| ~~A.1 writer optional 时 8 类事件静默丢失~~ | drift / 高 | **已闭环（phase283）** | `taskStreamWriter` / `auditWriter` 改必选 / `?.write` 短路全部消除 / Noop 显式降级 / `auditWriter` 类型 `AuditWriter` → `Audit` 接口（M#8）|
| ~~A.M5-leak SubAgentOptions 含 L4 引用~~ | drift / 高 | **已闭环（phase353 / 实然 0 违规）** | 历史登记声称 `taskSystem` / `contractManager` / `outboxWriter` 含 L4 references。phase353 r47 C Path #1 实测：`taskSystem?` 实为 `import type TaskScheduler` from `core/tools/task-scheduler.ts`（L3 Tools port / structural typing）/ `contractManager?` `outboxWriter?` agent.ts grep 0 ref（phase229+phase283 已清）/ `agentId` `originClawId` 是 identifier strings 不构成依赖。**实然 0 真违规**。dispatch table 描述脱节 N+3 实证 |
| A.invariant-1 实例一次性消费不可复用 anchor | anchor | 防 drift（合规）| 单次 run / 第二次 run 行为未定义 / 不可改为「实例可复用 / 多次 run」/ 用作 reviewer 自检 |
| A.invariant-2 writer 必选编译期强制 anchor | anchor | 防 drift（合规）| `taskStreamWriter` / `auditWriter` 必选（M#9）/ 不可退化为 optional / 装配方未提供必注 Noop 显式降级 / 用作 reviewer 自检 |
| A.invariant-3 子代理 L3 原语 + async/sync path 分流判据 anchor (phase 502 / 用户判据) | anchor | 防 drift（合规）| **核心判据**：SubAgent class = L3 原语（primitive 能力 / 非资源实例）/ **调用 createSubAgent 当原语用的 caller = L4 业务模块**（layering 判据 / 不 case-by-case）。**path 分流按 async/sync 语义**：（a）**异步**调用子代理 → **必经 AsyncTaskSystem.spawn**（AsyncTaskSystem own 异步生命周期管理：resultHandler + 持久化任务队列 + 崩溃恢复 / lifecycle dir = `tasks/queues/results/<task-id>/`）/ 不可绕开。（b）**同步**调用子代理 → 直 createSubAgent（内部子流程需 finalText 直返 / 不需 lifecycle 持久化 / lifecycle dir = `tasks/sync/spawn/<agentId>/`）。实然 2 path 全合规：AsyncTaskSystem.spawn = async path 主路径 + ContractSystem 验收 verifier-job = sync path（同步验收业务）。不可强统一为「全经 AsyncTaskSystem.spawn」（违 M#1 async/sync 独立业务语义 + M#8 sync 接口扩张暴露 ContractSystem 不必要 async 细节 + D7 sync detour 信息流复杂）/ 用作 reviewer 自检 |
| A.invariant-4 子代理 lifecycle 不可见原则 anchor (phase 507 / 用户判据 / phase 518 reframe) | anchor | 防 drift（合规）| **核心判据**：子代理 lifecycle 文件（daemon.log / steps.jsonl / messages.json / result.txt[.sent] / stream.jsonl / audit.tsv）**不在 subagent 视野内**。lifecycle dir 由 caller 装配在外（async → `tasks/queues/results/<id>/` / sync → `tasks/sync/spawn/<id>/`）/ subagent 默认 workspaceDir = `clawspace/`（**phase 518 改 / 与 caller 共享** / 校正 phase 512 over-engineering）/ subagents/<task-id>/ 改为**建议性临时区**（system prompt 教学推荐 / 非 strict default）/ 子代理 ls/find 默认看到 caller workspace / 自己的 lifecycle metadata 仍不在视野内（lifecycle dir 在 tasks/queues/ 或 tasks/sync/spawn/）/ Philosophy P3 derive：subagent 看不到自己 lifecycle 是上下文工程原则。不可改为「lifecycle 与 workspace 同 dir」（违 P3）/ 用作 reviewer 自检 |
| A.invariant-5 子代理临时区建议性 + ephemeral cleanup anchor (phase 515 / phase 518 reframe) | anchor | 防 drift（合规）| **核心判据**：`tasks/subagents/<task-id>/` 是 **ephemeral 建议性临时区** / 由 caller（async = AsyncTaskSystem.subagent-executor / sync = ContractSystem.verifier-job）在装配期 ensureDir 创建 + lifecycle 完结时（success / failure 都触发）`fs.removeDir` 清。**system prompt 教学**（buildSubagentSystemPromptPrefix）推荐 subagent **优先用此临时区** 创建 ephemeral 文件 / 避免在 caller clawspace 散落 / 但是建议性 / 0 strict enforce（信任 LLM 跟 prompt / phase 502 anchor 模式）。**best-effort 软降级**（feedback `best_effort_soft_degrade` Meta 34 N=5 实证累）：cleanup 失败不抛 / audit `subagent_workspace_cleanup_failed` / 不阻 lifecycle 主路径。**crash recovery**：daemon 启动期 `task-recovery.recoverTasks()` 末尾 sweep `tasks/subagents/` 全 orphan dirs。**phase 518 reframe**：subagent 默认 workspaceDir = `clawspace/`（共享 caller / 同主代理 mental model）/ subagents/<id>/ 仍创建 + cleanup 但是 advisory 不是 default cwd / 校正 phase 512 over-engineering 回归 phase 507 用户原意「避免」语义。不可改为「workspace 持久化」/「cleanup hard fail」/ 不可改回 strict default workspaceDir = subagents/<id>/（违 phase 502 invariant-3 SubAgent = caller 延伸的 mental model）/ 用作 reviewer 自检 |
| ~~KD#29 spawn/dispatch/ask_motion 业务语义归属~~ | drift | **✅ closed（phase347 + 后续 / 实然 0 残留）** | 应然：三工具业务语义归 AsyncTaskSystem(L4)。实然 4 文件（spawn.ts / dispatch.ts / ask-motion.ts / _pending-task-writer.ts）全迁至 `src/core/task/tools/` / `src/core/tools/builtins/` 0 残留 / 完成度比契约预期更完整。dispatch table 描述脱节 N+4 实证（fork agent 报告 implementation > contract claim）|
| ~~`audit?` field 短路残留~~ | drift | **✅ closed（phase366 / main `2f0548a`）** | module-level `audit?: AuditWriter` field 仍 optional / agent.ts 3 处 `this.audit?.write(...)` 短路 → phase366 audit field 必选化 + Noop 注入 / 3 处 `?.` 删（onStepComplete / persistMessages / appendToLog）/ D1 信息不丢失 / phase283 同型治理模板复用 |
| ~~契约行号引用策略~~ | drift | **✅ closed（phase372 / 真治理 + 释义豁免双轨）** | 历史契约引用具体行号 / 代码移位后 drift → Path #1 实测：历史举例 `task/system.ts:573` 已自然清理 / 18 处合规 path:linenum（12 backtick drift 描述 + 3 non-backtick drift / 3 OK changelog/历史）/ **真违规 4 行 5 refs 在 `l6_daemon.md:167-174` §3 console 清单 spec body**（行号实测全 stale）/ phase372 已治（method/symbol 名 + grep 指令）+ design/modules.md 末尾立「契约文档实践规范」footnote / **释义豁免模板第 6 次复用** |
| ~~turn-interrupted 错误信息误导性~~ | drift | **✅ closed（phase371）** | `turn_interrupted` 事件 `agent.ts` 固定显示 `Timeout after ${this.timeoutMs}ms` / 不区分实际中断原因 → phase371 makeExternalAbortError reason 结构化（`{ type: string; ms?: number }`）+ agent.ts message 区分四类（user_abort / idle_timeout / priority_inbox / signal）/ D1+D6 双原则 derive |
| **A.spec-1 应然 `interface SubAgent { run(input): Promise<SubAgentResult> }` rich types ↔ 实然 `class SubAgent` ctor 注入 + `run(): Promise<string>`** | spec drift / 大 | **closed**（phase414c L3 audit / interfaces/l3.md align 实然 class + ctor + 0 args run + return string）| 历史 interfaces 写应然 `interface SubAgent` + `run(input: SubAgentInput): SubAgentResult` rich types (SubAgentInput / SubAgentResult / SubAgentTimeouts / SubAgentIdentity / SubAgentTimeoutError 5 应然幻象 type) / 实然 = `class SubAgent` ctor 注入大 SubAgentOptions (15+ 字段) / `run()` 0 args 返 `Promise<string>` final text only / 应然 5 应然幻象 type 实然 0 实施 (timeout 走 AbortController + audit events / 不抛 SubAgentTimeoutError 类) / phase414c interfaces/l3.md 修订 align 实然 class + ctor 注入 + 0 args run + 返 string + 加 createSubAgent factory + NoopStreamWriter/NoopAuditWriter helper / 删 5 应然幻象 type |
| ~~**A.r60+1 messages.json 直接 fs.writeAtomic 绕 DialogStore L2**~~ | ~~drift / 高~~ | **✅ closed (phase 453 / `0bab36ca`)** | phase 453 落地 (phase β / **design+code 联动 cluster 完整 3 阶段**：phase 444 design + phase 450 code α + phase 453 code β)：(1) SubAgentOptions +`messageStore: DialogStore` 必填字段 / (2) SubAgent class field + ctor 接 / (3) agent.ts:322 改调 `this.messageStore.save(messages)` / 0 fs.writeAtomic messages.json 残留 / (4) caller cascade 9 处装配 ephemeral DialogStore（subagent-executor + contract/manager + 7 tests / `createDialogStore(fs, resultDir, audit, 'messages.json')` / 0 clawId / 0 archive 触发）/ (5) M#3 + M#5 align ✓ / 0 disk path 改 / messages.json schema 变（raw `Message[]` → `SessionData` wrapper / 0 caller 读 = 0 影响）/ 5 files +63 -4 / 1373+ tests PASS |
| ~~A.r60+2 路径硬编码 `tasks/results/${agentId}/` 字符串约定耦合~~ | drift / 中 | **✅ closed (phase443)** | phase443: SubAgentOptions +resultDir: string 必填 / SubAgent class field + ctor 接 / agent.ts 4 处 path 改 `${this.resultDir}/...`（:88 daemon.log / :166 ensureDir / :176 steps.jsonl / :320 messages.json）/ caller 注入: subagent-executor.ts:99 + contract/manager.ts:1246 + 6 tests (task.test.ts) + 1 test (subagent.test.ts) / M#3 + M#9 align ✓ / 0 disk path 改 / 仅字符串拼接位置迁移 / 注: A.r60+1 messages.json fs.writeAtomic 调用部分仍 open（涉 L2 DialogStore / 推 L2 解禁后）|
| ~~A.r60+3 daemon.log raw text 应然 §4 不承认~~ | drift / 中 | **✅ closed 2026-05-03**（应然 §4 加 daemon.log 第 5 文件 + 业务定位「raw text narrative / 不 structured」/ §M#5 显式 dep L1 FileSystem 仅供 daemon.log raw append）| 选 (a) 路径：raw text log 与 structured stream/audit 业务不同 / DialogStore/StreamLog 不适合 / fs.append 直写是合理设计 / 应然层补承认 5 文件 + dep L1 显式化。源：r60+ SubAgent fs 4 处用法分类 |
| ~~A.r60+4 arch 表 1 vs module §M#5 内部 inconsistent（DialogStore dep 一方有一方无）~~ | ~~drift / 中~~ | **✅ closed 完全 (phase 453 / `0bab36ca`)** | phase 453 落地：实然 src `agent.ts` import DialogStore type / SubAgent dep DialogStore / **三方 align 完整**（arch 表 1 + module §M#5 + 实然 src）。源：r60+ user 戳穿 + r61 phase 453 代码落地 |

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| ~~B.1 SubAgent 双实例化路径~~ | ~~drift / 中~~ | **⚓ accepted-stable (phase 502 / 合理派生态 reframe)** | **phase 502 28 原则核审推翻 framing**：双实例化非 drift / 是不同业务语义合理派生态。实然 2 处：`src/core/task/subagent-executor.ts:79` (AsyncTaskSystem 主路径 / async lifecycle + resultHandler) + `src/core/contract/verifier-job.ts:23` (ContractSystem 验收 / sync finalText 内部子流程 / phase 427 后位置 / 原 row path stale)。**β「强统一 ContractSystem 改走 AsyncTaskSystem.spawn」违 4 条原则**：M#1 业务语义独立可变（async lifecycle vs sync exec）/ M#2 验收是 ContractSystem 业务应自发起不 detour / M#8 sync finalText 接口扩张暴露 ContractSystem 不必要细节 / D7 detour 增 3 层间接信息流复杂。SubAgent class = 能力/工具非资源实例 / 资源（具体子代理实例）归创建者各自负责 → M#3 align。phase 471 false positive framing 模式同根。|
| ~~B.3 物理位置分散 / 无统一逻辑门面~~ | ~~design-gap / 低~~ | **✅ closed (phase 502 / 升档条件未触发)** | **phase 502 28 原则核审**：subagent/index.ts 19 行 thin facade align M#7+M#8（耦合界面稳定+最小）/ 三工具归 AsyncTaskSystem 单 owner align M#3 / 升档条件「多 caller 反复 import 散点」实测未触发（caller 全经 task/tools/ barrel）/ 设计意图正确。|
| ~~dispatch `addTaskResultHandler` callback 订阅~~ | drift / 低 | **✅ closed (phase438)** | phase438 dispatch handler 文件化：addTaskResultHandler API 删 / postProcessor declarative schema 替代 / `dispatch-contract-extract` standalone function in `src/core/task/post-processors/` / dead `taskSystem` field cascade 全清 / 重启可恢复 / 同 phase 与 task_system §7.B 同步登记 |
| **L3.G1 (subagent)** mainContextSnapshot + mainDialogStore 仍标 phase 458「应然 NEW」/ phase 470 已实施 marker mode 后 interfaces 同步纪律 | **业务决策性 design-gap / r65 起 cross-doc audit 浮出 / `feedback_design_doc_sync_after_phase_closure` 第 N+5 实证累**：interfaces/l3.md line 234 + 237 仍标「实然 copy mode（main messages 复制进 subagent / 应然 marker mode 推 phase 458 改 mainContextSnapshot + ask_caller / 见下应然 NEW 字段）」+「phase 458 应然 NEW」/ phase 470 (`a6b99f18`) spawn schema 7→3 + ask_caller tool + marker mode 已实施 / 应然 NEW 字段应升 actual / `messages?` field 应标 deprecated / interfaces 同步未推 | **业务决策性 / 用户拍板候选**：α interfaces line 234 删「应然 marker mode 推 phase 458」改「✅ closed by phase 470」+ line 237 删「phase 458 应然 NEW」改「phase 470 actual」/ β `messages?` field 标 ⚠ DEPRECATED phase 470 / γ 保留现状（spawn schema 实然字段 vs interfaces 待 src 实测核对）|
| **B.race-coupling Promise.race(runReact, timeoutPromise) 与 ctx.signal 双层 / runReact 内 callback 可在 race 解决后继续 fire** | drift / 中 / r65 D fork derive 浮出 | **✅ closed by phase 538** | 实然 `agent.ts:271-331` Promise.race winner = timeoutPromise → catch 抛 ToolTimeoutError 等 / runReact 仍 pending 直到下个 ctx.signal.aborted 检查点 / 期间 streamCallbacks（onTextDelta / onToolResult / onLLMResult）继续 emit onto sw（已 turn_interrupted 之后的 ghost events 进 stream.jsonl）/ chat-viewport replay 错显 / audit 可能再 emit LLM_CALL 计数 / 违 D1 信息不丢失语义清晰 + M#10 不合理停下 / ε.1 + ε.3 复合：ε.1 sw closed flag + safeSwWrite + 一次性 `ghost_callback_after_turn_end` audit / ε.3 runReact 内 callback 进入前补 signal check / derive 详 `coding plan/phase538/Phase 538 总览.md §D.3` |

### 7.C 应然原则对照

> 仅列应然对各原则的承诺立场 / 不写「合规✓」claims。

**Module Logic Principles**

- M#1 独立可变职责：执行原语 vs 生命周期管理 = 独立可变职责（KD#5 废止教训 / phase173 SubAgent 下移 L3）
- M#2 业务语义归属：「一次性 ReAct 循环」业务点归本模块；spawn/dispatch/ask_motion 业务语义归 AsyncTaskSystem(L4)（KD#29）
- M#3 资源唯一归属：tasks/ 目录归 AsyncTaskSystem；本模块仅写入调用方注入路径
- M#4 持久化：stream.jsonl + audit.tsv + steps.jsonl + messages.json + daemon.log（5 文件）持久化执行轨迹 / 写入区路径由 caller 注入 resultDir
- M#5 依赖单向：L3 → L1 (FileSystem — 仅 daemon.log raw text append) + L2 (DialogStore / AuditLog / StreamLog / Tools) + L3 同层 (AgentExecutor — runReact 一次性 ReAct 循环)（per arch §20 表 1）/ LLM 调用经 AgentExecutor → StepExecutor → LLMOrchestrator transitive chain / SubAgent 不直接 dep LLMOrchestrator / 0 上引 L4+ / 0 TaskScheduler dep（**SubAgent 同步循环 0 知 AsyncTaskSystem / 异步调度归 caller 经 dispatch/spawn 工具 AsyncTaskSystem own + Assembly 装配注入 SubAgent.tools**）
- M#6 依赖结构稳定：构造期 options 固化 / 运行期不变
- M#7 耦合界面稳定：SubAgent class + createSubAgent 工厂 + SubAgentOptions interface
- M#8 耦合界面最小：跨边界传必要 options / `auditWriter: Audit` 接口（不暴露 AuditWriter class 内部）
- M#9 显式编译器可检：所有签名 type-only / writer 必选编译期强制 / NoopWriter implements 接口校验
- M#10 不合理停下：超时 / LLM 错 rethrow / non-fatal catch 走 audit 不 rethrow
- M#11 边界对不上停下：发现 SubAgentOptions 字段含 L4 引用即停下重构（phase353 / Path #1 实测推翻 framing）

**Design Principles**

- D1a 信息不丢失：phase283 writer 必选 / 8 类事件不静默丢失
- D1b 状态可观察：8 事件覆盖完整生命周期 / stream.jsonl delta 粒度
- D1c 中断可恢复：caller 注入 resultDir 写入原子 / messages.json 经 DialogStore writeAtomic 兜底（恢复主体在 L4 AsyncTaskSystem）
- D1d 事后可审计：phase283 writer 必选保证全链可审
- D2 不丢弃 / 静默：phase283 A.1 消化 / 3 个 non-fatal catch 走 audit 合规
- D3 用户可观察：stream.jsonl 可被上层 stream consumer 实时查看
- D4 LLM 调用恢复：N/A（LLM 调用经 AgentExecutor → StepExecutor → LLMOrchestrator transitive 链 / 容错归 LLMOrchestrator / 本模块仅 one-shot 跑完即结束 / 不持 LLM 调用恢复语义）
- D5 日志重建：3 层日志 + messages.json + daemon.log 进程重启可重建子代理执行轨迹
- D6 子代理后不阻塞：SubAgent 是 AsyncTaskSystem 实现 D6 的同步执行原语 / 异步性归 caller (L4 AsyncTaskSystem) / SubAgent.run() 自身 sync 等待 finalText 返回 / 子代理决策权在父代理（prompt / tools / systemPrompt 传递）
- **D6.1 智能体创建子代理 OS 资源权限继承**（2026-05-07 加 / 2 轮 src 实测核 align）：原则边界按**执行路径**分（非 caller 类型）：(a) 走 AsyncTaskSystem subagent-executor 路径（spawn/dispatch 智能体工具 + retro/random_dream 系统调度 同走 writePendingSubagentTaskFile）→ tool instance module-level const reuse + ctx.clawDir 透传 → 同 PermissionChecker（hardcoded SYSTEM_PATHS+WRITABLE_PATHS derive）→ OS 边界 100% 隐式 align caller；(b) ContractSystem.verifier-job 直 createSubAgent → empty registry + reportTool only / 0 OS 工具 / 不存在继承语义；(c) deep_dream 不创 SubAgent / N/A / 详 §1.做 OS 资源访问权限继承
- D7 系统可信路径：caller 装配期注入 tools instance（受信工具集）/ writers 必选注入（M#9 编译期强制）/ 本模块不绕过
- D8 事件驱动：SubAgent 经 runReact 消费 LLM 工具调用事件
- D9 CLI 唯一外部入口：N/A（本模块 L3 内部原语 / 0 外部入口）
- D10 多 claw 不隔绝：经 caller (AsyncTaskSystem) 装配注入的 AskMotionTool 间接服务 D10 / 本模块不 own AskMotionTool（KD#29 已迁 AsyncTaskSystem）
- D11 motion 特殊：经 caller 装配注入的 AskMotionTool + motionContext 间接服务 D11 / 本模块不 own

**Philosophy**

- P1 Agent 即目录：caller 注入的 resultDir 目录持久化子代理状态
- P2 上下文工程：messages + prompt + systemPrompt + callerType 四维传递父代理上下文快照
- P3 分多个智能体加分子任务：**核心驱动原则**（SubAgent 是「派一个 sub-agent 替我做事」的最小封装 / 高效利用上下文窗口）/ SubAgent 单实现服务全 claw / motion 场景 / callerType 决 profile
- P4 系统为智能体服务：提供子代理实例化 + 生命周期管理 + 上下文继承基础设施

**Path Principles（7 条）**

- **Path #1 路径规划基于规划时刻的事实**：审计期 framing 必先 grep 实然（phase353 推翻 dispatch table 描述 / 注意实施过程中实然的变化）
- **Path #2 实然和应然差距显式登记**：违规明文上墙（在路径规划时参考 / §7.A + §7.B）
- **Path #3 语义原子变更单元**：APPEND-only §7 不解构既有节 / 1 phase = 1 commit 原子
- **Path #4 可回滚 + 破坏性论证**：API 改动 caller 评估 / 破坏性改动显式论证（反向测试：本模块可独立替换 LLMOrchestrator / Tools 实现而不动 AsyncTaskSystem caller —— M#1 ✓）
- **Path #5 完成后复盘**：phase 收尾三维 + Path Principles 第 4 维对账
- **Path #6 冲突立即中断**：scope 模糊或决策点必停报告（冲突调整优先于强行推进）
- **Path #7 总难度路径**：实然到达应然有诸多路径 / 选择降低总难度的（步骤间有相互作用 / 总难度 ≠ 各步骤成本简单相加）

### 7.D 历史纪律

- 2026-04-21 / phase173 SubAgent 从 L4 SubagentSystem 下移 L3（KD#5 废止 / 执行原语 vs 生命周期管理拆分）
- 2026-04-20 / phase163 SubagentSystem ↔ AsyncTaskSystem 运行时循环消除（writePendingSubagentTaskFile 文件直写 / scheduleSubAgentWithTracking helper 删）
- 2026-04-22 / phase201 §9 物理编号 APPEND backfill（工厂未实装 / 契约行号引用策略 drift）
- 2026-04-22 / phase229 createSubAgent thin proxy 工厂实装 + 2 消费方切换（D.1 D.2 解阻塞）
- 2026-04-23 / KD#29 spawn/dispatch/ask_motion 业务语义归 AsyncTaskSystem
- 2026-04-24 / phase247 三 non-fatal catch 由 monitor.error 迁至 audit?.write
- 2026-04-24 / phase252 monitor 字段保留 SubAgent 透传 消化（ToolExecutorOptions +auditWriter 透传）
- 2026-04-25 / phase283 §7.A A.1 清零（writer 必选 + Noop 显式降级 + auditWriter 类型 Audit 接口收窄）
- 2026-04-27 / phase347 KD#29 子任务 b+c dispatch 物理迁 + profiles 类型化（spawn/dispatch/ask-motion/_pending-task-writer 4 文件全迁 `src/core/task/tools/` / `src/core/tools/builtins/` 0 残留 / fork agent r48 复核确认）
- 2026-04-27 / phase353 §7.A.M5-leak 100% 推翻（实然 0 违规 / dispatch table N+3 实证）
- r60+ 重编号：9 节 → 8 节，每节 derive 自一条 Module Logic Principle（删原 §2 接口 / §5 上游依赖 / §6 不可消除耦合 → 已并入 interfaces/l3.md / 拆原 §1 所有权 hub 为 §1 职责 + §2 业务语义 + §3 资源 + §4 持久化 / 删原 §7 内部不变式 杂物筐 → 行为级回 §1.做、anchor 性质回 §7.A）
- 2026-05-04 / cross-doc audit drift 修订（§7.C P3 verbatim「分多个智能体加分子任务」/ Design Principles 编号修：D6 合并 D6a+D6b + D9-D11 重新对齐 verbatim + 加 D4/D7 + D9 N/A 标 align principles.md / §3 资源改 table 「无」+ 注脚 align 其他模块 / §7.B addTaskResultHandler row 同步 phase438 closed）
- 2026-05-04 / **phase 453 §A.r60+1 落地（phase β / L3 §A 全清里程碑）**（`0bab36ca`）/ design+code 联动 cluster 完整 3 阶段（phase 444 design + phase 450 code α + phase 453 code β）/ messages.json 经 L2 DialogStore 持久化 / SubAgent dep DialogStore + ctor 注入 ephemeral DialogStore（filename='messages.json' / 0 clawId / 0 archive 触发）/ caller cascade 9 处装配（subagent-executor + contract/manager + 7 tests）/ M#3 + M#5 align ✓ / 0 disk path 改 / **L3 §A 6 项全 closed**（A.r60+1 + A.r60+2 + A.r60+3 + A.r60+4 + naming-1 + spec-1）/ L3 模块边界重构基本收尾
- 2026-05-04 / phase 466 DialogStore systemPrompt + restorePrefix 落地（main `201bc6df`）/ DialogStore ctor 加 systemPrompt 必填 + restorePrefix(marker) 返完整前缀（messages 切片 + systemPrompt + meta）/ 1 instance = 1 system prompt regime / SubAgent ask_caller 工具实施前置 ✅（spawn cluster 收尾依赖）
- 2026-05-04 / phase 470 spawn cluster 收尾（main `a6b99f18` / r62 E fork / merge `f8b00074`）/ spawn schema 7→3 字段（intent + timeoutMs + maxSteps）+ SubAgentTask: prompt→intent + timeout→timeoutMs + 加 mainContextSnapshot marker / **SubAgentOptions 加 mainDialogStore + mainContextSnapshot 字段**（替代 messages copy mode / 单一权威源 DialogStore / phase 458 应然 NEW 升 actual）+ 删 phase 438 deprecated taskSystem / NEW ask_caller 工具（subagent profile only / `src/core/task/tools/ask-caller.ts` 61 行 / 含 placeholder LLM clone call wrapper）+ ExecContext 扩 mainDialogStore + mainContextSnapshot + currentToolUseId / Assembly setMainDialogStore inject AsyncTaskSystem / caller cascade（dispatch + retro-scheduler + random-dream + 6 tests）/ 20 files +214 -227 / 1353 tests PASS / **r53+ spawn cluster 完整闭环**（phase 444 design + phase 450 code α + phase 466 code β + phase 470 spawn 4 phase 跨 r 完整闭环）
- 2026-05-05 / r65 cross-doc audit 单 doc 一致性核（modules/l3_subagent.md vs arch §20 + 表 1/2 + interfaces/l3.md SubAgent 节）/ 0 derive drift / 主 derive 全 align（M#1-M#11 + Design Principle D1a-d + D2/D3/D5/D6/D7/D8 + D9/D10/D11 N/A + Philosophy P1+P2+P3 核心驱动原则+P4 + Path #1-#7）/ 4 主能力 align arch 表 2 / 6 dep + caller list（含 r65 修订 interfaces 加 l4_contract_system 验收路径 caller）align arch 表 1 / phase173 下移 L3 + phase229 工厂 + phase347 KD#29 工具迁 + phase353 M5-leak 推翻 + phase 453+466+470 spawn cluster 4 phase 完整闭环 + L3 §A 0 残留多里程碑稳态保留 / L3.G1 (subagent) interfaces line 234+237 mainContextSnapshot 应然 NEW → actual + messages? deprecated 同步纪律 design-gap 已登记 §B / design only / 0 src 改
- 2026-05-07 / **phase 522 联动 closure**（main `0f7c5219`）/ 用户 A.10「SubAgent 内部仍调 runReact」framing 推翻 closed / agent-executor module 公共 API 缩到 runReact only（per phase 522 ν 决策）/ subagent/agent.ts:272 真用 runReact 是合规 production API caller / 不是「旧兼容层未清理」/ 0 改 src/core/subagent/ / 详 modules/l3_agent_executor.md §7.D phase 522 milestone + §A.spec-1 ν 升级注

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| KD#5（已废止）| ~~SubagentSystem 合并 TaskRunner~~ | 废止 / 执行原语 vs 生命周期管理拆分 / SubAgent 下移 L3 |
| KD#27 | Tools 声明式归属 | SubAgent 不导出业务工具 / spawn/dispatch/ask_motion 归 AsyncTaskSystem |
| KD#29 | spawn / dispatch / ask_motion 业务语义归 AsyncTaskSystem(L4)| **全闭环（phase347 + 续 / 4 文件全迁 task/tools/）** / 业务语义归属 已闭环 |

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
> AskMotionTool / DispatchTool / spawnTool 测试归 l4_task_system.md §8（KD#29 三工具业务语义已迁 AsyncTaskSystem L4 / 本模块不再覆盖）。

## phase 695 — r93 E fork V4-P1.4 agent-race-ghost real timer race 业务决策 row

### V4-P1.4 `tests/core/subagent/agent-race-ghost.test.ts:113,124` 200/300ms physical sleep

- **claim**：测 timeout 后 ghost callback / 100ms margin 在慢 CI 紧
- **业务决策**：fakeTimer 改造 vs 保 real timer
- **选项**：
  - α：fakeTimer + `vi.advanceTimersByTimeAsync` 严格控时
  - β：保现状（real timer race 本质需 wallclock / fakeTimer 改造可能掩盖真 race）
  - γ：保 real timer + 缓 buffer（200→500ms / 300→1000ms）
- **28 原则核**：
  - 测试稳定性 → α
  - 真 race 测试本质 → β（fakeTimer 不复现真 race）
- **主会话预期**：γ 缓 buffer 不改 timer 类型（保留 race 真值 + 抗 CI 抖动）
- **决策状态**：**closed by phase 703**（r94 D-5 / γ — 缓 buffer 200→500ms / 300→1000ms / 5× margin / 28 原则 derive：DP「状态可观察」推 race 真值需 real timer / α fakeTimer 替换时间观察会掩盖真 race / β 100ms margin 偶发 flake 违 DP「不静默忽略」/ 用户确认 framework 后主会话自决 land / 与 phase 687 e2e 不引入 fakeTimer 反模式呼应）
