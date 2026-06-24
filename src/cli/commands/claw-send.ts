/**
 * @module L6.CLI.Claw.Send
 * Send an inbox message to a Claw
 */

import * as path from 'path';

import { loadGlobalConfig, clawExists } from '../../assembly/config-load.js';
import { getClawConfigPath } from '../../core/claw-topology/claw-instance-paths.js';
import { getGlobalConfigPath } from '../../assembly/global-config-path.js';
import { CliError } from '../errors.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { routeNotifyClaw } from '../../core/claw-topology/index.js';
import { formatClawStatusHint, formatNoActiveContractHint } from './claw-shared.js';
import { createSystemAudit } from '../../foundation/audit/index.js';
import { CLAWS_DIR } from '../../core/claw-topology/claw-instance-paths.js';
import { createProcessManagerForCLI } from '../../foundation/process-manager/index.js';
import { resolveClawDaemonDir, MOTION_CLAW_ID } from '../../core/claw-topology/index.js';
import { makeClawId } from '../../foundation/claw-identity/index.js';

export async function sendCommand(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  name: string, 
  message: string, 
  options?: { priority?: 'critical' | 'high' | 'normal' | 'low' }
): Promise<void> {
  loadGlobalConfig(deps);
  
  const configPath = getClawConfigPath(name);
  if (!clawExists(deps, configPath)) {
    throw new CliError(`Claw "${name}" does not exist`);
  }

  const globalConfigPath = getGlobalConfigPath();
  const baseDir = path.dirname(globalConfigPath);
  const clawDir = path.join(baseDir, CLAWS_DIR, name);
  const fileSystem = deps.fsFactory(baseDir);
  const audit = createSystemAudit(fileSystem, clawDir);

  routeNotifyClaw(fileSystem, baseDir, MOTION_CLAW_ID, name, {
    type: 'user_inbox_message',
    source: 'user',
    priority: options?.priority ?? 'normal',
    body: message,
  }, audit);

  console.log(`Message sent to "${name}"`);

  const processManager = createProcessManagerForCLI({ ...deps });
  const isAlive = processManager.isAlive(resolveClawDaemonDir(makeClawId(name)));
  const statusHint = formatClawStatusHint(name, isAlive);
  if (statusHint) console.log(statusHint);

  // phase 241: active contract hint — no active contract → remind caller
  const clawFs = deps.fsFactory(clawDir);
  let hasContract = false;
  try {
    const entries = clawFs.listSync(path.join('contract', 'active'), { includeDirs: true });
    hasContract = entries.some(e => e.isDirectory);
  } catch {
    // silent: contract dir scan failure is legitimate → treat as no active contract
    hasContract = false;
  }
  const contractHint = formatNoActiveContractHint(name, hasContract);
  if (contractHint) console.log(contractHint);
}
