/**
 * @module L6.CLI.WatchdogStateMigration
 * @layer L6 CLI 进程边界
 *
 * Phase 1455 Step A: watchdog state 迁移协议编排（CLIProcess 角色）。
 * 与 config 迁移（Phase 1289 Step B、watchdog-config-migration.ts）同型：
 * 本模块只编排、不直接写任何业务文件——文件 IO 全部经 Watchdog owner 原语
 * （createWatchdogStateMigration）：
 *   1. Watchdog 写 intent（watchdog/migrations/<id>/intent.json）
 *   2. Watchdog publish legacy 原文 → watchdog/state.json + 回读验证
 *   3. Watchdog 写 outcome + 发布 layout.json
 *
 * 语义（Step A 拍板；Step C 收口）：
 * - 仅 legacy → 全量迁移（verbatim copy + 回读验证）；
 * - 双方皆在 → 以 journal outcome(completed) 判 already；无 completed journal
 *   且原文逐字节相同 → crash 于 publish 后/outcome 前的续跑，补 outcome 收口；
 *   原文不同 → 保留双方 fail-loud（抛错、conflict outcome 留证）；
 * - 双方皆无 → missing（typed result，不静默创建；首次 save 自建新路径）；
 * - 中断恢复：intent 存在而 outcome 不存在 → pending → 幂等续跑；迁移 id 由
 *   legacy 原文 hash 派生（content-derived），同输入重入收敛同一 journal；
 * - Phase 1455 Step C：迁移终态后清退 legacy（root watchdog-state.json 仅在
 *   outcome 回读验证后删；logs/watchdog.log 历史日志删除不归档；
 *   watchdog-subscriptions/ 0 生产使用整体清退）——幂等、存在才删。
 */
import { getChestnutRoot } from '../core/claw-topology/index.js';
import type { RootConfigReader } from '../assembly/index.js';
import { sha256ShortHex } from '../foundation/node-utils/index.js';
import type { FileSystem } from '../foundation/fs/index.js';
import {
  createWatchdogLegacyRetirement,
  createWatchdogStateMigration,
  type WatchdogLegacyRetirement,
  type WatchdogStateMigration,
  type WatchdogStateMigrationOutcome,
} from '../watchdog/index.js';

export type WatchdogStateMigrationResult =
  /** 工作区未初始化（无 root config.yaml）——不属本协议范围。 */
  | { kind: 'not-initialized' }
  /** 双方皆无 —— typed 报告，不静默创建。 */
  | { kind: 'missing' }
  /** 新路径在（迁移已完成或全新工作区已写新态）——终态，无需动作。 */
  | { kind: 'already' }
  /** 本次运行推进了迁移（含 resume 续跑完成）。 */
  | { kind: 'migrated'; migrationId: string };

interface WatchdogStateMigrationDeps {
  fsFactory(baseDir: string): FileSystem;
  rootConfig: Pick<RootConfigReader, 'isInitialized'>;
}

/** content-derived 迁移 id：同 legacy 输入重入/续跑收敛到同一 journal 目录。 */
function migrationIdFor(legacyRaw: string): string {
  return `watchdog-state-relocation-${sha256ShortHex(legacyRaw, 12)}`;
}

function writeIntentIfAbsent(
  migration: WatchdogStateMigration,
  migrationId: string,
  legacyRaw: string,
  hasPending: boolean,
): void {
  if (hasPending) return; // intent 已在盘上（pending resume）
  migration.writeIntent({
    schema_version: migration.schemaVersion,
    migration_id: migrationId,
    kind: 'watchdog-state-relocation',
    created_at: new Date().toISOString(),
    source: {
      path: migration.legacyPath,
      sha256: sha256ShortHex(legacyRaw, 12),
    },
  });
}

function writeOutcome(
  migration: WatchdogStateMigration,
  migrationId: string,
  outcome: Omit<WatchdogStateMigrationOutcome, 'schema_version' | 'migration_id' | 'completed_at'>,
): void {
  migration.writeOutcome({
    schema_version: migration.schemaVersion,
    migration_id: migrationId,
    completed_at: new Date().toISOString(),
    ...outcome,
  });
}

/**
 * Phase 1455 Step C 清退收口：log/subscriptions 在任何迁移终态后幂等清退
 * （不依赖 state 迁移状态）；state legacy 仅在 outcome 回读验证后由调用点删。
 */
function retireLegacyArtifacts(retirement: WatchdogLegacyRetirement): void {
  retirement.retireLegacyLog();
  retirement.retireLegacySubscriptions();
}

/**
 * 确保 watchdog state 迁移到 watchdog/state.json（幂等、可重入）。
 * conflict / 回读验证失败场景抛错（fail-loud）；其余以 typed result 返回。
 * 迁移终态后清退 legacy 文件（Phase 1455 Step C）。
 */
export function ensureWatchdogStateMigrated(deps: WatchdogStateMigrationDeps): WatchdogStateMigrationResult {
  if (!deps.rootConfig.isInitialized()) return { kind: 'not-initialized' };

  const rootFs = deps.fsFactory(getChestnutRoot());
  const migration = createWatchdogStateMigration(rootFs);
  const retirement = createWatchdogLegacyRetirement(rootFs);
  const newRaw = migration.readNewRaw();
  const legacyRaw = migration.readLegacyRaw();
  const pending = migration.findPending();

  // 双方皆无 → missing（resume 时发现 pending 烂尾 → 以 noop 终态收口 journal）
  if (newRaw === null && legacyRaw === null) {
    if (pending) {
      writeOutcome(migration, pending.migrationId, {
        status: 'noop',
        published: false,
        detail: 'both legacy state and workspace state absent at resume',
      });
    }
    retireLegacyArtifacts(retirement);
    return { kind: 'missing' };
  }

  // legacy 无 → 终态（pending 烂尾 = crash 于 outcome 前 → 补 outcome/layout）
  if (legacyRaw === null) {
    if (pending) {
      writeOutcome(migration, pending.migrationId, {
        status: 'completed',
        published: false,
        detail: 'resumed with workspace state present and legacy absent; outcome lost in crash',
      });
      migration.finalizeLayout();
    }
    retireLegacyArtifacts(retirement);
    return { kind: 'already' };
  }

  // 以下 legacy 必在。
  const migrationId = pending?.migrationId ?? migrationIdFor(legacyRaw);

  // 双方皆在：completed journal → 迁移后稳态；清退 legacy（Step C）
  if (newRaw !== null) {
    if (migration.hasCompleted(migrationId)) {
      retirement.retireLegacyState();
      retireLegacyArtifacts(retirement);
      return { kind: 'already' };
    }
    writeIntentIfAbsent(migration, migrationId, legacyRaw, pending !== undefined);
    if (newRaw === legacyRaw) {
      // crash 于 publish 后 / outcome 前 → 回读验证一致、补 outcome 收口
      writeOutcome(migration, migrationId, {
        status: 'completed',
        published: false,
        detail: 'resumed after publish; byte-identical read-back verified, outcome lost in crash',
      });
      migration.finalizeLayout();
      retirement.retireLegacyState();
      retireLegacyArtifacts(retirement);
      return { kind: 'migrated', migrationId };
    }
    // 无 completed journal 且原文不同 → 冲突：双方保留、fail-loud（不清退）
    writeOutcome(migration, migrationId, {
      status: 'conflict',
      published: false,
      detail: 'legacy state and workspace state differ without a completed migration journal',
    });
    throw new Error(
      `Watchdog state conflict: ${migration.legacyPath} and ${migration.statePath} both exist ` +
      `with different content and no completed migration journal. ` +
      `Both preserved; resolve manually (migration ${migrationId}).`,
    );
  }

  // 仅 legacy → 全量迁移：publish + outcome 回读验证 → 清退 legacy（Step C）
  writeIntentIfAbsent(migration, migrationId, legacyRaw, pending !== undefined);
  migration.publish(legacyRaw);
  const verifyRaw = migration.readNewRaw();
  if (verifyRaw !== legacyRaw) {
    throw new Error(
      `Watchdog state migration read-back verification failed: ${migration.statePath} ` +
      `differs from legacy source after publish (migration ${migrationId}). Both preserved.`,
    );
  }
  writeOutcome(migration, migrationId, {
    status: 'completed',
    published: true,
  });
  migration.finalizeLayout();
  retirement.retireLegacyState();
  retireLegacyArtifacts(retirement);
  return { kind: 'migrated', migrationId };
}
