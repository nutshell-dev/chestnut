import type { FileSystem } from '../fs/index.js';
import type { AuditLog } from '../audit/index.js';

import type { isAlive as defaultL1IsAlive, spawnDetached as defaultSpawnDetached, getProcessStartTime as defaultGetProcessStartTime, kill as defaultKill } from '../process-exec/index.js';


/**
 * Brand type for daemon owner directory.
 *
 * phase 694: PM API 入参强制 brand、防 structural typing 让 ClawId 当 daemonDir 误传。
 * caller 必经 L4 ClawTopology.resolveClawDaemonDir 或 PM.makeDaemonDir 构造。
 *
 * 同型 brand: ChestnutRoot (core/claw-topology/claw-instance-paths.ts) / ClawId (identity/) / StepNumber.
 */
declare const DaemonDirBrand: unique symbol;
export type DaemonDir = string & { readonly [DaemonDirBrand]: true };

/** Brand factory (PM internal 自构造 or L4 ClawTopology 通过本 factory 包) */
export function makeDaemonDir(s: string): DaemonDir {
  return s as DaemonDir;
}


/**
 * Phase 1235: spawn ownership conflict 的合法竞争原因（discriminant）。
 * caller 不解析 message、reason 编译期可检。
 *
 * - active_owner:       active generation 对应进程仍活，磁盘 winner 是 active record
 * - spawn_in_progress:  spawning generation 已被另一 spawn 持有（precheck）
 * - commit_lost:        candidate → spawning move 输给 foreign generation
 */
export type ProcessSpawnConflictReason =
  | 'active_owner'
  | 'spawn_in_progress'
  | 'commit_lost';

/**
 * Phase 1235: 合法 spawn ownership 竞争 —— 另一实例/另一 spawn generation 是
 * 磁盘上的合法 winner。Watchdog 只对本类型清零 restart backoff。
 */
export class ProcessSpawnConflictError extends Error {
  readonly daemonDir: DaemonDir;
  readonly reason: ProcessSpawnConflictReason;
  /** 磁盘 winner 的 generation ID（来源逐分支不同，见 spawn.ts 六分支映射） */
  readonly generationId: string;
  constructor(
    daemonDir: DaemonDir,
    reason: ProcessSpawnConflictReason,
    generationId: string,
    message?: string,
  ) {
    super(message ?? `Spawn conflict for "${daemonDir}" (${reason}, generation ${generationId})`);
    this.name = 'ProcessSpawnConflictError';
    this.daemonDir = daemonDir;
    this.reason = reason;
    this.generationId = generationId;
  }
}

/**
 * Phase 1235: generation 持久状态损坏（malformed）—— fail-closed，不得解释为
 * 另一实例启动成功。携带原始损坏原因（Error cause option），Watchdog 归入
 * failed/backoff 并写 PROCESS_SPAWN_FAILED。
 */
export class ProcessGenerationStateError extends Error {
  readonly daemonDir: DaemonDir;
  readonly location: 'active' | 'spawning';
  readonly operation: 'inspect' | 'commit';
  readonly cause: unknown;
  constructor(
    daemonDir: DaemonDir,
    location: 'active' | 'spawning',
    operation: 'inspect' | 'commit',
    cause: unknown,
    message?: string,
  ) {
    super(
      message ?? `Malformed ${location} generation state for "${daemonDir}" (${operation})`,
    );
    this.name = 'ProcessGenerationStateError';
    this.daemonDir = daemonDir;
    this.location = location;
    this.operation = operation;
    // 显式 readonly 字段保留原始损坏原因（Error cause 语义），不覆盖、不丢失
    this.cause = cause;
  }
}

export interface SpawnOptions {
  /** 可执行文件路径（如 'node'） */
  command: string;
  /** 命令参数（如 ['/path/to/daemon-entry.js', 'motion']） */
  args: string[];
  /** 子进程工作目录（可选，默认继承父进程） */
  cwd?: string;
  /** stdout/stderr 重定向的日志文件绝对路径 */
  logFile: string;
  /** 环境变量（可选，默认继承父进程） */
  env?: Record<string, string | undefined>;
}

/**
 * Dependency context for sub-module functions.
 * Replaces class state (this.fs / this.audit).
 *
 * phase 694: 撤 resolveDir callback、PM 不再持 chestnut 拓扑映射；
 * sub-ops 直 take daemonDir: DaemonDir per call。
 */
export interface ProcessManagerContext {
  fs: FileSystem;
  audit: AuditLog;
  /** Optional alive override (used by tests spying on ProcessManager.prototype.isAlive) */
  isAlive?: (daemonDir: DaemonDir) => boolean;
  /** Optional ready override (used by tests spying on ProcessManager.prototype.isReady) */
  isReady?: (daemonDir: DaemonDir) => boolean;
  /** Optional l1IsAlive override (used by tests injecting process-exec level liveness probe) */
  l1IsAlive?: typeof defaultL1IsAlive;
  /** Optional spawnDetached override (used by tests injecting process-exec level spawn) */
  spawnDetached?: typeof defaultSpawnDetached;
  /** Optional getProcessStartTime override (used by tests injecting process-exec level startTime probe) */
  getProcessStartTime?: typeof defaultGetProcessStartTime;
  /** Optional kill override (used by tests injecting process-exec level signal sender) */
  kill?: typeof defaultKill;
}
