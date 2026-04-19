# L2 ProcessManager 对外接口契约

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

## 5. 不可消除的耦合

- **等待时间与 CLI 的时间常量共享**：`PROCESS_SPAWN_CONFIRM_MS` 定义 ProcessManager 内部「确认存活」轮询上限；同时 `cli/commands/{claw,motion,start}.ts`（grep 证据：claw.ts L132、motion.ts L218、start.ts L368/L383/L416）用同一常量 `setTimeout` 等待 spawn 稳定。概念相同、值同源（经 `src/constants.ts`），常量变更必须同时影响两处 —— 显式登记此耦合。
- **`SpawnOptions.logFile` 是进程 stdout/stderr 的唯一去向**：ProcessManager 打开文件描述符后交由子进程持有，自身不参与写入。调用方对该文件的任何期望（切分/查看/滚动）不由 ProcessManager 承担。
- **FS 抽象缺口**：spawn 内部对 `logFile` 使用原生 `openSync`/`closeSync` 获取真实 fd（Node `child_process.spawn` 的 stdio fd 参数要求数字 fd，无法走 FileSystem 抽象）。登记为显式耦合，不可消除。
- **pgrep 平台依赖**：`findProcesses` 与 spawn 的孤儿清理都依赖 `pgrep -f`（procps），非 POSIX 通用。平台耦合登记。

## 6. 配置常量归属

| 常量 | 目标归属 | 现状 | 修复方向 |
|---|---|---|---|
| `PROCESS_SPAWN_CONFIRM_MS` | ProcessManager 模块导出 | 定义在 `src/constants.ts`，CLI（claw.ts / motion.ts / start.ts）与 ProcessManager 双向消费 | 迁至 ProcessManager 模块导出，CLI 改 import；`src/constants.ts` 对应条目删除。见 A.5 |
| `SIGTERM_GRACE_MS` | ProcessManager 模块导出 | 定义在 `src/constants.ts`，仅 ProcessManager 消费 | 同上：迁至模块导出 |
| spawn 轮询间隔 `50ms` | ProcessManager 内部常量（`manager.ts` 顶部） | magic number 硬编码 | 抽为 `const SPAWN_POLL_INTERVAL_MS = 50`，不导出（内部实现细节） |
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
- **A.5（修复方向已定，待实施）— 时间常量跨层耦合**：`PROCESS_SPAWN_CONFIRM_MS` / `SIGTERM_GRACE_MS` 当前定义在 `src/constants.ts`，ProcessManager 与 CLI 双向消费同一全局常量，违反「常量归属于承担其语义的模块」。修复路径：
  1. ProcessManager 模块导出两个常量（`src/core/process/manager.ts` 或 `constants.ts` 子模块）
  2. CLI `claw.ts` / `motion.ts` / `start.ts` 改为 `import { PROCESS_SPAWN_CONFIRM_MS } from '.../process/...'`
  3. `src/constants.ts` 对应条目删除
  4. spawn 轮询间隔 50ms 同步抽为模块内部常量 `SPAWN_POLL_INTERVAL_MS`（不导出，内部细节）
  
  修复后 CLI 对时间策略的依赖显式走模块边界，ProcessManager 改时间值仅此一处改动。

### B 类（偏差登记，不必修）

- `findProcessesWarned` 去重 `Set` 无 TTL/清理策略（实例生命周期 = 进程生命周期，无泄漏风险）。
- `openSync` / `closeSync` 的 FS 抽象缺口（Node spawn fd 语义必需，不可消除，此处仅登记）。
- **接口冗余**：`isAlive(clawId)` 与 `getAliveStatus(clawId).alive` 同概念两种接口形式，对照「同一概念同一名字」值得讨论是否保留双接口还是收敛到 `getAliveStatus`。

### C 类（原则对照补充）

- 消费者全为 CLI 命令（8 文件），符合 modules.md「被谁调用：Daemon/CLI/Watchdog」且 clawforum 的 daemon/watchdog 本身就是 CLI 子命令。职责定位清晰。
- `dirResolver` 可选参数支持 Motion 的自定义 PID 路径，已显式表达的扩展点。
- PID 文件 + lockfile 构成 spawn 的磁盘持久化状态，下次 isAlive 调用即可重建运行时句柄 —— 正面符合「持久化一切」「中断可恢复」。

## 8. 测试覆盖（验证行为契约）

- `tests/core/process_manager.test.ts`（12 `it`）：默认 PID 路径 / 自定义 resolver / isAlive（活/死 stale 清理/非法 PID）/ stop（无 PID / stale 清理）/ spawn wx 排他锁（活进程拒绝 / 错误含 clawId / 空 PID concurrent 警告）。
- `tests/core/process_manager_spawn.test.ts`（3 `it`）：pgrep 模式参数、孤儿 SIGTERM、stale 空 PID 警告继续。

**覆盖缺口**：
- A.1/A.3 修复后需补 audit 事件断言（spawn/stop/kill 升级的事件写入）。
- A.2 修复后需补 pgrep 失败 vs 空结果的区分测试。
- A.4 架构边界测试（Phase 152 落地）：`grep 'daemon.lock' src/` 仅命中 ProcessManager 内部 helper，CLI / 其他模块全清。
