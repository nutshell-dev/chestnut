/**
 * @module L6.CLI.Claw.List
 * List all claws + status
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import {
  loadGlobalConfig, getGlobalConfigPath,
} from '../../foundation/config/index.js';
import { createDirContext, createProcessManagerForCLI } from '../utils/factories.js';
import { NodeFileSystem } from '../../foundation/fs/node-fs.js';
import { CONTRACT_DIR } from '../../core/contract/index.js';
import { CLAWS_DIR } from '../../types/paths.js';
import { formatRelativeTime, getLastActiveMs, LLM_OUTPUT_EVENTS } from './claw-shared.js';
import { handleCliError } from '../errors.js';

/**
 * List all Claws and their status
 */
export async function listCommand(): Promise<void> {
  loadGlobalConfig();

  const globalConfigPath = getGlobalConfigPath();
  const baseDir = path.dirname(globalConfigPath);
  const clawsDir = path.join(baseDir, CLAWS_DIR);

  const processManager = createProcessManagerForCLI();
  const { audit: systemAudit } = createDirContext(baseDir);

  // Helper: check contract status
  function getContractStatus(clawPath: string): string {
    for (const sub of ['active', 'paused']) {
      try {
        const entries = fs.readdirSync(path.join(clawPath, CONTRACT_DIR, sub), { withFileTypes: true });
        if (entries.some(e => e.isDirectory())) return sub;
      } catch { /* skip */ }
    }
    return '-';
  }

  // Helper: count unread outbox messages
  function getOutboxCount(clawPath: string): number {
    try {
      return fs.readdirSync(path.join(clawPath, 'outbox', 'pending')).length;
    } catch { return 0; }
  }

  // Helper: format relative last-active time
  async function formatLastActive(clawPath: string): Promise<string> {
    const clawFs = new NodeFileSystem({ baseDir: clawPath });
    const ms = await getLastActiveMs(clawFs, systemAudit);
    if (ms === undefined) return '-';
    const age = Date.now() - ms;
    const mins = Math.floor(age / 60000);
    if (mins < 1) return '<1m';
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    return `${hours}h`;
  }

  // Helper: get latest contract title (active > paused > most recent archive)
  function getLatestContractTitle(clawPath: string): string {
    for (const sub of ['active', 'paused']) {
      try {
        const dirs = fs.readdirSync(path.join(clawPath, CONTRACT_DIR, sub));
        for (const dir of dirs) {
          const yamlPath = path.join(clawPath, 'contract', sub, dir, 'contract.yaml');
          if (fs.existsSync(yamlPath)) {
            const content = fs.readFileSync(yamlPath, 'utf-8');
            const match = content.match(/^title:\s*["']?(.+?)["']?\s*$/m);
            if (match) return match[1].slice(0, 28);
          }
        }
      } catch { /* skip */ }
    }
    try {
      const archiveDir = path.join(clawPath, CONTRACT_DIR, 'archive');
      const dirs = fs.readdirSync(archiveDir);
      let latest = { mtime: 0, title: '' };
      for (const dir of dirs) {
        const yamlPath = path.join(archiveDir, dir, 'contract.yaml');
        if (fs.existsSync(yamlPath)) {
          const stat = fs.statSync(yamlPath);
          if (stat.mtimeMs > latest.mtime) {
            const content = fs.readFileSync(yamlPath, 'utf-8');
            const match = content.match(/^title:\s*["']?(.+?)["']?\s*$/m);
            if (match) latest = { mtime: stat.mtimeMs, title: match[1].slice(0, 28) };
          }
        }
      }
      if (latest.title) return latest.title;
    } catch { /* skip */ }
    return '-';
  }

  try {
    // Ensure claws directory exists
    if (!fs.existsSync(clawsDir)) {
      fs.mkdirSync(clawsDir, { recursive: true });
    }
    const entries = fs.readdirSync(clawsDir);
    const claws: Array<{
      name: string;
      status: string;
      pid?: string;
      contract: string;
      outbox: number;
      lastActive: string;
      lastContract: string;
    }> = [];

    for (const entry of entries) {
      const clawPath = path.join(clawsDir, entry);
      const configPath = path.join(clawPath, 'config.yaml');
      if (fs.existsSync(configPath)) {
        const isRunning = processManager.isAlive(entry);
        let pid: string | undefined;

        if (isRunning) {
          try {
            const pidNum = await processManager.readPid(entry);
            pid = pidNum !== null ? String(pidNum) : '';
          } catch { /* ignore read errors */ }
        }

        claws.push({
          name: entry,
          status: isRunning ? 'running' : 'stopped',
          pid,
          contract: getContractStatus(clawPath),
          outbox: getOutboxCount(clawPath),
          lastActive: await formatLastActive(clawPath),
          lastContract: getLatestContractTitle(clawPath),
        });
      }
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
      const pidStr = claw.pid || '-';
      console.log(`${claw.name.padEnd(20)} ${statusIcon.padEnd(12)} ${pidStr.padEnd(10)} ${claw.contract.padEnd(10)} ${String(claw.outbox).padEnd(8)} ${claw.lastActive.padEnd(10)} ${claw.lastContract.padEnd(30)}`);
    }

    console.log('─'.repeat(112));
    console.log(`\nTotal: ${claws.length} claws (${claws.filter(c => c.status === 'running').length} running)\n`);
  } catch (error) {
    console.error('Failed to list claws:', error instanceof Error ? error.message : String(error));
    process.exitCode = handleCliError(error);
  }
}
