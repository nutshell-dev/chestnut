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
export { sweepOrphanWatchdogs } from './orphan-sweep.js';
export { WATCHDOG_AUDIT_EVENTS, WATCHDOG_FILE_ROUTING } from './audit-events.js';
export { WATCHDOG_INBOX_MESSAGE_TYPES } from './inbox-formatter.js';
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
export {
  createWatchdogStateMigration,
  type WatchdogStateMigration,
  type WatchdogStateMigrationIntent,
  type WatchdogStateMigrationOutcome,
} from './state-migration.js';
