# Tools 模块内部契约

> 本文档限本模块**内部**应然 — 8 节结构 derive 自 Module Logic Principles：§1-§4 = M#1-#4 各占一节，§5 审计 = M#3 命名空间细则，§6 层级，§7 drift = M#10/#11，§8 测试。
> 跨模块对外承诺（接口签名、生产/消费方、归本模块加不归本模块、不可消除耦合理由）见 [interfaces/l2c.md](../interfaces/l2c.md) Tools 节。
> 模块本质加层归属见 [architecture.md](../architecture.md)。

## 1. 职责（M#1 独立可变职责）

> 本节内容 derive 自 [architecture.md](../architecture.md) §15「Tools 本质：工具注册加派发机制框架 / L2 agent 语义基础设施 / 在 L2 ToolProtocol 之上把 clawforum 工具机制封装成可重用基础服务 / 不预设具体 caller 类型 universe 加权限矩阵 — caller 类型有哪些加哪个 caller 能用哪个工具由 L6 Assembly 装配期 own 加注入」加 M#1 / M#2 / M#3 / M#4 / M#5。

### 做

应用 M#1（一个模块封装一组独立可变的职责），Tools 的单一职责 = **工具注册加派发加执行的机制框架**：

- **工具注册机制**：register / unregister / 查询 / profile 过滤 / 给 LLM 用的 schema 格式化 — 这是「工具注册表」的单一资源（M#3 derive）。
- **工具派发加执行编排**：按 caller 类型查权限再派发到 handler / 超时控制 / signal 合并 / 异步路由 — 这是工具调用的统一入口（M#3 资源唯一归属 derive）。
- **错误统一包装**：工具内部抛错 catch 转结构化 ToolResult / 不 rethrow / 保证 agent 继续（D「不丢弃 / 静默」derive — 错误信息以结构化形式暴露）。
- **执行上下文承载**：caller 身份加基础设施依赖句柄（fs / llm / audit）— 不预设业务模块依赖（M#5 derive）。
- **审计留痕**：调用前后写 audit / 集中决策点（M#3 audit 命名空间 own derive）。

> 具体 API 形态归 [interfaces/l2c.md](../interfaces/l2c.md) Tools 节。具体实现细节（Tool interface 形状加 supportsAsync 路由加 ExecContext 字段加 TOOL_PROFILES const 加 ReportResultTool 通用机制工具等）的存在依据是「注册加派发加执行框架」原语 — 实然采纳的细节差异登记 §7.B。

### 不做

- **不 own Tool / ToolResult / JsonSchema 协议 schema 定义**（归 L2 ToolProtocol — type-only schema 模块）— derive 自 M#1 独立可变职责
- **不 own 任何业务工具的执行语义**（业务工具归各业务模块自行声明 / Assembly 装配期注册）— derive 自 M#1 独立可变职责 + M#2 业务语义归属
- **不 own caller 类型 universe**（哪些 caller 存在归 L6 Assembly 装配期 own）— derive 自 M#5 不预设上层
- **不 own 权限矩阵**（哪个 caller 能用哪个工具归 L6 Assembly 装配期 own 加注入）— derive 自 M#5
- **不 own tool_use 解析**（从 LLM 响应提取 tool_use 归 L3 StepExecutor）— derive 自 M#1
- **不 own LLM 调用**（仅提供 formatForLLM schema 转换 / 不调 LLM）— derive 自 M#1
- **不 own 业务模块依赖透传**（ExecContext 不含 taskSystem / outboxWriter / contractManager / skillRegistry 等业务字段）— derive 自 M#5 依赖单向
- **不 own 注册表持久化**（ToolRegistry 是运行期派生态 / 每次装配重建）— derive 自 M#4
- **不 own 工具内业务审计**（caller 调 ctx.auditWriter 写各业务 audit / Tools 框架仅写工具调用本身的 audit）— derive 自 M#3 命名空间细则

## 2. 业务语义（M#2 业务语义归属）

> 应用 M#2（模块为自己的业务语义负责），Tools 的业务语义边界：

- **own**：工具注册加派发加权限校验加审计的「机制层」概念 — register / dispatch / schemas / ExecContext 等。这些是 Tools 唯一懂的「业务」（机制层级 / 不解读具体工具用途）。
- **角色定位**：Tools 是「**通用 agent 工具调用框架**」非「**业务工具实现器**」。具体「做什么」归各业务模块；「怎么注册 / 怎么调用 / 怎么过滤 / 怎么超时 / 怎么审计」归本模块。
- **ReportResultTool 例外**：作为 verifier 子代理结构化返回的**通用机制层工具**（防 JSON 文本 parse 脆弱）/ 归 Tools 自身（一种通用机制工具 / 非业务工具）。

## 3. 资源（M#3 资源唯一归属）

> 应用 M#3（每种资源只归属唯一模块），Tools 独占的资源：

- **工具注册表加派发入口**：clawforum 内部任何工具调用必经 Tools 间接派发 — 是 clawforum 对工具机制层的唯一调用入口（让权限校验加审计加超时加错误处理集中）。
- **运行期派生态**：`ToolRegistry.tools: Map<string, Tool>` 实例内存 / 不落盘 / 每次装配重建。
- **type-level 资源**：`ExecContext` 字段集（caller 身份加基础设施依赖句柄 / 不预设业务字段 / `Tool` 协议 schema 归 L2 ToolProtocol）+ `TOOL_PROFILES` 权限白名单 const（caller 类型 universe 加权限矩阵由 L6 Assembly 装配期 own 加注入 / 本模块仅持框架 type union 加 const 占位）。

## 4. 持久化（M#4）

> 应用 M#4（持久化一切信息到磁盘 / 运行时句柄从磁盘信息重建），Tools 自身的持久化立场：

- **模块零状态**：Tools 不持自有磁盘 artifact — ToolRegistry 加 ExecContext 全是运行期派生态。
- **重建语义**：进程重启时工具名集合加 profile 白名单加 schema 恒定（代码定义）/ 不涉及磁盘状态恢复 / Assembly 装配过程重新注册各业务模块声明的 Tool 对象即重建。

## 5. 审计事件清单

事件常量集中定义于 `TOOLS_AUDIT_EVENTS`（模块自治）。框架层只产生 2 个通用执行事件 / 业务工具的 audit 事件归各业务模块契约登记。

| 事件 type | 触发时机 | 载荷 |
|---|---|---|
| `tool_exec` | `ToolExecutorImpl.execute` finally 块 | `toolName=`, `outcome=ok\|err`, `ms=`, `summary=` |
| `tool_async_start` | execute 走 async 路径 | `toolName=`, `toolUseId=`, `task=<taskId>` |

> 业务工具事件（`contract_created` / `inbox_written` / `dispatch_load_skills_failed` / `status_contract_error` 等）via `ctx.auditWriter?.write()` 透传 / 归各业务模块契约 §5 登记。

## 6. 层级声明

L2 基础设施（agent 语义）/ framework only / 不持具体业务工具。详见 [architecture.md](../architecture.md) 加 [interfaces/l2c.md](../interfaces/l2c.md)。

## 7. 应然 vs 实然差距登记（M#10 / M#11）

> 原则：本节只登记**实然 ≠ 应然**的 gap（待治理或已治理的历史）+ 偏差 + 历史纪律。当前实然若与应然 align 则不在此登记。

### 7.A 必修违规（含历史已闭环）

| §A 条 | 类型 | 状态 | 触发情境 |
|---|---|---|---|
| A.1 capability 协议机制（TaskScheduler / ContractQuery / OutboxSink / ISkillLibrary）| design 决策 | 已闭环（KD#29 phase289 删除 / `9013f2b`）| 4 字段从 ExecContext 移除（taskSystem / outboxWriter / contractManager / skillRegistry）/ §5.1 capability 协议清单整段删 |
| ~~ToolExecutorImpl.taskSystem 字段未清理~~ | 登记错误（registration error / 非 drift）| 已撤销（phase350 r44 A）| r42 D 第 5 轮误判 / 实然 §1 应然显式 endorse「ToolExecutor 持 TaskScheduler 引用 async 路由」/ 与 phase289 ExecContext 4 字段无关（ExecContext interface ≠ ToolExecutorImpl class）/ phase347 r43 总览推翻率 ~50% 直接溯源此条登记错误向上游 dispatch 传播 |
| dispatch 工具物理位置 | drift | 已闭环（phase347）| `src/core/runtime/dispatch.ts` → `src/core/task/tools/dispatch.ts`（与 spawn/ask-motion KD#29 一致）|
| ~~**done 工具归 ContractSystem**~~ | **✅ closed（phase360 / main `e3285d0`）** | ~~业务依赖 `ContractManager` / `doneTool.contractManager?` 字段注入跨边界穿透 / `src/core/tools/builtins/done.ts` L2 Tools 集中 / 违 M#1+M#2+M#3+M#5+M#7+M#8~~ → phase360 done 物理迁 ContractSystem / KD#29 第 4 工具 / ~~port pattern 第 5 次复用~~ ⚠ STALE 2026-05-03：done 物理迁本身合理（业务工具归业务模块 own）/ 但「port pattern 第 5 次复用」标错（done 是 tool ownership 转移不是 port pattern）/ 详 feedback_governance_workaround_smell / `src/core/contract/tools/done.ts` 由 ContractSystem own / 跨边界穿透清 |
| profiles.ts 字符串硬编码 | drift | 已闭环（phase347）| `*_TOOL_NAME` const 自治（tool-names.ts 集中定义）+ ToolName union type / profiles.ts 编译期可检 / caller 风格统一并轨第 2 次复用（phase345 模板 1:1）|
| B.4 ToolExecutor.getExecContext() 未注入 auditWriter | drift | 已闭环（phase252）| `ToolExecutorOptions` 加 auditWriter 字段 / `getExecContext` 透传 / SubAgent 路径下 dispatch / status 工具拿到 ctx.auditWriter 不再 undefined |
| **A.X-1 ExecContext prototype 漂移 bug** | drift | 已闭环 | `executor.ts:224` `{...ctx, signal}` 展开丢类原型方法（getElapsedMs / incrementStep / isMotionChain getter）/ status 工具 `ctx.getElapsedMs()` 抛 TypeError / read/ls/search 读 `ctx.isMotionChain` 得 undefined。修复：新建 `cloneExecContext(ctx, { signal })` helper（`context.ts:74`）/ executor.ts:224 改调 helper（保留 prototype）/ step-executor.ts 同型修。诊断 + 修复方案：`coding plan/r34/status工具修复-诊断与计划.md`。**测试 fidelity 教训**：原 18 测试全绿但实机持续 audit error / `feedback_test_fixture_fidelity` 实证 |
| ~~A.X-2 status supportsAsync 过度准入~~ | ~~scope drift / 低~~ | **✅ closed（phase400 / main `3ed32b82`）** | 应然权威单源 = l2_command_tool §10.6（C 类 sync-only / 14 工具三分类）/ 实施：status.ts:125 `supportsAsync: true` → `false`（同根 l2_file_tool §A.4 read+ls 同 phase 治）/ 同根 drift 跨视角对齐模板首次实施期复用（Meta 31 立 feedback 升格后 / 元复利验证）/ design+code 单 phase 内联动模板第 2 实证（phase397 首发）|
| ~~B.1 TOOL_PROFILES 字符串硬编码~~ | drift | **✅ closed（phase347）** | const 化完成 |
| ~~B.2 L3 tools SkillRegistry value-import 治理（dispatch / skill）~~ | drift | **✅ closed（phase285）** | SkillSystem L5→L2 后无跨层问题 |
| ~~A.location-1 Tools 模块物理位置 cross-layer leak~~ | layer drift / 中 | **✅ closed（phase431 / main `d49ccb5d`）** | **应然** = L2 Tools 模块 = `src/foundation/tools/`。phase431 实施 4 阶段同 commit：(1) git mv 15 files `src/core/tools/{9 root + builtins/6}.ts` → `src/foundation/tools/`（保 history）(2) 内部相对 import path 修（dir 深度变化 / `'../../foundation/'` → `'../'`）(3) 28 caller files import path cascade（各深度 sed batch）(4) **同步消除 phase428 残留 cross-layer**：foundation/file-tool/ 4 file 内 `'core/tools/'` → `'tools/'`（同层）/ 0 行为改 / 1370+ 测试 PASS / **foundation/ 0 反向 cross-layer to core/ 验证通过** / **scope 收紧**：ToolProtocol 类型抽出独立模块推 phase 432 评估（Tool/ToolResult/ExecContext 保留 in foundation/tools/executor.ts）+ builtins/ 业务工具 redistribute 推 r+1+（send/skill/status 暂留 foundation/tools/builtins/）|
| **A.spec-1 应然 single `Tools` interface ↔ 实然 split `ToolRegistry` + `IToolExecutor`** | spec drift / 大 | **closed**（phase414c L2c audit / interfaces/l2c.md align 实然 split structure）| 历史 interfaces 写单一 `Tools` interface (`register(tool, allowedCallers)` / `schemas(caller)` / `dispatch(caller, toolUse)`) / 实然结构性拆 `ToolRegistry` interface + `IToolExecutor` interface 双角色 + `ToolRegistryImpl` / `ToolExecutorImpl` / `ToolExecutor extends ToolExecutorImpl` 三层类继承 / 权限模型完全不同 (应然 per-register `allowedCallers: string[]` vs 实然 Tool 元数据 readonly+idempotent+supportsAsync? + ToolProfile filter + ExecContext.callerType) / phase414c interfaces/l2c.md 修订 align 实然 split + permission model + 删 ToolUse / ToolPermissionError 应然幻象 |

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| **B.3 ReportResultTool 归属讨论** | design-gap / 应然 silent | 当前归 Tools（verifier 机制层 / 防脆弱 JSON parse 通用机制）/ 候选归 ContractSystem 业务工具 / 推 design phase 评估 |
| **B.5 ExecContext 17 字段 vs KD#29 「4 字段」设计意图** | 应然漂移 / 历史登记错误 | 「ExecContext 4 字段」是 KD#29 phase289 移除 4 业务字段后的描述简化 / 非实然字段总数 / 实然 14 字段（含 getter / methods 共 17 项）/ 历史 dispatch table 引用此「4 字段」时混淆设计意图与实然总数（ToolExecutorImpl.taskSystem 字段 撤销错误登记同根因）|
| **A.X-1 修复后回归测试要求**（待 fix）| 测试承诺 | tests 必须经实际 dispatcher / executor / spread 等中间层（不直调 tool / class.method）/ 否则伪绿（feedback_test_fixture_fidelity 同根）|

### 7.C 应然原则对照

> 仅列**应然**对各原则的承诺立场。

#### Module Logic Principles（11 条）

- **M1 独立可变职责**：工具框架机制层 / 与具体业务工具语义独立可变
- **M2 业务语义归属**：「机制」由 Tools own / 「业务」由各业务模块 own / α.1 决策（KD#27）
- **M3 资源归属**：无磁盘资源 / ToolRegistry 是运行期派生态
- **M4 持久化**：N/A
- **M5 依赖单向**：Tools → L2 ToolProtocol（type schema）+ L2 AuditLog（per arch §15 表 1）/ 0 反向 / KD#29 移除 capability 协议后无跨层 type 依赖
- **M6 依赖结构稳定**：Tool / ToolRegistry / IToolExecutor / ExecContext interface 稳定 / phase289 KD#29 + phase347 KD#29 物理迁是 non-breaking 收敛
- **M7 耦合界面稳定**：framework + 工厂稳定（createToolRegistry / createToolExecutor）
- **M8 耦合界面最小**：Tool 协议 7 字段 / Registry 7 方法 / Executor 3 方法
- **M9 显式表达编译器可检**：`ToolName` union type（phase347）/ `CallerType` / `ToolProfile` 强类型 / `TOOL_PROFILES` 编译期可检 / **A.X-1 例外**（class 原型方法非 own property / spread 丢失不可在编译期检测）
- **M10-M11**：未触发

#### Design Principles（11 条 / #1 展 4 面）

- **D1a 信息不丢失** / **D2 不得丢弃/静默**：工具内部错误包成 ToolResult 不 rethrow / agent 继续 / `tool_exec` audit 留痕
- **D1b 状态可观察**：`tool_exec` + `tool_async_start` audit 事件
- **D1c 中断可恢复**：超时 + signal 合并 / `Promise.race` 提前抛
- **D1d 事后可审计**：audit 事件全链覆盖
- **D3 用户可观察**：audit 事件流可聚合
- **D5 日志重建**：tool_exec 事件序列可重建 agent 工具调用链路
- **D7 系统可信路径**：受信组件
- **D8 事件驱动**：被动框架 / 不发事件
- **D11 CLI 唯一对外**：N/A
- **D4 / D6 / D9 / D10**：无关

#### Philosophy（4 条）

- **P1 Agent 即目录**：N/A（机制层不涉及 agent dir）
- **P2 上下文工程**：`ctx.dialogMessages` 透传 / supportsAsync 路由保留 LLM 上下文
- **P3 分多个智能体加分子任务**：单 framework 服务全部 caller 类型（claw / subagent / dispatcher / 等）
- **P4 系统为智能体服务**：framework 提供 caller 权限 / 超时 / signal / audit 五维基础设施

#### Path Principles（6 条）

- **Path #1 实测核**：治理动作要 grep 实然代码佐证
- **Path #2 §A 显式登记**：违规明文上墙
- **Path #3 APPEND 不解构**：契约修订加节不重写
- **Path #4 破坏性论证**：API 改动 caller 评估
- **Path #5 默认拆**：能力扩展优于职责合并
- **Path #6 停下报告**：scope 模糊或决策点必停报告

### 7.D 历史纪律

详 phase155D / phase163 / phase169 / phase177 / phase180 / phase199 / phase212 / phase217 / phase252 / phase285 / phase287 / phase289 / phase296 / phase347 / phase350 各 phase 收尾报告。

关键里程碑：
- phase212 createToolRegistry 工厂引入（main `5968b3a`）
- phase217 createToolExecutor 工厂引入（main `b93d00a`）
- phase252 B.4 ToolExecutor.getExecContext() auditWriter 注入闭环
- phase285 B.2 SkillRegistry value-import 治理（SkillSystem L5→L2 后清零）
- phase287 KD#29 Step A：spawn / dispatch / ask-motion 物理迁 src/core/task/tools/（main `11c9aec`）
- phase289 KD#29 Step B：ExecContext 4 业务字段移除 + §5.1 capability 协议清单删除（main `9013f2b`）
- phase296 SkillRegistry value-import 剩 2 处闭环（main `fb024ca`）
- phase337 TaskScheduler port 引入（消费方 own / SubAgent 仅 forward）⚠ STALE 2026-05-03 推翻：port 是 design work-around / 应然真合规 = SubAgent 同步循环 0 dep TaskSystem / dispatch/spawn 工具 TaskSystem own + 装配注入 SubAgent.tools / 详 feedback_governance_workaround_smell
- phase347 KD#29 物理迁移 + profiles.ts const 化 + tool-names.ts 集中定义
- phase350 r44 A：ToolExecutorImpl.taskSystem 字段 错误登记撤销 + IGNORE_PATTERN 双向 mutual drift 闭环
- r60+ 重编号：9 节 → 8 节，每节 derive 自一条 Module Logic Principle（删原 §2 接口 / §5 上游依赖 / §6 不可消除耦合 → 已并入 interfaces/l2c.md / 拆原 §1 所有权 hub 为 §1 职责 + §2 业务语义 + §3 资源 + §4 持久化 / 删原 §7 内部不变式 杂物筐 → 行为级回 §1.做、anchor 性质回 §7.A）

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| KD#27 Tools α.1 声明式归属（不持业务工具语义）| ✓ phase173 决策 / α.2 物理搬迁作为远期优化不做 |
| KD#28 SkillSystem L5→L2 重分类 | ✓ phase173 + phase180（关联 l2_skill_system）|
| KD#29 移除 capability 协议机制 | ✓ phase287 + phase289 闭环 |
| KD（phase347）KD#29 物理迁 + profiles 类型化 | ✓ |
| KD（r44 A）ToolExecutorImpl.taskSystem 字段 撤销错误登记 | ✓ phase350 |

## 8. 测试覆盖

应然行为应有测试覆盖：

- **Tool 协议**：name / schema / readonly / idempotent / supportsAsync 全字段
- **Registry 路径**：register / unregister / get / has / getAll / getForProfile / formatForLLM
- **Executor 路径**：execute / executeParallel / validateArgs / 超时 / signal 合并 / async 路由
- **ExecContext**：caller 身份 / 步数 / 中断 / fs/llm/auditWriter 注入 / isMotionChain getter / getElapsedMs / incrementStep
- **审计事件回链**：tool_exec / tool_async_start 触发时机+载荷断言

**测试 fidelity 要求**（A.X-1 教训 / `feedback_test_fixture_fidelity`）：

- 测试必须经**实际 dispatcher / executor / spread 等中间层** / 不直调 `tool.execute(args, ctx)`
- 直调测试**绕过** executor 的 `{...ctx}` spread 路径 = 伪绿（漏检 ExecContext 类原型方法丢失 bug）
- A.X-1 修复后必须新增端到端测试（强制经 ToolExecutor 调用）
