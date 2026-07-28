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

export { createDaemonCommand } from './daemon.js';
export type { DaemonCommandDeps } from './daemon.js';
export type { DaemonInstances } from './types.js';
