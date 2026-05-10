/**
 * stop command - Stop all clawforum processes
 */

import * as fs from 'fs';
import { existsSync } from 'fs';
import * as path from 'path';
import { loadGlobalConfig, getGlobalConfigPath, getMotionDir } from '../../foundation/config/index.js';
import { stopCommand as watchdogStop } from '../../watchdog/watchdog.js';
import { stopCommand as motionStop } from './motion.js';
import { ProcessManager, ProcessListUnavailable } from '../../foundation/process-manager/index.js';
import { kill } from '../../foundation/process-exec/index.js';
import { NodeFileSystem } from '../../foundation/fs/node-fs.js';
import { createSystemAudit, type AuditLog } from '../../foundation/audit/index.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from '../../foundation/process-manager/audit-events.js';
import { createProcessManagerForCLI } from '../utils/factories.js';
import { CLAWS_DIR } from '../../types/paths.js';
import { fileURLToPath } from 'url';

export async function stopAllCommand(): Promise<void> {
  loadGlobalConfig();

  // motion-level audit（α 模板复用 / 同 daemon-entry shim / fail-soft）
  let audit: AuditLog | null = null;
  try {
    const motionDir = getMotionDir();
    const motionFs = new NodeFileSystem({ baseDir: motionDir });
    audit = createSystemAudit(motionFs, motionDir);
  } catch {
    audit = null;  // audit 构造失败 / fallback null / 后续 audit?.write 软降级
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
  } catch { /* no claws dir */ }

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

  // 写入 clean-stop 标记，供下次启动时识别
  const cleanStopFile = path.join(baseDir, 'clean-stop');
  try {
    fs.writeFileSync(cleanStopFile, String(Date.now()), 'utf-8');
  } catch { /* best-effort */ }

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
