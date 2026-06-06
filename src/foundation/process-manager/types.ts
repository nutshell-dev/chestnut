import type { FileSystem } from '../fs/types.js';
import type { AuditLog } from '../audit/index.js';
import type { ProcessStartTime } from '../process-exec/index.js';
import type { isAlive as defaultL1IsAlive, spawnDetached as defaultSpawnDetached, getProcessStartTime as defaultGetProcessStartTime, kill as defaultKill } from '../process-exec/index.js';


export class LockConflictError extends Error {
  readonly clawId: string;
  constructor(clawId: string, message?: string) {
    super(message ?? `Lock conflict: another process holds the lock for ${clawId}`);
    this.name = 'LockConflictError';
    this.clawId = clawId;
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
 * Replaces class state (this.fs / this.audit / this.resolveDir).
 */
export interface ProcessManagerContext {
  fs: FileSystem;
  audit: AuditLog;
  resolveDir: (clawId: string) => string;
  /** Optional alive override (used by tests spying on ProcessManager.prototype.isAlive) */
  isAlive?: (clawId: string) => boolean;
  /** Optional ready override (used by tests spying on ProcessManager.prototype.isReady) */
  isReady?: (clawId: string) => boolean;
  /** Optional readLockPid override (used by tests spying on ProcessManager.prototype.readLockPid) */
  readLockPid?: (clawId: string) => { pid: number; startTime?: ProcessStartTime } | null;
  /** Optional l1IsAlive override (used by tests injecting process-exec level liveness probe) */
  l1IsAlive?: typeof defaultL1IsAlive;
  /** Optional spawnDetached override (used by tests injecting process-exec level spawn) */
  spawnDetached?: typeof defaultSpawnDetached;
  /** Optional getProcessStartTime override (used by tests injecting process-exec level startTime probe) */
  getProcessStartTime?: typeof defaultGetProcessStartTime;
  /** Optional kill override (used by tests injecting process-exec level signal sender) */
  kill?: typeof defaultKill;
}
