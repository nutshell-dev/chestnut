/**
 * @module L6.CLI.Claw.Outbox
 * Read and consume Claw outbox messages
 */

import { formatErr } from "../../foundation/node-utils/index.js";
import { getClawDir } from '../../foundation/claw-identity/index.js';
import { CliError } from '../errors.js';
import { noopAuditLog } from '../../foundation/audit/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import { OutboxReader } from '../../foundation/messaging/index.js';

export interface OutboxDrainOptions {
  limit?: number;
}

/**
 * Shared outbox drain routine: init → claim → markDone → count remaining.
 * Caller is responsible for directory existence checks and audit lifecycle events.
 */
export async function drainOutbox(
  fs: FileSystem,
  audit: AuditLog,
  options: OutboxDrainOptions = {},
): Promise<{ drained: string[]; remaining: number }> {
  const outboxReader = new OutboxReader(fs, audit);

  // Reconcile orphaned processing files back to pending before draining.
  await outboxReader.init('.');

  // Peek initial pending count for empty-check.
  // claimNext handles races internally; this list is best-effort.
  let initialFiles: string[] = [];
  try {
    initialFiles = await outboxReader.listClawOutboxPending('.');
  } catch (e) {
    throw new CliError(`Failed to list outbox pending: ${formatErr(e)}`);
  }

  if (initialFiles.length === 0) {
    return { drained: [], remaining: 0 };
  }

  // Limit number of messages read (default 1)
  const limit = options.limit ?? 1;

  // Read and output
  const MAX_RACE_RETRIES = 10;
  const results: string[] = [];
  let successCount = 0;
  let raceCount = 0;
  while (successCount < limit) {
    const claimed = await outboxReader.claimNext('.');
    if (claimed.status === 'empty') break;
    if (claimed.status === 'race_lost') {
      if (++raceCount >= MAX_RACE_RETRIES) break;
      continue;
    }
    if (claimed.status === 'io_error') {
      const msg = `Failed to claim next outbox message: ${claimed.error}`;
      process.stderr.write(`[claw-outbox] ${msg}\n`);
      throw new CliError(msg);
    }

    raceCount = 0;
    results.push(claimed.content);
    await outboxReader.markDone('.', claimed.claimPath, claimed.filename);
    successCount++;
  }

  // phase 938: calculate remaining from actual post-drain state rather than the
  // pre-drain snapshot, which is inaccurate when races or fewer messages exist.
  let remaining = 0;
  try {
    const remainingFiles = await outboxReader.listClawOutboxPending('.');
    remaining = remainingFiles.length;
  } catch (e) {
    // Fallback to the pre-drain snapshot minus successfully consumed messages.
    process.stderr.write(`[claw-outbox] post-drain list failed: ${formatErr(e)}\n`);
    remaining = Math.max(0, initialFiles.length - results.length);
  }

  return { drained: results, remaining };
}

/**
 * Print drained outbox messages in the shared CLI format.
 */
export function printOutboxResults(drained: string[], remaining: number): void {
  if (drained.length === 0) {
    console.log('outbox is empty');
    return;
  }

  for (const content of drained) {
    console.log(content);
    console.log('---');
  }

  if (remaining > 0) {
    console.log(`(${remaining} more unread message(s))`);
  }
}

export async function outboxCommand(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  name: string,
  options?: OutboxDrainOptions,
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

  audit?.write(CLI_AUDIT_EVENTS.CLAW_OUTBOX_DRAIN_START, `claw=${name}`, `limit=${options?.limit ?? 1}`);
  const { drained, remaining } = await drainOutbox(clawFs, audit ?? noopAuditLog, options);
  audit?.write(CLI_AUDIT_EVENTS.CLAW_OUTBOX_DRAIN_DONE, `claw=${name}`, `count=${drained.length}`, `remaining=${remaining}`);

  printOutboxResults(drained, remaining);
}
