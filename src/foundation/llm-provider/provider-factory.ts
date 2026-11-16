import type { AuditSink, ProviderConfig } from './types.js';
import { PiAiAdapter, type PiAiAdapterOptions } from './pi-ai-adapter.js';
import { LLMError } from './errors.js';
import type { LLMProvider } from './types.js';
import {
  resolvedProviderConfig,
  toInternalProviderConfig,
  type ProviderConnection,
} from './provider-connection.js';

export interface ProviderConnectionFactoryOptions extends PiAiAdapterOptions {
  /** Assembly-owned audit dependency; never part of connection identity. */
  auditLog?: AuditSink;
}

/** Validate legacy configuration without changing its historical error surface. */
function validateProviderConfig(config: ProviderConfig): void {
  const profile = config.authProfile ?? 'api_key';
  if (profile === 'api_key' && !config.apiKey?.trim()) {
    throw new LLMError(
      `ProviderConfig.apiKey is required (provider="${config.name || 'unknown'}")`,
      { provider: config.name, field: 'apiKey' },
    );
  }
  if (!config.model?.trim()) {
    throw new LLMError(
      `ProviderConfig.model is required (provider="${config.name || 'unknown'}")`,
      { provider: config.name, field: 'model' },
    );
  }
  if (!config.apiFormat && !config.piAiProvider) {
    throw new LLMError(
      `ProviderConfig.apiFormat is required (provider="${config.name || 'unknown'}")`,
      { provider: config.name, field: 'apiFormat' },
    );
  }
}

function withFactoryAudit(config: ProviderConfig, auditLog: AuditSink | undefined): ProviderConfig {
  if (!auditLog || config.auditLog === auditLog) return config;
  const projected = { ...config, auditLog };
  if (config.catalogResolution !== undefined) {
    Object.defineProperty(projected, 'catalogResolution', {
      value: config.catalogResolution,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
  return projected;
}

/**
 * Create a provider from the neutral connection contract. A connection produced
 * by the L1 setup resolver retains its private catalog projection; plain
 * external connections use the single explicit conversion below.
 */
export function createProviderFromConnection(
  connection: ProviderConnection,
  options?: ProviderConnectionFactoryOptions,
): LLMProvider {
  const resolved = resolvedProviderConfig(connection);
  if (resolved) {
    validateProviderConfig(resolved);
    return new PiAiAdapter(withFactoryAudit(resolved, options?.auditLog), options);
  }

  if (!connection.model.trim()) {
    throw new LLMError(
      `ProviderConnection.model is required (provider="${connection.providerId || 'unknown'}")`,
      { provider: connection.providerId, field: 'model' },
    );
  }
  if (!connection.apiFormat.trim()) {
    throw new LLMError(
      `ProviderConnection.apiFormat is required (provider="${connection.providerId || 'unknown'}")`,
      { provider: connection.providerId, field: 'apiFormat' },
    );
  }
  if (connection.authentication.kind === 'api_key' && !connection.authentication.value.trim()) {
    throw new LLMError(
      `ProviderConnection.authentication.value is required (provider="${connection.providerId || 'unknown'}")`,
      { provider: connection.providerId, field: 'authentication' },
    );
  }
  const config = withFactoryAudit(toInternalProviderConfig(connection), options?.auditLog);
  return new PiAiAdapter(config, {
    ...options,
    ...(connection.authentication.kind === 'capability'
      ? { authentication: connection.authentication }
      : {}),
  });
}

/** @deprecated Legacy L1 bridge. L2 and ordinary callers must use ProviderFactory. */
export function createLLMProvider(config: ProviderConfig, options?: PiAiAdapterOptions): LLMProvider {
  validateProviderConfig(config);
  return new PiAiAdapter(config, options);
}
