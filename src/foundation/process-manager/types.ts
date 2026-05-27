import type { FileSystem } from '../fs/types.js';
import type { AuditLog } from '../audit/index.js';
import type { ClawId } from '../identity/index.js';


export class LockConflictError extends Error {
  readonly clawId: ClawId;
  constructor(clawId: ClawId, message?: string) {
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
  resolveDir: (clawId: ClawId) => string;
  /** Optional alive override (used by tests spying on ProcessManager.prototype.isAlive) */
  isAlive?: (clawId: ClawId) => boolean;
  /** Optional ready override (used by tests spying on ProcessManager.prototype.isReady) */
  isReady?: (clawId: ClawId) => boolean;
  /** Optional readLockPid override (used by tests spying on ProcessManager.prototype.readLockPid) */
  readLockPid?: (clawId: ClawId) => { pid: number; startTime?: string } | null;
}
