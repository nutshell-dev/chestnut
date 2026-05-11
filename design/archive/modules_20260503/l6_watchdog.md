# Watchdog 模块内部契约

> 本文档限本模块**内部**应然 — 8 节结构 derive 自 Module Logic Principles：§1-§4 = M#1-#4 各占一节，§5 审计 = M#3 命名空间细则，§6 层级，§7 drift = M#10/#11，§8 测试。
> 跨模块对外承诺（接口签名、生产/消费方、归本模块加不归本模块、不可消除耦合理由）见 [interfaces/l6.md](../interfaces/l6.md) Watchdog 节。
> 模块本质加层归属见 [architecture.md](../architecture.md)。

## 1. 职责（M#1 独立可变职责）

> 本节内容 derive 自 [architecture.md](../architecture.md) §30「Watchdog 本质：进程级健康监控服务 / 非智能体（无 LLM / 无推理 / 无 prompt）/ 是监督基础设施 / L6 进程边界 ——『独立监控进程』」加 M#1 / M#2 / M#3 / M#5 加 Design Principle「motion 为 clawforum 中一个特殊的 claw / 对其他 claw 有单向访问权」加「磁盘即权威 / 内存可派生但不能为权威」加「事后可审计」。

### 做

应用 M#1（一个模块封装一组独立可变的职责），Watchdog 的单一职责 = **进程级健康监控**：

按观察 + 干预两面：

**观察**：
- Motion 存活轮询（每 tick 检查 motion daemon 是否活）
- Claw 崩溃检测（was alive → now dead 且持合约）
- Claw 不活跃检测（有活跃契约但 LLM 事件 timeout）

**干预**：
- Motion 自动重启（指数回避 backoff / 上限 5 min）
- Claw crash 通知中介（drop `crash_notification` 文件到 motion inbox）
- Claw 不活跃提醒（drop 提醒到 motion inbox）

> 具体 API 形态归 [interfaces/l6.md](../interfaces/l6.md) Watchdog 节。具体实现细节（startCommand / stopCommand / statusCommand / runWatchdogLoop / WatchdogObserver / WatchdogControl / WatchdogPort 等）的存在依据是「进程级健康监控」原语 — 实然采纳的细节差异加跨 agent fs.readdirSync 加主 loop 轮询模型加 motion 中介通知等登记 §7。

### 不做

- **不做 LLM 调用**（Watchdog 是非智能体本质 / 不持 LLM / 不做推理 / 不做 prompt）— derive 自 M#1
- **不做装配**（无 Assembly 调用 / Watchdog 是独立进程入口 / 自己不需要装 module 集合）— derive 自 M#1 + M#5
- **不做 agent 业务**（仅观察加干预 fs 状态加 lifecycle 事件 / 不参与 contract / task / dialog 等 agent 业务）— derive 自 M#1 + M#5
- **不做 PID 自注册**（watchdog.pid 自管 / 不归 ProcessManager 自注册体系 / A.11 W-tier 保留 / 防 ProcessManager 加 Watchdog 互相监控的循环）— derive 自 M#3
- **不直接通知 claw**（claw crash 通知经 motion 中介 / 应然 rule / motion 单向访问设计）— derive 自 Design Principle「motion 单向访问」

## 2. 业务语义（M#2 业务语义归属）

> 应用 M#2（模块为自己的业务语义负责），Watchdog 的业务语义边界：

- **own**：「进程健康监控」业务语义唯一发起点 — motion 存活轮询 / claw 崩溃检测 / claw 不活跃检测 / motion 自动重启 / claw crash 通知中介 / claw 不活跃提醒。这些是 Watchdog 唯一懂的「业务」（监督基础设施级）。
- **角色定位**：Watchdog 是「**独立进程观察者 + 干预者**」非「**智能体**」非「**装配方**」。CLI `watchdog start` 派生独立运行 / 监督跨 daemon（不装进 motion / claw daemon 内 / 监控自己有逻辑悖论）。
- **业务语义动词集**：
  - 「启动」：`startCommand()` → CLI watchdog start
  - 「关停」：`stopCommand()` → CLI watchdog stop
  - 「状态」：`statusCommand()` → CLI watchdog status
  - 「主 loop」：`runWatchdogLoop()` → 内部 entry 调
- **装配「独立进程」**（不装进 motion / claw daemon / 由 CLI `watchdog start` 派生独立运行）
- **motion 作为 claw crash 通知中介**（B.5.1 设计意图 / motion 单向访问设计）
- **状态**：冻结契约登记（不强行重构 / W-tier 保留待用户 design 决策）

## 3. 资源（M#3 资源唯一归属）

> 应用 M#3（每种资源只归属唯一模块），Watchdog 独占的资源：

| 资源 | 类别 | 持久化 |
|---|---|---|
| `watchdog.pid` | 持久化（独占）| ✓ 启动写 / 关停删 / 不归 ProcessManager 自注册 |
| `watchdog-state.json` | 持久化（独占）| ✓ 跨进程持久化（last seen / backoff / claw 状态）|
| `logs/watchdog.log` | 持久化（独占）| ✓ 详细日志（console.log 兜底）|
| `audit.tsv` | 复用全局 | ✓ 经 AuditWriter 写 WATCHDOG_* + CLAW_CRASH_* events |
| 主 loop 轮询计时器 | 派生态 | ✗ 重启重置（A9 W-tier 保留 / 非事件驱动）|
| 跨 agent 目录读 | 派生态 | ✗ 直 fs.readdirSync 多处（B.5.3 跨 agent 跨进程）|

## 4. 持久化（M#4）

> 应用 M#4（持久化一切信息到磁盘 / 运行时句柄从磁盘信息重建），Watchdog 自身的持久化立场：watchdog-state.json 跨进程持久化（A.2-A.4 W-tier 治理候选）/ watchdog.pid 自管 / 主 loop 轮询模型（A.9 W-tier 保留 / 非事件驱动）。

### 磁盘布局

```
<clawforumDir>/
├── watchdog.pid                  ← Watchdog 独占 / 启动写 / 关停删
├── watchdog-state.json           ← 跨进程状态（last seen + backoff + claw 历史 / A2-A4 W-tier 治理候选）
├── logs/
│   └── watchdog.log              ← 详细日志（console.log 兜底）
└── audit.tsv                     ← 全局 audit / 复用 / 写 WATCHDOG_* + CLAW_CRASH_* 事件
```

### 文件格式

- `watchdog.pid`：单行 `<pid>` 数字
- `watchdog-state.json`：JSON `{ /* version 字段 W-tier 待加 */, lastSeenAt: {...}, motionBackoff: {...}, clawState: {...} }`

### 重建语义

- 进程重启：经 CLI `watchdog start` 重新派生 / loadWatchdogState 容错回退默认（A3 W-tier 静默 catch）
- 状态文件不一致：A2 schema 无 version / 跨版本兼容靠运行期容错（W-tier 治理候选）
- watchdog.pid stale：watchdog start 检测 + 清理（自管 / 不经 ProcessManager.isAlive）

## 5. 审计事件清单

> 事件常量集中定义于 `src/watchdog/audit-events.ts` `WATCHDOG_AUDIT_EVENTS`（模块自治）。

7 个 WATCHDOG_* + CLAW_CRASH_* 事件：

| 事件 type | 触发时机 | 关键载荷 |
|---|---|---|
| `watchdog_stop` | SIGTERM/SIGINT 关停 | `signal`, `save_failed?` |
| `watchdog_crash` | 运行期 uncaughtException | `err` |
| `watchdog_cleanup_failed` | 主 loop iteration 异常 | `error_msg` |
| `watchdog_state_load_failed` | loadWatchdogState catch | `reason` |
| `watchdog_claw_scan` | 每 tick claw 扫描 | `ctx=inactivity\|crash`, `present=<comma-list>` |
| `claw_crash_detected` | claw was alive → now dead 且持合约 | `claw=<clawId>` |
| `claw_crash_notify_dropped` | crash notify drop 到 motion inbox 失败 | `claw=<clawId>`, `err` |

**保留 console 清单**（CLI status 输出 / 非审计语义）：
- watchdog.ts:135 `console.log(logLine.trim())` — log 输出
- watchdog.ts:511/533/535/544/549/554/565/569/575 — CLI startCommand / stopCommand / statusCommand status 输出 / 人眼 checkpoint

## 6. 层级声明

L6 进程边界（观察者 / 与 L6 Daemon / L6 CLI / L6 Assembly 同层 / 「进程级健康监控」业务语义独立可变 / **非智能体观察者**）。下游 CLI（L6 同层）直 dep Watchdog 公共 export（不直 import 内部实现 / 由 module visibility 控制）。watchdog-entry.ts shim 是进程 main / 由 CLI `watchdog start` 派生独立运行。详见 [architecture.md](../architecture.md) 加 [interfaces/l6.md](../interfaces/l6.md)。

## 7. 应然 vs 实然差距登记（M#10 / M#11）

> 原则：本节只登记**实然 ≠ 应然**的 gap（待治理或已治理的历史）+ 偏差 + 历史纪律。当前实然若与应然 align 则不在此登记。
>
> **W-tier 标记**：W-tier = 冻结期保留登记 / 风险高 / 等用户补 design 决策再解冻 / 不强行 mechanical 修。

### 7.A 必修违规（含历史已闭环）

| §A 条 | 类型 | 状态 | 触发情境 |
|---|---|---|---|
| ~~A.1 `log()` helper 无 audit 伴随~~ | drift | **已闭环（phase265）** | logWithAudit helper 引入 / 主路径 log 调用同写 audit |
| A.2 `watchdog-state.json` 无 version 字段 | drift / 中 | **W-tier 保留**（应然 sharpen / r60+ phase 落地）| **应然 rule**：状态文件 schema 必含 `version: number` 字段 / 跨版本破坏性 schema 变更需 version bump + 反向兼容 load 逻辑。当前实然无 version / 跨版本兼容靠运行期容错。升档：跨版本破坏性 schema 变更 / 推 r41+ 代码 phase |
| A.3 `loadWatchdogState` 静默 catch | drift / 低 → ⚓ accepted-stable | **⚓ accepted-stable** | **应然立场已合规**：容错回退默认状态 + audit `watchdog_state_load_failed` / D2「不丢弃 / 静默」满足（信息不丢失） / 静默 catch 仅指对调用方不冒泡 / 不是 audit 静默。升档：A.2 治理时同步评估 |
| A.4 `saveWatchdogState` 非原子写 | drift / 中 | **W-tier 保留**（应然 sharpen / r60+ phase 落地）| **应然 rule**：所有状态文件写入必走 L1 FileSystem.writeAtomic（temp + rename / rename 前崩溃不污染原文件）/ 当前实然直 writeFileSync。升档：状态文件损坏频发 / 推 r41+ 代码 phase |
| A.5 `daemonCommand` 命名冲突 | drift / 低 | **W-tier 保留** | watchdog.ts L335 import 名与 daemon.ts daemonCommand 函数名同 / 历史命名遗留 |
| A.6 watchdog-entry.ts 无 uncaughtException handler | drift / 中 | **W-tier 保留** | shim 18 行 / 应有显式 uncaughtException + audit `watchdog_crash`（实然有 audit 但 shim 路径未显式装）|
| A.7 `maybeCronClawCrash` 路径无 audit | drift / 低 | **W-tier 保留**（应然 sharpen / r60+ phase 落地）| **应然 rule**：三分判定（cron 派生 / 真崩溃 / 不确定）每分支必 audit 留痕（D5「日志重建任一时刻」derive）/ 当前实然缺 audit。升档：r41+ 代码 phase |
| A.8 跨 agent `fs.readdirSync` 全路径无 audit（≥ 9 处）| drift / 中 | **W-tier 保留**（应然 sharpen / r60+ phase 落地）| **应然 rule**：跨 agent 目录读取失败必经 AuditWriter audit（含目标 agent + 失败原因）/ 仅 logs/watchdog.log 不够（缺结构化）/ D2 derive。升档：r41+ 代码 phase |
| A.9 主 loop 轮询非事件驱动 | design-gap | **W-tier 保留** | tick 模型 / D8 N/A 显式豁免 / 升档：performance 告警或 fs.watch 替代决策 |
| A.10 测试覆盖 watchdog.ts 8 exports 中 5 未测 | drift / 低 | **W-tier 保留** | startCommand / stopCommand / statusCommand / runWatchdogLoop / getWatchdogEntryPath 缺直测（仅集成覆盖）|
| A.11 watchdog PID 独立于 ProcessManager 自注册体系 | design-gap → ⚓ accepted-stable | **⚓ accepted-stable** | **应然立场已合规**：watchdog.pid 自管是设计意图（防 ProcessManager + Watchdog 互相监控的循环）/ 监督进程不应由被监督方管 PID。升档：仅当 ProcessManager 重构能避循环 |
| ~~**A.12 `createWatchdogPort` 工厂位置 cross-layer leak `src/foundation/config/factories.ts`**~~ | layer drift / 中 | **✅ closed（phase419 / SHA `d5552dcb`）** | phase419 实施：物理迁 `src/foundation/config/factories.ts:99-130` → `src/watchdog/watchdog-port-factory.ts` (NEW) / 4 CLI caller import path 同步 / 同 phase360 cleanupOrphanedTemp 物理迁 + phase378 ShellTool 物理迁同型治理 / 0 行为改 / 1370+ 测试 PASS |
| **A.spec-1 应然 silent on 公共 export `shutdownWatchdog` / `loadWatchdogState` / `saveWatchdogState` / `logWithAudit`** | spec drift / 低 | **closed**（phase414c L6 audit / interfaces/l6.md align 实然 4 公共 export）| 历史 interfaces 写应然 7 export (startCommand/stopCommand/statusCommand/getWatchdogPid/isWatchdogAlive/getWatchdogEntryPath/runWatchdogLoop) / 实然多 4 export (shutdownWatchdog / loadWatchdogState / saveWatchdogState / logWithAudit) / 应然 underspec / phase414c interfaces/l6.md 修订加 4 实然 export |
| **A.spec-2 应然 startCommand/stopCommand/statusCommand 位置错位** | location drift / 低 | open（phase414c L6 audit 登记 / 推 r+1 phase 评估）| 应然 interfaces/l6.md 写 startCommand/stopCommand/statusCommand 是 Watchdog 模块 export / 实然 = 这 3 命令在 `src/cli/commands/` 而非 `src/watchdog/` (CLI 装配期 wire 到 watchdog 业务逻辑 / commander program 模式) / 命令本质是 CLI 入口 wrapping Watchdog 业务 / 升档：明确归 CLI 模块 vs Watchdog 模块 / 当前两边都登记 |

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| ~~watchdog.ts 物理位置 `cli/commands/` 而非 `src/` 根~~ | drift | **已闭环（phase303 / 整理债 C.3）** / 物理迁 `src/watchdog/` |
| motion 作为 claw crash 通知中介 | design-gap / 设计意图 | open 保留 / KD 决策 / 集中通知归 motion 单点 |
| watchdog-state.json 跨进程持久化 | design-gap | open 保留 / 监督需跨重启状态 / 当前 A2-A4 W-tier 治理候选 |
| 主 loop 轮询非事件驱动 | design-gap | A9 W-tier / tick 模型可观察 / D8 不适用（监督本质轮询）|
| watchdog.pid 自管 | design-gap | A11 W-tier / 监督进程独立体系合理 |
| ~~watchdog audit event 字符串硬编码~~ | drift | **已闭环（phase349 / r44 C）** / WATCHDOG_AUDIT_EVENTS 模块自治 / 全 caller 引用 const |
| ~~audit fork 误报~~ | drift / fork 误报 | **已闭环（phase349 Path #1 推翻）** / dispatch table N+3 实证 / fork 推荐 ≠ 终方案 |

### 7.C 应然原则对照

> 仅列应然对各原则的承诺立场 / 不写「合规✓」claims。

**Module Logic Principles**

- M#1 独立可变职责：观察 + 干预 vs Daemon 智能体循环驱动 = 完全不同关注点
- M#2 业务语义归属：进程健康监控由本模块发起 / 不归 Daemon
- M#3 资源唯一归属：watchdog.pid + watchdog-state.json + logs/watchdog.log 独占
- M#4 持久化：watchdog-state.json 跨进程持久化（A.2-A.4 W-tier 治理候选）
- M#5 依赖单向：L6 → L1 (FileSystem) + L2 (ProcessManager / AuditLog / Messaging InboxWriter / Stream LLM_OUTPUT_EVENTS Set) + L4 (ContractSystem utils / collectContractEvents) + L6 (CLI config)（per arch §30 表 1）/ 不上引 L6+ 装配 / 不依赖 Assembly
- M#6 依赖结构稳定：CLI 直 dep Watchdog 公共 export（L6→L6 同层单向 / phase422 后真合规 / port pattern 已删）
- M#7 耦合界面稳定：公共 export + utils 形态稳定
- M#8 耦合界面最小：CLI 经 Watchdog 公共 export 消费 / 内部细节由 module visibility 控制
- M#9 显式编译器可检：phase349 WATCHDOG_AUDIT_EVENTS const 集中 + structural typing port
- M#10 不合理停下：phase176 冻结期决策 / 不强行重构 / W-tier 显式登记保留
- M#11 边界对不上停下：A.1-A.11 显式登记 / 11 W-tier 保留待用户 design 决策

**Design Principles**

- D1a 信息不丢失：phase265 + phase349 接力 / WATCHDOG_* + CLAW_CRASH_* 事件覆盖
- D1b 状态可观察：watchdog_claw_scan 每 tick 写 / claw 状态可重建
- D1c 中断可恢复：watchdog-state.json 跨重启共享（A.2 W-tier）
- D1d 事后可审计：7 events 全覆盖 / phase349 const 引用合规
- D2 不丢弃 / 静默：A.3 loadWatchdogState 静默 catch W-tier 保留（已 audit / 信息不丢）
- D3 用户可观察：CLI status 输出（console.log 保留 / 非审计语义）+ logs/watchdog.log
- D5 日志重建：7 events + watchdog-state.json 足以重建监督轨迹
- D6 智能体决策主体：N/A（非智能体本质）
- D7 系统可信路径：经 InboxWriter / ProcessManager 受信注入消费
- **D8 事件驱动：N/A（A.9 W-tier / 主 loop 轮询模型 / 监督本质 / 显式豁免）**
- D9 CLI 唯一对外：经 CLI `watchdog start/stop/status` 入口
- D10 多 claw 不隔绝：跨 agent 目录读 ≥ 9 处（B.5.3）/ 监督本质需跨 claw
- D11 motion 特殊：motion 作为 claw crash 通知中介（设计意图）

**Philosophy**

- P1 Agent 即目录：监督跨 agent 目录（D9）
- P3 多 agent 利用：监督 motion + 多 claw / 不参与执行
- P4 系统为智能体服务：提供「进程健康监控 + 自动重启 + crash 通知中介」基础设施

**Path Principles**

- Path #1 实然为唯一基准：phase176 冻结登记 / phase265 / phase303 / phase311 / phase348 / phase349 各 phase 起步 Path #1 复核
- Path #3 语义最小变更：phase349 caller 风格统一并轨第 3 次复用（watchdog audit event + audit fork 误报 双 drift 治理）
- Path #6 冲突立即中断：phase349 audit fork 误报 / Path #1 推翻 / 不 mechanical 修 / dispatch table N+3 实证
- Path #8 总难度最低：W-tier 11 条登记保留 / 不强行清零（顶层模块冻结期纪律）
- 反向测试：本模块可独立替换 ProcessManager / FileSystem 实现而不动 CLI caller —— H9 port + M#1 ✓

### 7.D 历史纪律

- 2026-04-21 / phase176 L6 Watchdog 冻结契约首次登记（顶层模块抢跑期 / 方法论：feedback_top_module_freeze_window）/ §7.D 关键决策映射表首次
- 2026-04-24 / phase265 §7.A A.1 清零（log 路径 audit 集成 + logWithAudit helper）
- 2026-04-25 / phase303 整理债 C.3 物理迁移（watchdog.ts 从 `cli/commands/` 迁 `src/watchdog/` / 物理位置 drift 闭环）
- 2026-04-25 / phase311 N5 daemon/watchdog @module + layer-map 注释（4 文件 + layer-map 2 条目 / phase294 硬前置）
- 2026-04-27 / phase336 H1 audit-events.ts 模块自治拆分（WATCHDOG_AUDIT_EVENTS 物理迁出全局 events.ts）
- 2026-04-27 / phase346 watchdog-utils 共享部分迁离（β-utils / `LLM_OUTPUT_EVENTS` 迁 stream / `getContractCreatedMs` 迁 contract/utils.ts / H9 接力第 2 步）
- 2026-04-27 / phase348 H9 L3 WatchdogObserver/Control port 立（**port pattern 第 4 次复用里程碑** / phase337+335+340+348 / NEW `src/cli/watchdog-port.ts` + createWatchdogPort factory / watchdog/ 0 改 / structural typing / H9 三 phase 接力收官）⚠ STALE 2026-05-03 推翻：port pattern 第 4 次复用是 design debt 累积 / 推 r61+ 反向 design phase / 详 feedback_governance_workaround_smell
- 2026-04-27 / phase349 watchdog_stop + LLM breaker events 双 drift 治理（watchdog audit event + LLM breaker events 闭环 / **caller 风格统一并轨第 3 次复用 / 模板成熟阈值达**）/ **dispatch table N+3 新形态**（audit fork 报告误报 / Path #1 推翻）
- r60+ 重编号：9 节 → 8 节 / 每节 derive 自一条 Module Logic Principle（删原 §1 所有权 hub / §2 接口 / §5 上游依赖 / §6 不可消除耦合 → 已并入 interfaces/l6.md / 拆原 §1 为 §1 职责 + §2 业务语义 + §3 资源 + §4 持久化）

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| KD（待编号 / 监督本质）| Watchdog 是非智能体观察者 / 与 Daemon 并列但职责完全不同 | ✓ |
| KD（待编号）| Watchdog 独立进程 / 不装进 motion / claw daemon | ✓（CLI watchdog start 派生）|
| KD（待编号）| motion 作为 claw crash 通知中介 | ✓ 设计意图保留 |
| KD（待编号 / phase348 H9）| CLI 经 port 消费 Watchdog / 不直 import 内部 | ⚠ STALE 2026-05-03 推翻 / port pattern 第 4 次复用是 design debt / 真合规 = CLI 直 dep Watchdog 顺向（L6→L6 同层 OK / 内部细节用 module visibility 控制即可）/ 详 feedback_governance_workaround_smell |

## 8. 测试覆盖

应然行为（不绑定具体测试文件路径 / A.10 W-tier 5 exports 缺直测）：

- **观察路径**：motion 存活轮询 / claw 崩溃检测（was alive → now dead 且持合约）/ claw 不活跃检测（LLM 事件 timeout）
- **干预路径**：motion 自动重启 + 指数 backoff（上限 5 min）/ crash_notification drop 到 motion inbox / 不活跃提醒 drop
- **状态文件**：loadWatchdogState 容错回退（A.3 W-tier）/ saveWatchdogState 关停时写（A.4 非原子 W-tier）
- **生命周期**：startCommand 检测既有 pid → 派生进程 / stopCommand SIGTERM → 等待 → SIGKILL 兜底 / statusCommand 显示当前 pid + alive 状态
- **审计回链**：每个 §5 WATCHDOG_* + CLAW_CRASH_* 事件触发时机 + 载荷断言（7 events 全覆盖 / phase349 const 引用合规）
- **H9 port 适配**（phase348）：createWatchdogPort factory 构造 adapter / structural typing 满足 WatchdogObserver + WatchdogControl
- **跨 agent 目录读**：≥ 9 处 fs.readdirSync 防御性 catch（A.8 W-tier）/ 单 agent 失败不阻塞其他
- **maybeCronClawCrash 三分判定**：cron 派生 / 真崩溃 / 不确定（A.7 W-tier audit 缺）
- **保留 console**：CLI status 输出（startCommand / stopCommand / statusCommand）人眼 checkpoint / 非审计语义
- **β 双写**：log helper（phase265）log + audit 双写
