/**
 * Messaging 资源命名空间 const (M#3 single owner)
 *
 * Previously in foundation/paths.ts — moved to canonical module owner.
 */
import * as path from 'path';

export const INBOX_PENDING_DIR = 'inbox/pending';
export const INBOX_DONE_DIR = 'inbox/done';
export const INBOX_FAILED_DIR = 'inbox/failed';
export const INBOX_INFLIGHT_DIR = 'inbox/inflight';
export const OUTBOX_PENDING_DIR = 'outbox/pending';
export const OUTBOX_DONE_DIR = 'outbox/done';
export const OUTBOX_FAILED_DIR = 'outbox/failed';
export const OUTBOX_PROCESSING_DIR = 'outbox/processing';

/**
 * Resolve dead-letter queue directory path from an inbox base directory.
 * Encapsulates the 'dead-letter' leaf name — callers don't know the subdirectory name.
 *
 * @param inboxDir — absolute path to the inbox directory (e.g., .../motion/inbox)
 * @returns absolute path to the DLQ directory (e.g., .../motion/inbox/dead-letter)
 */
export function resolveDlqDir(inboxDir: string): string {
  return path.join(inboxDir, 'dead-letter');
}
