/**
 * Dispatch audit event names.
 *
 * Module-owned event namespace per H1 design (phase338 / r36 α 决策).
 * 字符串值与起步态 events.ts DISPATCH_ 系列等价 / 0 漂移。
 */
export const DISPATCH_AUDIT_EVENTS = {
  LOAD_SKILLS_FAILED: 'dispatch_load_skills_failed',
  CONTRACT_DONE_NOT_FOUND: 'dispatch_contract_done_not_found',
  CONTRACT_DONE_PARSE_FAILED: 'dispatch_contract_done_parse_failed',
  CONTRACT_DONE_MISSING_FIELDS: 'dispatch_contract_done_missing_fields',
  WRITE_BY_CONTRACT_FAILED: 'dispatch_write_by_contract_failed',
  NO_DIALOG_CONTEXT: 'dispatch_no_dialog_context',
} as const;
