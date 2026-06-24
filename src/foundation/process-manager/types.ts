import type { FileSystem } from '../fs/index.js';
import type { AuditLog } from '../audit/index.js';
import type { ProcessStartTime } from '../process-exec/index.js';
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


export class LockConflictError extends Error {
  readonly lockPath: string;
  constructor(lockPath: string, message?: string) {
    super(message ?? `Lock conflict: another process holds the lock at ${lockPath}`);
    this.name = 'LockConflictError';
    this.lockPath = lockPath;
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
  /** Optional readLockPid override (used by tests spying on ProcessManager.prototype.readLockPid) */
  readLockPid?: (daemonDir: DaemonDir) => { pid: number; startTime?: ProcessStartTime } | null;
  /** Optional l1IsAlive override (used by tests injecting process-exec level liveness probe) */
  l1IsAlive?: typeof defaultL1IsAlive;
  /** Optional spawnDetached override (used by tests injecting process-exec level spawn) */
  spawnDetached?: typeof defaultSpawnDetached;
  /** Optional getProcessStartTime override (used by tests injecting process-exec level startTime probe) */
  getProcessStartTime?: typeof defaultGetProcessStartTime;
  /** Optional kill override (used by tests injecting process-exec level signal sender) */
  kill?: typeof defaultKill;
}
