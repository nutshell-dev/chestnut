/**
 * @module L6.Watchdog
 * Single public production surface. Implementation and test hooks stay internal.
 *
 * Phase 1878 Step J: 主 loop 退出 barrel——只由 watchdog-entry 内部启动
 * （外部经 entry 面，不可绕过 crash handler 与进程启动协议）。
 */
export { ensureWatchdog } from './ensure.js';
export {
  getWatchdogPid,
  isWatchdogAlive,
  removeWatchdogPid,
  WatchdogPidForeignWorkspaceError,
} from './watchdog-pid.js';
export { getWatchdogEntryPath } from './watchdog-context.js';
// Phase 1878 Step I: 全局 audit writer get/set 面退役；CLI action 经窄能力取得
// writer 并自行 dispose（daemon 进程 own 语义不经 barrel）。
export { createWatchdogActionAudit, type WatchdogActionAudit } from './audit-wiring.js';
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
export {
  createWatchdogLegacyRetirement,
  type WatchdogLegacyRetirement,
} from './legacy-retirement.js';
