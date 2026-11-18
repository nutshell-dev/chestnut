import fs from 'node:fs';
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

function referenceMessage(role: 'system' | 'user' | 'assistant', content: string): number {
  return 1 // open
    + referenceText('message')
    + referenceText(' role') + referenceText('="') + referenceText(role) + referenceText('"')
    + 1 // sep
    + referenceText(content)
    + 1 // close
    + referenceText('message')
    + 1 // sep
    + 1; // end_of_msg
}

function estimatedTokens(input: CompleteInput): number {
  const result = meter.measure(input);
  expect(result).toMatchObject({
    kind: 'estimated', method: 'kimi-k3-text', reason: 'context_trim_only:kimi_k3_text_projection',
  });
  return result.kind === 'estimated' ? result.tokens : -1;
}

describe('Kimi K3 local text meter', () => {
  it.each(['hello world', '中文与 English', '😀👨\u200d👩\u200d👧\u200d👦', 'line 1\nline 2', ''])(
    'estimates stable mixed text %j with segmented control tokens',
    content => {
      const input = { messages: [{ role: 'user' as const, content }] };
      expect(estimatedTokens(input)).toBe(referenceMessage('user', content));
      expect(estimatedTokens(input)).toBe(referenceMessage('user', content));
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

  it('preserves system/user/assistant order and additive message boundaries', () => {
    const combined = {
      system: 'rules', messages: [
        { role: 'user' as const, content: 'question' },
        { role: 'assistant' as const, content: 'answer' },
      ],
    };
    expect(estimatedTokens(combined)).toBe(
      referenceMessage('system', 'rules')
      + referenceMessage('user', 'question')
      + referenceMessage('assistant', 'answer'),
    );
    expect(estimatedTokens({ messages: [] })).toBe(0);
  });

  it.each([
    ['tools', { messages: [{ role: 'user', content: 'hello' }], tools: [{ name: 'x', description: '', input_schema: {} }] }],
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
      limits: { supportedTools: 'none' },
    });
    expect(provenance.source.modelSha256).toBe(KIMI_K3_TEXT_ASSET_REVISION.split(':').at(-1));
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
    expect(artifact).toContain(KIMI_K3_TEXT_ASSET_REVISION);
    expect(artifact).toContain('Script=Han');
    expect(artifact).toContain('<|end_of_msg|>');
  });
});
