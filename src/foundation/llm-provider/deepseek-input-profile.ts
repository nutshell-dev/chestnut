/** @module L1.LLMProvider.DeepseekInputProfile */
import {
  createDeepseekV41Meter,
  DEEPSEEK_V41_ASSET_REVISION,
  DEEPSEEK_V41_TEXT_METHOD,
} from './deepseek-v41-meter.js';
import type {
  InputMeterDescriptor,
  MeterQualification,
  ModelInputMeter,
} from './input-meter-types.js';

export const DEEPSEEK_V41_PROFILE_ID = 'deepseek-v41-text-v1';

/** DeepSeek family names share one local V4.1 text estimator. */
export const deepseekV41InputProfile = Object.freeze({
  id: DEEPSEEK_V41_PROFILE_ID,
  family: 'deepseek' as const,
  descriptor(): MeterQualification {
    return {
      kind: 'estimated',
      method: DEEPSEEK_V41_TEXT_METHOD,
      projection: 'estimate-only:no-final-wire-projection',
      assetRevision: DEEPSEEK_V41_ASSET_REVISION,
      reason: 'context_trim_only:deepseek_v41_text',
      limits: Object.freeze({ supportedTools: 'declared' }),
    };
  },
  create(descriptor: Readonly<InputMeterDescriptor>): ModelInputMeter {
    return createDeepseekV41Meter(descriptor);
  },
});
