/**
 * @module L6.CLI.Claw.Stop
 * Stop the Claw daemon process
 */

import { loadGlobalConfig, clawExists } from '../../assembly/config/config-load.js';
import { getClawConfigPath } from '../../core/claw-topology/index.js';
import { CliError } from '../errors.js';
import { createProcessManagerForCLI, signalCleanStop, clearCleanStop } from '../../foundation/process-manager/index.js';
import { makeClawId } from '../../foundation/claw-identity/index.js';
import { resolveClawDaemonDir } from '../../core/claw-topology/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { getChestnutRoot } from '../../core/claw-topology/index.js';
import { makeChestnutRoot } from '../../core/claw-topology/index.js';

export async function stopCommand(deps: { fsFactory: (baseDir: string) => FileSystem }, name: string, extraDeps?: { audit?: AuditLog }): Promise<void> {
  const audit = extraDeps?.audit;
  loadGlobalConfig(deps);

  const configPath = getClawConfigPath(name);
  if (!clawExists(deps, configPath)) {
    throw new CliError(`Claw "${name}" does not exist`);
  }

  const processManager = createProcessManagerForCLI({ ...deps, baseDir: getChestnutRoot() });
  const daemonDir = resolveClawDaemonDir(makeClawId(name));

  // Check if running
  if (!processManager.isAlive(daemonDir)) {
    console.log(`Claw "${name}" is not running`);
    return;
  }

  console.log(`Stopping Claw "${name}"...`);

  // phase 287 Step B: use signalCleanStop SoT (M#1 共用基础设施单源)
  // phase 2 γ4 anchor 保: clean-stop marker BEFORE stop so watchdog can distinguish
  // intentional user stop from unexpected crash (CrashClass active_user_stopped vs active_unexpected).
  // phase 694: signalCleanStop 改 take daemonDir 直接、PM 不再持 chestnut 拓扑。
  const chestnutRoot = makeChestnutRoot(getChestnutRoot());
  const rootFs = deps.fsFactory(chestnutRoot);
  try {
    await signalCleanStop(rootFs, daemonDir, audit);
  } catch (err) {
    audit?.write(CLI_AUDIT_EVENTS.CLAW_STOP, `name=${name}`, `status=clean_stop_marker_failed`, `error=${String(err)}`);
  }

  const success = await processManager.stop(daemonDir);
  if (success) {
    audit?.write(CLI_AUDIT_EVENTS.CLAW_STOP, `name=${name}`, `status=success`);
    console.log(`✓ Stopped Claw "${name}"`);
  } else {
    audit?.write(CLI_AUDIT_EVENTS.CLAW_STOP, `name=${name}`, `status=failed`);
    // phase 1124 P1-18: stop 失败 → 清残留 marker，防后续真崩溃被误判 active_user_stopped
    // （γ4 anchor 不动：stopping 窗口内 marker 仍在；stop 成功路径 marker 保留）
    try {
      await clearCleanStop(rootFs, daemonDir, audit);
    } catch { /* silent: marker 清理 best-effort，残留仅次启动 spurious ungraceful warn */ }
    throw new CliError(`Failed to stop Claw "${name}"`);
  }
}
