/**
 * @module L2a.ProcessManager
 *
 * ProcessManager - Daemon process manager (thin orchestrator / phase 497 splitter)
 *
 * Manages daemon process startup, shutdown, and status checks.
 * Class facade preserved (14 public method) over 8 sub-modules via ProcessManagerContext.
 *
 * phase 694 L2a 真治：撤 ClawId / CLAWS_DIR import + ctor baseDir / dirResolver fallback。
 * API take daemonDir: DaemonDir per call、caller 必经 L4 ClawTopology
 * resolveClawDaemonDir(clawId) 算 daemonDir 再传入。PM 内部仅持 status/ 子目录
 * 命名 + file 名约定 schema、0 chestnut 拓扑知识。
 */

import type { FileSystem } from '../fs/index.js';
import type { DaemonDir } from './types.js';
import type { AuditLog } from '../audit/index.js';
import type { ProcessStartTime } from '../process-exec/index.js';
import { isAlive as defaultL1IsAlive, spawnDetached as defaultSpawnDetached, getProcessStartTime as defaultGetProcessStartTime, kill as defaultKill } from '../process-exec/index.js';

import * as pidOps from './pid.js';
import { getPidFile } from './paths.js';
import * as aliveOps from './alive.js';
import * as readyOps from './ready.js';
import * as lockOps from './lock.js';
import { spawnProcess } from './spawn.js';
import { stopProcess } from './stop.js';
import { findProcesses } from './find.js';
import type { ProcessManagerContext, SpawnOptions } from './types.js';


export { LockConflictError } from './types.js';
export type { SpawnOptions } from './types.js';
export { DAEMON_SHUTDOWN_GRACE_MS } from './constants.js';

export class ProcessManager {
  private readonly _ctx: ProcessManagerContext;
  protected readonly fs: FileSystem;

  constructor(
    fs: FileSystem,
    audit: AuditLog,
    l1IsAlive?: typeof defaultL1IsAlive,
    spawnDetached?: typeof defaultSpawnDetached,
    getProcessStartTime?: typeof defaultGetProcessStartTime,
    kill?: typeof defaultKill,
  ) {
    this.fs = fs;
    this._ctx = {
      fs,
      audit,
      isAlive: (daemonDir: DaemonDir) => this.isAlive(daemonDir),
      isReady: (daemonDir: DaemonDir) => this.isReady(daemonDir),
      readLockPid: (daemonDir: DaemonDir) => this.readLockPid(daemonDir),
      l1IsAlive,
      spawnDetached,
      getProcessStartTime,
      kill,
    };
  }

  // pid CRUD
  readPid(daemonDir: DaemonDir): Promise<{ pid: number; startTime?: ProcessStartTime } | null> {
    return pidOps.readPid(this._ctx, daemonDir).then((result) => {
      if (result.status === 'valid') {
        return { pid: result.pid, startTime: result.startTime };
      }
      return null;
    });
  }
  removePid(daemonDir: DaemonDir): Promise<boolean> { return pidOps.removePid(this._ctx, daemonDir); }
  selfWritePid(daemonDir: DaemonDir): Promise<void> { return pidOps.selfWritePid(this._ctx, daemonDir); }
  selfRemovePid(daemonDir: DaemonDir): Promise<void> { return pidOps.selfRemovePid(this._ctx, daemonDir); }

  /** PID file 绝对路径（用于 file-watcher 监听 daemon liveness 等场景）. */
  getPidFilePath(daemonDir: DaemonDir): string { return getPidFile(this._ctx, daemonDir); }

  // alive
  getAliveStatus(daemonDir: DaemonDir): { alive: boolean; reason: string; pid?: number } {
    return aliveOps.getAliveStatus(this._ctx, daemonDir);
  }
  isAlive(daemonDir: DaemonDir): boolean { return aliveOps.isAliveByPidFile(this._ctx, daemonDir); }
  isReady(daemonDir: DaemonDir): boolean { return readyOps.isReady(this._ctx, daemonDir); }
  markReady(daemonDir: DaemonDir): Promise<void> { return readyOps.markReady(this._ctx, daemonDir); }
  markNotReady(daemonDir: DaemonDir): Promise<void> { return readyOps.markNotReady(this._ctx, daemonDir); }

  // lock
  readLockPid(daemonDir: DaemonDir): { pid: number; startTime?: ProcessStartTime } | null { return lockOps.readLockPid(this._ctx, daemonDir); }
  acquireLock(daemonDir: DaemonDir): void { lockOps.acquireLock(this._ctx, daemonDir); }
  releaseLock(daemonDir: DaemonDir): void { lockOps.releaseLock(this._ctx, daemonDir); }

  // lifecycle
  spawn(daemonDir: DaemonDir, options: SpawnOptions): Promise<number> {
    return spawnProcess(this._ctx, daemonDir, options);
  }
  stop(daemonDir: DaemonDir): Promise<boolean> { return stopProcess(this._ctx, daemonDir); }

  // query
  findProcesses(pattern: string): number[] { return findProcesses(this._ctx, pattern); }
}
