/**
 * @module L2a.AuditLog.Layout
 * @layer L2 基础层（AuditLog）
 * @depends 无（纯静态常量协议，零 import、零 IO）
 * @contract Phase 1288 AuditLog 磁盘资源命名空间最终布局
 *
 * AuditLog 磁盘布局唯一 owner（Phase 1288 Step B）：
 *   AUDIT_PATHS        目标布局 identity（应然路径，相对 .chestnut/ 根）
 *   AUDIT_LEGACY_PATHS legacy 输入位置（仅 migration/compat 代码可消费）
 *
 * 边界：
 * - 路径值存在于 AUDIT_PATHS 不等于对应资源已发布；audit.tsv 数据路径的
 *   生产 IO 切换是 Step C 的事，本 Step 只迁 config.yaml 与迁移 journal。
 * - 普通新写代码不得使用 AUDIT_LEGACY_PATHS。
 * - 本模块不执行任何初始化；禁止 import FileSystem / YAML / Assembly / CLI。
 */

/** layout.json 记录格式的版本身份（同时是 audit/config.yaml 的 schema_version）。 */
export const AUDIT_LAYOUT_SCHEMA_VERSION = 1;

/** 目标布局（Phase 1288 总览最终树逐项一致）。 */
export const AUDIT_PATHS = {
  root: 'audit',
  layout: 'audit/layout.json',
  config: 'audit/config.yaml',
  audit: 'audit/audit.tsv',
  migrations: 'audit/migrations',
} as const;

/** legacy 输入位置；仅允许 migration/compat 代码消费。 */
export const AUDIT_LEGACY_PATHS = {
  /** legacy 根 audit.tsv（相对 .chestnut/ 根）；Step C 才切换数据路径。 */
  audit: 'audit.tsv',
  /** legacy root YAML（.chestnut/config.yaml）中的 audit 配置段顶层键名。 */
  configSection: 'audit',
} as const;
