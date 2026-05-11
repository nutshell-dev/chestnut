# Daemon 模块内部契约

> 本文档限本模块**内部**应然 — 8 节结构 derive 自 Module Logic Principles：§1-§4 = M#1-#4 各占一节，§5 审计 = M#3 命名空间细则，§6 层级，§7 drift = M#10/#11，§8 测试。
> 跨模块对外承诺（接口签名、生产/消费方、归本模块加不归本模块、不可消除耦合理由）见 [interfaces/l6.md](../interfaces/l6.md) Daemon 节。
> 模块本质加层归属见 [architecture.md](../architecture.md)。

## 1. 职责（M#1 独立可变职责）

> 本节内容 derive 自 [architecture.md](../architecture.md) §29「Daemon 本质：进程生命周期管理服务 / L6 进程边界 ——『主 daemon』」加 M#1 / M#2 / M#3 / M#5 加 Design Principle「事后可审计」加「进程独占防多实例竞争」业务 invariant。

### 做

应用 M#1（一个模块封装一组独立可变的职责），Daemon 的单一职责 = **进程生命周期管理**：

按生命周期三段：

**启动期**：
- lockfile 单实例保护（写 `status/pid` / 冲突由 Assembly 抛 `LockConflictError`）
- 调 `assemble(config)` 取 `Instances`
- 装后初始化：`daemon_start` audit + snapshot commit（context=daemon-start）
- 装配失败时发 `assemble_failed`（module=runtime / phase=post_assemble_init）后上抛退出

**运行期**：
- `startDaemonLoop(options)` 驱动 Runtime（主路径 processBatch / 中断 abort / 重试 retryLastTurn / 阻塞 waitForInbox）
- review_request 路径已迁 ContractSystem（Daemon 仅保留 onInboxMessages 转调）

**关停期**：
- 安装信号 handler（SIGTERM / SIGINT → shutdown 闭包）
- shutdown 调 `disassemble(instances, signal)` 反向拓扑清理
- unlink `status/pid`（pid 匹配时）
- 异常退出 `daemon_crash` audit

> 具体 API 形态归 [interfaces/l6.md](../interfaces/l6.md) Daemon 节。具体实现细节（daemonCommand / startDaemonLoop / waitForInbox / DaemonLoopOptions 4 组结构 / 双层 handler shim+内层 / preAssembleAudit 预构造 等）的存在依据是「进程生命周期管理」原语 — 实然采纳的细节差异加 driver/state 分离加 review_request 迁移链路等登记 §7.B。

### 不做

- **不做模块装配**（归 L6 Assembly / Daemon 调 Assembly 装好后获得 Instances / 不知 module 内部细节）— derive 自 M#1 + M#5
- **不做事件循环内部状态**（归 L5 Runtime / driver 在 Daemon / state 在 Runtime / driver/state 分离登记）— derive 自 M#1
- **不做子代理派发**（归 L4 AsyncTaskSystem）— derive 自 M#1 + M#5
- **不做审计落盘**（归 L2 AuditLog / Daemon 调 AuditLog 接口写）— derive 自 M#3 + M#5
- **不做 agent 业务身份语义**（motion / claw 由 Assembly 装配时 inject）— derive 自 M#5
- **不做业务命令路由**（外部操作经 L6 CLI / Daemon 是被 daemon-entry 启动 / 不直接接 user input）— derive 自 M#1
- **不允许 Instances 字段重新赋值**（readonly + tsc 编译期保证 / Daemon 仅读字段或调字段对象方法）— derive 自 M#7
- **不做 snapshot 实现**（git commit 等），归 L2 Snapshot（Daemon 仅在启动期调 `snapshot.commit('daemon-start')` 接口）— derive 自 M#3 + M#5

## 2. 业务语义（M#2 业务语义归属）

> 应用 M#2（模块为自己的业务语义负责），Daemon 的业务语义边界：

- **own**：「进程生命周期管理」业务语义唯一发起点 — 启动 / 关停 / 信号处理 / lockfile 单实例保护 / driver 在 Daemon（事件循环驱动节奏）。这些是 Daemon 唯一懂的「业务」（物理进程级）。
- **角色定位**：Daemon 是「**进程生命周期管理者 + 事件循环 driver**」非「**装配器**」非「**循环算法器**」非「**业务路由器**」。Assembly 装好 Instances / Daemon 拿到后驱动 Runtime / state 归 Runtime。
- **业务语义动词集**：
  - 「进程启动」：`daemonCommand(name)`
  - 「事件循环驱动」：`startDaemonLoop(options)` → Runtime（driver 在 Daemon / state 在 Runtime）
  - 「inbox 阻塞等待」：`waitForInbox(...)`
  - 「进程关停」：`shutdown(signal)` 闭包 + `disassemble`
- **装配「按需」**（任何 long-running daemon 进程入口装）

## 3. 资源（M#3 资源唯一归属）

> 应用 M#3（每种资源只归属唯一模块），Daemon 独占的资源：

| 资源 | 类别 | 持久化 |
|---|---|---|
| `<dir>/status/pid` lockfile | 持久化（独占）| ✓ 启动写 / 关停删 |
| `process.on('SIGTERM' \| 'SIGINT')` signal handler | 进程级（独占）| ✗ |
| `process.on('uncaughtException')` + `process.on('unhandledRejection')` | 进程级双层兜底（shim + 内层）| ✗ |
| 无内存状态 | 派生态 | ✗ instances 是 Assembly 返回不可变引用 |

## 4. 持久化（M#4）

> 应用 M#4（持久化一切信息到磁盘 / 运行时句柄从磁盘信息重建），Daemon 自身的持久化立场：lockfile 磁盘是权威 / instances 是 Assembly 不可变引用 / 无内存状态。

### 磁盘布局

```
<clawforumDir>/<name>/
└── status/
    └── pid              ← Daemon 独占 lockfile / 启动写当前 process.pid / 关停删（pid 匹配时）
```

### 文件格式

- `pid`：单行 `<pid>` 数字

### 重建语义

- 进程重启 → daemonCommand 写新 pid（冲突由 Assembly LockConflictError 上抛）
- pid 文件即权威 / 进程在 / pid 在 / 进程失活 / 下次启动经 ProcessManager isAlive 自动清理 stale 文件
- 无内存状态 / instances 由 Assembly 重建

## 5. 审计事件清单

> 应然事件常量集中定义于 `src/daemon/audit-events.ts` `DAEMON_AUDIT_EVENTS`（模块自治 / caller const 引用）。

daemon.ts 自产事件（3 events / assemble_failed 含 3 载荷分支）：

| 事件 type | 触发位置 | 载荷 |
|---|---|---|
| `daemon_start` | daemonCommand 装后初始化 | `clawId`, `pid` |
| `daemon_crash` | uncaughtException / unhandledRejection（运行期）| `err` |
| `assemble_failed`（载荷特化 / 3 phases）| daemon.ts 三分支：lockfile / pre_assemble / post_assemble_init | `module`, `phase`, `reason` |

> 注：`daemon_started`（with -ed）由 Assembly own / `daemon_start` 由 Daemon own / 2 events 不同语义。

daemon-loop.ts 自产事件（5 个）：

| 事件 type | 触发时机 | 关键载荷 |
|---|---|---|
| `daemon_loop_iteration` | processBatch 完成 / wait 触发 | `type=chain\|wait`, `injected`, `chain_total` |
| `daemon_loop_interrupt` | runtime 抛 IdleTimeout / UserInterrupt / PriorityInbox | `cause=idle_timeout\|user_interrupt\|priority_inbox`, `recovery_delay_ms` |
| `daemon_loop_llm_retry` | LLM error 重试 | `attempt`, `max`, `delay_ms`, `err` |
| `daemon_loop_fatal` | daemon-loop 顶层 catch | `err` |
| `daemon_loop_interrupt_poller_disabled` | poller 异常关闭 | `err_count`, `last_err` |

daemon-entry.ts shim 事件（2 个）：

| 事件 type | 触发时机 | 载荷 |
|---|---|---|
| `daemon_uncaught_exception` | shim 层 uncaughtException（极早期 / daemon.ts 未入）| `err` |
| `daemon_unhandled_rejection` | shim 层 unhandledRejection（极早期）| `err` |

保留 console 清单（β 双写 / γ 保留 / 详 §7）：

| 位置（method/symbol）| 决策 | 理由 |
|---|---|---|
| `daemon.ts` heartbeat 残留清理 catch（`console.warn "Failed to clean up heartbeat files"`）| β 双写保留 | 启动期 best-effort / non-ENOENT 才报 |
| `daemon.ts` shutdown pid 清理 catch（`console.warn "Failed to clean up pid file"`）| β 双写保留 | shutdown 期 best-effort / failure 后 process.exit(0) |
| `daemon.ts` startup banner（`console.log` "${label} Started"）| γ 保留 | console.log 是人眼 checkpoint / `daemon_start` audit 已承载审计语义 |
| `daemon-loop.ts` interrupt poll + LLM error + processBatch error 类（`console.warn` / `console.error`）| γ 保留 | 同型先例 / audit 已承载语义 |

## 6. 层级声明

L6 进程边界（与 L6 Watchdog / L6 CLI / L6 Assembly 同层 / 「进程生命周期管理」业务语义独立可变）。下游进程入口 `src/daemon-entry.ts` 唯一消费 daemonCommand。本模块下引 Assembly（L6 同层 / 装配根角色）+ Runtime（L5）+ L1-L2 基础设施 / 不上引 L6+。详见 [architecture.md](../architecture.md) 加 [interfaces/l6.md](../interfaces/l6.md)。

## 7. 应然 vs 实然差距登记（M#10 / M#11）

> 原则：本节只登记**实然 ≠ 应然**的 gap（待治理或已治理的历史）+ 偏差 + 历史纪律。当前实然若与应然 align 则不在此登记。

### 7.A 必修违规（含历史已闭环）

**§7.A 10/10 全清零里程碑（phase191 / 4 phase 接力 173+188+189+191）**：

| §A 条 | 类型 | 状态 | 触发情境 |
|---|---|---|---|
| ~~A.1 daemon-loop.ts 370 行运行时零 audit~~ | drift | **已闭环（phase173）** | 集成 5 类 audit（iteration / interrupt / llm_retry / fatal / interrupt_poller_disabled）|
| ~~A.2 console 16 处无 audit 跟进~~ | drift | **已闭环（phase173+188+189+191 / 16→0）** | phase173 daemon-loop 5 处 → 5 audit / phase188 review_request 10 处随代码删 / phase189 启动失败 3 处 audit + console 双写 / phase191 残余 3 处全登记保留运维可见 |
| ~~A.3 assemble 失败路径 audit 覆盖不全~~ | drift | **已闭环（phase189 / `af6f03a`）** | preAssembleAudit 预构造 / LockConflictError + 其他失败均 audit / module/phase 双字段承载 pre/post-assemble 二维状态 |
| ~~A.4a daemonCommand 入口全路径单测~~ | drift | **已闭环（phase174）** | 新建 `tests/cli/daemon-command.test.ts`（378 行 / 11 it）|
| ~~A.4b waitForInbox 无直接单测~~ | drift | **已闭环（phase183 / `37e8bcc`）** | +4 it 三路径 + settled guard / 0 产品代码 |
| ~~A.4c review_request 130 行路径零测试~~ | drift | **已闭环（phase188 / 代码迁 ContractManager）** | review_request 全归 ContractSystem / Daemon 零业务代码需直测 |
| ~~A.4d shutdown 信号处理单测~~ | drift | **已闭环（phase174）** | A4d shutdown signal + crash handler 4 it |
| ~~A.5 DaemonLoopOptions 11 字段超阈值~~ | drift | **已闭环（phase185 / `79c2a9c`）** | 11 平铺 → 4 组结构（核心驱动 5 + inbox 子组 + motion 子组 + 流式 2）/ 顶层 visible 9 |
| ~~A.6 review_request `new SkillRegistry` 临时实例化~~ | drift | **已闭环（phase177 / `91e8f64`）** | daemon.ts:179 → `createSkillRegistry` 工厂调用 |
| ~~A.7 daemon-entry shim 双层 handler audit 缺口~~ | drift | **已闭环（phase189 / `af6f03a`）** | shimAudit 预构造 / 双层 handler 共存 + 双发 audit / `daemon_uncaught_exception` + `daemon_unhandled_rejection` 新 audit type |
| ~~**A.r68-1 daemon heartbeat cleanup sync IO 启动期阻塞**~~ | ~~perf drift / 小~~ | **✅ closed (phase 562 / `40bf50ed`)** | `daemon.ts:89-102` heartbeat 残留清理 `fsNative.readdirSync` + loop `fsNative.unlinkSync` 启动期阻塞 event loop（典型 inbox 文件少 < 10 / 极端 case watcher 故障期累 100+）。phase 562 落地 α：4 行 diff `await fsAsync.readdir/unlink` 串行 / 0 行为差 / **`console.warn` β 双写保留不动**（phase 191 design intent 锁 / §7.B 行 127+264 align）/ ENOENT 分支保留（best-effort）/ dominant α / 28 原则 derive 5/5（M#7+M#10+D2+Path #3+Path #7）/ **「design intent 锁定后单维度治理纪律」首发实证**（仅治 sync IO 维度 / 不破 phase 191 audit β 锁 / 推 r+1+ 累 ≥ 2 实证升格 feedback）|

**phase 562 closure 后 §7.A 全清零续保**（A.1-A.7 + A.r68-1 = 8/8 closed / phase 191 10/10 里程碑后 r68 期内首加首闭）。

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| driver / state 分离（daemon-loop 驱动 / Runtime 持态）| design-gap / 冻结期判定 | open（保留）| Daemon 控制进程生命周期 × 循环节奏 / Runtime 隔离于进程机制（为未来 CLI / chat 复用）。升档：driver 行为依赖 state 内部细节 / Runtime 内部状态改动波及 daemon-loop 测试 → 转 §A |
| DaemonLoopOptions publisher-subscriber 形态 B / 9 字段（M#8 软合规）| design-gap → ⚓ accepted-stable | **⚓ accepted-stable**（phase185 治理后达稳态）| **应然立场已合规**：phase185 11 平铺 → 4 组结构治理后顶层 9 字段（5 核心平铺 + inbox 必填子组 + motion? 可选子组 + 2 平铺可选）/ M#8「耦合界面最小」≤ 8 阈值的软合规（5 平铺 + 2 子组聚合统计）/ phase238 + 本轮重核仍稳。升档：子组字段数增至 5+ / motion 子组出现 non-motion caller / 真添 1 顶层字段 → 重新评估子组化 |
| ~~review_request 跨模块编排归属迁移~~ | drift | **已闭环（phase188 4/4 完成）** | 链路：phase174 契约 / phase175 实装 / phase184 切换 / phase188 清理 / 全归 ContractManager.handleReviewRequest |
| 字面量未抽常量（轻度）| drift / 低 | open / 合 phase169 字符串字面量抽常量 同期细化 | `'clawspace/dispatch-skills'`（contract/manager.ts:1411 + dispatch.ts:65 = 2 处 / < 3 处升档阈值）/ `'by-contract'`（contract/manager.ts:1334 1 处）/ 升档：≥ 3 处或 typo 导致 runtime bug |
| ~~daemon_started 归属错配~~ | ~~drift~~ | **✅ closed（phase385 / δ 撤销 / dispatch framing 错位第 9 案）** | **0 真违反 / 实然 2 events 各归各家**：`daemon_started` (with -ed) = ASSEMBLY_AUDIT_EVENTS.DAEMON_STARTED / Assembly assemble.ts:521 own / `daemon_start` = ASSEMBLY_AUDIT_EVENTS.DAEMON_START / Daemon daemon.ts:108 own（含 prompt hash sha256）/ drift 原 framing 把两 events 混为一谈推「双发 / 应移除 daemon_start」错位 / 释义豁免模板第 8 次复用 |
| ~~ProcessManager 调用未在依赖登记~~ | ~~drift~~ | **✅ closed（phase385 / 应然 stale 同步条款第 5 次 / 已应用）** | r42 D fork 新发现 / 本契约 §6 已补 ProcessManager direct 依赖 / 应然描述与实然 align |
| ~~assembly audit event 字符串硬编码（继承）~~ | ~~drift~~ | **✅ closed phase386**（main `ae9ca839`）| NEW src/daemon/audit-events.ts (DAEMON_AUDIT_EVENTS / 6 events) / daemon.ts 2 caller + daemon-loop.ts 7 caller 改 const ref / LOOP_ITERATION + LOOP_INTERRUPT 单 const + payload 区分（行为契约 0 改）|
| **B.flaky-1 `daemon-command.test.ts` claw assemble 启动超时** | **flaky test / 低** | **open / 2026-05-10 phase655 发现，phase683 再次复现** | `tests/cli/daemon-command.test.ts > daemonCommand - A4a startup success > claw: assemble 成功 → daemon_start audit + snapshot.commit 被调` 偶发 `Test timed out in 15000ms` / 根因：claw 模式 daemon 启动流程中 assemble + snapshot.commit 异步初始化耗时波动，测试 15s 阈值偶发不够 / **与 phase655 修改无关**（phase655 只加 comment，0 触及 daemon-command 逻辑）/ **phase683 merge 后全量测试再次复现**（1676 tests 中 1 failed，单独运行 13/13 PASS）/ 升档条件：复现频率 >10% 或 CI 阻塞 → 治理（调大 testTimeout 或 mock 初始化耗时）|

### 7.C 应然原则对照

> 仅列应然对各原则的承诺立场 / 不写「合规✓」claims。

**Module Logic Principles**

- M#1 独立可变职责：Daemon 职责 = 进程生命周期（启动 / 关停 / 信号）/ 变更源（启停策略 / 信号语义 / lockfile 机制）与 L5 Runtime 事件循环不同
- M#2 业务语义归属：启动 / 关停由本模块发起 / daemon-loop 事件循环 driver 在 Daemon / state 在 Runtime（driver/state 分离 灰度登记）
- M#3 资源唯一归属：status/pid lockfile + process signal handler 归本模块独占
- M#4 持久化：lockfile 磁盘即权威 / instances 是 Assembly 不可变引用
- M#5 依赖单向：Daemon → Assembly + Runtime 公共 API + ProcessManager（lockfile 操作）+ Snapshot（启动期 commit）+ AuditLog（per arch §29 表 1）/ 无上行 / 无循环 / review_request 转调经 Assembly 注入 callback / Daemon 0 直 dep ContractSystem 业务模块
- M#6 依赖结构稳定：启动期 assemble 一次性注入 Instances / 运行期 readonly
- M#7 耦合界面稳定：DaemonLoopOptions 4 组结构（phase185）/ StreamCallbacks 结构较大保留
- M#8 耦合界面最小：daemonCommand(name) 单参最小 / DaemonLoopOptions 顶层 9 字段（5 平铺 + 2 子组 + 2 可选平铺）≤ 8 阈值软合规 / daemon-loop 对 Runtime 仅调 3 方法
- M#9 显式编译器可检：TypeScript 强类型贯穿 / DaemonLoopOptions / Instances 接口强制 / assembly audit event caller 字符串硬编码暂违反
- M#10 不合理停下：phase172 冻结决策 / 不强行重构 / phase173+188+189+191 接力清零 §7.A
- M#11 边界对不上停下：A.1-A.7 显式登记 + 接力清零 / driver/state 分离 + DaemonLoopOptions 形态 B + review_request 迁移 + 字面量未抽常量 显式登记

**Design Principles**

- D1a 信息不丢失：phase191 §A.2 16→0 闭环 / 3 处 β/γ 保留 console 属运维可见非信息丢弃
- D1b 状态可观察：phase173 装配期 audit + daemon-loop 5 事件覆盖 batch / interrupt / retry / fatal / poller_disabled 全维度
- D1c 中断可恢复：SIGTERM/SIGINT 触发 disassemble / 按拓扑反向清理
- D1d 事后可审计：§7.A 10/10 全清零 / phase177/183/185/188/189/191 接力 / 所有路径 audit 留痕
- D2 不丢弃 / 静默：phase173 daemon-loop 清零 / phase191 16→0 闭环 / 3 处保留 console 属运维可见
- D3 用户可观察：console 输出 + Runtime stream callbacks 传达
- D4 LLM 调用恢复：daemon-loop LLM error retry（指数 backoff / max LLM_MAX_RETRIES）+ phase173 daemon_loop_llm_retry audit
- D5 日志重建：daemon-loop 5 事件 + review_request 链路 phase188 归 ContractSystem + LockConflictError phase189 preAssembleAudit + §A.2 phase191 / 完整 daemon 轨迹可从 audit.tsv 重建
- D6 智能体决策主体：无关（Daemon 是基础设施）
- D7 系统可信路径：Assembly / Runtime 经受信注入消费
- D8 事件驱动：daemon-loop 用 inbox watcher + timeout 组合实现事件驱动（waitForInbox）
- D9 CLI 唯一对外：Daemon 经 daemon-entry.ts 作为进程 main / 与 CLI 其他 command 共享 `src/cli/commands/`
- D10 多 claw 不隔绝：同一 daemonCommand 支持 motion + claw 两身份
- D11 motion 特殊：motion 走 review_request（已迁 ContractSystem）+ heartbeat（motion-only 字段）

**Philosophy**

- P1 Agent 即目录：name 参数决定 agent 目录（dir = path.join(clawforumDir, name)）
- P3 分多个智能体加分子任务：同一 daemonCommand 支持 motion + claw 两身份
- P4 系统为智能体服务：提供进程常驻 + 信号处理 + review_request 编排（已迁 ContractSystem）基础设施

**Path Principles（7 条）**

- **Path #1 路径规划基于规划时刻的事实**：phase173/188/189/191/240/224 各 phase 起步 Path #1 复核 / 多次推翻或验证（治理动作要 grep 实然代码佐证）
- **Path #2 实然和应然差距显式登记**：违规明文上墙（在路径规划时参考 / §7.A + §7.B）
- **Path #3 语义原子变更单元**：§7.A 10/10 全清零分 4 phase 接力 / 每 phase 单一 scope / 1 phase = 1 commit 原子
- **Path #4 可回滚 + 破坏性论证**：API 改动 caller 评估 / 破坏性改动显式论证（反向测试：本模块可独立替换 Runtime / Assembly 实现而不动 daemon-entry —— M#1 ✓）
- **Path #5 完成后复盘**：phase 收尾三维 + Path Principles 第 4 维对账
- **Path #6 冲突立即中断**：phase172 冻结期决策 / 不强行重构 / phase173 §7.A3/A7 事实漏核纠正 / phase174 §7.A4a 文件名误登纠正 / phase169 C1 形态变种 3 次升格（冲突调整优先于强行推进）
- **Path #7 总难度路径**：实然到达应然有诸多路径 / 选择降低总难度的（步骤间有相互作用 / 总难度 ≠ 各步骤成本简单相加）/ A1 等大条分 phase 消化 / 不堆

> 注：原 §7.C「Path #8 总难度最低」是 Path #7 mis-numbered（canonical Path Principles 7 条 / 第 8 条不存在）/ 已修订为 Path #7「总难度路径」verbatim + 保留分 phase 消化注。

### 7.D 历史纪律

- 2026-04-21 / phase172 L6 Daemon 冻结契约首次登记（顶层模块抢跑期 / 方法论：feedback_top_module_freeze_window）
- 2026-04-21 / phase173 §7.A1 + §7.A2（部分）清零（daemon-loop 5 audit 集成）/ §7.A3+A7 事实漏核纠正（phase169 C1 形态变种第 1 次）
- 2026-04-21 / phase174 §7.A4a + §7.A4d 清零（daemon-command.test.ts 11 it）/ phase169 C1 形态变种第 2 次（daemon.test.ts 文件名误登纠正）/ Path Principles 落地动作 phase169 C1 形态变种第 3 次升格 feedback
- 2026-04-21 / phase175 ContractManager.handleReviewRequest 实装（review_request 迁移链路第 2 步）
- 2026-04-21 / phase177 §7.A6 清零（daemon.ts:179 → createSkillRegistry 工厂）
- 2026-04-21 / phase183 §7.A4b 清零（waitForInbox 4 it 直测）
- 2026-04-21 / phase184 Daemon onInboxMessages 切换（review_request 迁移链路第 3 步 / 非破坏性 + 旧代码 gate 短路）
- 2026-04-21 / phase185 §7.A5 清零（DaemonLoopOptions 11 → 4 组结构）
- 2026-04-21 / phase188 §7.A4c 清零 + review_request 迁移链路第 4 步（review_request 全归 ContractSystem / daemon.ts -124 行 / §2.5 / §5.5 整章删）
- 2026-04-21 / phase189 §7.A3 + §7.A7 同根同治清零（preAssembleAudit + shimAudit + 4 module/phase 双字段 + 双层 handler 双发 audit）
- 2026-04-22 / phase191 §7.A2 16→0 闭环里程碑（残余 3 处 β/β/γ 保留 console 决策）/ §7.A 10/10 全清零里程碑达成
- 2026-04-26 / r42 D 结构合规修（29→32 补 Path 6 / phase188+189+191 集中收官）
- 2026-04-27 / r42 D fork 新发现：daemon_started 归属错配 + ProcessManager 调用未登记 + assembly audit event caller 字符串硬编码（推 r43+ 应然同步）
- 2026-05-01 / phase385 daemon_started 归属错配释义闭环（δ 撤销 / dispatch framing 错位第 9 案 / 0 真违反 / 实然 2 events 各归各家 / `daemon_started` ASSEMBLY_AUDIT_EVENTS own + `daemon_start` DAEMON 自 own）+ ProcessManager 调用应然同步登记（r42 D fork 第 5 次「应然 stale 同步」条款应用 / §7.C M#5 已补 ProcessManager direct dep）
- 2026-05-01 / phase386 assembly audit event 字符串硬编码闭环（main `ae9ca839`）/ NEW src/daemon/audit-events.ts DAEMON_AUDIT_EVENTS（6 events）/ daemon.ts 2 caller + daemon-loop.ts 7 caller 全 const ref / 行为契约 0 改 / r42 D fork 3 新发现全收 3/3
- r60+ 重编号：9 节 → 8 节 / 每节 derive 自一条 Module Logic Principle（删原 §1.所有权 hub / §2 接口 / §5 上游依赖 / §6 不可消除耦合 → 已并入 interfaces/l6.md / 拆原 §1 为 §1 职责 + §2 业务语义 + §3 资源 + §4 持久化）
- 2026-05-05 / r65 cross-doc audit 单 doc 一致性核（modules/l6_daemon.md vs arch §29 + 表 1/2 + interfaces/l6.md Daemon 节）/ 0 derive drift / 主 derive 全 align（M#1-M#8 + Design Principle 事后可审计 + 进程独占）/ 修 SHA placeholder + 补 phase 385/386 closure timeline entry / design only / 0 src 改

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| KD#15 | Assembly 是装配汇聚点 / Daemon 只做进程生命周期 | ✓ phase188 review_request 迁出 / Daemon 零装配业务代码 |
| KD#23 | 装配职责三分（Assembly + Daemon + Runtime）| ✓ phase188 / Daemon 仅持进程生命周期 |
| KD（review_request 迁移链路）| review_request 归 ContractSystem | ✓ phase174→phase175→phase184→phase188 4 步链路闭环 |

## 8. 测试覆盖

应然行为（不绑定具体测试文件路径）：

- **daemonCommand 启动期 7 路径**：assemble 成功（claw + motion）/ LockConflictError / 其他 assemble 失败 / runtime.initialize 失败 / snapshot uncategorized / snapshot rejection
- **shutdown 信号处理 4 路径**：SIGTERM / SIGINT → shutdown 闭包 → disassemble → pid unlink → process.exit(0)
- **crash handler 4 路径**：uncaughtException / unhandledRejection（运行期）→ writeCrash → daemon_crash audit → process.exit(1)
- **shim 极早期 handler**（phase189 闭环）：shimAudit 双发 audit + 构造失败 fallback + write 抛静默 / `daemon_uncaught_exception` + `daemon_unhandled_rejection`
- **waitForInbox 三路径 + settled guard**（phase183）：新文件到达 / 超时 / ensureDirSync 抛错 / settled guard close 只调一次
- **DaemonLoopOptions 4 组结构**（phase185）：顶层 9 字段 + inbox 必填子组 + motion 可选子组（claw 整体省略）
- **driver / state 分离**：daemon-loop 调 runtime.processBatch / runtime.abort / runtime.retryLastTurn 3 方法 / 不消费 Runtime 内部状态
- **daemon-loop 5 audit 事件回链**（phase173）：daemon_loop_iteration / daemon_loop_interrupt / daemon_loop_llm_retry / daemon_loop_fatal / daemon_loop_interrupt_poller_disabled
- **assemble 失败 audit 双轨**（phase189）：preAssembleAudit（pre_assemble 阶段）+ auditWriter（post_assemble 阶段）/ module + phase 双字段
- **review_request 路径**（phase188 后）：onInboxMessages → ContractManager.handleReviewRequest 转调（happy / 非 review_request / 多条 / ctx 字段断言）
- **β 双写 console 保留 3 处**（phase191）：heartbeat 清理失败 / pid 清理失败 / `${label} Started` console.log
- **lockfile 单实例**：写 status/pid（冲突 LockConflictError 上抛）/ 关停删（pid 匹配时）
- **审计回链**：每个 §5 daemon_* + assemble_failed 事件触发时机 + 载荷断言（assembly audit event 治理后补 caller const 引用）
