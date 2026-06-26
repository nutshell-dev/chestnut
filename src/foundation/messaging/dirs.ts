/**
 * Messaging 资源命名空间 const (M#3 single owner)
 *
 * Previously in foundation/paths.ts — moved to canonical module owner.
 */
export const INBOX_PENDING_DIR = 'inbox/pending';
export const INBOX_DONE_DIR = 'inbox/done';
export const INBOX_FAILED_DIR = 'inbox/failed';
export const INBOX_INFLIGHT_DIR = 'inbox/inflight';
export const OUTBOX_PENDING_DIR = 'outbox/pending';
export const OUTBOX_DONE_DIR = 'outbox/done';
export const OUTBOX_FAILED_DIR = 'outbox/failed';
export const OUTBOX_PROCESSING_DIR = 'outbox/processing';

/** motion inbox 下的 dead letter queue 子目录（unknown destination 消息落点） */
export const DEAD_LETTER_DIR = 'dead-letter';
