import { llmProviderCall, llmProviderConfigContract } from '../../src/foundation/llm-provider/index.js';

type ProviderConfig = llmProviderConfigContract.ProviderConfig;
type ProviderConnection = llmProviderCall.ProviderConnection;
type ProviderFactory = llmProviderCall.ProviderFactory;

const { providerConnectionFromResolvedConfig } = llmProviderConfigContract;
const { createProviderFromConnection } = llmProviderCall;

/** Convert the legacy test fixture shape at the shared boundary only. */
export function testProviderConnection(config: ProviderConfig): ProviderConnection {
  return providerConnectionFromResolvedConfig(config);
}

/** Real L1 factory for tests that exercise the provider transport through fetch. */
export const testProviderFactory: ProviderFactory = {
  create: (connection) => createProviderFromConnection(connection),
};
