/**
 * Explicit persisted LLM configuration → runtime provider projections.
 * No legacy defaults or model/URL heuristics participate in this path.
 */
import type { ProviderConfig } from './types.js';
import {
  CatalogModelNotFoundError,
  UnknownCatalogProviderError,
  catalogModelKnown,
  isCatalogProvider,
  resolveCatalogIdentity,
  validateCatalogAuthProfile,
  validateCatalogProtocol,
} from './catalog-strategy.js';
import type { LLMProviderConfig } from './llm-provider-config-schema.js';
import {
  providerConnectionFromResolvedConfig,
  providerInputFromResolvedConfig,
  type ProviderConnection,
  type ProviderInput,
} from './provider-connection.js';

/** Derived identity is runtime-only and is never persisted or hashed as configuration. */
function attachCatalogResolution(config: ProviderConfig): ProviderConfig {
  Object.defineProperty(config, 'catalogResolution', {
    value: resolveCatalogIdentity(config, config.catalogProvider ? undefined : 'provider_id'),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return config;
}

function assertNotBareEnvVar(apiKey: string | undefined, display: string): void {
  if (apiKey && /^[A-Z][A-Z0-9_]{3,}$/.test(apiKey)) {
    throw new Error(
      `Provider "${display}": api_key looks like a bare environment variable name ("${apiKey}"). ` +
      `Use \${${apiKey}} to reference it.`,
    );
  }
}

/** Resolve persisted provider configuration into the ordinary L4/L2 input boundary. */
export function toProviderInput(p: LLMProviderConfig): ProviderInput {
  return providerInputFromResolvedConfig(toProviderConfig(p));
}

/** @deprecated @internal Legacy L1 bridge; ordinary callers use toProviderInput. */
export function toProviderConnection(p: LLMProviderConfig): ProviderConnection {
  return providerConnectionFromResolvedConfig(toProviderConfig(p));
}

/** Project only explicit document fields; unknown or incomplete identities fail closed. */
export function toProviderConfig(p: LLMProviderConfig): ProviderConfig {
  const providerId = p.provider_id;
  const display = p.label ?? providerId;
  assertNotBareEnvVar(p.api_key, display);

  const metadataOnly = p.catalog_provider !== undefined;
  if (metadataOnly) {
    // Deliberately do not compare protocols here: metadata-only exists precisely
    // to retain a curated wire protocol different from the metadata provider.
    validateCatalogAuthProfile(p.catalog_provider!, p.auth_profile);
    if (!p.base_url) {
      throw new Error(`Provider "${display}": metadata-only catalog hints require an explicit "base_url"`);
    }
  } else if (isCatalogProvider(providerId)) {
    validateCatalogAuthProfile(providerId, p.auth_profile);
    validateCatalogProtocol(providerId, p.api_format);
    if (!catalogModelKnown(providerId, p.model)) {
      throw new CatalogModelNotFoundError(providerId, p.model);
    }
  } else {
    if (!providerId.startsWith('custom:')) throw new UnknownCatalogProviderError(providerId);
    if (!p.base_url) {
      throw new Error(`Provider "${display}": custom provider identities require an explicit "base_url"`);
    }
  }

  const config: ProviderConfig = {
    name: display,
    apiKey: p.api_key,
    baseUrl: p.base_url,
    model: p.model,
    maxTokens: p.max_tokens,
    temperature: p.temperature,
    timeoutMs: p.timeout_ms,
    thinking: p.thinking,
    thinkingBudgetTokens: p.thinking_budget_tokens,
    thinkingMode: p.thinking_mode,
    thinkingEffort: p.thinking_effort,
    extraHeaders: p.extra_headers,
    dropThinkingBlocks: p.drop_thinking_blocks,
    apiFormat: p.api_format,
    authProfile: p.auth_profile,
    reasoningEffort: p.reasoning_effort,
    // A metadata-only provider id is the explicit wire identity. A custom:* id
    // stays local to the self-built model rather than becoming a catalog alias.
    ...((metadataOnly || isCatalogProvider(providerId)) && { piAiProvider: providerId }),
    ...(p.catalog_provider && { catalogProvider: p.catalog_provider }),
    ...(p.catalog_model && { catalogModel: p.catalog_model }),
  };
  return attachCatalogResolution(config);
}
