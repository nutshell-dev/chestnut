// src/assembly/audit-events.ts
/**
 * Assembly audit event names.
 *
 * Module-owned event namespace per H1 design (phase375 / r51 H caller 风格并轨第 5 次复用).
 * 字符串值与起步态 inline 字面量等价 / 0 漂移。
 */
export const ASSEMBLY_AUDIT_EVENTS = {
  ASSEMBLE_FAILED: 'assemble_failed',
  // phase 1873 Step J: DAEMON_START/DAEMON_CRASH 声明迁 Daemon owner（daemon/audit-events.ts）。
  DAEMON_STARTED: 'daemon_started',
  DAEMON_STOP: 'daemon_stop',
  DAEMON_UNCLEAN_EXIT: 'daemon_unclean_exit',
  CLEANUP_TEMP_FILES_FAILED: 'cleanup_temp_files_failed',
  DISASSEMBLE_STEP_FAILED: 'disassemble_step_failed',
  FALLBACK_RECONCILE_FAILED: 'assembly_fallback_reconcile_failed',
} as const;


/**
 * Phase 163 业主声明 file 归属（phase 122 §5.A + §6.7 + phase 159 模式）.
 *
 * 全 'audit'：业务事件归业务事件主 file（信噪比已通过 cron tick 分流改善）.
 */
export const ASSEMBLY_FILE_ROUTING: Readonly<Record<string, 'audit'>> = {
  assemble_failed: 'audit',
  daemon_started: 'audit',
  daemon_stop: 'audit',
  daemon_unclean_exit: 'audit',
  cleanup_temp_files_failed: 'audit',
  disassemble_step_failed: 'audit',
  assembly_fallback_reconcile_failed: 'audit',
} as const;
