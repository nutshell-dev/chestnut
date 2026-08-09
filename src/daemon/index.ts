/**
 * @module L6.Daemon
 * Daemon module barrel
 */
export {
  DAEMON_LOG,
  DAEMON_FALLBACK_TIMEOUT_MS,
  STARTUP_CHECK_COOLDOWN_MS,
  INTERRUPT_POLL_INTERVAL_MS,
  INTERRUPT_POLL_WARN_EVERY,
  INTERRUPT_POLL_MAX_ERRORS,
  INTERRUPT_POLL_RECOVERY_BACKOFF_MS,
} from './constants.js';

export { DAEMON_AUDIT_EVENTS } from './audit-events.js';
export type { DaemonAuditEvent } from './audit-events.js';

// phase 1243 Step B: Daemon inbox message type declarations（external contribution to Assembly）
export { DAEMON_INBOX_MESSAGE_TYPES } from './inbox-formatter.js';

export { DAEMON_FILE_ROUTING } from './audit-events.js';
export { resolveDaemonEntry } from './entry-resolver.js';
