import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Tokenizer } from '@huggingface/tokenizers';
import glmTokenizerSpec from '../../../src/foundation/llm-provider/tokenizers/glm53.tokenizer.json' with { type: 'json' };
import provenance from '../../../src/foundation/llm-provider/tokenizers/glm53.provenance.json' with { type: 'json' };
import {
  createGlm53TextMeter,
  GLM53_TEXT_ASSET_REVISION,
  GLM53_TEXT_PROFILE_ID,
  GLM53_TEXT_PROJECTION_REVISION,
} from '../../../src/foundation/llm-provider/glm53-text-meter.js';
import { createInputMeter } from '../../../src/foundation/llm-provider/input-meter.js';
import type { CatalogResolution } from '../../../src/foundation/llm-provider/catalog-strategy.js';
import type { CompleteInput, InputMeterDescriptor, ModelInputMeter } from '../../../src/foundation/llm-provider/input-meter-types.js';
import { createPiAiCredentialStore } from '../../../src/foundation/llm-provider/pi-ai-credentials.js';
import { resolvePiAiModel } from '../../../src/foundation/llm-provider/pi-ai-model.js';
import { loadPiAiRuntime } from '../../../src/foundation/llm-provider/pi-ai-runtime.js';
import type { ProviderConfig } from '../../../src/foundation/llm-provider/types.js';

/** Offline asset fixture only needs a short, positive provider timeout. */
const TEST_PROVIDER_TIMEOUT_MS = 1_000;
const referenceEncoder = new Tokenizer({ ...glmTokenizerSpec, added_tokens: [] }, {});
const config: ProviderConfig = {
  name: 'zai', model: 'glm-5.3', apiFormat: 'anthropic',
  baseUrl: 'https://api.z.ai/api/anthropic', catalogProvider: 'zai',
  catalogModel: 'glm-5.3', apiKey: 'offline-only', timeoutMs: TEST_PROVIDER_TIMEOUT_MS,
};

let meter: ModelInputMeter;
let model: ReturnType<typeof resolvePiAiModel>['model'];
let resolution: CatalogResolution;

beforeAll(async () => {
  ({ model, resolution } = resolvePiAiModel(await loadPiAiRuntime(), config));
  meter = createInputMeter(config, model, {}, resolution);
});

function referenceText(text: string): number {
  return text ? referenceEncoder.encode(text, { add_special_tokens: false }).ids.length : 0;
}

function estimatedTokens(input: CompleteInput): number {
  const result = meter.measure(input);
  expect(result).toMatchObject({
    kind: 'estimated', method: 'glm5.3-text', reason: 'context_trim_only:glm53_text',
  });
  return result.kind === 'estimated' ? result.tokens : -1;
}

describe('Glm53 local text meter', () => {
  it.each(['hello world', '中文与 English', '😀👨\u200d👩\u200d👧\u200d👦', 'line 1\nline 2', ''])(
    'estimates stable mixed text %j without chat markup',
    content => {
      const input = { messages: [{ role: 'user' as const, content }] };
      expect(estimatedTokens(input)).toBe(referenceText(content));
      expect(estimatedTokens(input)).toBe(referenceText(content));
    },
  );

  it('sums system and message content without role or control-token overhead', () => {
    const combined = {
      system: 'rules', messages: [
        { role: 'user' as const, content: 'question' },
        { role: 'assistant' as const, content: 'answer' },
      ],
    };
    expect(estimatedTokens(combined)).toBe(
      referenceText('rules') + referenceText('question') + referenceText('answer'),
    );
    expect(estimatedTokens({ messages: [] })).toBe(0);
  });

  it.each([
    ['tools', { messages: [{ role: 'user', content: 'hello' }], tools: [{ name: 'x', description: '', input_schema: {} }] }],
    ['non_text_content', { messages: [{ role: 'user', content: [{ type: 'image', source: { url: 'https://invalid' } }] }] }],
    ['non_text_content', { messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden' }] }] }],
    ['non_text_content', { messages: [{ role: 'user', content: [{ type: 'unknown', value: 'x' }] }] }],
    ['role:tool', { messages: [{ role: 'tool', content: 'result' }] }],
    ['control_token_in_text:<|user|>', { messages: [{ role: 'user', content: 'literal <|user|> text' }] }],
    ['control_token_in_text:<|begin_of_image|>', { messages: [{ role: 'user', content: 'literal <|begin_of_image|> text' }] }],
    ['control_token_in_text:<think>', { messages: [{ role: 'assistant', content: 'literal <think> text' }] }],
    ['non_text_system', { system: [{ type: 'text', text: 'rules' }], messages: [] }],
    ['duplicate_system', { system: 'one', messages: [{ role: 'system', content: 'two' }] }],
  ])('returns stable unavailable for %s instead of a zero or legacy fallback', (reason, input) => {
    const first = meter.measure(input as CompleteInput);
    expect(first).toEqual({
      kind: 'unavailable', reason: `glm53_text_estimate_unavailable:${reason}`,
    });
    expect(first).not.toMatchObject({ tokens: 0 });
    expect(meter.measure(input as CompleteInput)).toEqual(first);
  });

  it('isolates asset initialization and encoding failures in the affected meter', () => {
    const broken = createGlm53TextMeter(meter.descriptor, () => {
      throw new Error('missing test asset');
    });
    const expected = {
      kind: 'unavailable', reason: 'glm53_text_estimate_unavailable:asset_initialization_failed',
    };
    expect(broken.measure({ messages: [{ role: 'user', content: 'hello' }] })).toEqual(expected);
    expect(broken.measure({ messages: [{ role: 'user', content: 'hello' }] })).toEqual(expected);

    const failedEncoding = createGlm53TextMeter(meter.descriptor, () => ({
      encode(): never { throw new Error('bad encoding'); },
    }));
    expect(failedEncoding.measure({ messages: [{ role: 'user', content: 'hello' }] })).toEqual({
      kind: 'unavailable', reason: 'glm53_text_estimate_unavailable:encoding_failed:Error',
    });
    expect(meter.measure({ messages: [{ role: 'user', content: 'hello' }] }).kind).toBe('estimated');
  });

  it('does not fetch, refresh credentials, or write files while measuring', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const writeSpy = vi.spyOn(fs, 'writeFile');
    const writeSyncSpy = vi.spyOn(fs, 'writeFileSync');
    const read = vi.fn();
    const modify = vi.fn();
    createPiAiCredentialStore({ read, modify });
    try {
      expect(estimatedTokens({ messages: [{ role: 'user', content: 'offline' }] })).toBeGreaterThan(0);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(modify).not.toHaveBeenCalled();
      expect(writeSpy).not.toHaveBeenCalled();
      expect(writeSyncSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      writeSpy.mockRestore();
      writeSyncSpy.mockRestore();
    }
  });

  it('pins provenance and descriptor revisions and reuses only exact cached text', () => {
    const encoder = new Tokenizer({ ...glmTokenizerSpec, added_tokens: [] }, {});
    const encodeSpy = vi.spyOn(encoder, 'encode');
    const cached = createGlm53TextMeter(meter.descriptor, () => encoder);
    const input = { messages: [{ role: 'user' as const, content: 'cache me' }] };
    const first = cached.measure(input);
    const calls = encodeSpy.mock.calls.length;
    expect(cached.measure(input)).toEqual(first);
    expect(encodeSpy).toHaveBeenCalledTimes(calls);

    const otherDescriptor: InputMeterDescriptor = { ...meter.descriptor, revision: 'other-revision' };
    const isolated = createGlm53TextMeter(otherDescriptor, () => new Tokenizer({ ...glmTokenizerSpec, added_tokens: [] }, {}));
    expect(isolated.measure(input)).toEqual(first);
    expect(otherDescriptor.revision).not.toBe(meter.descriptor.revision);
    expect(meter.descriptor).toMatchObject({
      profile: GLM53_TEXT_PROFILE_ID,
      method: 'glm5.3-text',
      projection: GLM53_TEXT_PROJECTION_REVISION,
      assetRevision: GLM53_TEXT_ASSET_REVISION,
      limits: { supportedTools: 'none' },
    });
    const assetBytes = fs.readFileSync(new URL('../../../src/foundation/llm-provider/tokenizers/glm53.tokenizer.json', import.meta.url));
    const assetSha256 = createHash('sha256').update(assetBytes).digest('hex');
    expect(assetSha256).toBe(provenance.source.tokenizerSha256);
    expect(provenance.source.tokenizerSha256).toBe(GLM53_TEXT_ASSET_REVISION.split(':').at(-1));
    expect(provenance.conversion).toMatchObject({
      assetSha256,
      assetBytes: assetBytes.length,
    });
    expect(provenance.source.tokenizerBytes).toBe(assetBytes.length);
    const licenseBytes = fs.readFileSync(new URL('../../../src/foundation/llm-provider/tokenizers/LICENSE.glm53', import.meta.url));
    const licenseSha256 = createHash('sha256').update(licenseBytes).digest('hex');
    expect(provenance.license).toMatchObject({
      sourceSha256: licenseSha256,
      noticeSha256: licenseSha256,
      noticeBytes: licenseBytes.length,
    });
    expect(provenance.controlTokens).toEqual({
      '[gMASK]': 154822,
      '<sop>': 154824,
      '<|system|>': 154826,
      '<|user|>': 154827,
      '<|assistant|>': 154828,
    });
  });

  it('evicts oversized bounded-cache entries and never splits Unicode code points', () => {
    const chunks: string[] = [];
    const fakeEncoder = {
      encode(text: string): { ids: number[] } {
        chunks.push(text);
        return { ids: { length: text.length } as number[] };
      },
    };
    const cached = createGlm53TextMeter(meter.descriptor, () => fakeEncoder);
    const first = 'a'.repeat(9_000_000);
    const second = 'b'.repeat(9_000_000);
    const measure = (content: string): void => {
      expect(cached.measure({ messages: [{ role: 'user', content }] }).kind).toBe('estimated');
    };
    measure(first);
    const firstCalls = chunks.length;
    measure(first);
    expect(chunks).toHaveLength(firstCalls);
    measure(second);
    measure(first);
    expect(chunks.length).toBeGreaterThan(firstCalls * 2);

    chunks.length = 0;
    measure('😀'.repeat(400_001));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(/^[\uD800-\uDBFF]$/u.test(chunk.at(-1) ?? '')).toBe(false);
      expect(/^[\uDC00-\uDFFF]$/u.test(chunk.at(0) ?? '')).toBe(false);
    }
  });

  it('bundles the pinned tokenizer into the built ESM artifact', () => {
    const artifact = fs.readFileSync(new URL('../../../dist/index.js', import.meta.url), 'utf8');
    expect(artifact).toContain(GLM53_TEXT_ASSET_REVISION);
    expect(artifact).toContain('[gMASK]');
    expect(artifact).toContain('154822');
  });
});
