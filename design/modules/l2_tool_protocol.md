# ToolProtocol 模块内部契约

> 本文档限本模块**内部**应然 — type-only schema 模块（无 runtime / 无 audit events / 仅 schema 定义）。8 节结构 derive 自 Module Logic Principles：§1-§4 = M#1-#4 各占一节，§5 审计 = M#3 命名空间细则（type-only N/A），§6 层级，§7 drift = M#10/#11，§8 测试。
> 跨模块对外承诺（接口签名、生产/消费方、归本模块加不归本模块、不可消除耦合理由）见 [interfaces/l2b.md](../interfaces/l2b.md) ToolProtocol 节。
> 模块本质加层归属见 [architecture.md](../architecture.md)。

## 1. 职责（M#1 独立可变职责）

> 本节内容 derive 自 [architecture.md](../architecture.md) §12「ToolProtocol 本质：LLM 工具调用协议的 schema 抽象 / L2 LLM 语义基础设施 / 对接 LLM messages 中 tool_use/tool_result 协议」加 M#1 / M#3 / M#7。

### 做

应用 M#1（一个模块封装一组独立可变的职责），ToolProtocol 的单一职责 = **LLM tool calling 协议 schema 的单一定义方**：

- **Tool 接口 schema**：name 加 description 加 inputSchema 加 execute 方法签名 — 业务模块实现此接口提供工具。
- **ToolResult schema**：success 加 content 加 metadata 形状 — 业务模块返回此形状。
- **JsonSchema type alias**：input schema 的 type 别名。
- **ToolExecContext interface**：execute 调用上下文 schema（装配期注入字段，本协议不预设具体字段集 — 实际 ExecContext 字段集由 L2 Tools own）。

> 具体 API 形态归 [interfaces/l2b.md](../interfaces/l2b.md) ToolProtocol 节。

### 不做

- **不 own runtime 注册表**（归 L2 Tools — ToolRegistry / 派发 / 超时 / signal 合并 / audit）— derive 自 M#1
- **不 own 调用派发**（tool_use 派发到 handler 加超时加 audit 归 L2 Tools）— derive 自 M#1
- **不 own caller 权限决策**（哪个 caller 能用哪个工具归 L6 Assembly 装配期 own 加注入 L2 Tools）— derive 自 M#5
- **不 own 业务工具实现**（read / write / exec 等具体工具由各业务模块 own）— derive 自 M#1 + M#2
- **不 own ExecContext 具体字段集**（caller 身份加基础设施依赖句柄归 L2 Tools own / 本协议仅留 interface 占位）— derive 自 M#1

## 2. 业务语义（M#2 业务语义归属）

> 应用 M#2（模块为自己的业务语义负责），ToolProtocol 的业务语义边界：

- **own**：LLM tool calling 协议 schema 概念（Tool / ToolResult / JsonSchema / ToolExecContext）。
- **角色定位**：纯 schema 定义方 / 让业务模块加 Tools 框架都依赖此 schema 形状 — 是 schema 唯一真源。

## 3. 资源（M#3 资源唯一归属）

> 应用 M#3（每种资源只归属唯一模块），ToolProtocol 独占的资源：

| 资源 | 类别 | 持久化 |
|---|---|---|
| 无 | type-only | ✗ 无 runtime instance / 无磁盘 artifact / 无 mem state |

**schema 单源** — clawforum 内部任何 LLM tool calling 协议 schema 必经 ToolProtocol / 是 schema 唯一归属。

> 注：(1) 不占用 audit 命名空间（type-only 模块无运行期事件）/ (2) Tool / ToolResult / JsonSchema / ToolExecContext interface 是 type-only schema（实施细节归 §1.做 / 非 M#3 业务资源 / 资源粒度论：type-only 模块「资源」是 schema 单源归属本身）。

## 4. 持久化（M#4）

> 应用 M#4（持久化一切信息到磁盘 / 运行时句柄从磁盘信息重建），ToolProtocol 的持久化立场：

- **type-only schema**：无任何持久化需求 / 无重建语义 / 编译期 type 检查保证。

## 5. 审计事件清单

**ToolProtocol 不产生 audit 事件**（type-only / 无 runtime）。

工具调用 audit 事件（`tool_exec` / `tool_async_start`）归 [l2_tools.md](l2_tools.md) §5。

## 6. 层级声明

L2 LLM 语义基础设施 / 纯 schema 模块（与 DialogStore / Stream / LLMOrchestrator 同层）。详见 [architecture.md](../architecture.md) 加 [interfaces/l2b.md](../interfaces/l2b.md)。

## 7. 应然 vs 实然差距登记（M#10 / M#11）

> 原则：本节只登记**实然 ≠ 应然**的 gap（待治理或已治理的历史）+ 偏差 + 历史纪律。当前实然若与应然 align 则不在此登记。

### 7.A 必修违规（含历史已闭环）

| §A 条 | 类型 | 状态 | 触发情境 |
|---|---|---|---|
| ~~A.1 ToolProtocol type 物理位置 cross-layer 反向~~ | layer drift / 中 | **✅ closed（phase435 / main `7c64bc3f`）** | 应然 = L2 ToolProtocol = 独立 type-only 模块 / 物理位置 `src/foundation/tool-protocol/`。phase435 实施 4 阶段同 commit：(1) NEW `src/foundation/tool-protocol/` dir + git mv `caller-type.ts` 进入（保 history）+ NEW `index.ts` (2) source split：`Tool` / `ToolResult` / `ExecContext` interface 物理迁 `src/foundation/tools/executor.ts:42-93` → `src/foundation/tool-protocol/index.ts` + executor.ts 改 import from `'../tool-protocol/index.js'` + 保留 ToolRegistry/IToolExecutor 框架 type + impl 类 (3) 26 caller files import path cascade（mixed import 手 Edit + sed batch）(4) 删 `tools/index.ts` 临时 shim / 0 行为改 / 1370+ 测试 PASS / **L2 应然 align 7 全收清单延伸**（phase420 SkillSystem + phase423 DialogStore + phase425 PM 工厂 + phase428 FileTool + phase431 Tools + phase433 CommandTool + 本 phase ToolProtocol = 7/7 收）/ M#1 单一职责（schema 与 dispatch 框架独立可变）+ M#3 资源唯一归属（schema 资源不嵌入 dispatch 模块）双 align |
| **A.2 应然 `inputSchema` ↔ 实然 `schema` field 名 drift** | naming drift / 低 | **closed**（phase414c L2b audit / interfaces/l2b.md align 实然 `schema`）| 历史 interfaces 写 `Tool.inputSchema` / 实然 code 用 `Tool.schema` (executor.ts:88) / phase414c interfaces/l2b.md 修订 align 实然名 / 同步删 `JsonSchema` alias 改 `JSONSchema7` 名 align |
| **A.3 应然 `ToolExecContext` (generic) ↔ 实然 `ExecContext` (rich type) drift** | type shape drift / 中 | **closed**（phase414c L2b audit / interfaces/l2b.md align 实然 ExecContext rich type）| 历史 interfaces 写 `ToolExecContext { [key: string]: unknown }` (generic) / 实然 `ExecContext` 14+ 强类型字段 (clawId / clawDir / fs / llm? / profile / signal? / dialogMessages? / 等) / phase414c interfaces/l2b.md 修订 align 实然 / 同步登记 `CallerType` + `ToolProfile` type alias |

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| **L2b.G1 (tool-protocol)** arch 表 1 依赖列「无」未列 type-only L1 LLMProvider type 依赖 | **业务决策性 design-gap / r65 起 cross-doc audit 浮出**：interfaces/l2b.md line 409 注「`Message` / `ToolDefinition` 来自 [L1 LLMProvider](./l1.md#llmprovider-capability-di)（LLM 协议层 type 单源）」/ ToolProtocol type-only 但实际 import L1 LLMProvider type / arch 表 1 ToolProtocol row 依赖列「无」未反映 type-only dependency | **业务决策性 / 用户拍板候选**：α arch 表 1 依赖列改「无 runtime / type-only 依赖 L1 LLMProvider (Message + ToolDefinition)」/ β arch 表 1 资源列加备注「依赖 L1 LLMProvider type / 全 type-only / 无 runtime cycle」/ γ 保留现状（type-only 依赖通常不算 dep / 无 runtime 影响）|
| **L2b.G2 (tool-protocol)** arch 表 2 不提 ExecContext 装配期固定字段集 | **业务决策性 design-gap / r65 起 cross-doc audit 浮出**：interfaces/l2b.md 暴露 ExecContext 含 16 字段 (clawId/clawDir/contractId/callerType/fs/llm/profile/stepNumber/maxSteps/signal/subagentMaxSteps/dialogMessages/originClawId/isMotionChain/getElapsedMs/incrementStep/auditWriter) + 注「装配期固定字段集（L4+ 业务工具 caller universe 共享）」/ arch 表 2 ToolProtocol row 仅写「Tool 接口 schema、ToolResult 形状（type-only）」/ 未列 ExecContext / arch 与 interfaces 缺一类核心 type | **业务决策性 / 用户拍板候选**：α arch 表 2 改「Tool 接口 schema + ToolResult 形状 + ExecContext 装配期固定字段集（type-only）」/ β 保留现状（ExecContext 是 caller-side schema / Tool 协议核心仅 Tool+ToolResult）|

### 7.C 应然原则对照

> 仅列**应然**对各原则的承诺立场。

#### Module Logic Principles（11 条）

- **M#1 独立可变职责**：纯 schema 单源 / 与 runtime 注册派发独立可变
- **M#2 业务语义归属**：own LLM tool calling 协议 schema 概念
- **M#3 资源归属**：type-only / 无磁盘资源 / schema 单源
- **M#4 持久化**：N/A（type-only）
- **M#5 依赖单向**：ToolProtocol type-only / 自身 0 业务依赖（per arch §12 表 1 deps=无）/ 被 L2 Tools + L2 FileTool / CommandTool + 各业务工具模块依赖
- **M#6 依赖结构稳定**：Tool / ToolResult / JsonSchema / ToolExecContext interface 稳定
- **M#7 耦合界面稳定**：schema 形状稳定 / 加字段需 non-breaking
- **M#8 耦合界面最小**：4 type 定义最小覆盖
- **M#9 显式表达编译器可检**：Tool / ToolResult / JsonSchema interface 编译期可检 ✓ / **`ToolExecContext { [key: string]: unknown }` 是显式开放 type / 字段集编译期不可检（结构性限制）**：本协议留 interface 占位 / 实然字段由 L2 Tools own + Assembly 装配期注入 / Tool 实现期消费 ctx 字段需运行期约定（不是编译期约束）/ 灰度 acceptable（type-only schema 模块的开放 type 是设计意图 / 与 Tools framework 解耦 / Tools own 14 字段）
- **M#10 不合理停下** / **M#11 边界不对停下**：N/A

#### Design Principles（11 条 / #1 展 4 面）

- **D7 系统可信路径**：受信组件
- **D1 / D2 / D3 / D4 / D5 / D6 / D8 / D9 / D10 / D11**：N/A（type-only schema 不涉及运行期信息流）

#### Philosophy（4 条）

- **P1 Agent 即目录**：N/A
- **P2 上下文工程**：N/A
- **P3 分多个智能体加分子任务**：单 schema 服务全部业务工具实现 / 多 agent 复用同 schema
- **P4 系统为智能体服务**：schema 单源支撑工具调用基础设施

#### Path Principles（7 条）

- **Path #1 路径规划基于规划时刻的事实**：治理动作要 grep 实然代码佐证（注意实施过程中实然的变化）
- **Path #2 实然和应然差距显式登记**：违规明文上墙（在路径规划时参考 / §7.A + §7.B）
- **Path #3 语义原子变更单元**：契约修订 APPEND 加节不重写 / 1 phase = 1 commit 原子
- **Path #4 可回滚 + 破坏性论证**：schema 改动 caller 评估 / 破坏性改动显式论证
- **Path #5 完成后复盘**：phase 收尾三维 + Path Principles 第 4 维对账
- **Path #6 冲突立即中断**：scope 模糊或决策点必停报告（冲突调整优先于强行推进）
- **Path #7 总难度路径**：实然到达应然有诸多路径 / 选择降低总难度的（步骤间有相互作用 / 总难度 ≠ 各步骤成本简单相加）

### 7.D 历史纪律

- r61+ 从 L2 Tools 拆出 ToolProtocol（schema 单源独立成模块 / 与 Tools framework 独立可变 / Tool interface 加 ToolResult schema 加 JsonSchema 加 ToolExecContext interface 物理迁出）
- 2026-05-04 / cross-doc audit drift 修订（Module Logic 命名 M1-M11 → M#1-M#11 / §3 资源改 table 「无 type-only」+ 注脚 align 其他模块 / 注：§7.C P3 verbatim + Design Principles silent 集合 已合理）
- 2026-05-03 / phase 414c interfaces L2b audit（A.2 + A.3 closed）：interfaces/l2b.md 修订 align 实然 `Tool.schema`（不是 inputSchema）+ JsonSchema → JSONSchema7 + ExecContext rich type 14+ 强类型字段（不是 ToolExecContext generic）+ 加 CallerType + ToolProfile type alias / 删应然幻象描述
- 2026-05-04 / phase 435 ToolProtocol 物理迁闭环（main `7c64bc3f`）/ NEW `src/foundation/tool-protocol/` dir + git mv `caller-type.ts` 进入 + source split `Tool` / `ToolResult` / `ExecContext` interface 物理迁 `src/foundation/tools/executor.ts:42-93` → `src/foundation/tool-protocol/index.ts` + 26 caller files import path cascade + 删 tools/index.ts 临时 shim / A.1 closed / **L2 应然 align 7/7 全收清单完结**（phase420 SkillSystem + phase423 DialogStore + phase425 PM 工厂 + phase428 FileTool + phase431 Tools + phase433 CommandTool + 本 phase ToolProtocol = 7/7）/ M#1 单一职责（schema 与 dispatch 框架独立可变）+ M#3 资源唯一归属（schema 资源不嵌入 dispatch 模块）双 align
- 2026-05-05 / r65 cross-doc audit 单 doc 一致性核（modules/l2_tool_protocol.md vs arch §12 + 表 1/2 + interfaces/l2b.md ToolProtocol 节）/ 0 derive drift / 主 derive 全 align（M#1-M#9 + Design Principle D7 + 其他 N/A + Philosophy P3+P4 + Path #1-#7 / type-only schema 模块）/ 2 主能力 align arch 表 2（Tool 接口 schema + ToolResult 形状）/ 资源「无 type-only」align arch 表 1 / 补 phase414c+435 closure timeline entry / L2b.G1 type-only L1 LLMProvider type 依赖 + L2b.G2 ExecContext 装配期固定字段集 design-gap 已登记 §B（业务决策性 α/β/γ 候选）/ design only / 0 src 改

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| KD（r61+）ToolProtocol L2 type-only schema 模块 / Tool / ToolResult / JsonSchema / ToolExecContext schema 单源 | ✓ M#1 真合规 |

## 8. 测试覆盖

- **Tool 接口 schema**：业务模块实现此 interface 应可注册到 Tools registry
- **ToolResult schema**：业务模块返回此形状应被 Tools router 透明派发
- **type-only**：编译期 type 检查保证（无 runtime test）
