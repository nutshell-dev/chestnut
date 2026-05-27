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

import * as pidOps from './pid.js';
import * as aliveOps from './alive.js';
import * as readyOps from './ready.js';
import * as lockOps from './lock.js';
import { spawnProcess } from './spawn.js';
import { stopProcess } from './stop.js';
import { findProcesses } from './find.js';
import { CLAWS_DIR } from '../paths.js';
import type { ProcessManagerContext, SpawnOptions } from './types.js';
import type { ClawId } from '../identity/index.js';


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
  ) {
    this.fs = fs;
    this._ctx = {
      fs,
      audit,
      resolveDir: dirResolver ?? ((id: string) => path.join(baseDir, CLAWS_DIR, id)),
      isAlive: (clawId: ClawId) => this.isAlive(clawId),
      isReady: (clawId: ClawId) => this.isReady(clawId),
      readLockPid: (clawId: ClawId) => this.readLockPid(clawId),
    };
  }

  // pid CRUD
  readPid(clawId: ClawId): Promise<{ pid: number; startTime?: string } | null> {
    return pidOps.readPid(this._ctx, clawId);
  }
  removePid(clawId: ClawId): Promise<void> { return pidOps.removePid(this._ctx, clawId); }
  selfWritePid(clawId: ClawId): Promise<void> { return pidOps.selfWritePid(this._ctx, clawId); }
  selfRemovePid(clawId: ClawId): Promise<void> { return pidOps.selfRemovePid(this._ctx, clawId); }

  // alive
  getAliveStatus(clawId: ClawId): { alive: boolean; reason: string; pid?: number } {
    return aliveOps.getAliveStatus(this._ctx, clawId);
  }
  isAlive(clawId: ClawId): boolean { return aliveOps.isAliveByPidFile(this._ctx, clawId); }
  isReady(clawId: ClawId): boolean { return readyOps.isReady(this._ctx, clawId); }
  markReady(clawId: ClawId): Promise<void> { return readyOps.markReady(this._ctx, clawId); }
  markNotReady(clawId: ClawId): Promise<void> { return readyOps.markNotReady(this._ctx, clawId); }

  // lock
  readLockPid(clawId: ClawId): { pid: number; startTime?: string } | null { return lockOps.readLockPid(this._ctx, clawId); }
  acquireLock(clawId: ClawId): void { lockOps.acquireLock(this._ctx, clawId); }
  releaseLock(clawId: ClawId): void { lockOps.releaseLock(this._ctx, clawId); }

  // lifecycle
  spawn(clawId: ClawId, options: SpawnOptions): Promise<number> {
    return spawnProcess(this._ctx, clawId, options);
  }
  stop(clawId: ClawId): Promise<boolean> { return stopProcess(this._ctx, clawId); }

  // query
  findProcesses(pattern: string): number[] { return findProcesses(this._ctx, pattern); }
}
