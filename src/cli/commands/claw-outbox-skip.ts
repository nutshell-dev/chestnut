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
import { getClawDir } from '../../foundation/claw-identity/index.js';
import { CliError } from '../errors.js';
import { noopAuditLog } from '../../foundation/audit/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import { OutboxReader } from '../../foundation/messaging/index.js';

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
  const outboxReader = new OutboxReader(fs, audit);

  // Reconcile orphaned processing files back to pending before skipping.
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
    return { skipped: [], remaining: 0 };
  }

  // Limit number of messages skipped (default 1; --all clears all pending)
  const limit = options.all === true ? Number.POSITIVE_INFINITY : (options.limit ?? 1);

  const MAX_RACE_RETRIES = 10;
  const skipped: string[] = [];
  let raceCount = 0;
  while (skipped.length < limit) {
    // phase 1748: claim without reading content — skip 不读正文
    const claimed = await outboxReader.claimNext('.', { readContent: false });
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

    raceCount = 0;
    await outboxReader.markSkipped('.', claimed.claimPath, claimed.filename);
    skipped.push(claimed.filename);
  }

  // calculate remaining from actual post-skip state rather than the
  // pre-skip snapshot, which is inaccurate when races or fewer messages exist.
  let remaining = 0;
  try {
    const remainingFiles = await outboxReader.listClawOutboxPending('.');
    remaining = remainingFiles.length;
  } catch (e) {
    // Fallback to the pre-skip snapshot minus successfully skipped messages.
    process.stderr.write(`[claw-outbox-skip] post-skip list failed: ${formatErr(e)}\n`);
    remaining = Math.max(0, initialFiles.length - skipped.length);
  }

  return { skipped, remaining };
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
  const clawDir = getClawDir(name);
  const clawFs = deps.fsFactory(clawDir);
  if (!clawFs.existsSync('.')) {
    throw new CliError(
      `Claw directory not found: ${clawDir}. ` +
      `Expected at {CHESTNUT_ROOT}/.chestnut/claws/<name>/.`
    );
  }

  const modeCol = options.all === true ? 'all=true' : `limit=${options.limit ?? 1}`;
  audit?.write(CLI_AUDIT_EVENTS.CLAW_OUTBOX_SKIP_START, `claw=${name}`, modeCol);
  const { skipped, remaining } = await skipOutbox(clawFs, audit ?? noopAuditLog, options);
  audit?.write(CLI_AUDIT_EVENTS.CLAW_OUTBOX_SKIP_DONE, `claw=${name}`, `count=${skipped.length}`, `remaining=${remaining}`);

  printOutboxSkipResults(skipped, remaining);
}
