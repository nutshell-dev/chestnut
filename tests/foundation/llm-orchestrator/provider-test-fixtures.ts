import type { llmProviderCall } from '../../../src/foundation/llm-provider/index.js';

export type ProviderConnection = llmProviderCall.ProviderConnection;
export type ProviderFactory = llmProviderCall.ProviderFactory;
export type LLMProvider = llmProviderCall.LLMProvider;

export function connection(
  providerId: string,
  patch: Partial<ProviderConnection> = {},
): ProviderConnection {
  return {
    providerId,
    model: 'mock-model',
    apiFormat: 'anthropic',
    authentication: { kind: 'api_key' as const, value: 'test', identity: 'test' },
    ...patch,
  };
}

/** Neutral adapter for tests that exercise orchestrator caching rather than provider I/O. */
export const mockProviderFactory: ProviderFactory = {
  create(connection) {
    return {
      name: connection.providerId,
      model: connection.model,
      async call() {
        return { content: [], stop_reason: 'end_turn' };
      },
      async prepareInputMeter() { throw new Error('not used by this fixture'); },
    };
  },
};
