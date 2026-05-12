/**
 * @module L6.CLI.Claw.Health
 * Claw health report
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  loadGlobalConfig, clawExists, getClawDir, getGlobalConfigPath,
} from '../../foundation/config/index.js';
import { CliError } from '../errors.js';
import { createDirContext, createProcessManagerForCLI } from '../utils/factories.js';
import { NodeFileSystem } from '../../foundation/fs/node-fs.js';
import { CONTRACT_DIR } from '../../core/contract/index.js';
import { formatRelativeTime, getLastActiveMs } from './claw-shared.js';

/**
 * Display Claw health status (reads directory in real time)
 */
export async function healthCommand(name: string): Promise<void> {
  loadGlobalConfig();

  if (!clawExists(name)) {
    throw new CliError(`Claw "${name}" does not exist`);
  }

  const clawDir = getClawDir(name);
  const globalConfigPath = getGlobalConfigPath();
  const baseDir = path.dirname(globalConfigPath);

  const processManager = createProcessManagerForCLI();
  const { audit: systemAudit } = createDirContext(baseDir);

  const isRunning = processManager.isAlive(name);

  // Read inbox/outbox pending counts in real time
  let inboxPending = 0;
  let outboxPending = 0;
  try {
    const entries = fs.readdirSync(path.join(clawDir, 'inbox', 'pending'));
    inboxPending = entries.length;
  } catch { /* directory does not exist */ }
  try {
    const entries = fs.readdirSync(path.join(clawDir, 'outbox', 'pending'));
    outboxPending = entries.length;
  } catch { /* directory does not exist */ }

  // Check contract status
  let contractStatus = 'none';
  for (const sub of ['active', 'paused']) {
    try {
      const entries = fs.readdirSync(
        path.join(clawDir, CONTRACT_DIR, sub), { withFileTypes: true }
      );
      if (entries.some(e => e.isDirectory())) {
        contractStatus = sub;
        break;
      }
    } catch { /* skip */ }
  }

  // Last active time（统一使用 stream.jsonl 指标）
  let lastActive = '-';
  const clawFs = new NodeFileSystem({ baseDir: clawDir });
  const lastMs = await getLastActiveMs(clawFs, systemAudit);
  if (lastMs !== undefined) {
    lastActive = formatRelativeTime(Date.now() - lastMs);
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
