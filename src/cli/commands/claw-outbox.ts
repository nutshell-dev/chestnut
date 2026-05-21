/**
 * @module L6.CLI.Claw.Outbox
 * Read and consume Claw outbox messages
 */

import * as fs from 'fs';
import * as path from 'path';
import { getClawDir } from '../../foundation/config/index.js';
import { CliError } from '../errors.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import { MESSAGING_AUDIT_EVENTS } from '../../foundation/messaging/audit-events.js';

export async function outboxCommand(
  name: string,
  options?: { limit?: number },
  deps?: { audit?: AuditLog },
): Promise<void> {
  const audit = deps?.audit;
  // Outbox drain is a pure filesystem operation — we don't require config.yaml.
  // Motion's outbox scanner reports any claw dir containing pending/*.md, so the
  // CLI must be able to drain the same set, including orphan claws that have
  // outbox files but no config (e.g. abandoned or half-created claws).
  const clawDir = getClawDir(name);
  if (!fs.existsSync(clawDir)) {
    throw new CliError(
      `Claw directory not found: ${clawDir}. ` +
      `Expected at {CLAWFORUM_ROOT}/.clawforum/claws/<name>/.`
    );
  }

  const pendingDir = path.join(clawDir, 'outbox', 'pending');
  const doneDir = path.join(clawDir, 'outbox', 'done');

  // Read pending files
  let files: string[] = [];
  try {
    const allFiles = await fs.promises.readdir(pendingDir);
    files = allFiles.filter(f => f.endsWith('.md')).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(`[claw-outbox] readdir failed: ${(e as Error).message}\n`);
    }
    console.log('outbox is empty');
    return;
  }

  if (files.length === 0) {
    audit?.write(CLI_AUDIT_EVENTS.CLAW_OUTBOX_DRAIN_DONE, `claw=${name}`, `count=0`);
    console.log('outbox is empty');
    return;
  }

  // Limit number of messages read (default 1)
  const limit = options?.limit ?? 1;
  const toRead = files.slice(0, limit);
  const remaining = files.length - toRead.length;

  audit?.write(CLI_AUDIT_EVENTS.CLAW_OUTBOX_DRAIN_START, `claw=${name}`, `limit=${limit}`);

  // Read and output
  const results: string[] = [];
  for (const fileName of toRead) {
    const filePath = path.join(pendingDir, fileName);
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      results.push(content);

      // Move to done/
      try {
        await fs.promises.mkdir(doneDir, { recursive: true });
        await fs.promises.rename(filePath, path.join(doneDir, `${Date.now()}_${fileName}`));
        audit?.write(
          MESSAGING_AUDIT_EVENTS.OUTBOX_DELIVERED,
          `claw=${name}`,
          `file=${fileName}`,
          `deliveredAt=${Date.now()}`,
        );
      } catch (err) {
        audit?.write(
          MESSAGING_AUDIT_EVENTS.OUTBOX_DELIVERED,
          `claw=${name}`,
          `file=${fileName}`,
          `error=${err instanceof Error ? err.message : String(err)}`,
        );
        console.warn(`[outbox] Failed to move ${fileName} to done: ${err instanceof Error ? err.message : String(err)}`);
      }
    } catch (err) {
      console.warn(`[outbox] Failed to read ${fileName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Output
  for (const content of results) {
    console.log(content);
    console.log('---');
  }

  audit?.write(CLI_AUDIT_EVENTS.CLAW_OUTBOX_DRAIN_DONE, `claw=${name}`, `count=${results.length}`, `remaining=${remaining}`);

  if (remaining > 0) {
    console.log(`(${remaining} more unread message(s))`);
  }
}
