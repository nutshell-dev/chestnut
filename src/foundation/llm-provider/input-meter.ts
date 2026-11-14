/** @module L1.LLMProvider.InputMeter */
import type * as PiAi from '@earendil-works/pi-ai';
import { sha256Hex } from '../node-utils/index.js';
import type { ProviderConfig, ProviderWireMessage, ToolDefinition } from './types.js';
import type { InputMeterDescriptor, MessageAdditiveInputCounter, ModelInputMeter } from './input-meter-types.js';
import { estimateMessagesTokens, estimateTextTokens, estimateToolsTokens } from './token-estimator.js';
import { createDeepseekV41Meter } from './deepseek-v41-meter.js';
import type { CatalogResolution } from './catalog-strategy.js';
import {
  createDeepseekInputProjection,
  DEEPSEEK_PROJECTION_REVISION,
  DEEPSEEK_V41_ASSET_REVISION,
} from './deepseek-input-projection.js';
export type { CompleteInput, InputMeterDescriptor, InputMeasurement, InputMeasurementCapability, ModelInputMeter } from './input-meter-types.js';

/** Exact resolved identity required for the fixed DeepSeek template; names alone never qualify. */
export function isDeepseekV41MeterProfile(
  model: PiAi.Model<PiAi.Api>,
  resolution: CatalogResolution,
): boolean {
  return resolution.kind === 'metadata_only'
    && resolution.providerId === 'deepseek'
    && resolution.modelId === 'deepseek-flash'
    && String(model.api) === 'anthropic-messages'
    && (model.id === 'deepseek-flash' || model.id === 'deepseek-flash[1m]')
    && resolution.wire.model === model.id
    && resolution.wire.api === String(model.api);
}

/** Metadata and effective request options, never credentials, define the counting revision. */
export function createInputMeter(
  config: ProviderConfig,
  model: PiAi.Model<PiAi.Api>,
  effective: Pick<PiAi.SimpleStreamOptions, 'maxTokens' | 'temperature' | 'reasoning' | 'thinkingBudgets'>,
  resolution: CatalogResolution,
): ModelInputMeter {
  const effectiveOptions = Object.freeze({
    ...effective,
    ...(effective.thinkingBudgets && { thinkingBudgets: Object.freeze({ ...effective.thinkingBudgets }) }),
  });
  const deepseek = isDeepseekV41MeterProfile(model, resolution);
  const profile = deepseek ? 'deepseek-v41-flash-1017-v1' : 'legacy-cl100k-v2';
  const method = deepseek ? 'deepseek-v41-template' : 'legacy-cl100k';
  const projection = deepseek ? DEEPSEEK_PROJECTION_REVISION : 'legacy-chestnut-provider-wire-v1';
  const assetRevision = deepseek ? DEEPSEEK_V41_ASSET_REVISION : 'js-tiktoken:cl100k_base';
  const limits = Object.freeze({ supportedTools: deepseek ? 'client' as const : 'declared' as const });
  const effectiveMaxTokens = effectiveOptions.maxTokens ?? model.maxTokens;
  const descriptor: Readonly<InputMeterDescriptor> = Object.freeze({
    provider: resolution.providerId ?? config.name,
    providerLabel: config.name,
    model: model.id,
    api: String(model.api),
    contextWindow: resolution.window.contextWindow,
    windowResolution: resolution.window,
    ...(config.maxTokens !== undefined && { explicitMaxTokens: config.maxTokens }),
    effectiveMaxTokens,
    profile,
    method,
    projection,
    assetRevision,
    limits,
    revision: sha256Hex(JSON.stringify({
      profile, method, projection, assetRevision, limits, effectiveMaxTokens,
      sdk: 'pi-ai-1.4.0', provider: resolution.providerId ?? config.name,
      model: model.id, api: model.api, window: resolution.window, maxTokens: model.maxTokens,
      catalog: { kind: resolution.kind, source: resolution.source, revision: resolution.revision,
        providerId: resolution.providerId, modelId: resolution.modelId },
      reasoning: model.reasoning, compat: model.compat, thinkingLevelMap: model.thinkingLevelMap,
      dropThinkingBlocks: config.dropThinkingBlocks === true, effective: effectiveOptions,
    })),
  });
  if (deepseek) {
    return createDeepseekV41Meter(
      descriptor,
      createDeepseekInputProjection(config, model, effectiveOptions),
    );
  }
  const capability: MessageAdditiveInputCounter = {
    kind: 'message_additive',
    measureFixed(input) {
      return estimateTextTokens(input.system ?? '')
        + estimateToolsTokens(input.tools as ToolDefinition[] ?? []);
    },
    measureMessage(message) {
      return estimateMessagesTokens([message as ProviderWireMessage]);
    },
  };
  return {
    descriptor,
    capability,
    measure(input) {
      return {
        kind: 'estimated',
        method: 'legacy-cl100k',
        reason: 'unsupported_model_or_protocol',
        tokens: capability.measureFixed(input)
          + input.messages.reduce((sum, message) => sum + capability.measureMessage(message), 0),
      };
    },
  };
}
