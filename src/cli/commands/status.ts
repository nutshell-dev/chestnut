/**
 * Status command - Show status of all clawforum processes
 */

import * as path from 'path';
import { loadGlobalConfig, getNamedSubrootDir } from '../../foundation/config/index.js';
import { CONFIG_DEFAULTS } from '../../assembly/index.js';
import { ProcessManager, ProcessListUnavailable } from '../../foundation/process-manager/index.js';
import { createProcessManagerForCLI } from '../../foundation/process-manager/index.js';
import { CLAWS_DIR, resolveDaemonEntry } from '../../foundation/paths.js';
import {
  getWatchdogPid,
  isWatchdogAlive,
  getWatchdogEntryPath,
} from '../../watchdog/watchdog.js';
import { MOTION_CLAW_ID } from '../../constants.js';
import { makeClawId } from '../../foundation/identity/index.js';
import type { FileSystem } from '../../foundation/fs/types.js';

export function findOrphanProcesses(
  pm: ProcessManager,
  entryPath: string,
  excludePids: (number | null | undefined)[],
): number[] {
  const validExcludes = excludePids.filter((p): p is number => typeof p === 'number');
  try {
    return pm.findProcesses(entryPath).filter(p => !validExcludes.includes(p) && p !== process.pid);
  } catch (err) {
    if (err instanceof ProcessListUnavailable) {
      // audit 已由 findProcesses 写；降级：跳过孤儿扫描
      return [];
    }
    throw err;
  }
}

export async function statusCommand(deps: { fsFactory: (baseDir: string) => FileSystem }): Promise<void> {
  loadGlobalConfig(deps, CONFIG_DEFAULTS);

  // 1. Watchdog
  const watchdogPid = getWatchdogPid(deps.fsFactory);
  const watchdogAlive = isWatchdogAlive(deps.fsFactory);
  console.log(`watchdog: ${watchdogAlive ? `running (PID=${watchdogPid})` : 'stopped'}`);

  // 2. Motion
  const baseDir = path.dirname(getNamedSubrootDir(MOTION_CLAW_ID));
  const pm = createProcessManagerForCLI(deps);
  const motionStatus = pm.getAliveStatus(MOTION_CLAW_ID);
  console.log(`motion:   ${motionStatus.alive ? `running (${motionStatus.reason})` : `stopped (${motionStatus.reason})`}`);

  // 3. Claws
  const clawStatuses: { name: string; status: { alive: boolean; reason: string; pid?: number } }[] = [];
  const baseFs = deps.fsFactory(baseDir);
  if (baseFs.existsSync(CLAWS_DIR)) {
    const clawEntries = baseFs.listSync(CLAWS_DIR, { includeDirs: true })
      .filter(e => e.isDirectory)
      .map(e => e.name);

    for (const name of clawEntries) {
      const s = pm.getAliveStatus(makeClawId(name));
      console.log(`  ${name}: ${s.alive ? `running (${s.reason})` : `stopped (${s.reason})`}`);
      clawStatuses.push({ name, status: s });
    }
  }

  // 4. Orphan scan: find processes not tracked by PID files
  const nodeFs = deps.fsFactory(process.cwd());

  // Watchdog orphans
  const wdPath = getWatchdogEntryPath(deps.fsFactory);
  const wdPids = findOrphanProcesses(pm, wdPath, [watchdogPid]);
  if (wdPids.length > 0) {
    console.log(`  ⚠ orphan watchdog(s): PIDs ${wdPids.join(', ')}`);
  }

  // Daemon orphans
  const daemonEntryPath = resolveDaemonEntry(nodeFs);
  const motionPid = motionStatus.pid;
  const trackedPids = [motionPid, ...clawStatuses.map(s => s.status.pid)].filter((p): p is number => p !== undefined);
  const orphanDaemons = findOrphanProcesses(pm, daemonEntryPath, trackedPids);
  if (orphanDaemons.length > 0) {
    console.log(`  ⚠ orphan daemon(s): PIDs ${orphanDaemons.join(', ')}`);
  }
}
