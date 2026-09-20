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
import { kill, isPidArgvMatching, isAlive, ProcessListUnavailable } from '../../foundation/process-exec/index.js';
import { createSystemAudit, type AuditLog } from '../../foundation/audit/index.js';
import { registerActionResource } from '../action-scope.js';
import { makeClawId } from '../../foundation/claw-identity/index.js';

import { resolveDaemonEntry } from '../../daemon/index.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import { isFileNotFound, type FileSystem } from '../../foundation/fs/index.js';
import { CliError } from '../errors.js';

interface StopCommandDeps {
  fsFactory(baseDir: string): FileSystem;
  rootConfig: Pick<RootConfigReader, 'loadGlobal'>;
}

export async function stopAllCommand(
  deps: StopCommandDeps,
  extraDeps?: { audit?: AuditLog; kill?: typeof kill; isPidArgvMatching?: typeof isPidArgvMatching; isAlive?: typeof isAlive },
): Promise<void> {
  deps.rootConfig.loadGlobal();

  // motion-level audit（α 模板复用 / 同 daemon-entry shim / fail-soft）
  let audit: AuditLog | null = extraDeps?.audit ?? null;
  if (!audit) {
    try {
      const motionDir = getNamedSubrootDir(MOTION_CLAW_ID);
      const motionFs = deps.fsFactory(motionDir);
      audit = createSystemAudit(motionFs, motionDir);
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
  const killed = await sweepOrphanWatchdogs(deps.fsFactory, { excludePid: null });  // stop 不留任何
  if (killed.length > 0) {
    console.log(`Cleaned up ${killed.length} orphan watchdog process(es): ${killed.join(', ')}`);
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
  const running = clawNames.filter(name => pm.isAlive(resolveClawDaemonDir(makeClawId(name))));
  let stopFailed: string[] = [];
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
    if (stopFailed.length > 0) {
      console.warn(`Failed to stop ${stopFailed.length} claw(s): ${stopFailed.join(', ')}`);
    } else {
      console.log('All claws stopped');
    }
  }

  // Write marker so next boot can detect intentional stop
  const baseFs = deps.fsFactory(baseDir);
  try {
    // phase 521 (review-round4 CLI M): writeAtomicSync 已内置 tmp+rename atomicity；
    // 原 r126 F fork 在外层再 wrap tmpFile + moveSync (= double-tmp) → crash 在
    // writeAtomic 完成后 moveSync 前会留 clean-stop.<pid>.<ts>.tmp 孤儿、累积 in .chestnut/。
    // 改后直接 writeAtomicSync 到 'clean-stop'、原子 + 无中间 .tmp 残留。
    baseFs.writeAtomicSync('clean-stop', String(Date.now()));
  } catch { /* silent: clean-stop marker 写失败 best-effort / 缺 marker 仅次启动 spurious "ungraceful shutdown" warn 不影响功能 */ }

  // phase 2 γ4: 同时为每只被 stop 的 claw 写 per-claw marker so watchdog can classify
  // CrashClass.active_user_stopped vs active_unexpected per claw (not just global).
  // phase 366 L1 (review-2026-06-13): 仅成功 stop 的 claw 写 marker。
  // 旧码循环 running 全集即便 pm.stop 失败也写 marker → 下次 boot watchdog 把
  // active_unexpected 翻成 active_user_stopped → 抑制 restart prompt → crash 静默。
  const stopSucceededSet = new Set(running.filter(name => !stopFailed.includes(name)));
  for (const name of stopSucceededSet) {
    try {
      // phase 521 (review-round4 CLI M): 同 baseDir marker 路径、writeAtomicSync 已内置
      // tmp+rename、外层 wrap 去除、防 .tmp 孤儿累积 in .chestnut/claws/<name>/。
      const clawFs = deps.fsFactory(path.join(baseDir, getRelativeClawDir(name)));
      clawFs.writeAtomicSync('clean-stop', String(Date.now()));
    } catch {
      // silent: per-claw marker 写失败 best-effort（同全局 marker 处理）
    }
  }

  audit?.write(CLI_AUDIT_EVENTS.DAEMON_STOP, `scope=all`);
  console.log('Done.');

  // Cleanup: pgrep兜底，清理残留的daemon-entry.js孤儿进程
  // Use full path as pattern to only match current installation
  try {
    const daemonEntryPath = resolveDaemonEntry();
    let pids: number[] = [];
    try {
      pids = pm.findProcesses(daemonEntryPath);
    } catch (err) {
      if (err instanceof ProcessListUnavailable) {
        // audit 已由 findProcesses 写；降级：跳过孤儿清理
      } else {
        throw err;
      }
    }
    if (pids.length > 0) {
      console.log(`Cleaning up ${pids.length} orphan daemon process(es)...`);
      const killFn = extraDeps?.kill ?? kill;
      const isPidArgvMatchingFn = extraDeps?.isPidArgvMatching ?? isPidArgvMatching;
      const isAliveFn = extraDeps?.isAlive ?? isAlive;
      const remaining: number[] = [];
      for (const p of pids) {
        // phase 422 Step A (review medium orphan-cleanup uniformity): SIGTERM 前
        // 二次 argv-verify、防 findProcesses → kill 间 PID race window 误杀
        // shell/editor。mirror orphan-sweep.ts:74,101 pattern。
        if (!isPidArgvMatchingFn(p, daemonEntryPath)) {
          audit?.write(
            PROCESS_MANAGER_AUDIT_EVENTS.ORPHAN_SIGTERM_FAILED,
            `pid=${p}`,
            `context=stop_all_orphan_cleanup`,
            `reason=argv_verify_failed`,
          );
          continue;
        }
        try {
          killFn(p, 'TERM');
        } catch (err) {
          audit?.write(
            PROCESS_MANAGER_AUDIT_EVENTS.ORPHAN_SIGTERM_FAILED,
            `pid=${p}`,
            `context=stop_all_orphan_cleanup`,
            `reason=${formatErr(err)}`,
          );
          continue;
        }
        remaining.push(p);
      }

      // phase 804: poll for SIGTERM effect, escalate to SIGKILL, then verify death
      if (remaining.length > 0) {
        const deadline = Date.now() + DAEMON_SHUTDOWN_GRACE_MS;
        let alivePids = [...remaining];
        while (alivePids.length > 0 && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, PROCESS_STOP_POLL_INTERVAL_MS));
          alivePids = alivePids.filter(p => isAliveFn(p));
        }

        if (alivePids.length > 0) {
          console.log(`  ${alivePids.length} orphan(s) still alive, sending SIGKILL...`);
          for (const p of alivePids) {
            try { killFn(p, 'KILL'); } catch { /* silent: process already dead, race between poll and kill */ }
          }
          await new Promise(resolve => setTimeout(resolve, SIGKILL_DEAD_VERIFY_GRACE_MS));

          const finalSurvivors = alivePids.filter(p => isAliveFn(p));
          if (finalSurvivors.length > 0) {
            console.warn(`  WARNING: ${finalSurvivors.length} orphan(s) survived SIGKILL: ${finalSurvivors.join(', ')}`);
            audit?.write(
              PROCESS_MANAGER_AUDIT_EVENTS.ORPHAN_CLEANUP_PARTIAL,
              `pids=${finalSurvivors.join(',')}`,
              `context=stop_all_orphan_sigkill_survived`,
            );
          }
        }
      }
    }
  } catch (err) {
    audit?.write(
      PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_LIST_FAILED,
      `context=stop_all_cleanup_pipeline`,
      `reason=${formatErr(err)}`,
    );
  }

  // phase 355 C2: cleanup 完后才 throw、保 cleanup 不被 partial-failure 跳过。
  // 无 action scope 直调时本处为唯一终态点（正常 return / CliError throw 同在此后）
  if (!watchdogAuditScoped) watchdogActionAudit.dispose();
  if (stopFailed.length > 0) {
    throw new CliError(
      `Failed to stop ${stopFailed.length} claw(s): ${stopFailed.join(', ')}`,
      1,
    );
  }
}
