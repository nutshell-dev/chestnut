// src/assembly/audit-events.ts
/**
 * Assembly audit event names.
 *
 * Module-owned event namespace per H1 design (phase375 / r51 H caller 风格并轨第 5 次复用).
 * 字符串值与起步态 inline 字面量等价 / 0 漂移。
 */
export const ASSEMBLY_AUDIT_EVENTS = {
  ASSEMBLE_FAILED: 'assemble_failed',
  ASSEMBLE_LOCK_CONFLICT: 'assemble_lock_conflict',
  DAEMON_STARTED: 'daemon_started',
  DAEMON_START: 'daemon_start',
  DAEMON_STOP: 'daemon_stop',
  DAEMON_UNCLEAN_EXIT: 'daemon_unclean_exit',
  DAEMON_CRASH: 'daemon_crash',
  CLEANUP_TEMP_FILES_FAILED: 'cleanup_temp_files_failed',
  DISASSEMBLE_STEP_FAILED: 'disassemble_step_failed',
  FALLBACK_RECONCILE_FAILED: 'assembly_fallback_reconcile_failed',
} as const;
