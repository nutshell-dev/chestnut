/**
 * @module L6.Watchdog
 * Single public production surface. Implementation and test hooks stay internal.
 */
export { runWatchdogLoop } from './watchdog.js';
export { ensureWatchdog } from './ensure.js';
export {
  getWatchdogPid,
  isWatchdogAlive,
  removeWatchdogPid,
  WatchdogPidForeignWorkspaceError,
} from './watchdog-pid.js';
export {
  getWatchdogEntryPath,
  getAuditWriter,
  setAuditWriter,
} from './watchdog-context.js';
export { spawnWatchdogCandidate } from './spawn.js';
export { writeSubscription, MAX_THRESHOLD_MS } from './subscription-store.js';
export { WATCHDOG_AUDIT_EVENTS, WATCHDOG_FILE_ROUTING } from './audit-events.js';
export { WATCHDOG_INBOX_MESSAGE_TYPES } from './inbox-formatter.js';
export { decodeClawCrashedGuidance } from './claw-crashed-guidance.js';
export { decodeClawInactivityGuidance } from './claw-inactivity-guidance.js';
export type { WatchdogProcessDeps } from './types.js';
export {
  createWatchdogConfigMigration,
  WATCHDOG_LEGACY_PATHS,
  watchdogConfigSchema,
  type WatchdogConfig,
  type WatchdogConfigMigration,
  type WatchdogMigrationIntent,
  type WatchdogMigrationOutcome,
} from './migration.js';
