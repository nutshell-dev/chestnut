# Interfaces — 跨模块代码层级接口契约

> 本文档族集中表达 clawforum 跨模块的代码层级接口契约（type-only）加对外承诺（调用方使用规则、边界声明、不可消除耦合理由）。不写实现，不写应然推导（应然推导见 `architecture.md`），不写模块内部细节（内部应然见 `modules/<module>.md`）。

## §0 元说明

### 文档定位（design/ 文档分工）

| 文档 | 内容 |
|---|---|
| `principles.md` | 原则（Philosophy、Design Principles、Module Logic Principles、Path Principles） |
| `architecture.md` | 架构（各层定位、能力归属、模块本质加层归属、系统拓扑、模块 fact 表） |
| **`interfaces.md` 加 `interfaces/*.md`（本文族）** | 模块对外承诺（type-only 接口签名、调用方使用规则、边界声明、不可消除耦合理由） |
| `modules/*.md` | 单模块内部 spec（内部职责、内部 type、内部 events、持久化布局、drift 登记） |
| `practices.md` | 治理实践（drift 登记、const 抽取、测试断言、契约书写等从 phase 推导出的判据与做法） |
| `adr/` | 关键设计决策的鲜活历史记录 |
| `archive/` | 历史快照归档（modules/*.md 等结构性大改前的版本快照，仅供溯源 / 不入应然 derive 链）|

### 接口收录标准

**每个跨模块接口必有单一 own 方**（M#3 资源唯一归属）。「不归任何模块 own 的 shared 协议」= 设计缺陷，不收录此类。

收录条件（满足任一）：

1. **Capability**：一个模块 own 的能力接口，其他模块消费。
2. **Callback signature**：控制流 hook，own 方定义 signature，调用方实现。
3. **Type-level const / 跨模块共享常量**：模块 own 的常量对外承诺值（如 `IGNORE_PATTERN`、`DISPATCH_SKILLS_DIR`），消费方 import const ref 而不字面量重复 — 收录在该 const 所属模块的接口节内（M#9 编译期可检 derive）。

**不收录**：

- 错误类形状（仅类型形状，无协议含义）→ 归各模块 `modules/*.md`。
- 模块内部接口（仅模块自身使用）→ 归 `modules/*.md`。
- 模块内部 const（仅模块自身使用 / 0 跨模块 caller）→ 归 `modules/*.md` §3 资源。

### 每接口描述模板

```
## <接口名> [<inline attributes>]

**生产方**：<模块名>

**消费方**：
- <模块名>（<消费模式>，<可选简注>）

**接口签名**：（type-only，含 doc 字符串覆盖失败语义加调用约束）

**归本模块**：（本模块单一职责加业务语义加唯一资源入口）

**不归本模块**：
- <不归本模块的事>，归 <X>

**不可消除耦合理由**：（直接 derive 自相关 Module Logic Principles 加 Design Principles）
```

> **注**：仅写模块名，不写 src 代码路径（路径是实现细节，归 `modules/*.md` 内部）。

**Inline attribute** 取值：

- 性质：`capability` 或 `callback signature`。
- 消费模式：`direct`（函数或类型直 import）或 `DI`（装配期注入 instance，含 factory 与 new class 实施）。同接口可能两种模式并存，用 `+` 连接（如 `[capability, direct + DI]`）。

示例：
- 单模式：`[capability, DI]` — 仅装配期注入（如 LLMProvider）
- 多模式：`[capability, direct + DI]` — 既可直 import 也可装配注入（如 ProcessExec / FileSystem）
- callback hook：`[callback signature]` — own 方定义 signature / 调用方实现

### Module Logic Principles 落实

| 原则 | 在本文档体现 |
|---|---|
| **M#1** 单一职责 | 「归本模块」字段显式描述模块单一职责 |
| **M#2** 业务语义归属 | 「归本模块」加「不归本模块」对仗，业务语义边界显式 |
| **M#3** 资源唯一归属 | 「归本模块」含「业务模块要用本资源必经本模块」derive，每接口 own 方单源登记 |
| **M#5** 单向依赖 | 按 own 方 layer 分文件。生产方加消费方表达 layer 关系 |
| **M#6** 依赖结构稳定 | 消费方清单显式 |
| **M#7** 耦合界面稳定 | 接口签名 type-only，不暴露内部实现 |
| **M#8** 最小耦合 | type-only 签名只暴露最小集合 |
| **M#9** 显式表达 + 编译器可检 | type 签名优先，inline attribute 标性质，不可消除耦合理由显式 |
| **M#4** 持久化 | 不直接体现于本文档（type-only 接口签名 / 持久化布局归 `modules/*.md` §4）|
| **M#10** 不合理停下 | 不直接体现于本文档（过程纪律 / drift 登记归 `modules/*.md` §7.A）|
| **M#11** 边界对不上停下 | 不直接体现于本文档（过程纪律 / 同 M#10 / 归 `modules/*.md` §7.A）|

---

## §1 接口（按 own 方 layer 分文件）

| 文件 | 层 | 模块 |
|---|---|---|
| [l1.md](interfaces/l1.md) | L1 原语 | FileSystem、ProcessExec、LLMProvider、Transport、FileWatcher |
| [l2a.md](interfaces/l2a.md) | L2 通用基础设施 | AuditLog、Snapshot、ProcessManager |
| [l2b.md](interfaces/l2b.md) | L2 LLM 协议层基础设施 | DialogStore、Stream、LLMOrchestrator、ToolProtocol |
| [l2c.md](interfaces/l2c.md) | L2 agent 业务概念基础设施 | Messaging、SkillSystem、Tools、FileTool、CommandTool |
| [l3.md](interfaces/l3.md) | L3 agent 原语 | StepExecutor、AgentExecutor、SubAgent |
| [l4.md](interfaces/l4.md) | L4 agent 基础设施 | TaskSystem、ContractSystem、MemorySystem、EvolutionSystem |
| [l5.md](interfaces/l5.md) | L5 服务 | Runtime、Cron、Gateway |
| [l6.md](interfaces/l6.md) | L6 进程边界 | Daemon、CLI、Watchdog、Assembly |
