/**
 * @module L2b.LLMOrchestrator
 * LLM Orchestrator module (L2) — multi-provider fault-tolerant orchestration
 *
 * Exports: LLMOrchestrator interface, LLMOrchestratorImpl implementation,
 *          createLLMOrchestrator factory
 */

import type { LLMOrchestratorConfig, LLMOrchestrator } from './types.js';

export { LLMOrchestratorImpl } from './orchestrator.js';
export type {
  LLMOrchestratorConfig,
  LLMEventSink,
  LLMEvent,
  StreamChunk,
  LLMCallOptions,
  ProviderConfig,
  ProviderAdapter,
  LLMOrchestrator,
} from './types.js';

// phase 461: llm-provider-config-schema barrel re-export (M#7 接口稳定)
export { llmProviderConfigSchema, FORMAT_MAP } from './llm-provider-config-schema.js';
export type { LLMProviderConfig } from './llm-provider-config-schema.js';

import { LLMOrchestratorImpl } from './orchestrator.js';

export function createLLMOrchestrator(config: LLMOrchestratorConfig): LLMOrchestrator {
  return new LLMOrchestratorImpl(config);
}

export {
  DEFAULT_LLM_IDLE_TIMEOUT_MS,
  INIT_LLM_IDLE_TIMEOUT_MS,
  DEFAULT_LLM_TIMEOUT_MS,
  DEFAULT_RESET_TIMEOUT_MS,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_LLM_RETRY_ATTEMPTS,
} from './defaults.js';

// phase 1416: errors.ts 精准 export caller 实际需求 symbol。
// 不 wholesale 全 export errors.ts 防 transitive load 重演 phase 1413 stop-orphan-* test mock 教训
// （barrel re-export 拉 errors.ts → llm-provider/errors.js cascade、test 若 total mock
// errors.ts 内 symbol 会漏）。如 future caller 需更多 symbol、按需逐个 append。
// SDK 顶层 re-export (src/index.ts) + sister L2 (foundation/config/schemas.ts) 按 by-design
// 保留 deep import、depcruise rule 显式 pathNot allowlist 这两 entry。
export { LLMAllProvidersFailedError, LLMTimeoutError, LLMContextExceededError, classifyLLMError } from './errors.js';
export type { LLMErrorClass } from './errors.js';

