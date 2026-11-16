/** @module L1.LLMProvider.DeepseekInputProfile */
import type * as PiAi from '@earendil-works/pi-ai';
import { CATALOG_REVISION } from './catalog-strategy.js';
import type { CatalogResolution } from './catalog-strategy.js';
import { createDeepseekV41Meter } from './deepseek-v41-meter.js';
import {
  createDeepseekInputProjection,
  DEEPSEEK_PROJECTION_REVISION,
  DEEPSEEK_V41_ASSET_REVISION,
  type DeepseekEffectiveOptions,
} from './deepseek-input-projection.js';
import type {
  InputMeterDescriptor,
  MeterQualification,
  ModelInputMeter,
} from './input-meter-types.js';
import type { ProviderConfig } from './types.js';

export const DEEPSEEK_V41_PROFILE_ID = 'deepseek-v41-flash-1017-v1';

/**
 * The only counted profile backed by a resolved identity, final-wire projection,
 * and a versioned tokenizer asset. Catalog and protocol revisions are part of
 * the match so a same-name model cannot inherit this qualification.
 */
export const deepseekV41InputProfile = Object.freeze({
  id: DEEPSEEK_V41_PROFILE_ID,
  matches(model: PiAi.Model<PiAi.Api>, resolution: CatalogResolution): boolean {
    return resolution.kind === 'metadata_only'
      && resolution.revision === CATALOG_REVISION
      && resolution.providerId === 'deepseek'
      && resolution.modelId === 'deepseek-flash'
      && String(model.api) === 'anthropic-messages'
      && (model.id === 'deepseek-flash' || model.id === 'deepseek-flash[1m]')
      && resolution.wire.model === model.id
      && resolution.wire.api === String(model.api);
  },
  descriptor(): MeterQualification {
    return {
      kind: 'counted',
      method: 'deepseek-v41-template',
      projection: DEEPSEEK_PROJECTION_REVISION,
      assetRevision: DEEPSEEK_V41_ASSET_REVISION,
      limits: Object.freeze({ supportedTools: 'client' }),
    };
  },
  create(input: {
    readonly descriptor: Readonly<InputMeterDescriptor>;
    readonly config: ProviderConfig;
    readonly model: PiAi.Model<PiAi.Api>;
    readonly effective: DeepseekEffectiveOptions;
  }): ModelInputMeter {
    return createDeepseekV41Meter(
      input.descriptor,
      createDeepseekInputProjection(input.config, input.model, input.effective),
    );
  },
});
