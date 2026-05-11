# StatusService 模块内部契约

> 本文档限本模块**内部**应然 — 8 节结构 derive 自 Module Logic Principles：§1-§4 = M#1-#4 各占一节，§5 审计 = M#3 命名空间细则，§6 层级，§7 drift = M#10/#11，§8 测试。+ §10 工具通道（own agent 工具的模块 / 5 维度承诺 derive 自 architecture.md 表 3）。
> 跨模块对外承诺（接口签名、生产/消费方、归本模块加不归本模块、不可消除耦合理由）见 [interfaces/l5.md](../interfaces/l5.md) StatusService 节。
> 模块本质加层归属见 [architecture.md](../architecture.md)。

## 1. 职责（M#1 独立可变职责）

> 本节内容 derive 自 [architecture.md](../architecture.md) §28「StatusService 本质：agent 自我状态聚合 introspection 服务 / L5 服务 ——『daemon 内部 state 聚合 introspection』/ 聚合多业务模块（ContractSystem / AsyncTaskSystem 等）+ FileSystem 视图 / 对 agent 暴露单一 status 工具 / read-only / 0 自有资源 / 0 持久化」加 M#1 / M#2 / M#3 / M#5 加 Philosophy「系统为智能体服务」+「上下文工程」。

### 做

应用 M#1（一个模块封装一组独立可变的职责），StatusService 的单一职责 = **agent 自我状态聚合 introspection**：

- **多源 state 聚合**：read-only 调 ContractSystem.loadActive / AsyncTaskSystem.listRunning + listPending / FileSystem 概览（如 clawspace 子目录）等 / 组装单一 StatusSnapshot
- **status 工具实现**：schema + execute（call collect → format ToolResult）/ Assembly 装配期 register 进 Tools
- **read-only**：不修改任何业务 state / 不持自有资源 / 进程内同步聚合

> 具体 API 形态归 [interfaces/l5.md](../interfaces/l5.md) StatusService 节。具体实现细节（StatusSnapshot 字段集 / collect 内部多源调用顺序 / format 文本格式等）登记 §7.B。

### 不做

- **不 own 业务 state**（ContractSystem / AsyncTaskSystem / DialogStore / Snapshot 等业务 state 归各业务模块 own）— derive 自 M#3
- **不修改 state**（read-only / 仅查询聚合 / 不写）— derive 自 M#1 + M#2
- **不持自有资源**（无磁盘 artifact / 无运行期 mem state / 每次 collect 重新聚合）— derive 自 M#3 + M#4
- **不 own CLI status 子命令**（CLI 综合 `clawforum status` 命令归 L6 CLI / 但 dep StatusService.collect）— derive 自 M#1
- **不 own daemon process state**（PID / lockfile / 进程存活归 L6 Daemon + L2 ProcessManager）— derive 自 M#3
- **不 own watchdog state**（独立进程 / watchdog-state.json 归 L6 Watchdog）— derive 自 M#3
- **不参与 agent 决策**（仅查询 / 提供给 agent 决策所需信息 / 不替代 agent）— derive 自 D6「智能体是决策主体」

## 2. 业务语义（M#2 业务语义归属）

> 应用 M#2（模块为自己的业务语义负责），StatusService 的业务语义边界：

- **own**：「agent 自我状态聚合 introspection」业务语义唯一发起点 — 多源 state 聚合 + status 工具 schema + execute 实现。这些是 StatusService 唯一懂的「业务」（introspection 级 / 不解读业务模块内部细节）。
- **角色定位**：StatusService 是「**read-only state 聚合视图**」非「**业务模块**」非「**state owner**」。各业务模块 own state / StatusService 仅 read 组装 / 提供 agent introspection 视图。
- **业务语义动词集**：
  - 「聚合」：`collect()` → `StatusSnapshot`（read 多源）
  - 「工具实现」：`statusTool` schema + execute（agent invoke → call collect → format → ToolResult）
- **装配「按需」**：per-claw（含 motion）daemon 内装 / Assembly 装配期 register status 工具进 Tools

## 3. 资源（M#3 资源唯一归属）

> 应用 M#3（每种资源只归属唯一模块），StatusService 独占的资源：

| 资源 | 类别 | 持久化 |
|---|---|---|
| 无 | — | ✗ read-only 聚合 / 0 自有资源 / 0 持久化 |

**无磁盘资源** — read-only 聚合视图 / 持久化归各被聚合业务模块。

> 注：status 工具 schema + execute 实现集中 `src/core/status-service/status.ts`（实施细节归 §1.做 + §10 工具通道 / 非 M#3 业务资源）。

## 4. 持久化（M#4）

> 应用 M#4（持久化一切信息到磁盘 / 运行时句柄从磁盘信息重建），StatusService 自身的持久化立场：

- **模块零状态**：无自有磁盘 artifact / 无运行期 mem state / read-only 多源聚合
- **重建语义**：进程重启 → Assembly 重装 / 0 state 需重建（每次 collect 实时聚合）
- **持久化归被聚合模块**：

| 信息 | 归属 | 落盘 |
|---|---|---|
| 契约 state | ContractSystem（L4）| 契约目录树 |
| 任务 state | AsyncTaskSystem（L4）| `tasks/queues/{pending,running,done,failed,results}/` |
| 文件视图 | FileSystem（L1）| 实际 OS 文件系统 |

## 5. 审计事件清单

> 事件常量集中定义于 `src/core/status-service/audit-events.ts` `STATUS_AUDIT_EVENTS`（模块自治 / phase 446 闭环）。

3 STATUS_* events（单源聚合失败软降级 + audit）：

| 事件 type | 触发时机 | 载荷 |
|---|---|---|
| `status_contract_error` | ContractSystem.loadActive 抛错 | `source=contracts`, `reason` |
| `status_task_pending_error` | AsyncTaskSystem.listPending 抛错 | `source=tasks_pending`, `reason` |
| `status_task_running_error` | AsyncTaskSystem.listRunning 抛错 | `source=tasks_running`, `reason` |

通用工具调用事件由 L2 Tools 框架的 `tool_exec` 覆盖（StatusService 是 read-only 工具实现 / 无业务 state 改变）。

## 6. 层级声明

L5 服务（与 Runtime / Cron / Gateway 同层 / 「daemon 内部 state 聚合 introspection」业务语义独立可变）。下游 Assembly（L6）通过 `createStatusService` 工厂消费 + register status 工具 / CLI（L6）综合 status 命令也 dep 本模块 collect。详见 [architecture.md](../architecture.md) 加 [interfaces/l5.md](../interfaces/l5.md)。

## 7. 应然 vs 实然差距登记（M#10 / M#11）

> 原则：本节只登记**实然 ≠ 应然**的 gap（待治理或已治理的历史）+ 偏差 + 历史纪律。当前实然若与应然 align 则不在此登记。

### 7.A 必修违规

| §A 条 | 类型 | 状态 | 触发情境 |
|---|---|---|---|
| ~~**A.1 模块物理不存在 / status 工具实然 0 实施**~~ | structural drift / 大 | **✅ closed (phase 446)** | phase 446: NEW src/core/status-service/ 模块物理立 / git mv status.ts + status-port.ts + status-audit-events.ts → core/status-service/ (保 history) / NEW barrel index.ts (statusTool + STATUS_AUDIT_EVENTS + ContractStatusPort types re-export + @module L5.StatusService) / Assembly 显式 register（同 phase 440/442 模板）/ builtins/index.ts 删 statusTool 3 处 (import + re-export + register) / **业务工具归 owner module 第 5 实证**（phase 360 done + phase 416 memory_search + phase 440 send + phase 442 skill + 本 phase）/ Path #1 修正：design 原写「实然归 CLI L6」错 / 实然在 L2 foundation/tools/builtins/ |
| ~~**A.2 status 工具命名空间归属 drift**~~ | naming drift / 中 | **✅ closed (phase 446)** | phase 446: STATUS_AUDIT_EVENTS 已迁 src/core/status-service/audit-events.ts (3 events: CONTRACT_ERROR / TASK_PENDING_ERROR / TASK_RUNNING_ERROR / 字符串值起步态等价 / 0 漂移) / 命名空间归 L5 StatusService align / 注: cli_status_tool_invoked 实然 grep 验证（实施时核 / 0 命中 = 应然幻象同步删 / ≥1 命中 = 推 r+1 phase） |
| ~~**A.r62-1 ContractStatusPort STALE 推翻 + L4 → L5 反向 import**~~ | ~~drift / 中~~ | **✅ closed (phase 458 / `03c0cb9a`)** | Path #1 实测核浮出（同 phase 454 模板第 2 实证 / 升格阈值达）/ phase 446 立 ContractStatusPort 时未审视 STALE 推翻可能 / 1 impl only + 0 ROI + L4 → L5 反向 type-only import = 完全 `feedback_governance_workaround_smell §1+§5` 模式。phase 458 落地：(1) DELETE contract-status-port.ts + status-port-impl.ts 2 文件 / (2) statusTool 改 ContractSystem 直 dep（contractSystem field 替代 contractStatus field / loadStatusView 调用改 loadActive + 内联计算 doneCount/totalCount/items）/ (3) caller cascade（assemble.ts + tests/core/builtins.test.ts 8+ 处）/ (4) L4 → L5 反向 import 全清 / 6 files +29 -88 = 净 -59 行 / **port pattern 推翻 cluster 第 8 例 / cluster 8/8 全收官**（phase 422-432 7 cluster + phase 446 ContractStatusPort 立 + phase 458 推翻）/ `grep -rnE "^export interface \w+Port\b" src/` = 0 命中（cluster 收官硬证据）/ M#5 单向依赖 align ✓ |
| ~~**A.r67-1 status-tool schema async 字段 vs supportsAsync false drift**~~ | ~~spec drift / 小~~ | **✅ closed (phase 555 / `4ab5a3c2`)** | 应然 cross-doc 三源 align「statusTool 0 入参」（§10.2 + §7.C M#8 + §8 + interfaces/l5.md:288）/ 实然 schema.properties 含 `async: boolean` 但 `supportsAsync: false` 误导 LLM。phase 555 落地：(1) status-tool.ts schema.properties = `{}`（删 async 字段 / 净 -6 行 src）/ (2) supportsAsync: false 保不变 / execute 不变 / (3) tests/core/builtins.test.ts 加 cross-check 断言（properties 0 字段 + supportsAsync false）/ 模板复用 phase 530 ls/read 同型 / 28 原则 derive 5/5（M#7+M#8+P4+D5+D6+Path#7）/ 反向 3 项 PASS / 2 files +7 -6 = 净 +1 行 |

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| 单源聚合失败软降级 vs 抛错 | design-gap / 设计意图 | 当前应然：partial snapshot + warning / 不抛 / 让 status 工具尽可能多返信息给 agent。升档：业务模块 state 完整性强约束（如 contract progress 必须完整可读）→ 改抛 |
| status 工具 profile 准入 | design-gap / 默认全 profile | 当前应然：默认 motion + claw 主代理含 status / subagent / verifier / miner / dream 不含。升档：agent 角色场景细化 |

### 7.C 应然原则对照

> 仅列**应然**对各原则的承诺立场。

#### Module Logic Principles（11 条）

- **M#1 独立可变职责**：read-only state 聚合 / 与各业务模块 state owner 职责独立可变
- **M#2 业务语义归属**：collect + status 工具实现 由本模块发起 / 业务 state 修改归各业务模块
- **M#3 资源唯一归属**：无磁盘 / 无 mem / 业务 state 归各业务模块
- **M#4 持久化**：N/A（read-only）/ 业务 state 持久化归被聚合模块
- **M#5 依赖单向**：StatusService → L4 (ContractSystem / AsyncTaskSystem read) + L1 (FileSystem read) + L2 (ToolProtocol type schema / 实现 Tool 协议)（per arch §28 表 1）/ Tools 框架 register 由 Assembly 装配期完成 / 不算本模块直 dep / 不上引 L6+
- **M#6 依赖结构稳定**：ctor 一次注入 / 运行期不变
- **M#7 耦合界面稳定**：collect + statusTool 形态稳定 / StatusSnapshot 加字段需 non-breaking
- **M#8 耦合界面最小**：collect 0 args / statusTool 0 args（无入参）/ 输出 ToolResult 单结构
- **M#9 显式编译器可检**：StatusSnapshot interface 强类型 / 跨模块查询经被聚合模块 typed API
- **M#10 不合理停下**：单源失败软降级 / partial snapshot + warning / 不阻塞其他源 / 3 STATUS_* audit 留痕
- **M#11 边界对不上停下**：A.1 物理迁 + A.2 命名空间归属 显式登记

#### Design Principles（11 条 / #1 展 4 面）

- **D1a 信息不丢失**：collect 软降级失败时 partial snapshot 含 warning 字段 / 信息不静默丢
- **D1b 状态可观察**：核心驱动原则（status 工具是 agent 自我观察的入口）
- **D3 用户可观察**：核心驱动原则（CLI 综合 status 命令也 dep 本模块）
- **D6 智能体决策主体**：status 提供决策所需信息 / 不替代 agent 决策
- **D7 系统可信路径**：read-only 聚合 / 经 typed API 调被聚合模块 / 受信
- **D2 / D4 / D5 / D8 / D9 / D10 / D11**：N/A（read-only / 无业务 state 改变）

#### Philosophy（4 条）

- **P1 Agent 即目录**：中性（read-only 聚合视图 / 不直接 own agent 目录抽象 / 仅 read FileSystem 概览）
- **P2 上下文工程**：status 工具是 agent 自我 introspection 上下文 / 让 agent「看到自己」
- **P3 分多个智能体加分子任务**：中性（不直接派多 agent / 仅供单个 agent introspection / AsyncTaskSystem 派生由各业务发起）
- **P4 系统为智能体服务**：核心驱动原则（status 工具是「系统为智能体提供决策所需信息」的直接体现）

#### Path Principles（7 条）

- **Path #1 路径规划基于规划时刻的事实**：A.1 物理迁状态待 r+1 phase 实测核（治理动作要 grep 实然代码佐证 / 注意实施过程中实然的变化）
- **Path #2 实然和应然差距显式登记**：违规明文上墙（在路径规划时参考 / §7.A + §7.B）
- **Path #3 语义原子变更单元**：状态聚合不引入新业务概念 / 仅 read 各业务模块 typed API / 1 phase = 1 commit 原子
- **Path #4 可回滚 + 破坏性论证**：API 改动 caller 评估 / 破坏性改动显式论证
- **Path #5 完成后复盘**：phase 收尾三维 + Path Principles 第 4 维对账
- **Path #6 冲突立即中断**：scope 模糊或决策点必停报告（冲突调整优先于强行推进）
- **Path #7 总难度路径**：实然到达应然有诸多路径 / 选择降低总难度的（步骤间有相互作用 / 总难度 ≠ 各步骤成本简单相加）

### 7.D 历史纪律

- 2026-05-03 / r60+ StatusService L5 新增登记（arch §28 立 / 物理迁 + 工具命名空间迁 推 r+1 实施 phase）
- 2026-05-04 / phase 446 物理立 + status 工具迁出 L2 builtins → L5 core/status-service/（git mv 3 file + NEW barrel index.ts + Assembly 显式 register / builtins/index.ts 删 3 处 / caller cascade 4 src + 2 tests / **业务工具归 owner module 第 5 实证**（phase 360+416+440+442+本 phase 累 5 / 模板成熟极致 / r+1 Meta 升格候选）/ 物理迁三模板复合第 N+8 次 / Path #1 修正 design 原写实然归 L6 / 实然 L2 foundation/）
- 历史 status 工具归 L6 CLI（`cli_status_tool_invoked` audit / `src/cli/commands/status.ts`）/ Path #1 实测后归属转移 L5 StatusService align Philosophy P4「系统为智能体服务」+ Design Principle D6「智能体决策主体」更清晰 / status 工具本质是 introspection 服务 / 不是 CLI 命令路由
- 2026-05-04 / cross-doc audit drift 修订（§7.C Philosophy 加 P1+P3 中性立场行 / Module Logic 命名 M1-M11 → M#1-M#11 align gateway+runtime / §3 资源粒度 align arch 表 1「无」/ §5 升级登记 STATUS_AUDIT_EVENTS 3 events 已实施 align interfaces §10 / arch §28 表 1 加 CLI 为 caller align design 意图）
- 2026-05-04 / **phase 458 ContractStatusPort STALE 推翻 + L4 → L5 反向 import 消除**（`03c0cb9a`）/ DELETE contract-status-port.ts + status-port-impl.ts 2 文件 / statusTool 改 ContractSystem 直 dep（contractSystem field / loadActive + 内联 view 计算）/ caller cascade（assemble.ts + builtins.test.ts 8+ 处）/ 6 files +29 -88 = 净 -59 行 / **port pattern 推翻 cluster 第 8 例 / cluster 8/8 全收官**（phase 422-432 7 + phase 446 立 + phase 458 推翻）/ `grep -rnE "^export interface \w+Port\b" src/` = 0 命中 / Path #1 实测核浮出 hidden drift 第 2 实证（同 phase 454 / 升格阈值达）/ M#5 单向依赖 align ✓ / `feedback_governance_workaround_smell §5 cluster` 累 8/8 全收官
- 2026-05-05 / r65 cross-doc audit 单 doc 一致性核（modules/l5_status_service.md vs arch §28 + 表 1/2/3 + interfaces/l5.md StatusService 节）/ 0 derive drift / 主 derive 全 align（M#1-M#11 + Design Principle D1a/D1b/D3/D6/D7 + Philosophy P1+P2+P4 + Path #1+#3）/ 4 dep（ContractSystem + AsyncTaskSystem + FileSystem + ToolProtocol）+ 2 caller（Assembly + CLI）+ status 工具 5 维度承诺全 align / 0 应然幻象 / 0 双重归属 / phase 446 + 458 cluster 收官稳态保留 / design only / 0 src 改
- 2026-05-09 / **phase 555 status-tool async schema drift 删**（`4ab5a3c2` / r67 F fork）/ schema.properties 含 `async: boolean` 但 supportsAsync: false 误导 LLM / 删 async 字段（净 -6 行 src）+ tests/core/builtins.test.ts 加 cross-check 断言 / 同型 phase 530 ls/read 模板复用第 N 实证 / 28 原则 derive dominant α / 反向 3 项 PASS / **副发现**：dispatch 表 §F 第 2 项 `init-envvar.test.ts process.env 直 mutate` claim Path #1 实测 0 命中 → phase 543（`4475e773`）已闭环 / **「review claim 完全推翻」cluster 累 3 实证**（phase 540 D.2 + phase 543 5/8 + phase 555 F.2 STALE）/ Meta 38 阈值更近

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| KD（待编号 / D1b+P4 derive）| status 工具是 agent 自我状态 introspection 入口 / 归 L5 StatusService own | 应然契约一致 |
| KD（待编号）| StatusService read-only / 0 自有资源 / 不持业务 state | 应然契约一致 |
| KD（待编号）| CLI 综合 `clawforum status` 命令 dep StatusService.collect / 不重新实现聚合 | 应然契约一致 |
| KD（待编号 / phase 458）| StatusService statusTool 直 dep ContractSystem class / 0 ContractStatusPort 抽象层 | **✅ closed by phase 458**（main `03c0cb9a`）/ port pattern 推翻 cluster 第 8 例 / cluster 8/8 全收官 / DELETE 2 抽象层 file + 净 -59 行 / `feedback_governance_workaround_smell §5 cluster` 累 8/8 全收官 / Path #1 实测核浮出 hidden drift 第 2 实证（同 phase 454）|

## 8. 测试覆盖

应然行为（不绑定具体测试文件路径）：

- **collect 多源聚合**：ContractSystem + AsyncTaskSystem + FileSystem 各源 happy path
- **单源失败软降级**：单源抛错 → partial snapshot + warning 字段 / 不阻塞其他源 / 不抛
- **status 工具 schema**：name + description + 0 入参 schema
- **status 工具 execute**：调 collect → format → ToolResult
- **profile 准入**：motion + claw 主代理含 status / subagent / miner 等不含
- **read-only 不变量**：collect 0 修改任何业务 state / 不写磁盘 / 不调 setOnNotify 等回调注入
- **CLI 综合 status 命令 dep**：CLI 命令调 StatusService.collect 而非自实现聚合（同 dep 共用聚合视图）

## 10. 对智能体的承诺（工具通道）

> 5 维度结构（用途 / 入参 / 返回语义 / 副作用+跨通道 / profile 准入+不变量）。
> **工具构造**：`createStatusTool(contractSystem: ContractSystem): Tool` 工厂闭包（phase 533 / caller DIP enforce / 0 module-level mutable / deps 编译时必选）。

**【1. 用途】**

> **agent 自我状态 introspection 通道** — agent 通过 status 工具查看自己当前的活跃契约 progress、任务队列、clawspace 概览等多源聚合视图。

**设计意图**：
- agent 决策需要知道「我现在在做什么 / 还有什么任务等着」/ status 是这个信息入口
- read-only / 不改变任何 state / 安全调
- 多源聚合 / 一次查询拿到全景 / 不需要 agent 自己拼装多个 read

**【2. 入参 schema】**

```
（无入参）
```

**【3. 返回语义】**

```
ToolResult { success: boolean, content: string }
```

- 成功：success=true / content = 格式化的 status 文本（active contracts + 任务队列 + clawspace 概览 + warnings 如有）
- 单源失败：success=true（partial snapshot）/ content 含 warning 段标识哪些源失败
- 全失败（罕见）：success=false / content = error message

**【4. 副作用 + 跨通道影响】**

- **0 副作用**：read-only / 不改 state / 不写磁盘 / 不发 audit（除可选 `status_collect_failed` 升档候选）
- **跨通道**：经 ToolRegistry 注册 / 工具调用 audit 由 L2 Tools 框架的 `tool_exec` 覆盖

**【5. profile 准入 + 不变量】**

profile 准入：
- ✓ `full`（motion + claw 主代理）含 status
- ✗ `subagent` / `miner` / `verifier` / `dream` 不含（disposable / 不需自我 introspection）

不变量：
- **read-only**：execute 0 修改任何业务 state / tsc 编译期可保证（collect 返 readonly StatusSnapshot）
- **多源聚合**：单源失败不阻塞其他源 / 用 partial snapshot + warning 字段保证 D1a 信息不丢失
- **同步聚合**：进程内调用各业务模块 typed API / 不 spawn 子进程 / 不发 inbox 消息
