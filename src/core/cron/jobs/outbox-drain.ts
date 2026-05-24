/**
 * @module L5.Cron.Jobs.OutboxDrain
 * Periodic drain of claws/* outbox/pending/ → motion inbox/pending/.
 *
 * phase 1160 P0-2: revives pull channel of cross-agent messaging plane.
 * Claws write outbox messages; motion reads via this cron job (mirror
 * pattern of contract-observer).
 */

import * as path from 'path';
import { isFileNotFound, type FileSystem } from '../../../foundation/fs/types.js';
import type { AuditLog } from '../../../foundation/audit/index.js';
import { CRON_AUDIT_EVENTS } from '../audit-events.js';
import { CLAWS_DIR } from '../../../foundation/paths.js';

export interface OutboxDrainOptions {
  clawforumDir: string;        // .clawforum/ 目录
  motionInboxDir: string;      // motion inbox/pending/ 绝对路径
  fs: FileSystem;              // baseDir = clawforumDir
  audit: AuditLog;             // motion system audit
  limit?: number;              // 每 tick 每 claw 最大 drain 数（防单 claw bomb motion inbox）
}

const DEFAULT_LIMIT_PER_CLAW = 50;

export async function runOutboxDrain(opts: OutboxDrainOptions): Promise<void> {
  const { clawforumDir, motionInboxDir, fs, audit } = opts;
  const limitPerClaw = opts.limit ?? DEFAULT_LIMIT_PER_CLAW;

  // 1. scan claws/*
  const clawsDir = path.join(clawforumDir, CLAWS_DIR);
  let clawIds: string[];
  try {
    clawIds = fs.listSync(clawsDir, { includeDirs: true })
      .filter(e => e.isDirectory)
      .map(e => e.name);
  } catch (err) {
    if (isFileNotFound(err)) return; // first-run / no claws
    audit.write(CRON_AUDIT_EVENTS.OUTBOX_DRAIN_DONE,
      `total=0`, `reason=scan_failed`,
      `error=${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  audit.write(CRON_AUDIT_EVENTS.OUTBOX_DRAIN_START, `claws=${clawIds.length}`);

  let totalDrained = 0;

  for (const clawId of clawIds) {
    const outboxPending = path.join(clawsDir, clawId, 'outbox', 'pending');
    const outboxDone = path.join(clawsDir, clawId, 'outbox', 'done');

    let files: string[];
    try {
      files = fs.listSync(outboxPending, { includeDirs: false })
        .filter(e => e.name.endsWith('.md'))
        .map(e => e.name)
        .sort();
    } catch (err) {
      if (isFileNotFound(err)) continue;  // claw 无 outbox / first-run
      audit.write(CRON_AUDIT_EVENTS.OUTBOX_DRAIN_DONE,
        `claw=${clawId}`, `count=0`, `reason=list_failed`);
      continue;
    }

    if (files.length === 0) continue;

    const toRead = files.slice(0, limitPerClaw);
    for (const fileName of toRead) {
      const srcPath = path.join(outboxPending, fileName);
      const dstName = `${Date.now()}_${fileName}`;
      const dstPath = path.join(outboxDone, dstName);
      const inboxFileName = `outbox-drain-${clawId}-${Date.now()}_${fileName}`;
      const inboxPath = path.join(motionInboxDir, inboxFileName);

      try {
        const content = fs.readSync(srcPath);

        // write to motion inbox (atomic)
        await fs.ensureDir(motionInboxDir);
        await fs.writeAtomic(inboxPath, content);

        // mv pending → done
        await fs.ensureDir(outboxDone);
        await fs.move(srcPath, dstPath);

        totalDrained++;
      } catch (err) {
        audit.write(CRON_AUDIT_EVENTS.OUTBOX_DRAIN_DONE,
          `claw=${clawId}`, `file=${fileName}`, `reason=deliver_failed`,
          `error=${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  audit.write(CRON_AUDIT_EVENTS.OUTBOX_DRAIN_DONE,
    `claws=${clawIds.length}`, `total=${totalDrained}`);
}
