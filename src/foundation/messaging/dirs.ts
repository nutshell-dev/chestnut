/**
 * Messaging resource layout. Callers provide a claw root; only this owner
 * derives inbox/outbox leaves.
 */
import * as path from 'path';
import type { FileSystem } from '../fs/index.js';

export const INBOX_PENDING_DIR = 'inbox/pending';
export const INBOX_INFLIGHT_DIR = 'inbox/inflight';
export const INBOX_MISROUTED_DIR = 'inbox/misrouted';
export const INBOX_DONE_DIR = 'inbox/done';
export const INBOX_FAILED_DIR = 'inbox/failed';
export const OUTBOX_PENDING_DIR = 'outbox/pending';
export const OUTBOX_DONE_DIR = 'outbox/done';
export const OUTBOX_FAILED_DIR = 'outbox/failed';
export const OUTBOX_PROCESSING_DIR = 'outbox/processing';

export interface InboxTarget {
  readonly clawRoot: string;
  readonly pendingDir: string;
  readonly inflightDir: string;
  readonly misroutedDir: string;
  readonly doneDir: string;
  readonly failedDir: string;
  readonly deadLetterDir: string;
}

/** Derive every inbox leaf from one claw root. */
export function makeInboxTarget(clawRoot: string): InboxTarget {
  return {
    clawRoot,
    pendingDir: path.join(clawRoot, INBOX_PENDING_DIR),
    inflightDir: path.join(clawRoot, INBOX_INFLIGHT_DIR),
    misroutedDir: path.join(clawRoot, INBOX_MISROUTED_DIR),
    doneDir: path.join(clawRoot, INBOX_DONE_DIR),
    failedDir: path.join(clawRoot, INBOX_FAILED_DIR),
    deadLetterDir: path.join(clawRoot, 'inbox', 'dead-letter'),
  };
}

/** Assembly-facing layout action; the directory set stays Messaging-owned. */
export function initializeMessagingLayout(
  fs: Pick<FileSystem, 'ensureDirSync'>,
  clawRoot: string,
): void {
  const inbox = makeInboxTarget(clawRoot);
  for (const dir of [
    inbox.pendingDir,
    inbox.doneDir,
    inbox.failedDir,
    path.join(clawRoot, OUTBOX_PENDING_DIR),
    path.join(clawRoot, OUTBOX_DONE_DIR),
    path.join(clawRoot, OUTBOX_FAILED_DIR),
  ]) {
    fs.ensureDirSync(dir);
  }
}
