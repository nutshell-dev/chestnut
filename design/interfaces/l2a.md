# Interfaces L2a — 通用基础设施层接口

3 模块：AuditLog、Snapshot、ProcessManager。

模板加字段说明见主索引 [interfaces.md](../interfaces.md)。

---

## AuditLog [capability, DI]

**生产方**：`l2_audit_log`

**消费方**：所有需要审计的模块（几乎所有 L2+ 模块）

**接口签名**：

```ts
export interface AuditLog {
  write(type: string, ...fields: (string | number)[]): void;
}

// 实现 class（暴露给装配方做类型推断）
export class AuditWriter implements AuditLog {
  constructor(fs: FileSystem, filePath: string, maxSizeMb?: number | null);
  write(type: string, ...cols: (string | number)[]): void;
}

// 工厂
export function createSystemAudit(fs: FileSystem, baseDir: string): AuditWriter;
export function createAuditWriter(fs: FileSystem, filePath: string, maxSizeMb?: number | null): AuditWriter;

// 常量
export const AUDIT_FILE: string;  // 'audit.tsv' / audit 文件名（相对路径）
```

**使用语义**：写失败不抛（best-effort / `[AUDIT CRITICAL]` console.error 兜底 / 「审计的审计」递归边界）。event 名加字段语义由 caller 自治。`maxSizeMb` 触发按大小切割归档（mv to `<file>.<ts>.bak`）。

**应然权威**：interface 名 `AuditLog` align architecture.md §6 + 表 1 权威（实然 code drift 见 modules §A）。

**归本模块**：clawforum 状态迁移审计记录的唯一入口。业务模块要审计必经本模块。

**不归本模块**：

- event 名清单维护（合法 event 列表），归各调用方自治命名
- 业务字段 schema 验证，归各调用方业务
- 业务因果链构造（哪个 event 关联哪个），归各调用方业务

**不可消除耦合理由**：M#3 资源唯一归属（audit 持久化是单一资源）加 Design Principle「事后可审计」derive — 跨进程消费者经过 audit 文件 grep 重建任一时刻状态加决策链路必经本模块统一格式。

---

## Snapshot [capability, DI]

**生产方**：`l2_snapshot`

**消费方**：

- `l5_runtime`（DI，轮级 commit）
- `l6_daemon`（DI，启动期 init 加 commit）
- `l6_cli`（DI，CLI 命令）

**接口签名**：

```ts
export class Snapshot {
  constructor(dir: string, fs: FileSystem, audit: AuditLog, ignorePatterns: readonly string[]);
  init(): Promise<Result<void, ExpectedGitFailure>>;
  commit(message: string): Promise<Result<void, ExpectedGitFailure>>;
}

// 工厂
export function createSnapshot(
  dir: string,
  fs: FileSystem,
  audit: AuditLog,
  ignorePatterns: readonly string[],
): Snapshot;

// 常量（装配期注入 ignorePatterns 的默认聚合常量）
export const SNAPSHOT_IGNORE_PATTERNS: readonly string[];

export type ExpectedGitFailure =
  | { kind: 'not_a_repo'; stderr: string }
  | { kind: 'nothing_to_commit'; stderr: string }
  | { kind: 'no_commits_yet'; stderr: string }
  | { kind: 'no_repo_handle'; stderr: string }
  | { kind: 'uncategorized'; exitCode: number; stderr: string };
```

注：`Result<T, E>` 是 clawforum 通用 discriminated union（`{ ok: true; value }` 或 `{ ok: false; error }`）。

**使用语义**：

- 构造期通过 ctor 注入 `dir + fs + audit + ignorePatterns`（应然不立 SnapshotInitOptions / 实然 ctor own 配置）
- `init()` 幂等（已存在 .git 直接 ok / 0 args / 配置已 ctor 注入）
- `commit(message)` 无变更跳过返 `ok(undefined)` / 有变更走 `git add . && git commit`
- 预期失败（git 语义识别）→ 返 `Result.err(ExpectedGitFailure)` 降级 + audit 不抛（best-effort）
- 不可预期失败（磁盘满 / 权限拒）→ throw 冒泡给启动流程
- 连续失败 ≥ 3 次触发 audit `snapshot_degraded` 告警事件

**归本模块**：clawforum 目标目录版本化快照能力的唯一入口。业务模块要做版本化记录必经本模块。

**不归本模块**：

- 业务目录语义（agent 目录是调用方场景），调用方提供目标目录
- ignore patterns 聚合（哪些模块产生哪些 disk artifacts），归 L6 Assembly 装配期组装注入
- 业务级回滚策略（回滚到哪个版本、何时回滚），调用方决定
- 提交频率（如轮级 commit），调用方决定

**不可消除耦合理由**：M#3 资源唯一归属（目标目录的版本化历史状态是单一资源）加 M#9 不可消除耦合显式 — ignore patterns 通过参数注入（Assembly own 加组装），本模块不直接 import 其他模块的常量。

---

## ProcessManager [capability, DI]

**生产方**：`l2_process_manager`

**消费方**：

- `l6_daemon`（DI，daemon 自注册 PID 加生命周期管理）
- `l6_watchdog`（DI，监控目标进程加重启）
- `l6_cli`（DI，CLI 进程命令）

**接口签名**：

```ts
export class ProcessManager {
  constructor(
    fs: FileSystem,
    baseDir: string,
    audit: AuditLog,
    dirResolver?: (clawId: string) => string,
  );

  // 生命周期
  spawn(clawId: string, options: SpawnOptions): Promise<number>;     // 返 pid
  stop(clawId: string): Promise<boolean>;                            // 返 stopped (false = 已停 / 无操作)

  // 判活（sync OS calls / 不裹 Promise）
  isAlive(clawId: string): boolean;
  getAliveStatus(clawId: string): { alive: boolean; reason: string; pid?: number };
  findProcesses(pattern: string): number[];  // pgrep 包装 / 失败抛 ProcessListUnavailable

  // PID 公共 API（4 方法 / async = 涉 fs）
  readPid(clawId: string): Promise<number | null>;
  removePid(clawId: string): Promise<void>;
  selfWritePid(clawId: string): Promise<void>;   // wx 排他写 / 内部用 process.pid
  selfRemovePid(clawId: string): Promise<void>;

  // lockfile 公共 API（3 方法 / sync = 启动期 / shutdown 期）
  acquireLock(clawId: string): void;             // 冲突抛 LockConflictError
  releaseLock(clawId: string): void;
  readLockPid(clawId: string): number | null;
}

export interface SpawnOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  logFile?: string;       // stdio 日志 fd 路径
  detached?: boolean;
}

// 工厂（实然位置 drift 见 modules §A）
export function createAgentProcessManager(audit: AuditLog): ProcessManager;

// 常量（spawn 流程时序）
export const PROCESS_SPAWN_CONFIRM_MS: number;   // 3000 / spawn 后等待 PID 文件确认
export const SIGTERM_GRACE_MS: number;           // 5000 / SIGTERM 后等待优雅退出 → SIGKILL

export class LockConflictError extends Error {
  readonly clawId: string;
 // 锁冲突失败语义本质归 PM
}

export class ProcessListUnavailable extends Error {
  readonly code: 'PROCESS_LIST_UNAVAILABLE';
  readonly pattern: string;
  readonly cause: unknown;
  // pgrep 不可用时（找不到 binary / 权限拒）抛
}
```

**使用语义**：

- 参数名 `clawId`：PM 应然抽象层是「进程生命周期编排」/ 实然采纳 `clawId` 命名是因为 daemon 实然全是 claw daemon（含 motion 这一特殊 claw）/ caller universe 限定为 claw daemon
- spawn 失败抛 generic `Error`（应然 silent on 错误类 / 不立 ProcessManagerError 应然幻象 class）
- acquireLock 冲突抛 LockConflictError
- stop：先 SIGTERM + 等 SIGTERM_GRACE_MS / 仍存活 → SIGKILL 强制 kill / 进程不存在返 `false`
- isAlive / getAliveStatus / readLockPid 是 sync 因 underlying OS call 是 sync (`process.kill(pid, 0)` / fs.readSync)
- findProcesses sync = pgrep 子进程 spawnSync
- acquireLock / releaseLock sync = 启动期 / shutdown 期 critical section / 无 await 风险
- selfWritePid 1 参 = 写自身（用 `process.pid` 内部）/ 应然不分 self vs other 形态

**归本模块**：clawforum 进程生命周期编排能力的唯一入口。业务模块要管理进程生命周期必经本模块。

**不归本模块**：

- OS 信号名暴露（POSIX 信号名等），caller-facing API 用意图三档，OS 信号 mapping 是 L1 ProcessExec 内部细节
- 调用方业务概念（这进程是哪个 daemon、什么 agent identity），调用方业务
- 业务化重启策略（重启时机、backoff 策略、重启决策），调用方决定（如 L6 Watchdog own 重启 backoff）
- 直接 OS API 调用，归 L1 ProcessExec 加 L1 FileSystem

**不可消除耦合理由**：M#3 资源唯一归属（进程注册表加生命周期编排是单一资源）加 M#5 业务模块不允许直接 import OS 进程加文件 API。Design Principle「clawforum 支持分布式部署和跨 OS 平台」derive — 进程编排必经本模块抽象（与 L1 同型，L2 也守此约束）。
