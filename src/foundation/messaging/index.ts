/**
 * Messaging module (L2)
 *
 * Inbox/outbox directory management, message delivery and retrieval.
 * Dependencies: FileSystem, MessageCodec
 */

export { OutboxWriter } from './outbox-writer.js';
export type { OutboxWriteOptions } from './outbox-writer.js';
