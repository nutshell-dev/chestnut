/**
 * @module L4.ContractSystem
 * Contract module exports
 */

export { ContractSystem, createContractSystem } from './manager.js';

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
export { CONTRACT_INBOX_MESSAGE_TYPES } from './inbox-formatters.js';
export { createContractObserverJob } from './jobs/contract-observer.js';
// phase 484: verification-types barrel re-export
export type { NotifyClawFn } from './verification-types.js';

export {
  type ContractId,
  type Contract,
  type ProgressData,
  type VerificationResult,
  type DerivableStatus,
  type SubtaskStatus,
  type LastFailedFeedback,
  type ContractYaml,
  type ContractCreatePolicy,
  type CreatePolicyContext,
  ContractCreatePolicyViolationError,
  makeContractId,
} from './types.js';

// Phase 724: expose runtime Zod schema so CLI YAML validation uses the same source of truth
export { ContractYamlSchema } from './schemas.js';

// Phase 1193 Step B: archive current-format payload reader primitives only.

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
} from './contract-events-guidance.js';

// phase 1262 Step A: ContractSystem-owned contract_cancelled persisted guidance codec
export {
  encodeContractCancelledGuidance,
  decodeContractCancelledGuidance,
} from './contract-cancelled-guidance.js';

export {
  CONTRACT_ACTIVE_DIR,
  CONTRACT_YAML_FILE,
} from './dirs.js';

// Phase 1335 (r138 F fork): cross-module query API
export { listArchiveContracts } from './persistence.js';

export {
  readOnboardingStatus,
  type OnboardingStatus,
} from './onboarding-discovery.js';

export { listArchiveContractLocations, archiveContainerDir } from './locations.js';
export { CONTRACT_FILE_ROUTING } from './audit-events.js';
