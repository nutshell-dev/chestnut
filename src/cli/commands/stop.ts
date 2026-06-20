/**
 * stop command - Stop all chestnut processes
 */

import * as path from 'path';
import { formatErr } from "../../foundation/utils/index.js";
import { loadGlobalConfig } from '../../assembly/config-load.js';
import { getGlobalConfigPath, getNamedSubrootDir } from '../../foundation/config/index.js';
import { MOTION_CLAW_ID } from '../../constants.js';
import { createAuditWriter, AUDIT_FILE } from '../../foundation/audit/index.js';
import { getChestnutFs, getGlobalConfig, setAuditWriter as setWatchdogAuditWriter } from '../../watchdog/watchdog-context.js';
import { stopCommand as watchdogStop } from '../../watchdog/watchdog.js';
import { stopCommand as motionStop } from './motion.js';
import { ProcessListUnavailable } from '../../foundation/process-manager/index.js';
import { kill, isPidArgvMatching } from '../../foundation/process-exec/index.js';
import { createSystemAudit, type AuditLog } from '../../foundation/audit/index.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from '../../foundation/process-manager/index.js';
import { createProcessManagerForCLI } from '../../foundation/process-manager/index.js';
import { makeClawId } from '../../constants.js';
import { CLAWS_DIR } from '../../foundation/claw-paths.js';
import { resolveDaemonEntry } from '../../assembly/spawn-entry.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import { isFileNotFound, type FileSystem } from '../../foundation/fs/types.js';
import { CliError } from '../errors.js';

export async function stopAllCommand(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  extraDeps?: { audit?: AuditLog; kill?: typeof kill; isPidArgvMatching?: typeof isPidArgvMatching },
): Promise<void> {
  loadGlobalConfig(deps);

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
  try {
    const auditMaxSizeMb = getGlobalConfig(deps.fsFactory).audit.retention.max_size_mb;
    const watchdogAudit = createAuditWriter(getChestnutFs(deps.fsFactory), AUDIT_FILE, auditMaxSizeMb);
    setWatchdogAuditWriter(watchdogAudit);
  } catch (err) {
    console.error('Failed to wire watchdog audit:', err);
    // fail-soft: 既有 silent no-op fallback 保 (audit 不阻 stop 流程)
  }

  // 1. Stop watchdog first (prevents it from restarting motion)
  await watchdogStop(deps.fsFactory);

  // 1b. phase 1269 sub-4: sweep orphan watchdogs (恢复 commit 4b5bf0b7 精确化版)
  const { sweepOrphanWatchdogs } = await import('../../watchdog/orphan-sweep.js');
  const killed = await sweepOrphanWatchdogs(deps.fsFactory, { excludePid: null });  // stop 不留任何
  if (killed.length > 0) {
    console.log(`Cleaned up ${killed.length} orphan watchdog process(es): ${killed.join(', ')}`);
  }

  // 2. Stop motion
  await motionStop(deps);

  // 3. Stop all running claws
  const baseDir = path.dirname(getGlobalConfigPath());
  const pm = createProcessManagerForCLI(deps);

  let clawNames: string[] = [];
  try {
    const baseFs = deps.fsFactory(baseDir);
    clawNames = baseFs.listSync(CLAWS_DIR, { includeDirs: true })
      .filter(e => e.isDirectory)
      .map(e => e.name);
  } catch (e) {
    if (!isFileNotFound(e)) {
      console.error(`[stop] readdirSync claws dir failed: ${(e as Error).message}`);
    }
  }

  // phase 355 C2 (review-2026-06-13): partial-stop failure 在循环末
  // throw CliError、让 wrapper 真退非 0、不再 console.warn 静默 + 后续 return success。
  // 收集 failed 列表后延到 cleanup 之后 throw（保留 marker 写 / orphan cleanup 等业务）。
  const running = clawNames.filter(name => pm.isAlive(makeClawId(name)));
  let stopFailed: string[] = [];
  if (running.length > 0) {
    console.log(`Stopping ${running.length} claw(s): ${running.join(', ')}...`);
    const results = await Promise.allSettled(running.map(name => pm.stop(makeClawId(name))));
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
    // r126 F fork: atomic tmp+rename mirror phase 1024 G.1 / 防 crash 中 torn-write
    const tmpFile = `clean-stop.${process.pid}.${Date.now()}.tmp`;
    baseFs.writeAtomicSync(tmpFile, String(Date.now()));
    baseFs.moveSync(tmpFile, 'clean-stop');
  } catch { /* silent: clean-stop marker 写失败 best-effort / 缺 marker 仅次启动 spurious "ungraceful shutdown" warn 不影响功能 */ }

  // phase 2 γ4: 同时为每只被 stop 的 claw 写 per-claw marker so watchdog can classify
  // CrashClass.active_user_stopped vs active_unexpected per claw (not just global).
  // phase 366 L1 (review-2026-06-13): 仅成功 stop 的 claw 写 marker。
  // 旧码循环 running 全集即便 pm.stop 失败也写 marker → 下次 boot watchdog 把
  // active_unexpected 翻成 active_user_stopped → 抑制 restart prompt → crash 静默。
  const stopSucceededSet = new Set(running.filter(name => !stopFailed.includes(name)));
  for (const name of stopSucceededSet) {
    try {
      const clawFs = deps.fsFactory(path.join(baseDir, CLAWS_DIR, name));
      const tmpFile = `clean-stop.${process.pid}.${Date.now()}.tmp`;
      clawFs.writeAtomicSync(tmpFile, String(Date.now()));
      clawFs.moveSync(tmpFile, 'clean-stop');
    } catch {
      // silent: per-claw marker 写失败 best-effort（同全局 marker 处理）
    }
  }

  audit?.write(CLI_AUDIT_EVENTS.DAEMON_STOP, `scope=all`);
  console.log('Done.');

  // Cleanup: pgrep兜底，清理残留的daemon-entry.js孤儿进程
  // Use full path as pattern to only match current installation
  try {
    const daemonEntryPath = resolveDaemonEntry(deps.fsFactory(process.cwd()));
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
  if (stopFailed.length > 0) {
    throw new CliError(
      `Failed to stop ${stopFailed.length} claw(s): ${stopFailed.join(', ')}`,
      1,
    );
  }
}
