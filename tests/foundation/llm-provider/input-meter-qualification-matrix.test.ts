import { beforeAll, describe, expect, it } from 'vitest';
import { llmProviderCall } from '../../../src/foundation/llm-provider/index.js';
import { createLLMProvider } from '../../../src/foundation/llm-provider/provider-factory.js';
import type { ProviderConfig } from '../../../src/foundation/llm-provider/types.js';
import type { CatalogResolution } from '../../../src/foundation/llm-provider/catalog-strategy.js';
import {
  DEEPSEEK_PROJECTION_REVISION,
  DEEPSEEK_V41_ASSET_REVISION,
} from '../../../src/foundation/llm-provider/deepseek-input-projection.js';
import {
  createInputMeter,
  isDeepseekV41MeterProfile,
  qualifyMeter,
} from '../../../src/foundation/llm-provider/input-meter.js';
import {
  KIMI_K3_TEXT_ASSET_REVISION,
  KIMI_K3_TEXT_PROJECTION_REVISION,
} from '../../../src/foundation/llm-provider/kimi-k3-text-meter.js';
import {
  GLM53_TEXT_ASSET_REVISION,
  GLM53_TEXT_PROFILE_ID,
  GLM53_TEXT_PROJECTION_REVISION,
} from '../../../src/foundation/llm-provider/glm53-text-meter.js';
import {
  QWEN3_8_TEXT_ASSET_REVISION,
  QWEN3_8_TEXT_PROFILE_ID,
  QWEN3_8_TEXT_PROJECTION_REVISION,
} from '../../../src/foundation/llm-provider/qwen-text-meter.js';
import { resolvePiAiModel } from '../../../src/foundation/llm-provider/pi-ai-model.js';
import { loadPiAiRuntime } from '../../../src/foundation/llm-provider/pi-ai-runtime.js';

const TEST_PROVIDER_TIMEOUT_MS = 1_000;
const config: ProviderConfig = {
  name: 'deepseek', model: 'deepseek-flash[1m]', apiFormat: 'anthropic',
  baseUrl: 'https://api.deepseek.com/anthropic', catalogProvider: 'deepseek',
  catalogModel: 'deepseek-flash', apiKey: 'offline-only', temperature: 0, timeoutMs: TEST_PROVIDER_TIMEOUT_MS,
};

let model: ReturnType<typeof resolvePiAiModel>['model'];
let resolution: CatalogResolution;

beforeAll(async () => {
  ({ model, resolution } = resolvePiAiModel(await loadPiAiRuntime(), config));
});

describe('input meter qualification matrix', () => {
  it('counts only the resolved canonical DeepSeek identity with pinned projection and asset evidence', async () => {
    expect(model.id).toBe('deepseek-flash[1m]');
    expect(resolution).toMatchObject({
      kind: 'metadata_only', providerId: 'deepseek', modelId: 'deepseek-flash',
      wire: { model: 'deepseek-flash[1m]', api: 'anthropic-messages' },
    });
    expect(isDeepseekV41MeterProfile(model, resolution)).toBe(true);
    expect(qualifyMeter(resolution, model)).toEqual({
      kind: 'counted',
      method: 'deepseek-v41-template',
      projection: DEEPSEEK_PROJECTION_REVISION,
      assetRevision: DEEPSEEK_V41_ASSET_REVISION,
      limits: { supportedTools: 'client' },
    });

    const canonical = resolvePiAiModel(await loadPiAiRuntime(), { ...config, model: 'deepseek-flash' });
    expect(canonical.resolution.modelId).toBe('deepseek-flash');
    expect(qualifyMeter(canonical.resolution, canonical.model).kind).toBe('counted');
  });

  it('estimates only exact resolved Kimi K3 OpenAI identities with the local text profile', async () => {
    const kimi = resolvePiAiModel(await loadPiAiRuntime(), {
      name: 'moonshot', model: 'kimi-k3', apiFormat: 'openai',
      baseUrl: 'https://api.moonshot.cn/v1', catalogProvider: 'moonshotai-cn',
      catalogModel: 'kimi-k3', apiKey: 'offline-only', timeoutMs: TEST_PROVIDER_TIMEOUT_MS,
    });
    expect(kimi.resolution).toMatchObject({
      kind: 'metadata_only', providerId: 'moonshotai-cn', modelId: 'kimi-k3',
      wire: { model: 'kimi-k3', api: 'openai-completions' },
    });
    expect(qualifyMeter(kimi.resolution, kimi.model)).toEqual({
      kind: 'estimated',
      method: 'kimi-k3-text',
      projection: KIMI_K3_TEXT_PROJECTION_REVISION,
      assetRevision: KIMI_K3_TEXT_ASSET_REVISION,
      reason: 'context_trim_only:kimi_k3_text_projection',
      limits: { supportedTools: 'none' },
    });
    expect(createInputMeter(config, kimi.model, {}, kimi.resolution).measure({
      messages: [{ role: 'user', content: 'hello' }],
    })).toMatchObject({ kind: 'estimated', method: 'kimi-k3-text' });

    const global = resolvePiAiModel(await loadPiAiRuntime(), {
      name: 'moonshot-global', model: 'kimi-k3', piAiProvider: 'moonshotai',
      apiKey: 'offline-only', timeoutMs: TEST_PROVIDER_TIMEOUT_MS,
    });
    expect(global.resolution.kind).toBe('catalog_model');
    expect(qualifyMeter(global.resolution, global.model).method).toBe('kimi-k3-text');
  });

  it.each([
    ['catalog revision', () => ({
      candidateModel: model,
      candidateResolution: { ...resolution, revision: 'pi-ai@0.0.0' },
    })],
    ['provider', () => ({
      candidateModel: model,
      candidateResolution: { ...resolution, providerId: 'fireworks' },
    })],
    ['canonical model', () => ({
      candidateModel: model,
      candidateResolution: { ...resolution, modelId: 'deepseek-v4-pro' },
    })],
    ['wire model', () => ({
      candidateModel: model,
      candidateResolution: {
        ...resolution,
        wire: { ...resolution.wire, model: 'deepseek-flash-latest' },
      },
    })],
    ['protocol', () => ({
      candidateModel: { ...model, api: 'openai-completions' } as typeof model,
      candidateResolution: {
        ...resolution,
        wire: { ...resolution.wire, api: 'openai-completions' },
      },
    })],
    ['resolution kind', () => ({
      candidateModel: model,
      candidateResolution: { ...resolution, kind: 'catalog_model' },
    })],
  ])('keeps a mismatched %s on the legacy estimated path', (_name, candidates) => {
    const { candidateModel, candidateResolution } = candidates();
    const qualification = qualifyMeter(candidateResolution as CatalogResolution, candidateModel);
    expect(isDeepseekV41MeterProfile(candidateModel, candidateResolution as CatalogResolution)).toBe(false);
    expect(qualification).toMatchObject({
      kind: 'estimated',
      method: 'legacy-cl100k',
      projection: 'estimate-only:no-final-wire-projection',
      assetRevision: 'js-tiktoken:cl100k_base',
      reason: expect.stringMatching(/^unsupported_model_or_protocol:/),
      limits: { supportedTools: 'declared' },
    });
  });

  it('does not let a same-name custom model inherit counted qualification', async () => {
    const custom = resolvePiAiModel(await loadPiAiRuntime(), {
      ...config,
      catalogProvider: undefined,
      catalogModel: undefined,
      piAiProvider: undefined,
    });
    expect(qualifyMeter(custom.resolution, custom.model)).toMatchObject({
      kind: 'estimated',
      method: 'legacy-cl100k',
      reason: expect.stringContaining('catalog=custom'),
    });
  });

  it('keeps same-name K3 provider, API, and unresolved identities on legacy estimated', async () => {
    const kimi = resolvePiAiModel(await loadPiAiRuntime(), {
      name: 'moonshot', model: 'kimi-k3', piAiProvider: 'moonshotai',
      apiKey: 'offline-only', timeoutMs: TEST_PROVIDER_TIMEOUT_MS,
    });
    const candidates = [
      {
        candidateModel: kimi.model,
        candidateResolution: { ...kimi.resolution, providerId: 'fireworks' },
      },
      {
        candidateModel: { ...kimi.model, api: 'anthropic-messages' } as typeof kimi.model,
        candidateResolution: {
          ...kimi.resolution,
          wire: { ...kimi.resolution.wire, api: 'anthropic-messages' },
        },
      },
      {
        candidateModel: kimi.model,
        candidateResolution: { ...kimi.resolution, kind: 'custom', providerId: undefined },
      },
    ];
    for (const { candidateModel, candidateResolution } of candidates) {
      expect(qualifyMeter(candidateResolution as CatalogResolution, candidateModel)).toMatchObject({
        kind: 'estimated', method: 'legacy-cl100k', limits: { supportedTools: 'declared' },
      });
    }
  });

  it('uses one estimated Qwen3.8 asset for canonical Qwen3.7, Qwen3.8, and Qwen4 families', async () => {
    const qwenConfig: ProviderConfig = {
      name: 'qwen', model: 'qwen3.8-max', apiFormat: 'openai',
      baseUrl: 'https://coding.dashscope.aliyuncs.com/v1', catalogProvider: 'qwen-token-plan',
      catalogModel: 'qwen3.8-max', apiKey: 'offline-only', timeoutMs: TEST_PROVIDER_TIMEOUT_MS,
    };
    const runtime = await loadPiAiRuntime();
    const qwen38 = resolvePiAiModel(runtime, qwenConfig);
    const qwen37 = resolvePiAiModel(runtime, {
      ...qwenConfig,
      model: 'qwen3.7-plus', catalogProvider: 'qwen-token-plan-cn', catalogModel: 'qwen3.7-plus',
    });
    const qwen4Resolution = {
      ...qwen38.resolution,
      modelId: 'qwen4-max',
      wire: { ...qwen38.resolution.wire, model: 'qwen4-max' },
    } as CatalogResolution;
    const qwen4Model = { ...qwen38.model, id: 'qwen4-max' };

    for (const candidate of [qwen38, qwen37]) {
      expect(candidate.resolution).toMatchObject({
        providerId: expect.stringMatching(/^qwen-token-plan/),
        wire: { api: 'openai-completions' },
      });
    }
    for (const [candidateModel, candidateResolution] of [
      [qwen38.model, qwen38.resolution],
      [qwen37.model, qwen37.resolution],
      [qwen4Model, qwen4Resolution],
    ] as const) {
      expect(qualifyMeter(candidateResolution, candidateModel)).toEqual({
        kind: 'estimated',
        method: 'qwen3.8-text',
        projection: QWEN3_8_TEXT_PROJECTION_REVISION,
        assetRevision: QWEN3_8_TEXT_ASSET_REVISION,
        reason: 'context_trim_only:qwen_text_projection',
        limits: { supportedTools: 'none' },
      });
      const candidateMeter = createInputMeter(qwenConfig, candidateModel, {}, candidateResolution);
      expect(candidateMeter.descriptor.profile).toBe(QWEN3_8_TEXT_PROFILE_ID);
      expect(candidateMeter.measure({ messages: [{ role: 'user', content: 'hello' }] })).toMatchObject({
        kind: 'estimated', method: 'qwen3.8-text',
      });
    }
  });

  it('keeps Qwen gateway other vendors and mismatched Qwen identities on legacy estimated', async () => {
    const qwen = resolvePiAiModel(await loadPiAiRuntime(), {
      name: 'qwen', model: 'qwen3.8-max', apiFormat: 'openai',
      baseUrl: 'https://coding.dashscope.aliyuncs.com/v1', catalogProvider: 'qwen-token-plan',
      catalogModel: 'qwen3.8-max', apiKey: 'offline-only', timeoutMs: TEST_PROVIDER_TIMEOUT_MS,
    });
    const otherVendors = ['deepseek-v4-pro', 'glm-5.3', 'kimi-k2.7-code', 'MiniMax-M2.5'];
    const candidates = [
      ...otherVendors.map(modelId => ({
        candidateModel: { ...qwen.model, id: modelId },
        candidateResolution: {
          ...qwen.resolution, modelId, wire: { ...qwen.resolution.wire, model: modelId },
        },
      })),
      {
        candidateModel: qwen.model,
        candidateResolution: { ...qwen.resolution, providerId: 'openrouter' },
      },
      {
        candidateModel: qwen.model,
        candidateResolution: { ...qwen.resolution, modelId: 'qwen3.6-flash' },
      },
      {
        candidateModel: qwen.model,
        candidateResolution: { ...qwen.resolution, revision: 'pi-ai@0.0.0' },
      },
      {
        candidateModel: { ...qwen.model, api: 'anthropic-messages' } as typeof qwen.model,
        candidateResolution: {
          ...qwen.resolution,
          wire: { ...qwen.resolution.wire, api: 'anthropic-messages' },
        },
      },
      {
        candidateModel: qwen.model,
        candidateResolution: {
          ...qwen.resolution,
          wire: { ...qwen.resolution.wire, model: 'qwen3.8-flash' },
        },
      },
      {
        candidateModel: qwen.model,
        candidateResolution: { ...qwen.resolution, kind: 'custom', providerId: undefined },
      },
    ];
    for (const { candidateModel, candidateResolution } of candidates) {
      expect(qualifyMeter(candidateResolution as CatalogResolution, candidateModel)).toMatchObject({
        kind: 'estimated', method: 'legacy-cl100k', limits: { supportedTools: 'declared' },
      });
    }
  });

  it('uses one estimated GLM-5.3 asset for canonical Z.AI GLM families and wire formats', async () => {
    const runtime = await loadPiAiRuntime();
    const zaiConfig: ProviderConfig = {
      name: 'zai', model: 'glm-5.3', apiFormat: 'anthropic',
      baseUrl: 'https://api.z.ai/api/anthropic', catalogProvider: 'zai',
      catalogModel: 'glm-5.3', apiKey: 'offline-only', timeoutMs: TEST_PROVIDER_TIMEOUT_MS,
    };
    const zai53 = resolvePiAiModel(runtime, zaiConfig);
    const coding53 = resolvePiAiModel(runtime, {
      name: 'zai-coding', model: 'glm-5.3-flash', piAiProvider: 'zai-coding-cn',
      apiKey: 'offline-only', timeoutMs: TEST_PROVIDER_TIMEOUT_MS,
    });
    const zai47 = resolvePiAiModel(runtime, {
      name: 'zai-openai', model: 'glm-4.7', piAiProvider: 'zai',
      apiKey: 'offline-only', timeoutMs: TEST_PROVIDER_TIMEOUT_MS,
    });

    expect(zai53.resolution.wire.api).toBe('anthropic-messages');
    expect(coding53.resolution.wire.api).toBe('openai-completions');
    for (const candidate of [zai53, coding53, zai47]) {
      expect(qualifyMeter(candidate.resolution, candidate.model)).toEqual({
        kind: 'estimated',
        method: 'glm5.3-text',
        projection: GLM53_TEXT_PROJECTION_REVISION,
        assetRevision: GLM53_TEXT_ASSET_REVISION,
        reason: 'context_trim_only:glm53_text_projection',
        limits: { supportedTools: 'none' },
      });
      const candidateMeter = createInputMeter(zaiConfig, candidate.model, {}, candidate.resolution);
      expect(candidateMeter.descriptor.profile).toBe(GLM53_TEXT_PROFILE_ID);
      expect(candidateMeter.measure({ messages: [{ role: 'user', content: 'hello' }] })).toMatchObject({
        kind: 'estimated', method: 'glm5.3-text',
      });
    }
  });

  it('keeps GLM gateways, V models, other vendors, and mismatched identities on legacy estimated', async () => {
    const zai = resolvePiAiModel(await loadPiAiRuntime(), {
      name: 'zai', model: 'glm-5.3', apiFormat: 'anthropic',
      baseUrl: 'https://api.z.ai/api/anthropic', catalogProvider: 'zai',
      catalogModel: 'glm-5.3', apiKey: 'offline-only', timeoutMs: TEST_PROVIDER_TIMEOUT_MS,
    });
    const consistentModel = (modelId: string) => ({
      candidateModel: { ...zai.model, id: modelId },
      candidateResolution: {
        ...zai.resolution, modelId, wire: { ...zai.resolution.wire, model: modelId },
      },
    });
    const candidates = [
      ...['openrouter', 'qwen-token-plan', 'opencode'].map(providerId => ({
        candidateModel: zai.model,
        candidateResolution: { ...zai.resolution, providerId },
      })),
      consistentModel('qwen3.8-max'),
      consistentModel('glm-4.6v'),
      consistentModel('glm-4.4'),
      {
        candidateModel: zai.model,
        candidateResolution: { ...zai.resolution, revision: 'pi-ai@0.0.0' },
      },
      {
        candidateModel: { ...zai.model, api: 'openai-completions' } as typeof zai.model,
        candidateResolution: zai.resolution,
      },
      {
        candidateModel: zai.model,
        candidateResolution: {
          ...zai.resolution, wire: { ...zai.resolution.wire, model: 'glm-5.3-flash' },
        },
      },
      {
        candidateModel: zai.model,
        candidateResolution: { ...zai.resolution, kind: 'custom', providerId: undefined },
      },
    ];
    for (const { candidateModel, candidateResolution } of candidates) {
      expect(qualifyMeter(candidateResolution as CatalogResolution, candidateModel)).toMatchObject({
        kind: 'estimated', method: 'legacy-cl100k', limits: { supportedTools: 'declared' },
      });
    }
  });

  it('isolates descriptor cache keys when qualification identity changes', () => {
    const counted = createInputMeter(config, model, {}, resolution);
    const wrongRevision = {
      ...resolution,
      revision: 'pi-ai@0.0.0',
    };
    const estimated = createInputMeter(config, model, {}, wrongRevision);

    expect(counted.descriptor).toMatchObject({
      profile: 'deepseek-v41-flash-1017-v1',
      assetRevision: DEEPSEEK_V41_ASSET_REVISION,
    });
    expect(estimated.descriptor).toMatchObject({
      profile: 'legacy-cl100k-v2',
      assetRevision: 'js-tiktoken:cl100k_base',
    });
    expect(estimated.descriptor.revision).not.toBe(counted.descriptor.revision);
  });

  it('fails unsupported tools and multimodal blocks instead of estimating a counted profile', async () => {
    const meter = await createLLMProvider(config).prepareInputMeter();
    const serverTool = meter.measure({
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{
        name: 'server', description: '', input_schema: { type: 'object' },
        type: 'computer_20250101',
      } as never],
    });
    const multimodal = meter.measure({
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
      ] }],
    });

    expect(serverTool).toMatchObject({
      kind: 'unavailable', reason: expect.stringContaining('unsupported server/deferred tool'),
    });
    expect(multimodal).toMatchObject({
      kind: 'unavailable', reason: expect.stringContaining('unsupported content: image'),
    });
  });
});
