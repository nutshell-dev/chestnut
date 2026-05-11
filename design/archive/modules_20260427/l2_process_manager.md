# L2 ProcessManager 对外接口契约

**应然**（2026-04-26 修订 / 跟 modules.md §10 align）：
- **装配归属**：按需（任何需要管理子进程或自注册 PID 的进程装）
- **资源**：所有进程的 PID 文件（含他人 spawn 写入与自启动 self-register 写入）、lockfile
- **依赖**：FileSystem, AuditLog
- **耦合**：无
- **对外能力**：detached spawn / SIGTERM→SIGKILL 停止 / 存活探测 / 孤儿进程清理 / pgrep 模式查找 / 排他锁获取与释放 / PID 自注册与自删
- **被谁调用**：Daemon（启动 agent 进程、自启动 registerSelf）、Watchdog（存活检查、重启、自启动 registerSelf）、CLI（status/stop/claw/motion/start 等运维子命令）

**实然**：见 §7 各 A/B/C 类登记 + §9 四子节索引。

## 1. 概述

进程生命周期管理：排他启动（wx lockfile + PID 文件）、SIGTERM→SIGKILL 停止、isAlive/getAliveStatus 存活检查、孤儿进程扫描清理、pgrep 模式查找。消费者是 **Daemon / Watchdog / CLI 运维子命令**（status/claw/motion/stop/start），三者是独立的 L6 模块/职责——实现文件虽都位于 `cli/commands/` 目录，但模块身份不被 CLI 吞并。

PID 文件与 lockfile 是**运行时句柄的磁盘持久化载体**，呼应「持久化一切信息到磁盘，运行时句柄从磁盘信息重建」与「运行中断即从最后完整步恢复」：进程在，PID 文件在；进程失活，下次 isAlive 调用即清理 stale 文件。

## 2. 职责边界

**做**：
- PID 文件独占写入（`writeExclusiveSync` + `wx` flag）、读取、失活自动清理
- 存活判定（`kill(pid, 0)` 零信号探测）
- detached spawn：先 pgrep 清理同模式孤儿 → 清理 stale lockfile → 写 PID → fork 子进程 → 轮询到 alive 或 `PROCESS_SPAWN_CONFIRM_MS` 超时
- SIGTERM → `SIGTERM_GRACE_MS` 宽限 → SIGKILL 兜底
- `findProcesses(pattern)` 基于 `pgrep -f <escaped>` 的进程查找

**不做**：
- 日志聚合/滚动（调用方传 `logFile`，ProcessManager 仅把 stdout/stderr 重定向到该文件 fd）
- 子进程运行时健康检查（属于 Watchdog）
- 子进程信号处理约定（属于各 agent 自身）
- 跨模块资源归属（**见 A.4**，lockfile CLI 绕过已 Phase 152 归位）

## 3. 接口

```ts
interface SpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  logFile: string;
  env?: Record<string, string | undefined>;
}

class ProcessManager {
  // Phase 148 已修复：audit 必传（第 3 参）
  constructor(fs: FileSystem, baseDir: string, audit: Audit, dirResolver?: (clawId: string) => string);

  getAliveStatus(clawId: string): { alive: boolean; reason?: string; pid?: number };
  isAlive(clawId: string): boolean;

  spawn(clawId: string, options: SpawnOptions): Promise<number>;  // 返回子进程 PID
  stop(clawId: string): Promise<boolean>;                         // 返回是否实际停止了进程
  findProcesses(pattern: string): number[];

  acquireLock(clawId: string): Promise<void>;    // Phase 152
  releaseLock(clawId: string): Promise<void>;    // Phase 152
  readLockPid(clawId: string): number | null;    // Phase 152

  // Phase 228: PID 文件公开 API（原 private → public / 新增自写自删）
  readPid(clawId: string): Promise<number | null>;
  removePid(clawId: string): Promise<void>;
  selfWritePid(clawId: string): Promise<void>;    // 写 process.pid 到 PID 文件
  selfRemovePid(clawId: string): Promise<void>;   // 仅当 stored pid === process.pid 时删除
}

// 装配助手（Phase 148 Step 9）：CLI 无 runtime 上下文时构造 baseDir/audit.tsv 的 AuditWriter
// 归属 AuditLog 模块导出，此处引用
import { createSystemAudit } from '../audit/index.js';
```

`dirResolver` 可选，用于 Motion 等特殊 agent 的非默认 PID 路径；缺省使用 `<baseDir>/claws/<id>/status/pid`。

## 4. 失败语义

| 场景 | 当前行为 | 分类 |
|---|---|---|
| readPid 读失败（非 ENOENT） | `audit.write(PID_READ_FAILED, clawId=..., reason=...)` 后返回 `null`（Phase 148 已修复，原 `console.warn`）| A.1 已修复 |
| removePid 删除失败 | `audit.write(PID_REMOVE_FAILED, clawId=..., reason=...)` 后继续（Phase 148 已修复）| A.1 已修复 |
| pgrep 清理阶段 SIGTERM 失败 | `audit.write(ORPHAN_SIGTERM_FAILED, pid=..., reason=...)` 后继续（Phase 148 已修复）| A.1 已修复 |
| lockfile 读失败 | `audit.write(LOCKFILE_READ_FAILED, clawId=..., reason=...)` 后继续（Phase 148 已修复）| A.1 已修复 |
| lockfile SIGTERM / 删除失败 | `audit.write(LOCKFILE_CLEANUP_FAILED, clawId=..., reason=...)` 后继续（Phase 148 已修复）| A.1 已修复 |
| PID 空文件（并发 spawn 征兆） | `audit.write(PID_EMPTY, clawId=...)` 后按 stale 处理（Phase 148 已修复）| A.1 已修复 |
| stop 信号发送失败 | `audit.write(PROCESS_STOP_FAILED, clawId=..., reason=...)` 后返回 `false`（Phase 148 已修复）| A.1 已修复 |
| findProcesses 异常 | `audit.write(PROCESS_LIST_FAILED, pattern=..., reason=...)` 单次后返回 `[]`（Phase 148 已修复 audit；"pgrep 不可用"vs"无匹配"返 [] 歧义留 Phase 150）| A.2（Phase 150 scope）|
| findProcesses 去重 | `findProcessesWarned: Set<string>` 保证同一 pattern 只 audit 一次（实例生命周期持续）；防止 pgrep 缺失时洪泛 audit | 设计保留 |
| spawn 成功 | `audit.write(PROCESS_SPAWNED, clawId=..., pid=...)` 正面事件（Phase 148 已修复）| A.3 已修复 |
| spawn 失败（轮询超时 / wx 冲突等） | `audit.write(PROCESS_SPAWN_FAILED, clawId=..., reason=...)` 后抛 `Error`（audit 不替代抛出）| A.3 已修复 |
| spawn 轮询超时 | 抛 `Error` ✓ 预期失败调用方处理 | ok |
| wx 冲突（PID 已存在且活着） | 抛 `Error`（含 clawId） ✓ | ok |
| stop 成功（实际终止了进程） | `audit.write(PROCESS_STOPPED, clawId=..., pid=...)` 正面事件（Phase 148 已修复）| A.3 已修复 |
| stop 触发 SIGKILL 升级（SIGTERM 宽限未终止） | `audit.write(PROCESS_KILL_ESCALATED, clawId=..., pid=...)`（Phase 148 已修复）| A.3 已修复 |
| stop 目标已 stale（kill 回 ESRCH / 无 PID 文件） | `audit.write(PROCESS_STOP_STALE, clawId=..., reason=...)`（Phase 148 已修复）| A.3 已修复 |
| `getAliveStatus` 内 ESRCH 后旁路清理 `try { fs.deleteSync(pidFile); } catch {}` | 允许保留（旁路清理 + 下次 isAlive 调用重试兜底；非业务语义失败）| 设计保留 |
| readPid 读成功（Phase 228 新增公开 API 正面事件）| `audit.write(PID_READ_OK, clawId=..., pid=...)` | A.3 Phase 228 新增 |
| selfWritePid 写 PID 成功 | `audit.write(PID_WRITE_OK, clawId=..., pid=...)` | A.3 Phase 228 新增 |
| selfWritePid 写 PID 失败 | `audit.write(PID_WRITE_FAILED, clawId=..., reason=...)` 后抛 Error | A.3 Phase 228 新增 |
| removePid / selfRemovePid 删除成功 | `audit.write(PID_REMOVE_OK, clawId=...)` | A.3 Phase 228 新增 |

## 5. 不可消除的耦合

- **等待时间与 CLI 的时间常量共享**：`PROCESS_SPAWN_CONFIRM_MS` 定义 ProcessManager 内部「确认存活」轮询上限；同时 `cli/commands/{claw,motion,start}.ts`（grep 证据：claw.ts L132、motion.ts L218、start.ts L368/L383/L416）用同一常量 `setTimeout` 等待 spawn 稳定。概念相同、值同源（经 `src/constants.ts`），常量变更必须同时影响两处 —— 显式登记此耦合。
- **`SpawnOptions.logFile` 是进程 stdout/stderr 的唯一去向**：ProcessManager 打开文件描述符后交由子进程持有，自身不参与写入。调用方对该文件的任何期望（切分/查看/滚动）不由 ProcessManager 承担。
- **FS 抽象缺口**：spawn 内部对 `logFile` 使用原生 `openSync`/`closeSync` 获取真实 fd（Node `child_process.spawn` 的 stdio fd 参数要求数字 fd，无法走 FileSystem 抽象）。登记为显式耦合，不可消除。
- **pgrep 平台依赖**：`findProcesses` 与 spawn 的孤儿清理都依赖 `pgrep -f`（procps），非 POSIX 通用。平台耦合登记。

## 6. 配置常量归属

| 常量 | 目标归属 | 现状 | 修复方向 |
|---|---|---|---|
| `PROCESS_SPAWN_CONFIRM_MS` | ProcessManager 模块导出 | ProcessManager 模块导出（phase233 迁入） | 见 A.5 |
| `SIGTERM_GRACE_MS` | ProcessManager 模块导出 | ProcessManager 模块导出（phase233 迁入） | 见 A.5 |
| spawn 轮询间隔 `50ms` | ProcessManager 内部常量（`manager.ts` 顶部） | `SPAWN_POLL_INTERVAL_MS = 50` 内部常量（phase233 迁入）| — |
| `findProcessesWarned: Set<string>` | ProcessManager 实例状态 | 无 TTL/清理 | B 类偏差，仅登记（实例生命周期 = 进程生命周期，无泄漏风险） |

**归属原则对照**：「常量应归属于承担其语义的模块」。`PROCESS_SPAWN_CONFIRM_MS` / `SIGTERM_GRACE_MS` 的语义是 ProcessManager 的时间策略（spawn 存活确认 + stop SIGTERM→SIGKILL 宽限），不是跨模块通用配置。CLI 等待 spawn 稳定所用的时间必须与 ProcessManager 内部轮询上限同源，这个"同源"关系应该通过 **CLI import ProcessManager 导出的常量** 表达，而不是都指向一个中立的 `constants.ts`——后者把本应单向的依赖伪装成双向耦合。

## 7. 与现状的差异

### A 类（必修违规）

- **A.1（Phase 148 已修复）— 9 处 `console.warn` 静默吞没**：`manager.ts` 原 9 处 `console.warn` 全部替换为 `audit.write(<EVENT>, ...)`，事件名见 § 4。构造器 `audit: Audit` 必传（第 3 参），**不提供 NoopAudit 兜底**——测试用 `InMemoryAudit` 断言事件，与 SessionStore A.2 / Snapshot A.5 / Messaging A.4 同原则。CLI 无 runtime 上下文时通过 `createSystemAudit(fs, baseDir)` 装配（见 § 3）。
- **A.2（Phase 148 部分修复）— `findProcesses` 异常**：Phase 148 已把 `console.warn` 升级为 `audit.write(PROCESS_LIST_FAILED, ...)`，降级信号进入结构化事件流；`findProcessesWarned: Set<string>` 保证同一 pattern 不洪泛。**仍未修**：异常后仍返 `[]`——"pgrep 不可用" vs "无匹配"语义不可区分，失败语义拆分（抛 vs Result）属 Phase 150 "失败语义原语" scope。
- **A.3（Phase 148 已修复）— 进程生命周期 audit**：全链路生命周期事件接入：
  - `PROCESS_SPAWNED` / `PROCESS_SPAWN_FAILED`（spawn 成功/失败）
  - `PROCESS_STOPPED`（stop 实际终止进程）
  - `PROCESS_KILL_ESCALATED`（SIGTERM 宽限期未终止 → SIGKILL）
  - `PROCESS_STOP_STALE`（stop 目标 ESRCH / 无 PID 文件）
  
  进程生命周期作为 clawforum 最核心的可观察事件已完整进入审计流。
- **A.4（Phase 152 已修复）— 资源唯一归属被破坏（lockfile）**：原 `src/cli/commands/daemon.ts` 直接 `path.join(statusDir, 'daemon.lock')` 读写 lockfile 已全部归位。ProcessManager 新增 `acquireLock(clawId)` / `releaseLock(clawId)` / `readLockPid(clawId): number | null` 三个公共方法（见 § 3），内部 `getLockPath` helper 收敛 `'daemon.lock'` 字面量；`daemon.ts` 改用 `pm.acquireLock(name)` / `pm.releaseLock(name)`。`grep 'daemon.lock' src/` 仅命中 ProcessManager 内部实现。lockfile 语义完全归 ProcessManager。
- **A.5（phase233 已消化）— 时间常量跨层耦合**：`PROCESS_SPAWN_CONFIRM_MS` / `SIGTERM_GRACE_MS`
  迁至 `manager.ts` 模块内 `export const` 定义，经 `index.ts` 导出；CLI 三文件改 import 来源；
  `src/constants.ts` 对应条目删除；`SPAWN_POLL_INTERVAL_MS = 50` 内部常量新增。
  SHA: 37d8bb1

### B 类（偏差登记，不必修）

- `findProcessesWarned` 去重 `Set` 无 TTL/清理策略（实例生命周期 = 进程生命周期，无泄漏风险）。
- `openSync` / `closeSync` 的 FS 抽象缺口（Node spawn fd 语义必需，不可消除，此处仅登记）。
- **接口冗余**：`isAlive(clawId)` 与 `getAliveStatus(clawId).alive` 同概念两种接口形式，对照「同一概念同一名字」值得讨论是否保留双接口还是收敛到 `getAliveStatus`。

### C 类（原则对照补充）

- 消费者全为 CLI 命令（8 文件），符合 modules.md「被谁调用：Daemon/CLI/Watchdog」且 clawforum 的 daemon/watchdog 本身就是 CLI 子命令。职责定位清晰。
- `dirResolver` 可选参数支持 Motion 的自定义 PID 路径，已显式表达的扩展点。
- PID 文件 + lockfile 构成 spawn 的磁盘持久化状态，下次 isAlive 调用即可重建运行时句柄 —— 正面符合「持久化一切」「中断可恢复」。

### §7.drift — 应然 framing drift（phase325 全推 / 2026-04-26）

| # | 位置 | drift 描述 | 修正 |
|---|---|---|---|
| D1 | §head | 已有 head split（r32 D）/ 无 § numbering drift（§10 正确）| 无需修正 |

## 8. 测试覆盖（验证行为契约）

- `tests/core/process_manager.test.ts`（12 `it`）：默认 PID 路径 / 自定义 resolver / isAlive（活/死 stale 清理/非法 PID）/ stop（无 PID / stale 清理）/ spawn wx 排他锁（活进程拒绝 / 错误含 clawId / 空 PID concurrent 警告）。
- `tests/core/process_manager_spawn.test.ts`（3 `it`）：pgrep 模式参数、孤儿 SIGTERM、stale 空 PID 警告继续。

**覆盖缺口**：
- A.1/A.3 修复后需补 audit 事件断言（spawn/stop/kill 升级的事件写入）。
- A.2 修复后需补 pgrep 失败 vs 空结果的区分测试。
- A.4 架构边界测试（Phase 152 落地）：`grep 'daemon.lock' src/` 仅命中 ProcessManager 内部 helper，CLI / 其他模块全清。

## 9. §7 四子节索引 + phase195 backfill

本节是 phase195 对既有 `## 7. 与现状的差异`（A/B/C 类）的 §7 四子节索引 + §7.C 32 条全扫补齐 + §7.Phase 执行纪律登记。**保留既有 §7 不解构**（phase187 APPEND 模式 / phase192 L2 agent backfill 复用）。

### 9.A ↔ §7.A 映射

既有 "§7.A 类（必修违规）" 已登 5 条。**phase195 实测复核**：

- `grep "console\." src/foundation/process-manager/` → **0 命中**（`errors.ts` 7 / `index.ts` 10 / `manager.ts` 592 = 609 行 3 文件）
- audit 写位点 40+ 处，全部走 `AUDIT_EVENTS.*` 常量（15 类事件；**无 phase192 `B.p192-1` 式字面量分裂**）：
  ```
  LOCK_ACQUIRED / LOCK_RELEASED / LOCKFILE_CLEANUP_FAILED / LOCKFILE_READ_FAILED
  PID_EMPTY / PID_READ_FAILED / PID_REMOVE_FAILED
  PROCESS_SPAWNED / PROCESS_SPAWN_FAILED / PROCESS_STOPPED / PROCESS_STOP_FAILED
  PROCESS_KILL_ESCALATED / PROCESS_STOP_STALE
  PROCESS_LIST_FAILED / ORPHAN_SIGTERM_FAILED
  ```
- §A.1（9 处 `console.warn`）→ phase148 全清零（→ 9 audit events + 必传 audit + `InMemoryAudit` 测试模式）
- §A.2（`findProcesses` 异常 → `[]`）→ phase148 audit 通路部分清；失败语义拆分留 Phase 150
- §A.3（进程生命周期 audit）→ phase148 全清零（PROCESS_SPAWNED/FAILED/STOPPED/KILL_ESCALATED/STOP_STALE 5 事件全链）
- §A.4（lockfile CLI 绕过资源归属）→ phase152 全清零（`acquireLock`/`releaseLock`/`readLockPid` 3 方法 + `getLockPath` 收敛字面量）
- §A.5（`PROCESS_SPAWN_CONFIRM_MS` / `SIGTERM_GRACE_MS` 跨层常量归属）→ phase233 已消化（SHA: 37d8bb1）

**§7.A phase195 新增 = 0**（既有 A.1-A.5 覆盖充分 / phase148/152 治理轨迹清晰）。

### 9.B ↔ §7.B 映射

既有 "§7.B 类（偏差登记）" 已登 3 条：
1. `findProcessesWarned: Set<string>` 无 TTL/清理（实例生命周期兜底）
2. `openSync`/`closeSync` FS 抽象缺口（Node spawn fd 语义必需）
3. 接口冗余 `isAlive(clawId)` vs `getAliveStatus(clawId).alive`（收敛候选）

**phase195 新增 `B.p195-1`**（结构性登记）：

#### B.p195-1 — `manager.ts` 单文件 592 行（L2 最大）

- **现状**：`src/foundation/process-manager/manager.ts` 592 行，承载 PID 文件管理 + lockfile 排他锁 + spawn 轮询 + stop SIGTERM→SIGKILL + findProcesses pgrep + 孤儿清理 + `getAliveStatus` 6 类职责
- **对比组**（L2 同层 foundation 单文件规模）：
  - L2 SessionStore `store.ts` 250 行
  - L2 Messaging `inbox-reader.ts` 140 行 / `inbox-writer.ts` 135 行 / `outbox-writer.ts` 93 行
  - **L2 ProcessManager `manager.ts` 592 行 ≈ 2.4× SessionStore / 4.2× Messaging 单文件**
- **为何合规（当前）**：6 类职责在 M#1 独立可变维度紧密耦合 —— `spawn` 依赖 `acquireLock` + `writePidExclusive` + 孤儿清理；`stop` 依赖 `readPid` + `findProcesses` + `removePid`；共享状态 `findProcessesWarned` Set。拆分会引入跨文件状态传递 / 循环依赖风险
- **为何登记**：单文件体量超 500 行触发"可读性代价"—— 新读者定位单一方法需较多滚动；与编码规范"耦合界面稳定"（M#7）边界附近
- **owner**：phase0+（早期未分）
- **计划 phase**：独立 phase 拆 —— **触发条件**：
  - 新增职责（如 Watchdog 联动 health check）使行数 > 700
  - `findProcessesWarned` 共享状态需在 spawn / stop 两侧访问且逻辑变复杂
  - 6 类职责之一变更波及其他（M#1 反向测试不通过）
- **升档条件**：以上触发条件之一命中 → 升 §7.A（M#7 耦合界面稳定违反）

### 9.C §7.C 原则对照（32 条，phase195 补全）

既有 "§7.C 类（原则对照补充）" 仅 3 句（非 phase157 升格后全扫形态）。phase195 补 32 条全扫（Module Logic 11 + Design 11 / #1 展 4 面 + Philosophy 4 + Path 6）。深度按需。

#### Module Logic Principles（11 条）

- **M1 独立可变职责**：合规。ProcessManager 职责 = 进程生命周期（PID / lockfile / spawn / stop / pgrep 查找）；与"子进程健康检查"（Watchdog）+"运行时事件循环"（Runtime）+"信号处理约定"（各 agent 自身）独立可变
- **M2 业务语义归属**：合规。PID 文件 + lockfile 的读写判活语义全在 ProcessManager；CLI（status/claw/motion/stop/start）通过公共 API 消费
- **M3 资源归属**：合规（phase152 §A.4 lockfile 归位 + **phase228** §B.p154-1 PID 归位后完整合规）。PID 文件 + `daemon.lock` lockfile 完整归 ProcessManager；lockfile `getLockPath` helper 收敛字面量；7 call sites PID bypass phase228 全切（daemon.ts 3 + claw.ts 1 + chat-viewport.ts 3）
- **M4 持久化**：合规。PID 文件 + lockfile 是"运行时句柄的磁盘持久化载体"（§1 明示）；进程失活 `isAlive` 自动清理 stale 文件实现 "持久化一切 / 运行中断可恢复"
- **M5 依赖单向**：合规。`process-manager` → `foundation/fs` + `foundation/audit` + `types/errors`；无反向
- **M6 依赖结构稳定**：合规。ProcessManager class + SpawnOptions interface 自 phase0 稳定；phase148 audit 必传 / phase152 acquireLock 新增是 non-breaking 扩展
- **M7 耦合界面稳定**：**灰度**（既有 §B.3 接口冗余 `isAlive` vs `getAliveStatus` + 本 phase `B.p195-1` 单文件规模边界）
- **M8 耦合界面最小**：合规。ProcessManager ctor 4 参（含可选 `dirResolver`）；公共方法 8 个（getAliveStatus / isAlive / spawn / stop / findProcesses / acquireLock / releaseLock / readLockPid）；SpawnOptions 5 字段（phase185 DaemonLoopOptions 11 平铺对比范例；ProcessManager 无此问题）
- **M9 显式表达编译器可检**：合规。`SpawnOptions` interface 强类型；错误类 `ProcessManagerError` / `AlreadyRunningError` / `StaleLockFileError` 命名明确
- **M10 不合理停下**：合规。失败路径 audit + 返回值 / 抛 Error 分层（§4 失败语义表明示 13 场景）
- **M11 边界不对停下**：合规。`spawn` 失败抛 Error（audit 不替代）；`stop` 返 boolean；`findProcesses` 失败返 `[]` + audit（§A.2 失败语义歧义留 Phase 150）

#### Design Principles（11 条，#1 展 4 面）

- **D1a 信息不丢失**：合规（phase148 清零后 15 audit 事件全链覆盖失败路径）
- **D1b 状态可观察**：合规。PID 文件即状态（存在 = 活进程 / stale = 失活）；`getAliveStatus` 显式返 `{alive, reason, pid}` 三元组
- **D1c 中断可恢复**：**核心落实者**。"进程在，PID 文件在；进程失活，下次 isAlive 清理 stale 文件"（§1 明示）—— PID + lockfile 磁盘持久化 + 运行时句柄重建
- **D1d 事后可审计**：合规（phase148 必传 audit + 15 事件全覆盖 + 启动/停止/升级全链路）
- **D2 不得丢弃/静默**：合规（§A.1-A.3 phase148 清零；§A.2 audit 通路补齐后降级信号结构化）
- **D3 用户可观察**：合规（audit 事件流 + CLI status 命令可查 PID / 活性）
- **D4 LLM 调用恢复**：无关（ProcessManager 是基础设施，不参与 LLM）
- **D5 日志重建**：合规（audit 事件序列 + PID 文件时间戳 + lockfile 持有时间可重建进程生命周期）
- **D6a 决策主体**：无关（基础设施不做业务决策）
- **D6b 子代理不阻塞**：无关
- **D7 系统可信路径**：合规。PID 目录 + lockfile 目录约定在 WRITABLE_PATHS 内
- **D8 事件驱动**：合规（audit 发事件；ProcessManager 自身不消费事件，被 CLI / Daemon 被动调用）
- **D9 多 claw 不隔绝**：合规（`<baseDir>/claws/<id>/status/pid` 路径归属 per-claw；`findProcesses` pgrep 跨 claw 查找）
- **D10 motion 特殊**：合规（`dirResolver` 可选参支持 Motion 非默认 PID 路径）
- **D11 CLI 唯一对外**：合规（CLI status/claw/motion/stop/start 消费 ProcessManager；无跨 CLI 边界）

#### Philosophy（4 条）

- **P1 上下文工程**：无关
- **P2 多 agent 复用**：合规。单 ProcessManager 实例服务全部 claw；`dirResolver` 扩展点保留 motion 特殊性
- **P3 Agent 即目录 / 对话即状态**：合规。PID 文件 + lockfile 是"Agent 即目录"原语的进程状态位
- **P4 简单优先 / 持久化为主**：合规。文件 lockfile（非内存锁）；PID 文件（非 shared memory）；pgrep 外部命令（非进程表解析）

#### Path Principles（6 条）

- **Path #1 规划基于规划时刻事实**：✓ backfill 前 Read 源码 609 行 / 3 文件 + 测试 17 it（process_manager 14 + process_manager_spawn 3）+ 契约全文 136 行
- **Path #2 差距显式登记**：✓ §A 5 条（A.1-A.5）+ §B 3 条 + phase195 补 `B.p195-1`
- **Path #3 语义一致最小变更单元**：✓ 单一意图 = §7 四子节 APPEND 索引 + 32 条原则补全
- **Path #4 可回滚 + 破坏性论证**：✓ design 本地 only / 无破坏性（§7 原节不改 / §9 纯新增）
- **Path #5 完成后复盘**：phase195 Step 3 产出
- **Path #6 冲突立即中断**：未触发（分支 C 与 r4 分支 A/B/D 文件零重叠）

### 9.D 关键决策映射表（modules.md 迁移）

从 `design/modules.md` §关键设计决策章节迁移（2026-04-26 主会话；后续清理阶段重构）。原 KD 编号保留供对账。

- **KD#17（原 modules.md）ProcessManager 独立于 Daemon**：进程生命周期管理（spawn/stop/isAlive/PID）是基础设施能力,Daemon、CLI、Watchdog 三方共用,不归任何一方内部
- **KD#22（原 modules.md）ProcessManager 是库代码，PID 策略唯一归属此模块**：各进程按需实例化 ProcessManager；PID 文件（他人 spawn 写入 + 自启动 registerSelf 写入）与 lockfile 均归 ProcessManager，自启动进程通过 registerSelf 接入，不直接操作 PID 文件字面量

---

### 9.Phase 执行纪律

#### phase195 纪律 — L2 ProcessManager backfill（2026-04-22，design 本地 only）

- **scope**：既有 `## 7. 与现状的差异` 有 A/B/C 类但 §7.C 仅 3 句薄登记；phase187 APPEND 模式补 §9 章节作为 §7 四子节索引 + phase195 增量
- **产出**：§7.A 映射（0 新增 / 既有 A.1-A.5 phase148/152 部分/全清索引）/ §7.B 映射 + `B.p195-1`（manager.ts 单文件 592 行结构性登记）/ §7.C 32 条全扫（补既有 3 句不足）/ §7.Phase（本节）
- **对比组**：
  - phase187 L1 × 5 backfill 8 §7.A / 9 §7.B（基础层）
  - phase192 SessionStore 0 §7.A / 0 §7.B（最干净 L2 agent）
  - phase192 Messaging 0 §7.A / 1 §7.B（inbox-writer 字面量）
  - phase193 L2 纯通用 × 3（Stream / FileWatcher / AuditLog）0 §7.A 全部
  - **phase195 ProcessManager 0 §7.A / 1 §7.B**（`B.p195-1` 单文件结构性登记 —— 与 `B.p192-1` 2 行级清理形成"规模型 B 类"对比）
- **方法论贡献**：
  - **L2 最大单模块 backfill 落地**（ProcessManager 609 行）—— 与 SessionStore 292 / Messaging 441 形成 L2 三档规模组
  - **`B.p195-1` 结构性 B 类登记**首次 —— 既往 B 类多是 2 行级（`B.p187-1` `B.p192-1`）、3 行级（Messaging §B.3 接口冗余）；本 phase 首次登记"单文件规模"级结构性偏差
  - **既有 §7 薄 §C（3 句）补全 32 条**场景 —— phase187 既有 §C 文件已有完整 §A/§B 只补 §C；ProcessManager 契约是 phase157 §7.C 升格"全 32 条扫描"前形态的典型代表
- **"backfill 零新增"形态第 2 次实证候选**：
  - §7.A 新增 = 0 ✓
  - §7.B 新增 = 1（`B.p195-1` 算新增）
  - 与 phase192 SessionStore（0 + 0）不同 —— 本 phase 属 "零 §7.A 新增" 而非纯零新增
  - "backfill 零新增" 需区分："§7.A 零新增" 和 "完全零新增" 两亚型；phase192 SessionStore 是后者，phase195 是前者
- **升格候选**（观察 phase196+）：
  - **"§7.A 零新增 / §7.B 结构性登记" 亚型**（phase195 首次）—— 2 次验证后可细化 `feedback_module_contract_structure` "backfill 零新增" 节
  - **"单文件规模 B 类登记模板"**（`B.p195-1` 首次）—— 定义触发条件（行数阈值 / 多职责耦合信号 / M#1 反向测试不通过）

#### B.p154-1 已消化（phase228）

- **原登记**：`代码组织整理债.md` B.p154-1 / 7 call sites（daemon.ts 3 + claw.ts 1 + chat-viewport.ts 3）绕过 ProcessManager 直读/写 PID 文件，违反 M#3 资源归属（PID 归 ProcessManager 独占）
  - N1 drift：整理债登记 5 / 分发表 5 → phase228 Step 1 实测 7（chat-viewport 多发 L837 + L1169 两处）
- **phase228 兑现**：`readPid` / `removePid` private → public + `selfWritePid` / `selfRemovePid` 新增 + 7 call sites 全切 + 4 audit 事件（PID_READ_OK / PID_WRITE_OK / PID_WRITE_FAILED / PID_REMOVE_OK）
- **commit**：`b50fa53`（2026-04-22）/ merge `3933b4a`

#### phase228 纪律 — ProcessManager PID public API + 7 call sites 切换（2026-04-22，代码 phase）

- **scope**：B.p154-1 整理债消化 / r12 分支 C / ProcessManager 4 API 可见性 + 新增 + 7 call sites 迁移
- **产出**：
  - `manager.ts`：`readPid` / `removePid` private → public；`selfWritePid` / `selfRemovePid` 新增（~30 行）
  - `events.ts`：4 新常量（PID_READ_OK / PID_WRITE_OK / PID_WRITE_FAILED / PID_REMOVE_OK）
  - `daemon.ts` 3 + `claw.ts` 1 + `chat-viewport.ts` 3 = 7 call sites 全切 fsNative → PM public API
  - 测试：ProcessManager 4 API 覆盖 + daemon-command mock 修复（selfWritePid/selfRemovePid spy）
- **N1 drift**：分发表 5 call sites → Step 1 实测 7（chat-viewport L837 + L1169 多发 2 处）/ N1 登记
- **起步 SHA**：`0e9ed57`（phase221 main tip）/ **合入 SHA**：`b50fa53` / merge `3933b4a`（非 ff / Phase 229 先合入）
- **M#3 状态**：phase228 清零后 PID 文件 + lockfile 完整归 ProcessManager / §7.C M3 从 phase152 部分合规 → **完整合规**
- **Path #7**：PID 归 ProcessManager 不自决（r11 E 方案 A 原则对照 / phase228 兑现登记）

#### phase233 纪律 — §9.A 时间常量归属修复（2026-04-22，代码 phase）

- **scope**：§9.A A.5 消化 / r13 分支 E / 2 常量迁移 + 3 CLI import 替换 + magic number 命名
- **产出**：
  - `manager.ts`：删 constants.ts import → `export const PROCESS_SPAWN_CONFIRM_MS = 3000` / `SIGTERM_GRACE_MS = 5000` + `const SPAWN_POLL_INTERVAL_MS = 50`（L454 `50` 替换）
  - `index.ts`：+1 re-export 行
  - `start.ts` / `claw.ts` / `motion.ts`：import 来源切 `foundation/process-manager/index.js`
  - `constants.ts`：Process Management 节删除（2 常量 + 注释块）
- **起步 SHA**：`a85abe3`（phase227）/ **合入 SHA**：`37d8bb1`（ff merge）
- **M#3 状态**：phase233 后 `PROCESS_SPAWN_CONFIRM_MS` / `SIGTERM_GRACE_MS` / `SPAWN_POLL_INTERVAL_MS` 完整归 ProcessManager / M#3 全合规
- **Path #7**：常量归属于承担其语义的模块（phase225 细则首次代码 phase 实践）
