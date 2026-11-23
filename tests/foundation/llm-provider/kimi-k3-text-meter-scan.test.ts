import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import provenance from '../../../src/foundation/llm-provider/tokenizers/kimi-k3.provenance.json' with { type: 'json' };
import {
  createKimiK3TextMeter,
  KIMI_K3_TEXT_PROFILE_ID,
} from '../../../src/foundation/llm-provider/kimi-k3-text-meter.js';
import type {
  CompleteInput,
  InputMeasurement,
  InputMeterDescriptor,
  ModelInputMeter,
} from '../../../src/foundation/llm-provider/input-meter-types.js';

const CONTROLS = ['<|open|>', '<|close|>', '<|sep|>', '<|end_of_msg|>'] as const;
const controls = new Set<string>(CONTROLS);
const controlList: string[] = [...CONTROLS];
const MAX_CHUNK_CODE_POINTS = 25_000;

type Encode = (
  text: string,
  allowed?: string[] | 'all',
  disallowed?: string[] | 'all',
) => number[];

function defaultBodyEncode(text: string): number[] {
  return { length: text.length } as number[];
}

function makeDescriptor(revision = 'phase2224-scan'): InputMeterDescriptor {
  return {
    revision,
    provider: 'moonshot',
    model: 'kimi-k3',
    api: 'openai',
    contextWindow: 1_000_000,
    profile: KIMI_K3_TEXT_PROFILE_ID,
  };
}

function createFixture(bodyImplementation: Encode = defaultBodyEncode) {
  const bodyEncode = vi.fn(bodyImplementation);
  const encode = vi.fn((
    text: string,
    allowed?: string[] | 'all',
    disallowed?: string[] | 'all',
  ): number[] => {
    if (controls.has(text) && Array.isArray(allowed) && allowed.length === 1
      && allowed[0] === text && Array.isArray(disallowed) && disallowed.length === 0) return [0];
    return bodyEncode(text, allowed, disallowed);
  });
  const factory = vi.fn(() => ({ encode }));
  const meter = createKimiK3TextMeter(makeDescriptor(), factory);
  return { bodyEncode, encode, factory, meter };
}

function makeFixture(bodyImplementation: Encode = defaultBodyEncode) {
  const fixture = createFixture(bodyImplementation);
  expect(fixture.meter.measure({ messages: [] })).toMatchObject({ kind: 'estimated', tokens: 0 });
  expect(fixture.encode.mock.calls).toEqual(CONTROLS.map(token => [token, [token], []]));
  fixture.encode.mockClear();
  fixture.bodyEncode.mockClear();
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

function chunkCount(text: string): number {
  return Math.ceil(Array.from(text).length / MAX_CHUNK_CODE_POINTS);
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function measurementTokens(measurement: InputMeasurement | undefined): number | undefined {
  return measurement?.kind === 'estimated' ? measurement.tokens : undefined;
}

describe('Kimi K3 successful text cache scan lifecycle', () => {
  it('uses the four pinned non-empty K3 control tokens', () => {
    expect(controlList).toHaveLength(4);
    expect(controlList.every(token => token.length > 0)).toBe(true);
    expect([...controlList].sort()).toEqual(Object.keys(provenance.controlTokens).sort());
  });

  it('skips control scans and body encoding for an exact warm hit', () => {
    const { bodyEncode, meter } = makeFixture();
    const text = 'ordinary cached context';
    const cold = measureTextWithScanCount(meter, text);
    const warm = measureTextWithScanCount(meter, ['ordinary', 'cached', 'context'].join(' '));

    expect(cold.measurement).toEqual(warm.measurement);
    expect(cold.measurement).toMatchObject({ kind: 'estimated', tokens: text.length });
    expect(cold.scans).toBe(controls.size);
    expect(warm.scans).toBe(0);
    expect(bodyEncode).toHaveBeenCalledTimes(1);
    expect(bodyEncode).toHaveBeenCalledWith(text, [], controlList);
  });

  it('encodes every Unicode-safe chunk with K3 arguments and none on a warm hit', () => {
    const { bodyEncode, meter } = makeFixture();
    const firstChunk = `${'a'.repeat(MAX_CHUNK_CODE_POINTS - 1)}😀`;
    const secondChunk = 'b'.repeat(MAX_CHUNK_CODE_POINTS);
    const thirdChunk = 'c';
    const text = `${firstChunk}${secondChunk}${thirdChunk}`;
    const cold = measureTextWithScanCount(meter, text);
    const warm = measureTextWithScanCount(meter, [firstChunk, secondChunk, thirdChunk].join(''));

    expect(cold.measurement).toEqual(warm.measurement);
    expect(cold.measurement).toMatchObject({ kind: 'estimated', tokens: text.length });
    expect(cold.scans).toBe(controls.size);
    expect(warm.scans).toBe(0);
    expect(bodyEncode.mock.calls).toEqual([
      [firstChunk, [], controlList],
      [secondChunk, [], controlList],
      [thirdChunk, [], controlList],
    ]);
    expect([...firstChunk]).toHaveLength(MAX_CHUNK_CODE_POINTS);
    expect([...secondChunk]).toHaveLength(MAX_CHUNK_CODE_POINTS);
    expect(bodyEncode).toHaveBeenCalledTimes(3);
  });

  it('treats a successful zero token count as a warm hit', () => {
    const { bodyEncode, meter } = makeFixture(() => []);
    const text = 'zero token fixture';
    const cold = measureTextWithScanCount(meter, text);
    const warm = measureTextWithScanCount(meter, text);

    expect(cold.measurement).toMatchObject({ kind: 'estimated', tokens: 0 });
    expect(warm.measurement).toEqual(cold.measurement);
    expect(cold.scans).toBe(controls.size);
    expect(warm.scans).toBe(0);
    expect(bodyEncode).toHaveBeenCalledTimes(1);
  });

  it('shares warm hits across descriptors but isolates different factories', () => {
    const { bodyEncode, factory, meter } = makeFixture();
    const other = createKimiK3TextMeter(makeDescriptor('other-generation'), factory);
    const isolated = makeFixture();
    const text = 'shared exact text';
    const cold = measureTextWithScanCount(meter, text);
    const warm = measureTextWithScanCount(other, text);
    const isolatedCold = measureTextWithScanCount(isolated.meter, text);

    expect(warm.measurement).toEqual(cold.measurement);
    expect(isolatedCold.measurement).toEqual(cold.measurement);
    expect(cold.scans).toBe(controls.size);
    expect(warm.scans).toBe(0);
    expect(isolatedCold.scans).toBe(controls.size);
    expect(bodyEncode).toHaveBeenCalledTimes(1);
    expect(isolated.bodyEncode).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(isolated.factory).toHaveBeenCalledTimes(1);
    expect(other.descriptor.revision).toBe('other-generation');
    expect(meter.descriptor.revision).toBe('phase2224-scan');
  });

  it('keeps control-list conflict priority and never caches repeated conflicts', () => {
    const { bodyEncode, encode, meter } = makeFixture();
    const [firstControl, secondControl] = CONTROLS;
    const text = `${secondControl} appears before ${firstControl}`;
    const first = measureTextWithScanCount(meter, text);
    const second = measureTextWithScanCount(meter, text);

    const expected = {
      kind: 'unavailable',
      reason: `kimi_k3_text_estimate_unavailable:control_token_in_text:${firstControl}`,
    };
    expect(first.measurement).toEqual(expected);
    expect(second.measurement).toEqual(expected);
    expect(first.scans).toBe(1);
    expect(second.scans).toBe(1);
    expect(bodyEncode).not.toHaveBeenCalled();
    expect(encode).not.toHaveBeenCalled();
  });

  it('keeps asset initialization failure ahead of empty and invalid inputs', () => {
    const factory = vi.fn(() => {
      throw new Error('asset unavailable');
    });
    const meter = createKimiK3TextMeter(makeDescriptor(), factory);
    const expected = {
      kind: 'unavailable',
      reason: 'kimi_k3_text_estimate_unavailable:asset_initialization_failed',
    };

    expect(meter.measure({ messages: [] })).toEqual(expected);
    expect(meter.measure(textInput([{ type: 'unknown', value: 'x' }]))).toEqual(expected);
    expect(meter.measure(textInput(CONTROLS[1]))).toEqual(expected);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('does not hide retained initialization validation failure behind a shared warm entry', () => {
    let validControls = false;
    const bodyEncode = vi.fn(defaultBodyEncode);
    const encode = vi.fn((
      text: string,
      allowed?: string[] | 'all',
      disallowed?: string[] | 'all',
    ): number[] => {
      if (controls.has(text) && Array.isArray(allowed) && allowed.length === 1
        && allowed[0] === text && Array.isArray(disallowed) && disallowed.length === 0) {
        return validControls ? [0] : [];
      }
      return bodyEncode(text, allowed, disallowed);
    });
    const factory = vi.fn(() => ({ encode }));
    const broken = createKimiK3TextMeter(makeDescriptor('broken-initialization'), factory);
    const text = 'cached after another view initializes';
    const expected = {
      kind: 'unavailable',
      reason: 'kimi_k3_text_estimate_unavailable:asset_initialization_failed',
    };
    expect(broken.measure(textInput(text))).toEqual(expected);

    validControls = true;
    const working = createKimiK3TextMeter(makeDescriptor('working-initialization'), factory);
    const cold = measureTextWithScanCount(working, text);
    const brokenWarm = measureTextWithScanCount(broken, text);

    expect(cold.measurement.kind).toBe('estimated');
    expect(cold.scans).toBe(controls.size);
    expect(brokenWarm.measurement).toEqual(expected);
    expect(brokenWarm.scans).toBe(0);
    expect(bodyEncode).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('restarts at the first chunk after a second-chunk failure and caches only recovery', () => {
    const firstChunk = 'a'.repeat(MAX_CHUNK_CODE_POINTS);
    const secondChunk = 'b'.repeat(MAX_CHUNK_CODE_POINTS);
    const thirdChunk = 'c';
    let failSecondChunk = true;
    const { bodyEncode, meter } = makeFixture(text => {
      if (text === secondChunk && failSecondChunk) {
        failSecondChunk = false;
        throw new Error('injected second chunk failure');
      }
      return defaultBodyEncode(text);
    });
    const text = `${firstChunk}${secondChunk}${thirdChunk}`;
    const failed = measureTextWithScanCount(meter, text);
    const recovered = measureTextWithScanCount(meter, text);
    const warm = measureTextWithScanCount(meter, text);

    expect(failed.measurement).toEqual({
      kind: 'unavailable',
      reason: 'kimi_k3_text_estimate_unavailable:encoding_failed:Error',
    });
    expect(recovered.measurement).toMatchObject({ kind: 'estimated', tokens: text.length });
    expect(warm.measurement).toEqual(recovered.measurement);
    expect(failed.scans).toBe(controls.size);
    expect(recovered.scans).toBe(controls.size);
    expect(warm.scans).toBe(0);
    expect(bodyEncode.mock.calls).toEqual([
      [firstChunk, [], controlList],
      [secondChunk, [], controlList],
      [firstChunk, [], controlList],
      [secondChunk, [], controlList],
      [thirdChunk, [], controlList],
    ]);
  });

  it('validates new image and unknown parts even when their text is cached', () => {
    const { bodyEncode, meter } = makeFixture();
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
        reason: 'kimi_k3_text_estimate_unavailable:non_text_content',
      });
    }
    expect(bodyEncode).toHaveBeenCalledTimes(1);
  });

  it('rescans and re-encodes an entry evicted by two roughly 9MB texts', () => {
    const { bodyEncode, meter } = makeFixture();
    const first = 'a'.repeat(9_000_000);
    const second = 'b'.repeat(9_000_000);
    const cold = measureTextWithScanCount(meter, first);
    const eviction = measureTextWithScanCount(meter, second);
    const afterEviction = measureTextWithScanCount(meter, first);

    expect(cold.measurement.kind).toBe('estimated');
    expect(eviction.measurement.kind).toBe('estimated');
    expect(afterEviction.measurement).toEqual(cold.measurement);
    expect(cold.scans).toBe(controls.size);
    expect(eviction.scans).toBe(controls.size);
    expect(afterEviction.scans).toBe(controls.size);
    expect(bodyEncode).toHaveBeenCalledTimes(chunkCount(first) * 3);
  });

  it('rescans and re-encodes every call above the 16MiB cache capacity', () => {
    const { bodyEncode, meter } = makeFixture();
    const text = 'x'.repeat(16 * 1024 * 1024 + 1);
    const first = measureTextWithScanCount(meter, text);
    const second = measureTextWithScanCount(meter, text);

    expect(first.measurement.kind).toBe('estimated');
    expect(second.measurement).toEqual(first.measurement);
    expect(first.scans).toBe(controls.size);
    expect(second.scans).toBe(controls.size);
    expect(bodyEncode).toHaveBeenCalledTimes(chunkCount(text) * 2);
  });

  it('records cold and warm scan cost for six corpus shapes', () => {
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
        const operations = makeFixture();
        const coldOperations = measureTextWithScanCount(operations.meter, text);
        const encodeAfterCold = operations.bodyEncode.mock.calls.length;
        const warmOperations = measureTextWithScanCount(operations.meter, text);
        const chunks = chunkCount(text);

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
          utf16Units: text.length,
          utf8Bytes: Buffer.byteLength(text, 'utf8'),
          chunkCount: chunks,
          coldScans: coldOperations.scans,
          warmScans: warmOperations.scans,
          coldEncodeCalls: encodeAfterCold,
          warmEncodeCalls: operations.bodyEncode.mock.calls.length - encodeAfterCold,
          coldTokens: measurementTokens(coldMeasurement),
          warmTokens: measurementTokens(warmMeasurement),
          coldMs,
          warmSamplesMs,
          warmTotalMs: warmSamplesMs.reduce((sum, sample) => sum + sample, 0),
          warmMedianMs: median(warmSamplesMs),
          measurementsEqual: JSON.stringify(coldMeasurement) === JSON.stringify(warmMeasurement),
          operationMeasurementsEqual: JSON.stringify(coldOperations.measurement)
            === JSON.stringify(warmOperations.measurement),
        });
      }
    } finally {
      console.log(JSON.stringify({
        scope: 'Real Kimi K3 meter with length-only fake body encoder and four valid initialization controls. Operation and timing factories are independent; timing has no includes spy. Cold follows explicit empty-input initialization and includes scan plus all chunk encodes; warm reuses exact-text cache. This whole-meter sample is not comparable with Phase 2224 Step A pure find/includes microbenchmarks.',
        family: 'kimi-k3',
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpu: os.cpus()[0]?.model ?? 'unknown',
        controlTokens: controls.size,
        construction: 'unit.repeat(Math.ceil(targetUtf16Units / unit.length)).slice(0, targetUtf16Units)',
        rows,
      }));
    }

    for (const row of rows) {
      expect(row.coldScans, String(row.label)).toBe(controls.size);
      expect(row.warmScans, String(row.label)).toBe(0);
      expect(row.coldEncodeCalls, String(row.label)).toBe(row.chunkCount);
      expect(row.warmEncodeCalls, String(row.label)).toBe(0);
      expect(row.coldTokens, String(row.label)).toBe(row.warmTokens);
      expect(row.measurementsEqual, String(row.label)).toBe(true);
      expect(row.operationMeasurementsEqual, String(row.label)).toBe(true);
    }
    expect(rows).toHaveLength(corpusDefinitions.length);
  });
});
