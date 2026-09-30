/**
 * @module L1.LLMProvider
 * Phase 1927 Step D：catalog provider → chestnut 配置策略单源。
 *
 * pi-ai catalog（PROVIDER_INVENTORY 快照）是 provider universe；PRESETS 只是
 * UX 别名/默认值。本模块给「显式 catalog provider 配置」（provider_id + model +
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
import { MODEL_CATALOG } from './model-catalog.generated.js';
import { PRESETS, type AuthProfile } from './presets.js';

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

/** 显式 model 规则：`${providerId}/${model}` 命中静态 catalog seed。 */
export function catalogModelKnown(providerId: string, model: string): boolean {
  return `${providerId}/${model}` in MODEL_CATALOG;
}

/**
 * 无任何 preset 别名的 catalog provider（UX 列表的增量来源——消除 provider
 * universe 与 PRESETS 的双重封闭来源：preset 覆盖的走 preset，其余由 inventory
 * 单源派生）。返回排序后的 provider id。
 */
export function catalogProvidersWithoutPreset(): string[] {
  const covered = new Set(
    Object.values(PRESETS)
      .map((p) => p.piAiProvider)
      .filter((v): v is string => v !== undefined),
  );
  return Object.keys(PROVIDER_INVENTORY).filter((id) => !covered.has(id)).sort();
}
