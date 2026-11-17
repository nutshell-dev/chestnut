/** Persisted provider configuration schema and the narrow ProviderInput projection. */
import type { LLMProviderConfig } from '../llm-provider-config-schema.js';

export type LLMProviderConfigContract = LLMProviderConfig;

export { THINKING_LEVELS } from '../thinking-levels.js';
export type { ThinkingLevel } from '../thinking-levels.js';
export { DEFAULT_LLM_TIMEOUT_MS } from '../defaults.js';
export { llmProviderConfigSchema } from '../llm-provider-config-schema.js';
export type { LLMProviderConfig } from '../llm-provider-config-schema.js';
export { toProviderInput } from '../config-adapter.js';
