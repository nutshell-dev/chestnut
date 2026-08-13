/**
 * @module L2a.ProcessManager
 *
 * ProcessManager - Daemon process manager (thin orchestrator / phase 497 splitter)
 *
 * Manages daemon process startup, shutdown, and status checks.
 * Class facade preserved over sub-modules via ProcessManagerContext.
 *
 * phase 694 L2a 真治：撤 ClawId / CLAWS_DIR import + ctor baseDir / dirResolver fallback。
 * API take daemonDir: DaemonDir per call、caller 必经 L4 ClawTopology
 * resolveClawDaemonDir(clawId) 算 daemonDir 再传入。PM 内部仅持 status/ 子目录
 * 命名 + file 名约定 schema、0 chestnut 拓扑知识。
 *
 * Phase 1204 Step E：删除 lock / legacy pidfile API；generation directory 是
 * 唯一权威。
 */

import type { FileSystem } from '../fs/index.js';
import type { DaemonDir } from './types.js';
import type { AuditLog } from '../audit/index.js';
import type { ProcessStartTime } from '../process-exec/index.js';
import { isAlive as defaultL1IsAlive, spawnDetached as defaultSpawnDetached, getProcessStartTime as defaultGetProcessStartTime, kill as defaultKill } from '../process-exec/index.js';

import * as aliveOps from './alive.js';
import * as readyOps from './ready.js';
import { spawnProcess } from './spawn.js';
import { ensureRunning as ensureRunningOp } from './ensure-running.js';
import { stopProcess } from './stop.js';
import { findProcesses } from './find.js';
import {
  activateGeneration,
  retireGeneration,
  writeReadyFact,
  inspectSpawning,
  inspectSpawningPid,
  hasStopIntentForGeneration,
  type ActivateGeneration,
  type RetireGeneration,
  type ProcessGenerationRecord,
  type WriteGenerationFact,
} from './generation.js';
import type { EnsureRunningOutcome, ProcessManagerContext, SpawnOptions } from './types.js';


export { ProcessGenerationStateError, ProcessSpawnConflictError, ProcessWinnerConvergenceError } from './types.js';
export type { EnsureRunningOutcome, ProcessSpawnConflictReason, ProcessWinnerConvergenceReason, SpawnOptions } from './types.js';
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
      isReady: (daemonDir: DaemonDir) => this.isReady(daemonDir),
      l1IsAlive,
      spawnDetached,
      getProcessStartTime,
      kill,
    };
  }

  // alive / ready
  getAliveStatus(daemonDir: DaemonDir): { alive: boolean; reason: string; pid?: number } {
    return aliveOps.getAliveStatus(this._ctx, daemonDir);
  }
  isReady(daemonDir: DaemonDir): boolean { return readyOps.isReady(this._ctx, daemonDir); }

  // generation (Phase 1204)
  inspectSpawning(daemonDir: DaemonDir): ReturnType<typeof inspectSpawning> { return inspectSpawning(this._ctx, daemonDir); }
  inspectSpawningPid(daemonDir: DaemonDir): ReturnType<typeof inspectSpawningPid> { return inspectSpawningPid(this._ctx, daemonDir); }
  writeGenerationReady(_daemonDir: DaemonDir, record: ProcessGenerationRecord, pid: number, startTime?: ProcessStartTime): Promise<WriteGenerationFact> {
    return writeReadyFact(this._ctx, record, pid, startTime);
  }
  activateGeneration(daemonDir: DaemonDir, identity: { generationId: string; pid: number; startTime?: ProcessStartTime }): ActivateGeneration {
    return activateGeneration(this._ctx, daemonDir, identity);
  }
  retireGeneration(daemonDir: DaemonDir, expected: { generationId: string }, reason: Parameters<typeof retireGeneration>[3], source: Parameters<typeof retireGeneration>[4]): RetireGeneration {
    return retireGeneration(this._ctx, daemonDir, expected, reason, source);
  }
  hasStopIntentForGeneration(daemonDir: DaemonDir, generationId: string): boolean {
    return hasStopIntentForGeneration(this._ctx, daemonDir, generationId);
  }

  // lifecycle
  spawn(daemonDir: DaemonDir, options: SpawnOptions): Promise<number> {
    return spawnProcess(this._ctx, daemonDir, options);
  }
  /**
   * Phase 1282 Step A: 「确保 daemon ready」单一能力，封装 precheck/spawn/conflict/join。
   * 调用方不得再组合 getAliveStatus+spawn（TOCTOU）；合法 conflict 自动 join exact winner。
   */
  ensureRunning(daemonDir: DaemonDir, options: SpawnOptions): Promise<EnsureRunningOutcome> {
    return ensureRunningOp(this._ctx, daemonDir, options);
  }
  stop(daemonDir: DaemonDir): Promise<boolean> { return stopProcess(this._ctx, daemonDir); }

  // query
  findProcesses(pattern: string): number[] { return findProcesses(this._ctx, pattern); }
}
