import { llmProviderCall } from '../../src/foundation/llm-provider/index.js';
import { providerInputFromResolvedConfig } from '../../src/foundation/llm-provider/provider-connection.js';
import type { ProviderConfig } from '../../src/foundation/llm-provider/types.js';
import {
  handleForProvider,
  legacyProviderFactory,
  type ProviderConnection,
  type ProviderInput,
} from '../foundation/llm-orchestrator/provider-test-fixtures.js';

export type { ProviderConnection, ProviderInput };
type ProviderFactory = llmProviderCall.ProviderFactory;
type LLMProvider = llmProviderCall.LLMProvider;

/** Convert the legacy test config shape at the shared test boundary only. */
export function testProviderConnection(config: ProviderConfig): ProviderConnection {
  const input = providerInputFromResolvedConfig(config);
  return Object.assign(input, {
    providerId: config.name,
    apiFormat: config.apiFormat ?? config.catalogResolution?.wire.api ?? 'unknown',
    defaults: {
      temperature: config.temperature,
      timeoutMs: config.timeoutMs,
      ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
      ...(config.extraHeaders !== undefined ? { extraHeaders: config.extraHeaders } : {}),
      ...(config.thinking !== undefined ? { thinking: config.thinking } : {}),
      ...(config.thinkingBudgetTokens !== undefined ? { thinkingBudgetTokens: config.thinkingBudgetTokens } : {}),
      ...(config.thinkingMode !== undefined ? { thinkingMode: config.thinkingMode } : {}),
      ...(config.thinkingEffort !== undefined ? { thinkingEffort: config.thinkingEffort } : {}),
      ...(config.reasoningEffort !== undefined ? { reasoningEffort: config.reasoningEffort } : {}),
      ...(config.dropThinkingBlocks !== undefined ? { dropThinkingBlocks: config.dropThinkingBlocks } : {}),
    },
  }) as ProviderConnection;
}

/** Real L1 factory for tests that exercise the provider transport through fetch. */
export const testProviderFactory: ProviderFactory = {
  create: input => llmProviderCall.createProviderFromInput(input),
};

/** Historical fake factories return adapters; adapt them only at the test DI seam. */
export function legacyTestProviderFactory(
  create: (input: ProviderConnection) => LLMProvider,
): ProviderFactory {
  return legacyProviderFactory(create);
}

export function testProviderHandle(input: ProviderInput, provider: LLMProvider) {
  return handleForProvider(input, provider);
}
