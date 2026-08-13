/**
 * @module L6.CLI.Claw.Daemon
 * Start the Claw daemon (auto-backgrounds).
 *
 * Extracted from `cli/index.ts` action lambda (phase 1421) to:
 *  - restore SRP (action wrapper only wires CLI args)
 *  - enable processManager DI for tests (no vi.mock on dynamic await import)
 */

import { getWorkspaceRoot } from '../../core/claw-topology/index.js';
import { resolveClawDaemonDir } from '../../core/claw-topology/index.js';
import * as path from 'path';
import { getChestnutRoot, getClawDir, getClawConfigPath } from '../../core/claw-topology/index.js';
import { createSystemAudit } from '../../foundation/audit/index.js';
import { createAgentProcessManager } from '../../foundation/process-manager/index.js';
import { makeClawId } from '../../foundation/claw-identity/index.js';
import type { ProcessManager } from '../../foundation/process-manager/index.js';
import { CliError } from '../errors.js';
import { resolveDaemonEntry } from '../../daemon/index.js';
import { DAEMON_LOG } from '../../daemon/index.js';
import type { ClawCommandDeps } from './claw-command-deps.js';

export type DaemonPM = Pick<ProcessManager, 'getAliveStatus' | 'spawn'>;

export interface ClawDaemonDeps extends ClawCommandDeps {
  /** Test seam — when provided, skips real ProcessManager construction. */
  processManager?: DaemonPM;
}

export async function clawDaemonCommand(
  deps: ClawDaemonDeps,
  name: string,
): Promise<void> {
  deps.rootConfig.loadGlobal();
  const configPath = getClawConfigPath(name);
  if (deps.rootConfig.loadClaw(configPath) === undefined) {
    throw new CliError(`Claw "${name}" does not exist. Try \`chestnut claw list\` to see existing claws.`);
  }
  const clawDir = getClawDir(name);
  const baseDir = getChestnutRoot();
  const nodeFs = deps.fsFactory(baseDir);
  const systemAudit = createSystemAudit(nodeFs, baseDir);
  const pm: DaemonPM = deps.processManager
    ?? createAgentProcessManager({ fsFactory: deps.fsFactory, baseDir }, systemAudit);
  if (pm.getAliveStatus(resolveClawDaemonDir(makeClawId(name))).alive) {
    console.warn(`⚠ Claw "${name}" is already running`);
    return;
  }
  const daemonEntryPath = resolveDaemonEntry();
  const pid = await pm.spawn(resolveClawDaemonDir(makeClawId(name)), {
    command: 'node',
    args: [daemonEntryPath, name],
    logFile: path.join(clawDir, DAEMON_LOG),
    env: { ...process.env, CHESTNUT_ROOT: getWorkspaceRoot() } as Record<string, string | undefined>,
  });
  console.log(`Started Claw "${name}" (PID: ${pid})`);
}
