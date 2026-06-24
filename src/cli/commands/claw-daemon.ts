/**
 * @module L6.CLI.Claw.Daemon
 * Start the Claw daemon (auto-backgrounds).
 *
 * Extracted from `cli/index.ts` action lambda (phase 1421) to:
 *  - restore SRP (action wrapper only wires CLI args)
 *  - enable processManager DI for tests (no vi.mock on dynamic await import)
 */

import { getWorkspaceRoot } from '../../core/claw-topology/claw-instance-paths.js';
import { resolveClawDaemonDir } from '../../core/claw-topology/index.js';
import * as path from 'path';
import { loadGlobalConfig, clawExists } from '../../assembly/config-load.js';
import { getClawDir, getClawConfigPath } from '../../foundation/config/index.js';
import { getGlobalConfigPath } from '../../assembly/global-config-path.js';
import { createSystemAudit } from '../../foundation/audit/index.js';
import { createAgentProcessManager } from '../../foundation/process-manager/index.js';
import { makeClawId } from '../../foundation/claw-identity/index.js';
import type { ProcessManager } from '../../foundation/process-manager/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { CliError } from '../errors.js';
import { resolveDaemonEntry } from '../../assembly/spawn-entry.js';
import { DAEMON_LOG } from '../../daemon/constants.js';

export type DaemonPM = Pick<ProcessManager, 'isAlive' | 'spawn'>;

export interface ClawDaemonDeps {
  fsFactory: (baseDir: string) => FileSystem;
  /** Test seam — when provided, skips real ProcessManager construction. */
  processManager?: DaemonPM;
}

export async function clawDaemonCommand(
  deps: ClawDaemonDeps,
  name: string,
): Promise<void> {
  loadGlobalConfig({ fsFactory: deps.fsFactory });
  const configPath = getClawConfigPath(name);
  if (!clawExists({ fsFactory: deps.fsFactory }, configPath)) {
    throw new CliError(`Claw "${name}" does not exist. Try \`chestnut claw list\` to see existing claws.`);
  }
  const clawDir = getClawDir(name);
  const baseDir = path.dirname(getGlobalConfigPath());
  const nodeFs = deps.fsFactory(baseDir);
  const systemAudit = createSystemAudit(nodeFs, baseDir);
  const pm: DaemonPM = deps.processManager
    ?? createAgentProcessManager({ fsFactory: deps.fsFactory }, systemAudit);
  if (pm.isAlive(resolveClawDaemonDir(makeClawId(name)))) {
    console.warn(`⚠ Claw "${name}" is already running`);
    return;
  }
  const daemonEntryPath = resolveDaemonEntry(nodeFs);
  const pid = await pm.spawn(resolveClawDaemonDir(makeClawId(name)), {
    command: 'node',
    args: [daemonEntryPath, name],
    logFile: path.join(clawDir, DAEMON_LOG),
    env: { ...process.env, CHESTNUT_ROOT: getWorkspaceRoot() } as Record<string, string | undefined>,
  });
  console.log(`Started Claw "${name}" (PID: ${pid})`);
}
