import type { ModelCatalogEntry } from './model-catalog.generated.js';
import type { ApiFormat } from './presets.js';

export interface ContextWindowResolution {
  readonly contextWindow: number;
  readonly source: 'catalog' | 'configured' | 'heuristic' | 'explicit_fallback';
  readonly providerId: string;
  readonly modelId: string;
  readonly revision: string;
}

export interface CatalogWireIdentity {
  readonly model: string;
  readonly api?: string;
  readonly baseUrl?: string;
}

interface CatalogResolutionBase {
  readonly providerId?: string;
  readonly modelId: string;
  readonly wire: Readonly<CatalogWireIdentity>;
  readonly revision: string;
  readonly window: Readonly<ContextWindowResolution>;
}

export type CatalogResolution = CatalogResolutionBase & (
  | {
      readonly kind: 'catalog_model';
      readonly source: 'provider_id' | 'preset_alias';
      readonly providerId: string;
      readonly metadata: Readonly<ModelCatalogEntry>;
    }
  | {
      readonly kind: 'metadata_only';
      readonly source: 'metadata_only';
      readonly providerId: string;
      readonly metadata: Readonly<ModelCatalogEntry>;
    }
  | {
      readonly kind: 'custom';
      readonly source: 'explicit_custom';
      readonly metadata?: undefined;
    }
);

/** Pure facade input; ProviderConfig is structurally assignable without a type cycle. */
export interface CatalogIdentityConfig {
  readonly name: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly apiFormat?: ApiFormat;
  readonly piAiProvider?: string;
  readonly catalogProvider?: string;
  readonly catalogModel?: string;
}
