/**
 * @module L6.CLI.Claw.Health
 * Claw health report
 */

import * as path from 'path';
import { resolveClawDaemonDir } from '../../core/claw-topology/index.js';
import { loadGlobalConfig, clawExists } from '../../assembly/config/config-load.js';
import { getClawDir, getClawConfigPath } from '../../core/claw-topology/index.js';
import { getGlobalConfigPath } from '../../assembly/config/global-config-path.js';
import { CliError } from '../errors.js';
import { createDirContext } from '../../foundation/audit/index.js';
import { createProcessManagerForCLI } from '../../foundation/process-manager/index.js';
import { makeClawId } from '../../foundation/claw-identity/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { hasActiveContract, listLegacyPausedContracts } from '../../core/contract/index.js';
import { peekPendingCount, listOutboxPendingSync } from '../../foundation/messaging/index.js';
import { formatRelativeTime, getLastActiveMs } from './claw-shared.js';

/**
 * Display Claw health status (reads directory in real time)
 */
export async function healthCommand(deps: { fsFactory: (baseDir: string) => FileSystem }, name: string, opts?: { json?: boolean }): Promise<void> {
  loadGlobalConfig(deps);

  const configPath = getClawConfigPath(name);
  if (!clawExists(deps, configPath)) {
    throw new CliError(`Claw "${name}" does not exist`);
  }

  const clawDir = getClawDir(name);
  const globalConfigPath = getGlobalConfigPath();
  const baseDir = path.dirname(globalConfigPath);
  const clawFs = deps.fsFactory(clawDir);

  const processManager = createProcessManagerForCLI({ ...deps, baseDir });
  const { audit: systemAudit } = createDirContext(deps, baseDir);

  const isRunning = processManager.isAlive(resolveClawDaemonDir(makeClawId(name)));

  // Read inbox/outbox pending counts in real time
  // phase 858: lightweight query helpers now return Result; -1 marks I/O error
  const inboxResult = peekPendingCount(clawFs, '.');
  const inboxPending = inboxResult.ok ? inboxResult.value : -1;
  const outboxResult = listOutboxPendingSync(clawFs, '.');
  const outboxPending = outboxResult.ok ? outboxResult.value.length : -1;

  // Check contract status (current semantics: active only)
  let contractStatus = 'none';
  if (hasActiveContract(clawFs, '.')) {
    contractStatus = 'active';
  }

  // phase 1123 Step D: surface legacy paused contracts as read-only diagnostics
  const legacyPaused = listLegacyPausedContracts(clawFs, '.');

  // Last active time（统一使用 stream.jsonl 指标）
  let lastActive = '-';
  let lastActiveIso: string | null = null;
  const lastMs = await getLastActiveMs(clawFs, systemAudit);
  if (lastMs !== undefined) {
    lastActive = formatRelativeTime(Date.now() - lastMs);
    lastActiveIso = new Date(lastMs).toISOString();
  }

  if (opts?.json) {
    const payload = {
      name,
      status: isRunning ? 'running' : 'stopped',
      inbox_pending: inboxPending,
      outbox_pending: outboxPending,
      contract: contractStatus as 'active' | 'none',
      legacy_paused: legacyPaused,
      last_active: lastActiveIso,
      as_of: new Date().toISOString(),
    };
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`\nHealth Check: ${name}`);
  console.log('─'.repeat(40));
  console.log(`status: ${isRunning ? 'running' : 'stopped'}`);
  console.log(`inbox_pending: ${inboxPending}`);
  console.log(`outbox_pending: ${outboxPending}`);
  console.log(`contract: ${contractStatus}`);
  if (legacyPaused.length > 0) {
    console.log(`legacy_paused: ${legacyPaused.map(r => r.contractId).join(', ')} (read-only)`);
  }
  console.log(`last_active: ${lastActive}`);
  console.log(`as_of: ${new Date().toISOString()}`);
}
