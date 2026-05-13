/**
 * @module L4.ShadowSystem.AuditEvents
 * phase 767 NEW，shadow 工具运行时审计事件加 cache observability（D8 ratify）。
 */

export const SHADOW_AUDIT_EVENTS = {
  STARTED: 'shadow_started',
  FINISHED: 'shadow_finished',
  FAILED: 'shadow_failed',
  PREFIX_RESTORED: 'shadow_prefix_restored',
  CACHE_USAGE: 'shadow_cache_usage',
  RECURSION_REJECTED: 'shadow_recursion_rejected',
} as const;
