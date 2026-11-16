import type { ApiFormat } from './presets.js';
import type { ThinkingLevel } from './thinking-levels.js';
import type { ProviderConfig, LLMProvider } from './types.js';
import { sha256Hex } from '../node-utils/index.js';
import { DEFAULT_LLM_TIMEOUT_MS } from './defaults.js';

/** Authentication material is consumed by L1; identity values must be non-secret. */
export type ProviderAuthentication =
  | {
      readonly kind: 'api_key';
      readonly value: string;
      /** Optional operational revision (for example, an L4-owned secret digest). */
      readonly identity?: string;
    }
  | {
      readonly kind: 'capability';
      readonly identity: string;
      readonly resolve: () => Promise<{ readonly accessToken: string }>;
    };

/**
 * Neutral, resolved single-provider connection. Catalog entries, credential
 * backends, artifact owners and orchestration recovery state deliberately do
 * not belong to this contract.
 */
export interface ProviderConnection {
  readonly providerId: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly apiFormat: string;
  readonly authentication: ProviderAuthentication;
  readonly defaults?: Readonly<{
    temperature?: number;
    timeoutMs?: number;
    maxTokens?: number;
    extraHeaders?: Readonly<Record<string, string>>;
    thinking?: boolean;
    thinkingBudgetTokens?: number;
    thinkingMode?: 'adaptive' | 'enabled';
    thinkingEffort?: ThinkingLevel;
    reasoningEffort?: ThinkingLevel;
    dropThinkingBlocks?: boolean;
  }>;
}

export interface ProviderFactory {
  create(connection: ProviderConnection): LLMProvider;
}

const resolvedProjections = new WeakMap<ProviderConnection, ProviderConfig>();

/**
 * L1 setup-time resolver result. The original resolved projection remains
 * private to L1 so catalog/auth/thinking behavior survives the L4/L2 boundary.
 */
export function providerConnectionFromResolvedConfig(config: ProviderConfig): ProviderConnection {
  const authentication: ProviderAuthentication = config.apiKey !== undefined
    ? { kind: 'api_key', value: config.apiKey, identity: sha256Hex(config.apiKey) }
    : {
        kind: 'capability',
        identity: `${config.authProfile ?? 'api_key'}:${config.name}`,
        resolve: () => Promise.reject(new Error('Resolved provider authentication requires the L1 factory runtime')),
      };
  const connection: ProviderConnection = {
    providerId: config.name,
    model: config.model,
    ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    apiFormat: config.apiFormat ?? config.catalogResolution?.wire.api ?? 'catalog',
    authentication,
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
  };
  resolvedProjections.set(connection, config);
  return connection;
}

/** @internal Only the L1 factory may retrieve the setup-time projection. */
export function resolvedProviderConfig(connection: ProviderConnection): ProviderConfig | undefined {
  return resolvedProjections.get(connection);
}

/** @internal Single neutral-connection to legacy adapter projection point. */
export function toInternalProviderConfig(connection: ProviderConnection): ProviderConfig {
  const auth = connection.authentication;
  return {
    name: connection.providerId,
    model: connection.model,
    ...(connection.baseUrl !== undefined ? { baseUrl: connection.baseUrl } : {}),
    apiFormat: connection.apiFormat as ApiFormat,
    ...(auth.kind === 'api_key' ? { apiKey: auth.value } : {}),
    temperature: connection.defaults?.temperature ?? 0.7,
    timeoutMs: connection.defaults?.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
    ...(connection.defaults?.maxTokens !== undefined ? { maxTokens: connection.defaults.maxTokens } : {}),
    ...(connection.defaults?.extraHeaders !== undefined
      ? { extraHeaders: { ...connection.defaults.extraHeaders } }
      : {}),
    ...(connection.defaults?.thinking !== undefined ? { thinking: connection.defaults.thinking } : {}),
    ...(connection.defaults?.thinkingBudgetTokens !== undefined
      ? { thinkingBudgetTokens: connection.defaults.thinkingBudgetTokens }
      : {}),
    ...(connection.defaults?.thinkingMode !== undefined ? { thinkingMode: connection.defaults.thinkingMode } : {}),
    ...(connection.defaults?.thinkingEffort !== undefined ? { thinkingEffort: connection.defaults.thinkingEffort } : {}),
    ...(connection.defaults?.reasoningEffort !== undefined ? { reasoningEffort: connection.defaults.reasoningEffort } : {}),
    ...(connection.defaults?.dropThinkingBlocks !== undefined
      ? { dropThinkingBlocks: connection.defaults.dropThinkingBlocks }
      : {}),
  };
}
