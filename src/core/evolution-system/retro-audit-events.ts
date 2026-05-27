// src/core/contract/retro-audit-events.ts
/**
 * Contract retrospective audit event names.
 *
 * Module-owned event namespace（phase383 / r52 H 裁决 1+2）.
 * 字符串值保留 'contract_retro_*' 前缀 / 行为契约 0 改 / 与起步态 events.ts CONTRACT_RETRO_* 系列等价 / 0 漂移（裁决 3）.
 *
 * 历史关联：phase338 H1 收官时 RETRO_* 与 CONTRACT_AUDIT_EVENTS 同文件 / phase383 命名空间分离.
 */
export const RETRO_AUDIT_EVENTS = {
  // phase 1335 (r138 F fork): boot reconcile audit emit trace
  EVOLUTION_BOOT_RECONCILE: 'evolution_boot_reconcile',
  INDEX_FAILED: 'contract_retro_index_failed',
  YAML_FAILED: 'contract_retro_yaml_failed',
  SKILL_FAILED: 'contract_retro_skill_failed',
  MINING_FAILED: 'contract_retro_mining_failed',
  SCHEDULE_FAILED: 'contract_retro_schedule_failed',
  CLEANUP_FAILED: 'contract_retro_cleanup_failed',
  SKIPPED_DUPLICATE: 'retro_skipped_duplicate',
  STATE_LOAD_FAILED: 'retro_state_load_failed',
  STATE_SAVE_FAILED: 'retro_state_save_failed',
} as const;
