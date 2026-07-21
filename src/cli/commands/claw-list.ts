/**
 * @module L6.CLI.Claw.List
 * List all claws + status
 */

import * as path from 'path';
import {
  enumerateClaws,
  resolveClawDaemonDir,
} from '../../core/claw-topology/index.js';
import { loadGlobalConfig } from '../../assembly/config/config-load.js';
import { getGlobalConfigPath } from '../../assembly/config/global-config-path.js';
import { createDirContext } from '../../foundation/audit/index.js';
import { createProcessManagerForCLI } from '../../foundation/process-manager/index.js';
import { makeClawId } from '../../foundation/claw-identity/index.js';
import { isFileNotFound, type FileSystem } from '../../foundation/fs/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import {
  getLatestContractStats,
  listLegacyPausedContracts,
  CONTRACT_ACTIVE_DIR,
  CONTRACT_YAML_FILE,
} from '../../core/contract/index.js';
import { listArchiveContractLocations, archiveContainerDir } from '../../core/contract/locations.js';
import type { ContractSubtaskStats, LegacyPausedContractRef } from '../../core/contract/index.js';
import { CONFIG_YAML_FILE } from '../../core/claw-topology/index.js';
import { getLastActiveMs } from './claw-shared.js';
import { listOutboxPendingSync } from '../../foundation/messaging/index.js';

/** claw-list title console 显示截断 cap（防 list 行过长）*/
const CLAW_TITLE_DISPLAY_CHARS = 28;

/** Tri-state field value: present value, missing, or I/O error. */
type FieldValue = { kind: 'value'; text: string } | { kind: 'missing' } | { kind: 'error'; reason: string };

function formatField(value: FieldValue): string {
  if (value.kind === 'value') return value.text;
  if (value.kind === 'missing') return '-';
  return 'err';
}


/**
 * List all Claws and their status
 */
/** Internal claw entry populated for list rendering. */
interface ClawEntry {
  name: string;
  status: 'running' | 'stopped';
  pid?: number;
  pidError?: string;
  lastActiveIso: string | null;
  contract: string;
  contractError?: string;
  outbox: number;
  lastActive: string;
  lastContract: string;
  lastContractError?: string;
  legacyPaused: LegacyPausedContractRef[];
}

export async function listCommand(deps: { fsFactory: (baseDir: string) => FileSystem }, opts?: { json?: boolean; summary?: boolean }): Promise<void> {
  loadGlobalConfig(deps);

  const globalConfigPath = getGlobalConfigPath();
  const baseDir = path.dirname(globalConfigPath);
  const clawsDir = path.join(baseDir, 'claws');

  const processManager = createProcessManagerForCLI({ ...deps, baseDir });
  const { audit: systemAudit } = createDirContext(deps, baseDir);

  // Helper: check contract status
  function getContractStatus(clawFs: FileSystem): FieldValue {
    try {
      const entries = clawFs.listSync(CONTRACT_ACTIVE_DIR, { includeDirs: true });
      return entries.some(e => e.isDirectory)
        ? { kind: 'value', text: 'active' }
        : { kind: 'missing' };
    } catch (err) {
      if (isFileNotFound(err)) return { kind: 'missing' };
      return { kind: 'error', reason: formatErr(err) };
    }
  }

  // Helper: count unread outbox messages
  // phase 746: use Messaging lightweight query helper
  // phase 934: helper returns Result; -1 marks I/O error
  function getOutboxCount(clawFs: FileSystem): number {
    const r = listOutboxPendingSync(clawFs, '.');
    return r.ok ? r.value.length : -1;
  }

  async function formatLastActiveMs(clawFs: FileSystem): Promise<number | undefined> {
    return await getLastActiveMs(clawFs, systemAudit);
  }

  // Helper: get latest contract title (active > most recent archive)
  function getLatestContractTitle(clawFs: FileSystem): FieldValue {
    try {
      let activeEntries: Array<{ name: string; isDirectory: boolean }> = [];
      try {
        activeEntries = clawFs
          .listSync(CONTRACT_ACTIVE_DIR, { includeDirs: true })
          .filter(e => e.isDirectory)
          .sort((a, b) => a.name.localeCompare(b.name));
      } catch (err) {
        if (!isFileNotFound(err)) {
          return { kind: 'error', reason: `active contract scan failed: ${formatErr(err)}` };
        }
        // ENOENT means no active contract directory; fall through to archive scan.
      }

      if (activeEntries.length > 0) {
        const yamlPath = path.join(CONTRACT_ACTIVE_DIR, activeEntries[0].name, CONTRACT_YAML_FILE);
        try {
          const content = clawFs.readSync(yamlPath);
          const match = content.match(/^title:\s*["']?(.+?)["']?\s*$/m);
          if (match) return { kind: 'value', text: match[1].slice(0, CLAW_TITLE_DISPLAY_CHARS) };
        } catch (err) {
          if (isFileNotFound(err)) return { kind: 'missing' };
          return { kind: 'error', reason: `active contract scan failed: ${formatErr(err)}` };
        }
        return { kind: 'missing' };
      }
    } catch (err) {
      return { kind: 'error', reason: `active contract scan failed: ${formatErr(err)}` };
    }

    try {
      // phase 1127 Step C: read across current archive state subdirs + legacy flat.
      let latest: { mtime: number; title: string } | null = null;
      for (const entry of listArchiveContractLocations({ fs: clawFs, archiveDir: archiveContainerDir() })) {
        const relYamlPath = path.join(entry.contractRoot, CONTRACT_YAML_FILE);
        try {
          const stat = clawFs.statSync(relYamlPath);
          if (latest && stat.mtime.getTime() <= latest.mtime) continue;
          const content = clawFs.readSync(relYamlPath);
          const match = content.match(/^title:\s*["']?(.+?)["']?\s*$/m);
          if (!match) continue;
          latest = { mtime: stat.mtime.getTime(), title: match[1].slice(0, CLAW_TITLE_DISPLAY_CHARS) };
        } catch (err) {
          if (isFileNotFound(err)) continue;
          return { kind: 'error', reason: `archive contract scan failed: ${formatErr(err)}` };
        }
      }
      if (latest) return { kind: 'value', text: latest.title };
      return { kind: 'missing' };
    } catch (err) {
      return { kind: 'error', reason: `archive contract scan failed: ${formatErr(err)}` };
    }
  }

  async function readPidField(clawName: string): Promise<FieldValue> {
    const daemonDir = resolveClawDaemonDir(makeClawId(clawName));
    try {
      const pidResult = await processManager.readPid(daemonDir);
      switch (pidResult.status) {
        case 'valid':    return { kind: 'value', text: String(pidResult.pid) };
        case 'spawning': return { kind: 'value', text: 'spawning' };
        case 'missing':  return { kind: 'missing' };
        case 'io_error': case 'corrupt':  return { kind: 'error', reason: pidResult.error };
      }
    } catch (err) {
      return { kind: 'error', reason: formatErr(err) };
    }
  }

  // phase 687 (audit T2.11): 删 outer try/catch + handleCliError、外层 clawCommand (cli/index.ts:139) 已包 withCliErrorHandling
  const baseDirFs = deps.fsFactory(baseDir);
  const clawsDirName = 'claws';
  if (!baseDirFs.existsSync(clawsDirName)) {
    baseDirFs.ensureDirSync(clawsDirName);
  }
  const clawsDirFs = deps.fsFactory(clawsDir);
  const entries = enumerateClaws(clawsDirFs, '.');
  const claws: ClawEntry[] = [];
  const diagnostics: { claw: string; field: string; reason: string }[] = [];

  for (const entry of entries) {
    const clawFs = deps.fsFactory(path.join(clawsDir, entry));
    if (clawFs.existsSync(CONFIG_YAML_FILE)) {
      const isRunning = processManager.isAlive(resolveClawDaemonDir(makeClawId(entry)));

      const contractField = getContractStatus(clawFs);
      const lastContractField = getLatestContractTitle(clawFs);
      const legacyPaused = listLegacyPausedContracts(clawFs, '.');
      const pidField = await readPidField(entry);

      if (contractField.kind === 'error') diagnostics.push({ claw: entry, field: 'contract', reason: contractField.reason });
      if (lastContractField.kind === 'error') diagnostics.push({ claw: entry, field: 'lastContract', reason: lastContractField.reason });
      if (pidField.kind === 'error') diagnostics.push({ claw: entry, field: 'pid', reason: pidField.reason });

      let pid: number | undefined;
      if (pidField.kind === 'value') pid = Number(pidField.text);

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
        pidError: pidField.kind === 'error' ? pidField.reason : undefined,
        contract: formatField(contractField),
        contractError: contractField.kind === 'error' ? contractField.reason : undefined,
        outbox: getOutboxCount(clawFs),
        lastActive,
        lastActiveIso: lastMs !== undefined ? new Date(lastMs).toISOString() : null,
        lastContract: formatField(lastContractField),
        lastContractError: lastContractField.kind === 'error' ? lastContractField.reason : undefined,
        legacyPaused,
      });
    }
  }

  function printDiagnostics(): void {
    if (diagnostics.length === 0) return;
    console.error('\nDiagnostics:');
    for (const d of diagnostics) {
      console.error(`  [${d.claw}/${d.field}] ${d.reason}`);
    }
  }

  function printLegacyPaused(): void {
    const lines: string[] = [];
    for (const claw of claws) {
      if (claw.legacyPaused.length > 0) {
        const ids = claw.legacyPaused.map(r => r.contractId).join(', ');
        lines.push(`  ${claw.name}: legacy paused ${ids}`);
      }
    }
    if (lines.length === 0) return;
    console.log('\nLegacy paused contracts (read-only):');
    for (const line of lines) console.log(line);
  }

  if (opts?.summary) {
    if (claws.length === 0) {
      console.log('No claws found. Create one with: chestnut claw <name> create');
      return;
    }
    const summaries: string[] = [];
    for (const claw of claws) {
      const stats = getLatestContractStats(clawFsForClaw(claw.name), '.');
      summaries.push(formatClawSummary(claw, stats));
    }
    console.log(summaries.join('\n\n'));
    printDiagnostics();
    return;
  }

  // Helper: get a FileSystem scoped to a specific claw directory
  function clawFsForClaw(name: string): FileSystem {
    return deps.fsFactory(path.join(clawsDir, name));
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
        legacy_paused: c.legacyPaused,
      })),
      total: claws.length,
      running_count: claws.filter(c => c.status === 'running').length,
      as_of: new Date().toISOString(),
    };
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (claws.length === 0) {
    console.log('No claws found. Create one with: chestnut claw <name> create');
    return;
  }

  console.log('\nClaw List:');
  console.log('─'.repeat(112));
  console.log(`${'Name'.padEnd(20)} ${'Status'.padEnd(12)} ${'PID'.padEnd(10)} ${'Contract'.padEnd(10)} ${'Outbox'.padEnd(8)} ${'LastActive'.padEnd(10)} ${'Last Contract'.padEnd(30)}`);
  console.log('─'.repeat(112));

  for (const claw of claws) {
    const statusIcon = claw.status === 'running' ? '[running]' : '[stopped]';
    const pidStr = claw.pidError ? 'err' : (claw.pid !== undefined ? String(claw.pid) : '-');
    console.log(`${claw.name.padEnd(20)} ${statusIcon.padEnd(12)} ${pidStr.padEnd(10)} ${claw.contract.padEnd(10)} ${String(claw.outbox).padEnd(8)} ${claw.lastActive.padEnd(10)} ${claw.lastContract.padEnd(30)}`);
  }

  console.log('─'.repeat(112));
  console.log(`\nTotal: ${claws.length} claws (${claws.filter(c => c.status === 'running').length} running)\n`);
  printDiagnostics();
  printLegacyPaused();
}

/** Exported for unit testing; not part of the public CLI surface. */
export function formatClawSummary(claw: ClawEntry, stats: ContractSubtaskStats | null): string {
  const lines: string[] = [];
  lines.push(claw.name);

  const running = claw.status === 'running';
  const age = claw.lastActive;
  const ageMs = claw.lastActiveIso ? Date.now() - new Date(claw.lastActiveIso).getTime() : Infinity;
  const pid = claw.pidError ? 'PID: err' : (claw.pid !== undefined ? `PID: ${claw.pid}` : 'PID: none');

  let daemonLine: string;
  if (running) {
    if (ageMs < 5 * 60_000) {
      daemonLine = `running · last active ${age} ago · ${pid}`;
    } else {
      daemonLine = `running · last active ${age} ago (⚠ stalled) · ${pid}`;
    }
  } else {
    if (ageMs === Infinity) {
      daemonLine = `stopped · last active never · ${pid}`;
    } else if (ageMs < 5 * 60_000) {
      daemonLine = `stopped · just stopped · ${pid}`;
    } else {
      daemonLine = `stopped · last active ${age} ago · ${pid}`;
    }
  }
  lines.push(`  daemon: ${daemonLine}`);

  if (claw.contract === 'active') {
    if (running) {
      lines.push(`  current: working on "${stats?.title ?? '(unknown)'}"`);
    } else {
      const activeTitle = stats?.title ?? '(unknown)';
      lines.push(`  current: ⚠ has active contract "${activeTitle}" but daemon is stopped — needs restart`);
    }
  } else {
    if (stats === null) {
      lines.push('  current: no contract history — fresh claw');
    } else {
      lines.push('  current: idle');
    }
  }

  if (stats && stats.total > 0) {
    const title = stats.title.slice(0, 60);
    let quality: string;
    if (stats.abandoned > 0) {
      quality = `${stats.passed} passed, ${stats.forceAccepted} force-accepted, ${stats.abandoned} abandoned`;
    } else if (stats.forceAccepted === 0) {
      quality = 'all passed first attempt';
    } else if (stats.passed === 0) {
      quality = '⚠ all force-accepted (retry limit reached)';
    } else {
      quality = `${stats.passed} passed, ⚠ ${stats.forceAccepted} force-accepted (retry limit reached)`;
    }
    lines.push(`  last completed: "${title}" · completed`);
    lines.push(`    ${stats.total} subtasks — ${quality}`);
  }

  if (claw.outbox > 0) {
    lines.push(`  ⚠ ${claw.outbox} undelivered outbox messages`);
  }

  if (claw.legacyPaused && claw.legacyPaused.length > 0) {
    const ids = claw.legacyPaused.map(r => r.contractId).join(', ');
    lines.push(`  legacy paused (read-only): ${ids}`);
  }

  return lines.join('\n');
}
