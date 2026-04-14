/**
 * ProcessManager - Claw process manager
 *
 * Manages daemon process startup, shutdown, and status checks
 */

// TODO(phase3): zombie process detection - MVP uses `ps` command to detect zombies, TS only uses kill(0), macOS/Linux behavior differs

import { spawn, execSync, spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';
import { openSync, mkdirSync, closeSync } from 'fs';

import type { IFileSystem } from '../fs/types.js';
import {
  PROCESS_SPAWN_CONFIRM_MS,
  SIGTERM_GRACE_MS,
  RESTART_DELAY_MS,
} from '../../constants.js';

export interface ProcessStatus {
  pid: number;
  startedAt: string;
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
  private fs: IFileSystem;
  private baseDir: string;
  private resolveDir: (id: string) => string;

  constructor(fs: IFileSystem, baseDir: string, dirResolver?: (id: string) => string) {
    this.fs = fs;
    this.baseDir = baseDir;
    this.resolveDir = dirResolver ?? ((id: string) => path.join(baseDir, 'claws', id));
  }

  /**
   * Get the status directory path for a claw
   */
  private getStatusDir(clawId: string): string {
    return path.join(this.resolveDir(clawId), 'status');
  }

  /**
   * Get the pid file path
   */
  private getPidFile(clawId: string): string {
    return path.join(this.getStatusDir(clawId), 'pid');
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
  private async readPid(clawId: string): Promise<number | null> {
    try {
      const pidFile = this.getPidFile(clawId);
      const content = await this.fs.read(pidFile);
      const pid = parseInt(content.trim(), 10);
      return isNaN(pid) ? null : pid;
    } catch (err: any) {
      // ENOENT/FS_NOT_FOUND is expected (process not running); other errors should be logged
      if (err?.code !== 'ENOENT' && err?.code !== 'FS_NOT_FOUND') {
        console.warn(`[ProcessManager] Failed to read PID for ${clawId}:`, err?.message || err);
      }
      return null;
    }
  }

  /**
   * Write the pid file
   */
  private async writePid(clawId: string, pid: number): Promise<void> {
    await this.ensureStatusDir(clawId);
    const pidFile = this.getPidFile(clawId);
    await this.fs.writeAtomic(pidFile, String(pid));
  }

  /**
   * Delete the pid file
   */
  private async removePid(clawId: string): Promise<void> {
    try {
      const pidFile = this.getPidFile(clawId);
      await this.fs.delete(pidFile);
    } catch (err: any) {
      // Ignore file-not-found (ENOENT or NodeFileSystem's FS_NOT_FOUND)
      if (err.code !== 'ENOENT' && err.code !== 'FS_NOT_FOUND') {
        console.warn(`[ProcessManager] Failed to remove PID file for ${clawId}:`, err);
      }
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
   * Spawn the daemon process
   * @param clawId process ID
   * @param clawDir working directory
   * @param args optional spawn arguments (defaults to starting the claw daemon)
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
    try {
      const pids = this.findProcesses(pattern);
      let sentAny = false;
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGTERM');
          sentAny = true;
        } catch (err: any) {
          if (err?.code !== 'ESRCH') {
            console.warn(`[process] Failed to SIGTERM PID ${pid}: ${err?.message}`);
          }
        }
      }
      if (sentAny) {
        await new Promise(resolve => setTimeout(resolve, SIGTERM_GRACE_MS));
      }
    } catch { /* pgrep returns exit code 1 when no match found */ }

    // Check and clean up the old daemon's lockfile
    const lockFile = path.join(this.getStatusDir(clawId), 'daemon.lock');
    try {
      const lockContent = this.fs.readSync(lockFile);
      const lockPid = parseInt(lockContent.trim(), 10);
      if (!isNaN(lockPid)) {
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
              console.warn(`[process] Failed to SIGTERM lock PID ${lockPid}: ${err?.message}`);
            }
          }
        }
      }
      // Clean up stale lockfile (not-found is normal on first run)
      try { await this.fs.delete(lockFile); } catch (err: any) {
        if (err?.code !== 'ENOENT' && err?.code !== 'FS_NOT_FOUND') {
          console.warn(`[process] Failed to delete lockfile ${lockFile}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch { /* lockfile does not exist, this is normal */ }
    
    // Exclusively create the PID file (avoid race conditions)
    const pidFile = this.getPidFile(clawId);
    await this.ensureStatusDir(clawId);
    
    try {
      // 'wx' = write + exclusive, throws EEXIST if the file already exists
      const handle = await fs.open(pidFile, 'wx');
      await handle.close(); // Close the handle; actual PID will be written with writeFile later
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
          console.warn(`[ProcessManager] Empty PID file for "${clawId}", possible concurrent spawn`);
        }
        // 清理陈旧文件并重建
        await this.removePid(clawId).catch(() => {});
        const handle = await fs.open(pidFile, 'wx');
        await handle.close();
      } else {
        throw err;
      }
    }

    // Ensure log directory exists and open log file
    mkdirSync(path.dirname(options.logFile), { recursive: true });
    const logFd = openSync(options.logFile, 'a');

    try {
      const proc = spawn(options.command, options.args, {
        detached: true,
        stdio: ['ignore', logFd, logFd],  // stdout + stderr → daemon.log
        env: options.env ?? process.env as Record<string, string | undefined>,
        ...(options.cwd ? { cwd: options.cwd } : {}),
      });
      
      // Let the child process run independently, without blocking the parent from exiting
      proc.unref();

      const pid = proc.pid;
      if (!pid) {
        throw new Error('Failed to spawn daemon process');
      }

      // Write the pid file
      await fs.writeFile(pidFile, String(pid), 'utf-8');

      // Poll until alive or timeout (handles slow ESM startup on constrained servers).
      // Always checks at least once; retries every 50ms up to PROCESS_SPAWN_CONFIRM_MS total.
      let alive = this.isAlive(clawId);
      const deadline = Date.now() + PROCESS_SPAWN_CONFIRM_MS;
      while (!alive && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
        alive = this.isAlive(clawId);
      }
      if (!alive) {
        throw new Error(`Process "${clawId}" failed to start. Check logs at: ${options.logFile}`);
      }

      return pid;
    } catch (err) {
      // Startup failed — clean up the PID file
      await this.removePid(clawId).catch(() => {});
      throw err;
    } finally {
      // Design doc: ensure logFd is closed in all paths
      closeSync(logFd);
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
      }

      await this.removePid(clawId);
      return true;
    } catch (err: any) {
      // Process no longer exists
      if (err.code === 'ESRCH') {
        await this.removePid(clawId);
        return true;
      }
      return false;
    }
  }

  /**
   * Restart the daemon process
   * @param clawId process ID
   * @param clawDir working directory
   * @param args optional spawn arguments
   * @returns new process PID
   */
  async restart(clawId: string, options: SpawnOptions): Promise<number> {
    await this.stop(clawId);
    // Brief wait to ensure resources such as ports are released
    await new Promise(resolve => setTimeout(resolve, RESTART_DELAY_MS));
    const pid = await this.spawn(clawId, options);
    return pid;
  }

  /**
   * Find processes matching a pattern (pgrep -f pattern)
   * Encapsulates platform-specific process finding
   */
  findProcesses(pattern: string): number[] {
    try {
      const result = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf-8' });
      const output = (result.status === 0 || result.status === 1) ? (result.stdout ?? '') : '';
      return output.trim().split('\n')
        .map(s => parseInt(s, 10))
        .filter(p => !isNaN(p) && p !== process.pid);
    } catch {
      return [];
    }
  }

  /**
   * List all running Claws
   * @returns list of running claw IDs
   */
  async listRunning(): Promise<string[]> {
    try {
      const clawsDir = path.join(this.baseDir, 'claws');
      const entries = await this.fs.list(clawsDir, { includeDirs: true });
      const running: string[] = [];

      for (const entry of entries) {
        if (entry.isDirectory) {
          const clawId = entry.name;
          if (this.isAlive(clawId)) {
            running.push(clawId);
          }
        }
      }

      return running;
    } catch (err) {
      console.warn('[process] listRunning failed:', err);
      return [];
    }
  }
}
