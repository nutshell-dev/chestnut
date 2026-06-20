// src/core/contract/retro-audit-events.ts
/**
 * Contract retrospective audit event names.
 *
 * Module-owned event namespace（phase383 / r52 H 裁决 1+2）.
 * 字符串值保留 'contract_retro_*' 前缀 / 行为契约 0 改 / 与起步态 events.ts CONTRACT_AUDIT_EVENTS 系列等价 / 0 漂移（裁决 3）.
 *
 * 历史关联：phase338 H1 收官时 RETRO_* 与 CONTRACT_AUDIT_EVENTS 同文件 / phase383 命名空间分离.
 *
 * phase 280: 删 EVOLUTION_STATE_CROSS_SOURCE_MISMATCH / _SKIPPED（EC-1 消除）
 * 加 EVOLUTION_LEGACY_SCHEMA_MIGRATED_RESET（高水位线 migration）.
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
  // phase 253 Step A: _saveState schema invariant violated
  EVOLUTION_STATE_INVARIANT_VIOLATED: 'evolution_state_invariant_violated',
  // phase 280: legacy schema migration audit
  EVOLUTION_LEGACY_SCHEMA_MIGRATED_RESET: 'evolution_legacy_schema_migrated_reset',
  // phase 324 C5: progress.completed_at 缺失 → 拒绝推水位 / 防单坏 contract 毒化高水位
  EVOLUTION_SKIPPED_MISSING_COMPLETED_AT: 'evolution_skipped_missing_completed_at',
  // phase 450 (review-round3 §3): retroChain wait prev 超时（10 min 默认）后
  // 本次 retro 不再连累阻塞、emit STALLED audit + 进 impl（stall 后 prev 与本次并行、接受）
  RETRO_CHAIN_STALLED: 'evolution_retro_chain_stalled',
} as const;
