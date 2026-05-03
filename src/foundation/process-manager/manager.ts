/**
 * ProcessManager - Claw process manager
 *
 * Manages daemon process startup, shutdown, and status checks
 */

import * as path from 'path';

import type { FileSystem } from '../fs/types.js';
import type { AuditLog } from '../audit/index.js';
import { ProcessListUnavailable } from './errors.js';
import { spawnDetached, pgrepSync } from '../process-exec/index.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from './audit-events.js';
import { STATUS_SUBDIR } from '../../types/paths.js';

export const PROCESS_SPAWN_CONFIRM_MS = 3000;
export const SIGTERM_GRACE_MS = 5000;
const SPAWN_POLL_INTERVAL_MS = 50;

/**
 * Thrown when a lock is already held by another live process.
 * Used to distinguish "holder alive" from "stale lock" in acquireLock.
 */
export class LockConflictError extends Error {
  readonly clawId: string;
  constructor(clawId: string, message?: string) {
    super(message ?? `Lock conflict: another daemon is running for ${clawId}`);
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

export class ProcessManager {
  private fs: FileSystem;
  private baseDir: string;
  private resolveDir: (id: string) => string;
  private readonly audit: AuditLog;

  constructor(fs: FileSystem, baseDir: string, audit: AuditLog, dirResolver?: (id: string) => string) {
    this.fs = fs;
    this.baseDir = baseDir;
    this.audit = audit;
    this.resolveDir = dirResolver ?? ((id: string) => path.join(baseDir, 'claws', id));
  }

  /**
   * Get the status directory path for a claw
   */
  private getStatusDir(clawId: string): string {
    return path.join(this.resolveDir(clawId), STATUS_SUBDIR);
  }

  /**
   * Get the pid file path
   */
  private getPidFile(clawId: string): string {
    return path.join(this.getStatusDir(clawId), 'pid');
  }

  /**
   * Get the lock file path
   */
  private getLockFile(clawId: string): string {
    return path.join(this.getStatusDir(clawId), 'daemon.lock');
  }

  /**
   * Ensure the status directory exists
   */
  private async ensureStatusDir(clawId: string): Promise<void> {
    const statusDir = this.getStatusDir(clawId);
    await this.fs.ensureDir(statusDir);
  }

  /**
   * Read the pid file
   */
  async readPid(clawId: string): Promise<number | null> {
    try {
      const pidFile = this.getPidFile(clawId);
      const content = await this.fs.read(pidFile);
      const pid = parseInt(content.trim(), 10);
      if (!Number.isFinite(pid)) {
        this.audit.write(PROCESS_MANAGER_AUDIT_EVENTS.PID_READ_FAILED, `claw=${clawId}`, `reason=invalid_pid`);
        return null;
      }
      this.audit.write(PROCESS_MANAGER_AUDIT_EVENTS.PID_READ_OK, `claw=${clawId}`, `pid=${pid}`);
      return pid;
    } catch (err: any) {
      // ENOENT/FS_NOT_FOUND is expected (process not running); other errors should be logged
      if (err?.code === 'ENOENT' || err?.code === 'FS_NOT_FOUND') {
        return null;
      }
      this.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.PID_READ_FAILED,
        `claw=${clawId}`,
        `reason=${err?.message || String(err)}`,
      );
      return null;
    }
  }

  /**
   * Delete the pid file
   */
  async removePid(clawId: string): Promise<void> {
    try {
      const pidFile = this.getPidFile(clawId);
      await this.fs.delete(pidFile);
      this.audit.write(PROCESS_MANAGER_AUDIT_EVENTS.PID_REMOVE_OK, `claw=${clawId}`);
    } catch (err: any) {
      // Ignore file-not-found (ENOENT or NodeFileSystem's FS_NOT_FOUND)
      if (err.code === 'ENOENT' || err.code === 'FS_NOT_FOUND') {
        return;
      }
      this.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.PID_REMOVE_FAILED,
        `claw=${clawId}`,
        `reason=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Get detailed alive status including reason
   */
  getAliveStatus(clawId: string): { alive: boolean; reason: string; pid?: number } {
    try {
      const pidFile = this.getPidFile(clawId);
      const content = this.fs.readSync(pidFile);
      const trimmed = content.trim();
      if (trimmed === '') {
        return { alive: false, reason: 'empty PID file' };
      }
      const pid = parseInt(trimmed, 10);
      if (isNaN(pid)) {
        return { alive: false, reason: `invalid PID: "${trimmed}"` };
      }

      try {
        process.kill(pid, 0);
        return { alive: true, reason: `PID ${pid}`, pid };
      } catch (err: any) {
        if (err.code === 'ESRCH') {
          try { this.fs.deleteSync(pidFile); } catch { /* ignore */ }
          return { alive: false, reason: `PID ${pid} not found (ESRCH)` };
        }
        if (err.code === 'EPERM') {
          return { alive: true, reason: `PID ${pid} (EPERM, assumed alive)`, pid };
        }
        return { alive: false, reason: `kill(0) error: ${err.code}` };
      }
    } catch (err: any) {
      if (err.code === 'ENOENT' || err.code === 'FS_NOT_FOUND') {
        return { alive: false, reason: 'no PID file' };
      }
      return { alive: false, reason: `read error: ${err.code || err.message}` };
    }
  }

  /**
   * Check whether the process is alive
   * Uses process.kill(pid, 0) to detect process existence
   */
  isAlive(clawId: string): boolean {
    return this.getAliveStatus(clawId).alive;
  }

  /**
   * Read the lock file PID. Returns null if file missing or unreadable.
   */
  readLockPid(clawId: string): number | null {
    try {
      const lockFile = this.getLockFile(clawId);
      const content = this.fs.readSync(lockFile).trim();
      const pid = parseInt(content, 10);
      return isNaN(pid) ? null : pid;
    } catch (err: any) {
      if (err?.code !== 'ENOENT' && err?.code !== 'FS_NOT_FOUND') {
        this.audit.write(
          PROCESS_MANAGER_AUDIT_EVENTS.LOCKFILE_READ_FAILED,
          `claw=${clawId}`,
          `reason=${err?.message || String(err)}`,
        );
      }
      return null;
    }
  }

  /**
   * Acquire exclusive daemon lock for the given clawId.
   * Called from within the daemon process itself (foreground entry).
   * Throws if another live daemon holds the lock.
   */
  acquireLock(clawId: string): void {
    const lockFile = this.getLockFile(clawId);
    this.fs.ensureDirSync(path.dirname(lockFile));
    try {
      this.fs.writeExclusiveSync(lockFile, String(process.pid));
      this.audit.write(PROCESS_MANAGER_AUDIT_EVENTS.LOCK_ACQUIRED, `claw=${clawId}`, `pid=${process.pid}`);
      return;
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
    }

    // EEXIST: probe holder
    const holderPid = this.readLockPid(clawId);
    if (holderPid !== null) {
      try {
        process.kill(holderPid, 0);
        // kill succeeded → holder is alive
        throw new LockConflictError(
          clawId,
          `Another "${clawId}" daemon is running (PID: ${holderPid})`,
        );
      } catch (killErr: any) {
        if (killErr instanceof LockConflictError) throw killErr; // holder alive
        if (killErr?.code === 'EPERM') {
          // alive but no permission to signal
          throw new LockConflictError(
            clawId,
            `Another "${clawId}" daemon is running (PID: ${holderPid}, no permission to signal)`,
          );
        }
        if (killErr?.code === 'ESRCH') {
          // stale, fall through to cleanup
        } else {
          // unknown errno: conservative — treat as alive, do not steal
          throw new LockConflictError(
            clawId,
            `kill probe failed (errno=${killErr?.code}): ${killErr instanceof Error ? killErr.message : String(killErr)}`,
          );
        }
      }
    }

    // stale: remove and retry once
    try { this.fs.deleteSync(lockFile); } catch (e: any) {
      if (e?.code !== 'ENOENT' && e?.code !== 'FS_NOT_FOUND') {
        this.audit.write(PROCESS_MANAGER_AUDIT_EVENTS.LOCKFILE_CLEANUP_FAILED, `claw=${clawId}`, `op=acquire_retry`, `reason=${e?.message || String(e)}`);
      }
    }
    try {
      this.fs.writeExclusiveSync(lockFile, String(process.pid));
      this.audit.write(PROCESS_MANAGER_AUDIT_EVENTS.LOCK_ACQUIRED, `claw=${clawId}`, `pid=${process.pid}`, `context=stale_retry`);
    } catch (retryErr: any) {
      if (retryErr?.code === 'EEXIST') {
        throw new LockConflictError(
          clawId,
          `Another "${clawId}" daemon acquired the lock during retry`,
        );
      }
      throw retryErr;
    }
  }

  /**
   * Release the daemon lock if held by the current process.
   * Deletes the lock file; failures are audit-logged, not thrown.
   *
   * TOCTOU note: readLockPid + deleteSync is check-then-act.
   * Acceptable because releaseLock is only called during daemon shutdown,
   * when this process still holds the lock. If another daemon had already
   * stolen the lock, this process would have been SIGKILL'd and its
   * shutdown handler would not be running.
   */
  releaseLock(clawId: string): void {
    const holderPid = this.readLockPid(clawId);
    if (holderPid !== process.pid) return; // 不是本进程持有，不动
    const lockFile = this.getLockFile(clawId);
    try {
      this.fs.deleteSync(lockFile);
      this.audit.write(PROCESS_MANAGER_AUDIT_EVENTS.LOCK_RELEASED, `claw=${clawId}`, `pid=${process.pid}`);
    } catch (err: any) {
      if (err?.code !== 'ENOENT' && err?.code !== 'FS_NOT_FOUND') {
        this.audit.write(
          PROCESS_MANAGER_AUDIT_EVENTS.LOCKFILE_CLEANUP_FAILED,
          `claw=${clawId}`,
          `op=release`,
          `reason=${err?.message || String(err)}`,
        );
      }
    }
  }

  /**
   * Spawn a detached process
   * @param clawId - process identifier (used for PID file management)
   * @param options - spawn configuration (command, args, logFile, env, cwd)
   * @returns process PID
   */
  async spawn(clawId: string, options: SpawnOptions): Promise<number> {
    // Fast-path: if already running, fail immediately to avoid waiting on pgrep
    if (this.isAlive(clawId)) {
      throw new Error(`Claw "${clawId}" is already running (PID file exists)`);
    }

    // Kill all orphaned daemon processes with the same name (pgrep scan)
    // Use args as pattern to only match current installation
    const pattern = options.args.join(' ');
    let pids: number[] = [];
    try {
      pids = this.findProcesses(pattern);
    } catch (err) {
      if (err instanceof ProcessListUnavailable) {
        // 降级：孤儿清理跳过；spawn 继续尝试
        // audit 已由 findProcesses 写
      } else {
        throw err;
      }
    }
    let sentAny = false;
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM');
        sentAny = true;
      } catch (err: any) {
        if (err?.code !== 'ESRCH') {
          this.audit.write(
            PROCESS_MANAGER_AUDIT_EVENTS.ORPHAN_SIGTERM_FAILED,
            `claw=${clawId}`,
            `pid=${pid}`,
            `reason=${err?.message || String(err)}`,
          );
        }
      }
    }
    if (sentAny) {
      await new Promise(resolve => setTimeout(resolve, SIGTERM_GRACE_MS));
    }

    // Check and clean up the old daemon's lockfile
    const lockFile = this.getLockFile(clawId);
    try {
      const lockPid = this.readLockPid(clawId);
      if (lockPid !== null) {
        // Pre-check: only SIGTERM if the lock holder is still alive
        let lockAlive = false;
        try {
          process.kill(lockPid, 0);
          lockAlive = true;
        } catch (err: any) {
          if (err.code === 'EPERM') lockAlive = true; // process exists but no permission to signal
        }
        if (lockAlive) {
          try {
            process.kill(lockPid, 'SIGTERM');
            // Wait for graceful exit
            await new Promise(resolve => setTimeout(resolve, SIGTERM_GRACE_MS));
          } catch (err: any) {
            if (err?.code !== 'ESRCH') {
              this.audit.write(
                PROCESS_MANAGER_AUDIT_EVENTS.LOCKFILE_CLEANUP_FAILED,
                `claw=${clawId}`,
                `op=sigterm`,
                `pid=${lockPid}`,
                `reason=${err?.message || String(err)}`,
              );
            }
          }
        }
      }
      // Clean up stale lockfile (not-found is normal on first run)
      try { await this.fs.delete(lockFile); } catch (err: any) {
        if (err?.code !== 'ENOENT' && err?.code !== 'FS_NOT_FOUND') {
          this.audit.write(
            PROCESS_MANAGER_AUDIT_EVENTS.LOCKFILE_CLEANUP_FAILED,
            `claw=${clawId}`,
            `op=delete`,
            `path=${lockFile}`,
            `reason=${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err: any) {
      if (err?.code !== 'ENOENT' && err?.code !== 'FS_NOT_FOUND') {
        this.audit.write(
          PROCESS_MANAGER_AUDIT_EVENTS.LOCKFILE_READ_FAILED,
          `claw=${clawId}`,
          `reason=${err?.code || err?.message || String(err)}`,
        );
      }
    }
    
    // Exclusively create the PID file (avoid race conditions)
    const pidFile = this.getPidFile(clawId);
    await this.ensureStatusDir(clawId);
    
    try {
      // 'wx' = write + exclusive, throws EEXIST if the file already exists
      this.fs.writeExclusiveSync(pidFile, '');
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        // Check whether the process is genuinely running or this is a stale PID file
        if (this.isAlive(clawId)) {
          throw new Error(`Claw "${clawId}" is already running (PID file exists)`);
        }
        // 区分：空文件 = spawn 进行中；有 PID 内容 = 陈旧文件
        let existingContent = '';
        try { existingContent = this.fs.readSync(pidFile).trim(); } catch {}
        if (existingContent === '') {
          // 空文件：可能有并发 spawn，记录警告后继续（接受极小概率重复启动）
          this.audit.write(
            PROCESS_MANAGER_AUDIT_EVENTS.PID_EMPTY,
            `claw=${clawId}`,
          );
        }
        // 清理陈旧文件并重建
        await this.removePid(clawId).catch(() => {});
        this.fs.writeExclusiveSync(pidFile, '');
      } else {
        throw err;
      }
    }

    // Ensure log directory exists
    this.fs.ensureDirSync(path.dirname(options.logFile));

    try {
      const { pid } = spawnDetached(options.command, options.args, {
        cwd: options.cwd,
        env: options.env,
        logFile: options.logFile,
      });

      // Write the pid file
      await this.fs.writeAtomic(pidFile, String(pid));

      // Poll until alive or timeout (handles slow ESM startup on constrained servers).
      // Always checks at least once; retries every SPAWN_POLL_INTERVAL_MS up to PROCESS_SPAWN_CONFIRM_MS total.
      let alive = this.isAlive(clawId);
      const deadline = Date.now() + PROCESS_SPAWN_CONFIRM_MS;
      while (!alive && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, SPAWN_POLL_INTERVAL_MS));
        alive = this.isAlive(clawId);
      }
      if (!alive) {
        throw new Error(`Process "${clawId}" failed to start. Check logs at: ${options.logFile}`);
      }

      this.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_SPAWNED,
        `claw=${clawId}`,
        `pid=${pid}`,
        `command=${options.command}`,
        `args=${options.args.join(' ').slice(0, 200)}`,
      );

      return pid;
    } catch (err) {
      // Startup failed — clean up the PID file
      await this.removePid(clawId).catch(() => {});
      this.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_SPAWN_FAILED,
        `claw=${clawId}`,
        `command=${options.command}`,
        `reason=${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  /**
   * Gracefully stop the process
   * SIGTERM → wait 5 seconds → SIGKILL
   * @returns whether the process was successfully stopped
   */
  async stop(clawId: string): Promise<boolean> {
    const pid = await this.readPid(clawId);
    if (!pid) {
      return false;
    }

    // Check whether the process is still running
    if (!this.isAlive(clawId)) {
      await this.removePid(clawId);
      this.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_STOP_STALE,
        `claw=${clawId}`,
        `pid=${pid}`,
      );
      return true;
    }

    let via = 'sigterm';
    try {
      // Send SIGTERM
      process.kill(pid, 'SIGTERM');

      // Wait for graceful shutdown
      await new Promise(resolve => setTimeout(resolve, SIGTERM_GRACE_MS));

      // Check whether still running
      if (this.isAlive(clawId)) {
        // Force kill
        process.kill(pid, 'SIGKILL');
        via = 'sigkill';
        this.audit.write(
          PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_KILL_ESCALATED,
          `claw=${clawId}`,
          `pid=${pid}`,
        );
      }

      await this.removePid(clawId);
      this.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_STOPPED,
        `claw=${clawId}`,
        `pid=${pid}`,
        `via=${via}`,
      );
      return true;
    } catch (err: any) {
      // Process no longer exists
      if (err.code === 'ESRCH') {
        await this.removePid(clawId);
        this.audit.write(
          PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_STOP_STALE,
          `claw=${clawId}`,
          `pid=${pid}`,
          `via=esrch`,
        );
        return true;
      }
      this.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_STOP_FAILED,
        `claw=${clawId}`,
        `pid=${pid}`,
        `via=${via}`,
        `reason=${err.code || err.message}`,
      );
      return false;
    }
  }

  /**
   * Find processes matching a pattern (pgrep -f pattern)
   * Encapsulates platform-specific process finding
   */
  /**
   * Write current process PID to the pid file
   */
  async selfWritePid(clawId: string): Promise<void> {
    try {
      await this.ensureStatusDir(clawId);
      const pidFile = this.getPidFile(clawId);
      await this.fs.writeAtomic(pidFile, String(process.pid));
      this.audit.write(PROCESS_MANAGER_AUDIT_EVENTS.PID_WRITE_OK, `claw=${clawId}`, `pid=${process.pid}`);
    } catch (e: any) {
      this.audit.write(PROCESS_MANAGER_AUDIT_EVENTS.PID_WRITE_FAILED, `claw=${clawId}`, `reason=${e?.message ?? String(e)}`);
      throw e;
    }
  }

  /**
   * Remove the pid file only if it contains the current process PID
   */
  async selfRemovePid(clawId: string): Promise<void> {
    const storedPid = await this.readPid(clawId);
    if (storedPid === process.pid) {
      await this.removePid(clawId);
    }
  }

  findProcesses(pattern: string): number[] {
    // Escape POSIX ERE metacharacters — callers pass file paths which may
    // contain `(`, `)`, `[`, `]`, `+`, `?`, `.` etc. Without escaping,
    // pgrep treats them as regex, fails with exit 2 on invalid ERE, and
    // we silently return [] (orphan cleanup becomes a no-op).
    const escaped = pattern.replace(/[\\.^$*+?()[\]{}|]/g, '\\$&');
    let pids: number[];
    try {
      pids = pgrepSync(escaped);
    } catch (err) {
      if (err instanceof ProcessListUnavailable) {
        this.audit.write(
          PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_LIST_FAILED,
          `pattern=${pattern}`,
          `reason=${err.message}`,
        );
      }
      throw err;
    }
    return pids.filter(p => p !== process.pid);
  }

}
