import { beforeAll, describe, expect, it } from 'vitest';
import { llmProviderCall } from '../../../src/foundation/llm-provider/index.js';
import { createLLMProvider } from '../../../src/foundation/llm-provider/provider-factory.js';
import type { ProviderConfig } from '../../../src/foundation/llm-provider/types.js';
import type { CatalogResolution } from '../../../src/foundation/llm-provider/catalog-strategy.js';
import {
  DEEPSEEK_V41_ASSET_REVISION,
  DEEPSEEK_V41_TEXT_METHOD,
} from '../../../src/foundation/llm-provider/deepseek-v41-meter.js';
import { DEEPSEEK_V41_PROFILE_ID } from '../../../src/foundation/llm-provider/deepseek-input-profile.js';
import { createInputMeter, qualifyMeter } from '../../../src/foundation/llm-provider/input-meter.js';
import {
  KIMI_K3_TEXT_ASSET_REVISION,
  KIMI_K3_TEXT_PROFILE_ID,
} from '../../../src/foundation/llm-provider/kimi-k3-text-meter.js';
import {
  GLM53_TEXT_ASSET_REVISION,
  GLM53_TEXT_PROFILE_ID,
} from '../../../src/foundation/llm-provider/glm53-text-meter.js';
import {
  QWEN3_8_TEXT_ASSET_REVISION,
  QWEN3_8_TEXT_PROFILE_ID,
} from '../../../src/foundation/llm-provider/qwen-text-meter.js';
import {
  normalizeModelFamilyName,
  resolveModelFamily,
} from '../../../src/foundation/llm-provider/model-family-resolver.js';
import { resolvePiAiModel } from '../../../src/foundation/llm-provider/pi-ai-model.js';
import { loadPiAiRuntime } from '../../../src/foundation/llm-provider/pi-ai-runtime.js';
import type { CompleteInput } from '../../../src/foundation/llm-provider/input-meter-types.js';

const TEST_PROVIDER_TIMEOUT_MS = 1_000;
const config: ProviderConfig = {
  name: 'gateway', model: 'deepseek-flash[1m]', apiFormat: 'anthropic',
  baseUrl: 'https://gateway.invalid/anthropic', catalogProvider: 'deepseek',
  catalogModel: 'deepseek-flash', apiKey: 'offline-only', temperature: 0, timeoutMs: TEST_PROVIDER_TIMEOUT_MS,
};

let model: ReturnType<typeof resolvePiAiModel>['model'];
let resolution: CatalogResolution;

beforeAll(async () => {
  ({ model, resolution } = resolvePiAiModel(await loadPiAiRuntime(), config));
});

function candidates(modelId: string): { model: typeof model; resolution: CatalogResolution } {
  return {
    model: { ...model, id: modelId },
    resolution: { ...resolution, modelId, wire: { ...resolution.wire, model: modelId } },
  };
}

const FAMILIES = [
  {
    family: 'deepseek', model: 'deepseek-flash[1m]', profile: DEEPSEEK_V41_PROFILE_ID,
    method: DEEPSEEK_V41_TEXT_METHOD, assetRevision: DEEPSEEK_V41_ASSET_REVISION,
  },
  {
    family: 'kimi', model: 'kimi-k3', profile: KIMI_K3_TEXT_PROFILE_ID,
    method: 'kimi-k3-text', assetRevision: KIMI_K3_TEXT_ASSET_REVISION,
  },
  {
    family: 'qwen', model: 'qwen3.8-max', profile: QWEN3_8_TEXT_PROFILE_ID,
    method: 'qwen3.8-text', assetRevision: QWEN3_8_TEXT_ASSET_REVISION,
  },
  {
    family: 'glm', model: 'glm-5.3', profile: GLM53_TEXT_PROFILE_ID,
    method: 'glm5.3-text', assetRevision: GLM53_TEXT_ASSET_REVISION,
  },
] as const;

describe('model-family input meter matrix', () => {
  it.each([
    ['deepseek-flash[1m]', 'deepseek'],
    ['accounts/fireworks/models/DeepSeek-V4P1-Flash', 'deepseek'],
    ['kimi-k3', 'kimi'],
    ['k3', 'kimi'],
    ['K3-256K', 'kimi'],
    ['moonshot/kimi-k2.7-code', 'kimi'],
    ['qwen3.8-max', 'qwen'],
    ['Qwen4-Max', 'qwen'],
    ['glm-4.7', 'glm'],
    ['zai/glm-5.3-flash', 'glm'],
    ['MiniMax-M2.5', undefined],
    ['deepseekish', undefined],
    ['k3s', undefined],
    ['not-kimi-k3', undefined],
  ])('resolves %s only from its normalized model name', (modelName, family) => {
    expect(resolveModelFamily(modelName)).toBe(family);
  });

  it('normalizes case, gateway prefixes, and one trailing context suffix', () => {
    expect(normalizeModelFamilyName('  Accounts/Example/DeepSeek-Flash[1M]  ')).toBe('deepseek-flash');
    expect(normalizeModelFamilyName('k3-256k')).toBe('k3-256k');
  });

  it.each([
    ['configured Kimi with DeepSeek wire', 'kimi-k3', 'deepseek-flash[1m]', KIMI_K3_TEXT_PROFILE_ID],
    ['unknown configuration with Kimi wire', 'unknown-model', 'kimi-k3', 'legacy-cl100k-v2'],
    ['configured Qwen with unknown wire', 'qwen3.8-max', 'unknown-model', QWEN3_8_TEXT_PROFILE_ID],
  ])('selects from configuration for %s', (_name, configuredModel, wireModel, expectedProfile) => {
    const candidate = candidates(wireModel);
    const meter = createInputMeter(
      { ...config, model: configuredModel }, candidate.model, {}, candidate.resolution,
    );
    expect(meter.descriptor.profile).toBe(expectedProfile);
  });

  it.each(FAMILIES)('keeps $family selection invariant across provider, API, wire, and base URL', family => {
    const base = candidates('deepseek-flash[1m]');
    const variants = [
      base,
      { model: { ...base.model, id: 'kimi-k3', api: 'openai-completions' } as typeof model,
        resolution: { ...base.resolution, providerId: 'qwen-token-plan', revision: 'other-revision' } },
      { model: { ...base.model, id: 'unknown-model' },
        resolution: { ...base.resolution, kind: 'custom', providerId: undefined, modelId: 'unrelated-catalog-model',
          wire: { model: 'unrelated-wire-model', api: 'unrelated-wire-api' } } as CatalogResolution },
      { model: { ...base.model, id: 'glm-5.3' },
        resolution: { ...base.resolution, modelId: 'qwen3.8-max', wire: { ...base.resolution.wire, model: 'qwen3.8-max' } } },
    ];
    const qualifications = variants.map(candidate => qualifyMeter(family.model, candidate.resolution, candidate.model));
    for (const qualification of qualifications) {
      expect(qualification).toEqual({
        kind: 'estimated', method: family.method,
        projection: 'estimate-only:no-final-wire-projection', assetRevision: family.assetRevision,
        reason: `context_trim_only:${family.family === 'deepseek' ? 'deepseek_v41_text'
          : family.family === 'kimi' ? 'kimi_k3_text' : family.family === 'qwen' ? 'qwen_text' : 'glm53_text'}`,
        limits: { supportedTools: 'declared' },
      });
    }
    const meters = variants.map((candidate, index) => createInputMeter(
      { ...config, model: family.model, name: `provider-${index}`, baseUrl: `https://provider-${index}.invalid` },
      candidate.model, {}, candidate.resolution,
    ));
    expect(meters.map(meter => meter.descriptor.profile)).toEqual(Array.from({ length: 4 }, () => family.profile));
    expect(meters.map(meter => meter.descriptor.configuredModel)).toEqual(Array.from({ length: 4 }, () => family.model));
    for (const meter of meters) {
      expect(meter.measure({ messages: [{ role: 'user', content: 'hello' }] })).toMatchObject({
        kind: 'estimated', method: family.method,
      });
    }
  });

  it('changes the selected family when only the configured model name changes', () => {
    const candidate = candidates('deepseek-flash[1m]');
    const methods = FAMILIES.map(family =>
      qualifyMeter(family.model, candidate.resolution, candidate.model).method);
    const profiles = FAMILIES.map(family => createInputMeter(
      { ...config, model: family.model }, candidate.model, {}, candidate.resolution,
    ).descriptor.profile);
    expect(methods).toEqual(FAMILIES.map(family => family.method));
    expect(profiles).toEqual(FAMILIES.map(family => family.profile));
    expect(new Set(methods).size).toBe(FAMILIES.length);
  });

  it('resolves Qwen gateway models by configured names instead of the gateway provider', () => {
    const expected = new Map([
      ['deepseek-v4-pro', 'deepseek-v41-text'],
      ['glm-5.3', 'glm5.3-text'],
      ['kimi-k2.7-code', 'kimi-k3-text'],
      ['qwen3.8-max', 'qwen3.8-text'],
      ['MiniMax-M2.5', 'legacy-cl100k'],
    ]);
    const candidate = candidates('deepseek-flash[1m]');
    candidate.resolution = { ...candidate.resolution, providerId: 'qwen-token-plan' };
    for (const [configuredModel, method] of expected) {
      expect(qualifyMeter(configuredModel, candidate.resolution, candidate.model)).toMatchObject({ kind: 'estimated', method });
      expect(createInputMeter(
        { ...config, model: configuredModel }, candidate.model, {}, candidate.resolution,
      ).descriptor.method).toBe(method);
    }
  });

  it('uses cl100k for an unknown configured family even when the wire model is known', () => {
    const knownWire = candidates('kimi-k3');
    expect(qualifyMeter('unknown-model', knownWire.resolution, knownWire.model)).toMatchObject({
      kind: 'estimated', method: 'legacy-cl100k',
      projection: 'estimate-only:no-final-wire-projection', assetRevision: 'js-tiktoken:cl100k_base',
      limits: { supportedTools: 'declared' },
    });
  });

  it.each(FAMILIES)('estimates common text, tools, tool results, and thinking for $family', family => {
    const candidate = candidates(family.model);
    const meter = createInputMeter({ ...config, model: family.model }, candidate.model, {}, candidate.resolution);
    const input: CompleteInput = {
      system: 'rules',
      tools: [{ name: 'weather', description: 'read weather', input_schema: {
        type: 'object', properties: { city: { type: 'string' } }, required: ['city'],
      } }],
      messages: [
        { role: 'user', content: [
          { type: 'text', text: 'What is the weather?' },
          { type: 'tool_result', tool_use_id: 'call-1', content: [{ type: 'text', text: 'sunny' }] },
        ] },
        { role: 'assistant', content: [
          { type: 'thinking', thinking: 'use the weather tool' },
          { type: 'tool_use', id: 'call-1', name: 'weather', input: { city: 'Paris' } },
        ] },
      ],
    };
    const first = meter.measure(input);
    expect(first).toMatchObject({ kind: 'estimated', method: family.method });
    expect(first.kind === 'estimated' ? first.tokens : 0).toBeGreaterThan(0);
    expect(meter.measure(input)).toEqual(first);
    expect(meter.descriptor.limits).toMatchObject({ supportedTools: 'declared' });
  });

  it.each(FAMILIES)('keeps image, audio, binary, and unknown parts unavailable for $family', family => {
    const candidate = candidates(family.model);
    const meter = createInputMeter({ ...config, model: family.model }, candidate.model, {}, candidate.resolution);
    const parts = [
      { type: 'image', source: { type: 'base64', data: 'AA==' } },
      { type: 'audio', source: { type: 'base64', data: 'AA==' } },
      { type: 'binary', data: new Uint8Array([1, 2]) },
      { type: 'unknown', value: 'do not stringify me' },
    ];
    for (const part of parts) {
      const result = meter.measure({ messages: [{ role: 'user', content: [part] }] });
      expect(result).toEqual({ kind: 'unavailable', reason: expect.stringMatching(/:non_text_content$/u) });
      expect(result).not.toMatchObject({ kind: 'counted', tokens: 0 });
    }
  });

  it.each(FAMILIES)('bounds message and tool collections for $family', family => {
    const candidate = candidates(family.model);
    const meter = createInputMeter({ ...config, model: family.model }, candidate.model, {}, candidate.resolution);
    const messages = Array.from({ length: 4_097 }, () => ({ role: 'user' as const, content: '' }));
    const tools = Array.from({ length: 257 }, (_, index) => ({
      name: `tool-${index}`, description: '', input_schema: { type: 'object' },
    }));
    expect(meter.measure({ messages })).toEqual({
      kind: 'unavailable', reason: expect.stringMatching(/:messages_limit_exceeded$/u),
    });
    expect(meter.measure({ messages: [], tools })).toEqual({
      kind: 'unavailable', reason: expect.stringMatching(/:tools_limit_exceeded$/u),
    });
  });

  it('keeps descriptor identity facts separate from tokenizer qualification', () => {
    const first = createInputMeter(config, model, {}, resolution);
    const otherResolution = { ...resolution, revision: 'other-revision', providerId: 'other-provider' };
    const second = createInputMeter(config, model, {}, otherResolution);
    expect(first.descriptor.profile).toBe(second.descriptor.profile);
    expect(first.descriptor.method).toBe(second.descriptor.method);
    expect(first.descriptor.revision).not.toBe(second.descriptor.revision);
  });

  it('records configured aliases separately from unchanged wire and window facts', () => {
    const first = createInputMeter({ ...config, model: 'kimi-k3' }, model, {}, resolution);
    const second = createInputMeter({ ...config, model: 'k3' }, model, {}, resolution);
    expect(first.descriptor).toMatchObject({
      model: model.id, configuredModel: 'kimi-k3', profile: KIMI_K3_TEXT_PROFILE_ID,
      windowResolution: resolution.window, effectiveMaxTokens: model.maxTokens,
    });
    expect(second.descriptor).toMatchObject({
      model: model.id, configuredModel: 'k3', profile: KIMI_K3_TEXT_PROFILE_ID,
      windowResolution: resolution.window, effectiveMaxTokens: model.maxTokens,
    });
    expect(first.descriptor.revision).not.toBe(second.descriptor.revision);
  });

  it('estimates declared tools but returns stable unavailable for multimodal input', async () => {
    const meter = await createLLMProvider(config).prepareInputMeter();
    const toolInput = meter.measure({
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ name: 'server', description: '', input_schema: { type: 'object' } }],
    });
    const multimodal = meter.measure({
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
      ] }],
    });
    expect(toolInput).toMatchObject({ kind: 'estimated', method: 'deepseek-v41-text', tokens: expect.any(Number) });
    expect(multimodal).toEqual({ kind: 'unavailable', reason: 'deepseek_v41_text_estimate_unavailable:non_text_content' });
    expect(meter.measure({ messages: [{ role: 'user', content: 'hello' }] }).kind).toBe('estimated');
  });
});
