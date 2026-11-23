import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { Tokenizer } from '@huggingface/tokenizers';
import tokenizerSpec from '../../../src/foundation/llm-provider/tokenizers/deepseek-v41.tokenizer.json' with { type: 'json' };
import { createDeepseekV41Meter } from '../../../src/foundation/llm-provider/deepseek-v41-meter.js';
import type {
  CompleteInput,
  InputMeasurement,
  InputMeterDescriptor,
  ModelInputMeter,
} from '../../../src/foundation/llm-provider/input-meter-types.js';

const controls = new Set(tokenizerSpec.added_tokens.map(token => token.content));
const controlList = [...controls];
type TokenizerInstance = InstanceType<typeof Tokenizer>;

function makeDescriptor(revision = 'phase2222-scan'): InputMeterDescriptor {
  return {
    revision,
    provider: 'deepseek',
    model: 'deepseek-flash[1m]',
    api: 'anthropic',
    contextWindow: 1_000_000,
    profile: 'phase2222-deepseek-scan',
  };
}

function makeFixture(encodeImplementation: (text: string) => { ids: number[] } = text => ({ ids: [text.length] })) {
  const encode = vi.fn(encodeImplementation);
  const factory = vi.fn(() => ({ encode }) as unknown as TokenizerInstance);
  const meter = createDeepseekV41Meter(makeDescriptor(), factory);
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

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

describe('DeepSeek successful text cache scan lifecycle', () => {
  it('uses only non-empty real added tokens as control conflicts', () => {
    expect(controlList).toHaveLength(tokenizerSpec.added_tokens.length);
    expect(controlList.every(token => token.length > 0)).toBe(true);
  });

  it('skips control scans and encoding for an exact warm hit', () => {
    const { encode, meter } = makeFixture();
    const text = 'ordinary cached context';
    const cold = measureTextWithScanCount(meter, text);
    const warm = measureTextWithScanCount(meter, ['ordinary', 'cached', 'context'].join(' '));

    expect(cold.measurement).toEqual(warm.measurement);
    expect(cold.measurement.kind).toBe('estimated');
    expect(cold.scans).toBe(controls.size);
    expect(warm.scans).toBe(0);
    expect(encode).toHaveBeenCalledTimes(1);
  });

  it('treats a cached zero token count as a hit', () => {
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

  it('shares warm hits across descriptors without sharing descriptor state', () => {
    const { encode, factory, meter } = makeFixture();
    const other = createDeepseekV41Meter(makeDescriptor('other-generation'), factory);
    const text = 'shared exact text';
    const cold = measureTextWithScanCount(meter, text);
    const warm = measureTextWithScanCount(other, text);

    expect(warm.measurement).toEqual(cold.measurement);
    expect(cold.scans).toBe(controls.size);
    expect(warm.scans).toBe(0);
    expect(encode).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(other.descriptor.revision).toBe('other-generation');
  });

  it('keeps conflict priority and rescans repeated failures without encoding', () => {
    const { encode, meter } = makeFixture();
    const [firstControl, secondControl] = controlList;
    expect(firstControl).toBeDefined();
    expect(secondControl).toBeDefined();
    const text = `${secondControl} appears before ${firstControl}`;
    const first = measureTextWithScanCount(meter, text);
    const second = measureTextWithScanCount(meter, text);

    const expected = {
      kind: 'unavailable',
      reason: `deepseek_v41_text_estimate_unavailable:control_token_in_text:${firstControl}`,
    };
    expect(first.measurement).toEqual(expected);
    expect(second.measurement).toEqual(expected);
    expect(first.scans).toBe(1);
    expect(second.scans).toBe(1);
    expect(encode).not.toHaveBeenCalled();
  });

  it('does not cache an encoding failure and reuses only the later success', () => {
    let fail = true;
    const { encode, meter } = makeFixture(text => {
      if (fail) {
        fail = false;
        throw new Error('injected encoding failure');
      }
      return { ids: [text.length] };
    });
    const text = 'encoding recovery text';
    const failed = measureTextWithScanCount(meter, text);
    const recovered = measureTextWithScanCount(meter, text);
    const warm = measureTextWithScanCount(meter, text);

    expect(failed.measurement).toEqual({
      kind: 'unavailable',
      reason: 'deepseek_v41_text_estimate_unavailable:encoding_failed:Error',
    });
    expect(recovered.measurement.kind).toBe('estimated');
    expect(warm.measurement).toEqual(recovered.measurement);
    expect(failed.scans).toBe(controls.size);
    expect(recovered.scans).toBe(controls.size);
    expect(warm.scans).toBe(0);
    expect(encode).toHaveBeenCalledTimes(2);
  });

  it('keeps asset initialization failure ahead of empty and invalid inputs', () => {
    const meter = createDeepseekV41Meter(makeDescriptor(), () => {
      throw new Error('asset unavailable');
    });
    const expected = {
      kind: 'unavailable',
      reason: 'deepseek_v41_text_estimate_unavailable:asset_initialization_failed',
    };

    expect(meter.measure({ messages: [] })).toEqual(expected);
    expect(meter.measure(textInput([{ type: 'unknown', value: 'x' }]))).toEqual(expected);
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
        reason: 'deepseek_v41_text_estimate_unavailable:non_text_content',
      });
    }
    expect(encode).toHaveBeenCalledTimes(1);
  });

  it('rescans and re-encodes an entry evicted by the byte bound', () => {
    const { encode, meter } = makeFixture();
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
    expect(encode).toHaveBeenCalledTimes(3);
  });

  it('rescans and re-encodes text above the cache byte capacity', () => {
    const { encode, meter } = makeFixture();
    const text = 'x'.repeat(16 * 1024 * 1024 + 1);
    const first = measureTextWithScanCount(meter, text);
    const second = measureTextWithScanCount(meter, text);

    expect(first.measurement.kind).toBe('estimated');
    expect(second.measurement).toEqual(first.measurement);
    expect(first.scans).toBe(controls.size);
    expect(second.scans).toBe(controls.size);
    expect(encode).toHaveBeenCalledTimes(2);
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
          utf16Units: text.length,
          utf8Bytes: Buffer.byteLength(text, 'utf8'),
          coldScans: coldOperations.scans,
          warmScans: warmOperations.scans,
          coldEncodeCalls: encodeAfterCold,
          warmEncodeCalls: operations.encode.mock.calls.length - encodeAfterCold,
          coldMs,
          warmSamplesMs,
          warmMedianMs: median(warmSamplesMs),
          measurementsEqual: coldMeasurement === warmMeasurement
            || JSON.stringify(coldMeasurement) === JSON.stringify(warmMeasurement),
          operationMeasurementsEqual: JSON.stringify(coldOperations.measurement)
            === JSON.stringify(warmOperations.measurement),
        });
      }
    } finally {
      console.log(JSON.stringify({
        scope: 'Real DeepSeek meter with fixed fake encoder; timing has no includes spy. Cold includes the initial successful scan and encode; warm samples reuse the exact-text cache.',
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
      expect(row.coldEncodeCalls, String(row.label)).toBe(1);
      expect(row.warmEncodeCalls, String(row.label)).toBe(0);
      expect(row.measurementsEqual, String(row.label)).toBe(true);
      expect(row.operationMeasurementsEqual, String(row.label)).toBe(true);
    }
    expect(rows).toHaveLength(corpusDefinitions.length);
  });
});
