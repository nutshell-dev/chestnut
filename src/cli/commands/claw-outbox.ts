/**
 * @module L6.CLI.Claw.Outbox
 * Read and consume Claw outbox messages
 */

import { formatErr } from "../../foundation/node-utils/index.js";
import { getClawDir } from '../../core/claw-topology/index.js';
import { CliError } from '../errors.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import { OutboxReader } from '../../foundation/messaging/index.js';

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

  const outboxReader = new OutboxReader(clawFs, audit ?? { write: () => {} } as unknown as AuditLog);

  // Reconcile orphaned processing files back to pending before draining.
  await outboxReader.init('.');

  // Peek initial pending count for empty-check + remaining counter.
  // claimNext handles races internally; this list is best-effort.
  let initialFiles: string[] = [];
  try {
    initialFiles = await outboxReader.listClawOutboxPending('.');
  } catch (e) {
    // listClawOutboxPending swallows non-fatal errors; this catch is defensive.
    process.stderr.write(`[claw-outbox] list pending failed: ${formatErr(e)}\n`);
  }

  if (initialFiles.length === 0) {
    audit?.write(CLI_AUDIT_EVENTS.CLAW_OUTBOX_DRAIN_DONE, `claw=${name}`, `count=0`);
    console.log('outbox is empty');
    return;
  }

  // Limit number of messages read (default 1)
  const limit = options?.limit ?? 1;
  const remaining = Math.max(0, initialFiles.length - limit);

  audit?.write(CLI_AUDIT_EVENTS.CLAW_OUTBOX_DRAIN_START, `claw=${name}`, `limit=${limit}`);

  // Read and output
  const results: string[] = [];
  for (let i = 0; i < limit; i++) {
    const claimed = await outboxReader.claimNext('.');
    if (claimed.status === 'empty') break;
    if (claimed.status === 'io_error') {
      const msg = `Failed to claim next outbox message: ${claimed.error}`;
      process.stderr.write(`[claw-outbox] ${msg}\n`);
      throw new CliError(msg);
    }

    results.push(claimed.content);
    await outboxReader.markDone('.', claimed.claimPath, claimed.filename);
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
