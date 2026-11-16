/** Provider configuration schema and resolved adapter contract. */
import { toProviderConfig } from '../config-adapter.js';
import type { LLMProviderConfig } from '../llm-provider-config-schema.js';
import type { ProviderConfig } from '../types.js';

export type LLMProviderConfigContract = LLMProviderConfig;
export type ResolvedProviderConfigContract = ProviderConfig;
export const resolveProviderConfig = toProviderConfig;

export { THINKING_LEVELS } from '../thinking-levels.js';
export type { ThinkingLevel } from '../thinking-levels.js';
export { DEFAULT_LLM_TIMEOUT_MS } from '../defaults.js';
export { llmProviderConfigSchema } from '../llm-provider-config-schema.js';
export type { LLMProviderConfig } from '../llm-provider-config-schema.js';
export { toProviderConfig, toProviderConnection } from '../config-adapter.js';
export { providerConnectionFromResolvedConfig } from '../provider-connection.js';
export type { ProviderConfig } from '../types.js';
