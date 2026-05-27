/**
 * @module L6.CLI.Claw.Outbox
 * Read and consume Claw outbox messages
 */

import * as path from 'path';
import { randomUUID } from 'crypto';
import { getClawDir } from '../../foundation/config/index.js';
import { CliError } from '../errors.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import { MESSAGING_AUDIT_EVENTS } from '../../foundation/messaging/audit-events.js';

export async function outboxCommand(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  name: string,
  options?: { limit?: number },
  opts?: { audit?: AuditLog },
): Promise<void> {
  const audit = opts?.audit;
  // Outbox drain is a pure filesystem operation — we don't require config.yaml.
  // Motion's outbox scanner reports any claw dir containing pending/*.md, so the
  // CLI must be able to drain the same set, including orphan claws that have
  // outbox files but no config (e.g. abandoned or half-created claws).
  const clawDir = getClawDir(name);
  const clawFs = deps.fsFactory(clawDir);
  if (!clawFs.existsSync('.')) {
    throw new CliError(
      `Claw directory not found: ${clawDir}. ` +
      `Expected at {CLAWFORUM_ROOT}/.clawforum/claws/<name>/.`
    );
  }

  // Read pending files
  let files: string[] = [];
  try {
    const allFiles = (await clawFs.list(path.join('outbox', 'pending'))).map(e => e.name);
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

  await clawFs.ensureDir(path.join('outbox', 'processing'));

  // Read and output
  const results: string[] = [];
  for (const fileName of toRead) {
    const relPendingPath = path.join('outbox', 'pending', fileName);
    const claimToken = `cli_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const relClaimedPath = path.join('outbox', 'processing', `${claimToken}_${fileName}`);

    try {
      // ATOMIC CLAIM: winner-takes-all via OS rename
      await clawFs.move(relPendingPath, relClaimedPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        audit?.write(CLI_AUDIT_EVENTS.CLAW_OUTBOX_DRAIN_RACE_LOST,
          `claw=${name}`, `file=${fileName}`);
        continue;
      }
      console.warn(`[outbox] Failed to claim ${fileName}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    try {
      const content = await clawFs.read(relClaimedPath);
      results.push(content);

      // Move to done/
      try {
        await clawFs.ensureDir(path.join('outbox', 'done'));
        const relDonePath = path.join('outbox', 'done', `${Date.now()}_${fileName}`);
        await clawFs.move(relClaimedPath, relDonePath);
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
