/**
 * @module L6.CLI.Claw.List
 * List all claws + status
 */

import * as path from 'path';
import {
  loadGlobalConfig, getGlobalConfigPath,
} from '../../foundation/config/index.js';
import { CONFIG_DEFAULTS } from '../../assembly/index.js';
import { createDirContext } from '../../foundation/audit/index.js';
import { createProcessManagerForCLI } from '../../foundation/process-manager/factories.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import { CONTRACT_DIR } from '../../core/contract/index.js';
import { CLAWS_DIR } from '../../foundation/paths.js';
import { getLastActiveMs } from './claw-shared.js';
import { makeClawId } from '../../foundation/identity/index.js';
import { handleCliError } from '../errors.js';

/**
 * List all Claws and their status
 */
export async function listCommand(deps: { fsFactory: (baseDir: string) => FileSystem }, opts?: { json?: boolean }): Promise<void> {
  loadGlobalConfig(deps, CONFIG_DEFAULTS);

  const globalConfigPath = getGlobalConfigPath();
  const baseDir = path.dirname(globalConfigPath);
  const clawsDir = path.join(baseDir, CLAWS_DIR);

  const processManager = createProcessManagerForCLI(deps);
  const { audit: systemAudit } = createDirContext(deps, baseDir);

  // Helper: check contract status
  function getContractStatus(clawFs: FileSystem): string {
    for (const sub of ['active', 'paused']) {
      try {
        const entries = clawFs.listSync(path.join(CONTRACT_DIR, sub), { includeDirs: true });
        if (entries.some(e => e.isDirectory)) return sub;
      } catch { /* silent: skip */ }
    }
    return '-';
  }

  // Helper: count unread outbox messages
  function getOutboxCount(clawFs: FileSystem): number {
    try {
      return clawFs.listSync(path.join('outbox', 'pending')).map(e => e.name).length;
    } catch { return 0; }
  }

  async function formatLastActiveMs(clawFs: FileSystem): Promise<number | undefined> {
    return await getLastActiveMs(clawFs, systemAudit);
  }

  // Helper: get latest contract title (active > paused > most recent archive)
  function getLatestContractTitle(clawFs: FileSystem): string {
    for (const sub of ['active', 'paused']) {
      try {
        const dirs = clawFs.listSync(path.join(CONTRACT_DIR, sub), { includeDirs: true }).map(e => e.name);
        for (const dir of dirs) {
          const relYamlPath = path.join('contract', sub, dir, 'contract.yaml');
          if (clawFs.existsSync(relYamlPath)) {
            const content = clawFs.readSync(relYamlPath);
            const match = content.match(/^title:\s*["']?(.+?)["']?\s*$/m);
            if (match) return match[1].slice(0, 28);
          }
        }
      } catch { /* silent: skip */ }
    }
    try {
      const dirs = clawFs.listSync(path.join(CONTRACT_DIR, 'archive'), { includeDirs: true }).map(e => e.name);
      let latest = { mtime: 0, title: '' };
      for (const dir of dirs) {
        const relYamlPath = path.join(CONTRACT_DIR, 'archive', dir, 'contract.yaml');
        if (clawFs.existsSync(relYamlPath)) {
          const stat = clawFs.statSync(relYamlPath);
          if (stat.mtime.getTime() > latest.mtime) {
            const content = clawFs.readSync(relYamlPath);
            const match = content.match(/^title:\s*["']?(.+?)["']?\s*$/m);
            if (match) latest = { mtime: stat.mtime.getTime(), title: match[1].slice(0, 28) };
          }
        }
      }
      if (latest.title) return latest.title;
    } catch { /* silent: skip */ }
    return '-';
  }

  try {
    const baseDirFs = deps.fsFactory(baseDir);
    // Ensure claws directory exists
    if (!baseDirFs.existsSync(CLAWS_DIR)) {
      baseDirFs.ensureDirSync(CLAWS_DIR);
    }
    const clawsDirFs = deps.fsFactory(clawsDir);
    const entries = clawsDirFs.listSync('.', { includeDirs: true }).map(e => e.name);
    const claws: Array<{
      name: string;
      status: string;
      pid?: number;
      lastActiveIso: string | null;
      contract: string;
      outbox: number;
      lastActive: string;
      lastContract: string;
    }> = [];

    for (const entry of entries) {
      const clawFs = deps.fsFactory(path.join(clawsDir, entry));
      if (clawFs.existsSync('config.yaml')) {
        const isRunning = processManager.isAlive(makeClawId(entry));
        let pid: number | undefined;

        if (isRunning) {
          try {
            const stored = await processManager.readPid(makeClawId(entry));
            if (stored !== null) pid = stored.pid;
          } catch { /* silent: ignore read errors */ }
        }

        const lastMs = await formatLastActiveMs(clawFs);
        let lastActive = '-';
        if (lastMs !== undefined) {
          const age = Date.now() - lastMs;
          const mins = Math.floor(age / 60000);
          if (mins < 1) lastActive = '<1m';
          else if (mins < 60) lastActive = `${mins}m`;
          else lastActive = `${Math.floor(mins / 60)}h`;
        }

        claws.push({
          name: entry,
          status: isRunning ? 'running' : 'stopped',
          pid,
          contract: getContractStatus(clawFs),
          outbox: getOutboxCount(clawFs),
          lastActive,
          lastActiveIso: lastMs !== undefined ? new Date(lastMs).toISOString() : null,
          lastContract: getLatestContractTitle(clawFs),
        });
      }
    }

    if (opts?.json) {
      const payload = {
        claws: claws.map(c => ({
          name: c.name,
          status: c.status as 'running' | 'stopped',
          pid: c.pid ?? null,
          contract: c.contract,
          outbox: c.outbox,
          last_active: c.lastActiveIso,
          last_contract: c.lastContract,
        })),
        total: claws.length,
        running_count: claws.filter(c => c.status === 'running').length,
        as_of: new Date().toISOString(),
      };
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    if (claws.length === 0) {
      console.log('No claws found. Create one with: clawforum claw create <name>');
      return;
    }

    // Print table
    console.log('\nClaw List:');
    console.log('─'.repeat(112));
    console.log(`${'Name'.padEnd(20)} ${'Status'.padEnd(12)} ${'PID'.padEnd(10)} ${'Contract'.padEnd(10)} ${'Outbox'.padEnd(8)} ${'LastActive'.padEnd(10)} ${'Last Contract'.padEnd(30)}`);
    console.log('─'.repeat(112));

    for (const claw of claws) {
      const statusIcon = claw.status === 'running' ? '[running]' : '[stopped]';
      const pidStr = claw.pid !== undefined ? String(claw.pid) : '-';
      console.log(`${claw.name.padEnd(20)} ${statusIcon.padEnd(12)} ${pidStr.padEnd(10)} ${claw.contract.padEnd(10)} ${String(claw.outbox).padEnd(8)} ${claw.lastActive.padEnd(10)} ${claw.lastContract.padEnd(30)}`);
    }

    console.log('─'.repeat(112));
    console.log(`\nTotal: ${claws.length} claws (${claws.filter(c => c.status === 'running').length} running)\n`);
  } catch (error) {
    process.exitCode = handleCliError(error);
  }
}
