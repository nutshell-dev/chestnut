/**
 * @module L6.CLI.Claw.OutboxSkip
 * Skip unread Claw outbox messages (archive without reading, not marked delivered)
 *
 * phase 1748：motion 对「已读但无需动作」的 outbox 消息没有不读即归档的通道，
 * 只能放任消息滞留、outbox-summary 提示持续。本命令把 pending 消息不读内容
 * 直接归档到 done/（与 delivered 同目录、信息不丢），并以独立 audit 事件
 * outbox_skipped 留痕（区别于 delivered）。
 */

import { formatErr } from "../../foundation/node-utils/index.js";
import { assertClawDirExists } from './claw-target.js';
import { CliError } from '../errors.js';
import { noopAuditLog } from '../../foundation/audit/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import { createOutboxReader } from '../../foundation/messaging/index.js';

export interface OutboxSkipOptions {
  limit?: number;
  all?: boolean;
}

/**
 * Shared outbox skip routine: init → claim (no read) → markSkipped → count remaining.
 * Caller is responsible for directory existence checks and audit lifecycle events.
 */
export async function skipOutbox(
  fs: FileSystem,
  audit: AuditLog,
  options: OutboxSkipOptions = {},
): Promise<{ skipped: string[]; remaining: number }> {
  const outboxReader = createOutboxReader({ clawRoot: '.', fs, audit });

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
    return { skipped: [], remaining: 0 };
  }

  // Limit number of messages skipped (default 1; --all clears all pending)
  const limit = options.all === true ? Number.POSITIVE_INFINITY : (options.limit ?? 1);

  const MAX_RACE_RETRIES = 10;
  const skipped: string[] = [];
  let raceCount = 0;
  while (skipped.length < limit) {
    // phase 1748: claim without reading content — skip 不读正文
    const claimed = await outboxReader.claimNext({ readContent: false });
    if (claimed.status === 'empty') break;
    if (claimed.status === 'race_lost') {
      if (++raceCount >= MAX_RACE_RETRIES) break;
      continue;
    }
    if (claimed.status === 'io_error') {
      const msg = `Failed to claim next outbox message: ${claimed.error}`;
      process.stderr.write(`[claw-outbox-skip] ${msg}\n`);
      throw new CliError(msg);
    }
    if (claimed.status === 'recovery_required') {
      // Unreachable with readContent:false today (no read, no rollback), but the
      // ClaimResult union requires explicit handling — never degrade to empty/io_error.
      const msg =
        `Outbox claim requires recovery: read failed (${claimed.readError}); ` +
        `rollback failed (${claimed.rollbackError}); ` +
        `file remains in processing: ${claimed.claimPath} (original: ${claimed.filename})`;
      process.stderr.write(`[claw-outbox-skip] ${msg}\n`);
      throw new CliError(msg);
    }

    raceCount = 0;
    try {
      await claimed.markSkipped();
    } catch (settlementError) {
      throw new CliError(
        `Outbox skip settlement failed for ${claimed.claimPath}: ${formatErr(settlementError)}`,
      );
    }
    skipped.push(claimed.filename);
  }

  // calculate remaining from actual post-skip state rather than the
  // pre-skip snapshot, which is inaccurate when races or fewer messages exist.
  const remainingResult = await outboxReader.listPendingResult();
  if (remainingResult.kind === 'failed') {
    throw new CliError(`Post-skip outbox list failed: ${formatErr(remainingResult.error)}`);
  }
  return { skipped, remaining: remainingResult.files.length };
}

/**
 * Print skipped outbox result in the shared CLI format (filenames only, no content).
 */
export function printOutboxSkipResults(skipped: string[], remaining: number): void {
  if (skipped.length === 0) {
    console.log('outbox is empty');
    return;
  }

  for (const filename of skipped) {
    console.log(`- ${filename}`);
  }

  console.log(`skipped ${skipped.length} message(s) (${remaining} remaining)`);
}

export async function outboxSkipCommand(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  name: string,
  options: OutboxSkipOptions = {},
  opts?: { audit?: AuditLog },
): Promise<void> {
  const audit = opts?.audit;
  // Outbox skip is a pure filesystem operation — we don't require config.yaml,
  // same as outboxCommand (orphan claws must be skippable by motion).
  const target = assertClawDirExists(deps, name);
  const clawFs = deps.fsFactory(target.clawDir);

  const modeCol = options.all === true ? 'all=true' : `limit=${options.limit ?? 1}`;
  audit?.write(CLI_AUDIT_EVENTS.CLAW_OUTBOX_SKIP_START, `claw=${name}`, modeCol);
  const { skipped, remaining } = await skipOutbox(clawFs, audit ?? noopAuditLog, options);
  audit?.write(CLI_AUDIT_EVENTS.CLAW_OUTBOX_SKIP_DONE, `claw=${name}`, `count=${skipped.length}`, `remaining=${remaining}`);

  printOutboxSkipResults(skipped, remaining);
}
