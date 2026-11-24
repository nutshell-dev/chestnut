import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLLMProvider, createProviderFromInput } from '../../../src/foundation/llm-provider/provider-factory.js';
import { createPiAiCredentialStore } from '../../../src/foundation/llm-provider/pi-ai-credentials.js';
import { buildEffectiveCallOptions } from '../../../src/foundation/llm-provider/pi-ai-call-options.js';
import type {
  LLMCallOptions,
  ProviderConfig,
  ProviderStreamChunk,
} from '../../../src/foundation/llm-provider/types.js';

/** Offline requests must finish promptly without contacting the real service. */
const TEST_PROVIDER_TIMEOUT_MS = 5_000;
const CONFIG_MAX_TOKENS = 4_096;
const CALL_MAX_TOKENS = 2_048;
const THINKING_BUDGET_TOKENS = 1_024;

interface WireBody {
  model: string;
  messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
  max_tokens?: number;
  stream: boolean;
  system: Array<Record<string, unknown>>;
  temperature?: number;
  tools: Array<Record<string, unknown> & { input_schema: Record<string, unknown> }>;
  thinking: Record<string, unknown>;
}

interface CapturedRequest {
  url: URL;
  method: string;
  body: WireBody;
}

const sseFrames = [
  { type: 'message_start', message: { id: 'm1', role: 'assistant', content: [], usage: { input_tokens: 15, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
];

function syntheticAnthropicResponse(): Response {
  return new Response(sseFrames.map(event =>
    `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
  ).join(''), { headers: { 'content-type': 'text/event-stream' } });
}

async function captureRequest(input: string | URL | Request, init?: RequestInit): Promise<CapturedRequest> {
  const request = input instanceof Request ? input : undefined;
  const rawBody = init?.body ?? await request?.clone().text();
  if (rawBody === undefined) throw new Error('request body is required');
  return {
    url: new URL(request?.url ?? String(input)),
    method: init?.method ?? request?.method ?? 'GET',
    body: JSON.parse(String(rawBody)) as WireBody,
  };
}

const cases = [
  {
    name: 'defaults-off', thinking: false, maxTokens: CONFIG_MAX_TOKENS, temperature: 0.6,
    config: {}, callOverrides: {},
  },
  {
    name: 'overrides-off', thinking: false, maxTokens: CALL_MAX_TOKENS, temperature: 0.2,
    config: {}, callOverrides: { maxTokens: CALL_MAX_TOKENS, temperature: 0.2 },
  },
  {
    name: 'overrides-on', thinking: true, maxTokens: CALL_MAX_TOKENS + THINKING_BUDGET_TOKENS,
    temperature: undefined,
    config: { thinking: true, thinkingEffort: 'low', thinkingBudgetTokens: THINKING_BUDGET_TOKENS },
    callOverrides: { maxTokens: CALL_MAX_TOKENS, temperature: 0.2 },
  },
  {
    name: 'explicit-off', thinking: false, maxTokens: CALL_MAX_TOKENS, temperature: 0.2,
    config: { thinking: false, thinkingMode: 'adaptive', thinkingEffort: 'high' },
    callOverrides: { maxTokens: CALL_MAX_TOKENS, temperature: 0.2 },
  },
] as const;

function createOptions(overrides: Pick<LLMCallOptions, 'maxTokens' | 'temperature'>): LLMCallOptions {
  return {
    system: 'policy top',
    messages: [
      { role: 'system', content: 'policy extra' },
      { role: 'user', content: [{ type: 'text', text: 'weather?' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'checking' },
          {
            type: 'tool_use', id: 'tool-1', name: 'lookup_weather',
            input: { city: 'Hangzhou', model: 'business-model' },
          },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'sunny', is_error: false }],
      },
      { role: 'user', content: [{ type: 'text', text: 'summarize' }] },
    ],
    tools: [{
      name: 'lookup_weather',
      description: 'lookup weather',
      input_schema: {
        type: 'object',
        properties: { city: { type: 'string' }, model: { type: 'string' } },
        required: ['city'],
      },
    }],
    ...overrides,
  };
}

function createConfig(overrides: Partial<ProviderConfig>): ProviderConfig {
  return {
    name: 'deepseek',
    model: 'deepseek-flash[1m]',
    apiFormat: 'anthropic',
    baseUrl: 'https://api.deepseek.com/anthropic',
    catalogProvider: 'deepseek',
    catalogModel: 'deepseek-flash',
    apiKey: 'synthetic-only',
    temperature: 0.6,
    maxTokens: CONFIG_MAX_TOKENS,
    timeoutMs: TEST_PROVIDER_TIMEOUT_MS,
    thinking: false,
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('DeepSeek Anthropic actual SDK wire', () => {
  describe.each(cases)('$name', testCase => {
    it.each(['call', 'stream'] as const)('%s preserves messages, tools, and effective options', async mode => {
      const captures: CapturedRequest[] = [];
      const fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        captures.push(await captureRequest(input, init));
        return syntheticAnthropicResponse();
      });
      vi.stubGlobal('fetch', fetchSpy);

      try {
        const modify = vi.fn(async () => { throw new Error('credential writes forbidden'); });
        const credentials = createPiAiCredentialStore({ read: async () => undefined, modify });
        const options = createOptions(testCase.callOverrides);
        const before = structuredClone(options);
        const adapter = createLLMProvider(createConfig(testCase.config), { credentials });

        await adapter.prepareInputMeter();
        expect(fetchSpy).not.toHaveBeenCalled();

        if (mode === 'call') {
          const response = await adapter.call(options);
          expect(response.content).toStrictEqual([{ type: 'text', text: 'ok' }]);
          expect(response.stop_reason).toBe('end_turn');
        } else {
          if (!adapter.stream) throw new Error('stream support is required');
          const chunks: ProviderStreamChunk[] = [];
          for await (const chunk of adapter.stream(options)) chunks.push(chunk);
          expect(chunks.map(chunk => chunk.type)).toStrictEqual(['text_delta', 'done']);
          expect(chunks[0]).toStrictEqual({ type: 'text_delta', delta: 'ok' });
          expect(chunks[1]).toMatchObject({ type: 'done', stopReason: 'end_turn' });
        }

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(modify).not.toHaveBeenCalled();
        expect(options).toStrictEqual(before);
        expect(captures).toHaveLength(1);
        const capture = captures[0];
        if (!capture) throw new Error('expected one captured request');
        assertWire(capture, testCase);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});

describe('four-field input with candidate call defaults', () => {
  it('keeps copied/rebuilt input and meter/request defaults equivalent', async () => {
    const captures: CapturedRequest[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      captures.push(await captureRequest(input, init));
      return syntheticAnthropicResponse();
    }));
    const input = {
      baseUrl: 'https://api.deepseek.com/anthropic',
      model: 'deepseek-flash[1m]',
      protocol: 'anthropic' as const,
      authentication: { kind: 'api_key' as const, value: 'synthetic-only' },
    };
    const callDefaults = {
      thinking: true,
      thinkingEffort: 'low' as const,
      thinkingBudgetTokens: THINKING_BUDGET_TOKENS,
      maxTokens: CONFIG_MAX_TOKENS,
      temperature: 0,
    };
    for (const candidate of [input, { ...input, authentication: { ...input.authentication } }]) {
      const handle = createProviderFromInput(candidate);
      const meter = await handle.provider.prepareInputMeter({ callDefaults });
      expect(meter.descriptor.effectiveMaxTokens).toBe(CONFIG_MAX_TOKENS);
      await handle.provider.call({ ...createOptions({}), callDefaults });
    }
    expect(captures).toHaveLength(2);
    for (const capture of captures) {
      expect(capture.body.max_tokens).toBe(CONFIG_MAX_TOKENS + THINKING_BUDGET_TOKENS);
      expect(capture.body.thinking).toMatchObject({ type: 'enabled', budget_tokens: THINKING_BUDGET_TOKENS });
      expect(capture.body).not.toHaveProperty('temperature');
    }
  });

  it('omits an unset maxTokens and preserves explicit zero temperature', async () => {
    let captured: CapturedRequest | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      captured = await captureRequest(input, init);
      return syntheticAnthropicResponse();
    }));
    const handle = createProviderFromInput({
      baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-flash[1m]', protocol: 'anthropic',
      authentication: { kind: 'api_key', value: 'synthetic-only' },
    });
    const effective = buildEffectiveCallOptions(createConfig({ maxTokens: undefined }), {
      callDefaults: { thinking: false, temperature: 0 },
    });
    expect(effective).not.toHaveProperty('maxTokens');
    await handle.provider.call({ ...createOptions({}), callDefaults: { thinking: false, temperature: 0 } });
    // The SDK owns its unset default; L1 does not invent or persist a maxTokens value.
    expect(captured?.body.max_tokens).toBe(65_536);
    expect(captured?.body.temperature).toBe(0);
    expect(captured?.body.thinking).toEqual({ type: 'disabled' });
  });
});

function assertWire(capture: CapturedRequest, testCase: (typeof cases)[number]): void {
  const { url, method, body } = capture;
  expect(url.origin).toBe('https://api.deepseek.com');
  expect(url.pathname).toBe('/anthropic/v1/messages');
  expect(method).toBe('POST');
  expect(body.model).toBe('deepseek-flash[1m]');
  expect(body.stream).toBe(true);
  expect(body.max_tokens).toBe(testCase.maxTokens);
  expect(body.system).toEqual([
    expect.objectContaining({ type: 'text', text: 'policy top\n\npolicy extra' }),
  ]);
  expect(body.messages).toEqual([
    { role: 'user', content: [{ type: 'text', text: 'weather?' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'checking' },
        {
          type: 'tool_use', id: 'tool-1', name: 'lookup_weather',
          input: { city: 'Hangzhou', model: 'business-model' },
        },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'sunny', is_error: false }],
    },
    { role: 'user', content: [expect.objectContaining({ type: 'text', text: 'summarize' })] },
  ]);
  const toolUse = body.messages[1]?.content[1];
  expect(toolUse?.input).toStrictEqual({ city: 'Hangzhou', model: 'business-model' });
  const serializedMessages = JSON.stringify(body.messages);
  expect(serializedMessages.match(/"type":"tool_result"/g)).toHaveLength(1);
  expect(serializedMessages).not.toContain('No result provided');

  expect(body.tools).toEqual([
    expect.objectContaining({ name: 'lookup_weather', description: 'lookup weather' }),
  ]);
  expect(body.tools[0]?.input_schema).toStrictEqual({
    type: 'object',
    properties: { city: { type: 'string' }, model: { type: 'string' } },
    required: ['city'],
  });

  if (testCase.thinking) {
    expect(body.thinking).toStrictEqual({
      type: 'enabled', budget_tokens: THINKING_BUDGET_TOKENS, display: 'summarized',
    });
    expect(body).not.toHaveProperty('temperature');
  } else {
    expect(body.thinking).toStrictEqual({ type: 'disabled' });
    expect(body).toHaveProperty('temperature', testCase.temperature);
  }
}
