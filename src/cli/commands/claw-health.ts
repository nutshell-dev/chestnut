/**
 * @module L6.CLI.Claw.Health
 * Claw health report
 */

import { resolveClawDaemonDir } from '../../core/claw-topology/index.js';
import { getChestnutRoot, getClawDir, getClawConfigPath } from '../../foundation/claw-identity/index.js';
import { CliError } from '../errors.js';
import { actionAuditFor } from '../action-scope.js';
import { createProcessManagerForCLI } from '../../foundation/process-manager/index.js';
import { makeClawId } from '../../foundation/claw-identity/index.js';
import { hasActiveContract } from '../../core/contract/index.js';
import { peekPendingCount, listOutboxPendingSync } from '../../foundation/messaging/index.js';
import { formatRelativeTime, getLastActiveMs } from './claw-shared.js';
import type { ClawCommandDeps } from './claw-command-deps.js';

/**
 * Display Claw health status (reads directory in real time)
 */
export async function healthCommand(deps: ClawCommandDeps, name: string, opts?: { json?: boolean }): Promise<void> {
  deps.rootConfig.loadGlobal();

  const configPath = getClawConfigPath(name);
  if (deps.rootConfig.loadClaw(configPath) === undefined) {
    throw new CliError(`Claw "${name}" does not exist`);
  }

  const clawDir = getClawDir(name);
  const baseDir = getChestnutRoot();
  const clawFs = deps.fsFactory(clawDir);

  const processManager = createProcessManagerForCLI({ ...deps, baseDir });
  const systemAudit = actionAuditFor(baseDir, deps);

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
  console.log(`last_active: ${lastActive}`);
  console.log(`as_of: ${new Date().toISOString()}`);
}
