/** User-facing provider choice facts; the catalog remains owner-managed. */
import type { AuthProfile } from '../presets.js';
import type { ResolvedThinkingDefaults } from '../thinking-defaults.js';

export interface ProviderPresetView {
  readonly id: string;
  readonly defaultModel?: string;
  readonly authProfile: AuthProfile;
  readonly requiresBaseUrl: boolean;
}

export interface ProviderChoiceCatalogCapability {
  readonly listPresetIds: () => readonly string[];
  readonly resolvePreset: (id: string) => ProviderPresetView;
  readonly resolveThinkingDefaults: (
    presetId: string,
    model?: string,
  ) => ResolvedThinkingDefaults | undefined;
  readonly isCatalogProvider: (providerId: string) => boolean;
  readonly deriveCatalogAuthProfile: (providerId: string) => AuthProfile;
}

export { PRESETS, resolvePreset, presetAuthProfile, presetRequiresBaseUrl } from '../presets.js';
export type { AuthProfile, ApiFormat, PresetThinkingDefaults } from '../presets.js';
export { resolveThinkingDefaults } from '../thinking-defaults.js';
export type { ResolvedThinkingDefaults } from '../thinking-defaults.js';
export {
  UnknownCatalogProviderError,
  CatalogModelNotFoundError,
  catalogProviderEntry,
  isCatalogProvider,
  deriveCatalogAuthProfile,
  validateCatalogAuthProfile,
  validateCatalogProtocol,
  CatalogProtocolMismatchError,
  catalogModelKnown,
  resolveCatalogIdentity,
  CATALOG_REVISION,
} from '../catalog-strategy.js';
export type { CatalogResolution, CatalogWireIdentity } from '../catalog-strategy.js';
export { catalogProviderLoginMetadata } from '../provider-login-metadata.js';
export type { CatalogProviderLoginMetadata } from '../provider-login-metadata.js';
export {
  CATALOG_PROVIDER_ALIAS_REVISION,
  resolveLegacyCatalogProviderAlias,
} from '../catalog-provider-aliases.js';
