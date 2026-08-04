/**
 * Audit config schema / phase 10 decentralize
 * Owner: audit-log（audit.tsv retention yaml schema 业主）
 *
 * Phase 1288 Step B: schema 不再被 Assembly compose 进 root global config；
 * auditConfigSchema 现服务于两处：
 *   1. AuditLog 自家 config store（.chestnut/audit/config.yaml，见 workspace-config.ts）
 *   2. 迁移期 legacy root YAML `audit:` 段的 typed 读取（Assembly 代为 raw 读取后 parse）
 */
import { z } from 'zod';
import { AUDIT_LAYOUT_SCHEMA_VERSION } from './layout.js';

export const auditConfigSchema = z.object({
  retention: z.object({
    max_size_mb: z.number().min(1).nullable().default(null),
  }).default({}),
});

export type AuditConfig = z.infer<typeof auditConfigSchema>;

/**
 * .chestnut/audit/config.yaml 落盘文件 schema：业务 config + 文件版本。
 * 磁盘形态（Phase 1288 总览拍板）：
 *   schema_version: 1
 *   retention:
 *     max_size_mb: null
 */
export const auditWorkspaceConfigFileSchema = auditConfigSchema.extend({
  schema_version: z.literal(AUDIT_LAYOUT_SCHEMA_VERSION),
});

export type AuditWorkspaceConfigFile = z.infer<typeof auditWorkspaceConfigFileSchema>;

/** fresh init 默认 workspace audit config（只有 fresh init 才允许创建默认配置）。 */
export function createDefaultAuditWorkspaceConfig(): AuditWorkspaceConfigFile {
  return {
    schema_version: AUDIT_LAYOUT_SCHEMA_VERSION,
    retention: { max_size_mb: null },
  };
}
