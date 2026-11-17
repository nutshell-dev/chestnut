/**
 * @module L6.Watchdog
 * Single public production surface. Implementation and test hooks stay internal.
 *
 * Phase 1878 Step J: 主 loop 退出 barrel——只由 watchdog-entry 内部启动
 * （外部经 entry 面，不可绕过 crash handler 与进程启动协议）。
 */
export { ensureWatchdog, WatchdogOrphanInspectionError, type EnsureWatchdogResult } from './ensure.js';
export type {
  WatchdogRecoveryWindow,
  WatchdogCandidateAdmission,
  WatchdogCandidateAdmissionResult,
} from './candidate-recovery.js';
export {
  getWatchdogPid,
  inspectWatchdogLivenessForCli,
  removeWatchdogPid,
  WatchdogPidForeignWorkspaceError,
} from './watchdog-pid.js';
export { getWatchdogEntryPath } from './watchdog-context.js';
export { inspectWatchdogHealth } from './health.js';
// Phase 1878 Step I: 全局 audit writer get/set 面退役；CLI action 经窄能力取得
// writer 并自行 dispose（daemon 进程 own 语义不经 barrel）。
export { createWatchdogActionAudit, type WatchdogActionAudit } from './audit-wiring.js';
export { spawnWatchdogCandidate, WatchdogCandidateAdmissionRejectedError } from './spawn.js';
export { stopWatchdog, type WatchdogStopOutcome } from './watchdog-control.js';
export { sweepOrphanWatchdogs, inspectOrphanWatchdogs } from './orphan-sweep.js';
export { WATCHDOG_AUDIT_EVENTS, WATCHDOG_FILE_ROUTING } from './audit-events.js';
export { WATCHDOG_LOG_HINT } from './watchdog-log.js';
export { WATCHDOG_INBOX_MESSAGE_TYPES } from './inbox-formatter.js';
export type { WatchdogProcessDeps } from './types.js';
export type {
  ClawsDirectoryObservation,
  ClawsSupervisionState,
  DirectoryEvidence,
  SupervisionCoverage,
} from './claws-observation.js';
export type {
  WatchdogOrphanSweepOutcome,
  WatchdogOrphanInspectionReport,
  WatchdogOrphanDecision,
} from './orphan-sweep.js';
// phase 1890 Step J：迁移协议实体（config-migration-journal/migration/
// state-migration/legacy-retirement）退役删除；fresh init 直调 live 创建面。
export {
  initWorkspaceWatchdogConfig,
  publishWatchdogLayout,
  loadWorkspaceWatchdogConfig,
} from './workspace-config.js';
