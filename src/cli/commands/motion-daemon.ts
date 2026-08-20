/**
 * @module L6.CLI.Motion.Daemon
 * Start the Motion daemon (auto-backgrounds).
 *
 * Extracted from `cli/index.ts` action lambda (phase 1421) — sister of
 * `clawDaemonCommand`. See phase1421 PHASE1421.md §3-4 for root cause + design.
 */

import { getWorkspaceRoot } from '../../core/claw-topology/index.js';
import * as path from 'path';
import type { RootConfigReader } from '../../assembly/index.js';
import { getNamedSubrootDir } from '../../core/claw-topology/index.js';
import { createSystemAudit } from '../../foundation/audit/index.js';
import { createAgentProcessManager } from '../../foundation/process-manager/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { resolveDaemonEntry } from '../../daemon/index.js';
import { DAEMON_LOG } from '../../daemon/index.js';
import { resolveClawDaemonDir, MOTION_CLAW_ID } from '../../core/claw-topology/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import type { DaemonPM } from './claw-daemon.js';

interface MotionDaemonDeps {
  fsFactory: (baseDir: string) => FileSystem;
  rootConfig: Pick<RootConfigReader, 'loadGlobal'>;
  /** Test seam — when provided, skips real ProcessManager construction. */
  processManager?: DaemonPM;
}

export async function motionDaemonCommand(deps: MotionDaemonDeps, extraDeps?: { audit?: AuditLog }): Promise<void> {
  deps.rootConfig.loadGlobal();
  const motionDir = getNamedSubrootDir('motion');
  // Motion-only callsite: motionDir = <chestnutRoot>/motion → dirname 一层即 chestnutRoot
  const baseDir = path.dirname(motionDir);
  const nodeFs = deps.fsFactory(baseDir);
  const systemAudit = createSystemAudit(nodeFs, baseDir);
  const pm: DaemonPM = deps.processManager
    ?? createAgentProcessManager({ fsFactory: deps.fsFactory, baseDir }, systemAudit);
  if (pm.getAliveStatus(resolveClawDaemonDir(MOTION_CLAW_ID)).alive) {
    console.warn('⚠ Motion is already running');
    return;
  }
  const daemonEntryPath = resolveDaemonEntry();
  const pid = await pm.spawn(resolveClawDaemonDir(MOTION_CLAW_ID), {
    command: 'node',
    args: [daemonEntryPath, MOTION_CLAW_ID],
    logFile: path.join(motionDir, DAEMON_LOG),
    env: { ...process.env, CHESTNUT_ROOT: getWorkspaceRoot() } as Record<string, string | undefined>,
  });
  // phase 1452 Step B: spawn 成功侧 emit（claw-daemon 同型）；失败侧由 PM 承载
  extraDeps?.audit?.write(CLI_AUDIT_EVENTS.MOTION_DAEMON_START, `pid=${pid}`);
  console.log(`Started Motion daemon (PID: ${pid})`);
}
