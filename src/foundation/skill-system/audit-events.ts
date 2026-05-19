/**
 * @module L2.SkillSystem
 * SKILL_AUDIT_EVENTS — SkillSystem audit events const namespace（phase355 / phase345 模板）
 */

export const SKILL_AUDIT_EVENTS = {
  LOAD_FAILED: 'skill_load_failed',
  REGISTRY_LOADED: 'skill_registry_loaded',
  DUPLICATE_SKIPPED: 'skill_duplicate_skipped',
  DIR_NOT_FOUND: 'skill_dir_not_found',
} as const;
