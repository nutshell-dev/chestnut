/**
 * @module L6.CLI.Claw.Stop
 * Stop the Claw daemon process
 */

import {
  loadGlobalConfig, clawExists,
} from '../../foundation/config/index.js';
import { CONFIG_DEFAULTS } from '../../assembly/index.js';
import { CliError } from '../errors.js';
import { createProcessManagerForCLI } from '../../foundation/process-manager/factories.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import { makeClawId } from '../../foundation/identity/index.js';
import type { FileSystem } from '../../foundation/fs/types.js';

export async function stopCommand(deps: { fsFactory: (baseDir: string) => FileSystem }, name: string, extraDeps?: { audit?: AuditLog }): Promise<void> {
  const audit = extraDeps?.audit;
  loadGlobalConfig(deps, CONFIG_DEFAULTS);
  
  if (!clawExists(deps, name)) {
    throw new CliError(`Claw "${name}" does not exist`);
  }

  const processManager = createProcessManagerForCLI(deps);

  // Check if running
  if (!processManager.isAlive(makeClawId(name))) {
    console.log(`Claw "${name}" is not running`);
    return;
  }

  console.log(`Stopping Claw "${name}"...`);

  const success = await processManager.stop(makeClawId(name));
  if (success) {
    audit?.write(CLI_AUDIT_EVENTS.CLAW_STOP, `name=${name}`, `status=success`);
    console.log(`✓ Stopped Claw "${name}"`);
  } else {
    audit?.write(CLI_AUDIT_EVENTS.CLAW_STOP, `name=${name}`, `status=failed`);
    throw new CliError(`Failed to stop Claw "${name}"`);
  }
}
