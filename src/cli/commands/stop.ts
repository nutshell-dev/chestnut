/**
 * stop command - Stop all chestnut processes
 */

import * as path from 'path';
import { formatErr } from "../../foundation/node-utils/index.js";
import type { RootConfigReader } from '../../assembly/index.js';
import { getChestnutRoot, getNamedSubrootDir } from '../../foundation/claw-identity/index.js';
import { enumerateClaws, getRelativeClawDir } from '../../foundation/claw-identity/index.js';
import { resolveClawDaemonDir, MOTION_CLAW_ID } from '../../core/claw-topology/index.js';
import { createWatchdogActionAudit } from '../../watchdog/index.js';
import { stopCommand as watchdogStop } from './watchdog-cli.js';
import { stopCommand as motionStop } from './motion.js';
import { PROCESS_MANAGER_AUDIT_EVENTS, createProcessManagerForCLI, DAEMON_SHUTDOWN_GRACE_MS } from '../../foundation/process-manager/index.js';
import { PROCESS_STOP_POLL_INTERVAL_MS, SIGKILL_DEAD_VERIFY_GRACE_MS } from '../../foundation/process-manager/index.js';
import {
  kill,
  ProcessListUnavailable,
  terminateProcessTarget,
  observeProcessTargetWithLegacyProbeForTest,
} from '../../foundation/process-exec/index.js';
import { actionAuditFor, registerActionResource } from '../action-scope.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { makeClawId } from '../../foundation/claw-identity/index.js';

import { resolveDaemonEntry } from '../../daemon/index.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import { isFileNotFound, type FileSystem } from '../../foundation/fs/index.js';
import { CliError } from '../errors.js';
import {
  commitCleanStopMarker,
  type CleanStopMarkerOutcome,
} from './clean-stop-marker.js';

interface StopCommandDeps {
  fsFactory(baseDir: string): FileSystem;
  rootConfig: Pick<RootConfigReader, 'loadGlobal'>;
}

export async function stopAllCommand(
  deps: StopCommandDeps,
  extraDeps?: {
    audit?: AuditLog;
    kill?: typeof kill;
    isPidArgvMatching?: (pid: number, expectedToken: string) => boolean;
    isAlive?: (pid: number, expectedStartTime?: string) => boolean;
  },
): Promise<void> {
  deps.rootConfig.loadGlobal();

  // motion-level audit（α 模板复用 / 同 daemon-entry shim / fail-soft）
  // phase 1879 Step D: 创建经 action scope（无 scope 直调回落裸创建；fail-soft 语义保持）
  let audit: AuditLog | null = extraDeps?.audit ?? null;
  if (!audit) {
    try {
      const motionDir = getNamedSubrootDir(MOTION_CLAW_ID);
      audit = actionAuditFor(motionDir, deps);
    } catch (err) {
      console.error('Failed to construct audit for stop command:', err);
      audit = null;  // audit 构造失败 / fallback null / 后续 audit?.write 软降级
    }
  }

  // NEW: workspace audit 注入 watchdog 模块（与 watchdog daemon 同源）
  // 防 sub-1/sub-2/sub-4 audit emit 在 CLI 进程 silent no-op
  // Phase 1878 Step I: 经窄能力 createWatchdogActionAudit 取得（构造 fail-soft
  // 内化）+ action scope 注册 dispose；无 scope 直调（测试/内部）时终态自 dispose。
  const watchdogActionAudit = createWatchdogActionAudit(deps.fsFactory);
  const watchdogAuditScoped = registerActionResource(
    'watchdog-action-audit',
    () => watchdogActionAudit.dispose(),
  );
  const baseDir = getChestnutRoot();

  // 1. Stop watchdog first (prevents it from restarting motion)
  await watchdogStop(deps.fsFactory);

  // 1b. phase 1269 sub-4: sweep orphan watchdogs (恢复 commit 4b5bf0b7 精确化版)
  const { sweepOrphanWatchdogs } = await import('../../watchdog/index.js');
  const orphanSweep = await sweepOrphanWatchdogs(deps.fsFactory, { excludePid: null }, {
    kill: extraDeps?.kill,
    ...(extraDeps?.isAlive !== undefined ? {
      observeProcessTarget: (target: { pid: number }) =>
        observeProcessTargetWithLegacyProbeForTest(target, {
          legacyProbe: extraDeps.isAlive!,
          argvMatch: (pid, token) => extraDeps.isPidArgvMatching?.(pid, token) ?? true,
        }),
    } : {}),
  });  // stop 不留任何
  if (orphanSweep.killed.length > 0) {
    console.log(
      `Cleaned up ${orphanSweep.killed.length} orphan watchdog process(es): ${orphanSweep.killed.join(', ')}`,
    );
  }
  if (orphanSweep.failures.length > 0) {
    console.warn(`Failed to confirm ${orphanSweep.failures.length} orphan watchdog stop(s)`);
  }

  // 2. Stop motion
  await motionStop(deps);

  // 3. Stop all running claws
  const pm = createProcessManagerForCLI({ ...deps, baseDir });

  let clawNames: string[] = [];
  try {
    const baseFs = deps.fsFactory(baseDir);
    clawNames = enumerateClaws(baseFs, 'claws');
  } catch (e) {
    if (!isFileNotFound(e)) {
      console.error(`[stop] readdirSync claws dir failed: ${(e as Error).message}`);
    }
  }

  // phase 355 C2 (review-2026-06-13): partial-stop failure 在循环末
  // throw CliError、让 wrapper 真退非 0、不再 console.warn 静默 + 后续 return success。
  // 收集 failed 列表后延到 cleanup 之后 throw（保留 marker 写 / orphan cleanup 等业务）。
  // Do not prefilter through a boolean probe: typed stop handles not_running and
  // preserves unknown/malformed evidence instead of skipping a live process.
  const running = clawNames;
  let stopFailed: string[] = [];
  const markerOutcomes: CleanStopMarkerOutcome[] = [];
  const markerFailures: string[] = [];
  const cleanupFailures: string[] = [];
  const stopErrors: unknown[] = [];
  const recordMarkerOutcome = (
    outcome: CleanStopMarkerOutcome,
    label: string,
    event: string,
    columns: string[],
  ): void => {
    markerOutcomes.push(outcome);
    if (outcome.kind === 'committed') return;
    const markerError = outcome.kind === 'not_attempted'
      ? { name: 'Error', message: 'marker write was not attempted' }
      : outcome.error;
    markerFailures.push(
      `${label} ${outcome.kind}: ${markerError.name}: ${markerError.message}`,
    );
    stopErrors.push(markerError);
    try {
      audit?.write(
        event,
        ...columns,
        `status=clean_stop_marker_${outcome.kind}`,
        `path=${outcome.path}`,
        `operation_id=${outcome.operationId}`,
        `error=${markerError.name}: ${markerError.message}`,
      );
    } catch (err) {
      markerFailures.push(`${label} marker audit failed: ${formatErr(err)}`);
      stopErrors.push(err);
    }
  };
  if (running.length > 0) {
    console.log(`Stopping ${running.length} claw(s): ${running.join(', ')}...`);
    const results = await Promise.allSettled(running.map(async name => {
      // phase 1769: typed outcome——not_running 是竞态终局非失败；failed 带 stage/reason 证据
      const outcome = await pm.stop(resolveClawDaemonDir(makeClawId(name)));
      if (outcome.kind === 'failed') {
        throw new Error(`stopProcess failed for ${name} (stage=${outcome.stage}): ${outcome.reason}`);
      }
    }));
    stopFailed = results
      .map((r, i) => (r.status === 'rejected' ? running[i] : null))
      .filter((n): n is string => n !== null);
    for (const result of results) {
      if (result.status === 'rejected') stopErrors.push(result.reason);
    }
    if (stopFailed.length > 0) {
      console.warn(`Failed to stop ${stopFailed.length} claw(s): ${stopFailed.join(', ')}`);
    } else {
      console.log('All claws stopped');
    }
  }

  // Write marker so next boot can detect intentional stop
  const baseFs = deps.fsFactory(baseDir);
  const globalMarker = await commitCleanStopMarker({
    scope: 'global',
    path: path.join(baseDir, 'clean-stop'),
    // phase 521 (review-round4 CLI M): writeAtomicSync 已内置 tmp+rename atomicity；
    // 不在外层再 wrap tmpFile + moveSync，避免 double-tmp 孤儿。
    write: () => baseFs.writeAtomicSync('clean-stop', String(Date.now())),
  });
  recordMarkerOutcome(globalMarker, 'global', CLI_AUDIT_EVENTS.DAEMON_STOP, ['scope=all']);

  // phase 2 γ4: 同时为每只被 stop 的 claw 写 per-claw marker so watchdog can classify
  // CrashClass.active_user_stopped vs active_unexpected per claw (not just global).
  // phase 366 L1 (review-2026-06-13): 仅成功 stop 的 claw 写 marker。
  // 旧码循环 running 全集即便 pm.stop 失败也写 marker → 下次 boot watchdog 把
  // active_unexpected 翻成 active_user_stopped → 抑制 restart prompt → crash 静默。
  const stopSucceededSet = new Set(running.filter(name => !stopFailed.includes(name)));
  for (const name of stopSucceededSet) {
    const clawDir = path.join(baseDir, getRelativeClawDir(name));
    const clawFs = deps.fsFactory(clawDir);
    const outcome = await commitCleanStopMarker({
      scope: 'claw',
      path: path.join(clawDir, 'clean-stop'),
      write: () => clawFs.writeAtomicSync('clean-stop', String(Date.now())),
    });
    recordMarkerOutcome(outcome, name, CLI_AUDIT_EVENTS.CLAW_STOP, [`name=${name}`]);
  }

  audit?.write(CLI_AUDIT_EVENTS.DAEMON_STOP, `scope=all`);

  // Cleanup: pgrep兜底，清理残留的daemon-entry.js孤儿进程
  // Use full path as pattern to only match current installation
  try {
    const daemonEntryPath = resolveDaemonEntry();
    let pids: number[] = [];
    try {
      pids = pm.findProcessesSyncForCli(daemonEntryPath);
    } catch (err) {
      if (err instanceof ProcessListUnavailable) {
        // 无法取得进程表是 discovery unknown，不等于“没有孤儿”。
        cleanupFailures.push(`daemon discovery unknown: ${formatErr(err)}`);
        stopErrors.push(err);
      } else {
        throw err;
      }
    }
    if (pids.length > 0) {
      console.log(`Cleaning up ${pids.length} orphan daemon process(es)...`);
      const killFn = extraDeps?.kill ?? kill;
      for (const p of pids) {
        const outcome = await terminateProcessTarget({ pid: p, argvToken: daemonEntryPath }, {
          graceMs: DAEMON_SHUTDOWN_GRACE_MS,
          confirmMs: SIGKILL_DEAD_VERIFY_GRACE_MS,
          pollIntervalMs: PROCESS_STOP_POLL_INTERVAL_MS,
        }, {
          signal: killFn,
          ...(extraDeps?.isAlive !== undefined ? {
            observeTarget: (target: { pid: number; argvToken?: string }) =>
              observeProcessTargetWithLegacyProbeForTest(target, {
                legacyProbe: extraDeps.isAlive!,
                argvMatch: (pid, token) => extraDeps.isPidArgvMatching?.(pid, token) ?? true,
              }),
          } : {}),
        });
        if (outcome.kind === 'gone') continue;
        const outcomeStage = outcome.kind === 'still_alive' ? 'confirm' : outcome.stage;
        cleanupFailures.push(`daemon orphan ${p}: ${outcome.kind}/${outcomeStage}`);
        stopErrors.push(outcome);
        if (outcome.kind === 'indeterminate' && outcome.stage === 'sigterm') {
          audit?.write(
            PROCESS_MANAGER_AUDIT_EVENTS.ORPHAN_SIGTERM_FAILED,
            `pid=${p}`,
            `context=stop_all_orphan_cleanup`,
            `reason=${formatErr(outcome.error)}`,
          );
          continue;
        }
        const stage = outcome.kind === 'still_alive' ? 'confirm' : outcome.stage;
        audit?.write(
          PROCESS_MANAGER_AUDIT_EVENTS.ORPHAN_CLEANUP_PARTIAL,
          `pids=${p}`,
          `context=${outcome.kind === 'still_alive' ? 'stop_all_orphan_sigkill_survived' : 'stop_all_orphan_cleanup'}`,
          `stage=${stage}`,
          `reason=${outcome.kind === 'still_alive' ? 'process_survived_sigkill' : formatErr(outcome.error)}`,
          `evidence=${JSON.stringify(outcome.evidence)}`,
        );
        console.warn(`  WARNING: orphan ${p} termination was not confirmed (${outcome.kind})`);
      }
    }
  } catch (err) {
    cleanupFailures.push(`daemon cleanup unknown: ${formatErr(err)}`);
    stopErrors.push(err);
    audit?.write(
      PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_LIST_FAILED,
      `context=stop_all_cleanup_pipeline`,
      `reason=${formatErr(err)}`,
    );
  }

  // phase 355 C2: cleanup 完后才 throw、保 cleanup 不被 partial-failure 跳过。
  // 无 action scope 直调时本处为唯一终态点（正常 return / CliError throw 同在此后）
  if (!watchdogAuditScoped) watchdogActionAudit.dispose();
  if (
    stopFailed.length > 0
    || orphanSweep.failures.length > 0
    || markerFailures.length > 0
    || cleanupFailures.length > 0
  ) {
    const details = [
      ...(stopFailed.length > 0 ? [`claws: ${stopFailed.join(', ')}`] : []),
      ...(orphanSweep.failures.length > 0
        ? [`orphan watchdogs: ${orphanSweep.failures.map(f => f.pid ?? 'discovery').join(', ')}`]
        : []),
      ...(markerFailures.length > 0 ? [`clean-stop markers: ${markerFailures.join(', ')}`] : []),
      ...(cleanupFailures.length > 0 ? [`cleanup: ${cleanupFailures.join(', ')}`] : []),
    ];
    throw new CliError(`Failed to stop ${details.join('; ')}`, {
      code: 1,
      cause: new AggregateError(stopErrors),
    });
  }
  console.log('Done.');
}
