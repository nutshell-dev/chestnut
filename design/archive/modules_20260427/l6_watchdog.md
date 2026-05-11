# Watchdog 接口契约

**应然**（2026-04-26 修订 / 跟 modules.md §28 align）：进程级健康监控。独立进程，观察 + 干预系统健康状态。非智能体（无 LLM / 无 prompt），是监督基础设施。Motion 存活监控与自动重启、Claw 崩溃/不活跃检测与中介通知。

**实然**：落地于 `src/watchdog/watchdog.ts` + `src/watchdog/watchdog-utils.ts` + `src/watchdog-entry.ts` shim。主 loop 轮询模型（非事件驱动，B.p176-4 / A9 W-tier 保留）。§7.A 9/11 清零 / 2 条 W-tier 等触发（A9 主 loop 事件驱动 / A11 PID 归 PM 自注册）。§7.B 5 条偏差保留。

归属：L6a 进程入口 — 观察者进程。
- **应然依赖**：ProcessManager, AuditLog, FileSystem, CLI config
- **实然依赖**：ProcessManager (createProcessManagerForCLI), AuditWriter (direct new), NodeFileSystem + direct fs, cli-factories (createDirContext), cli/config, utils/inbox-writer, watchdog-utils.ts (internal), node 内置

> 状态：冻结登记（phase176，承 phase172 Daemon 同型模板）
> 起点 main：`e177d44`（phase174 合入后）
> Scope：A 契约 + D modules.md 索引两动作 / 零代码改动

---

## 1. 所有权

### 归属层

L6a 进程入口 — **观察者进程**（第 2 个 L6a 契约，承 Daemon 之后）。

Watchdog 是 **非智能体观察者**：无 LLM、无推理、无 prompt，是**监督基础设施**。与 Daemon（驱动 claw/motion 智能体循环）并列，但职责完全不同。

### 身份

- 物理位置：`src/cli/commands/watchdog.ts`（516 行主体，**N1 实然 512 行**，phase216 InboxWriter 迁移净减 4 行，不影响 §7.A 分析）+ `src/cli/commands/watchdog-utils.ts`（135 行纯函数聚合）+ `src/watchdog-entry.ts`（2 行 shim）
- 进程形态：独立进程（`node watchdog-entry.js`），由 CLI `watchdog start` 启动
- **非智能体身份**：观察 + 干预两类动作，不是任何 claw 或 motion 的执行体

### 职责（按"观察 + 干预"两面）

**观察面**（主 loop 轮询）：
1. motion 进程存活检测（`pm.getAliveStatus('motion')`）
2. claw 进程存活检测（`pm.isAlive(clawId)` 逐 claw 枚举）
3. claw 活动度检测（`gatherClawSnapshot` + `getClawActivityInfo` 读 stream.jsonl）
4. claw 合约状态（`clawHasContract` + `getContractCreatedMs`）
5. 系统全局状态登记（`watchdog_check` audit 事件）

**干预面**（根据观察决策）：
1. motion 崩溃 → 重启（`pm.spawn('motion', ...)` + backoff 指数回避 / 上限 5 min）
2. claw 崩溃（was alive, now dead, 且有合约）→ drop crash_notification 文件到 motion inbox（motion 中介）
3. claw 长时间不活跃（timeout_ms 未出 LLM 事件）→ drop inactivity 提醒到 motion inbox

### 资源（Watchdog 独占）

- `.clawforum/watchdog.pid`：自己维护的 PID 文件（**不**通过 ProcessManager 自注册 —— watchdog 是 PM 的使用者，PM 自注册 API 是给被观察进程用的，这一层不能反向依赖）
- `.clawforum/watchdog-state.json`：跨进程持久化的通知状态（`lastInactivityNotified` + `inactivityNotifyCount`）
- `.clawforum/logs/watchdog.log`：append-only 文本日志
- `.clawforum/audit.tsv`：复用全局 audit（Watchdog 为自己事件的归属源）

### 业务语义（由本模块主动发起）

| 语义 | 对外输出 | 触发时机 |
|---|---|---|
| motion 健康维护 | 自动重启 motion 进程 + backoff 控制 | motion 存活检测失败 |
| claw 崩溃告警 | motion inbox `crash_notification` 消息（snapshot 含 contract + outbox）| claw 由 alive → dead 且持有合约 |
| claw 不活跃提醒 | motion inbox `watchdog_inactivity` 消息 | claw 持合约但 LLM 事件 timeout（可配）|
| 系统 liveness 日志 | `watchdog_check` audit + `watchdog.log` | 每主 loop tick（默认 30s） |
| 启动/关停事件 | `watchdog_start` / `watchdog_stop` audit | daemonCommand 开始 / shutdownWatchdog 结束 |

---

## 2. 接口

### 2.1 watchdog.ts 8 exports

| 行 | export | 签名 | 调用场景 |
|---|---|---|---|
| L31 | `getWatchdogEntryPath()` | `(): string` | CLI 启动时定位 entry shim |
| L74 | `shutdownWatchdog(auditWriter, signal)` | `(AuditWriter, string) => void [exit]` | 信号 handler 调用（SIGTERM/SIGINT） |
| L95 | `getWatchdogPid()` | `(): number \| null` | `watchdog status` CLI 查 PID |
| L105 | `isWatchdogAlive()` | `(): boolean` | `watchdog status` CLI 查存活 |
| L203 | `maybeCronClawInactivity(pm, audit)` | `async (ProcessManager, AuditWriter) => void` | 主 loop 每 tick 调用 |
| L335 | `runWatchdogLoop()` | `async (): Promise<void>` | watchdog-entry.ts 主入口（phase264 命名整治后 / 冲突消除）|
| L446 | `startCommand()` | `async (): Promise<void>` | CLI `watchdog start` 直接入口（spawn 子进程） |
| L480 | `stopCommand()` | `async (): Promise<void>` | CLI `watchdog stop` 直接入口（SIGTERM + 超时 SIGKILL） |

**归属说明**：
- `runWatchdogLoop` 是"主循环身份"（phase264 从 `daemonCommand` 改名 / 与 daemon.ts 同名冲突消除 / watchdog-entry.ts 别名消除）。
- `getWatchdogEntryPath` / `getWatchdogPid` / `isWatchdogAlive` 是 CLI 运维查询窗口（start/stop/status 消费）。
- `shutdownWatchdog` 是信号 handler 专用；外部不直接调用（仅 `runWatchdogLoop` 内 `process.on('SIGTERM', () => shutdownWatchdog(...))` 消费）。
- `maybeCronClawInactivity` 是主 loop 业务入口；**注意 `maybeCronClawCrash` 是私有**（L286，§7.A7 登记"claw 崩溃无 audit" 会连带讨论该私有函数）。

### 2.2 watchdog-utils.ts 8 exports

| 行 | export | 类别 | 备注 |
|---|---|---|---|
| L12 | `ClawActivityInfo` | interface | watchdog 自用 |
| L21 | `getClawActivityInfo(fs, audit)` | async function | watchdog 自用 |
| L58 | `clawHasContract(clawDir)` | function | watchdog 自用 + 测试 |
| L89 | `ClawSnapshot` | interface | watchdog 自用 + 测试 |
| L97 | `ProcessLiveness` | interface | watchdog 自用 + 测试 |
| L101 | `gatherClawSnapshot(clawDir, pm, clawId)` | function | watchdog 自用 + 测试 |
| L125 | `getEffectiveInterval(notifyCount, timeoutMs)` | function（backoff 3x 阈值）| watchdog 自用 + 测试 |
| L130 | `shouldResetNotifyCount(lastEventMs, lastNotified)` | function | watchdog 自用 + 测试 |

**已迁出（phase346）**：
- ~~`LLM_OUTPUT_EVENTS`~~ → `src/foundation/stream/types.ts`（stream 事件分类 / chat-viewport + watchdog 共享）
- ~~`getContractCreatedMs(clawDir)`~~ → `src/core/contract/utils.ts`（contract 目录读取 / chat-viewport + watchdog 共享）

**归属说明**：
- 8 exports 中 5 纯函数（无 IO 副作用除 fs.readdirSync / readFileSync）+ 3 interface
- 模块边界按 M1 反向测试：改任一函数不会连带其他（clawHasContract / getEffectiveInterval / shouldResetNotifyCount 是独立逻辑，各自可测），合规
- 归属可议（§7.B 登记）：`gatherClawSnapshot` 既读 FS 又用 ProcessLiveness，接近"snapshot 模块"候选，但无独立资源归属 → 暂留 utils

### 2.3 watchdog-entry.ts shim（2 行）

```ts
import { runWatchdogLoop } from './cli/commands/watchdog.js';
await runWatchdogLoop();
```

**与 daemon-entry.ts 对比**：
- daemon-entry.ts 12 行：uncaughtException + unhandledRejection + 内含 writeCrash → daemon_crash audit
- watchdog-entry.ts 2 行：**无 top-level error handler**，无 audit 包裹

→ §7.A6 登记"watchdog-entry 无 uncaughtException handler" + §7.A A6 衍生"无 watchdog_crash audit 对等"

### 2.4 内部私有（非 export）

| 符号 | 位置 | 语义 |
|---|---|---|
| `getClawforumDir` | L23 | 解 `getMotionDir` 的父目录（`.clawforum` 根） |
| `getWatchdogPidFile` | L40 | 返回 `.clawforum/watchdog.pid` |
| `getMotionContext` | L48 | 缓存的 motion `{ fs, audit }` context |
| `writeWatchdogPid` | L61 | 写 `.clawforum/watchdog.pid` JSON（含 pid + root） |
| `removeWatchdogPid` | L66 | 删 watchdog.pid 文件 |
| `log` | L124 | watchdog 日志 helper — `console.log(...)` + append `watchdog.log` |
| `writeWatchdogInboxMessage` | L139 | 往 motion inbox drop 文件（`watchdog_*` type）|
| `WatchdogState` + `loadWatchdogState` + `saveWatchdogState` | L161-191 | 跨进程状态持久化 |
| `getGlobalConfig` | L195 | 懒加载 global 配置缓存 |
| `maybeCronClawCrash` | L286 | **私有**，claw 崩溃检测（§7.A7 路径无 audit） |

---

## 3. 审计事件清单

**6 distinct types × 7 call sites**（以下按调用点汇总；type 集合 `{ watchdog_start, watchdog_stop, watchdog_check, watchdog_restart_triggered, process_spawn, process_spawn_failed }`）。

### 3.1 watchdog.ts 生命周期事件

| 行 | type | 载荷 | 触发条件 |
|---|---|---|---|
| L353 | `watchdog_start` | 无 | runWatchdogLoop 开始，auditWriter 初始化后立即写 |
| L88 | `watchdog_stop` | `signal=${signal}`, `save_failed=${msg}` | shutdownWatchdog 路径：saveWatchdogState 失败分支 |
| L90 | `watchdog_stop` | `signal=${signal}` | shutdownWatchdog 路径：save 成功分支 |

**合规性**：start + stop 对称 ✓（两个 stop call site 是成功/失败两分支，type 合并合规，与 daemon-entry `daemon_crash` 同族）。

### 3.2 watchdog.ts 观察 + 干预事件

| 行 | type | 载荷 | 触发条件 |
|---|---|---|---|
| L392 | `watchdog_check` | `alive=${clawIds.join(',')}` | 每主 loop tick，枚举存活进程后 |
| L396 | `watchdog_restart_triggered` | `motion` | 检测到 motion down，决定重启前 |
| L414 | `process_spawn` | `motion`, `pid=${pid}` | pm.spawn('motion', ...) 成功 |
| L423 | `process_spawn_failed` | `motion`, `err=${msg}` | pm.spawn 抛错且非 "already running"（失败分支累计 motionRestartFailures） |

**合规性**：干预"尝试 → 成功 / 失败"三向分叉，audit 覆盖完整 ✓。

**事件时序**（motion 重启典型路径）：

```
pm.getAliveStatus('motion')  →  alive=false
  ↓
audit: watchdog_check alive=...（motion 不在 aliveIds）
  ↓
audit: watchdog_restart_triggered motion
  ↓
pm.stop('motion').catch(...)  (清理 stale PID)
  ↓
pm.spawn('motion', ...)
  ↓ 成功分支                ↓ 失败分支
audit: process_spawn        audit: process_spawn_failed
```

### 3.3 事件回链缺口（§7.A 候选）

| # | 缺口 | 说明 | 登记 |
|---|---|---|---|
| A1 | `log()` helper L124-136 无 audit | watchdog 所有日志走 `console.log` + 文件 append，无 audit 伴随 | §7.A1 |
| A3 | `loadWatchdogState` L180 静默 catch | 文件损坏不发 audit 不显式提示 | §7.A3 |
| A6/A6' | watchdog-entry.ts 无 `watchdog_crash` audit | uncaughtException 未拦截，进程异常退出无审计回链 | §7.A6 |
| A7 | `maybeCronClawCrash` L285-336 全路径无 audit | claw crash → motion inbox 通知路径无 audit（函数签名不含 audit 参数，与 maybeCronClawInactivity 不对称） | §7.A7 |
| A8 | 跨 agent `fs.readdirSync` ≥ 9 处无 audit | 观察性读 — 不登记谁何时枚举了哪些 claw | §7.A8 |

**与 Daemon §3 对比**：
- Daemon 5 audit type / watchdog 6 audit type（含 process_spawn / process_spawn_failed 两个跨模块复用 type）
- Daemon § 8.2 phase174 已全 ✓；**Watchdog §8.2 尚未建立事件回链测试**（§7.A10 测试覆盖 5/8 未测）

---

## 4. 上游依赖

按 L1 → L6 依赖层级核查（`feedback_apply_principles_first` Design #7 单向依赖）。

### 4.1 L1 — FileSystem

| 消费面 | 行号 | 形态 |
|---|---|---|
| watchdog.ts | L15-16 | `FileSystem` type + `NodeFileSystem` 值 |
| 直接 node `fs.*` | 多处 | watchdog.ts 用 `import * as fs from 'fs'` 而非 FileSystem 抽象（**§7.B 登记**：L6a 进程级 IO 可直用 node `fs`；与 foundation/fs 抽象并存） |

**合规性**：混用（L6 可直接访问 node fs；foundation/fs 用于需要测试替身的边界如 auditWriter / inbox-writer）。

### 4.2 L2 — AuditLog

- watchdog.ts L17 `import { AuditWriter }` — 值消费
- L348 `new AuditWriter(new NodeFileSystem(...), 'audit.tsv', auditMaxSizeMb)` — 实例化位置
- 按层级：L6 直接 new L2 实例（无工厂）；与 Daemon 对齐（Daemon 也是直接 new AuditWriter）

### 4.3 L2 — ProcessManager（最核心上游）

- watchdog.ts L11 type + L14 值 import
- L18 `createProcessManagerForCLI` 工厂 import（**非 new**）
- L358 `const pm = createProcessManagerForCLI()` —— 工厂装配路径（phase169 工厂化后统一入口）
- 用法：`pm.getAliveStatus('motion')` / `pm.isAlive(clawId)` / `pm.spawn('motion', ...)` / `pm.stop('motion')`
- **不使用**：`pm.registerSelf` —— watchdog 进程 PID 自己维护 `.clawforum/watchdog.pid`（§5.4 不可消除耦合）

### 4.4 utils/inbox-writer

- watchdog.ts L19 `writeInboxMessage` import
- 消费点：`writeWatchdogInboxMessage` L139-154（往 motion inbox drop 文件）+ `maybeCronClawCrash` L322-331（往 motion inbox drop `crash_notification`）

### 4.5 CLI config

- watchdog.ts L13 `getMotionDir` + `loadGlobalConfig` import
- **无 `getClawDir`**（watchdog 跨 claw 读用 `path.join(getClawforumDir(), 'claws', clawId)` 手动拼接，§7.A8 / §7.B 登记）

### 4.6 watchdog-utils.ts（内部子模块）

- watchdog.ts L20 import 8 符号（5 函数 + 3 interface）from `./watchdog-utils.js`
- watchdog.ts 额外 import `LLM_OUTPUT_EVENTS` from `../foundation/stream/types.js`（phase346 迁出）
- watchdog.ts 额外 import `getContractCreatedMs` from `../core/contract/utils.js`（phase346 迁出）
- 单向依赖：watchdog.ts → watchdog-utils.ts（无反向）

### 4.7 cli-factories

- watchdog.ts L18 `createDirContext` + `createProcessManagerForCLI` import
- `createDirContext(getMotionDir())` 用于 `getMotionContext` helper（L50，缓存 motion 的 fs + audit）

### 4.8 node 内置

| 模块 | 用途 |
|---|---|
| fs / existsSync | 跨 agent readdirSync + 文件读写 |
| path | 路径拼接 |
| child_process (spawn, spawnSync) | 进程启停 |
| url (fileURLToPath) | ESM import.meta.url 解析 |
| timers/promises (setTimeout) | 主 loop backoff 非阻塞 sleep |

### 4.9 依赖层级合规

```
watchdog.ts (L6a)
  ├── L2: ProcessManager (via createProcessManagerForCLI factory)
  ├── L2: AuditWriter (direct new)
  ├── L1: FileSystem (NodeFileSystem + direct fs)
  ├── L6c: cli-factories (createDirContext)
  ├── L6b: cli/config (getMotionDir, loadGlobalConfig)
  ├── utils: inbox-writer (writeInboxMessage)
  └── internal: watchdog-utils.ts (8 exports)
  └── L2: stream/types.ts (LLM_OUTPUT_EVENTS, phase346 迁出)
  └── L4: contract/utils.ts (getContractCreatedMs, phase346 迁出)

watchdog-utils.ts
  └── L1: FileSystem / AuditLog (types only + readdirSync)
  └── L2: stream/types.ts (LLM_OUTPUT_EVENTS import, phase346)
```

**单向**：无 ProcessManager/AuditLog → watchdog 反向依赖；无 daemon.ts ↔ watchdog.ts 交叉（daemonCommand 同名冲突 phase264 已清零 / 不构成依赖）。

---

## 5. 不可消除耦合

**消除路径首选 port pattern**（feedback_module_contract_structure r40.2）：消费方 own port + 默认实现 + assembly 注入 / phase337+335+340 三 phase 实证。Watchdog 当前耦合（motion 中介 / 反向 cli 依赖）H9 治理中（phase343 L1 cycle 消 + phase346 L2 utils 迁 + phase347 L3 port 推 r43+）/ port pattern 第 4 次复用。

四类结构性耦合，冻结期不改，登记为契约约束。

### 5.1 motion 作为 claw crash 通知中介

**形态**：`maybeCronClawCrash` 检测到 claw 崩溃 → **不能直接通知用户**，只能 `writeInboxMessage` 文件 drop 到 motion inbox（L322-331），由 motion 消费并转发。

**为何不可消除**：
- Watchdog 无直接用户通道（无 LLM / 无 stream writer）
- Motion 是 claw 消息总线的上游（`crash_notification` 最终经 motion → 人类/claw 路径分发）
- 不可消除即使在未来重构：Watchdog 作为基础设施不升级为用户通道

### 5.2 watchdog-state.json 跨进程持久化

**形态**：`lastInactivityNotified` + `inactivityNotifyCount` 两 Map 必须跨 watchdog 进程重启保留（否则每次重启重新通知，形成噪声）。

**为何不可消除**：
- 通知去重是业务语义（不发重复提醒）
- Watchdog 进程重启不意味着 claw 状态重置

**治理缺口**（§7.A2-A4）：
- 无 version 字段 → 未来 schema 演进需迁移
- `loadWatchdogState` 静默 catch（L180）→ 文件损坏不发警告
- `saveWatchdogState` 非原子写（L190 直接 writeFileSync）→ crash 中途可能部分写

### 5.3 跨 agent 目录 readdirSync（≥ 9 处）

**形态**：Watchdog 本质职责就是枚举 `.clawforum/claws/*`，无法仅靠事件驱动。

**消费点**（读 `clawsDir` / `claw 子目录`）：
- watchdog.ts L209 / L224（maybeCronClawInactivity 活动度检测）
- watchdog.ts L291 / L304（maybeCronClawCrash 崩溃检测 + Map 清理）
- watchdog.ts L382（主 loop watchdog_check 枚举）
- watchdog-utils.ts L61 / L72 / L107 / L114（snapshot + contract 检测）

**为何不可消除**：
- 不支持事件驱动枚举（fs.watch 不观察"claw 启动"这个业务事件）
- 定期轮询是唯一合理形态

**治理缺口**（§7.A8）：无 audit 事件记录"watchdog 在 T 时刻观察到 [claw1, claw2, ...]"（与 `watchdog_check` 重复？否，watchdog_check 记"存活"，不记"存在"）。

### 5.4 watchdog.pid 独立于 ProcessManager 自注册体系

**形态**：watchdog 自己维护 `.clawforum/watchdog.pid`（`writeWatchdogPid` L61 直接 `fs.writeFileSync`），**不调用** `pm.registerSelf(...)`。

**为何不可消除**：
- ProcessManager 自注册 API 是给**被观察进程**（claw / motion）用的
- Watchdog 是 PM 的**使用者**，若反向依赖 PM 自注册会形成循环（PM 调 watchdog / watchdog 反注册到 PM）
- 架构上 watchdog 作为基础设施站在 PM 之上，PID 管理独立于 PM 体系

**影响面**：
- `watchdog status` 命令走 `getWatchdogPid()` 读 watchdog.pid（不走 PM API）
- PM 视角 watchdog 不可见；若 watchdog 崩溃，PM 无法发现（与 daemon 对 PM 有 registerSelf 的方式不同）

**治理登记**（§7.A11 / §7.D 关键决策）：此处是历史架构决策，冻结期不改。

---

## 6. 配置常量归属

### 6.1 Watchdog 独占常量

| 常量 | 位置 | 语义 |
|---|---|---|
| backoff 上限 `5 * 60 * 1000` | L439 硬编码 | motion 重启失败指数回避上限（5 min） |
| backoff 指数底 `Math.pow(2, n-1)` | L439 | 指数回避系数 |
| `getEffectiveInterval` 3x 倍数 | watchdog-utils.ts L125-128 | notifyCount ≥ 2 时 backoff 3x timeoutMs |

**§7.B 登记**（`B.p176-3`）：backoff 上限硬编码未抽常量，工程折衷（数值语义清晰 + 不需用户调）。

### 6.2 消费常量（来自 `loadGlobalConfig()`）

| 配置路径 | 默认 | 消费点 |
|---|---|---|
| `watchdog.claw_inactivity_timeout_ms` | 300000（5 min） | maybeCronClawInactivity |
| `watchdog.interval_ms` | 30000（30 s） | 主 loop sleep 间隔 |
| `audit.retention.max_size_mb` | null | AuditWriter 构造 |

### 6.3 未抽常量登记（§7.B 候选）

- `auditMaxSizeMb` 缺省 null（L347）— 与 Daemon 对齐合规
- `LLM_OUTPUT_EVENTS = new Set(['thinking_delta', 'text_delta', 'tool_call'])`（utils L19）— 跨模块枚举，合理内聚在 utils 中
- `removeWatchdogPid` + `getWatchdogPidFile` 路径 `.clawforum/watchdog.pid` — 路径拼接未抽常量（与 daemon `.clawforum/daemon.pid` 对齐，路径拼接方式一致）

---

## 7. 实然差距

### 7.A 必修违规（未来稳定化 phase 的基线 scope）

11 条（phase176 登记；未来各条对应独立稳定化 phase）。

#### A1 `log()` helper 无 audit 伴随 — ✅ phase265 已清零

**发现**：watchdog.ts L124-136 `log(message)` 是所有内部日志唯一输出 helper，实现为 `console.log(...)` + append `watchdog.log`，**完全无 audit 伴随**。

**治理**：phase265（r19 F / SHA `bc77c29`）新增 `logWithAudit(message, auditType?, payload?)` + `let _auditWriter: AuditWriter | null = null` module-level 变量 + `WATCHDOG_CLEANUP_FAILED` 常量；L397 `Failed to clean up motion before restart` 迁移到 `logWithAudit`。3 新 it 验证行为契约。

**phase 锚点**：phase176 §7.A1 登记；phase265 §7.A1 清零（merge SHA `bc77c29`）。

#### A2 `watchdog-state.json` 无 version 字段

**发现**：watchdog.ts L161-164 `WatchdogState` interface 仅含 `lastInactivityNotified` + `inactivityNotifyCount`，**无 version / schema 字段**。

**当前行为**：
```ts
interface WatchdogState {
  lastInactivityNotified: Record<string, number>;
  inactivityNotifyCount: Record<string, number>;
}
```

**应然**：按 Design #5（审计/状态为契约）+ Path #4（可回滚 + 破坏性论证）：未来若新增字段（如 `lastCrashNotified` 去重 claw crash 通知），老 watchdog-state.json 无法兼容判定。应加 `version: 1` 字段；读时按 version 分派解析。

**影响面**：schema 演进困难；若未来跨版本兼容出错，状态丢失重导致通知噪声。

**治理路径**：独立稳定化 phase（与 A3/A4 合并）—— 加 version 字段 + loadWatchdogState 按版本分派 + saveWatchdogState 写 version: 1。

**phase 锚点**：phase176 §7.A2 登记。**→ phase272 已清零**（bc7ec5446815942848e9727c7140e7cfb0f533cf 2026-04-24）  
`WatchdogState.version?: number`（v0 = absent 向后兼容 / v1 = current）；`saveWatchdogState` 写 `version: 1`；`loadWatchdogState` 读时 `state.version ?? 0` 兼容旧格式。

#### A3 `loadWatchdogState` 静默 catch

**发现**：watchdog.ts L170-183 载入路径：
```ts
function loadWatchdogState(): void {
  try {
    const raw = fs.readFileSync(getWatchdogStateFile(), 'utf-8');
    const state = JSON.parse(raw) as WatchdogState;
    for (const [k, v] of Object.entries(state.lastInactivityNotified ?? {})) { ... }
    for (const [k, v] of Object.entries(state.inactivityNotifyCount ?? {})) { ... }
  } catch {
    // 首次启动或文件损坏 — 从空状态开始
  }
}
```

**应然**：按 Philosophy #2（不得丢弃/静默）：catch 块应区分"首次启动"（ENOENT）vs"文件损坏"（SyntaxError / 字段类型错）。第二类应发 audit `watchdog_state_load_failed` + 文件重命名备份（`watchdog-state.json.corrupt-${timestamp}`）。

**影响面**：文件损坏时从空状态重启 = 通知计数丢失 = 用户收到重复提醒（违反 5.2 去重语义）。

**治理路径**：同 A2/A4 合并 phase 处理。

**phase 锚点**：phase176 §7.A3 登记。**→ phase272 已清零**（bc7ec5446815942848e9727c7140e7cfb0f533cf 2026-04-24）  
`loadWatchdogState` catch 拆两路：ENOENT → 静默；其余 → `renameSync` backup（`.corrupt-${Date.now()}`）+ `_auditWriter?.write(WATCHDOG_STATE_LOAD_FAILED, ...)`；N1 修复保证 `_auditWriter` 在调用前已赋值。

#### A4 `saveWatchdogState` 非原子写

**发现**：watchdog.ts L185-191：
```ts
function saveWatchdogState(): void {
  const state: WatchdogState = { ... };
  fs.writeFileSync(getWatchdogStateFile(), JSON.stringify(state, null, 2));
}
```

**应然**：按 Philosophy #1a（信息不丢失）：writeFileSync 在写中途 crash → 文件部分写 → 下次 load 触发 A3 静默 catch → 状态丢失。应用 write-to-temp + rename 原子模式（或复用 `foundation/fs` 的 writeAtomic）。

**影响面**：watchdog crash 中途（尤其在主 loop 每 tick 的 L434）概率虽低但存在；触发 A3 路径。

**治理路径**：同 A2/A3 合并 phase，改用 writeAtomic。

**phase 锚点**：phase176 §7.A4 登记。**→ phase272 已清零**（bc7ec5446815942848e9727c7140e7cfb0f533cf 2026-04-24）  
`saveWatchdogState` 改为 `writeFileSync(tmp)` + `renameSync(tmp, dest)`（POSIX 原子；Windows best-effort）；`tmp` 路径含 `process.pid` 后缀，crash 残留不干扰 state 读取。

#### A5 `daemonCommand` 命名冲突（watchdog.ts L335 vs daemon.ts）

**发现**：
- watchdog.ts L335 `export async function daemonCommand()` —— 主 loop 入口
- daemon.ts 同名 `export async function daemonCommand()` —— daemon 主入口
- watchdog-entry.ts L1 必须 `import { daemonCommand as watchdogDaemonCommand }` 别名绕开

**应然**：按 Module Logic #M8（耦合界面最小）+ Design #1（独立可变职责）：命名应反映职责而非结构。建议改名 `runWatchdogLoop` / `watchdogMainLoop`，消除与 Daemon 的同名冲突。

**影响面**：
- 代码可读性：读 watchdog.ts 见 `daemonCommand` 第一反应是 daemon
- 维护性：新人接手时需查 entry shim 才能确认职责
- IDE 提示：跳转时需手动区分文件

**治理路径**：独立命名整治 phase（影响面：watchdog-entry.ts 别名可去 + 函数签名改 1 处 + 可能的测试用例引用更新 + export symbol 变更）。

**phase 锚点**：phase176 §7.A5 登记。

**→ phase264 已清零**（`daemonCommand` → `runWatchdogLoop` / watchdog-entry.ts + cli/index.ts 别名消除 / 5 处改动 / 测试零改动）

#### A6 watchdog-entry.ts 无 uncaughtException handler

**发现**：watchdog-entry.ts 2 行（见 §2.3）**无** uncaughtException / unhandledRejection 拦截，对比 daemon-entry.ts 12 行含两层 handler + writeCrash → `daemon_crash` audit。

**应然**：按 Philosophy #2（不得丢弃/静默）+ Design #5（审计为契约）：进程异常退出路径必须有 audit 回链。应补 `process.on('uncaughtException', ...)` 拦截 + 发 `watchdog_crash` audit + 同步 flush 到 audit.tsv。

**影响面**：
- watchdog 进程非预期崩溃（OOM / unhandled promise rejection）无审计回链
- 故障排查靠 shell 退出码 + 系统日志，非 audit 内线索

**治理路径**：独立稳定化 phase 补 shim handler；与 daemon-entry 对齐结构；新增 `watchdog_crash` audit type。

**phase 锚点**：phase176 §7.A6 登记。

**→ phase269 已清零**（6c4f2e2 2026-04-24）  
实施：`watchdog-entry.ts` +uncaughtException / +unhandledRejection handler；`watchdog.ts` `writeWatchdogCrash(err)` export（使用 `_auditWriter?.write(WATCHDOG_CRASH)`）；`WATCHDOG_CRASH` 常量

#### A7 `maybeCronClawCrash` 路径无 audit

**发现**：watchdog.ts L285-336 `function maybeCronClawCrash(pm: ProcessManager): void` **不接受 audit 参数**，全路径无 `auditWriter.write(...)` 调用。对比 `maybeCronClawInactivity(pm, audit)` 有 audit 参数 + 在适当处写 audit。

**当前行为**：
- L309 检测到 `wasAlive && !currentlyAlive` → log → writeInboxMessage（`crash_notification` drop 到 motion inbox）
- writeInboxMessage 内部会写 `inbox_message_written` audit（从 motion audit context），但 watchdog 视角**无**对等 `claw_crash_detected` / `claw_crash_notified` audit

**应然**：按 Design #5（审计为契约）+ Philosophy #1b（状态可观察）：claw crash 是 watchdog 的核心业务事件，必须 audit；函数签名应对齐 `maybeCronClawInactivity(pm, audit)`，新增 audit 参数；主 loop L433 调用处传 auditWriter。

**影响面**：
- claw crash 统计无法从 watchdog audit 直接查出
- 需关联 motion inbox 消息 timestamp + watchdog.log 才能还原

**治理路径**：独立稳定化 phase —— 改函数签名 + 新 audit type `claw_crash_detected` / `claw_crash_notify_dropped` + 主 loop 传参。

**phase 锚点**：phase176 §7.A7 登记。

**→ phase269 已清零**（6c4f2e2 2026-04-24）  
实施：`maybeCronClawCrash(pm, audit: AuditWriter)` 签名改（export 化供测试）；crash 检测路径 +`CLAW_CRASH_DETECTED`；inbox 写入失败路径 try/catch +`CLAW_CRASH_NOTIFY_DROPPED`；主 loop L448 透传 `auditWriter`；`CLAW_CRASH_DETECTED` / `CLAW_CRASH_NOTIFY_DROPPED` 常量

#### A8 跨 agent `fs.readdirSync` 全路径无 audit（≥ 9 处）

**发现**：F14 grep 结果汇总 —— watchdog.ts 5 处（L209 / L224 / L291 / L304 / L382） + watchdog-utils.ts 4 处（L61 / L72 / L107 / L114）跨 agent 目录枚举，全部无 audit。

**应然**：按 Philosophy #1b（状态可观察）：观察者在 T 时刻"看见了哪些 claw" 是业务事件（与 `watchdog_check alive=...` 区分：alive 是"存活"，观察读是"存在 + 被检测"）。应设计 `watchdog_observe_claws alive=... inactive=... crashed=...` 更丰富载荷，或每次读发 `watchdog_readdir` 细粒度事件。

**影响面**：
- 观察者视角缺失"谁在被观察"维度
- 若有 claw 被外部创建但 watchdog 没检测到（如权限问题），无 audit 能追溯

**治理路径（phase277 决策）**：
- watchdog.ts 5 处按函数分 3 次补 audit（不逐处补）：
  - `maybeCronClawInactivity`（L230+L245 合一）：`WATCHDOG_CLAW_SCAN, ctx=inactivity present=...`
  - `maybeCronClawCrash`（L312+L325 合一）：`WATCHDOG_CLAW_SCAN, ctx=crash present=...`
  - 主 loop L407：扩展现有 `watchdog_check` payload 追加 `present=...`
- watchdog-utils.ts 4 处（L61/L72/L107/L114）：per-claw 子目录读，父 scan event 覆盖，不独立 audit

**phase 锚点**：phase176 §7.A8 登记；**→ phase277 已清零**（WATCHDOG_CLAW_SCAN × 3处 / merge SHA `90e4953`）2026-04-24。

#### A9 主 loop 轮询非事件驱动

**发现**：watchdog.ts L373-442 主 loop 是 while + sleep 结构；无 `fs.watch` / chokidar 事件订阅。

**应然**：按 Design #6（事件驱动优先于轮询）：文件变化（contract 出现 / 消失）可事件驱动。现状是每 30s 轮询一次所有 claw 目录。

**影响面**：
- 响应延迟最长 30s（watchdog.interval_ms 配置）
- CPU 开销：即使无 claw 在线也定期 readdir

**为何归 §7.A 观察而非 §7.B 合规**：
- 若仅是工程折衷应登记 §7.B
- 但本条涉及"观察延迟"语义；若未来 claw 启动/消失是高频事件，轮询模型会成为瓶颈
- 保留 §7.A 观察位，下一次用户反馈 claw 启动延迟感知则升级

**治理路径**：待触发（用户反馈 / 规模扩张）；若升级，需重写主 loop 为 `fs.watch` + 轮询 fallback 混合。

**phase 锚点**：phase176 §7.A9 登记。

**phase281 确认**：W-tier 继续保留。H/M/L 全清零（phase277）后无新触发条件。§7.B4 双重登记维持（工程折衷 + 观察位）。

#### A10 测试覆盖 watchdog.ts 8 exports 中 5 未测

**发现**：F6 + D4 测试矩阵
- watchdog.ts：5/8 未测（getWatchdogEntryPath / isWatchdogAlive / runWatchdogLoop / startCommand / stopCommand）
- watchdog-utils.ts：0/6 未测（phase346 迁出 getContractCreatedMs → contract/utils.ts）

**应然**：按 Module Logic #M8（耦合界面稳定测试护栏）+ phase174 daemon §8 同标准：核心 export 至少有一条 it 覆盖（可合规小于 100%，但主路径必覆盖）。

**影响面**：
- runWatchdogLoop / startCommand / stopCommand 是用户可见命令；主 loop 完全未测
- 与 phase174 daemon.ts 5 audit 事件回链测试对标，watchdog 本层缺口更大

**治理路径**：独立测试补齐 phase（参 phase174 daemon-command.test.ts 模板 — 6 层 mock + 11 it / Module Logic #3 资源归属）。预估规模 ~300-400 行 test file。

**phase 锚点**：phase176 §7.A10 登记。**→ phase271 已清零**（tests/cli/watchdog.test.ts +~18 it / getWatchdogPid / isWatchdogAlive / getWatchdogEntryPath / startCommand / stopCommand / runWatchdogLoop 全覆盖 / crash 路径 TODO 等 H3）

#### A11 watchdog PID 独立于 ProcessManager 自注册体系

**发现**：F15 + §5.4 —— watchdog 自维护 `.clawforum/watchdog.pid`（`writeWatchdogPid` L61 直接 `fs.writeFileSync`），不调用 `pm.registerSelf(...)`。

**应然**（PM 自注册角度）：按 Module Logic #M3（资源归属）+ Design #3（数据流）：统一 PID 管理应走 PM 唯一 API。但 watchdog 特殊性（观察 PM 使用者本身）导致反向依赖 PM 自注册会形成循环。

**当前决策**（§5.4）：**设计为不可消除耦合**（登记 §7.D 关键决策）。但若未来 PM 提供"非被观察的观察者自注册" API（明确区分），可改造 watchdog 使用新 API。

**影响面**：
- PM 的 `getAliveStatus` 无法观察到 watchdog 本身
- `watchdog status` CLI 需走独立的 `getWatchdogPid` + `isWatchdogAlive`
- 若 watchdog 进程异常死亡，外部无法从 PM 体系发现，只能靠系统层手段

**为何登记 §7.A 而非仅 §5.4**：
- §5.4 说明"为何现状合理"
- §7.A11 观察"如果架构演进，此处是改造候选"
- 双登记反映"当前合规 + 未来观察位"

**治理路径**：暂无 phase；等 PM 提供观察者自注册 API 时重评。

**phase 锚点**：phase176 §7.A11 登记。

**phase281 确认**：W-tier 继续保留。PM 自注册 API 无演进（r22 起步 SHA bc7ec54 核实）；触发条件不变。

---

### 7.B 偏差登记（当前合理 / 冻结期不改）

按 `feedback_deviation_registry` 规范：每条包含质疑 / 理由 / 顺手成本评估 / 治理路径。

**type 标签**（feedback_module_contract_structure r40.3）：B 项必标 `drift` vs `design-gap` 二分。
- **drift type**：契约说应 X / 实然 Y / 修法明确（推 §7.A 必修）
- **design-gap type**：应然 silent / 实然有 / 修法不明 / 必推独立 design phase 评估

> 现有 B.p176-* 历史登记 type 分类待 r43+ 应然同步 phase 批量补标。已知初判：
> - B.p176-1 watchdog.ts 物理位置 = **drift / phase303 部分消化**
> - **B.p344-watchdog-1 watchdog_stop hardcode**（r42 D fork 第 5 轮新发现）= **drift / 局部**：watchdog.ts L96/98 直字符串 `'watchdog_stop'` 未用 WATCHDOG_AUDIT_EVENTS 常量 / B.p344 模式第 6 模块**局部**适用（其他 6 events 已合规）/ 推 r43+
> - **B.p344-watchdog-2 watchdog-entry 无 uncaughtException handler**（r42 D fork 第 5 轮新发现）= **drift / 中**：watchdog-entry.ts 0 行 crash handler / 无 watchdog_crash audit / 进程异常退出无审计回链 / 应同 daemon-entry §2.3 模式 / 推 r43+

#### B.p176-1 watchdog.ts 物理位置 `cli/commands/` 而非 `src/` 根

**质疑**：L6a 顶层模块应在 src/ 根（如 daemon-entry.ts / watchdog-entry.ts 的 shim 位置）。

**理由**：
- `watchdog.ts` 虽是 L6a 进程主体，但同时承担 `watchdog start/stop/status` CLI 命令（L446 / L480）
- 历史上所有 CLI 命令统一归 `src/cli/commands/`（namespace 一致性）
- 将 watchdog.ts 迁出 `cli/commands/` 会拆出"CLI 命令 + L6a 主 loop"两文件，反而增加耦合

**顺手成本评估**：
- 若强拆：新建 `src/watchdog-main.ts`（L6a 主体）+ 保留 `src/cli/commands/watchdog.ts`（薄 CLI wrapper）
- grep 消费面：`watchdog.js` import 约 3 处（watchdog-entry.ts / 测试文件 × 2）
- 顺手做需同步拆 import path 更新；但因命名冲突 A5 未处理，顺手还会暴露新冲突
- 成本 > 收益（当下）

**治理路径**：A5（daemonCommand → runWatchdogLoop）phase264 已清零。物理位置重审（B.p176-1）现已解锁，独立 phase 评估。

**phase281 评估**：**保留**。runWatchdogLoop 命名清晰化后移动代价 > 收益（须拆 `src/watchdog-main.ts` + 薄 CLI wrapper / import 更新 3 处；`watchdog-entry.ts` shim 已承担 L6a 入口语义）。新触发条件：watchdog.ts > 400 行 或 CLI 层与主 loop 需独立演进时再评。

#### B.p176-2 watchdog-utils.ts 8 exports 聚合（非按业务拆分）

**质疑**：原 10 exports 跨多个业务域（activity / contract / snapshot / backoff），按 M1 反向测试应拆 3-4 个独立文件。

**理由**：
- M1 反向测试实证：clawHasContract / getContractCreatedMs 改造不连带 getEffectiveInterval 改造（独立业务语义）
- 但各函数都在"辅助 watchdog 主 loop 业务决策"范畴，聚合 utils 便于 watchdog.ts 单点 import
- 115 行合计规模小（M1 工具阈值 ~200 行），不强触发拆分

**phase346 更新**：已拆 2 export 按业务语义归位（β-utils）：
- `LLM_OUTPUT_EVENTS` → `src/foundation/stream/types.ts`（stream 事件分类 / M#2 强 align）
- `getContractCreatedMs` → `src/core/contract/utils.ts`（contract 目录读取 / M#2 强 align）
- 余 8 export 仍为 watchdog 真私有，留位

**治理路径**：余 8 export 若未来增至 ~200 行或出现"改 A 影响 B" 的证据，再拆。

**phase346 评估**：**部分清零**。2/10 跨消费 export 已迁出；余 8 保留。watchdog/ 不再持跨子系统共享 utils。

#### B.p176-3 backoff 常量硬编码（L439 `5 * 60 * 1000`）

**质疑**：配置驱动更灵活，应抽到 `src/constants.ts` 或 `global.json`。

**理由**：
- 数值语义清晰（5 min 是"合理上限"）
- 无用户配置需求（backoff 是崩溃恢复内部行为）
- 抽常量增加 maintenance 开销

**顺手成本评估**：3 行改动（新 const + 替换 1 处）+ 单元测试；可忽略。但本 phase scope 明示零代码改动，留此处登记。

**治理路径**：未来若主 loop 重构时顺带做（不为此单独开 phase）。

**phase281 评估**：**保留**。L492 `5 * 60 * 1000` 仍在；phase272 未触及 backoff。触发条件（主 loop 重构）未发生。

#### B.p176-4 主 loop 轮询模型（vs 事件驱动）

**质疑**：Design #6 事件驱动优先；chokidar 已在 daemon-loop 应用。

**理由**：
- watchdog 的观察面是"进程存活"（`pm.isAlive`）+ "活动度"（stream.jsonl 最新事件 ts）
- 进程存活无天然事件源（OS 信号不可靠跨平台）
- 活动度虽可 fs.watch 监听 stream.jsonl，但跨 claw × N 个 watcher 开销大
- 轮询 + `interval_ms` 配置是架构合理选择

**顺手成本评估**：改造为事件驱动是重大重构（数百行代码 + 测试），非"顺手"。

**治理路径**：绑定 A9 观察位；用户反馈或规模扩张时触发。

**phase281 评估**：**保留等依赖**（A9 W-tier）。轮询结构无变化；H/M/L 全清零后无新触发条件。等 A9 触发（用户反馈 / claw 规模 >10）时联动评估。

#### B.p176-5 跨 agent 读用 `fs.readdirSync` 而非 `getClawDir` config helper

**质疑**：config.ts 提供了 `getClawDir(name)` 但 watchdog 跨枚举时用 `path.join(getClawforumDir(), 'claws', clawId)`。

**理由**：
- `getClawDir` 需要已知 clawId；watchdog 的场景是"枚举所有 claws"（不知 ID）
- `getClawforumDir()` 是 watchdog 内部 helper（L23，解 motionDir 父目录）
- 直接拼 `claws/clawId` 语义清晰

**顺手成本评估**：若 config.ts 新增 `getClawsDir()` helper，可统一接口；但 config 文件已稳定，单独改动无收益。

**治理路径**：与其他 config 整治 phase 合并（无独立开）。

**phase281 评估**：**保留**。L247/251/267/330/334 仍手动 `path.join`；`getClawDir` 适合单 claw 访问 / 不适用枚举场景；设计语义不变。触发条件（config 整治）未发生。

---

### 7.C 原则对照（Philosophy 4 + Design 11 + Module Logic 11 + Path 6 = 32 条）

> 按 `feedback_apply_principles_first` L56-82 全量扫描。每条结论：✓ 合规 / ◐ 部分违反 / ✗ 违反 → §7.A 编号 / N/A 不适用。

#### Philosophy 4 条

| # | 原则 | 结论 | 证据 |
|---|---|---|---|
| P1a | 信息不丢失 | ✓ → phase272 已清零 | watchdog-state 静默 catch + 非原子写（A3/A4 phase272 整治）|
| P1b | 状态可观察 | ✓ | ~~A1 phase265~~ / ~~A7 phase269~~ / ~~A8 phase277~~ 全清 |
| P2 | 不得丢弃/静默 | ✓ → phase272 已清零 | loadWatchdogState 静默 catch（phase272 整治）|
| P3 | 可回滚 | ✓ | 冻结期不改代码；复盘产 phase 锚点便于未来回滚到 e177d44 前 |

#### Design 11 条

| # | 原则 | 结论 | 证据 |
|---|---|---|---|
| D1 | 独立可变职责 | ✓ | A5 命名冲突 phase264 已清零（runWatchdogLoop）|
| D1a | 单资源独占 | ✓ | watchdog.pid / watchdog-state.json / watchdog.log / audit.tsv 归属明确 |
| D1b | 数据流单向 | ✓ | watchdog → motion inbox（不反向）/ PM → watchdog（watchdog 不反注册） |
| D1c | 接口契约外显 | ✓ | ~~A10 phase271 已清零~~（8/8 exports 全部有测试覆盖）|
| D1d | 模块边界明示 | ◐ → B.p176-1 | cli/commands/watchdog.ts 位置模糊 L6a 身份 |
| D2 | 显式装配归位 | ✓ | createProcessManagerForCLI 工厂 / createDirContext 工厂 |
| D3 | 数据流层次 | ✓ | L2 → L6a 单向；无跨层越级 |
| D4 | 类型收敛于契约 | ✓ | ClawActivityInfo / ClawSnapshot / ProcessLiveness 明示 export |
| D5 | 审计为契约 | ✓ | ~~A1 phase265~~ / ~~A6/A7 phase269~~ / ~~A8 phase277~~ 全清 |
| D6 | 事件驱动优先 | ◐ → B.p176-4 / A9 | 主 loop 轮询（合规登记 + 观察位） |
| D6a | 跨进程结构化 | ✓ | audit.tsv + inbox 消息均结构化 |
| D7 | 单向依赖 | ✓ | watchdog → L2/L1，无反向 |
| D8 | 耦合界面最小 | ◐ → D8 | 18 exports M1 阈值边缘（A5 命名冲突 phase264 已清零）|
| D9 | 状态所有权单一 | ✓ | Maps + watchdog-state.json 只在 watchdog 进程内持 |
| D10 | identity 不对称 | ✓ | motion / claw 分支明示（§1 职责表）|
| D11 | 冻结 + 稳定化 | ✓ | 本 phase 冻结登记；未来 A1-A10 独立稳定化 phase |

#### Module Logic 11 条

| # | 原则 | 结论 | 证据 |
|---|---|---|---|
| M1 | 反向测试判拆分 | ✓ | watchdog.ts 8 + utils 10 = 18 exports 均通过反向测试（改 A 不连带 B） |
| M2 | 执行 vs 生命周期拆 | ✓ | watchdog.ts 主循环 = 生命周期 / utils = 执行原语，合规 |
| M3 | 资源归属 | ✓ | §1 资源表；测试 fixture 按此分层（F7 assemble.test.ts 同模板） |
| M4 | 默认拆分 / 合并需论证 | ✓ | utils 聚合由 B.p176-2 反向测试阈值论证保留 |
| M5 | 循环耦合 vs 反向依赖 | ✓ | watchdog → PM 单向；PM 不依赖 watchdog 类型/符号 |
| M6 | 顶层冻结治理 | ✓ | L6a 顶层冻结，下层（PM / Audit / FS）稳定 |
| M7 | 耦合界面稳定 | ✓ | ~~A10 phase271 已清零~~（8/8 exports 全部有测试覆盖）|
| M8 | 耦合界面最小 | ◐ → D8 | 18 exports M1 阈值边缘（A5 命名冲突 phase264 已清零）|
| M9 | 装配归位 | ✓ | pm 工厂 + dir context 工厂 |
| M10 | 可观测性债务 | ✓ | ~~A1 phase265~~ / ~~A6/A7 phase269~~ / ~~A8 phase277~~ 全清 |
| M11 | 审计事件集最小 | ✓ | 6 audit types 聚焦；未散发细粒度事件 |

#### Path 6 条

| # | 原则 | 结论 | 证据 |
|---|---|---|---|
| Path1 | 基于规划时刻事实 | ✓ | F1-F16 / F16 修总览 7 条偏差；Step 1 完整 Read |
| Path2 | 差距显式登记 | ✓ | §7.A 11 条 / §7.B 5 条 / §7.D 关键决策登记 |
| Path3 | 最小变更单元 | ✓ | 零代码改动；仅新建 1 契约 + 1 索引补字段 |
| Path4 | 可回滚 + 破坏性论证 | ✓ | 无代码改动即无破坏；contract/modules.md 可 rm 回滚 |
| Path5 | 完成后复盘 + 反馈规则 | → Step 7 | phase176 纪律复盘 + MEMORY 治理协议首次应用 |
| Path6 | 发现冲突立即中断 | ✓ | phase175 占用发现 → 换号 phase176；总览 F16 7 偏差发现 → 先修总览再 Step 2 |

---

### 7.D 关键决策映射表

按 `feedback_module_contract_structure` §7.D（phase157 升格，phase172-174 未实践，phase176 首次落地）。

| # | 决策 | 原则编号 | 采纳/妥协 | 历史 phase 锚点 |
|---|---|---|---|---|
| D.1 | Watchdog 作为独立进程（非 Daemon 子模块）| Design #1 独立可变职责 + Module Logic #M1 反向测试 + #M2 执行 vs 生命周期 | **采纳** | 项目初始设计（无明确 phase） |
| D.2 | ProcessManager 作为 watchdog 的使用者（不反向依赖 PM 自注册）| Design #7 单向依赖 + Module Logic #M5 循环耦合 vs 反向依赖 | **采纳** | phase169 PM 工厂化后 createProcessManagerForCLI；phase176 §5.4 明示 |
| D.3 | motion 作为 claw crash 通知的**中介**（watchdog 不直接通道）| Design #10 identity 不对称 + Design #7 单向依赖 | **采纳** | MVP 设计（watchdog → motion → claw/用户 消息链）；phase176 §5.1 登记 |
| D.4 | `log()` helper 只走 console + file（不走 audit）| Path #2 差距显式登记 | **妥协登记** | phase176 §7.A1；未来稳定化 phase（与 A2-A4 合并）偿 |
| D.5 | `watchdog-state.json` 无 version 字段 + 静默 catch + 非原子写（A2-A4 三并） | Path #2 差距显式登记 + Design #5 审计为契约 + Philosophy #1a 信息不丢失 | **妥协→已偿** | phase176 §7.A2-A4；**phase272 已清零** |
| D.6 | ~~`daemonCommand` 命名冲突~~ → `runWatchdogLoop`（phase264 清零）| Path #2 差距显式登记 + Module Logic #M8 | **妥协→已偿** | phase176 §7.A5 登记 / phase264 独立命名整治 phase 兑现 |
| D.7 | `maybeCronClawCrash` 无 audit 参数 + 路径无 audit | Path #2 差距登记 + Design #5 审计为契约 | **妥协登记** | phase176 §7.A7；独立稳定化 phase（新 audit type + 签名改）偿 |
| D.8 | 主 loop 轮询而非事件驱动 | Path #2 差距登记 + Design #6 事件驱动优先 | **工程折衷** | phase176 §7.B4 + §7.A9 观察位；用户反馈或规模扩张触发升级 |
| D.9 | `watchdog-utils.ts` 10 exports 聚合（不按业务域拆）| Module Logic #M1 反向测试 + #M4 默认拆分 | **采纳**（反向测试不强触发拆）| phase176 §7.B2 登记 |
| D.10 | `fs.readdirSync` 跨 agent 枚举无 audit（观察读不同于活度检查）| Path #2 差距登记 + Philosophy #1b 状态可观察 | **妥协登记** | phase176 §7.A8；独立稳定化 phase 扩 `watchdog_check` 载荷或新 `watchdog_observe_*` 事件族偿 |

**采纳/妥协分布**：
- 采纳 4 条（D.1 / D.2 / D.3 / D.9）：架构层面稳定决策，无改造压力
- 妥协登记 6 条（D.4-D.8 + D.10）：全部绑定到未来独立稳定化 phase；冻结期不改

**决策链路追溯**：每条 D 都可通过"原则编号 → §7.A/§7.B 登记 → 未来 phase"三跳溯源；phase157 升格 §7.D 的设计目标（决策可审计）实证。

**modules.md 迁移条目**（2026-04-26 主会话；后续清理阶段重构合并入上表）

- **KD#18（原 modules.md）Watchdog 是 L6 入口**：进程级健康监控是系统行为，需要审计，不是外部设施。通过 CLI 查询系统状态，不直接读其他模块的资源

---

### 7.Phase 执行纪律（本 phase 独有发现）

#### P.176.1 phase175 占用发现 → 换号 phase176

起步时 `ls "coding plan/phase175/"` 已被并行 session（ContractManager.handleReviewRequest 实施）占用，phase176 顺延立卷。Path #6（发现冲突立即中断 + 换路径）实证。

#### P.176.2 MEMORY.md 8 分类治理协议首次应用

phase176 是 MEMORY.md 整理（`MR.1-MR.5`）落地后**首个**按新 8 分类治理协议起草的 phase。Step 7 复盘需评协议实际效果。

#### P.176.3 Path Principles 落地第 2 phase

phase174 是首个显式按 Path 起草（首次实践）。phase176 是第 2 phase，对 Path 模板的"稳定性"起验证作用（phase174 是独案，phase176 连续 2 案后方可评效）。

#### P.176.4 总览 F16 7 条偏差修订实证

Step 1 扫描首次发现总览 §背景 §范围 共 7 条数字/区间偏差（imports 18→21 / utils exports 7→10 / 合计 15→18 / watchdog.test.ts 5→4 / utils test 10+→27 / motion restart L396-414→L394-429 / claw crash L285-324→L285-336）；按 `feedback_verify_facts_before_plan` 2026-04-20 升格条款（总览级数字断言预核强制）+ phase174 形态变种教训（ls/grep 位置不够必 Read 内容），Step 1 先修总览再进 Step 2。

---

### §7.drift — 应然 framing drift（phase325 全推 / 2026-04-26）

| # | 位置 | drift 描述 | 修正 |
|---|---|---|---|
| D1 | §head | 缺 head 应然/实然 split | 补全（已执行）|

## 8. 测试覆盖

### 8.1 行为覆盖矩阵

#### watchdog.ts 8 exports

| export | 直接测试 | 间接覆盖 | 状态 | §7.A 登记 |
|---|---|---|---|---|
| `getWatchdogEntryPath` | ✓ 2 it | - | ✓（返回路径格式断言）| phase271 |
| `shutdownWatchdog` | ✓ fix 005 × 2 it | - | ✓ | - |
| `getWatchdogPid` | ✓ 2 it | - | ✓（存在/不存在两路径）| phase271 |
| `isWatchdogAlive` | ✓ 3 it | - | ✓（alive/root mismatch/no file 三路径）| phase271 |
| `maybeCronClawInactivity` | ✓ fix 4 × 2 it | - | ✓（仅 error isolation，主逻辑未覆盖）| 部分 |
| `runWatchdogLoop` | ✓ 5 it | - | ✓ non-crash（start/check/restart/fail/normal）/ crash 路径 TODO H3 | phase271 |
| `startCommand` | ✓ 3 it | - | ✓（already running/spawn/fail 三路径）| phase271 |
| `stopCommand` | ✓ 3 it | - | ✓（not running/SIGTERM/EPERM 三路径）| phase271 |

#### watchdog-utils.ts 10 exports

| export | 类型 | 状态 |
|---|---|---|
| `ClawActivityInfo` | interface | N/A |
| `LLM_OUTPUT_EVENTS` | const | 间接覆盖（`getClawActivityInfo` 测试） |
| `getClawActivityInfo` | async func | ✓ 9 it 全面 |
| `clawHasContract` | func | ✓ 4 it |
| `getContractCreatedMs` | func | **未测** (A10 衍生) |
| `ClawSnapshot` | interface | N/A |
| `ProcessLiveness` | interface | N/A |
| `gatherClawSnapshot` | func | ✓ 7 it |
| `getEffectiveInterval` | func | ✓ 4 it |
| `shouldResetNotifyCount` | func | ✓ 3 it |

### 8.2 §3 事件回链（冻结期未建立）

对比 Daemon §8.2（phase173 + phase174 清零全 ✓），Watchdog 6 audit type × 7 call sites **无一条**建立事件回链测试：

| audit type | 触发点 | 回链测试 |
|---|---|---|
| watchdog_start | runWatchdogLoop L353 | ✓ phase271 it 1 |
| watchdog_stop (×2 变种) | shutdownWatchdog L88/L90 | ✓ fix 005 × 2 it（phase133 等历史 it 已回链）|
| watchdog_check | 主 loop L392 | ✓ phase271 it 2 |
| watchdog_restart_triggered | 主 loop L396 | ✓ phase271 it 3 |
| process_spawn | 主 loop L414 | ✓ phase271 it 3 |
| process_spawn_failed | 主 loop L423 | ✓ phase271 it 4 |

**回链率**：6/6（watchdog_stop 已有 / 其余 5 phase271 补齐）。注：crash audit（H3 新增）等 H3 合入后补 §8.2 行。

### 8.3 测试缺口说明

**当前状态**（phase271 已清零 §7.A A10）：
- 全 watchdog.ts 测试 25 it：shutdownWatchdog × 2 + maybeCronClawInactivity × 2 + logWithAudit × 3 + getWatchdogPid × 2 + isWatchdogAlive × 3 + getWatchdogEntryPath × 2 + startCommand × 3 + stopCommand × 3 + runWatchdogLoop × 5
- **核心主 loop（runWatchdogLoop）**：phase271 覆盖 non-crash 5 路径；crash 路径（maybeCronClawCrash）待 H3 合入后补齐
- start/stop CLI 命令：phase271 全覆盖（already running / spawn / fail / not running / SIGTERM / EPERM 六路径）

---

### 7.Phase 执行纪律（phase260 独有发现）

#### P.260.1 watchdog.ts 行数 N1 drift（516 → 512）

phase176 冻结契约登记时标注 watchdog.ts 516 行。phase260 Path #1 实然核测得实际 512 行（-4 行）。根因：phase216 InboxWriter 14 call sites 迁移净减 4 行。不影响 §7.A 任何分析（行号 drift 登记为 B 类；B.p216 已记录）。§2.1 物理位置说明已补 N1 注记。

#### P.260.2 §7.A 11 条 0 drift 实证

phase260 Path #1 实然核：git log + grep 确认 11 条 §7.A 全部 open、0 drift（phase216 行数微 drift 为唯一偏差，已 N1 登记）。

#### P.260.3 phase226 分组规划模板第 2 次实践

phase226 console 分组规划模板（双轴分组：按形态 × 按依赖顺序）第 2 次应用（phase226 console / phase260 Watchdog §7.A）。产出独立文件：`coding plan/phase260/Watchdog 稳定化分组规划.md`（8 组）+ `coding plan/phase260/r19+ Watchdog 治理分派清单.md`（r19 B-F 分配）。

#### P.260.4 W-tier 等触发分组（A9 + A11）

A9（主 loop 事件驱动）/ A11（PID 归 PM 自注册）归 W-tier：架构改造 / 等外部触发条件（claw 数量 >10 / PM API 演进）。§7.A 保留 open 登记，§7.B 补充妥协说明（§5.4 决策 + §7.B4 双重登记）。11 条全覆盖不含等触发削减（11/11）。

#### P.260.5 r19 冲突面分析

B/C/D 三分支均改 `watchdog.ts` → 不可纯并行；推荐顺序执行 C（H2 rename）→ D（H3 crash audit）→ B（H1 state）或等价顺序。E/F 分支可与 B 并行（改 watchdog.ts 非 crash 路径 / 待行区间确认）。详见分派清单 §r19 冲突面预估。

### 7.Phase 执行纪律（phase264 独有发现）

#### P.264.1 N1 call site 数量偏差

phase260 H2 预估"1 函数改名 + entry shim 别名消除"，实然扫描：watchdog.ts L335 声明（1）+ watchdog-entry.ts import + call（2）+ cli/index.ts import + call（2）= **5 处**。偏差来源：phase260 未计入 cli/index.ts 的 alias import。测试文件零引用（watchdog.test.ts 仅导入 maybeCronClawInactivity / shutdownWatchdog）。

#### P.264.2 §7.A A5 清零里程碑

`daemonCommand` → `runWatchdogLoop` 完成：
- watchdog-entry.ts 别名消除（`import { daemonCommand as watchdogDaemonCommand }` → `import { runWatchdogLoop }`）
- cli/index.ts 别名消除（同上）
- D1 / M8 评级前进：◐ → ✓（D1）/ ◐ → D8 only（M8）
- B.p176-1（物理位置重审）前置条件解锁

#### P.264.3 解锁下游

H3（crash audit / A6+A7）现可安全起步：watchdog-entry.ts import 已改为 `runWatchdogLoop`，扩展 uncaughtException handler 无命名冲突风险。

---

### 7.Phase 执行纪律（phase265 独有发现）

#### P.265.1 _auditWriter 提升由 M1 自行完成

phase260 r19-E-M1-step-plan.md 原假设"_auditWriter module-level 变量由 H3 引入"失效（H3 = r20+）。phase265 自行添加 `let _auditWriter: AuditWriter | null = null`（module-level）并在 `runWatchdogLoop` init 段赋值，H3 后续无需再处理此变量。

#### P.265.2 §7.A A1 清零里程碑

`logWithAudit(message, auditType?, payload?)` + `_auditWriter` module-level + `WATCHDOG_CLEANUP_FAILED` 常量：
- L397 `Failed to clean up motion before restart` → `logWithAudit(msg, AUDIT_EVENTS.WATCHDOG_CLEANUP_FAILED, ...)`
- 3 新 it：有 auditType / 无 auditType / `_auditWriter = null` 不抛
- P1b ◐ 减少 1 条（A1 消化）/ D5 ◐ 减少 1 条（A1 消化）
- merge SHA `bc77c29`（r19 F branch）

#### P.265.3 迁移保守判据实证

已有 audit 的 log 点（L420 process_spawn_failed / L392 watchdog_restart_triggered）保留 `log()` 不迁移，避免双写 audit。纯竞态信息 log（L415 "motion already started"）也保留 `log()`。仅无 audit 且属失败路径的 L397 迁移。

### 7.Phase 执行纪律（phase271 独有发现）

#### P.271.1 N1 — fix-4 测试 audit 参数 drift

现有 fix-4 测试（maybeCronClawInactivity 2 it）调用时缺第二 `audit` 参数。
根因：phase265 M1 修改签名后测试未同步更新。phase271 Step 1 修复。

#### P.271.2 §7.A A10 清零里程碑

watchdog.ts 8/8 exports 全部有测试覆盖（phase271 +~18 it）。
事件回链率：1/6 → 6/6（watchdog_stop 已有 / 其余 5 phase271 补齐）。
crash 路径 TODO：maybeCronClawCrash crash audit（CLAW_CRASH_DETECTED 等）等 H3 合入后补。

#### P.271.3 H3 协调模式

M2（纯 tests）与 H3（watchdog.ts src）零文件冲突 / r20 B/C 可并行。
crash 路径测试延后到 H3 merge → 保持测试契约与 src 同步（不写超前测试）。

---

### 7.Phase 执行纪律（phase274 独有发现）

#### P.274.1 §7.C cascade — r20 B/C 影响

r20 B（phase269）A6+A7 清零 → §7.C 前进：
- P1b：◐ → A7/A8 → ◐ → A8（A7 消化）
- D5：◐ → A6/A7/A8 → ◐ → A8（A6/A7 消化）
- M10：◐ → A1/A6/A7/A8 → ◐ → A8（A6/A7 消化）

r20 C（phase271）A10 清零 → §7.C 前进：
- D1c：◐ → A10 → **✓**（接口契约外显 全清）
- M7：◐ → A10 → **✓**（耦合界面稳定 全清）

### 7.Phase 执行纪律（phase277 独有发现）

#### P.277.1 §7.A A8 清零里程碑

watchdog.ts 3 处 scan audit 补齐（maybeCronClawInactivity / maybeCronClawCrash / 主 loop watchdog_check 扩展）。
watchdog-utils.ts 4 处 per-claw 子目录读：父 scan event 覆盖策略（不独立 audit）。
merge SHA `90e4953` 2026-04-24。

#### P.277.2 §7.C cascade — A8 影响

A8 清零触发 3 条 §7.C 前进（Watchdog §7.A H/M/L 全清零）：
- P1b 状态可观察：◐ → **✓**
- D5 审计为契约：◐ → **✓**
- M10 可观测性债务：◐ → **✓**

---

### 7.Phase 执行纪律（phase281 独有发现）

#### P.281.1 §7.B 5 条评估（`feedback_debt_inventory_status §§7.B 治理评估模板` 4 步）

- **scope**：§7.A H/M/L 全清零（phase277）后 §7.B 进入可评期
- **评估结论**：
  - B.p176-1（物理位置）：**保留**（A5 解锁后评估；移动代价 > 收益；新触发 >400 行）
  - B.p176-2（utils 聚合）：**保留**（135 行未增长；触发条件未达）
  - B.p176-3（backoff 常量）：**保留**（L492 仍在；主 loop 重构触发条件未发生）
  - B.p176-4（轮询模型）：**保留等依赖**（绑 A9 W-tier；轮询结构无变化）
  - B.p176-5（readdirSync）：**保留**（枚举场景语义不变；config 整治触发条件未发生）
- **登记错：0 条**

#### P.281.2 W-tier A9/A11 状态确认

H/M/L 全清零后：
- A9（主 loop 轮询）：W-tier 继续保留；无新触发条件
- A11（PID 独立于 PM）：W-tier 继续保留；PM API 无演进
- **Watchdog §7.A 状态：9/11 清零 / 2 条 W-tier 等触发**

#### P.281.3 §7.C 无前进

剩余 ◐ 条目（D1d / D6 / D8 / M8）全对应 §7.B 保留条目 —— 本 phase 无清零动作 → §7.C 无级联前进。

#### phase303 纪律 — C.3 Watchdog 物理迁移（2026-04-25 / SHA `171f3dc`）

- **scope**：r27 分支 E / `cli/commands/watchdog.ts` + `watchdog-utils.ts` → `src/watchdog/`
- **变更量**：git mv ×2 / watchdog.ts 内部 8 路径 + 2 runtime 计算 / watchdog-utils.ts 3 路径 / 6 外部 importer + entry / 测试 4 处
- **N3（关键 drift）**：watchdog.ts 含 `fileURLToPath(import.meta.url)` runtime 路径计算 / 移动后层数变化：getWatchdogEntryPath 3→2 级 / spawn daemon 2→1 级
- **N5 跟进**：layer-map.json 未覆盖 src/daemon/ + src/watchdog/ L6a 路径 → 后续 phase 补 @module 注释 + layer-map 条目
