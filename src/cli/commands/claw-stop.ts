/**
 * @module L6.CLI.Claw.Stop
 * Stop the Claw daemon process
 */

import * as path from 'path';
import { makeAgentDirResolver } from '../../core/claw-topology/index.js';
import { loadGlobalConfig, clawExists } from '../../assembly/config-load.js';
import { getClawConfigPath } from '../../foundation/config/index.js';
import { CliError } from '../errors.js';
import { createProcessManagerForCLI, signalCleanStop } from '../../foundation/process-manager/index.js';
import { makeClawId } from '../../foundation/identity/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import { makeChestnutRoot, getChestnutRoot } from '../../foundation/install-paths.js';
import { CLAWS_DIR } from '../../foundation/claw-paths.js';

export async function stopCommand(deps: { fsFactory: (baseDir: string) => FileSystem }, name: string, extraDeps?: { audit?: AuditLog }): Promise<void> {
  const audit = extraDeps?.audit;
  loadGlobalConfig(deps);

  const configPath = getClawConfigPath(name);
  if (!clawExists(deps, configPath)) {
    throw new CliError(`Claw "${name}" does not exist`);
  }

  const processManager = createProcessManagerForCLI({ ...deps, resolveAgentDir: makeAgentDirResolver() });

  // Check if running
  if (!processManager.isAlive(makeClawId(name))) {
    console.log(`Claw "${name}" is not running`);
    return;
  }

  console.log(`Stopping Claw "${name}"...`);

  // phase 287 Step B: use signalCleanStop SoT (M#1 共用基础设施单源)
  // phase 2 γ4 anchor 保: clean-stop marker BEFORE stop so watchdog can distinguish
  // intentional user stop from unexpected crash (CrashClass active_user_stopped vs active_unexpected).
  try {
    const chestnutRoot = makeChestnutRoot(getChestnutRoot());
    const rootFs = deps.fsFactory(chestnutRoot);
    await signalCleanStop(rootFs, chestnutRoot, path.join(CLAWS_DIR, name), audit);
  } catch (err) {
    // best-effort: marker 写失败仍 stop / SoT 已 emit CLEAN_STOP_SIGNALED on success
    // outer audit emit on failure（防 watchdog 误判 crash 时无 trail）
    audit?.write(CLI_AUDIT_EVENTS.CLAW_STOP, `name=${name}`, `status=clean_stop_marker_failed`, `error=${String(err)}`);
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
