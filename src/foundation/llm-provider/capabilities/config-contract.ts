/** Persisted provider configuration schema and the narrow ProviderInput projection. */
import type { LLMProviderConfig } from '../llm-provider-config-schema.js';
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

export const providerInputIdentity: ProviderInputIdentityCapability = {
  stableIdentity: input => describeProviderInput(input).stableIdentity,
  operationalIdentity: input => describeProviderInput(input).cacheKey,
};

export { THINKING_LEVELS } from '../thinking-levels.js';
export type { ThinkingLevel } from '../thinking-levels.js';
export { DEFAULT_LLM_TIMEOUT_MS } from '../defaults.js';
export { llmProviderConfigSchema } from '../llm-provider-config-schema.js';
export { PROVIDER_NO_LABEL_SENTINEL } from '../llm-provider-config-schema.js';
export type { LLMProviderConfig } from '../llm-provider-config-schema.js';
export type { ProviderInput } from '../provider-connection.js';
export { toProviderInput } from '../config-adapter.js';
