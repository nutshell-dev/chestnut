/** @module L1.LLMProvider.InputMeter */
import type * as PiAi from '@earendil-works/pi-ai';
import { sha256Hex } from '../node-utils/index.js';
import type { ProviderConfig, ProviderWireMessage, ToolDefinition } from './types.js';
import type {
  InputMeterDescriptor,
  MessageAdditiveInputCounter,
  MeterQualification,
  ModelInputMeter,
} from './input-meter-types.js';
import {
  estimateMessagesTokens,
  estimateTextTokens,
  estimateToolsTokens,
  LEGACY_CL100K_ASSET_REVISION,
  LEGACY_CL100K_METHOD,
  LEGACY_CL100K_UNSUPPORTED_REASON,
} from './token-estimator.js';
import type { CatalogResolution } from './catalog-strategy.js';
import { deepseekV41InputProfile } from './deepseek-input-profile.js';
import { kimiK3TextInputProfile } from './kimi-k3-text-meter.js';
import { glm53TextInputProfile } from './glm53-text-meter.js';
import { qwenTextInputProfile } from './qwen-text-meter.js';
import {
  MODEL_FAMILY_RESOLVER_REVISION,
  resolveModelFamily,
  type InputModelFamily,
} from './model-family-resolver.js';
export type { CompleteInput, InputMeterDescriptor, InputMeasurement, InputMeasurementCapability, MeterQualification, ModelInputMeter } from './input-meter-types.js';

interface InputMeterProfile {
  readonly id: string;
  readonly family: InputModelFamily;
  readonly descriptor: () => MeterQualification;
  readonly create: (descriptor: Readonly<InputMeterDescriptor>) => ModelInputMeter;
}

const INPUT_METER_PROFILES = [
  deepseekV41InputProfile,
  kimiK3TextInputProfile,
  glm53TextInputProfile,
  qwenTextInputProfile,
] as const satisfies readonly InputMeterProfile[];

function matchingProfile(model: PiAi.Model<PiAi.Api>): InputMeterProfile | undefined {
  const family = resolveModelFamily(model.id);
  return INPUT_METER_PROFILES.find(profile => profile.family === family);
}

/** Stable audit reason with resolved identity; no credentials or request content are included. */
function unsupportedMeterReason(
  resolution: CatalogResolution,
  model: PiAi.Model<PiAi.Api>,
): string {
  return `${LEGACY_CL100K_UNSUPPORTED_REASON}:catalog=${resolution.kind};provider=${resolution.providerId ?? 'unresolved'};model=${resolution.modelId};wireModel=${model.id};api=${String(model.api)}`;
}

function legacyQualification(
  resolution: CatalogResolution,
  model: PiAi.Model<PiAi.Api>,
): MeterQualification {
  return {
    kind: 'estimated',
    method: LEGACY_CL100K_METHOD,
    projection: 'estimate-only:no-final-wire-projection',
    assetRevision: LEGACY_CL100K_ASSET_REVISION,
    reason: unsupportedMeterReason(resolution, model),
    limits: Object.freeze({ supportedTools: 'declared' }),
  };
}

/** Select a local estimator by model family; request wire facts never qualify it. */
export function qualifyMeter(
  resolution: CatalogResolution,
  model: PiAi.Model<PiAi.Api>,
): MeterQualification {
  return matchingProfile(model)?.descriptor()
    ?? legacyQualification(resolution, model);
}

/** Descriptor facts remain auditable but do not participate in family selection. */
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
  const meterProfile = matchingProfile(model);
  const qualification = meterProfile?.descriptor() ?? legacyQualification(resolution, model);
  const profile = meterProfile?.id ?? 'legacy-cl100k-v2';
  const { method, projection, assetRevision, limits } = qualification;
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
      resolver: MODEL_FAMILY_RESOLVER_REVISION,
      sdk: 'pi-ai-1.4.0', provider: resolution.providerId ?? config.name,
      model: model.id, api: model.api, window: resolution.window, maxTokens: model.maxTokens,
      catalog: { kind: resolution.kind, source: resolution.source, revision: resolution.revision,
        providerId: resolution.providerId, modelId: resolution.modelId },
      reasoning: model.reasoning, compat: model.compat, thinkingLevelMap: model.thinkingLevelMap,
      dropThinkingBlocks: config.dropThinkingBlocks === true, effective: effectiveOptions,
    })),
  });
  if (meterProfile) return meterProfile.create(descriptor);
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
      try {
        return {
          kind: 'estimated',
          method: LEGACY_CL100K_METHOD,
          reason: qualification.reason ?? LEGACY_CL100K_UNSUPPORTED_REASON,
          tokens: capability.measureFixed(input)
            + input.messages.reduce((sum, message) => sum + capability.measureMessage(message), 0),
        };
      } catch (error) {
        // silent: local cl100k initialization/encoding failures become typed unavailable.
        return {
          kind: 'unavailable',
          reason: `legacy_cl100k_estimate_unavailable:${error instanceof Error ? error.name : 'UnknownError'}`,
        };
      }
    },
  };
}
