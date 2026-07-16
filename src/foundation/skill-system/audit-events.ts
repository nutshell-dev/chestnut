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
} as const;
