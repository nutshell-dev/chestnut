/**
 * Summon audit event names.
 *
 * Module-owned event namespace per H1 design.
 * 字符串值与起步态 events.ts DISPATCH_ 系列等价 / 0 漂移。
 */
export const SUMMON_AUDIT_EVENTS = {
  LOAD_SKILLS_FAILED: 'summon_load_skills_failed',
  CONTRACT_DONE_NOT_FOUND: 'summon_contract_done_not_found',
  CONTRACT_DONE_PARSE_FAILED: 'summon_contract_done_parse_failed',
  CONTRACT_DONE_MISSING_FIELDS: 'summon_contract_done_missing_fields',
  WRITE_BY_CONTRACT_FAILED: 'summon_write_by_contract_failed',
  NO_DIALOG_CONTEXT: 'summon_no_dialog_context',
  RETRO_INDEX_PARSE_FAILED: 'retro_index_parse_failed',
} as const;
