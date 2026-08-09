/**
 * @module L6.CLI.WatchdogConfigMigration
 * @layer L6 CLI 进程边界
 *
 * Phase 1289 Step B: watchdog 配置迁移协议编排（CLIProcess 角色）。
 * 两个 owner 各自执行 mutation，本模块只编排、不直接写任何文件：
 *   1. Assembly raw 读取 legacy 段（root YAML `watchdog:`，typed WatchdogConfig +
 *      退役字段 log_archive_days 捕获 + source hash）
 *   2. Watchdog 写 intent（watchdog/migrations/<id>/intent.json，retired_fields 留证）
 *   3. Watchdog exclusive publish 新配置 + 回读校验
 *   4. Assembly 原子移除 legacy 段 + 回读校验
 *   5. Watchdog 写 outcome + 发布 layout.json
 *
 * 语义（总览拍板）：
 * - 两边同值 → 继续（删 legacy 段）；两边冲突 → 保留双方并 fail-loud（抛错）；
 * - 普通启动两边皆无 → 报 missing（typed result，不静默创建）；fresh init 才创建
 *   默认配置（不在本模块，见 initWorkspaceWatchdogConfig + init.ts）；
 * - 中断恢复：intent 存在而 outcome 不存在 → pending → 幂等续跑；迁移 id 由
 *   legacy source hash 派生（content-derived），同输入重入收敛到同一 journal。
 */
import { getChestnutRoot } from '../core/claw-topology/index.js';
import type { RootConfigLegacyMigration, RootConfigReader } from '../assembly/index.js';
import { getGlobalConfigPath } from '../assembly/config/global-config-path.js';
import { sha256ShortHex } from '../foundation/node-utils/index.js';
import type { FileSystem } from '../foundation/fs/index.js';
import {
  WATCHDOG_LAYOUT_SCHEMA_VERSION,
  WATCHDOG_PATHS,
  WATCHDOG_LEGACY_PATHS,
} from '../watchdog/layout.js';
import type { WatchdogConfig } from '../watchdog/config-schema.js';
import {
  loadWorkspaceWatchdogConfig,
  publishMigratedWorkspaceWatchdogConfig,
  sameWatchdogConfig,
} from '../watchdog/workspace-config.js';
import {
  writeWatchdogMigrationIntent,
  writeWatchdogMigrationOutcome,
  findPendingWatchdogMigration,
  publishWatchdogLayout,
  type WatchdogMigrationOutcome,
} from '../watchdog/config-migration-journal.js';

export type WatchdogConfigMigrationResult =
  /** root config.yaml 不存在（未初始化工作区）——不属本协议范围。 */
  | { kind: 'not-initialized' }
  /** 两边皆无 —— typed 报告，不静默创建。 */
  | { kind: 'missing' }
  /** 新配置在、legacy 段无 —— 终态，无需动作。 */
  | { kind: 'already' }
  /** 本次运行推进了迁移（含 resume 续跑完成）。 */
  | { kind: 'migrated'; migrationId: string };

type LegacyWatchdogConfigSection = NonNullable<ReturnType<RootConfigLegacyMigration['readWatchdogSection']>>;

export interface WatchdogConfigMigrationDeps {
  fsFactory(baseDir: string): FileSystem;
  rootConfig: Pick<RootConfigReader, 'isInitialized'>;
  rootConfigLegacy: Pick<RootConfigLegacyMigration, 'readWatchdogSection' | 'removeWatchdogSection'>;
}

/** content-derived 迁移 id：同 legacy 输入重入/续跑收敛到同一 journal 目录。 */
function migrationIdFor(legacy: LegacyWatchdogConfigSection): string {
  return `watchdog-config-relocation-${sha256ShortHex(legacy.sourceHash, 12)}`;
}

function writeIntentIfAbsent(
  rootFs: FileSystem,
  migrationId: string,
  legacy: LegacyWatchdogConfigSection,
  hasPending: boolean,
): void {
  if (hasPending) return; // intent 已在盘上（pending resume）
  writeWatchdogMigrationIntent(rootFs, {
    schema_version: WATCHDOG_LAYOUT_SCHEMA_VERSION,
    migration_id: migrationId,
    kind: 'watchdog-config-relocation',
    created_at: new Date().toISOString(),
    source: {
      path: getGlobalConfigPath(),
      section: WATCHDOG_LEGACY_PATHS.configSection,
      sha256: legacy.sourceHash,
    },
    legacy: legacy.config,
    // 退役字段留证：仅 legacy 段实际含 log_archive_days 时设置本键。
    ...(legacy.retired.log_archive_days !== undefined
      ? { retired_fields: { log_archive_days: legacy.retired.log_archive_days } }
      : {}),
  });
}

function writeOutcome(
  rootFs: FileSystem,
  migrationId: string,
  outcome: Omit<WatchdogMigrationOutcome, 'schema_version' | 'migration_id' | 'completed_at'>,
): void {
  writeWatchdogMigrationOutcome(rootFs, {
    schema_version: WATCHDOG_LAYOUT_SCHEMA_VERSION,
    migration_id: migrationId,
    completed_at: new Date().toISOString(),
    ...outcome,
  });
}

function describeConfig(config: WatchdogConfig): string {
  return (
    `interval_ms=${config.interval_ms}, ` +
    `disk_warning_mb=${config.disk_warning_mb}, ` +
    `claw_inactivity_timeout_ms=${config.claw_inactivity_timeout_ms}`
  );
}

/**
 * 确保 workspace watchdog config 迁移到位（幂等、可重入）。
 * conflict / invalid 场景抛错（fail-loud）；其余以 typed result 返回。
 */
export function ensureWatchdogConfigMigrated(deps: WatchdogConfigMigrationDeps): WatchdogConfigMigrationResult {
  if (!deps.rootConfig.isInitialized()) return { kind: 'not-initialized' };

  const rootFs = deps.fsFactory(getChestnutRoot());
  const existing = loadWorkspaceWatchdogConfig(rootFs);
  if (existing.kind === 'invalid') {
    throw new Error(`Workspace watchdog config is invalid (${WATCHDOG_PATHS.config}): ${existing.message}`);
  }
  const legacy = deps.rootConfigLegacy.readWatchdogSection();
  const pending = findPendingWatchdogMigration(rootFs);

  // 两边皆无 → missing（resume 时发现 pending 烂尾 → 以 noop 终态收口 journal）
  if (existing.kind === 'missing' && !legacy) {
    if (pending) {
      writeOutcome(rootFs, pending.migrationId, {
        status: 'noop',
        published: false,
        legacy_removed: false,
        detail: 'both legacy section and workspace config absent at resume',
      });
    }
    return { kind: 'missing' };
  }

  // 新配置在、legacy 段无 → 终态（pending 烂尾 = crash 于 outcome 前 → 补 outcome/layout）
  if (existing.kind === 'ok' && !legacy) {
    if (pending) {
      writeOutcome(rootFs, pending.migrationId, {
        status: 'completed',
        published: false,
        legacy_removed: true,
        detail: 'resumed after legacy removal; outcome lost in crash',
      });
      publishWatchdogLayout(rootFs);
    }
    return { kind: 'already' };
  }

  // 以下 legacy 必存在。
  const migrationId = pending?.migrationId ?? migrationIdFor(legacy!);

  // 两边皆在且值冲突 → journal 留证（intent + conflict outcome）后 fail-loud，双方保留
  if (existing.kind === 'ok' && !sameWatchdogConfig(existing.config, legacy!.config)) {
    writeIntentIfAbsent(rootFs, migrationId, legacy!, pending !== undefined);
    writeOutcome(rootFs, migrationId, {
      status: 'conflict',
      published: false,
      legacy_removed: false,
      detail: `legacy ${describeConfig(legacy!.config)}; workspace ${describeConfig(existing.config)}`,
    });
    throw new Error(
      `Watchdog config conflict: ${getGlobalConfigPath()}#${WATCHDOG_LEGACY_PATHS.configSection} and ` +
      `${WATCHDOG_PATHS.config} both exist with different values ` +
      `(legacy ${describeConfig(legacy!.config)}; workspace ${describeConfig(existing.config)}). ` +
      `Both preserved; resolve manually (migration ${migrationId}).`,
    );
  }

  // 可推进路径：仅 legacy（全量迁移）或 两边同值（crash 于 publish 后 / 续跑删 legacy）
  writeIntentIfAbsent(rootFs, migrationId, legacy!, pending !== undefined);
  let published = false;
  if (existing.kind === 'missing') {
    published = publishMigratedWorkspaceWatchdogConfig(rootFs, legacy!.config, legacy!.sourceHash) === 'published';
  }
  deps.rootConfigLegacy.removeWatchdogSection();
  writeOutcome(rootFs, migrationId, {
    status: 'completed',
    published,
    legacy_removed: true,
  });
  publishWatchdogLayout(rootFs);
  return { kind: 'migrated', migrationId };
}
