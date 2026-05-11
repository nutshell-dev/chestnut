# ADR 0004 — modules.md 关键决策 30 条

**状态**：已采纳（持续演进）
**决策者**：用户 + agent 协作
**来源**：clawforum/design/modules.md §关键设计决策

## Context

clawforum 的模块架构（27 模块 / 6 层）在 r17-r29 重构过程中积累了 30 条关键设计决策。这些决策散在 modules.md 的 §关键设计决策 节，但缺乏独立可检索的 ADR 载体。本 ADR 将它们索引为独立条目，便于跨会话引用和未来复审。

## Decision

以下 30 条决策按 modules.md 编号索引。每条含决策内容 + 原则依据 + 状态。完整论述见 `design/modules.md` 原文。

### 执行层（L1-L3）

| # | 决策 | 原则依据 | 状态 |
|---|---|---|---|
| 1 | 工具 handler 装配期注入 StepExecutor | M#2（模块 own 业务语义）| 生效 |
| 2 | FileSystem 权限域（agentFs + trustedFs）| M#3（资源唯一归属）| 生效 |
| 3 | SessionStore 不绑目录（base path 由调用方决定）| M#1（独立可变职责）| 生效 |
| 4 | StepExecutor 只跑一步，循环归 AgentExecutor | M#1（独立可变职责）| 生效 |
| 10 | Stream + AuditLog 拆分 | M#1（独立可变职责）| 生效 |
| 11 | Transport 独立原语（第三种 I/O） | M#5（依赖单向）| 生效 |
| 12 | Gateway 桥接 Stream 与 Transport | M#8（耦合界面最小）| 生效 |
| 13 | 回调注入是显式耦合 | M#9（不可消除耦合显式）| 生效 |
| 14 | 中断信号走 Gateway → 回调 | M#5（信息流单向）| 生效 |

### 任务层（L4）

| # | 决策 | 原则依据 | 状态 |
|---|---|---|---|
| 5 | ~~SubagentSystem 合并 TaskRunner~~ **已废止** | 违反 M#1 / phase173 修正 | 废止 |
| 6 | dispatch 和 spawn 独立工具，归属 TaskSystem(L4) | M#1 + M#2 | 生效 |
| 30 | ContractSystem LLM 验收经 TaskSystem 调度 | M#1 + D1/D4 | 生效 |

### 入口层（L5-L6）

| # | 决策 | 原则依据 | 状态 |
|---|---|---|---|
| 7 | 智能体通过 CLI 操作系统 | Philosophy（CLI 唯一对外入口）| 生效 |
| 8 | ContractSystem 低频操作走 CLI | M#8（耦合界面最小）| 生效 |
| 15 | Assembly 是装配汇聚点，Daemon 只做进程生命周期 | M#1（独立可变职责）| 生效 |
| 16 | 事件驱动循环归 Runtime | M#1（独立可变职责）| 生效 |
| 17 | ProcessManager 独立于 Daemon | M#1 + M#3 | 生效 |
| 18 | Watchdog 是 L6 入口 | Philosophy（可观察）| 生效 |
| 24 | Motion 不是模块，是 identity 配置分支 | M#1（不是独立可变职责）| 生效 |

### 装配与拓扑

| # | 决策 | 原则依据 | 状态 |
|---|---|---|---|
| 9 | 配置是数据不是模块 | M#1（配置变更源 ≠ 模块变更源）| 生效 |
| 19 | Snapshot 轮级快照（非步级）| 性能权衡 | 生效 |
| 20 | 工具实现可走进程内 CLI 调用 | M#8（耦合最小）| 生效 |
| 21 | CLI 是所有进程外使用者的统一入口 | Philosophy | 生效 |
| 22 | ProcessManager 是库代码，PID 策略唯一归属 | M#2 + M#3 | 生效 |
| 23 | 装配职责三分（模块/Assembly/Daemon）| M#1（独立可变）| 生效 |
| 25 | Runtime 不自建 L1-L2 实例 | M#5 + M#8 | 生效 |
| 26 | 用户 ↔ motion ↔ claw 中介模型 | Philosophy（可观察 + CLI 入口）| 生效 |
| 27 | Tools α.1 声明式归属（框架 vs 业务工具）| M#2 | 生效 |
| 28 | SkillSystem 归 L2 基础设施 | M#5（消除 L4→L5 反向）| 生效 |
| 29 | 移除 capability 协议机制 | M#1 + M#2 + M#5 | 生效 |

### 已废止

| # | 决策 | 废止原因 |
|---|---|---|
| 5 | SubagentSystem 合并 TaskRunner | 违反「执行原语 vs 生命周期管理 = 独立可变职责」/ phase173 修正 |

## Consequence

### 正面

- **可检索**：30 条决策独立编号 / 跨会话引用时用 `#N` 即可
- **可复审**：每条附原则依据 / 未来原则演进时可逐条再审
- **变更追踪**：新增/废止决策在此 ADR 中有明确记录

### 负面

- **维护成本**：modules.md 原文更新时需同步此 ADR（但 ADR 本身是引用索引 / 不重复论述）
- **不替代 modules.md**：本 ADR 是索引 / 详细论述仍以 modules.md 为准

## 参考

- `design/modules.md` §关键设计决策（权威来源）
- `design/principles.md`（M#1-M#11 原则定义）
- `feedback_primitive_vs_lifecycle_split.md`（#5 废止教训）
- `feedback_default_split_not_merge.md`（#5 废止教训）
