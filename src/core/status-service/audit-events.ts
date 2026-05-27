/**
 * Status tool audit event names.
 *
 * Module-owned event namespace per H1 design (phase338 / r36 α 决策).
 * 字符串值与起步态 events.ts STATUS_ 系列等价 / 0 漂移。
 */
export const STATUS_AUDIT_EVENTS = {
  CONTRACT_ERROR: 'status_contract_error',
  TASK_PENDING_ERROR: 'status_task_pending_error',
  TASK_RUNNING_ERROR: 'status_task_running_error',
} as const;
