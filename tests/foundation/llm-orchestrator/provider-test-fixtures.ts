import type { llmProviderCall } from '../../../src/foundation/llm-provider/index.js';
import {
  describeProviderConnection,
  describeProviderInput,
  providerInputFromResolvedConfig,
  type ProviderConnection as InternalProviderConnection,
} from '../../../src/foundation/llm-provider/provider-connection.js';
import type { ProviderConfig } from '../../../src/foundation/llm-provider/types.js';
import type { ApiFormat } from '../../../src/foundation/llm-provider/presets.js';

export type ProviderInput = llmProviderCall.ProviderInput;
export type ProviderFactory = llmProviderCall.ProviderFactory;
export type ProviderHandle = llmProviderCall.ProviderHandle;
export type LLMProvider = llmProviderCall.LLMProvider;

/** Legacy test metadata retained only so historical fixtures can select their fake adapter. */
export type ProviderConnection = Omit<ProviderInput, 'authentication'> & {
  readonly providerId: string;
  readonly apiFormat: string;
  readonly authentication: InternalProviderConnection['authentication'];
  readonly defaults?: InternalProviderConnection['defaults'];
};

export function connection(
  providerId: string,
  patch: Partial<ProviderConnection> = {},
): ProviderConnection {
  const authentication = patch.authentication ?? { kind: 'api_key' as const, value: 'test', identity: 'test' };
  const defaults = patch.defaults;
  const config: ProviderConfig = {
    name: patch.providerId ?? providerId,
    model: patch.model ?? 'mock-model',
    ...(patch.baseUrl !== undefined ? { baseUrl: patch.baseUrl } : {}),
    apiFormat: (patch.apiFormat ?? 'anthropic') as ApiFormat,
    ...(authentication.kind === 'api_key' ? { apiKey: authentication.value } : {}),
    authProfile: authentication.profile ?? 'api_key',
    ...(defaults?.temperature !== undefined ? { temperature: defaults.temperature } : {}),
    ...(defaults?.timeoutMs !== undefined ? { timeoutMs: defaults.timeoutMs } : {}),
    ...(defaults?.maxTokens !== undefined ? { maxTokens: defaults.maxTokens } : {}),
    ...(defaults?.extraHeaders !== undefined ? { extraHeaders: defaults.extraHeaders } : {}),
    ...(defaults?.thinking !== undefined ? { thinking: defaults.thinking } : {}),
    ...(defaults?.thinkingBudgetTokens !== undefined ? { thinkingBudgetTokens: defaults.thinkingBudgetTokens } : {}),
    ...(defaults?.thinkingMode !== undefined ? { thinkingMode: defaults.thinkingMode } : {}),
    ...(defaults?.thinkingEffort !== undefined ? { thinkingEffort: defaults.thinkingEffort } : {}),
    ...(defaults?.reasoningEffort !== undefined ? { reasoningEffort: defaults.reasoningEffort } : {}),
    ...(defaults?.dropThinkingBlocks !== undefined ? { dropThinkingBlocks: defaults.dropThinkingBlocks } : {}),
  };
  const input = providerInputFromResolvedConfig(config);
  return Object.assign(input, {
    providerId: config.name,
    apiFormat: config.apiFormat,
    authentication,
    ...(defaults !== undefined ? { defaults } : {}),
  });
}

export function descriptorFor(input: ProviderInput) {
  return 'providerId' in input && 'apiFormat' in input
    ? describeProviderConnection(input as unknown as InternalProviderConnection)
    : describeProviderInput(input);
}

/** Wrap a fake adapter in the new handle contract; legacy metadata never enters production. */
export function handleForProvider(input: ProviderInput, provider: LLMProvider): ProviderHandle {
  return { provider, descriptor: descriptorFor(input) };
}

/** Adapt a historical fake factory at the test DI boundary only. */
export function legacyProviderFactory(
  create: (input: ProviderConnection) => LLMProvider,
): ProviderFactory {
  return {
    create: input => {
      const descriptor = descriptorFor(input);
      const legacyInput = {
        ...input,
        providerId: descriptor.providerId,
        apiFormat: descriptor.protocol,
        authentication: {
          ...input.authentication,
          profile: descriptor.authProfile,
        },
        defaults: {
          ...(descriptor.timeoutMs !== undefined ? { timeoutMs: descriptor.timeoutMs } : {}),
          ...(descriptor.maxTokens !== undefined ? { maxTokens: descriptor.maxTokens } : {}),
        },
      } as ProviderConnection;
      return { provider: create(legacyInput), descriptor };
    },
  };
}

/** Neutral adapter for tests that exercise orchestrator caching rather than provider I/O. */
export const mockProviderFactory: ProviderFactory = {
  create(input) {
    const descriptor = descriptorFor(input);
    return {
      descriptor,
      provider: {
        name: descriptor.providerId,
        model: descriptor.model,
        async call() {
          return { content: [], stop_reason: 'end_turn' };
        },
        async prepareInputMeter() { throw new Error('not used by this fixture'); },
      },
    };
  },
};
