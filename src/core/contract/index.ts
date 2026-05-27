/**
 * @module L4.ContractSystem
 * Contract module exports
 */

import { ContractSystem, type ContractSystemDeps } from './manager.js';

export { ContractSystem, type ContractSystemDeps } from './manager.js';

export {
  type ProgressData,
  type VerificationResult,
  type VerifierConfig,
  type VerifierResult,
  type ContractYaml,
} from './types.js';

export { createSubmitSubtaskTool, SUBMIT_SUBTASK_TOOL_NAME } from './tools/submit-subtask.js';

export { getContractCreatedMs } from './utils.js';
export { collectContractEvents } from './jobs/event-collector.js';
export * from './audit-emit.js';

export {
  CONTRACT_DIR,
  CONTRACT_ACTIVE_DIR,
  CONTRACT_PAUSED_DIR,
  CONTRACT_ARCHIVE_DIR,
} from './dirs.js';

// Phase 1335 (r138 F fork): cross-module query API
export { listArchiveContracts } from './persistence.js';
export type { ArchiveContractRef } from './types.js';

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
