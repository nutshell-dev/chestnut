import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Tiktoken } from 'js-tiktoken/lite';
import kimiK3Bpe from '../../../src/foundation/llm-provider/tokenizers/kimi-k3.tiktoken.json' with { type: 'json' };
import provenance from '../../../src/foundation/llm-provider/tokenizers/kimi-k3.provenance.json' with { type: 'json' };
import {
  createKimiK3TextMeter,
  KIMI_K3_TEXT_ASSET_REVISION,
  KIMI_K3_TEXT_PROFILE_ID,
  KIMI_K3_TEXT_PROJECTION_REVISION,
} from '../../../src/foundation/llm-provider/kimi-k3-text-meter.js';
import { createInputMeter } from '../../../src/foundation/llm-provider/input-meter.js';
import { createLLMProvider } from '../../../src/foundation/llm-provider/provider-factory.js';
import type { CatalogResolution } from '../../../src/foundation/llm-provider/catalog-strategy.js';
import type { CompleteInput, InputMeterDescriptor, ModelInputMeter } from '../../../src/foundation/llm-provider/input-meter-types.js';
import { createPiAiCredentialStore } from '../../../src/foundation/llm-provider/pi-ai-credentials.js';
import { resolvePiAiModel } from '../../../src/foundation/llm-provider/pi-ai-model.js';
import { loadPiAiRuntime } from '../../../src/foundation/llm-provider/pi-ai-runtime.js';
import type { ProviderConfig } from '../../../src/foundation/llm-provider/types.js';

const CONTROLS = ['<|open|>', '<|close|>', '<|sep|>', '<|end_of_msg|>'] as const;
/** Offline asset fixture only needs a short, positive provider timeout. */
const TEST_PROVIDER_TIMEOUT_MS = 1_000;
const referenceEncoder = new Tiktoken(kimiK3Bpe);
const config: ProviderConfig = {
  name: 'moonshot', model: 'kimi-k3', apiFormat: 'openai',
  baseUrl: 'https://api.moonshot.cn/v1', catalogProvider: 'moonshotai-cn',
  catalogModel: 'kimi-k3', apiKey: 'offline-only', timeoutMs: TEST_PROVIDER_TIMEOUT_MS,
};

let meter: ModelInputMeter;
let model: ReturnType<typeof resolvePiAiModel>['model'];
let resolution: CatalogResolution;

beforeAll(async () => {
  ({ model, resolution } = resolvePiAiModel(await loadPiAiRuntime(), config));
  meter = createInputMeter(config, model, {}, resolution);
});

function referenceText(text: string): number {
  return text ? referenceEncoder.encode(text, [], [...CONTROLS]).length : 0;
}

function independentChunkSum(text: string): number {
  const points = Array.from(text);
  let total = 0;
  for (let start = 0; start < points.length; start += 25_000) {
    total += referenceText(points.slice(start, start + 25_000).join(''));
  }
  return total;
}

const TEXT_CHUNKING = {
  unit: 'unicode-code-point',
  maxCodePoints: 25_000,
  scope: 'each-common-input-text-segment',
  aggregation: 'sum-independent-encodings',
  wholeTextEquivalence: 'not-guaranteed',
} as const;

const CHUNK_BOUNDARY_CASES = [
  { name: 'below', text: 'a '.repeat(12_499) + 'x', codePoints: 24_999, chunkedTokens: 12_500, wholeTokens: 12_500 },
  { name: 'at', text: 'a '.repeat(12_500), codePoints: 25_000, chunkedTokens: 12_501, wholeTokens: 12_501 },
  { name: 'above', text: 'a '.repeat(12_500) + 'x', codePoints: 25_001, chunkedTokens: 12_502, wholeTokens: 12_501 },
  { name: 'ascii-merge', text: 'a '.repeat(12_499) + 'hello world', codePoints: 25_009, chunkedTokens: 12_503, wholeTokens: 12_501 },
  { name: 'cjk-merge', text: 'a '.repeat(12_499) + '中华人民共和国', codePoints: 25_005, chunkedTokens: 12_503, wholeTokens: 12_501 },
  { name: 'whitespace-run', text: 'a '.repeat(12_499) + '    x', codePoints: 25_003, chunkedTokens: 12_502, wholeTokens: 12_501 },
  { name: 'non-bmp-at-edge', text: 'a '.repeat(12_499) + 'x😀end', codePoints: 25_003, chunkedTokens: 12_503, wholeTokens: 12_503 },
  { name: 'zwj-cross-edge', text: 'a '.repeat(12_499) + '👨\u200d👩\u200d👧\u200d👦end', codePoints: 25_008, chunkedTokens: 12_511, wholeTokens: 12_511 },
  { name: 'combining-cross-edge', text: 'a '.repeat(12_499) + 'xe\u0301end', codePoints: 25_004, chunkedTokens: 12_502, wholeTokens: 12_502 },
  { name: 'multiple-chunks', text: 'a '.repeat(24_999) + 'hello world', codePoints: 50_009, chunkedTokens: 25_004, wholeTokens: 25_001 },
] as const;

function estimatedTokens(input: CompleteInput): number {
  const result = meter.measure(input);
  expect(result).toMatchObject({
    kind: 'estimated', method: 'kimi-k3-text', reason: 'context_trim_only:kimi_k3_text',
  });
  return result.kind === 'estimated' ? result.tokens : -1;
}

describe('Kimi K3 local text meter', () => {
  it.each(['hello world', '中文与 English', '😀👨\u200d👩\u200d👧\u200d👦', 'line 1\nline 2', ''])(
    'estimates stable mixed text %j without chat markup',
    content => {
      const input = { messages: [{ role: 'user' as const, content }] };
      expect(estimatedTokens(input)).toBe(referenceText(content));
      expect(estimatedTokens(input)).toBe(referenceText(content));
    },
  );

  it('counts every structural control as its pinned special token', () => {
    for (const control of CONTROLS) {
      expect(referenceEncoder.encode(control, [control], [])).toEqual([
        provenance.controlTokens[control],
      ]);
    }
    expect(kimiK3Bpe.bpe_ranks.split(' ').length - 2).toBe(provenance.source.mergeableRanks);
  });

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
    ['non_text_content', { messages: [{ role: 'user', content: [{ type: 'image', source: { url: 'https://invalid' } }] }] }],
    ['role:tool', { messages: [{ role: 'tool', content: 'result' }] }],
    ['control_token_in_text:<|open|>', { messages: [{ role: 'user', content: 'literal <|open|> text' }] }],
    ['duplicate_system', { system: 'one', messages: [{ role: 'system', content: 'two' }] }],
  ])('returns stable unavailable for %s instead of a zero or legacy fallback', (reason, input) => {
    const first = meter.measure(input as CompleteInput);
    expect(first).toEqual({
      kind: 'unavailable', reason: `kimi_k3_text_estimate_unavailable:${reason}`,
    });
    expect(first).not.toMatchObject({ tokens: 0 });
    expect(meter.measure(input as CompleteInput)).toEqual(first);
  });

  it('isolates asset initialization failure in the affected meter', () => {
    const broken = createKimiK3TextMeter(meter.descriptor, () => {
      throw new Error('missing test asset');
    });
    const expected = {
      kind: 'unavailable', reason: 'kimi_k3_text_estimate_unavailable:asset_initialization_failed',
    };
    expect(broken.measure({ messages: [{ role: 'user', content: 'hello' }] })).toEqual(expected);
    expect(broken.measure({ messages: [{ role: 'user', content: 'hello' }] })).toEqual(expected);
    expect(meter.measure({ messages: [{ role: 'user', content: 'hello' }] }).kind).toBe('estimated');
  });

  it('reuses one encoder and exact text cache across descriptor-bound meter views', () => {
    const encoder = new Tiktoken(kimiK3Bpe);
    const factory = vi.fn(() => encoder);
    const encodeSpy = vi.spyOn(encoder, 'encode');
    const first = createKimiK3TextMeter(meter.descriptor, factory);
    const second = createKimiK3TextMeter({ ...meter.descriptor, revision: 'other-config-generation' }, factory);
    const input = { messages: [{ role: 'user' as const, content: 'shared across meter views' }] };

    const measurement = first.measure(input);
    expect(factory).toHaveBeenCalledTimes(1);
    const calls = encodeSpy.mock.calls.length;
    expect(second.measure(input)).toEqual(measurement);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(encodeSpy).toHaveBeenCalledTimes(calls);
    expect(second.descriptor.revision).toBe('other-config-generation');
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

  it('pins provenance and descriptor revisions and reuses only exact cached text', async () => {
    const encoder = new Tiktoken(kimiK3Bpe);
    const encodeSpy = vi.spyOn(encoder, 'encode');
    const cached = createKimiK3TextMeter(meter.descriptor, () => encoder);
    const input = { messages: [{ role: 'user' as const, content: 'cache me' }] };
    const first = cached.measure(input);
    const calls = encodeSpy.mock.calls.length;
    expect(cached.measure(input)).toEqual(first);
    expect(encodeSpy).toHaveBeenCalledTimes(calls);

    const otherDescriptor: InputMeterDescriptor = { ...meter.descriptor, revision: 'other-revision' };
    const isolated = createKimiK3TextMeter(otherDescriptor, () => new Tiktoken(kimiK3Bpe));
    expect(isolated.measure(input)).toEqual(first);
    expect(otherDescriptor.revision).not.toBe(meter.descriptor.revision);
    expect(meter.descriptor).toMatchObject({
      profile: KIMI_K3_TEXT_PROFILE_ID,
      method: 'kimi-k3-text',
      projection: KIMI_K3_TEXT_PROJECTION_REVISION,
      assetRevision: KIMI_K3_TEXT_ASSET_REVISION,
      limits: { supportedTools: 'declared' },
    });
    const prepared = await createLLMProvider(config).prepareInputMeter();
    expect(prepared.descriptor.assetRevision).toBe(KIMI_K3_TEXT_ASSET_REVISION);

    const assetBytes = fs.readFileSync(new URL(
      '../../../src/foundation/llm-provider/tokenizers/kimi-k3.tiktoken.json', import.meta.url,
    ));
    const assetSha256 = createHash('sha256').update(assetBytes).digest('hex');
    expect(provenance.conversion).toMatchObject({ assetSha256, assetBytes: assetBytes.length });
    expect(assetSha256).not.toBe(provenance.source.modelSha256);
    expect(KIMI_K3_TEXT_ASSET_REVISION).toBe([
      `${provenance.source.repository}:tiktoken.model:${provenance.source.modelSha256}`,
      `asset-sha256:${assetSha256}`,
      `conversion:${provenance.conversion.version}`,
    ].join(':'));

    const historicalDescriptor: InputMeterDescriptor = {
      ...meter.descriptor,
      assetRevision: `${provenance.source.repository}:tiktoken.model:${provenance.source.modelSha256}`,
    };
    const historical = createKimiK3TextMeter(historicalDescriptor, () => new Tiktoken(kimiK3Bpe));
    expect(historical.measure(input)).toEqual(first);
    expect(historicalDescriptor.assetRevision).toBe(
      `${provenance.source.repository}:tiktoken.model:${provenance.source.modelSha256}`,
    );
  });

  it('declares the bounded chunk approximation in runtime provenance', () => {
    expect(provenance.runtime.textChunking).toEqual(TEXT_CHUNKING);
  });

  it.each(CHUNK_BOUNDARY_CASES)('matches the independent real-BPE chunk sum for $name', fixture => {
    const points = Array.from(fixture.text);
    expect(points).toHaveLength(fixture.codePoints);
    const chunks: string[] = [];
    for (let start = 0; start < points.length; start += 25_000) {
      chunks.push(points.slice(start, start + 25_000).join(''));
    }
    expect(chunks.join('')).toBe(fixture.text);
    for (const chunk of chunks) {
      expect(/^[\uD800-\uDBFF]$/u.test(chunk.at(-1) ?? '')).toBe(false);
      expect(/^[\uDC00-\uDFFF]$/u.test(chunk.at(0) ?? '')).toBe(false);
    }

    const chunked = independentChunkSum(fixture.text);
    const whole = referenceText(fixture.text);
    expect(chunked).toBe(fixture.chunkedTokens);
    expect(whole).toBe(fixture.wholeTokens);
    if (fixture.codePoints <= 25_000) expect(chunked).toBe(whole);

    const input = { messages: [{ role: 'user' as const, content: fixture.text }] };
    const result = meter.measure(input);
    expect(result).toMatchObject({
      kind: 'estimated', method: 'kimi-k3-text',
      reason: 'context_trim_only:kimi_k3_text', tokens: chunked,
    });
    expect(meter.measure(input)).toEqual(result);
  });

  it('restarts chunk boundaries for each common-input message segment', () => {
    const first = 'a '.repeat(12_500);
    const second = 'x';
    const expected = independentChunkSum(first) + independentChunkSum(second);
    expect(expected).not.toBe(referenceText(first + second));
    const input = { messages: [
      { role: 'user' as const, content: first },
      { role: 'assistant' as const, content: second },
    ] };
    const result = meter.measure(input);
    expect(result).toMatchObject({ kind: 'estimated', tokens: expected });
    expect(meter.measure(input)).toEqual(result);
  });

  it('rejects a control token spanning an artificial chunk boundary', () => {
    const input = { messages: [{ role: 'user' as const, content: 'a '.repeat(12_499) + '<|open|>' + 'tail' }] };
    const result = meter.measure(input);
    expect(result).toEqual({
      kind: 'unavailable',
      reason: 'kimi_k3_text_estimate_unavailable:control_token_in_text:<|open|>',
    });
    expect(result).not.toHaveProperty('tokens');
  });

  it('evicts oversized bounded-cache entries and never splits Unicode code points', () => {
    const chunks: string[] = [];
    const fakeEncoder = {
      encode(text: string): number[] {
        if ((CONTROLS as readonly string[]).includes(text)) return [0];
        chunks.push(text);
        return { length: text.length } as number[];
      },
    };
    const cached = createKimiK3TextMeter(meter.descriptor, () => fakeEncoder);
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
    expect(artifact).toContain(provenance.source.modelSha256);
    expect(artifact).toContain(provenance.conversion.assetSha256);
    expect(artifact).toContain(provenance.conversion.version);
    expect(artifact).toContain('Script=Han');
    expect(artifact).toContain('<|end_of_msg|>');
  });
});
