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
export type { CompleteInput, InputMeterDescriptor, InputMeasurement, InputMeasurementCapability, MeterQualification, ModelInputMeter } from './input-meter-types.js';

interface InputMeterProfile {
  readonly id: string;
  readonly matches: (model: PiAi.Model<PiAi.Api>, resolution: CatalogResolution) => boolean;
  readonly descriptor: () => MeterQualification;
  readonly create: (input: {
    readonly descriptor: Readonly<InputMeterDescriptor>;
    readonly config: ProviderConfig;
    readonly model: PiAi.Model<PiAi.Api>;
    readonly effective: Pick<PiAi.SimpleStreamOptions, 'maxTokens' | 'temperature' | 'reasoning' | 'thinkingBudgets'>;
  }) => ModelInputMeter;
}

/** Counted profiles are explicit evidence bundles; provider names never imply membership. */
const INPUT_METER_PROFILES = [deepseekV41InputProfile] as const satisfies readonly InputMeterProfile[];

function matchingProfile(
  resolution: CatalogResolution,
  model: PiAi.Model<PiAi.Api>,
): InputMeterProfile | undefined {
  return INPUT_METER_PROFILES.find(profile => profile.matches(model, resolution));
}

/** Exact resolved identity required for the fixed DeepSeek template; names alone never qualify. */
export function isDeepseekV41MeterProfile(
  model: PiAi.Model<PiAi.Api>,
  resolution: CatalogResolution,
): boolean {
  return deepseekV41InputProfile.matches(model, resolution);
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

/** Only a resolved identity with final-wire projection and bound assets may be counted. */
export function qualifyMeter(
  resolution: CatalogResolution,
  model: PiAi.Model<PiAi.Api>,
): MeterQualification {
  return matchingProfile(resolution, model)?.descriptor()
    ?? legacyQualification(resolution, model);
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
  const meterProfile = matchingProfile(resolution, model);
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
      sdk: 'pi-ai-1.4.0', provider: resolution.providerId ?? config.name,
      model: model.id, api: model.api, window: resolution.window, maxTokens: model.maxTokens,
      catalog: { kind: resolution.kind, source: resolution.source, revision: resolution.revision,
        providerId: resolution.providerId, modelId: resolution.modelId },
      reasoning: model.reasoning, compat: model.compat, thinkingLevelMap: model.thinkingLevelMap,
      dropThinkingBlocks: config.dropThinkingBlocks === true, effective: effectiveOptions,
    })),
  });
  if (meterProfile) {
    return meterProfile.create({ descriptor, config, model, effective: effectiveOptions });
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
        method: LEGACY_CL100K_METHOD,
        reason: qualification.reason ?? LEGACY_CL100K_UNSUPPORTED_REASON,
        tokens: capability.measureFixed(input)
          + input.messages.reduce((sum, message) => sum + capability.measureMessage(message), 0),
      };
    },
  };
}
