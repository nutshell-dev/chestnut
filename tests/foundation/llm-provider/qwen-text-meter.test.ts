import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Tokenizer } from '@huggingface/tokenizers';
import qwenTokenizerSpec from '../../../src/foundation/llm-provider/tokenizers/qwen3.8.tokenizer.json' with { type: 'json' };
import provenance from '../../../src/foundation/llm-provider/tokenizers/qwen3.8.provenance.json' with { type: 'json' };
import {
  createQwenTextMeter,
  QWEN3_8_TEXT_ASSET_REVISION,
  QWEN3_8_TEXT_PROFILE_ID,
  QWEN3_8_TEXT_PROJECTION_REVISION,
} from '../../../src/foundation/llm-provider/qwen-text-meter.js';
import { createInputMeter } from '../../../src/foundation/llm-provider/input-meter.js';
import type { CatalogResolution } from '../../../src/foundation/llm-provider/catalog-strategy.js';
import type { CompleteInput, InputMeterDescriptor, ModelInputMeter } from '../../../src/foundation/llm-provider/input-meter-types.js';
import { createPiAiCredentialStore } from '../../../src/foundation/llm-provider/pi-ai-credentials.js';
import { resolvePiAiModel } from '../../../src/foundation/llm-provider/pi-ai-model.js';
import { loadPiAiRuntime } from '../../../src/foundation/llm-provider/pi-ai-runtime.js';
import type { ProviderConfig } from '../../../src/foundation/llm-provider/types.js';

/** Offline asset fixture only needs a short, positive provider timeout. */
const TEST_PROVIDER_TIMEOUT_MS = 1_000;
const referenceEncoder = new Tokenizer({ ...qwenTokenizerSpec, added_tokens: [] }, {});
const config: ProviderConfig = {
  name: 'qwen', model: 'qwen3.8-max', apiFormat: 'openai',
  baseUrl: 'https://coding.dashscope.aliyuncs.com/v1', catalogProvider: 'qwen-token-plan',
  catalogModel: 'qwen3.8-max', apiKey: 'offline-only', timeoutMs: TEST_PROVIDER_TIMEOUT_MS,
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
    kind: 'estimated', method: 'qwen3.8-text', reason: 'context_trim_only:qwen_text',
  });
  return result.kind === 'estimated' ? result.tokens : -1;
}

describe('Qwen local text meter', () => {
  it.each(['hello world', '中文与 English', '😀👨\u200d👩\u200d👧\u200d👦', 'line 1\nline 2', ''])(
    'estimates stable mixed text %j without chat markup',
    content => {
      const input = { messages: [{ role: 'user' as const, content }] };
      expect(estimatedTokens(input)).toBe(referenceText(content));
      expect(estimatedTokens(input)).toBe(referenceText(content));
    },
  );

  it('sums system and message content without IM markup', () => {
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
    ['control_token_in_text:<|im_start|>', { messages: [{ role: 'user', content: 'literal <|im_start|> text' }] }],
    ['control_token_in_text:<|image_pad|>', { messages: [{ role: 'user', content: 'literal <|image_pad|> text' }] }],
    ['duplicate_system', { system: 'one', messages: [{ role: 'system', content: 'two' }] }],
  ])('returns stable unavailable for %s instead of a zero or legacy fallback', (reason, input) => {
    const first = meter.measure(input as CompleteInput);
    expect(first).toEqual({
      kind: 'unavailable', reason: `qwen_text_estimate_unavailable:${reason}`,
    });
    expect(first).not.toMatchObject({ tokens: 0 });
    expect(meter.measure(input as CompleteInput)).toEqual(first);
  });

  it('isolates asset initialization and encoding failures in the affected meter', () => {
    const broken = createQwenTextMeter(meter.descriptor, () => {
      throw new Error('missing test asset');
    });
    const expected = {
      kind: 'unavailable', reason: 'qwen_text_estimate_unavailable:asset_initialization_failed',
    };
    expect(broken.measure({ messages: [{ role: 'user', content: 'hello' }] })).toEqual(expected);
    expect(broken.measure({ messages: [{ role: 'user', content: 'hello' }] })).toEqual(expected);

    const failedEncoding = createQwenTextMeter(meter.descriptor, () => ({
      encode(): never { throw new Error('bad encoding'); },
    }));
    expect(failedEncoding.measure({ messages: [{ role: 'user', content: 'hello' }] })).toEqual({
      kind: 'unavailable', reason: 'qwen_text_estimate_unavailable:encoding_failed:Error',
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
    const encoder = new Tokenizer({ ...qwenTokenizerSpec, added_tokens: [] }, {});
    const encodeSpy = vi.spyOn(encoder, 'encode');
    const cached = createQwenTextMeter(meter.descriptor, () => encoder);
    const input = { messages: [{ role: 'user' as const, content: 'cache me' }] };
    const first = cached.measure(input);
    const calls = encodeSpy.mock.calls.length;
    expect(cached.measure(input)).toEqual(first);
    expect(encodeSpy).toHaveBeenCalledTimes(calls);

    const otherDescriptor: InputMeterDescriptor = { ...meter.descriptor, revision: 'other-revision' };
    const isolated = createQwenTextMeter(otherDescriptor, () => new Tokenizer({ ...qwenTokenizerSpec, added_tokens: [] }, {}));
    expect(isolated.measure(input)).toEqual(first);
    expect(otherDescriptor.revision).not.toBe(meter.descriptor.revision);
    expect(meter.descriptor).toMatchObject({
      profile: QWEN3_8_TEXT_PROFILE_ID,
      method: 'qwen3.8-text',
      projection: QWEN3_8_TEXT_PROJECTION_REVISION,
      assetRevision: QWEN3_8_TEXT_ASSET_REVISION,
      limits: { supportedTools: 'none' },
    });
    const assetBytes = fs.readFileSync(new URL('../../../src/foundation/llm-provider/tokenizers/qwen3.8.tokenizer.json', import.meta.url));
    expect(createHash('sha256').update(assetBytes).digest('hex')).toBe(provenance.source.tokenizerSha256);
    expect(provenance.source.tokenizerSha256).toBe(QWEN3_8_TEXT_ASSET_REVISION.split(':').at(-1));
    expect(provenance.controlTokens).toEqual({ '<|im_start|>': 248045, '<|im_end|>': 248046 });
  });

  it('evicts oversized bounded-cache entries and never splits Unicode code points', () => {
    const chunks: string[] = [];
    const fakeEncoder = {
      encode(text: string): { ids: number[] } {
        chunks.push(text);
        return { ids: { length: text.length } as number[] };
      },
    };
    const cached = createQwenTextMeter(meter.descriptor, () => fakeEncoder);
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
    expect(artifact).toContain(QWEN3_8_TEXT_ASSET_REVISION);
    expect(artifact).toContain('<|im_start|>');
    expect(artifact).toContain('248044');
  });
});
