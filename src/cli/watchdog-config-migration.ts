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
import { getChestnutRoot } from '../foundation/claw-identity/index.js';
import type { RootConfigLegacyMigration, RootConfigReader } from '../assembly/index.js';
import { sha256ShortHex } from '../foundation/node-utils/index.js';
import type { FileSystem } from '../foundation/fs/index.js';
import {
  createWatchdogConfigMigration,
  WATCHDOG_LEGACY_PATHS,
  type WatchdogConfig,
  type WatchdogConfigMigration,
  type WatchdogMigrationOutcome,
} from '../watchdog/index.js';

type WatchdogConfigMigrationResult =
  /** root config.yaml 不存在（未初始化工作区）——不属本协议范围。 */
  | { kind: 'not-initialized' }
  /** 两边皆无 —— typed 报告，不静默创建。 */
  | { kind: 'missing' }
  /** 新配置在、legacy 段无 —— 终态，无需动作。 */
  | { kind: 'already' }
  /** 本次运行推进了迁移（含 resume 续跑完成）。 */
  | { kind: 'migrated'; migrationId: string };

type LegacyWatchdogConfigSection = NonNullable<ReturnType<RootConfigLegacyMigration['readWatchdogSection']>>;

interface WatchdogConfigMigrationDeps {
  fsFactory(baseDir: string): FileSystem;
  rootConfig: Pick<RootConfigReader, 'isInitialized'>;
  rootConfigLegacy: Pick<RootConfigLegacyMigration, 'readWatchdogSection' | 'removeWatchdogSection'>;
}

/** content-derived 迁移 id：同 legacy 输入重入/续跑收敛到同一 journal 目录。 */
function migrationIdFor(legacy: LegacyWatchdogConfigSection): string {
  return `watchdog-config-relocation-${sha256ShortHex(legacy.sourceHash, 12)}`;
}

function writeIntentIfAbsent(
  migration: WatchdogConfigMigration,
  migrationId: string,
  legacy: LegacyWatchdogConfigSection,
  hasPending: boolean,
): void {
  if (hasPending) return; // intent 已在盘上（pending resume）
  migration.writeIntent({
    schema_version: migration.schemaVersion,
    migration_id: migrationId,
    kind: 'watchdog-config-relocation',
    created_at: new Date().toISOString(),
    source: {
      path: legacy.sourcePath,
      section: WATCHDOG_LEGACY_PATHS.configSection,
      sha256: legacy.sourceHash,
    },
    legacy: legacy.config,
    // 退役字段留证：legacy 段实际含已退役字段时设置本键（log_archive_days /
    // disk_warning_mb / claw_inactivity_timeout_ms，由 Assembly 读取面捕获）。
    ...(Object.values(legacy.retired).some((v) => v !== undefined)
      ? { retired_fields: legacy.retired }
      : {}),
  });
}

function writeOutcome(
  migration: WatchdogConfigMigration,
  migrationId: string,
  outcome: Omit<WatchdogMigrationOutcome, 'schema_version' | 'migration_id' | 'completed_at'>,
): void {
  migration.writeOutcome({
    schema_version: migration.schemaVersion,
    migration_id: migrationId,
    completed_at: new Date().toISOString(),
    ...outcome,
  });
}

function describeConfig(config: WatchdogConfig): string {
  return (
    `interval_ms=${config.interval_ms}, ` +
    `heartbeat_stale_timeout_ms=${config.heartbeat_stale_timeout_ms}`
  );
}

/**
 * 确保 workspace watchdog config 迁移到位（幂等、可重入）。
 * conflict / invalid 场景抛错（fail-loud）；其余以 typed result 返回。
 */
export function ensureWatchdogConfigMigrated(deps: WatchdogConfigMigrationDeps): WatchdogConfigMigrationResult {
  if (!deps.rootConfig.isInitialized()) return { kind: 'not-initialized' };

  const rootFs = deps.fsFactory(getChestnutRoot());
  const migration = createWatchdogConfigMigration(rootFs);
  const existing = migration.load();
  if (existing.kind === 'invalid') {
    throw new Error(`Workspace watchdog config is invalid (${migration.configPath}): ${existing.message}`);
  }
  const legacy = deps.rootConfigLegacy.readWatchdogSection();
  const pending = migration.findPending();

  // 两边皆无 → missing（resume 时发现 pending 烂尾 → 以 noop 终态收口 journal）
  if (existing.kind === 'missing' && !legacy) {
    if (pending) {
      writeOutcome(migration, pending.migrationId, {
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
      writeOutcome(migration, pending.migrationId, {
        status: 'completed',
        published: false,
        legacy_removed: true,
        detail: 'resumed after legacy removal; outcome lost in crash',
      });
      migration.finalizeLayout();
    }
    return { kind: 'already' };
  }

  // 以下 legacy 必存在。
  const migrationId = pending?.migrationId ?? migrationIdFor(legacy!);

  // 两边皆在且值冲突 → journal 留证（intent + conflict outcome）后 fail-loud，双方保留
  if (existing.kind === 'ok' && !migration.same(existing.config, legacy!.config)) {
    writeIntentIfAbsent(migration, migrationId, legacy!, pending !== undefined);
    writeOutcome(migration, migrationId, {
      status: 'conflict',
      published: false,
      legacy_removed: false,
      detail: `legacy ${describeConfig(legacy!.config)}; workspace ${describeConfig(existing.config)}`,
    });
    throw new Error(
      `Watchdog config conflict: ${legacy!.sourcePath}#${WATCHDOG_LEGACY_PATHS.configSection} and ` +
      `${migration.configPath} both exist with different values ` +
      `(legacy ${describeConfig(legacy!.config)}; workspace ${describeConfig(existing.config)}). ` +
      `Both preserved; resolve manually (migration ${migrationId}).`,
    );
  }

  // 可推进路径：仅 legacy（全量迁移）或 两边同值（crash 于 publish 后 / 续跑删 legacy）
  writeIntentIfAbsent(migration, migrationId, legacy!, pending !== undefined);
  let published = false;
  if (existing.kind === 'missing') {
    published = migration.publish(legacy!.config, legacy!.sourceHash) === 'published';
  }
  deps.rootConfigLegacy.removeWatchdogSection();
  writeOutcome(migration, migrationId, {
    status: 'completed',
    published,
    legacy_removed: true,
  });
  migration.finalizeLayout();
  return { kind: 'migrated', migrationId };
}
