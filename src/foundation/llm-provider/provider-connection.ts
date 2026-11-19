import { API_FORMATS, type ApiFormat } from './api-format.js';
import type { ThinkingLevel } from './thinking-levels.js';
import type { ProviderConfig, LLMProvider } from './types.js';
import { sha256Hex, sha256ShortHex } from '../node-utils/index.js';
import { DEFAULT_LLM_TIMEOUT_MS } from './defaults.js';

/** Authentication material crosses the L1 boundary; identity values are non-secret. */
export type ProviderAuthenticationInput =
  | {
      readonly kind: 'api_key';
      readonly value: string;
      readonly identity?: string;
      /** Neutral, non-secret authentication assembly category. */
      readonly profile?: 'api_key' | 'ambient' | 'oauth';
    }
  | {
      readonly kind: 'capability';
      readonly identity: string;
      /** Neutral, non-secret authentication assembly category. */
      readonly profile?: 'api_key' | 'ambient' | 'oauth';
      readonly resolve: () => Promise<{ readonly accessToken: string }>;
    };

/** @internal L1-only authentication metadata retained for catalog/runtime resolution. */
export type ProviderAuthentication =
  | (Extract<ProviderAuthenticationInput, { kind: 'api_key' }> & {
      readonly profile?: 'api_key' | 'ambient' | 'oauth';
    })
  | (Extract<ProviderAuthenticationInput, { kind: 'capability' }> & {
      readonly profile?: 'api_key' | 'ambient' | 'oauth';
    });

/** The only ordinary cross-module provider construction input. */
export interface ProviderInput {
  readonly baseUrl?: string;
  readonly model: string;
  readonly authentication: ProviderAuthenticationInput;
  readonly protocol: ApiFormat;
}

/** @internal L1 resolved connection; never part of L2/L4 configuration. */
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

/**
 * Secret-safe provider facts produced by L1. The operational fields let L2
 * preserve cache, recovery migration and probe behavior without reading the
 * internal connection or its defaults projection.
 */
export interface ProviderDescriptor {
  readonly providerId: string;
  readonly model: string;
  readonly identity: string;
  readonly cacheKey: string;
  readonly legacyIdentity: string;
  readonly stableIdentity: string;
  readonly protocol: string;
  readonly authProfile: string;
  readonly timeoutMs?: number;
  readonly maxTokens?: number;
  readonly extraHeaderNames: readonly string[];
}

export interface ProviderHandle {
  readonly provider: LLMProvider;
  readonly descriptor: ProviderDescriptor;
}

export interface ProviderFactory {
  create(input: ProviderInput): ProviderHandle;
}

const resolvedConnectionProjections = new WeakMap<ProviderConnection, ProviderConfig>();
const resolvedInputProjections = new WeakMap<ProviderInput, ProviderConfig>();

function authenticationFromResolvedConfig(config: ProviderConfig): ProviderAuthentication {
  return config.apiKey !== undefined
    ? {
        kind: 'api_key',
        value: config.apiKey,
        identity: sha256Hex(config.apiKey),
        profile: config.authProfile ?? 'api_key',
      }
    : {
        kind: 'capability',
        identity: `${config.authProfile ?? 'api_key'}:${config.name}`,
        profile: config.authProfile ?? 'api_key',
        resolve: () => Promise.reject(new Error('Resolved provider authentication requires the L1 factory runtime')),
      };
}

/** Convert the persisted document to the narrow public input, retaining L1 resolution privately. */
export function providerInputFromResolvedConfig(config: ProviderConfig): ProviderInput {
  const authentication = authenticationFromResolvedConfig(config);
  const protocol = config.apiFormat ?? config.catalogResolution?.wire.api;
  if (!protocol || !API_FORMATS.includes(protocol as ApiFormat)) {
    throw new Error(`Provider "${config.name}": explicit protocol is required`);
  }
  const input: ProviderInput = {
    ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    model: config.model,
    protocol: protocol as ApiFormat,
    authentication: authentication.kind === 'api_key'
      ? {
          kind: 'api_key',
          value: authentication.value,
          identity: authentication.identity,
          profile: authentication.profile,
        }
      : {
          kind: 'capability',
          identity: authentication.identity,
          profile: authentication.profile,
          resolve: authentication.resolve,
        },
  };
  resolvedInputProjections.set(input, config);
  return input;
}

/** @deprecated @internal Legacy L1 bridge; ordinary callers use ProviderInput. */
export function providerConnectionFromResolvedConfig(config: ProviderConfig): ProviderConnection {
  const connection: ProviderConnection = {
    providerId: config.name,
    model: config.model,
    ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    apiFormat: config.apiFormat ?? config.catalogResolution?.wire.api ?? 'unknown',
    authentication: authenticationFromResolvedConfig(config),
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
  resolvedConnectionProjections.set(connection, config);
  return connection;
}

/** @internal Only the L1 factory may retrieve a setup-time projection. */
export function resolvedProviderConfig(input: ProviderInput | ProviderConnection): ProviderConfig | undefined {
  return resolvedInputProjections.get(input as ProviderInput) ?? resolvedConnectionProjections.get(input as ProviderConnection);
}

function plainInputProviderId(input: ProviderInput): string {
  if (input.baseUrl !== undefined) {
    try {
      return new URL(input.baseUrl).hostname;
    } catch {
      // silent: adapter validation owns invalid URL reporting; identity only needs a deterministic fallback.
    }
  }
  return input.protocol?.trim() || 'unknown';
}

/** @internal The single public-input to internal-connection resolution point. */
export function resolveInternalConnection(input: ProviderInput): ProviderConnection {
  const resolved = resolvedProviderConfig(input);
  if (resolved) return providerConnectionFromResolvedConfig(resolved);
  if ('providerId' in input && 'apiFormat' in input) {
    return input as unknown as ProviderConnection;
  }
  return {
    providerId: plainInputProviderId(input),
    model: input.model,
    ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
    apiFormat: input.protocol ?? '',
    authentication: input.authentication,
  };
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
    authProfile: auth.profile,
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

function authenticationIdentity(authentication: ProviderAuthentication, length?: number): string {
  const identity = authentication.identity;
  if (!identity) return 'noapikey';
  return length === undefined ? identity : identity.slice(0, length);
}

function descriptorFromResolvedConfig(
  config: ProviderConfig,
  authenticationOverride?: ProviderAuthentication,
): ProviderDescriptor {
  const authentication = authenticationOverride ?? authenticationFromResolvedConfig(config);
  const protocol = config.apiFormat ?? config.catalogResolution?.wire.api ?? 'unknown';
  const legacyParts = [
    config.name || 'unknown',
    protocol || 'unknown',
    config.model || 'unknown',
    config.baseUrl ?? 'default',
    authenticationIdentity(authentication, 8),
  ];
  const legacyIdentity = sha256ShortHex(legacyParts.join(':'), 12);
  const authProfile = authentication.profile ?? 'api_key';
  const identity = authProfile === 'api_key'
    ? legacyIdentity
    : sha256ShortHex([...legacyParts, authProfile].join(':'), 12);
  const behavior = {
    temperature: config.temperature,
    timeoutMs: config.timeoutMs,
    maxTokens: config.maxTokens,
    thinking: config.thinking,
    thinkingBudgetTokens: config.thinkingBudgetTokens,
    thinkingMode: config.thinkingMode,
    thinkingEffort: config.thinkingEffort,
    reasoningEffort: config.reasoningEffort,
    dropThinkingBlocks: config.dropThinkingBlocks,
    extraHeaders: config.extraHeaders,
  };
  const stableIdentity = sha256Hex(JSON.stringify({
    providerId: config.name,
    model: config.model,
    baseUrl: config.baseUrl,
    protocol,
    authentication: {
      kind: authentication.kind,
      profile: authProfile,
      ...(authentication.kind === 'capability' ? { identity: authentication.identity } : {}),
    },
    defaults: {
      ...behavior,
      extraHeaders: config.extraHeaders === undefined ? undefined : Object.keys(config.extraHeaders).sort(),
    },
  }));
  return {
    providerId: config.name,
    model: config.model,
    identity,
    cacheKey: `${identity}:${sha256ShortHex(JSON.stringify(behavior), 8)}`,
    legacyIdentity,
    stableIdentity,
    protocol,
    authProfile,
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
    extraHeaderNames: Object.keys(config.extraHeaders ?? {}).sort(),
  };
}

/** Produce secret-safe identity/runtime facts without exposing the internal connection. */
export function describeProviderInput(input: ProviderInput): ProviderDescriptor {
  const resolved = resolvedProviderConfig(input);
  if (resolved) return descriptorFromResolvedConfig(resolved);
  return descriptorFromResolvedConfig(
    toInternalProviderConfig(resolveInternalConnection(input)),
    input.authentication,
  );
}

/** @deprecated @internal Descriptor projection for the legacy L1 connection bridge. */
export function describeProviderConnection(connection: ProviderConnection): ProviderDescriptor {
  const resolved = resolvedConnectionProjections.get(connection);
  if (resolved) return descriptorFromResolvedConfig(resolved);
  return descriptorFromResolvedConfig(toInternalProviderConfig(connection), connection.authentication);
}
