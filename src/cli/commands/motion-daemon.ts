/**
 * @module L6.CLI.Motion.Daemon
 * Start the Motion daemon (auto-backgrounds).
 *
 * Extracted from `cli/index.ts` action lambda (phase 1421) — sister of
 * `clawDaemonCommand`. See phase1421 PHASE1421.md §3-4 for root cause + design.
 */

import { getChestnutRoot } from '../../foundation/claw-identity/index.js';
import * as path from 'path';
import type { RootConfigReader } from '../../assembly/index.js';
import { getNamedSubrootDir } from '../../foundation/claw-identity/index.js';
import { actionAuditFor } from '../action-scope.js';
import { createAgentProcessManager } from '../../foundation/process-manager/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { createDaemonSpawnOptions } from '../../daemon/index.js';
import {
  resolveClawDaemonDir,
  MOTION_CLAW_ID,
  requireMotionAccess,
} from '../../core/claw-topology/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import type { DaemonPM } from './claw-daemon.js';
import { getCapturedCliMotionAccess } from '../motion-cli-guard.js';

interface MotionDaemonDeps {
  fsFactory: (baseDir: string) => FileSystem;
  rootConfig: Pick<RootConfigReader, 'loadGlobal'>;
  /** Test seam — when provided, skips real ProcessManager construction. */
  processManager?: DaemonPM;
}

export async function motionDaemonCommand(deps: MotionDaemonDeps, extraDeps?: { audit?: AuditLog }): Promise<void> {
  requireMotionAccess(getCapturedCliMotionAccess('start'), 'start', 'motion/daemon');
  deps.rootConfig.loadGlobal();
  const motionDir = getNamedSubrootDir('motion');
  // Motion-only callsite: motionDir = <chestnutRoot>/motion → dirname 一层即 chestnutRoot
  const baseDir = path.dirname(motionDir);
  const systemAudit = actionAuditFor(baseDir, deps);
  const pm: DaemonPM = deps.processManager
    ?? createAgentProcessManager({ fsFactory: deps.fsFactory, baseDir }, systemAudit);
  // Phase 1464 Step B: spawn specification 归 Daemon 唯一 owner
  const outcome = await pm.ensureRunning(resolveClawDaemonDir(
    MOTION_CLAW_ID,
    getCapturedCliMotionAccess('start'),
    'start',
  ), createDaemonSpawnOptions({
    clawId: MOTION_CLAW_ID,
    agentDir: motionDir,
    chestnutRoot: getChestnutRoot(),
  }));
  if (outcome.kind !== 'spawned') {
    console.warn('⚠ Motion is already running');
    return;
  }
  const pid = outcome.pid;
  // phase 1452 Step B: spawn 成功侧 emit（claw-daemon 同型）；失败侧由 PM 承载
  extraDeps?.audit?.write(CLI_AUDIT_EVENTS.MOTION_DAEMON_START, `pid=${pid}`);
  console.log(`Started Motion daemon (PID: ${pid})`);
}
