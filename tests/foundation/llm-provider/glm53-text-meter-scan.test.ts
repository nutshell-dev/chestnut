import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { Tokenizer } from '@huggingface/tokenizers';
import glmTokenizerSpec from '../../../src/foundation/llm-provider/tokenizers/glm53.tokenizer.json' with { type: 'json' };
import { createGlm53TextMeter } from '../../../src/foundation/llm-provider/glm53-text-meter.js';
import type {
  CompleteInput,
  InputMeasurement,
  InputMeterDescriptor,
  ModelInputMeter,
} from '../../../src/foundation/llm-provider/input-meter-types.js';

const controls = new Set(glmTokenizerSpec.added_tokens.map(token => token.content));
const controlList = [...controls];
type TokenizerInstance = InstanceType<typeof Tokenizer>;

function makeDescriptor(revision = 'phase2224-scan'): InputMeterDescriptor {
  return {
    revision,
    provider: 'zai',
    model: 'glm-5.3',
    api: 'anthropic',
    contextWindow: 1_000_000,
    profile: 'phase2224-glm53-scan',
  };
}

function bodyEncode(text: string): { ids: number[] } {
  return { ids: { length: text.length } as number[] };
}

function makeFixture(encodeImplementation: (text: string) => { ids: number[] } = bodyEncode) {
  const encode = vi.fn(encodeImplementation);
  const factory = vi.fn(() => ({ encode }) as unknown as TokenizerInstance);
  const meter = createGlm53TextMeter(makeDescriptor(), factory);
  return { encode, factory, meter };
}

function makeInitializedFixture(encodeImplementation: (text: string) => { ids: number[] } = bodyEncode) {
  const fixture = makeFixture(encodeImplementation);
  expect(fixture.meter.measure({ messages: [] })).toMatchObject({ kind: 'estimated', tokens: 0 });
  fixture.encode.mockClear();
  return fixture;
}

function textInput(content: unknown): CompleteInput {
  return { messages: [{ role: 'user', content }] };
}

function measureWithScanCount(
  meter: ModelInputMeter,
  input: CompleteInput,
  targetText: string,
): { measurement: InputMeasurement; scans: number } {
  const nativeIncludes = String.prototype.includes;
  let scans = 0;
  let measurement: InputMeasurement;
  const spy = vi.spyOn(String.prototype, 'includes').mockImplementation(
    function (this: string, search: string, position?: number): boolean {
      if (this === targetText && controls.has(search)) scans += 1;
      return nativeIncludes.call(this, search, position);
    },
  );
  try {
    measurement = meter.measure(input);
  } finally {
    spy.mockRestore();
  }
  return { measurement, scans };
}

function measureTextWithScanCount(meter: ModelInputMeter, text: string) {
  return measureWithScanCount(meter, textInput(text), text);
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

describe('GLM successful text cache scan lifecycle', () => {
  it('uses only non-empty real added tokens as control conflicts', () => {
    expect(controlList).toHaveLength(glmTokenizerSpec.added_tokens.length);
    expect(controlList.length).toBeGreaterThan(0);
    expect(controlList.every(token => token.length > 0)).toBe(true);
  });

  it('skips control scans and encoding for an exact warm hit', () => {
    const { encode, meter } = makeInitializedFixture();
    const text = 'ordinary cached context';
    const cold = measureTextWithScanCount(meter, text);
    const warm = measureTextWithScanCount(meter, ['ordinary', 'cached', 'context'].join(' '));

    expect(cold.measurement).toEqual(warm.measurement);
    expect(cold.measurement.kind).toBe('estimated');
    expect(cold.scans).toBe(controls.size);
    expect(warm.scans).toBe(0);
    expect(encode).toHaveBeenCalledTimes(1);
    expect(encode).toHaveBeenCalledWith(text, { add_special_tokens: false });
  });

  it('scans once but encodes every bounded chunk including non-BMP boundaries', () => {
    const { encode, meter } = makeInitializedFixture();
    const expectedChunks = [
      `${'a'.repeat(24_999)}😀`,
      '中'.repeat(25_000),
      '😀tail',
    ];
    const text = expectedChunks.join('');
    const cold = measureTextWithScanCount(meter, text);
    const warm = measureTextWithScanCount(meter, text);

    expect(cold.measurement).toMatchObject({ kind: 'estimated', tokens: text.length });
    expect(warm.measurement).toEqual(cold.measurement);
    expect(cold.scans).toBe(controls.size);
    expect(warm.scans).toBe(0);
    expect(encode).toHaveBeenCalledTimes(expectedChunks.length);
    expectedChunks.forEach((chunk, index) => {
      expect([...chunk].length).toBeLessThanOrEqual(25_000);
      expect(/^[\uD800-\uDBFF]$/u.test(chunk.at(-1) ?? '')).toBe(false);
      expect(/^[\uDC00-\uDFFF]$/u.test(chunk.at(0) ?? '')).toBe(false);
      expect(encode).toHaveBeenNthCalledWith(index + 1, chunk, { add_special_tokens: false });
    });
  });

  it('treats a cached zero token count from every chunk as a hit', () => {
    const { encode, meter } = makeInitializedFixture(() => ({ ids: [] }));
    const text = '0'.repeat(25_001);
    const cold = measureTextWithScanCount(meter, text);
    const warm = measureTextWithScanCount(meter, text);

    expect(cold.measurement).toMatchObject({ kind: 'estimated', tokens: 0 });
    expect(warm.measurement).toEqual(cold.measurement);
    expect(cold.scans).toBe(controls.size);
    expect(warm.scans).toBe(0);
    expect(encode).toHaveBeenCalledTimes(2);
  });

  it('shares warm hits across descriptors without sharing descriptor state', () => {
    const { encode, factory, meter } = makeInitializedFixture();
    const other = createGlm53TextMeter(makeDescriptor('other-generation'), factory);
    const text = 'shared exact text';
    const cold = measureTextWithScanCount(meter, text);
    const warm = measureTextWithScanCount(other, text);

    expect(warm.measurement).toEqual(cold.measurement);
    expect(cold.scans).toBe(controls.size);
    expect(warm.scans).toBe(0);
    expect(encode).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(other.descriptor.revision).toBe('other-generation');
    expect(meter.descriptor.revision).toBe('phase2224-scan');
  });

  it('does not share cached text between different encoder factories', () => {
    const first = makeInitializedFixture();
    const second = makeInitializedFixture();
    const text = 'factory-local cached text';
    const cold = measureTextWithScanCount(first.meter, text);
    const isolated = measureTextWithScanCount(second.meter, text);

    expect(isolated.measurement).toEqual(cold.measurement);
    expect(cold.scans).toBe(controls.size);
    expect(isolated.scans).toBe(controls.size);
    expect(first.encode).toHaveBeenCalledTimes(1);
    expect(second.encode).toHaveBeenCalledTimes(1);
  });

  it('keeps conflict priority and rescans repeated failures without encoding', () => {
    const { encode, meter } = makeInitializedFixture();
    const [firstControl, secondControl] = controlList;
    expect(firstControl).toBeDefined();
    expect(secondControl).toBeDefined();
    const text = `${secondControl} appears before ${firstControl}`;
    const first = measureTextWithScanCount(meter, text);
    const second = measureTextWithScanCount(meter, text);

    const expected = {
      kind: 'unavailable',
      reason: `glm53_text_estimate_unavailable:control_token_in_text:${firstControl}`,
    };
    expect(first.measurement).toEqual(expected);
    expect(second.measurement).toEqual(expected);
    expect(first.scans).toBe(1);
    expect(second.scans).toBe(1);
    expect(encode).not.toHaveBeenCalled();
  });

  it('keeps initialization failure ahead of cached, empty, and invalid inputs', () => {
    const encode = vi.fn(bodyEncode);
    let failInitialization = true;
    const factory = vi.fn(() => {
      if (failInitialization) throw new Error('asset unavailable');
      return { encode } as unknown as TokenizerInstance;
    });
    const broken = createGlm53TextMeter(makeDescriptor(), factory);
    const expected = {
      kind: 'unavailable',
      reason: 'glm53_text_estimate_unavailable:asset_initialization_failed',
    };
    const text = 'text cached by a working descriptor';
    expect(broken.measure(textInput(text))).toEqual(expected);

    failInitialization = false;
    const working = createGlm53TextMeter(makeDescriptor('working-generation'), factory);
    expect(working.measure({ messages: [] })).toMatchObject({ kind: 'estimated', tokens: 0 });
    encode.mockClear();
    expect(working.measure(textInput(text)).kind).toBe('estimated');

    expect(broken.measure({ messages: [] })).toEqual(expected);
    expect(broken.measure(textInput([{ type: 'unknown', value: 'x' }]))).toEqual(expected);
    expect(broken.measure(textInput(text))).toEqual(expected);
    expect(encode).toHaveBeenCalledTimes(1);
  });

  it('restarts from the first chunk after a second-chunk encoding failure', () => {
    const firstChunk = 'a'.repeat(25_000);
    const secondChunk = 'b'.repeat(100);
    let failSecondChunk = true;
    const { encode, meter } = makeInitializedFixture(text => {
      if (text === secondChunk && failSecondChunk) {
        failSecondChunk = false;
        throw new Error('injected second-chunk failure');
      }
      return bodyEncode(text);
    });
    const text = `${firstChunk}${secondChunk}`;
    const failed = measureTextWithScanCount(meter, text);
    const recovered = measureTextWithScanCount(meter, text);
    const warm = measureTextWithScanCount(meter, text);

    expect(failed.measurement).toEqual({
      kind: 'unavailable',
      reason: 'glm53_text_estimate_unavailable:encoding_failed:Error',
    });
    expect(recovered.measurement).toMatchObject({ kind: 'estimated', tokens: text.length });
    expect(warm.measurement).toEqual(recovered.measurement);
    expect(failed.scans).toBe(controls.size);
    expect(recovered.scans).toBe(controls.size);
    expect(warm.scans).toBe(0);
    expect(encode.mock.calls.map(([chunk]) => chunk)).toEqual([
      firstChunk,
      secondChunk,
      firstChunk,
      secondChunk,
    ]);
  });

  it('validates new image and unknown parts even when their text is cached', () => {
    const { encode, meter } = makeInitializedFixture();
    const text = 'cached safe text';
    expect(meter.measure(textInput(text)).kind).toBe('estimated');
    const invalidInputs = [
      textInput([
        { type: 'text', text },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
      ]),
      textInput([{ type: 'text', text }, { type: 'unknown', text }]),
    ];

    for (const input of invalidInputs) {
      expect(meter.measure(input)).toEqual({
        kind: 'unavailable',
        reason: 'glm53_text_estimate_unavailable:non_text_content',
      });
    }
    expect(encode).toHaveBeenCalledTimes(1);
  });

  it('rescans and re-encodes an entry evicted by the byte bound', () => {
    const { encode, meter } = makeInitializedFixture();
    const first = 'a'.repeat(9_000_000);
    const second = 'b'.repeat(9_000_000);
    const cold = measureTextWithScanCount(meter, first);
    const coldEncodeCalls = encode.mock.calls.length;
    const eviction = measureTextWithScanCount(meter, second);
    const evictionEncodeCalls = encode.mock.calls.length - coldEncodeCalls;
    const afterEviction = measureTextWithScanCount(meter, first);
    const reencodeCalls = encode.mock.calls.length - coldEncodeCalls - evictionEncodeCalls;

    expect(cold.measurement.kind).toBe('estimated');
    expect(eviction.measurement.kind).toBe('estimated');
    expect(afterEviction.measurement).toEqual(cold.measurement);
    expect(cold.scans).toBe(controls.size);
    expect(eviction.scans).toBe(controls.size);
    expect(afterEviction.scans).toBe(controls.size);
    expect(coldEncodeCalls).toBeGreaterThan(1);
    expect(evictionEncodeCalls).toBe(coldEncodeCalls);
    expect(reencodeCalls).toBe(coldEncodeCalls);
  });

  it('rescans and re-encodes text above the cache byte capacity', () => {
    const { encode, meter } = makeInitializedFixture();
    const text = 'x'.repeat(16 * 1024 * 1024 + 1);
    const first = measureTextWithScanCount(meter, text);
    const firstEncodeCalls = encode.mock.calls.length;
    const second = measureTextWithScanCount(meter, text);
    const secondEncodeCalls = encode.mock.calls.length - firstEncodeCalls;

    expect(first.measurement.kind).toBe('estimated');
    expect(second.measurement).toEqual(first.measurement);
    expect(first.scans).toBe(controls.size);
    expect(second.scans).toBe(controls.size);
    expect(firstEncodeCalls).toBeGreaterThan(1);
    expect(secondEncodeCalls).toBe(firstEncodeCalls);
  });

  it('records cold and warm scan cost', () => {
    const corpusDefinitions = [
      ['ascii-small', 'ordinary context ', 4_096],
      ['ascii-long', 'ordinary context ', 1_048_576],
      ['cjk-small', '普通上下文数据', 4_096],
      ['cjk-long', '普通上下文数据', 1_048_576],
      ['angle-small', '<ordinary> context ', 4_096],
      ['angle-long', '<ordinary> context ', 1_048_576],
    ] as const;
    const rows: Array<Record<string, unknown>> = [];
    try {
      for (const [label, unit, utf16Units] of corpusDefinitions) {
        const text = unit.repeat(Math.ceil(utf16Units / unit.length)).slice(0, utf16Units);
        const operations = makeInitializedFixture();
        const coldOperations = measureTextWithScanCount(operations.meter, text);
        const encodeAfterCold = operations.encode.mock.calls.length;
        const warmOperations = measureTextWithScanCount(operations.meter, text);

        const timing = makeInitializedFixture();
        const coldStart = performance.now();
        const coldMeasurement = timing.meter.measure(textInput(text));
        const coldMs = performance.now() - coldStart;
        timing.meter.measure(textInput(text));
        timing.meter.measure(textInput(text));
        const warmSamplesMs: number[] = [];
        let warmMeasurement: InputMeasurement | undefined;
        for (let sample = 0; sample < 7; sample += 1) {
          const start = performance.now();
          warmMeasurement = timing.meter.measure(textInput(text));
          warmSamplesMs.push(performance.now() - start);
        }
        rows.push({
          label,
          construction: `repeat ${JSON.stringify(unit)} and slice to ${utf16Units} UTF-16 code units`,
          utf16Units: text.length,
          utf8Bytes: Buffer.byteLength(text, 'utf8'),
          coldScans: coldOperations.scans,
          warmScans: warmOperations.scans,
          coldChunks: encodeAfterCold,
          coldEncodeCalls: encodeAfterCold,
          warmEncodeCalls: operations.encode.mock.calls.length - encodeAfterCold,
          coldMs,
          warmSamplesMs,
          warmMedianMs: median(warmSamplesMs),
          timingMeasurementsEqual: JSON.stringify(coldMeasurement) === JSON.stringify(warmMeasurement),
          operationMeasurementsEqual: JSON.stringify(coldOperations.measurement)
            === JSON.stringify(warmOperations.measurement),
          crossFixtureMeasurementsEqual: JSON.stringify(coldOperations.measurement)
            === JSON.stringify(coldMeasurement),
        });
      }
    } finally {
      console.log(JSON.stringify({
        scope: 'Real GLM meter with fixed fake encoder, pre-initialized on empty input. Operations and timing use independent factories; timing has no includes spy. Cold includes the first full scan and encode, while warm samples reuse the exact-text cache. This is not the Phase 2224 Step A pure find/includes microbenchmark.',
        family: 'glm53',
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpu: os.cpus()[0]?.model ?? 'unknown',
        addedTokens: controls.size,
        rows,
      }));
    }

    for (const row of rows) {
      expect(row.coldScans, String(row.label)).toBe(controls.size);
      expect(row.warmScans, String(row.label)).toBe(0);
      expect(row.coldEncodeCalls, String(row.label)).toBe(Math.ceil(Number(row.utf16Units) / 25_000));
      expect(row.coldChunks, String(row.label)).toBe(row.coldEncodeCalls);
      expect(row.warmEncodeCalls, String(row.label)).toBe(0);
      expect(row.timingMeasurementsEqual, String(row.label)).toBe(true);
      expect(row.operationMeasurementsEqual, String(row.label)).toBe(true);
      expect(row.crossFixtureMeasurementsEqual, String(row.label)).toBe(true);
    }
    expect(rows).toHaveLength(corpusDefinitions.length);
  });
});
