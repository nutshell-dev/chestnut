/** Watchdog-owned configuration migration facade. */
import type { FileSystem } from '../foundation/fs/index.js';
import {
  WATCHDOG_LAYOUT_SCHEMA_VERSION,
  WATCHDOG_LEGACY_PATHS,
  WATCHDOG_PATHS,
} from './layout.js';
import { watchdogConfigSchema, type WatchdogConfig } from './config-schema.js';
import {
  initWorkspaceWatchdogConfig,
  loadWorkspaceWatchdogConfig,
  publishMigratedWorkspaceWatchdogConfig,
  sameWatchdogConfig,
} from './workspace-config.js';
import {
  findPendingWatchdogMigration,
  publishWatchdogLayout,
  writeWatchdogMigrationIntent,
  writeWatchdogMigrationOutcome,
  type WatchdogMigrationIntent,
  type WatchdogMigrationOutcome,
} from './config-migration-journal.js';

export type { WatchdogConfig, WatchdogMigrationIntent, WatchdogMigrationOutcome };
export { WATCHDOG_LEGACY_PATHS, watchdogConfigSchema };

export function createWatchdogConfigMigration(fs: FileSystem) {
  return {
    schemaVersion: WATCHDOG_LAYOUT_SCHEMA_VERSION,
    configPath: WATCHDOG_PATHS.config,
    legacySection: WATCHDOG_LEGACY_PATHS.configSection,
    load: () => loadWorkspaceWatchdogConfig(fs),
    init: () => initWorkspaceWatchdogConfig(fs),
    same: (a: WatchdogConfig, b: WatchdogConfig) => sameWatchdogConfig(a, b),
    publish: (config: WatchdogConfig, sourceHash: string) =>
      publishMigratedWorkspaceWatchdogConfig(fs, config, sourceHash),
    findPending: () => findPendingWatchdogMigration(fs),
    writeIntent: (intent: WatchdogMigrationIntent) => writeWatchdogMigrationIntent(fs, intent),
    writeOutcome: (outcome: WatchdogMigrationOutcome) => writeWatchdogMigrationOutcome(fs, outcome),
    finalizeLayout: () => publishWatchdogLayout(fs),
  } as const;
}

export type WatchdogConfigMigration = ReturnType<typeof createWatchdogConfigMigration>;
