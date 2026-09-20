/**
 * @module L2b.LLMOrchestrator
 * LLM Orchestrator module (L2) — multi-provider fault-tolerant orchestration
 *
 * Exports: LLMOrchestrator interface, LLMOrchestratorImpl implementation,
 *          createLLMOrchestrator factory
 */

export type {
  LLMOrchestratorConfig,
  LLMEventSink,
  LLMEvent,
  LLMCallOptions,
  LLMOrchestrator,
  LLMRuntimeCapability,
  LLMStreamChunk,
} from './types.js';

// phase 461: llm-provider-config-schema barrel re-export (M#7 接口稳定)
export { llmProviderConfigSchema, FORMAT_MAP } from './llm-provider-config-schema.js';
export type { LLMProviderConfig } from './llm-provider-config-schema.js';

export { createLLMOrchestrator } from './orchestrator.js';

// Phase 1826/1827: 恢复安排单一 owner 的公共协议 + session 工厂。
export { createRecoverySession } from './recovery.js';
export type {
  LLMRecoveryFacts,
  LLMRecoveryAdmission,
  LLMRecoveryController,
  LLMRecoverySession,
  LLMOrchestratorOwner,
  RecoveryCallScope,
  RecoveryFailureInput,
  RecoverySessionDeps,
} from './recovery.js';
export {
  LLM_RECOVERY_STATE_FILE,
  createInitialRecoveryState,
  exportLegacyRecoveryState,
  importLegacyRecoveryExport,
  loadRecoveryState,
  saveRecoveryState,
} from './recovery-state.js';
export type {
  LLMRecoveryAcceptedFactBatch,
  LLMRecoverySchedule,
  LLMRecoveryStateV1,
  LLMRecoveryBudget,
  LLMRecoveryProviderFact,
  LegacyRecoveryExport,
  LegacyRecoveryExportResult,
  LegacyRetryStateV2,
  LegacyBlockedStateV2,
} from './recovery-state.js';

export {
  DEFAULT_LLM_IDLE_TIMEOUT_MS,
  INIT_LLM_IDLE_TIMEOUT_MS,
  DEFAULT_LLM_TIMEOUT_MS,
  DEFAULT_RESET_TIMEOUT_MS,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_LLM_RETRY_ATTEMPTS,
  LLM_RECOVERY_MAX_RETRIES,
  LLM_RECOVERY_RETRY_INITIAL_DELAY_MS,
  LLM_RECOVERY_RETRY_MAX_DELAY_MS,
  LLM_RECOVERY_COOLDOWN_MS,
  LLM_RECOVERY_QUOTA_INITIAL_DELAY_MS,
  LLM_RECOVERY_QUOTA_MAX_DELAY_MS,
} from './defaults.js';

// phase 1416: errors.ts 精准 export caller 实际需求 symbol。
// 不 wholesale 全 export errors.ts 防 transitive load 重演 phase 1413 stop-orphan-* test mock 教训
// （barrel re-export 拉 errors.ts → llm-provider/errors.js cascade、test 若 total mock
// errors.ts 内 symbol 会漏）。如 future caller 需更多 symbol、按需逐个 append。
// SDK 顶层 re-export (src/index.ts) + sister L2 (foundation/config/schemas.ts) 按 by-design
// 保留 deep import、depcruise rule 显式 pathNot allowlist 这两 entry。
export { LLMAllProvidersFailedError, LLMCircuitBreakerOpenError, classifyLLMError, isContextExceededError, getUserActionHint } from './errors.js';
export type { LLMErrorClass, UserActionHint } from './errors.js';

export { toProviderConfig } from './config-adapter.js';
export { llmOrchestratorConfigSchema } from './config-schema.js';

// phase 1872 Step H: LLM 事件命名空间 + file routing 声明归 owner（原 assembly/llm-audit-events.ts）
export { LLM_AUDIT_EVENTS, LLM_ORCHESTRATOR_FILE_ROUTING } from './audit-events.js';
