// Re-export L1 provider constants (canonical owner per M#5)
export { THINKING_TOKEN_RESERVE, STREAM_MAX_DURATION_MS, STREAM_IDLE_MAX_MS } from '../llm-provider/constants.js';

/**
 * @deprecated Only used by daemon-loop, does not control orchestrator retry.
 * Orchestrator retry is configured via LLMOrchestratorConfig.maxAttempts / retryDelayMs.
 */
export const LLM_MAX_RETRIES = 3;

/**
 * @deprecated Only used by daemon-loop, does not control orchestrator retry.
 * Orchestrator retry is configured via LLMOrchestratorConfig.maxAttempts / retryDelayMs.
 */
export const LLM_RETRY_INITIAL_DELAY_MS = 30_000;

/**
 * @deprecated Only used by daemon-loop, does not control orchestrator retry.
 * Orchestrator retry is configured via LLMOrchestratorConfig.maxAttempts / retryDelayMs.
 */
export const LLM_RETRY_MAX_DELAY_MS = 300_000;
