/**
 * @module L4.Messaging.DrainOutboxes
 * Drain pending outboxes across all claws and deliver to recipient inbox.
 * - routing destination determined by message `to:` field
 * - uses InboxWriter codec for audit emit + filename convention + priority field
 * - atomic claim via fs.move processing/ (OS-level semantics)
 * - 0 raw writeAtomic to inbox (mirror phase 1285 ack read-side model)
 */

import * as path from 'path';
import { randomUUID } from 'crypto';
import type { FileSystem } from '../fs/types.js';
import { isFileNotFound } from '../fs/types.js';
import type { AuditLog } from '../audit/index.js';
import { InboxWriter, makeInboxPath } from './inbox-writer.js';
import { decodeInbox } from './codec-inbox.js';
import { CLAWS_DIR } from '../paths.js';
import { MOTION_CLAW_ID } from '../../constants.js';

export const DEFAULT_LIMIT_PER_CLAW = 50;

export interface DrainOutboxesOptions {
  clawforumDir: string;
  fs: FileSystem;
  audit: AuditLog;
  limitPerClaw?: number;
  signal?: AbortSignal;
}

export interface DrainResult {
  delivered: number;
  failed: number;
}

export async function drainOutboxes(opts: DrainOutboxesOptions): Promise<DrainResult> {
  const { clawforumDir, fs, audit } = opts;
  const limitPerClaw = opts.limitPerClaw ?? DEFAULT_LIMIT_PER_CLAW;

  // 1. scan claws/*
  const clawsDir = path.join(clawforumDir, CLAWS_DIR);
  let clawIds: string[];
  try {
    clawIds = fs.listSync(clawsDir, { includeDirs: true })
      .filter(e => e.isDirectory)
      .map(e => e.name);
  } catch (err) {
    if (isFileNotFound(err)) {
      return { delivered: 0, failed: 0 };
    }
    throw err;
  }

  let delivered = 0;
  let failed = 0;

  for (const clawId of clawIds) {
    if (opts.signal?.aborted) break;

    const outboxPending = path.join(clawsDir, clawId, 'outbox', 'pending');
    const outboxDone = path.join(clawsDir, clawId, 'outbox', 'done');
    const processingDir = path.join(clawsDir, clawId, 'outbox', 'processing');

    let files: string[];
    try {
      files = fs.listSync(outboxPending, { includeDirs: false })
        .filter(e => e.name.endsWith('.md'))
        .map(e => e.name)
        .sort();
    } catch (err) {
      if (isFileNotFound(err)) continue;
      failed++;
      continue;
    }

    if (files.length === 0) continue;

    await fs.ensureDir(processingDir);

    const toRead = files.slice(0, limitPerClaw);
    for (const fileName of toRead) {
      if (opts.signal?.aborted) break;

      const srcPath = path.join(outboxPending, fileName);
      const claimToken = `drain_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
      const claimedPath = path.join(processingDir, `${claimToken}_${fileName}`);

      try {
        // ATOMIC CLAIM: winner-takes-all via OS rename
        await fs.move(srcPath, claimedPath);
      } catch (err) {
        if (isFileNotFound(err)) {
          // lost race → another process won / graceful skip
          continue;
        }
        failed++;
        continue;
      }

      try {
        const content = fs.readSync(claimedPath);
        const msg = decodeInbox(content);

        // routing by `to:` field
        const to = msg.to || MOTION_CLAW_ID;
        const targetInboxDir = to === MOTION_CLAW_ID
          ? path.join(clawforumDir, MOTION_CLAW_ID, 'inbox', 'pending')
          : path.join(clawsDir, to, 'inbox', 'pending');

        const inboxWriter = InboxWriter.__internal_create(fs, makeInboxPath(targetInboxDir), audit);
        await inboxWriter.write(msg);

        // mv processing → done
        await fs.ensureDir(outboxDone);
        const uniq = `${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
        const doneName = `${Date.now()}_${uniq}_${fileName}`;
        const donePath = path.join(outboxDone, doneName);
        await fs.move(claimedPath, donePath);

        delivered++;
      } catch (err) {
        // delivery failed — leave in processing for retry / manual inspection
        const reason = err instanceof Error ? err.message : String(err);
        audit.write('drain_delivery_failed', `claw=${clawId}`, `file=${fileName}`, `reason=${reason}`);
        failed++;
      }
    }
  }

  return { delivered, failed };
}
