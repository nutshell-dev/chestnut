/**
 * stop command - Stop all clawforum processes
 */

import * as path from 'path';
import { loadGlobalConfig, getGlobalConfigPath, getNamedSubrootDir } from '../../foundation/config/index.js';
import { MOTION_CLAW_ID } from '../../constants.js';
import { CONFIG_DEFAULTS } from '../../assembly/index.js';
import { createAuditWriter } from '../../foundation/audit/index.js';
import { getClawforumFs, getGlobalConfig, setAuditWriter as setWatchdogAuditWriter } from '../../watchdog/watchdog-context.js';
import { stopCommand as watchdogStop } from '../../watchdog/watchdog.js';
import { stopCommand as motionStop } from './motion.js';
import { ProcessListUnavailable } from '../../foundation/process-manager/index.js';
import { kill } from '../../foundation/process-exec/index.js';
import { createSystemAudit, type AuditLog } from '../../foundation/audit/index.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from '../../foundation/process-manager/audit-events.js';
import { createProcessManagerForCLI } from '../../foundation/process-manager/index.js';
import { CLAWS_DIR, resolveDaemonEntry } from '../../foundation/paths.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import { makeClawId } from '../../foundation/identity/index.js';
import type { FileSystem } from '../../foundation/fs/types.js';

export async function stopAllCommand(deps: { fsFactory: (baseDir: string) => FileSystem }, extraDeps?: { audit?: AuditLog }): Promise<void> {
  loadGlobalConfig(deps, CONFIG_DEFAULTS);

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
    const auditMaxSizeMb = getGlobalConfig(deps.fsFactory).audit?.retention?.max_size_mb ?? null;
    const watchdogAudit = createAuditWriter(getClawforumFs(deps.fsFactory), 'audit.tsv', auditMaxSizeMb);
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
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(`[stop] readdirSync claws dir failed: ${(e as Error).message}\n`);
    }
  }

  const running = clawNames.filter(name => pm.isAlive(makeClawId(name)));
  if (running.length > 0) {
    console.log(`Stopping ${running.length} claw(s): ${running.join(', ')}...`);
    const results = await Promise.allSettled(running.map(name => pm.stop(makeClawId(name))));
    const failed = results
      .map((r, i) => (r.status === 'rejected' ? running[i] : null))
      .filter((n): n is string => n !== null);
    if (failed.length > 0) {
      console.warn(`Failed to stop ${failed.length} claw(s): ${failed.join(', ')}`);
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
      for (const p of pids) {
        try {
          kill(p, 'TERM');
        } catch (err) {
          audit?.write(
            PROCESS_MANAGER_AUDIT_EVENTS.ORPHAN_SIGTERM_FAILED,
            `pid=${p}`,
            `context=stop_all_orphan_cleanup`,
            `reason=${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  } catch (err) {
    audit?.write(
      PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_LIST_FAILED,
      `context=stop_all_cleanup_pipeline`,
      `reason=${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
