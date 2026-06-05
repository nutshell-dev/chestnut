/**
 * @module L6.CLI.Claw.Stop
 * Stop the Claw daemon process
 */

import {
  loadGlobalConfig, clawExists, getClawDir,
} from '../../foundation/config/index.js';
import { CliError } from '../errors.js';
import { createProcessManagerForCLI } from '../../foundation/process-manager/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import { makeClawId } from '../../foundation/paths.js';
import type { FileSystem } from '../../foundation/fs/types.js';

export async function stopCommand(deps: { fsFactory: (baseDir: string) => FileSystem }, name: string, extraDeps?: { audit?: AuditLog }): Promise<void> {
  const audit = extraDeps?.audit;
  loadGlobalConfig(deps);

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

  // phase 2 γ4: write clean-stop marker BEFORE stop so watchdog can distinguish
  // intentional user stop from unexpected crash (CrashClass active_user_stopped vs active_unexpected).
  // Atomic tmp+rename (mirror stopAllCommand phase 1024 G.1 pattern / 防 torn-write).
  try {
    const clawFs = deps.fsFactory(getClawDir(name));
    const tmpFile = `clean-stop.${process.pid}.${Date.now()}.tmp`;
    clawFs.writeAtomicSync(tmpFile, String(Date.now()));
    clawFs.moveSync(tmpFile, 'clean-stop');
  } catch {
    // silent: marker 写失败 best-effort / watchdog 缺 marker 视同 unexpected (false-positive 单次容忍)
  }

  const success = await processManager.stop(makeClawId(name));
  if (success) {
    audit?.write(CLI_AUDIT_EVENTS.CLAW_STOP, `name=${name}`, `status=success`);
    console.log(`✓ Stopped Claw "${name}"`);
  } else {
    audit?.write(CLI_AUDIT_EVENTS.CLAW_STOP, `name=${name}`, `status=failed`);
    throw new CliError(`Failed to stop Claw "${name}"`);
  }
}
