/**
 * Explicit, fail-closed migration from legacy preset/provider documents.
 * This is the only L4 compatibility path that interprets preset defaults.
 */
import {
  llmProviderCatalog,
  llmProviderConfigContract,
} from '../../foundation/llm-provider/index.js';
import { llmOrchestratorConfigSchema } from './config-schema.js';
import type { SharedLLMInput } from './selection.js';

const {
  deriveCatalogAuthProfile,
  catalogModelKnown,
  catalogProviderEntry,
  isCatalogProvider,
  presetAuthProfile,
  resolvePreset,
  resolveThinkingDefaults,
} = llmProviderCatalog;
const { llmProviderConfigSchema, toProviderInput } = llmProviderConfigContract;

type ProviderInputDocument = SharedLLMInput['primary'];
type ApiFormat = llmProviderCatalog.ApiFormat;

export type LegacyPresetMigrationErrorCode =
  | 'invalid_source'
  | 'unknown_preset'
  | 'incomplete_mapping'
  | 'invalid_mapping';

/** Typed migration failure; messages deliberately exclude credentials/header values. */
export class LegacyPresetMigrationError extends Error {
  constructor(
    readonly code: LegacyPresetMigrationErrorCode,
    readonly role: string,
    message: string,
    readonly presetId?: string,
    options?: ErrorOptions,
  ) {
    super(`Legacy LLM migration ${code} at ${role}: ${message}`, options);
    this.name = 'LegacyPresetMigrationError';
  }
}

export interface LegacyLLMMigrationResult {
  readonly config: SharedLLMInput;
  readonly migrated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(
  code: LegacyPresetMigrationErrorCode,
  role: string,
  message: string,
  presetId?: string,
  options?: ErrorOptions,
): never {
  throw new LegacyPresetMigrationError(code, role, message, presetId, options);
}

function uniqueCatalogApiFormat(providerId: string, role: string): ApiFormat {
  const apis = catalogProviderEntry(providerId).apis;
  if (apis.length !== 1) {
    fail(
      'incomplete_mapping',
      role,
      `legacy catalog provider "${providerId}" has ${apis.length} protocols; an explicit api_format is required`,
    );
  }
  return apis[0] as ApiFormat;
}

function migrateLegacyCatalogProvider(
  provider: Record<string, unknown>,
  role: string,
): { config: ProviderInputDocument; migrated: boolean } {
  const providerId = provider.provider_id;
  if (typeof providerId !== 'string' || !providerId || !isCatalogProvider(providerId)) {
    fail('invalid_source', role, 'provider_id must name a known catalog provider');
  }
  if (typeof provider.model !== 'string' || !provider.model || provider.model === 'auto') {
    fail('incomplete_mapping', role, 'legacy catalog provider requires an explicit model');
  }
  const config = {
    ...provider,
    provider_id: providerId,
    api_format: provider.api_format ?? uniqueCatalogApiFormat(providerId, role),
    auth_profile: provider.auth_profile ?? deriveCatalogAuthProfile(providerId),
  } as ProviderInputDocument;
  return { config, migrated: true };
}

function migratePresetProvider(
  provider: Record<string, unknown>,
  presetId: string,
  role: string,
): ProviderInputDocument {
  if (provider.provider_id !== undefined) {
    fail('invalid_source', role, 'legacy preset and provider_id must not be combined', presetId);
  }

  let preset: ReturnType<typeof resolvePreset>;
  try {
    preset = resolvePreset(presetId);
  } catch (error) {
    // silent: the resolver error is preserved as the typed migration error's cause.
    fail('unknown_preset', role, `unknown preset "${presetId}"`, presetId, { cause: error });
  }

  const model = typeof provider.model === 'string' && provider.model && provider.model !== 'auto'
    ? provider.model
    : preset.defaultModel;
  if (!model) fail('incomplete_mapping', role, 'preset has no explicit or default model', presetId);

  const baseUrl = typeof provider.base_url === 'string' && provider.base_url
    ? provider.base_url
    : preset.defaultBaseUrl;
  const authProfile = presetAuthProfile(preset);
  if (provider.auth_profile !== undefined && provider.auth_profile !== authProfile) {
    fail('invalid_mapping', role, 'legacy auth_profile conflicts with the preset mapping', presetId);
  }

  let providerId: string;
  let apiFormat = preset.apiFormat;
  let catalogProvider: string | undefined;
  let catalogModel: string | undefined;
  if (preset.catalogProvider || preset.catalogModel) {
    if (!preset.catalogProvider || !preset.catalogModel || !apiFormat || !baseUrl) {
      fail('incomplete_mapping', role, 'metadata-only preset mapping is incomplete', presetId);
    }
    providerId = preset.piAiProvider ?? preset.id;
    catalogProvider = preset.catalogProvider;
    catalogModel = preset.catalogModel;
  } else if (preset.piAiProvider && catalogModelKnown(preset.piAiProvider, model)) {
    providerId = preset.piAiProvider;
    apiFormat = preset.catalogApiFormat ?? preset.apiFormat;
    if (!apiFormat) fail('incomplete_mapping', role, 'catalog preset has no protocol mapping', presetId);
  } else {
    // A legacy preset with a non-catalog model was a self-built endpoint. Preserve
    // that wire behavior with an explicit custom identity instead of guessing.
    if (!apiFormat || !baseUrl) {
      fail('incomplete_mapping', role, 'custom preset mapping requires protocol and base_url', presetId);
    }
    providerId = `custom:${preset.id}`;
  }

  if (provider.api_format !== undefined && provider.api_format !== apiFormat) {
    fail('invalid_mapping', role, 'legacy api_format conflicts with the preset mapping', presetId);
  }

  const thinkingExplicit = [
    'thinking',
    'thinking_budget_tokens',
    'thinking_mode',
    'thinking_effort',
    'reasoning_effort',
    'drop_thinking_blocks',
  ].some(key => provider[key] !== undefined);
  const thinking = thinkingExplicit ? undefined : resolveThinkingDefaults(presetId, model);
  const {
    preset: _preset,
    provider_id: _providerId,
    api_format: _apiFormat,
    catalog_provider: _catalogProvider,
    catalog_model: _catalogModel,
    ...behavior
  } = provider;
  return {
    ...behavior,
    provider_id: providerId,
    api_format: apiFormat,
    auth_profile: authProfile,
    model,
    ...(baseUrl !== undefined ? { base_url: baseUrl } : {}),
    ...(catalogProvider !== undefined ? { catalog_provider: catalogProvider } : {}),
    ...(catalogModel !== undefined ? { catalog_model: catalogModel } : {}),
    ...thinking,
  } as ProviderInputDocument;
}

function validateExplicitProvider(provider: ProviderInputDocument): void {
  // Migration ends by entering the same normal adapter path; invalid catalog
  // protocol/auth/model mappings therefore fail before any target write.
  toProviderInput(llmProviderConfigSchema.parse(provider));
}

/** Migrate one legacy provider draft, or validate an already explicit provider. */
export function migrateLegacyProviderConfig(
  value: unknown,
  role = 'primary',
): ProviderInputDocument {
  if (!isRecord(value)) fail('invalid_source', role, 'provider must be an object');
  try {
    // `transport` was historical wire metadata, not part of the explicit
    // persisted contract. Always discard it before strict validation so old
    // documents remain migratable instead of failing on an unknown key forever.
    const provider = value.transport === undefined
      ? value
      : (() => {
        const { transport: _transport, ...withoutTransport } = value;
        return withoutTransport;
      })();
    if (typeof provider.preset === 'string' && provider.preset) {
      const migrated = migratePresetProvider(provider, provider.preset, role);
      validateExplicitProvider(migrated);
      return migrated;
    }
    if (provider.provider_id !== undefined && (provider.api_format === undefined || provider.auth_profile === undefined)) {
      const migrated = migrateLegacyCatalogProvider(provider, role).config;
      validateExplicitProvider(migrated);
      return migrated;
    }
    validateExplicitProvider(provider as ProviderInputDocument);
    return provider as ProviderInputDocument;
  } catch (error) {
    if (error instanceof LegacyPresetMigrationError) throw error;
    fail('invalid_mapping', role, 'mapped provider does not satisfy the explicit schema', undefined, { cause: error });
  }
}

/** Migrate primary/fallbacks together; the input object is never mutated. */
export function migrateLegacyLLMConfig(value: unknown): LegacyLLMMigrationResult {
  if (!isRecord(value) || !isRecord(value.primary)) {
    fail('invalid_source', 'primary', 'LLM source must contain a primary provider object');
  }
  if (value.fallbacks !== undefined && !Array.isArray(value.fallbacks)) {
    fail('invalid_source', 'fallbacks', 'fallbacks must be an array');
  }
  const primary = migrateLegacyProviderConfig(value.primary, 'primary');
  const legacyFallbacks = value.fallbacks as unknown[] | undefined;
  const fallbacks = legacyFallbacks?.map((provider, index) =>
    migrateLegacyProviderConfig(provider, `fallbacks[${index}]`));
  const config = {
    ...value,
    primary,
    ...(fallbacks !== undefined ? { fallbacks } : {}),
  } as SharedLLMInput;
  llmOrchestratorConfigSchema.parse(config);
  const migrated = primary !== value.primary
    || fallbacks?.some((provider, index) => provider !== legacyFallbacks?.[index]) === true;
  return { config, migrated };
}
