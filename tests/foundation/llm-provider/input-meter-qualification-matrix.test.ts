import { beforeAll, describe, expect, it } from 'vitest';
import { llmProviderCall } from '../../../src/foundation/llm-provider/index.js';
const { createLLMProvider } = llmProviderCall;
import type { llmProviderConfigContract } from '../../../src/foundation/llm-provider/index.js';
type ProviderConfig = llmProviderConfigContract.ProviderConfig;
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
