/**
 * @module L4.ContractSystem
 * Contract module exports
 */

import { ContractSystem, type ContractSystemDeps } from './manager.js';

export { ContractSystem, type ContractSystemDeps } from './manager.js';

// phase 767: contract event notification callback (moved from L6 Assembly)
export { createContractNotifyCallback } from './contract-notify-callback.js';
export type { ContractNotifyDeps, ContractNotifyCallback } from './contract-notify-callback.js';

// phase 1424: contract auditor exports
export { ContractAuditor, type ContractAuditorDeps, type AuditorVerdict, type AuditorDrift, type AuditRequest, type AuditOutcome, parseVerdict } from './contract-auditor.js';

// phase 465: errors barrel re-export
export {
  ContractValidationError,
  LockContentionExhaustedError,
  MultipleActiveContractsError,
  ContractCapacityError,
} from './errors.js';
// phase 482: audit-events barrel re-export (CONTRACT_AUDIT_EVENTS for evolution-system; ID/file routing constants for assembly remain deep-imported per allowlist)
export { CONTRACT_AUDIT_EVENTS } from './audit-events.js';
// phase 484: verification-types barrel re-export
export type { NotifyClawFn, VerificationGatewayResult } from './verification-types.js';

// Phase 1136 Step B: verification attempt transition types
export type {
  VerificationAttemptTransition,
  VerificationTransitionResult,
} from './verification-transition-types.js';
export { contractFootprint, type ContractFootprint, type ContractFootprintOptions } from './contract-footprint.js';
export { buildAuditorPrompt, type AuditorPromptInput } from './auditor-prompt.js';

export {
  type ProgressData,
  type VerificationResult,
  type VerifierConfig,
  type VerifierResult,
  type ContractYaml,
  type ContractCreatePolicy,
  type CreatePolicyContext,
  type CreateContractOptions,
  ContractCreatePolicyViolationError,
  ContractProgressInvariantViolatedError,
} from './types.js';

// Phase 724: expose runtime Zod schema so CLI YAML validation uses the same source of truth
export { ContractYamlSchema } from './schemas.js';

// Phase 1134: new active/current layout primitives (not wired to legacy writers yet)
export {
  CONTRACT_STAGING_DIR,
  CONTRACT_ACTIVE_CURRENT_DIR,
  CONTRACT_SUBTASKS_DIR,
} from './dirs.js';

export {
  type PersistedContractYaml,
  type SubtaskRuntimeRecord,
  type VerificationAttemptRecord,
  type SubtaskRuntimeStatus,
  type VerificationAttemptStatus,
} from './types.js';

export {
  PersistedContractYamlSchema,
  SubtaskRuntimeRecordSchema,
  VerificationAttemptRecordSchema,
} from './schemas.js';

export {
  readCurrentContractLayout,
  deriveContractAggregate,
  deriveSubtaskRetrySummary,
  projectCurrentRuntime,
  prepareContractStaging,
  commitContractStaging,
  cleanupAbandonedContractStaging,
  type CurrentContractLayout,
  type ContractAggregateStatus,
  type SubtaskRetrySummary,
  type PreparedStaging,
  type CurrentContractRuntimeView,
} from './new-layout.js';

export {
  ContractLayoutCorruptedError,
  ActiveContractSlotOccupiedError,
  ContractStagingCorruptedError,
  ContractArchiveReadError,
} from './errors.js';

export {
  readArchivePayload,
  type ArchivePayloadReadResult,
  type ArchivePayloadView,
  type ArchiveReadIssue,
  type ArchiveReadIssueCode,
} from './archive-reader.js';

export { createSubmitSubtaskTool, SUBMIT_SUBTASK_TOOL_NAME } from './tools/submit-subtask.js';

// phase 744 + 752: lightweight read-only query helpers (0-instance-dep)
export {
  hasActiveContract,
  getActiveContractTimestamp,
  getContractVerificationDir,
  listActiveContracts,
  listLegacyPausedContracts,
  getContractMetadata,
  readContractYamlLightweight,
  readArchiveProgress,
  getLatestContractStats,
} from './lightweight-query.js';
export type { ContractSummary, ContractMetadata, ContractSubtaskStats, LegacyPausedContractRef } from './lightweight-query.js';

export { collectContractEvents } from './jobs/event-collector.js';

export {
  CONTRACT_DIR,
  CONTRACT_ACTIVE_DIR,
  CONTRACT_ARCHIVE_DIR,
  PROGRESS_FILE,
  CONTRACT_YAML_FILE,
  PROGRESS_LOCK_FILE,
} from './dirs.js';

// Phase 1335 (r138 F fork): cross-module query API
export { listArchiveContracts } from './persistence.js';
export type { ArchiveContractRef } from './types.js';

// Phase 1146 Step C: structured cross-claw archive time query
export { queryArchiveContracts } from './archive-query.js';
export type {
  ArchiveTime,
  ArchiveTimeUnknownReason,
  ArchiveQueryIssue,
  ArchiveQueryIssueCode,
  ArchiveQueryFilter,
  ArchiveQueryEntry,
  ArchiveQueryResult,
} from './types.js';

export {
  readOnboardingStatus,
  type OnboardingStatus,
  type OnboardingStatusKind,
} from './onboarding-discovery.js';

/**
 * ContractSystem 工厂 —— 严格对齐 ctor 7 参数
 *
 * 输入：clawDir / clawId / fs 必填；llm / verifierScheduler 可选
 * 输出：ContractSystem 实例
 * 边界：可选参数未传时运行期能力降级（见 design/modules/l4_contract_system.md §2.a）
 * 失败：不抛；能力降级延迟到方法调用
 */
export function createContractSystem(deps: ContractSystemDeps): ContractSystem {
  return new ContractSystem(deps);
}
