/**
 * @module L2.ProcessManager
 *
 * ProcessManager - Claw process manager (thin orchestrator / phase 497 splitter)
 *
 * Manages daemon process startup, shutdown, and status checks.
 * Class facade preserved (9 public method) over 8 sub-modules via ProcessManagerContext.
 */

import * as path from 'path';

import type { FileSystem } from '../fs/types.js';
import type { AuditLog } from '../audit/index.js';
import type { ProcessStartTime } from '../process-exec/index.js';
import { isAlive as defaultL1IsAlive, spawnDetached as defaultSpawnDetached, getProcessStartTime as defaultGetProcessStartTime, kill as defaultKill } from '../process-exec/index.js';

import * as pidOps from './pid.js';
import * as aliveOps from './alive.js';
import * as readyOps from './ready.js';
import * as lockOps from './lock.js';
import { spawnProcess } from './spawn.js';
import { stopProcess } from './stop.js';
import { findProcesses } from './find.js';
import { CLAWS_DIR } from '../../assembly/claw-dirs.js';
import type { ProcessManagerContext, SpawnOptions } from './types.js';


export { LockConflictError } from './types.js';
export type { SpawnOptions } from './types.js';
export { DAEMON_SHUTDOWN_GRACE_MS } from './constants.js';

export class ProcessManager {
  private readonly _ctx: ProcessManagerContext;
  protected readonly fs: FileSystem;

  constructor(
    fs: FileSystem,
    baseDir: string,
    audit: AuditLog,
    dirResolver?: (id: string) => string,
    l1IsAlive?: typeof defaultL1IsAlive,
    spawnDetached?: typeof defaultSpawnDetached,
    getProcessStartTime?: typeof defaultGetProcessStartTime,
    kill?: typeof defaultKill,
  ) {
    this.fs = fs;
    this._ctx = {
      fs,
      audit,
      resolveDir: dirResolver ?? ((id: string) => path.join(baseDir, CLAWS_DIR, id)),
      isAlive: (clawId: string) => this.isAlive(clawId),
      isReady: (clawId: string) => this.isReady(clawId),
      readLockPid: (clawId: string) => this.readLockPid(clawId),
      l1IsAlive,
      spawnDetached,
      getProcessStartTime,
      kill,
    };
  }

  // pid CRUD
  readPid(clawId: string): Promise<{ pid: number; startTime?: ProcessStartTime } | null> {
    return pidOps.readPid(this._ctx, clawId);
  }
  removePid(clawId: string): Promise<void> { return pidOps.removePid(this._ctx, clawId); }
  selfWritePid(clawId: string): Promise<void> { return pidOps.selfWritePid(this._ctx, clawId); }
  selfRemovePid(clawId: string): Promise<void> { return pidOps.selfRemovePid(this._ctx, clawId); }

  // alive
  getAliveStatus(clawId: string): { alive: boolean; reason: string; pid?: number } {
    return aliveOps.getAliveStatus(this._ctx, clawId);
  }
  isAlive(clawId: string): boolean { return aliveOps.isAliveByPidFile(this._ctx, clawId); }
  isReady(clawId: string): boolean { return readyOps.isReady(this._ctx, clawId); }
  markReady(clawId: string): Promise<void> { return readyOps.markReady(this._ctx, clawId); }
  markNotReady(clawId: string): Promise<void> { return readyOps.markNotReady(this._ctx, clawId); }

  // lock
  readLockPid(clawId: string): { pid: number; startTime?: ProcessStartTime } | null { return lockOps.readLockPid(this._ctx, clawId); }
  acquireLock(clawId: string): void { lockOps.acquireLock(this._ctx, clawId); }
  releaseLock(clawId: string): void { lockOps.releaseLock(this._ctx, clawId); }

  // lifecycle
  spawn(clawId: string, options: SpawnOptions): Promise<number> {
    return spawnProcess(this._ctx, clawId, options);
  }
  stop(clawId: string): Promise<boolean> { return stopProcess(this._ctx, clawId); }

  // query
  findProcesses(pattern: string): number[] { return findProcesses(this._ctx, pattern); }
}
