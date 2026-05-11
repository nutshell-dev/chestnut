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

- **type-only**：无 runtime instance / 无磁盘 artifact / 无 mem state。
- **schema 单源**：clawforum 内部任何 LLM tool calling 协议 schema 必经 ToolProtocol — 是 schema 唯一归属。
- **不占用 audit 命名空间**：type-only 模块无运行期事件。

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
| **A.1 ToolProtocol type 物理位置 cross-layer 反向** | layer drift / 中 | open（phase414c L2b audit 登记 / 推 r+1 phase 物理迁）| **应然** = L2 ToolProtocol = 独立 type-only 模块 / 物理位置应在 `src/foundation/tool-protocol/` (与其他 L2 模块同层 pattern)。**实然** = `Tool` / `ToolResult` / `ExecContext` 接口定义在 `src/core/tools/executor.ts` (L4 dispatch 模块同文件)。这违反 M#5 单向依赖（L4 模块同时 own L2 schema definition）+ M#3 资源唯一归属（schema 资源不应嵌入 dispatch 模块）/ 应然权威 = arch §12 + 表 1 「ToolProtocol L2」/ 治理：r+1 phase 物理迁 type to `src/foundation/tool-protocol/` + `src/core/tools/executor.ts` 改 import |
| **A.2 应然 `inputSchema` ↔ 实然 `schema` field 名 drift** | naming drift / 低 | **closed**（phase414c L2b audit / interfaces/l2b.md align 实然 `schema`）| 历史 interfaces 写 `Tool.inputSchema` / 实然 code 用 `Tool.schema` (executor.ts:88) / phase414c interfaces/l2b.md 修订 align 实然名 / 同步删 `JsonSchema` alias 改 `JSONSchema7` 名 align |
| **A.3 应然 `ToolExecContext` (generic) ↔ 实然 `ExecContext` (rich type) drift** | type shape drift / 中 | **closed**（phase414c L2b audit / interfaces/l2b.md align 实然 ExecContext rich type）| 历史 interfaces 写 `ToolExecContext { [key: string]: unknown }` (generic) / 实然 `ExecContext` 14+ 强类型字段 (clawId / clawDir / fs / llm? / profile / signal? / dialogMessages? / 等) / phase414c interfaces/l2b.md 修订 align 实然 / 同步登记 `CallerType` + `ToolProfile` type alias |

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

> 当前无登记偏差。

### 7.C 应然原则对照

> 仅列**应然**对各原则的承诺立场。

#### Module Logic Principles（11 条）

- **M1 独立可变职责**：纯 schema 单源 / 与 runtime 注册派发独立可变
- **M2 业务语义归属**：own LLM tool calling 协议 schema 概念
- **M3 资源归属**：type-only / 无磁盘资源 / schema 单源
- **M4 持久化**：N/A（type-only）
- **M5 依赖单向**：ToolProtocol type-only / 自身 0 业务依赖（per arch §12 表 1 deps=无）/ 被 L2 Tools + L2 FileTool / CommandTool + 各业务工具模块依赖
- **M6 依赖结构稳定**：Tool / ToolResult / JsonSchema / ToolExecContext interface 稳定
- **M7 耦合界面稳定**：schema 形状稳定 / 加字段需 non-breaking
- **M8 耦合界面最小**：4 type 定义最小覆盖
- **M9 显式表达编译器可检**：Tool / ToolResult / JsonSchema interface 编译期可检 ✓ / **`ToolExecContext { [key: string]: unknown }` 是显式开放 type / 字段集编译期不可检（结构性限制）**：本协议留 interface 占位 / 实然字段由 L2 Tools own + Assembly 装配期注入 / Tool 实现期消费 ctx 字段需运行期约定（不是编译期约束）/ 灰度 acceptable（type-only schema 模块的开放 type 是设计意图 / 与 Tools framework 解耦 / Tools own 14 字段）
- **M10 不合理停下** / **M11 边界不对停下**：N/A

#### Design Principles（11 条 / #1 展 4 面）

- **D7 系统可信路径**：受信组件
- **D1 / D2 / D3 / D4 / D5 / D6 / D8 / D9 / D10 / D11**：N/A（type-only schema 不涉及运行期信息流）

#### Philosophy（4 条）

- **P1 Agent 即目录**：N/A
- **P2 上下文工程**：N/A
- **P3 分多个智能体加分子任务**：单 schema 服务全部业务工具实现 / 多 agent 复用同 schema
- **P4 系统为智能体服务**：schema 单源支撑工具调用基础设施

#### Path Principles（6 条）

- **Path #1 实测核**：治理动作要 grep 实然代码佐证
- **Path #2 §A 显式登记**：违规明文上墙
- **Path #3 APPEND 不解构**：契约修订加节不重写
- **Path #4 破坏性论证**：schema 改动 caller 评估
- **Path #5 默认拆**：能力扩展优于职责合并
- **Path #6 停下报告**：scope 模糊或决策点必停报告

### 7.D 历史纪律

- r61+ 从 L2 Tools 拆出 ToolProtocol（schema 单源独立成模块 / 与 Tools framework 独立可变 / Tool interface 加 ToolResult schema 加 JsonSchema 加 ToolExecContext interface 物理迁出）

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| KD（r61+）ToolProtocol L2 type-only schema 模块 / Tool / ToolResult / JsonSchema / ToolExecContext schema 单源 | ✓ M#1 真合规 |

## 8. 测试覆盖

- **Tool 接口 schema**：业务模块实现此 interface 应可注册到 Tools registry
- **ToolResult schema**：业务模块返回此形状应被 Tools router 透明派发
- **type-only**：编译期 type 检查保证（无 runtime test）
