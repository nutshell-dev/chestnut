import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { Tokenizer } from '@huggingface/tokenizers';
import qwenTokenizerSpec from '../../../src/foundation/llm-provider/tokenizers/qwen3.8.tokenizer.json' with { type: 'json' };
import { createQwenTextMeter } from '../../../src/foundation/llm-provider/qwen-text-meter.js';
import type {
  CompleteInput,
  InputMeasurement,
  InputMeterDescriptor,
  ModelInputMeter,
} from '../../../src/foundation/llm-provider/input-meter-types.js';

const controls = new Set(qwenTokenizerSpec.added_tokens.map(token => token.content));
const controlList = [...controls];
const MAX_CHUNK_CODE_POINTS = 25_000;
type TokenizerInstance = InstanceType<typeof Tokenizer>;
type EncodeOptions = { add_special_tokens: boolean };
type EncodeResult = { ids: number[] };
type EncodeImplementation = (text: string, options: EncodeOptions) => EncodeResult;

function makeDescriptor(revision = 'phase2224-scan'): InputMeterDescriptor {
  return {
    revision,
    provider: 'qwen',
    model: 'qwen3.8-max',
    api: 'openai',
    contextWindow: 1_000_000,
    profile: 'phase2224-qwen-scan',
  };
}

function bodyEncode(text: string): EncodeResult {
  return { ids: { length: text.length } as number[] };
}

function preinitialize(meter: ModelInputMeter): void {
  expect(meter.measure({ messages: [] })).toEqual({
    kind: 'estimated',
    method: 'qwen3.8-text',
    tokens: 0,
    reason: 'context_trim_only:qwen_text',
  });
}

function makeFixture(encodeImplementation: EncodeImplementation = bodyEncode) {
  const encode = vi.fn(encodeImplementation);
  const factory = vi.fn(() => ({ encode }) as unknown as TokenizerInstance);
  const meter = createQwenTextMeter(makeDescriptor(), factory);
  preinitialize(meter);
  encode.mockClear();
  return { encode, factory, meter };
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

function multiChunkFixture(): { text: string; chunks: string[] } {
  const first = `${'a'.repeat(MAX_CHUNK_CODE_POINTS - 1)}😀`;
  const second = 'b'.repeat(MAX_CHUNK_CODE_POINTS);
  const third = '😀';
  return { text: `${first}${second}${third}`, chunks: [first, second, third] };
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function sameMeasurement(left: InputMeasurement | undefined, right: InputMeasurement | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

describe('Qwen successful text cache scan lifecycle', () => {
  it('uses every non-empty real added token as a control conflict', () => {
    expect(controlList).toHaveLength(qwenTokenizerSpec.added_tokens.length);
    expect(controlList.length).toBeGreaterThan(0);
    expect(controlList.every(token => token.length > 0)).toBe(true);
  });

  it('skips control scans and body encoding for an exact warm hit', () => {
    const { encode, meter } = makeFixture();
    const text = 'ordinary cached context';
    const cold = measureTextWithScanCount(meter, text);
    const warm = measureTextWithScanCount(meter, ['ordinary', 'cached', 'context'].join(' '));

    expect(cold.measurement).toMatchObject({ kind: 'estimated', tokens: text.length });
    expect(warm.measurement).toEqual(cold.measurement);
    expect(cold.scans).toBe(controls.size);
    expect(warm.scans).toBe(0);
    expect(encode).toHaveBeenCalledTimes(1);
    expect(encode).toHaveBeenCalledWith(text, { add_special_tokens: false });
  });

  it('encodes every Unicode-safe chunk with parameters once and none when warm', () => {
    const { encode, meter } = makeFixture();
    const { text, chunks } = multiChunkFixture();
    const cold = measureTextWithScanCount(meter, text);
    const expectedCalls = chunks.map(chunk => [chunk, { add_special_tokens: false }]);

    expect(cold.measurement).toMatchObject({ kind: 'estimated', tokens: text.length });
    expect(cold.scans).toBe(controls.size);
    expect(encode.mock.calls).toEqual(expectedCalls);
    for (const chunk of chunks) {
      expect([...chunk].length).toBeLessThanOrEqual(MAX_CHUNK_CODE_POINTS);
      expect(/^[\uD800-\uDBFF]$/u.test(chunk.at(-1) ?? '')).toBe(false);
      expect(/^[\uDC00-\uDFFF]$/u.test(chunk.at(0) ?? '')).toBe(false);
    }

    const warm = measureTextWithScanCount(meter, chunks.join(''));
    expect(warm.measurement).toEqual(cold.measurement);
    expect(warm.scans).toBe(0);
    expect(encode.mock.calls).toEqual(expectedCalls);
  });

  it('treats a successful zero token count as a warm hit', () => {
    const { encode, meter } = makeFixture(() => ({ ids: [] }));
    const text = 'zero token fixture';
    const cold = measureTextWithScanCount(meter, text);
    const warm = measureTextWithScanCount(meter, text);

    expect(cold.measurement).toMatchObject({ kind: 'estimated', tokens: 0 });
    expect(warm.measurement).toEqual(cold.measurement);
    expect(cold.scans).toBe(controls.size);
    expect(warm.scans).toBe(0);
    expect(encode).toHaveBeenCalledTimes(1);
  });

  it('shares warm hits across descriptors with the same factory owner', () => {
    const { encode, factory, meter } = makeFixture();
    const other = createQwenTextMeter(makeDescriptor('other-generation'), factory);
    preinitialize(other);
    const text = 'shared exact text';
    const cold = measureTextWithScanCount(meter, text);
    const warm = measureTextWithScanCount(other, text);

    expect(warm.measurement).toEqual(cold.measurement);
    expect(cold.scans).toBe(controls.size);
    expect(warm.scans).toBe(0);
    expect(encode).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(meter.descriptor.revision).toBe('phase2224-scan');
    expect(other.descriptor.revision).toBe('other-generation');
  });

  it('does not reuse text counts across different factory owners', () => {
    const first = makeFixture();
    const second = makeFixture();
    const text = 'factory isolated text';
    const firstCold = measureTextWithScanCount(first.meter, text);
    const secondCold = measureTextWithScanCount(second.meter, text);

    expect(secondCold.measurement).toEqual(firstCold.measurement);
    expect(firstCold.scans).toBe(controls.size);
    expect(secondCold.scans).toBe(controls.size);
    expect(first.encode).toHaveBeenCalledTimes(1);
    expect(second.encode).toHaveBeenCalledTimes(1);
    expect(first.factory).toHaveBeenCalledTimes(1);
    expect(second.factory).toHaveBeenCalledTimes(1);
  });

  it('keeps control-list priority and rescans repeated conflicts without encoding', () => {
    const { encode, meter } = makeFixture();
    const [firstControl, secondControl] = controlList;
    expect(firstControl).toBeDefined();
    expect(secondControl).toBeDefined();
    const text = `${secondControl} appears before ${firstControl}`;
    const first = measureTextWithScanCount(meter, text);
    const second = measureTextWithScanCount(meter, text);
    const expected = {
      kind: 'unavailable',
      reason: `qwen_text_estimate_unavailable:control_token_in_text:${firstControl}`,
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
    const broken = createQwenTextMeter(makeDescriptor(), factory);
    const expected = {
      kind: 'unavailable',
      reason: 'qwen_text_estimate_unavailable:asset_initialization_failed',
    };
    const text = 'text cached by a working descriptor';
    expect(broken.measure(textInput(text))).toEqual(expected);

    failInitialization = false;
    const working = createQwenTextMeter(makeDescriptor('working-generation'), factory);
    preinitialize(working);
    encode.mockClear();
    const cold = measureTextWithScanCount(working, text);
    const brokenWarm = measureTextWithScanCount(broken, text);

    expect(cold.measurement.kind).toBe('estimated');
    expect(brokenWarm.measurement).toEqual(expected);
    expect(brokenWarm.scans).toBe(0);
    expect(broken.measure({ messages: [] })).toEqual(expected);
    expect(broken.measure(textInput([{ type: 'unknown', value: 'x' }]))).toEqual(expected);
    expect(encode).toHaveBeenCalledTimes(1);
  });

  it('restarts from the first chunk after a second-chunk encoding failure', () => {
    const { text, chunks } = multiChunkFixture();
    const [firstChunk, secondChunk, thirdChunk] = chunks;
    let failSecondChunk = true;
    const { encode, meter } = makeFixture(chunk => {
      if (failSecondChunk && chunk === secondChunk) {
        failSecondChunk = false;
        throw new Error('injected second chunk failure');
      }
      return bodyEncode(chunk);
    });

    const failed = measureTextWithScanCount(meter, text);
    const recovered = measureTextWithScanCount(meter, text);
    const callsAfterRecovery = encode.mock.calls.length;
    const warm = measureTextWithScanCount(meter, text);

    expect(failed.measurement).toEqual({
      kind: 'unavailable',
      reason: 'qwen_text_estimate_unavailable:encoding_failed:Error',
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
      thirdChunk,
    ]);
    expect(encode.mock.calls.length - callsAfterRecovery).toBe(0);
  });

  it('validates new image and unknown parts even when their text is cached', () => {
    const { encode, meter } = makeFixture();
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
        reason: 'qwen_text_estimate_unavailable:non_text_content',
      });
    }
    expect(encode).toHaveBeenCalledTimes(1);
  });

  it('rescans and re-encodes an entry evicted by two roughly 9MB texts', () => {
    const { encode, meter } = makeFixture();
    const first = 'a'.repeat(9_000_000);
    const second = 'b'.repeat(9_000_000);
    const chunksPerText = Math.ceil(first.length / MAX_CHUNK_CODE_POINTS);
    const cold = measureTextWithScanCount(meter, first);
    const callsAfterCold = encode.mock.calls.length;
    const eviction = measureTextWithScanCount(meter, second);
    const callsAfterEviction = encode.mock.calls.length;
    const afterEviction = measureTextWithScanCount(meter, first);

    expect(cold.measurement.kind).toBe('estimated');
    expect(eviction.measurement.kind).toBe('estimated');
    expect(afterEviction.measurement).toEqual(cold.measurement);
    expect(cold.scans).toBe(controls.size);
    expect(eviction.scans).toBe(controls.size);
    expect(afterEviction.scans).toBe(controls.size);
    expect(callsAfterCold).toBe(chunksPerText);
    expect(callsAfterEviction - callsAfterCold).toBe(chunksPerText);
    expect(encode.mock.calls.length - callsAfterEviction).toBe(chunksPerText);
  });

  it('rescans and re-encodes text above the 16MiB cache capacity', () => {
    const { encode, meter } = makeFixture();
    const text = 'x'.repeat(16 * 1024 * 1024 + 1);
    const chunksPerText = Math.ceil(text.length / MAX_CHUNK_CODE_POINTS);
    const first = measureTextWithScanCount(meter, text);
    const callsAfterFirst = encode.mock.calls.length;
    const second = measureTextWithScanCount(meter, text);

    expect(first.measurement.kind).toBe('estimated');
    expect(second.measurement).toEqual(first.measurement);
    expect(first.scans).toBe(controls.size);
    expect(second.scans).toBe(controls.size);
    expect(callsAfterFirst).toBe(chunksPerText);
    expect(encode.mock.calls.length - callsAfterFirst).toBe(chunksPerText);
  });

  it('records cold and warm scan cost for six corpora', () => {
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
        const expectedChunks = Math.ceil(text.length / MAX_CHUNK_CODE_POINTS);
        const operations = makeFixture();
        const coldOperations = measureTextWithScanCount(operations.meter, text);
        const encodeAfterCold = operations.encode.mock.calls.length;
        const warmOperations = measureTextWithScanCount(operations.meter, text);

        const timing = makeFixture();
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
          construction: 'unit.repeat(Math.ceil(utf16Units / unit.length)).slice(0, utf16Units)',
          utf16Units: text.length,
          utf8Bytes: Buffer.byteLength(text, 'utf8'),
          expectedChunks,
          coldScans: coldOperations.scans,
          warmScans: warmOperations.scans,
          coldEncodeCalls: encodeAfterCold,
          warmEncodeCalls: operations.encode.mock.calls.length - encodeAfterCold,
          coldMs,
          warmSamplesMs,
          warmMedianMs: median(warmSamplesMs),
          measurementsEqual: sameMeasurement(coldMeasurement, warmMeasurement),
          operationMeasurementsEqual: sameMeasurement(
            coldOperations.measurement,
            warmOperations.measurement,
          ),
        });
      }
    } finally {
      console.log(JSON.stringify({
        scope: 'Real Qwen meter with fake {ids} encoder; empty-input initialization is excluded. Operation counts and timings use independent factories, and timing has no includes spy. Cold includes one full scan and all body chunk encodes; warm reuses the exact-text cache. This whole-meter cost is not comparable with the Phase A isolated scan microbenchmark.',
        family: 'qwen',
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
      expect(row.coldEncodeCalls, String(row.label)).toBe(row.expectedChunks);
      expect(row.warmEncodeCalls, String(row.label)).toBe(0);
      expect(row.measurementsEqual, String(row.label)).toBe(true);
      expect(row.operationMeasurementsEqual, String(row.label)).toBe(true);
    }
    expect(rows).toHaveLength(corpusDefinitions.length);
  });
});
