/** Persisted provider configuration schema and the narrow ProviderInput projection. */
import type { LLMProviderConfig } from '../llm-provider-config-schema.js';
import type { ProviderCallDefaults } from '../types.js';
import {
  describeProviderInput,
  type ProviderInput,
} from '../provider-connection.js';

export type LLMProviderConfigContract = LLMProviderConfig;

/** Opaque, secret-safe provider identity; consumers cannot inspect L1 descriptors. */
export interface ProviderInputIdentityCapability {
  stableIdentity(input: ProviderInput): string;
  operationalIdentity(input: ProviderInput): string;
}

/** Typed persisted snake_case → candidate call-default projection; connection fields are excluded. */
export function providerCallDefaultsFromConfig(config: LLMProviderConfig): ProviderCallDefaults {
  return Object.freeze({
    ...(config.temperature !== undefined && { temperature: config.temperature }),
    ...(config.max_tokens !== undefined && { maxTokens: config.max_tokens }),
    ...(config.timeout_ms !== undefined && { timeoutMs: config.timeout_ms }),
    ...(config.thinking !== undefined && { thinking: config.thinking }),
    ...(config.thinking_mode !== undefined && { thinkingMode: config.thinking_mode }),
    ...(config.thinking_effort !== undefined && { thinkingEffort: config.thinking_effort }),
    ...(config.thinking_budget_tokens !== undefined && { thinkingBudgetTokens: config.thinking_budget_tokens }),
    ...(config.reasoning_effort !== undefined && { reasoningEffort: config.reasoning_effort }),
    ...(config.drop_thinking_blocks !== undefined && { dropThinkingBlocks: config.drop_thinking_blocks }),
  });
}

export const providerInputIdentity: ProviderInputIdentityCapability = {
  stableIdentity: input => describeProviderInput(input).stableIdentity,
  operationalIdentity: input => describeProviderInput(input).cacheKey,
};

export { THINKING_LEVELS } from '../thinking-levels.js';
export type { ThinkingLevel } from '../thinking-levels.js';
export { DEFAULT_LLM_TIMEOUT_MS } from '../defaults.js';
export { llmProviderConfigSchema, strictLLMProviderConfigSchema } from '../llm-provider-config-schema.js';
export { PROVIDER_NO_LABEL_SENTINEL } from '../llm-provider-config-schema.js';
export type { LLMProviderConfig, StrictLLMProviderConfig } from '../llm-provider-config-schema.js';
export type { ProviderInput } from '../provider-connection.js';
export type { ProviderCallDefaults } from '../types.js';
export { toProviderInput } from '../config-adapter.js';
