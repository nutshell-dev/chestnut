/**
 * @module L6.CLI.Claw.Outbox
 * Read and consume Claw outbox messages
 */

import { formatErr } from "../../foundation/node-utils/index.js";
import { assertClawDirExists } from './claw-target.js';
import { CliError } from '../errors.js';
import { noopAuditLog } from '../../foundation/audit/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import { createOutboxReader } from '../../foundation/messaging/index.js';

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
  const outboxReader = createOutboxReader({ clawRoot: '.', fs, audit });

  // Degraded recovery is not a ready consumer: fail closed before claiming.
  const init = await outboxReader.init();
  if (init.kind === 'degraded') {
    throw new CliError(
      `Outbox init degraded at ${init.stage} (${init.path}): ${formatErr(init.error)}`,
      { cause: init.error },
    );
  }

  const initial = await outboxReader.listPendingResult();
  if (initial.kind === 'failed') {
    throw new CliError(`Failed to list outbox pending: ${formatErr(initial.error)}`);
  }
  const initialFiles = initial.files;

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
    const claimed = await outboxReader.claimNext();
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
    if (claimed.status === 'recovery_required') {
      // Claim is stuck in processing: read failed and rollback failed. Do NOT
      // continue draining or silently degrade — surface claim identity so the
      // operator (or restart reconcile) can settle it.
      const msg =
        `Outbox claim requires recovery: read failed (${claimed.readError}); ` +
        `rollback failed (${claimed.rollbackError}); ` +
        `file remains in processing: ${claimed.claimPath} (original: ${claimed.filename})`;
      process.stderr.write(`[claw-outbox] ${msg}\n`);
      try {
        await claimed.handle.markFailed(new Error(msg));
      } catch (settlementError) {
        throw new CliError(`${msg}; failed settlement also failed: ${formatErr(settlementError)}`);
      }
      throw new CliError(msg);
    }

    raceCount = 0;
    try {
      results.push(claimed.content);
    } catch (consumeError) {
      try {
        await claimed.markFailed(consumeError);
      } catch (settlementError) {
        throw new CliError(
          `Outbox consumption failed (${formatErr(consumeError)}); ` +
          `failed settlement also failed (${formatErr(settlementError)}); ` +
          `claim=${claimed.claimPath}`,
        );
      }
      throw new CliError(`Failed to consume outbox message: ${formatErr(consumeError)}`);
    }
    try {
      await claimed.markDone();
    } catch (settlementError) {
      throw new CliError(
        `Outbox done settlement failed for ${claimed.claimPath}: ${formatErr(settlementError)}`,
      );
    }
    successCount++;
  }

  // phase 938: calculate remaining from actual post-drain state rather than the
  // pre-drain snapshot, which is inaccurate when races or fewer messages exist.
  const remainingResult = await outboxReader.listPendingResult();
  if (remainingResult.kind === 'failed') {
    throw new CliError(`Post-drain outbox list failed: ${formatErr(remainingResult.error)}`);
  }
  return { drained: results, remaining: remainingResult.files.length };
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
  const target = assertClawDirExists(deps, name);
  const clawFs = deps.fsFactory(target.clawDir);

  audit?.write(CLI_AUDIT_EVENTS.CLAW_OUTBOX_DRAIN_START, `claw=${name}`, `limit=${options?.limit ?? 1}`);
  const { drained, remaining } = await drainOutbox(clawFs, audit ?? noopAuditLog, options);
  audit?.write(CLI_AUDIT_EVENTS.CLAW_OUTBOX_DRAIN_DONE, `claw=${name}`, `count=${drained.length}`, `remaining=${remaining}`);

  printOutboxResults(drained, remaining);
}
