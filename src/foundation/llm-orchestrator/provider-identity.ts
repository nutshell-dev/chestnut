/**
 * Secret-safe provider fault identity and adapter cache fingerprints.
 * Authentication secrets never enter these functions; only an opaque identity
 * supplied by the connection owner participates in operational invalidation.
 */
import type { llmProviderCall } from '../llm-provider/index.js';
type ProviderConnection = llmProviderCall.ProviderConnection;
import { sha256ShortHex } from '../node-utils/index.js';

function authenticationIdentity(connection: ProviderConnection, length?: number): string {
  const identity = connection.authentication.identity;
  if (!identity) return 'noapikey';
  return length === undefined ? identity : identity.slice(0, length);
}

function legacyIdentityParts(connection: ProviderConnection): string[] {
  return [
    connection.providerId || 'unknown',
    connection.apiFormat || 'unknown',
    connection.model || 'unknown',
    connection.baseUrl ?? 'default',
    authenticationIdentity(connection, 8),
  ];
}

/** Pre-connection identity projection retained for persisted recovery migration. */
export function legacyProviderIdentity(connection: ProviderConnection): string {
  return sha256ShortHex(legacyIdentityParts(connection).join(':'), 12);
}

/** Behavior defaults affect adapter reuse, not fault/recovery ownership. */
export function providerIdentity(connection: ProviderConnection): string {
  const profile = connection.authentication.profile ?? 'api_key';
  if (profile === 'api_key') return legacyProviderIdentity(connection);
  return sha256ShortHex([...legacyIdentityParts(connection), profile].join(':'), 12);
}

/** Provider identity plus all neutral adapter behavior defaults. */
export function providerCacheKey(connection: ProviderConnection): string {
  const defaults = connection.defaults;
  const behaviorFingerprint = sha256ShortHex(JSON.stringify({
    temperature: defaults?.temperature,
    timeoutMs: defaults?.timeoutMs,
    maxTokens: defaults?.maxTokens,
    thinking: defaults?.thinking,
    thinkingBudgetTokens: defaults?.thinkingBudgetTokens,
    thinkingMode: defaults?.thinkingMode,
    thinkingEffort: defaults?.thinkingEffort,
    reasoningEffort: defaults?.reasoningEffort,
    dropThinkingBlocks: defaults?.dropThinkingBlocks,
    extraHeaders: defaults?.extraHeaders,
  }), 8);
  return `${providerIdentity(connection)}:${behaviorFingerprint}`;
}
