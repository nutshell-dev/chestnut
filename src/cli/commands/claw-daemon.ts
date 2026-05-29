/**
 * @module L6.CLI.Claw.Daemon
 * Start the Claw daemon (auto-backgrounds).
 *
 * Extracted from `cli/index.ts` action lambda (phase 1421) to:
 *  - restore SRP (action wrapper only wires CLI args)
 *  - enable processManager DI for tests (no vi.mock on dynamic await import)
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  loadGlobalConfig, clawExists, getClawDir, getGlobalConfigPath,
} from '../../foundation/config/index.js';
import { CONFIG_DEFAULTS } from '../../assembly/index.js';
import { createSystemAudit } from '../../foundation/audit/index.js';
import { createAgentProcessManager } from '../../foundation/process-manager/agent-factory.js';
import type { ProcessManager } from '../../foundation/process-manager/manager.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import { CliError } from '../errors.js';
import { makeClawId } from '../../foundation/identity/index.js';
import { getWorkspaceRoot } from '../../foundation/paths.js';
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
  loadGlobalConfig({ fsFactory: deps.fsFactory }, CONFIG_DEFAULTS);
  if (!clawExists({ fsFactory: deps.fsFactory }, name)) {
    throw new CliError(`Claw "${name}" does not exist. Try \`clawforum claw list\` to see existing claws.`);
  }
  const clawDir = getClawDir(name);
  const baseDir = path.dirname(getGlobalConfigPath());
  const nodeFs = deps.fsFactory(baseDir);
  const systemAudit = createSystemAudit(nodeFs, baseDir);
  const pm: DaemonPM = deps.processManager
    ?? createAgentProcessManager({ fsFactory: deps.fsFactory }, systemAudit);
  if (pm.isAlive(makeClawId(name))) {
    console.warn(`⚠ Claw "${name}" is already running`);
    return;
  }
  // bundle layout: daemon-entry.js sits next to cli/index.js (one level above commands/)
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const cliDir = path.dirname(thisDir);
  const bundleEntry = path.join(cliDir, 'daemon-entry.js');
  const bundleFs = deps.fsFactory(cliDir);
  const relBundle = path.relative(cliDir, bundleEntry);
  const daemonEntryPath = bundleFs.existsSync(relBundle)
    ? bundleEntry
    : path.resolve(cliDir, '..', 'daemon-entry.js');
  const pid = await pm.spawn(makeClawId(name), {
    command: 'node',
    args: [daemonEntryPath, name],
    logFile: path.join(clawDir, DAEMON_LOG),
    env: { ...process.env, CLAWFORUM_ROOT: getWorkspaceRoot() } as Record<string, string | undefined>,
  });
  console.log(`Started Claw "${name}" (PID: ${pid})`);
}
