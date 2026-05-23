/**
 * stop command - Stop all clawforum processes
 */

import * as fs from 'fs';
import { existsSync } from 'fs';
import * as path from 'path';
import { loadGlobalConfig, getGlobalConfigPath, getMotionDir } from '../../foundation/config/index.js';
import { CONFIG_DEFAULTS } from '../../assembly/config-defaults.js';
import { stopCommand as watchdogStop } from '../../watchdog/watchdog.js';
import { stopCommand as motionStop } from './motion.js';
import { ProcessManager, ProcessListUnavailable } from '../../foundation/process-manager/index.js';
import { kill } from '../../foundation/process-exec/index.js';
import { NodeFileSystem } from '../../foundation/fs/node-fs.js';
import { createSystemAudit, type AuditLog } from '../../foundation/audit/index.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from '../../foundation/process-manager/audit-events.js';
import { createProcessManagerForCLI } from '../utils/factories.js';
import { CLAWS_DIR } from '../../foundation/paths.js';
import { fileURLToPath } from 'url';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';

export async function stopAllCommand(deps?: { audit?: AuditLog }): Promise<void> {
  loadGlobalConfig(CONFIG_DEFAULTS);

  // motion-level audit（α 模板复用 / 同 daemon-entry shim / fail-soft）
  let audit: AuditLog | null = deps?.audit ?? null;
  if (!audit) {
    try {
      const motionDir = getMotionDir();
      const motionFs = new NodeFileSystem({ baseDir: motionDir });
      audit = createSystemAudit(motionFs, motionDir);
    } catch (err) {
      console.error('Failed to construct audit for stop command:', err);
      audit = null;  // audit 构造失败 / fallback null / 后续 audit?.write 软降级
    }
  }

  // 1. Stop watchdog first (prevents it from restarting motion)
  await watchdogStop();

  // 2. Stop motion
  await motionStop();

  // 3. Stop all running claws
  const baseDir = path.dirname(getGlobalConfigPath());
  const clawsDir = path.join(baseDir, CLAWS_DIR);
  const pm = createProcessManagerForCLI();

  let clawNames: string[] = [];
  try {
    clawNames = fs.readdirSync(clawsDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(`[stop] readdirSync claws dir failed: ${(e as Error).message}\n`);
    }
  }

  const running = clawNames.filter(name => pm.isAlive(name));
  if (running.length > 0) {
    console.log(`Stopping ${running.length} claw(s): ${running.join(', ')}...`);
    const results = await Promise.allSettled(running.map(name => pm.stop(name)));
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
  const cleanStopFile = path.join(baseDir, 'clean-stop');
  try {
    // r126 F fork: atomic tmp+rename mirror phase 1024 G.1 / 防 crash 中 torn-write
    const tmpFile = `${cleanStopFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpFile, String(Date.now()), 'utf-8');
    fs.renameSync(tmpFile, cleanStopFile);
  } catch { /* best-effort */ }

  audit?.write(CLI_AUDIT_EVENTS.DAEMON_STOP, `scope=all`);
  console.log('Done.');

  // Cleanup: pgrep兜底，清理残留的daemon-entry.js孤儿进程
  // Use full path as pattern to only match current installation
  try {
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    // bundled: thisDir=dist/, daemon-entry.js is sibling; unbundled: thisDir=dist/cli/commands/, go up 2
    const bundleEntry = path.join(thisDir, 'daemon-entry.js');
    const daemonEntryPath = existsSync(bundleEntry) ? bundleEntry : path.resolve(thisDir, '..', '..', 'daemon-entry.js');
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
