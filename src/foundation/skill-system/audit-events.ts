/**
 * @module L2c.SkillSystem
 * SKILL_AUDIT_EVENTS — SkillSystem audit events const namespace（phase355 / phase345 模板）
 */

export const SKILL_AUDIT_EVENTS = {
  LOAD_FAILED: 'skill_load_failed',
  REGISTRY_LOADED: 'skill_registry_loaded',
  DUPLICATE_REJECTED: 'skill_duplicate_rejected',
  NAMESPACE_INVALID: 'skill_namespace_invalid',
  DIR_NOT_FOUND: 'skill_dir_not_found',
  VERSION_INVALID: 'skill_version_invalid',   // NEW phase 59 / skillsystem-auditor §P4
  RESCAN_ABORTED: 'skill_rescan_aborted',     // NEW phase 1084
  PUBLISH_IN_PROGRESS_SKIPPED: 'skill_publish_in_progress_skipped', // Phase 1913 Step C: marker 在 = 未提交，不注册半版本
  VERSION_BASELINE_CREATED: 'skill_version_baseline_created',   // Phase 1919 Step B: 旧 live 树一次性迁移为版本库 baseline
  VERSION_MIGRATION_BLOCKED: 'skill_version_migration_blocked', // Phase 1919 Step B: 旧活动 intent/marker 在场，迁移阻断留证
  VERSION_IMPORT_PUBLISHED: 'skill_version_import_published',   // Phase 1919 Step B: owner import 条件发布成功
  VERSION_IMPORT_CONFLICT: 'skill_version_import_conflict',     // Phase 1919 Step B: 晚发布者冲突（候选保留）
  VERSION_SYNC_FAILED: 'skill_version_sync_failed',             // Phase 1919 Step B: 固定版本投影同步失败（已发布事实不受影响）
} as const;
