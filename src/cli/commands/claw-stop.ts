/**
 * @module L6.CLI.Claw.Stop
 * Stop the Claw daemon process
 */

import * as path from 'path';
import { CliError } from '../errors.js';
import { createProcessManagerForCLI, signalCleanStop, clearCleanStop } from '../../foundation/process-manager/index.js';
import { assertPublishedClaw } from './claw-target.js';
import { resolveClawDaemonDir } from '../../core/claw-topology/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import { getChestnutRoot } from '../../foundation/claw-identity/index.js';
import { makeChestnutRoot } from '../../foundation/claw-identity/index.js';
import type { ClawCommandDeps } from './claw-command-deps.js';
import { commitCleanStopMarker } from './clean-stop-marker.js';

export async function stopCommand(deps: ClawCommandDeps, name: string, extraDeps?: { audit?: AuditLog }): Promise<void> {
  const audit = extraDeps?.audit;
  deps.rootConfig.loadGlobal();

  const target = assertPublishedClaw(deps, name);

  const processManager = createProcessManagerForCLI({ ...deps, baseDir: getChestnutRoot() });
  const daemonDir = resolveClawDaemonDir(target.clawId);

  console.log(`Stopping Claw "${name}"...`);

  // phase 287 Step B: use signalCleanStop SoT (M#1 共用基础设施单源)
  // phase 2 γ4 anchor 保: clean-stop marker BEFORE stop so watchdog can distinguish
  // intentional user stop from unexpected crash (CrashClass active_user_stopped vs active_unexpected).
  // phase 694: signalCleanStop 改 take daemonDir 直接、PM 不再持 chestnut 拓扑。
  const chestnutRoot = makeChestnutRoot(getChestnutRoot());
  const rootFs = deps.fsFactory(chestnutRoot);
  const markerOutcome = await commitCleanStopMarker({
    scope: 'claw',
    path: path.join(daemonDir, 'clean-stop'),
    // signalCleanStop also writes audit after the rename; an audit exception can
    // therefore leave the marker committed, so the safe classification is unknown.
    onThrow: 'unknown',
    write: () => signalCleanStop(rootFs, daemonDir, audit),
  });
  const markerFailures: string[] = [];
  const stopErrors: unknown[] = [];
  if (markerOutcome.kind !== 'committed') {
    const markerError = markerOutcome.kind === 'not_attempted'
      ? { name: 'Error', message: 'marker write was not attempted' }
      : markerOutcome.error;
    markerFailures.push(
      `clean-stop marker ${markerOutcome.kind}: ${markerError.name}: ${markerError.message}`,
    );
    stopErrors.push(markerError);
    try {
      audit?.write(
        CLI_AUDIT_EVENTS.CLAW_STOP,
        `name=${name}`,
        `status=clean_stop_marker_${markerOutcome.kind}`,
        `path=${markerOutcome.path}`,
        `operation_id=${markerOutcome.operationId}`,
        `error=${markerError.name}: ${markerError.message}`,
      );
    } catch (err) {
      markerFailures.push(`clean-stop marker audit failed: ${String(err)}`);
      stopErrors.push(err);
    }
  }

  // phase 1769: typed outcome——按 discriminant 处理，不再由 boolean 反推终局
  const outcome = await processManager.stop(daemonDir);
  if (outcome.kind === 'stopped' || outcome.kind === 'intent_recorded') {
    if (markerFailures.length > 0) {
      throw new CliError(
        `Stopped Claw "${name}" without clean-stop proof: ${markerFailures.join('; ')}`,
        { code: 1, cause: new AggregateError(stopErrors) },
      );
    }
    audit?.write(CLI_AUDIT_EVENTS.CLAW_STOP, `name=${name}`, `status=success`);
    console.log(`✓ Stopped Claw "${name}"`);
    return;
  }
  if (outcome.kind === 'not_running') {
    if (markerFailures.length > 0) {
      throw new CliError(
        `Claw "${name}" is not running; clean-stop proof is unavailable: ${markerFailures.join('; ')}`,
        { code: 1, cause: new AggregateError(stopErrors) },
      );
    }
    // 无目标 generation 的幂等终局：非失败，不 throw
    audit?.write(CLI_AUDIT_EVENTS.CLAW_STOP, `name=${name}`, `status=not_running`);
    console.log(`Claw "${name}" is not running`);
    return;
  }
  // failed：保留 stage 与原始 reason 证据
  audit?.write(
    CLI_AUDIT_EVENTS.CLAW_STOP,
    `name=${name}`,
    `status=failed`,
    `stage=${outcome.stage}`,
    `reason=${outcome.reason}`,
  );
  // phase 1124 P1-18: stop 失败 → 清残留 marker，防后续真崩溃被误判 active_user_stopped
  // （γ4 anchor 不动：stopping 窗口内 marker 仍在；stop 成功路径 marker 保留）
  const cleanupFailures: string[] = [];
  try {
    await clearCleanStop(rootFs, daemonDir, audit);
  } catch (err) {
    cleanupFailures.push(`marker_cleanup_failed: ${String(err)}`);
    stopErrors.push(err);
    try {
      audit?.write(
        CLI_AUDIT_EVENTS.CLAW_STOP,
        `name=${name}`,
        `status=marker_cleanup_failed`,
        `error=${String(err)}`,
      );
    } catch (auditError) {
      cleanupFailures.push(`marker cleanup audit failed: ${String(auditError)}`);
      stopErrors.push(auditError);
    }
  }
  const details = [
    `stage=${outcome.stage}: ${outcome.reason}`,
    ...markerFailures,
    ...cleanupFailures,
  ];
  throw new CliError(`Failed to stop Claw "${name}" (${details.join('; ')})`, {
    code: 1,
    cause: new AggregateError(stopErrors),
  });
}
