/**
 * @module L6.CLI.Claw.Outbox
 * Read and consume Claw outbox messages
 */

import * as path from 'path';
import { formatErr } from "../../foundation/utils/index.js";
import { UUID_SHORT_LEN } from '../../constants.js';
import { randomUUID } from 'crypto';
import { getClawDir } from '../../foundation/config/index.js';
import { CliError } from '../errors.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import { MESSAGING_AUDIT_EVENTS, OUTBOX_PENDING_DIR, OUTBOX_PROCESSING_DIR, OUTBOX_DONE_DIR } from '../../foundation/messaging/index.js';

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
      `Expected at {CHESTNUT_ROOT}/.chestnut/claws/<name>/.`
    );
  }

  // Read pending files
  let files: string[] = [];
  try {
    const allFiles = (await clawFs.list(OUTBOX_PENDING_DIR)).map(e => e.name);
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

  await clawFs.ensureDir(OUTBOX_PROCESSING_DIR);

  // Read and output
  const results: string[] = [];
  for (const fileName of toRead) {
    const relPendingPath = path.join(OUTBOX_PENDING_DIR, fileName);
    const claimToken = `cli_${process.pid}_${Date.now()}_${randomUUID().slice(0, UUID_SHORT_LEN)}`;
    const relClaimedPath = path.join(OUTBOX_PROCESSING_DIR, `${claimToken}_${fileName}`);

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
      console.warn(`[outbox] Failed to claim ${fileName}: ${formatErr(err)}`);
      continue;
    }

    try {
      const content = await clawFs.read(relClaimedPath);
      results.push(content);

      // Move to done/
      try {
        await clawFs.ensureDir(OUTBOX_DONE_DIR);
        const relDonePath = path.join(OUTBOX_DONE_DIR, `${Date.now()}_${fileName}`);
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
          `error=${formatErr(err)}`,
        );
        console.warn(`[outbox] Failed to move ${fileName} to done: ${formatErr(err)}`);
      }
    } catch (err) {
      console.warn(`[outbox] Failed to read ${fileName}: ${formatErr(err)}`);
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
