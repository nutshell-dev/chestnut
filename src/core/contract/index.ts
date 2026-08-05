/**
 * @module L4.ContractSystem
 * Contract module exports
 */

import { ContractSystem, type ContractSystemDeps } from './manager.js';

export { ContractSystem } from './manager.js';

// phase 1260 Step A: ContractSystem-owned typed notification protocol
// （Step B：transport adapter 已物理归位 src/assembly/contract-notification-adapter.ts，
//   barrel 不再 export Assembly 实现）
export type {
  ContractNotification,
  ContractNotificationSink,
} from './notification.js';

// phase 1424: contract auditor exports
export { ContractAuditor } from './contract-auditor.js';

// phase 465: errors barrel re-export
export {
  ContractValidationError,
} from './errors.js';
// phase 482: audit-events barrel re-export (CONTRACT_AUDIT_EVENTS for evolution-system; ID/file routing constants for assembly remain deep-imported per allowlist)
export { CONTRACT_AUDIT_EVENTS } from './audit-events.js';
// phase 484: verification-types barrel re-export
export type { NotifyClawFn, VerificationGatewayResult } from './verification-types.js';

// Phase 1136 Step B: verification attempt transition types
export type {
  VerificationAttemptTransition,
} from './verification-transition-types.js';
export { contractFootprint, type ContractFootprint, type ContractFootprintOptions } from './contract-footprint.js';
export { buildAuditorPrompt } from './auditor-prompt.js';

export {
  type ContractId,
  type Contract,
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
  makeContractId,
} from './types.js';

// Phase 724: expose runtime Zod schema so CLI YAML validation uses the same source of truth
export { ContractYamlSchema } from './schemas.js';

// Phase 1193 Step B: archive current-format payload reader primitives only.
export { CONTRACT_SUBTASKS_DIR } from './dirs.js';

export {
  type PersistedContractYaml,
  type SubtaskRuntimeRecord,
} from './types.js';

export {
  PersistedContractYamlSchema,
  SubtaskRuntimeRecordSchema,
  VerificationAttemptRecordSchema,
} from './schemas.js';

export {
  readStrictContractLayoutAtRoot,
  projectArchivePayloadRuntime,
} from './archive-payload-layout.js';

export {
  getContractSubtasksDir,
  getContractYamlPath,
} from './archive-payload-layout.js';

export {
  ContractLayoutCorruptedError,
  ContractArchiveReadError,
} from './errors.js';

export {
  readArchivePayload,
  type ArchivePayloadView,
  type ArchiveReadIssue,
  type ArchiveReadIssueCode,
} from './archive-reader.js';

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
export type { ContractSubtaskStats, LegacyPausedContractRef } from './lightweight-query.js';

export { collectContractEvents } from './jobs/event-collector.js';

// phase 1261 Step A: ContractSystem-owned contract_events persisted guidance codec
export {
  encodeContractEventsGuidance,
  decodeContractEventsGuidance,
  type ContractEventGuidanceRef,
} from './contract-events-guidance.js';

// phase 1262 Step A: ContractSystem-owned contract_cancelled persisted guidance codec
export {
  encodeContractCancelledGuidance,
  decodeContractCancelledGuidance,
  type ContractCancelledGuidanceRef,
} from './contract-cancelled-guidance.js';

export {
  CONTRACT_ACTIVE_DIR,
  CONTRACT_ARCHIVE_DIR,
  PROGRESS_FILE,
  CONTRACT_YAML_FILE,
} from './dirs.js';

// Phase 1335 (r138 F fork): cross-module query API
export { listArchiveContracts } from './persistence.js';
export type { ArchiveContractRef } from './types.js';

// Phase 1146 Step C: structured cross-claw archive time query
export type {
  ArchiveTime,
  ArchiveQueryIssue,
  ArchiveQueryFilter,
  ArchiveQueryEntry,
  ArchiveQueryResult,
} from './types.js';

export {
  readOnboardingStatus,
  type OnboardingStatus,
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
export { listArchiveContractLocations, archiveContainerDir } from './locations.js';
export { CONTRACT_FILE_ROUTING } from './audit-events.js';
