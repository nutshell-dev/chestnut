/**
 * Communication module
 * Outbox writing re-exported from Messaging (L2).
 * Inbox watching remains in core/communication.
 */

// Re-export from new location (backward compat)
export { OutboxWriter } from '../../foundation/messaging/index.js';
export type { OutboxWriteOptions } from '../../foundation/messaging/index.js';

// Inbox watching stays here
export { InboxWatcher } from './inbox.js';
