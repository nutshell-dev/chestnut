/**
 * @module L6.CLI.AuditConfigMigration
 * @layer L6 CLI 进程边界
 *
 * Phase 1288 Step B: audit 配置迁移协议编排（CLIProcess 角色）。
 * 两个 owner 各自执行 mutation，本模块只编排、不直接写任何文件：
 *   1. Assembly raw 读取 legacy 段（root YAML `audit:`，typed AuditConfig + source hash）
 *   2. AuditLog 写 intent（audit/migrations/<id>/intent.json）
 *   3. AuditLog exclusive publish 新配置 + 回读校验
 *   4. Assembly 原子移除 legacy 段 + 回读校验
 *   5. AuditLog 写 outcome + 发布 layout.json
 *
 * 语义（总览拍板）：
 * - 两边同值 → 继续（删 legacy 段）；两边冲突 → 保留双方并 fail-loud（抛错）；
 * - 普通启动两边皆无 → 报 missing（typed result，不静默创建）；fresh init 才创建
 *   默认配置（不在本模块，见 initWorkspaceAuditConfig + init.ts）；
 * - 中断恢复：intent 存在而 outcome 不存在 → pending → 幂等续跑；迁移 id 由
 *   legacy source hash 派生（content-derived），同输入重入收敛到同一 journal。
 */
import { getChestnutRoot } from '../core/claw-topology/index.js';
import {
  isInitialized,
  readLegacyAuditConfigSection,
  removeLegacyAuditConfigSection,
  type LegacyAuditConfigSection,
} from '../assembly/config/config-load.js';
import { getGlobalConfigPath } from '../assembly/config/global-config-path.js';
import {
  loadWorkspaceAuditConfig,
  publishMigratedWorkspaceAuditConfig,
  writeAuditMigrationIntent,
  writeAuditMigrationOutcome,
  findPendingAuditMigration,
  publishAuditLayout,
  AUDIT_LAYOUT_SCHEMA_VERSION,
  AUDIT_PATHS,
  AUDIT_LEGACY_PATHS,
  type AuditConfig,
  type AuditMigrationOutcome,
} from '../foundation/audit/index.js';
import { sha256ShortHex } from '../foundation/node-utils/index.js';
import type { FileSystem } from '../foundation/fs/index.js';

export type AuditConfigMigrationResult =
  /** root config.yaml 不存在（未初始化工作区）——不属本协议范围。 */
  | { kind: 'not-initialized' }
  /** 两边皆无 —— typed 报告，不静默创建。 */
  | { kind: 'missing' }
  /** 新配置在、legacy 段无 —— 终态，无需动作。 */
  | { kind: 'already' }
  /** 本次运行推进了迁移（含 resume 续跑完成）。 */
  | { kind: 'migrated'; migrationId: string };

function sameAuditConfig(a: AuditConfig, b: AuditConfig): boolean {
  return a.retention.max_size_mb === b.retention.max_size_mb;
}

/** content-derived 迁移 id：同 legacy 输入重入/续跑收敛到同一 journal 目录。 */
function migrationIdFor(legacy: LegacyAuditConfigSection): string {
  return `audit-config-relocation-${sha256ShortHex(legacy.sourceHash, 12)}`;
}

function writeIntentIfAbsent(
  rootFs: FileSystem,
  migrationId: string,
  legacy: LegacyAuditConfigSection,
  hasPending: boolean,
): void {
  if (hasPending) return; // intent 已在盘上（pending resume）
  writeAuditMigrationIntent(rootFs, {
    schema_version: AUDIT_LAYOUT_SCHEMA_VERSION,
    migration_id: migrationId,
    kind: 'audit-config-relocation',
    created_at: new Date().toISOString(),
    source: {
      path: getGlobalConfigPath(),
      section: AUDIT_LEGACY_PATHS.configSection,
      sha256: legacy.sourceHash,
    },
    legacy: legacy.config,
  });
}

function writeOutcome(
  rootFs: FileSystem,
  migrationId: string,
  outcome: Omit<AuditMigrationOutcome, 'schema_version' | 'migration_id' | 'completed_at'>,
): void {
  writeAuditMigrationOutcome(rootFs, {
    schema_version: AUDIT_LAYOUT_SCHEMA_VERSION,
    migration_id: migrationId,
    completed_at: new Date().toISOString(),
    ...outcome,
  });
}

/**
 * 确保 workspace audit config 迁移到位（幂等、可重入）。
 * conflict / invalid 场景抛错（fail-loud）；其余以 typed result 返回。
 */
export function ensureAuditConfigMigrated(deps: { fsFactory: (baseDir: string) => FileSystem }): AuditConfigMigrationResult {
  if (!isInitialized(deps)) return { kind: 'not-initialized' };

  const rootFs = deps.fsFactory(getChestnutRoot());
  const existing = loadWorkspaceAuditConfig(rootFs);
  if (existing.kind === 'invalid') {
    throw new Error(`Workspace audit config is invalid (${AUDIT_PATHS.config}): ${existing.message}`);
  }
  const legacy = readLegacyAuditConfigSection(deps);
  const pending = findPendingAuditMigration(rootFs);

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
      publishAuditLayout(rootFs);
    }
    return { kind: 'already' };
  }

  // 以下 legacy 必存在。
  const migrationId = pending?.migrationId ?? migrationIdFor(legacy!);

  // 两边皆在且值冲突 → journal 留证（intent + conflict outcome）后 fail-loud，双方保留
  if (existing.kind === 'ok' && !sameAuditConfig(existing.config, legacy!.config)) {
    writeIntentIfAbsent(rootFs, migrationId, legacy!, pending !== undefined);
    writeOutcome(rootFs, migrationId, {
      status: 'conflict',
      published: false,
      legacy_removed: false,
      detail:
        `legacy max_size_mb=${legacy!.config.retention.max_size_mb}, ` +
        `workspace max_size_mb=${existing.config.retention.max_size_mb}`,
    });
    throw new Error(
      `Audit config conflict: ${getGlobalConfigPath()}#${AUDIT_LEGACY_PATHS.configSection} and ` +
      `${AUDIT_PATHS.config} both exist with different values ` +
      `(legacy max_size_mb=${legacy!.config.retention.max_size_mb}, ` +
      `workspace max_size_mb=${existing.config.retention.max_size_mb}). ` +
      `Both preserved; resolve manually (migration ${migrationId}).`,
    );
  }

  // 可推进路径：仅 legacy（全量迁移）或 两边同值（crash 于 publish 后 / 续跑删 legacy）
  writeIntentIfAbsent(rootFs, migrationId, legacy!, pending !== undefined);
  let published = false;
  if (existing.kind === 'missing') {
    published = publishMigratedWorkspaceAuditConfig(rootFs, legacy!.config, legacy!.sourceHash) === 'published';
  }
  removeLegacyAuditConfigSection(deps);
  writeOutcome(rootFs, migrationId, {
    status: 'completed',
    published,
    legacy_removed: true,
  });
  publishAuditLayout(rootFs);
  return { kind: 'migrated', migrationId };
}
