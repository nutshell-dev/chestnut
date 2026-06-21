/**
 * @module L6.CLI.Claw.Health
 * Claw health report
 */

import * as path from 'path';
import { loadGlobalConfig, clawExists } from '../../assembly/config-load.js';
import { getClawDir, getGlobalConfigPath, getClawConfigPath } from '../../foundation/config/index.js';
import { CliError } from '../errors.js';
import { createDirContext } from '../../foundation/audit/index.js';
import { createProcessManagerForCLI } from '../../foundation/process-manager/index.js';
import { MOTION_CLAW_ID } from '../../core/claw-topology/index.js';
import { makeClawId } from '../../foundation/identity/index.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import { isFileNotFound } from '../../foundation/fs/types.js';
import { CONTRACT_DIR } from '../../core/contract/index.js';
import { INBOX_PENDING_DIR, OUTBOX_PENDING_DIR } from '../../foundation/messaging/index.js';
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

  const processManager = createProcessManagerForCLI({ ...deps, motionClawId: MOTION_CLAW_ID });
  const { audit: systemAudit } = createDirContext(deps, baseDir);

  const isRunning = processManager.isAlive(makeClawId(name));

  // Read inbox/outbox pending counts in real time
  let inboxPending = 0;
  let outboxPending = 0;
  try {
    const entries = clawFs.listSync(INBOX_PENDING_DIR).map(e => e.name);
    inboxPending = entries.length;
  } catch (err) {
    // phase 517: 用 isFileNotFound 兼容 FileSystem 包装层（FS_NOT_FOUND）+ 原生 fs（ENOENT）
    // phase 906 narrow 单码漏判 FS_NOT_FOUND → stopped claw 无 inbox dir 时崩
    if (!isFileNotFound(err)) throw err;
  }
  try {
    const entries = clawFs.listSync(OUTBOX_PENDING_DIR).map(e => e.name);
    outboxPending = entries.length;
  } catch (err) {
    if (!isFileNotFound(err)) throw err;
  }

  // Check contract status
  let contractStatus = 'none';
  for (const sub of ['active', 'paused']) {
    try {
      const entries = clawFs.listSync(path.join(CONTRACT_DIR, sub), { includeDirs: true });
      if (entries.some(e => e.isDirectory)) {
        contractStatus = sub;
        break;
      }
    } catch (err) {
      if (!isFileNotFound(err)) throw err;
    }
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
      contract: contractStatus as 'active' | 'paused' | 'none',
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
