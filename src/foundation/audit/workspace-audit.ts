/**
 * @module L2a.AuditLog.WorkspaceAudit
 * @layer L2 基础层（AuditLog）
 *
 * Phase 1288 Step C: workspace 根审计 capability — `.chestnut/audit/audit.tsv`
 * 的唯一生产构造入口（Watchdog daemon / CLI 侧 Watchdog 操作统一经此）。
 *
 * 设计契约（Phase 1288 总览拍板）：
 * - caller 只给 fsFactory + chestnutRoot；不得传路径、maxSizeMb 或 raw config；
 * - 目标路径固定 AUDIT_PATHS.audit（audit/audit.tsv，相对 chestnutRoot）；
 * - retention 自 AuditLog 自家 config store 读取（missing → null；invalid → throw）。
 *
 * legacy 根 audit.tsv（AUDIT_LEGACY_PATHS.audit）本模块不读不写；
 * 兼容期双读/monitor 校准归 Step D。
 */
import type { FileSystem } from '../fs/index.js';
import type { AuditLog } from './types.js';
import { AuditWriter } from './writer.js';
import { AUDIT_PATHS } from './layout.js';
import { readWorkspaceAuditRetentionMaxSizeMb } from './workspace-config.js';

/**
 * 构造 workspace 根审计 writer（固定写 `audit/audit.tsv`）。
 * invalid config → throw（fail-loud，与 readWorkspaceAuditRetentionMaxSizeMb 契约一致）。
 */
export function createWorkspaceAudit(
  fsFactory: (baseDir: string) => FileSystem,
  chestnutRoot: string,
): AuditLog {
  const fs = fsFactory(chestnutRoot);
  const maxSizeMb = readWorkspaceAuditRetentionMaxSizeMb(fs);
  return new AuditWriter(fs, AUDIT_PATHS.audit, maxSizeMb);
}
