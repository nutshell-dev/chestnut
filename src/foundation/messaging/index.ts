/**
 * Messaging module (L2)
 *
 * Inbox/outbox directory management, message delivery and retrieval.
 * Dependencies: FileSystem, MessageCodec
 */

export { OutboxWriter } from './outbox-writer.js';
export type { OutboxWriteOptions } from './outbox-writer.js';

export { writeInbox, writeInboxMessage, readInboxFileMeta } from './inbox-writer.js';
export type { InboxMessageOptions } from './inbox-writer.js';

export { InboxWatcher } from './inbox-reader.js';
