/**
 * @module L1.LLMProvider
 * Phase 1927 Step D：catalog provider → chestnut 配置策略单源。
 *
 * pi-ai catalog（PROVIDER_INVENTORY 快照）是 provider universe；legacy preset
 * migration 是独立输入边界。本模块给「显式 catalog provider 配置」（provider_id + model +
 * auth_profile）提供同步的、无需动态 import pi-ai 的裁决面：
 *
 * - provider 合法性：inventory 快照成员（未知 id loud，附可用清单）；
 * - model 规则（含动态 provider 的显式规则）：必须命中静态 catalog seed
 *   （MODEL_CATALOG `${provider}/${model}`）——动态 provider 的运行时
 *   refresh 发现不是配置入口，配置期只认静态 seed，runtime catalog 命中
 *   因此得到保证（resolvePiAiModel catalog 分支）；
 * - auth profile：显式 auth_profile 须与 inventory auth 类兼容；缺省派生
 *   （OAuth-only → oauth；其余 → api_key；ambient 由用户显式声明）。
 */
import { PROVIDER_INVENTORY, type ProviderInventoryEntry } from './provider-inventory.generated.js';
import {
  MODEL_CATALOG,
  MODEL_CATALOG_PI_AI_VERSION,
} from './model-catalog.generated.js';
import type { ApiFormat, AuthProfile } from './api-format.js';
import { resolveContextWindowForIdentity } from './model-context-windows.js';
import type {
  CatalogIdentityConfig,
  CatalogResolution,
  CatalogWireIdentity,
} from './catalog-resolution-types.js';
export type {
  CatalogResolution,
  CatalogWireIdentity,
  ContextWindowResolution,
} from './catalog-resolution-types.js';

export const CATALOG_REVISION = `pi-ai@${MODEL_CATALOG_PI_AI_VERSION}` as const;

/** chestnut apiFormat → pi-ai api；由 identity facade 与 wire model 共用。 */
export const API_FORMAT_TO_PI_AI_API: Readonly<Record<ApiFormat, string>> = {
  anthropic: 'anthropic-messages',
  openai: 'openai-completions',
  gemini: 'google-generative-ai',
  'anthropic-messages': 'anthropic-messages',
  'azure-openai-responses': 'azure-openai-responses',
  'bedrock-converse-stream': 'bedrock-converse-stream',
  'cloudflare-workers-ai-system-one': 'cloudflare-workers-ai-system-one',
  'google-generative-ai': 'google-generative-ai',
  'google-vertex': 'google-vertex',
  'llama-cpp-classify': 'llama-cpp-classify',
  'mistral-conversations': 'mistral-conversations',
  'openai-codex-responses': 'openai-codex-responses',
  'openai-completions': 'openai-completions',
  'openai-decisions': 'openai-decisions',
  'openai-responses': 'openai-responses',
  'openrouter-images': 'openrouter-images',
  'pi-messages': 'pi-messages',
  'typesafe-system-one': 'typesafe-system-one',
};

/** 显式 catalog 配置的 provider id 不在 inventory（typed；available 清单由快照单源派生）。 */
export class UnknownCatalogProviderError extends Error {
  readonly providerId: string;
  readonly availableProviderIds: readonly string[];
  constructor(providerId: string) {
    super(
      `Unknown catalog provider "${providerId}". ` +
      `Available catalog providers: ${Object.keys(PROVIDER_INVENTORY).join(', ')}`,
    );
    this.name = 'UnknownCatalogProviderError';
    this.providerId = providerId;
    this.availableProviderIds = Object.freeze(Object.keys(PROVIDER_INVENTORY));
  }
}

/** model 未命中该 provider 的静态 catalog seed（显式 model 规则；typed）。 */
export class CatalogModelNotFoundError extends Error {
  readonly providerId: string;
  readonly model: string;
  constructor(providerId: string, model: string) {
    super(
      `Model "${model}" is not in the static catalog of provider "${providerId}" ` +
      `(explicit catalog configs require a static catalog model; check the configured provider id or pi-ai catalog version)`,
    );
    this.name = 'CatalogModelNotFoundError';
    this.providerId = providerId;
    this.model = model;
  }
}

/** inventory 成员查询（未知 id → UnknownCatalogProviderError）。 */
export function catalogProviderEntry(providerId: string): ProviderInventoryEntry {
  const entry = PROVIDER_INVENTORY[providerId];
  if (!entry) throw new UnknownCatalogProviderError(providerId);
  return entry;
}

export function isCatalogProvider(providerId: string): boolean {
  return providerId in PROVIDER_INVENTORY;
}

/**
 * 缺省 auth profile 派生：OAuth-only provider（无 apiKey auth）→ 'oauth'；
 * 其余 → 'api_key'（ambient 环境解析不是默认——ambient 由用户显式声明，
 * preset（bedrock/vertex）已内置该声明）。
 */
export function deriveCatalogAuthProfile(providerId: string): AuthProfile {
  const entry = catalogProviderEntry(providerId);
  return !entry.auth.apiKey && entry.auth.oauth ? 'oauth' : 'api_key';
}

/**
 * 校验显式 auth_profile 与 provider auth 类兼容（不兼容 loud，附原因）：
 * - api_key / ambient：依托 apiKey auth 方法（ambient = pi-ai resolve 的环境解析）；
 * - oauth：须声明 oauth auth 方法。
 */
export function validateCatalogAuthProfile(providerId: string, profile: AuthProfile): void {
  const entry = catalogProviderEntry(providerId);
  if (profile === 'oauth' && !entry.auth.oauth) {
    throw new Error(
      `Catalog provider "${providerId}" has no OAuth auth method; auth_profile "oauth" is not supported ` +
      `(use "api_key"${entry.auth.apiKey ? '' : ' is also unavailable — misconfigured inventory'})`,
    );
  }
  if ((profile === 'api_key' || profile === 'ambient') && !entry.auth.apiKey) {
    throw new Error(
      `Catalog provider "${providerId}" is OAuth-only; auth_profile "${profile}" is not supported ` +
      `(use "oauth" and complete the interactive provider login first)`,
    );
  }
}

export class CatalogProtocolMismatchError extends Error {
  constructor(
    readonly providerId: string,
    readonly apiFormat: ApiFormat,
    readonly supportedApis: readonly string[],
  ) {
    super(
      `Catalog provider "${providerId}" does not support api_format "${apiFormat}" ` +
      `(resolved protocol "${API_FORMAT_TO_PI_AI_API[apiFormat]}"; supported: ${supportedApis.join(', ') || 'none'})`,
    );
    this.name = 'CatalogProtocolMismatchError';
  }
}

/** Validate the explicit protocol against the static provider inventory. */
export function validateCatalogProtocol(providerId: string, apiFormat: ApiFormat): void {
  const entry = catalogProviderEntry(providerId);
  const protocol = API_FORMAT_TO_PI_AI_API[apiFormat];
  if (!entry.apis.includes(protocol)) {
    throw new CatalogProtocolMismatchError(providerId, apiFormat, Object.freeze([...entry.apis]));
  }
}

/** 显式 model 规则：`${providerId}/${model}` 命中静态 catalog seed。 */
export function catalogModelKnown(providerId: string, model: string): boolean {
  return `${providerId}/${model}` in MODEL_CATALOG;
}

function wireIdentity(config: CatalogIdentityConfig): Readonly<CatalogWireIdentity> {
  return Object.freeze({
    model: config.model,
    ...(config.apiFormat && { api: API_FORMAT_TO_PI_AI_API[config.apiFormat] }),
    ...(config.baseUrl && { baseUrl: config.baseUrl }),
  });
}

/**
 * Provider/model 身份的唯一同步解析入口。SDK 只负责把 catalog_model 实例化，
 * 不再决定它是不是合法目录身份；凭证和 endpoint 策略仍留在各自边界。
 */
export function resolveCatalogIdentity(
  config: CatalogIdentityConfig,
  source?: 'provider_id' | 'preset_alias',
): CatalogResolution {
  const revision = CATALOG_REVISION;
  const base = {
    modelId: config.model,
    wire: wireIdentity(config),
    revision,
  };

  if (config.catalogProvider && config.catalogModel) {
    const providerId = config.catalogProvider;
    catalogProviderEntry(providerId);
    const metadata = MODEL_CATALOG[`${providerId}/${config.catalogModel}`];
    if (!metadata) throw new CatalogModelNotFoundError(providerId, config.catalogModel);
    const identity = {
      ...base,
      kind: 'metadata_only' as const,
      source: 'metadata_only' as const,
      providerId,
      modelId: config.catalogModel,
      metadata,
    };
    return Object.freeze({
      ...identity,
      window: resolveContextWindowForIdentity(identity),
    });
  }

  if (config.piAiProvider) {
    const providerId = config.piAiProvider;
    if (source === 'provider_id') catalogProviderEntry(providerId);
    const metadata = MODEL_CATALOG[`${providerId}/${config.model}`];
    if (metadata) {
      const identity = {
        ...base,
        kind: 'catalog_model' as const,
        source: source === 'provider_id' ? 'provider_id' as const : 'preset_alias' as const,
        providerId,
        metadata,
      };
      return Object.freeze({
        ...identity,
        window: resolveContextWindowForIdentity(identity),
      });
    }
    if (source === 'provider_id') throw new CatalogModelNotFoundError(providerId, config.model);
  }

  const identity = {
    ...base,
    kind: 'custom' as const,
    source: 'explicit_custom' as const,
    ...(config.piAiProvider && { providerId: config.piAiProvider }),
  };
  return Object.freeze({
    ...identity,
    window: resolveContextWindowForIdentity({ ...identity, providerHint: config.name }),
  });
}

/** SDK materialization 只补全 wire 字段，不改变 catalog/window 身份与 revision。 */
export function withCatalogWireIdentity(
  resolution: CatalogResolution,
  wire: CatalogWireIdentity,
): CatalogResolution {
  return Object.freeze({ ...resolution, wire: Object.freeze(wire) });
}
