/**
 * @module L6.CLI.Claw.List
 * List all claws + status
 */

import * as path from 'path';
import { resolveClawDaemonDir } from '../../core/claw-topology/index.js';
import { loadGlobalConfig } from '../../assembly/config/config-load.js';
import { getGlobalConfigPath } from '../../assembly/config/global-config-path.js';
import { createDirContext } from '../../foundation/audit/index.js';
import { createProcessManagerForCLI } from '../../foundation/process-manager/index.js';
import { makeClawId } from '../../foundation/claw-identity/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { getLatestContractStats, CONTRACT_ACTIVE_DIR, CONTRACT_ARCHIVE_DIR, CONTRACT_YAML_FILE } from '../../core/contract/index.js';
import type { ContractSubtaskStats } from '../../core/contract/index.js';
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

function formatErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
      if (!clawFs.existsSync(CONTRACT_ACTIVE_DIR)) return { kind: 'missing' };
      const entries = clawFs.listSync(CONTRACT_ACTIVE_DIR, { includeDirs: true });
      return entries.some(e => e.isDirectory)
        ? { kind: 'value', text: 'active' }
        : { kind: 'missing' };
    } catch (err) {
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

  // Helper: get latest contract title (active > paused > most recent archive)
  function getLatestContractTitle(clawFs: FileSystem): FieldValue {
    try {
      if (clawFs.existsSync(CONTRACT_ACTIVE_DIR)) {
        const activeEntries = clawFs
          .listSync(CONTRACT_ACTIVE_DIR, { includeDirs: true })
          .filter(e => e.isDirectory)
          .sort((a, b) => a.name.localeCompare(b.name));
        if (activeEntries.length > 0) {
          const yamlPath = path.join(CONTRACT_ACTIVE_DIR, activeEntries[0].name, CONTRACT_YAML_FILE);
          if (clawFs.existsSync(yamlPath)) {
            const content = clawFs.readSync(yamlPath);
            const match = content.match(/^title:\s*["']?(.+?)["']?\s*$/m);
            if (match) return { kind: 'value', text: match[1].slice(0, CLAW_TITLE_DISPLAY_CHARS) };
          }
          return { kind: 'missing' };
        }
      }
    } catch (err) {
      return { kind: 'error', reason: `active contract scan failed: ${formatErr(err)}` };
    }

    try {
      if (!clawFs.existsSync(CONTRACT_ARCHIVE_DIR)) return { kind: 'missing' };
      const dirs = clawFs.listSync(CONTRACT_ARCHIVE_DIR, { includeDirs: true }).map(e => e.name);
      let latest: { mtime: number; title: string } | null = null;
      for (const dir of dirs) {
        const relYamlPath = path.join(CONTRACT_ARCHIVE_DIR, dir, CONTRACT_YAML_FILE);
        if (!clawFs.existsSync(relYamlPath)) continue;
        const stat = clawFs.statSync(relYamlPath);
        if (latest && stat.mtime.getTime() <= latest.mtime) continue;
        const content = clawFs.readSync(relYamlPath);
        const match = content.match(/^title:\s*["']?(.+?)["']?\s*$/m);
        if (!match) continue;
        latest = { mtime: stat.mtime.getTime(), title: match[1].slice(0, CLAW_TITLE_DISPLAY_CHARS) };
      }
      if (latest) return { kind: 'value', text: latest.title };
      return { kind: 'missing' };
    } catch (err) {
      return { kind: 'error', reason: `archive contract scan failed: ${formatErr(err)}` };
    }
  }

  async function readPidField(clawName: string): Promise<FieldValue> {
    const daemonDir = resolveClawDaemonDir(makeClawId(clawName));
    if (!processManager.isAlive(daemonDir)) return { kind: 'missing' };
    try {
      const stored = await processManager.readPid(daemonDir);
      if (stored.status === 'valid') return { kind: 'value', text: String(stored.pid) };
      return { kind: 'missing' };
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
  const entries = clawsDirFs.listSync('.', { includeDirs: true }).map(e => e.name);
  const claws: ClawEntry[] = [];
  const diagnostics: { claw: string; field: string; reason: string }[] = [];

  for (const entry of entries) {
    const clawFs = deps.fsFactory(path.join(clawsDir, entry));
    if (clawFs.existsSync(CONFIG_YAML_FILE)) {
      const isRunning = processManager.isAlive(resolveClawDaemonDir(makeClawId(entry)));

      const contractField = getContractStatus(clawFs);
      const lastContractField = getLatestContractTitle(clawFs);
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
  } else if (claw.contract === 'paused') {
    lines.push('  current: paused contract');
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

  return lines.join('\n');
}
