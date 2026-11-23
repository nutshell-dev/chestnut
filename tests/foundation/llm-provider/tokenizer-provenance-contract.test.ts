import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import kimiProvenance from '../../../src/foundation/llm-provider/tokenizers/kimi-k3.provenance.json' with { type: 'json' };
import qwenProvenance from '../../../src/foundation/llm-provider/tokenizers/qwen3.8.provenance.json' with { type: 'json' };
import glmProvenance from '../../../src/foundation/llm-provider/tokenizers/glm53.provenance.json' with { type: 'json' };
import {
  KIMI_K3_TEXT_ASSET_REVISION,
  KIMI_K3_TEXT_PROJECTION_REVISION,
} from '../../../src/foundation/llm-provider/kimi-k3-text-meter.js';
import {
  QWEN3_8_TEXT_ASSET_REVISION,
  QWEN3_8_TEXT_PROJECTION_REVISION,
} from '../../../src/foundation/llm-provider/qwen-text-meter.js';
import {
  GLM53_TEXT_ASSET_REVISION,
  GLM53_TEXT_PROJECTION_REVISION,
} from '../../../src/foundation/llm-provider/glm53-text-meter.js';
import { COMMON_INPUT_PROJECTION_REVISION } from '../../../src/foundation/llm-provider/common-input-projection.js';
import { createInputMeter } from '../../../src/foundation/llm-provider/input-meter.js';
import { resolveModelFamily } from '../../../src/foundation/llm-provider/model-family-resolver.js';
import { resolvePiAiModel } from '../../../src/foundation/llm-provider/pi-ai-model.js';
import { loadPiAiRuntime } from '../../../src/foundation/llm-provider/pi-ai-runtime.js';
import type { CatalogResolution } from '../../../src/foundation/llm-provider/catalog-strategy.js';
import type { CompleteInput } from '../../../src/foundation/llm-provider/input-meter-types.js';
import type { ProviderConfig } from '../../../src/foundation/llm-provider/types.js';

const TEST_PROVIDER_TIMEOUT_MS = 1_000;
const config: ProviderConfig = {
  name: 'gateway', model: 'deepseek-flash[1m]', apiFormat: 'anthropic',
  baseUrl: 'https://gateway.invalid/anthropic', catalogProvider: 'deepseek',
  catalogModel: 'deepseek-flash', apiKey: 'offline-only', timeoutMs: TEST_PROVIDER_TIMEOUT_MS,
};

const FAMILIES = [
  {
    family: 'kimi', configuredModel: 'kimi-k3', method: 'kimi-k3-text',
    provenance: kimiProvenance, assetRevision: KIMI_K3_TEXT_ASSET_REVISION,
    projectionRevision: KIMI_K3_TEXT_PROJECTION_REVISION,
    controlToken: '<|open|>', unavailablePrefix: 'kimi_k3_text_estimate_unavailable',
  },
  {
    family: 'qwen', configuredModel: 'qwen3.8-max', method: 'qwen3.8-text',
    provenance: qwenProvenance, assetRevision: QWEN3_8_TEXT_ASSET_REVISION,
    projectionRevision: QWEN3_8_TEXT_PROJECTION_REVISION,
    controlToken: '<|im_start|>', unavailablePrefix: 'qwen_text_estimate_unavailable',
  },
  {
    family: 'glm', configuredModel: 'glm-5.3', method: 'glm5.3-text',
    provenance: glmProvenance, assetRevision: GLM53_TEXT_ASSET_REVISION,
    projectionRevision: GLM53_TEXT_PROJECTION_REVISION,
    controlToken: '<|user|>', unavailablePrefix: 'glm53_text_estimate_unavailable',
  },
] as const;

const COMMON_INPUT: CompleteInput = {
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

let model: ReturnType<typeof resolvePiAiModel>['model'];
let resolution: CatalogResolution;

beforeAll(async () => {
  ({ model, resolution } = resolvePiAiModel(await loadPiAiRuntime(), config));
});

function createFamilyMeter(family: (typeof FAMILIES)[number]) {
  return createInputMeter({ ...config, model: family.configuredModel }, model, {}, resolution);
}

describe('tokenizer provenance contract', () => {
  it.each(FAMILIES)('pins the actual $family asset bytes and current runtime declaration', family => {
    const assetBytes = fs.readFileSync(new URL(
      `../../../src/foundation/llm-provider/tokenizers/${family.provenance.asset}`, import.meta.url,
    ));
    const assetSha256 = createHash('sha256').update(assetBytes).digest('hex');
    expect(family.provenance.conversion).toMatchObject({
      assetSha256, assetBytes: assetBytes.length,
    });
    expect(family.assetRevision).toContain(assetSha256);
    expect(family.provenance.runtime).toMatchObject({
      networkDownload: false,
      remoteTokenApi: false,
      kind: 'estimated',
      selection: 'configured-model-family',
      projection: family.projectionRevision,
      inputProjection: COMMON_INPUT_PROJECTION_REVISION,
      supportedInputs: ['text', 'tool_definitions', 'tool_use', 'tool_result', 'thinking_text'],
    });
  });

  it('keeps Kimi derived asset identity separate from its upstream model identity', () => {
    expect(kimiProvenance.conversion.assetSha256).not.toBe(kimiProvenance.source.modelSha256);
    expect(KIMI_K3_TEXT_ASSET_REVISION).toContain(kimiProvenance.source.modelSha256);
    expect(KIMI_K3_TEXT_ASSET_REVISION).toContain(kimiProvenance.conversion.version);
  });

  it.each([
    { provenance: qwenProvenance, assetRevision: QWEN3_8_TEXT_ASSET_REVISION },
    { provenance: glmProvenance, assetRevision: GLM53_TEXT_ASSET_REVISION },
  ])('keeps the verbatim $provenance.source.repository asset identity unchanged', ({ provenance, assetRevision }) => {
    expect(provenance.conversion.assetSha256).toBe(provenance.source.tokenizerSha256);
    expect(provenance.conversion.assetBytes).toBe(provenance.source.tokenizerBytes);
    expect(assetRevision).toBe(
      `${provenance.source.repository}:tokenizer.json:${provenance.source.tokenizerSha256}`,
    );
  });

  it.each(FAMILIES)('estimates common-input tools and thinking for $family across provider and API identities', family => {
    expect(resolveModelFamily(family.configuredModel)).toBe(family.family);
    const meter = createFamilyMeter(family);
    const result = meter.measure(COMMON_INPUT);
    expect(result).toMatchObject({ kind: 'estimated', method: family.method });
    expect(result.kind === 'estimated' ? result.tokens : 0).toBeGreaterThan(0);
    expect(meter.descriptor.projection).toBe(family.projectionRevision);
  });

  it('uses cl100k for an unknown configured family even with a known wire model', () => {
    const meter = createInputMeter({ ...config, model: 'unknown-model' }, model, {}, resolution);
    expect(meter.descriptor).toMatchObject({ method: 'legacy-cl100k', assetRevision: 'js-tiktoken:cl100k_base' });
    expect(meter.measure({ messages: [{ role: 'user', content: 'hello' }] })).toMatchObject({
      kind: 'estimated', method: 'legacy-cl100k',
    });
  });

  it.each(FAMILIES)('keeps unsupported input boundaries unchanged for $family', family => {
    const meter = createFamilyMeter(family);
    expect(meter.measure({ messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', data: 'AA==' } },
    ] }] })).toEqual({
      kind: 'unavailable', reason: `${family.unavailablePrefix}:non_text_content`,
    });
    expect(meter.measure({ messages: [{ role: 'user', content: family.controlToken }] })).toEqual({
      kind: 'unavailable', reason: `${family.unavailablePrefix}:control_token_in_text:${family.controlToken}`,
    });
    expect(meter.measure({
      system: 'one', messages: [{ role: 'system', content: 'two' }],
    })).toEqual({
      kind: 'unavailable', reason: `${family.unavailablePrefix}:duplicate_system`,
    });
  });
});
