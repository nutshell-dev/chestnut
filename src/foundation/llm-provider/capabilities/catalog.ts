/** User-facing provider choice facts; the catalog remains owner-managed. */
import type { AuthProfile } from '../presets.js';
export interface ProviderChoiceCatalogCapability {
  readonly listPresetIds: () => readonly string[];
  readonly isCatalogProvider: (providerId: string) => boolean;
  readonly deriveCatalogAuthProfile: (providerId: string) => AuthProfile;
}

export type { AuthProfile, ApiFormat, PresetThinkingDefaults } from '../presets.js';
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
  resolveCatalogConnectionCandidate,
  CATALOG_REVISION,
} from '../catalog-strategy.js';
export type {
  CatalogResolution,
  CatalogWireIdentity,
  CatalogConnectionCandidateInput,
  PersistedConnectionCandidate,
} from '../catalog-strategy.js';
export { catalogProviderLoginMetadata } from '../provider-login-metadata.js';
export type { CatalogProviderLoginMetadata } from '../provider-login-metadata.js';
export {
  CATALOG_PROVIDER_ALIAS_REVISION,
  resolveLegacyCatalogProviderAlias,
} from '../catalog-provider-aliases.js';
