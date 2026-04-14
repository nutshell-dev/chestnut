/**
 * Status command - Show status of all clawforum processes
 */

import * as fs from 'fs';
import * as path from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { loadGlobalConfig, getMotionDir } from '../config.js';
import { ProcessManager } from '../../foundation/process-manager/index.js';
import { NodeFileSystem } from '../../foundation/fs/node-fs.js';
import { getWatchdogPid, isWatchdogAlive, getWatchdogEntryPath } from './watchdog.js';

export async function statusCommand(): Promise<void> {
  loadGlobalConfig();

  // 1. Watchdog
  const watchdogPid = getWatchdogPid();
  const watchdogAlive = isWatchdogAlive();
  console.log(`watchdog: ${watchdogAlive ? `running (PID=${watchdogPid})` : 'stopped'}`);

  // 2. Motion
  const baseDir = path.dirname(getMotionDir());
  const nodeFs = new NodeFileSystem({ baseDir, enforcePermissions: false });
  const pm = new ProcessManager(nodeFs, baseDir, (id) => {
    if (id === 'motion') return path.join(baseDir, 'motion');
    return path.join(baseDir, 'claws', id);
  });
  const motionStatus = pm.getAliveStatus('motion');
  console.log(`motion:   ${motionStatus.alive ? `running (${motionStatus.reason})` : `stopped (${motionStatus.reason})`}`);

  // 3. Claws
  const clawsDir = path.join(baseDir, 'claws');
  const clawStatuses: { name: string; status: { alive: boolean; reason: string; pid?: number } }[] = [];
  if (fs.existsSync(clawsDir)) {
    const clawEntries = fs.readdirSync(clawsDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);

    for (const name of clawEntries) {
      const s = pm.getAliveStatus(name);
      console.log(`  ${name}: ${s.alive ? `running (${s.reason})` : `stopped (${s.reason})`}`);
      clawStatuses.push({ name, status: s });
    }
  }

  // 4. Orphan scan: find processes not tracked by PID files
  const thisDir = path.dirname(fileURLToPath(import.meta.url));

  // Watchdog orphans
  const wdPath = getWatchdogEntryPath();
  const wdPids = pm.findProcesses(wdPath).filter(p => p !== watchdogPid && p !== process.pid);
  if (wdPids.length > 0) {
    console.log(`  ⚠ orphan watchdog(s): PIDs ${wdPids.join(', ')}`);
  }

  // Daemon orphans
  const bundleEntry = path.join(thisDir, 'daemon-entry.js');
  const daemonEntryPath = existsSync(bundleEntry)
    ? bundleEntry
    : path.resolve(thisDir, '..', '..', 'daemon-entry.js');
  const motionPid = motionStatus.pid;
  const trackedPids = [motionPid, ...clawStatuses.map(s => s.status.pid)].filter((p): p is number => p !== undefined);
  const orphanDaemons = pm.findProcesses(daemonEntryPath).filter(p => !trackedPids.includes(p) && p !== process.pid);
  if (orphanDaemons.length > 0) {
    console.log(`  ⚠ orphan daemon(s): PIDs ${orphanDaemons.join(', ')}`);
  }
}
