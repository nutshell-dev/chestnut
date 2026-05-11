# MemorySystem 模块内部契约

> 本文档限本模块**内部**应然 — 8 节结构 derive 自 Module Logic Principles：§1-§4 = M#1-#4 各占一节，§5 审计 = M#3 命名空间细则，§6 层级，§7 drift = M#10/#11，§8 测试。
> 跨模块对外承诺（接口签名、生产/消费方、归本模块加不归本模块、不可消除耦合理由）见 [interfaces/l4.md](../interfaces/l4.md) MemorySystem 节。
> 模块本质加层归属见 [architecture.md](../architecture.md)。

## 1. 职责（M#1 独立可变职责）

> 本节内容 derive 自 [architecture.md](../architecture.md) §23「MemorySystem 本质：智能体持久化记忆服务（dream 经验提炼 + 记忆查询）/ L4 agent 基础设施 ——『记忆』/ 设计中先不实现」加 M#1 / M#2 / M#3 / M#5 加 Philosophy P2「上下文工程」加 Design Principle「智能体是决策主体」。

### 做（应然）

应用 M#1（一个模块封装一组独立可变的职责），MemorySystem 的单一职责 = **智能体记忆服务**：

- **dream 触发**：deep-dream（per claw 经验提炼）+ random-dream（跨 claw 整合 / motion scope）
- **记忆查询**：`memory_search` 工具（agent-facing）/ 按关键词 / 时间窗 / claw 范围检索
- **记忆持久化**：dream 输出落盘 / 跨 claw 可见
- **去重协调**：避免重复 dream 同一段会话历史

### 不做（应然）

- **不做 LLM 调用主路径**（dream 内部经 L2 LLMOrchestrator）— derive 自 M#5
- **不做 dream 子代理生命周期**（归 L3 SubAgent + L4 TaskSystem）— derive 自 M#1
- **不做定时调度**（dream 触发由 L5 Cron）— derive 自 M#1
- **不做跨进程通信**（dream 结果通知归 L2 Messaging）— derive 自 M#5

## 2. 业务语义（M#2 业务语义归属）

- **own**：「智能体记忆」业务语义唯一发起点 — dream 触发 / 记忆查询 / 跨 claw 记忆共享
- **角色定位**：MemorySystem 是「**记忆基础设施**」非「**dream 执行器**」（dream 子代理实际执行）非「**调度器**」（Cron 触发）
- **装配「按需」**：motion 装跨 claw dream / claw 装 per-claw dream

## 3. 资源（M#3 资源唯一归属）

> 应然 / 待 phase 落地具体目录布局。

- dream 状态持久化（per claw + 跨 claw motion-scope 两类）
- memory 索引（待设计）
- 跨 claw 共享 memory（待设计）

## 4. 持久化（M#4）

- dream 状态落盘 / 跨重启可恢复
- memory 索引落盘
- 具体磁盘布局 / 文件格式 / 重建语义 待 phase 落地

## 5. 审计事件清单

> 事件常量**应然**集中定义于 `src/core/memory/audit-events.ts` `MEMORY_AUDIT_EVENTS`（模块自治）。

应然清单（待 phase 落地后回填具体）：
- `memory_search_invoked` / `memory_search_failed` — 查询
- `dream_triggered` / `dream_completed` / `dream_failed` — dream 主路径
- `memory_dedupe_skipped` — 去重

## 6. 层级声明

L4 agent 业务流程层（与 TaskSystem / ContractSystem / EvolutionSystem 同层 / 「智能体记忆」业务语义独立可变 / 与 EvolutionSystem 同属「经验整合」类业务：MemorySystem 整合会话经验 / EvolutionSystem 整合契约能力）。下游 Assembly（L6）通过工厂消费 + 注入 deps + Cron（L5）触发 dream。详见 [architecture.md](../architecture.md) 加 [interfaces/l4.md](../interfaces/l4.md)。

## 7. 应然 vs 实然差距登记（M#10 / M#11）

> 整模块设计中状态 / 实然部分嵌在 cron jobs（dream 系列）/ 待 phase 落地后系统化迁移。

### 7.A 必修违规

| §A 条 | 类型 | 状态 | 触发情境 |
|---|---|---|---|
| **A.spec-1 应然 stub「设计中, 先不实现」 stale ↔ 实然部分实施** | spec drift / 中 | **closed**（phase414c L4 audit / interfaces/l4.md 升级 stub → 部分实施状态描述）| 应然原 interfaces/l4.md MemorySystem 节写「整体状态 = 设计中, 先不实现 / 详细设计登记见 modules/l4_memory_system.md (设计中 stub)」/ 实然 phase318 (main `5f6b689`) 已实施 `class MemorySystem` + ctor 注入 + `runDeepDream(maxCompressionTokens?)` + `runRandomDream()` + `createMemorySystem` factory + standalone `runDeepDream` / `runRandomDream` 函数 + memory_search 工具 (cross-layer location `src/core/tools/builtins/memory_search.ts`) / 应然 stub 早 phase318 落地后已 stale / phase414c interfaces/l4.md 修订升级 stub → align 实然部分实施状态 + 暴露未实施部分（去重状态 + 业务 spec 细节）|
| **A.location-1 memory_search 工具 cross-layer location** | location drift / 中 | **✅ closed**（phase416 / main `0ff29848`）| 实施落地：`src/core/tools/builtins/memory_search.ts` → `src/core/memory/tools/memory_search.ts` (git mv 保 history) + Assembly register caller 改为 MemorySystem 装配期 register / 测试文件同步迁 / phase360 done 物理迁模板复用 / 物理迁三模板复合第 5 实证 |

### 7.B 偏差登记

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| ~~整模块设计中 / 实然 0 落地~~ | ~~design-gap~~ | **部分闭环**：phase318（main `5f6b689`）模块壳 + 工厂 + dream 物理迁 / **phase412**（cross-layer port + @module 注释修）/ 业务实装（runDream / memory_search）推后续 design phase（spec 业务细节待决策）|
| dream 系列双重归属（cron 触发 + memory 业务）| design-gap / 双重归属保留 | 同 l5_cron A.1 ⚓ accepted-stable |
| ~~random-dream cross-layer~~ ✅ closed | drift / 中 | **✅ closed**（phase424 / main `2bab8042`）| **phase412 错治理反向 + 真合规落地**：删 TaskLifecyclePort interface (runtime-ports.ts:83-94) + 5 caller 直 dep TaskSystem class (memory/system + memory/random-dream + runtime + task/tools/dispatch + tests/core/cron/random-dream) / 同层 L4 → L4 单向完全合 M#5 / 同 phase422 WatchdogPort STALE 推翻模板（port pattern reversal 第 2 例 / cluster 6 port 闭 2）/ feedback_governance_workaround_smell 真合规设计落地 |
| 缺 memory_search 工具 + 索引 | design-gap | 高优 / 与 dream 整合同 phase |
| 缺去重状态文件 | design-gap | 中 |

### 7.C 应然原则对照

> 仅列**应然**对各原则的承诺立场 / 代码 phase 落地后批量补判定。

#### Module Logic Principles（11 条）

- M#1 独立职责：「智能体记忆」业务独立 / 不与 EvolutionSystem 共变
- M#2 业务语义：dream 触发 / 记忆查询由本模块发起
- M#3 资源：dream state + memory 索引独占
- M#4 持久化：dream 状态落盘 / memory 索引落盘
- M#5 单向：L4 → L1 (FileSystem) + L2 (LLMOrchestrator / Messaging / AuditLog / ToolProtocol) + L4 同层 (TaskSystem — dream 子代理 fire-and-forget)（per arch §23 表 1）/ 不上引 L5+
- M#6 结构稳定：ctor 一次注入
- M#7 界面稳定：待 phase 落地稳定
- M#8 界面最小：memory 业务对外仅 dream + search 入口
- M#9 编译期可检：所有签名 type-only
- M#10 不合理停下：当前嵌 cron jobs 是冻结期妥协 / 设计中
- M#11 边界对不上停下：实然嵌 cron / 应然独立模块 / 显式登记

#### Design Principles（11 条）

- D1a-d 信息 / 状态 / 中断 / 审计：dream 状态文件 + audit events 全覆盖（应然）
- D2 不丢弃：dream 失败 audit 留痕
- D6 子代理不阻塞：dream 经 TaskSystem fire-and-forget
- D8 事件驱动：Cron 触发 / 不轮询
- D9 多 claw 不隔绝：跨 claw memory 可见

#### Philosophy（4 条）

- P1 Agent 即目录：dream 输出落对应 agent 目录
- P2 上下文工程：**核心驱动原则**（memory 是上下文压缩+复用的核心机制）
- P3 多 agent 利用：跨 claw memory 共享
- P4 系统为智能体服务：memory_search 工具让 agent 检索过往经验

### 7.D 历史纪律

- 2026-04-26 / phase318 MemorySystem 模块化（main `5f6b689`）/ createMemorySystem 工厂首立 + 4 文件搬迁（dream + audit-events + system + index）+ N1 LLM 注入修复 / modules.md 27/27 应然 100% / 模块壳基础设施
- 2026-05-03 / phase412 cross-layer port 治理 + @module 注释修（main `2be01261`）/ TaskLifecyclePort 扩 +1 writePendingSubAgentTask method + TaskSystem 实装 thin wrapper + SubAgentTaskInfo 新 export + random-dream 改调 + @module L5 → L4 修 + 测试 mock 完整 TaskLifecyclePort（6 method）/ 候选 9 random-dream cross-layer 闭环 / 候选 1 部分闭环（业务实装 runDream / memory_search 推后续 design phase）/ 候选 4 dream 双重归属 ⚓ accepted-stable（同 l5_cron §A.1 / 不消解）/ Path #7 路径 γ 第 4 phase / 模块边界重构阶段第 4 phase / ~~port pattern 第 N+1 次复用~~ ⚠ STALE 2026-05-03 推翻：同层单向 over-engineering / 详 feedback_governance_workaround_smell
- 2026-05-03 / phase424 TaskLifecyclePort STALE 推翻（main `2bab8042`）/ 删 TaskLifecyclePort interface (runtime-ports.ts:83-94) + caller 5 处直 dep TaskSystem class（同层单向合 M#5）+ 测试 mock partial cast / port pattern reversal 第 2 例（phase422 第 1 / cluster 6 闭 2）/ feedback_governance_workaround_smell 真合规落地 / 对应 §B random-dream cross-layer → ✅ closed

### 7.E 关键决策映射

待编号。

## 8. 测试覆盖

应然行为（不绑定具体测试文件路径 / 待 phase 落地后回填）：

- dream 触发路径 / 去重 / 错误隔离
- memory_search 工具调用 / 索引查询
- 跨 claw memory 可见性
- dream 失败软失败
