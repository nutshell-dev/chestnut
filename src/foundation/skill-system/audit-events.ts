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
  VERSION_EDIT_BEGAN: 'skill_version_edit_began',               // Phase 1919 Step C: 分支编辑事务开启（含 retry 派生）
  VERSION_EDIT_RETRIED: 'skill_version_edit_retried',           // Phase 1919 Step C: 冲突编辑从最新版本重做（链接 parentEditId）
  VERSION_EDIT_PUBLISHED: 'skill_version_edit_published',       // Phase 1919 Step C: 编辑事务条件发布成功
  VERSION_EDIT_CONFLICT: 'skill_version_edit_conflict',         // Phase 1919 Step C: 编辑事务路径基准过期（候选保留）
  VERSION_EDIT_CANCELLED: 'skill_version_edit_cancelled',       // Phase 1919 Step C: 编辑事务取消（可保存内容已先保存）
  VERSION_EDIT_VALIDATION_FAILED: 'skill_version_edit_validation_failed', // Phase 1919 Step C: 候选 SKILL.md 缺失/非法（候选保留）
} as const;
