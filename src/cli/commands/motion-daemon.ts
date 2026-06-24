/**
 * @module L6.CLI.Motion.Daemon
 * Start the Motion daemon (auto-backgrounds).
 *
 * Extracted from `cli/index.ts` action lambda (phase 1421) — sister of
 * `clawDaemonCommand`. See phase1421 PHASE1421.md §3-4 for root cause + design.
 */

import { getWorkspaceRoot } from '../../core/claw-topology/claw-instance-paths.js';
import * as path from 'path';
import { loadGlobalConfig } from '../../assembly/config-load.js';
import { getNamedSubrootDir } from '../../foundation/config/index.js';
import { createSystemAudit } from '../../foundation/audit/index.js';
import { createAgentProcessManager } from '../../foundation/process-manager/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { resolveDaemonEntry } from '../../assembly/spawn-entry.js';
import { DAEMON_LOG } from '../../daemon/constants.js';
import { resolveClawDaemonDir, MOTION_CLAW_ID } from '../../core/claw-topology/index.js';
import type { DaemonPM } from './claw-daemon.js';

interface MotionDaemonDeps {
  fsFactory: (baseDir: string) => FileSystem;
  /** Test seam — when provided, skips real ProcessManager construction. */
  processManager?: DaemonPM;
}

export async function motionDaemonCommand(deps: MotionDaemonDeps): Promise<void> {
  loadGlobalConfig({ fsFactory: deps.fsFactory });
  const motionDir = getNamedSubrootDir('motion');
  // Motion-only callsite: motionDir = <chestnutRoot>/motion → dirname 一层即 chestnutRoot
  const baseDir = path.dirname(motionDir);
  const nodeFs = deps.fsFactory(baseDir);
  const systemAudit = createSystemAudit(nodeFs, baseDir);
  const pm: DaemonPM = deps.processManager
    ?? createAgentProcessManager({ fsFactory: deps.fsFactory }, systemAudit);
  if (pm.isAlive(resolveClawDaemonDir(MOTION_CLAW_ID))) {
    console.warn('⚠ Motion is already running');
    return;
  }
  const daemonEntryPath = resolveDaemonEntry(nodeFs);
  const pid = await pm.spawn(resolveClawDaemonDir(MOTION_CLAW_ID), {
    command: 'node',
    args: [daemonEntryPath, MOTION_CLAW_ID],
    logFile: path.join(motionDir, DAEMON_LOG),
    env: { ...process.env, CHESTNUT_ROOT: getWorkspaceRoot() } as Record<string, string | undefined>,
  });
  console.log(`Started Motion daemon (PID: ${pid})`);
}
