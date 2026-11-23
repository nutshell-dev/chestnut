import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  llmProviderCall,
  llmProviderCredentialRuntime,
  llmProviderModelMeasurement,
} from '../../../src/foundation/llm-provider/index.js';
import { createLLMProvider } from '../../../src/foundation/llm-provider/provider-factory.js';
import type { InputMeasurement } from '../../../src/foundation/llm-provider/input-meter-types.js';

const { loadPiAiRuntime } = llmProviderCredentialRuntime;
type InputMeasurementObservation = llmProviderModelMeasurement.InputMeasurementObservation;
type InputMeasurementUsage = llmProviderModelMeasurement.InputMeasurementUsage;
type LLMResponse = llmProviderCall.LLMResponse;
type ProviderStreamChunk = llmProviderCall.ProviderStreamChunk;
type ProviderUsage = llmProviderCall.ProviderUsage;

const INPUT_MEASUREMENT_TIMEOUT_MS = 5_000;
type Mode = 'call' | 'stream';
type ApiFormat = 'openai' | 'anthropic';

interface ReconciliationCase {
  name: string;
  apiFormat: ApiFormat;
  measurement: InputMeasurement;
  supplierInput: number;
  effectiveInputTokens?: number;
  deltaTokens?: number;
  reconciliation: 'matched' | 'mismatch' | 'no_usage' | 'unavailable';
  usage: InputMeasurementUsage;
  publicUsage: ProviderUsage;
  invalidTerminalUsage?: boolean;
  reason?: string;
}

function estimated(tokens: number): InputMeasurement {
  return {
    kind: 'estimated',
    method: 'legacy-cl100k',
    reason: 'test-fixed-estimate',
    tokens,
  };
}

function openAiUsage(input: number): InputMeasurementUsage {
  return {
    unCachedInputTokens: input,
    outputTokens: 1,
    cacheWriteInputTokens: 0,
    cacheReadInputTokens: 0,
    totalTokens: input + 1,
    reasoningTokens: 0,
  };
}

function openAiPublicUsage(input: number): ProviderUsage {
  return {
    inputTokens: input,
    outputTokens: 1,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    totalTokens: input + 1,
    details: { reasoningTokens: 0 },
  };
}

function openAiCase(
  name: string,
  localTokens: number,
  supplierInput: number,
  reconciliation: 'matched' | 'mismatch',
  deltaTokens: number,
): ReconciliationCase {
  return {
    name,
    apiFormat: 'openai',
    measurement: estimated(localTokens),
    supplierInput,
    effectiveInputTokens: supplierInput,
    deltaTokens,
    reconciliation,
    usage: openAiUsage(supplierInput),
    publicUsage: openAiPublicUsage(supplierInput),
  };
}

const invalidPublicUsage = openAiPublicUsage(3);
delete invalidPublicUsage.inputTokens;

const cases: ReconciliationCase[] = [
  openAiCase('negative delta', 37, 3, 'mismatch', -34),
  openAiCase('positive delta', 2, 3, 'mismatch', 1),
  openAiCase('equal measurements', 3, 3, 'matched', 0),
  openAiCase('explicit supplier zero', 37, 0, 'mismatch', -37),
  openAiCase('local and supplier zero', 0, 0, 'matched', 0),
  {
    name: 'Anthropic cached input',
    apiFormat: 'anthropic',
    measurement: estimated(37),
    supplierInput: 15,
    effectiveInputTokens: 15,
    deltaTokens: -22,
    reconciliation: 'mismatch',
    usage: {
      unCachedInputTokens: 10,
      outputTokens: 4,
      cacheWriteInputTokens: 2,
      cacheReadInputTokens: 3,
      totalTokens: 19,
    },
    publicUsage: {
      inputTokens: 15,
      outputTokens: 4,
      cacheReadInputTokens: 3,
      cacheWriteInputTokens: 2,
      totalTokens: 19,
    },
  },
  {
    name: 'local measurement unavailable',
    apiFormat: 'openai',
    measurement: { kind: 'unavailable', reason: 'test measurement unavailable' },
    supplierInput: 3,
    effectiveInputTokens: 3,
    reconciliation: 'unavailable',
    usage: openAiUsage(3),
    publicUsage: openAiPublicUsage(3),
  },
  {
    name: 'invalid SDK terminal input',
    apiFormat: 'openai',
    measurement: estimated(37),
    supplierInput: 3,
    reconciliation: 'no_usage',
    usage: { ...openAiUsage(3), unCachedInputTokens: -1 },
    publicUsage: invalidPublicUsage,
    invalidTerminalUsage: true,
    reason: 'invalid_usage:unCachedInputTokens',
  },
];

function openAiResponse(input: number): Response {
  return new Response([
    `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })}`,
    `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: input, completion_tokens: 1, total_tokens: input + 1 } })}`,
    'data: [DONE]',
    '',
  ].join('\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function anthropicResponse(): Response {
  const frames = [
    ['message_start', { type: 'message_start', message: { id: 'm1', usage: { input_tokens: 10, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }],
    ['message_stop', { type: 'message_stop' }],
  ] as const;
  return new Response(
    frames.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify(data)}`).join('\n\n'),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

async function injectInvalidTerminalUsage(): Promise<void> {
  const runtime = await loadPiAiRuntime();
  const createModels = runtime.createModels;
  vi.spyOn(runtime, 'createModels').mockImplementation((...args) => {
    const models = createModels(...args);
    const streamSimple = models.streamSimple.bind(models);
    vi.spyOn(models, 'streamSimple').mockImplementation((...streamArgs) => {
      const stream = streamSimple(...streamArgs);
      const originalIterator = stream[Symbol.asyncIterator].bind(stream);
      Object.defineProperty(stream, Symbol.asyncIterator, {
        value: async function* () {
          for await (const event of { [Symbol.asyncIterator]: originalIterator }) {
            yield event.type === 'done'
              ? { ...event, message: { ...event.message, usage: { ...event.message.usage, input: -1 } } }
              : event;
          }
        },
      });
      return stream;
    });
    return models;
  });
}

async function runCase(testCase: ReconciliationCase, mode: Mode): Promise<{
  live: InputMeasurementObservation[];
  snapshots: InputMeasurementObservation[];
  publicUsage: ProviderUsage | undefined;
}> {
  const fetchMock = vi.fn(async () => testCase.apiFormat === 'openai'
    ? openAiResponse(testCase.supplierInput)
    : anthropicResponse());
  vi.stubGlobal('fetch', fetchMock);
  if (testCase.invalidTerminalUsage) await injectInvalidTerminalUsage();

  const anthropic = testCase.apiFormat === 'anthropic';
  const adapter = createLLMProvider({
    name: `measurement-reconciliation-${testCase.apiFormat}`,
    apiKey: 'test-key',
    baseUrl: anthropic ? 'https://measurement.invalid' : 'https://measurement.invalid/v1',
    model: anthropic ? 'claude-test' : 'gpt-test',
    apiFormat: testCase.apiFormat,
    temperature: 0,
    timeoutMs: INPUT_MEASUREMENT_TIMEOUT_MS,
  });
  const meter = await adapter.prepareInputMeter();
  const measure = vi.fn(() => structuredClone(testCase.measurement));
  vi.spyOn(adapter, 'prepareInputMeter').mockResolvedValue({ ...meter, measure });

  const live: InputMeasurementObservation[] = [];
  const snapshots: InputMeasurementObservation[] = [];
  const options = {
    messages: [{ role: 'user' as const, content: 'hello' }],
    onInputMeasurement: (fact: InputMeasurementObservation): void => {
      live.push(fact);
      snapshots.push(structuredClone(fact));
    },
  };
  let response: LLMResponse | undefined;
  const chunks: ProviderStreamChunk[] = [];
  if (mode === 'call') {
    response = await adapter.call(options);
  } else {
    if (!adapter.stream) throw new Error('expected stream capability');
    for await (const chunk of adapter.stream(options)) chunks.push(chunk);
  }

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(measure).toHaveBeenCalledTimes(1);
  const publicUsage = mode === 'call'
    ? response?.usage
    : chunks.find(chunk => chunk.type === 'done')?.usage;
  return { live, snapshots, publicUsage };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each(['call', 'stream'] as const)('request-local measurement reconciliation via %s', mode => {
  it.each(cases)('$name', async testCase => {
    const { live, snapshots, publicUsage } = await runCase(testCase, mode);

    expect(publicUsage).toEqual(testCase.publicUsage);
    if (testCase.reconciliation === 'no_usage') {
      expect(publicUsage).not.toHaveProperty('inputTokens');
    } else {
      expect(publicUsage).toHaveProperty('inputTokens', testCase.effectiveInputTokens);
    }
    expect(snapshots.map(fact => fact.kind)).toEqual(['prepared', 'completed']);
    const [prepared, completed] = snapshots;
    if (prepared?.kind !== 'prepared' || completed?.kind !== 'completed') {
      throw new Error('expected one request-local prepared/completed pair');
    }

    expect(prepared.measurement).toEqual(testCase.measurement);
    expect(prepared).not.toHaveProperty('usage');
    expect(live[0]).toEqual(prepared);
    expect(completed).toMatchObject({
      requestId: prepared.requestId,
      descriptorRevision: prepared.descriptor.revision,
      inputHash: prepared.inputHash,
      artifactRef: prepared.artifactRef,
      measurement: testCase.measurement,
      reconciliation: testCase.reconciliation,
    });
    expect(completed.measurement).toEqual(prepared.measurement);
    expect(completed.usage).toEqual(testCase.usage);

    if (testCase.measurement.kind === 'estimated') {
      expect(completed).toHaveProperty('measuredInputTokens', testCase.measurement.tokens);
    } else {
      expect(completed).not.toHaveProperty('measuredInputTokens');
    }
    if (testCase.effectiveInputTokens === undefined) {
      expect(completed).not.toHaveProperty('effectiveInputTokens');
      expect(completed).not.toHaveProperty('normalizedUsageInputTokens');
    } else {
      expect(completed).toHaveProperty('effectiveInputTokens', testCase.effectiveInputTokens);
      expect(completed).toHaveProperty('normalizedUsageInputTokens', testCase.effectiveInputTokens);
    }
    if (testCase.deltaTokens === undefined) {
      expect(completed).not.toHaveProperty('deltaTokens');
    } else {
      expect(completed).toHaveProperty('deltaTokens', testCase.deltaTokens);
    }
    if (testCase.reason === undefined) {
      expect(completed).not.toHaveProperty('reason');
    } else {
      expect(completed).toHaveProperty('reason', testCase.reason);
    }
  });
});
