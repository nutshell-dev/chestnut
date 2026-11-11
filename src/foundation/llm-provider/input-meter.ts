/** @module L1.LLMProvider.InputMeter */
import type * as PiAi from '@earendil-works/pi-ai';
import { sha256Hex } from '../node-utils/index.js';
import type { ProviderConfig, ProviderWireMessage, ToolDefinition } from './types.js';
import type { ModelInputMeter } from './input-meter-types.js';
import { estimateMessagesTokens, estimateTextTokens, estimateToolsTokens } from './token-estimator.js';
import { createDeepseekV41Meter } from './deepseek-v41-meter.js';
export type { CompleteInput, InputMeterDescriptor, InputMeasurement, ModelInputMeter } from './input-meter-types.js';

/** Metadata and effective request options, never credentials, define the counting revision. */
export function createInputMeter(
  config: ProviderConfig,
  model: PiAi.Model<PiAi.Api>,
  effective: Pick<PiAi.SimpleStreamOptions, 'maxTokens' | 'temperature' | 'reasoning' | 'thinkingBudgets'>,
): ModelInputMeter {
  const profile = 'legacy-cl100k-v1';
  const descriptor = Object.freeze({
    provider: config.name,
    model: model.id,
    api: String(model.api),
    contextWindow: model.contextWindow,
    ...(config.maxTokens !== undefined && { explicitMaxTokens: config.maxTokens }),
    profile,
    revision: sha256Hex(JSON.stringify({
      profile, sdk: 'pi-ai-1.4.0', model: model.id, api: model.api,
      window: model.contextWindow, maxTokens: model.maxTokens,
      catalogProvider: config.catalogProvider, catalogModel: config.catalogModel,
      reasoning: model.reasoning, compat: model.compat, thinkingLevelMap: model.thinkingLevelMap,
      dropThinkingBlocks: config.dropThinkingBlocks === true, effective,
    })),
  });
  if (config.catalogProvider === 'deepseek' && config.catalogModel === 'deepseek-flash'
    && String(model.api) === 'anthropic-messages'
    && (model.id === 'deepseek-flash' || model.id === 'deepseek-flash[1m]')) {
    return createDeepseekV41Meter(descriptor);
  }
  return {
    descriptor,
    measure(input) {
      return {
        kind: 'estimated',
        method: 'legacy-cl100k',
        reason: 'unsupported_model_or_protocol',
        tokens: estimateMessagesTokens(input.messages as ProviderWireMessage[])
          + estimateTextTokens(input.system ?? '') + estimateToolsTokens(input.tools as ToolDefinition[] ?? []),
      };
    },
  };
}
