import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIAdapter } from '../../../src/foundation/llm-provider/openai.js';
import { GeminiAdapter } from '../../../src/foundation/llm-provider/gemini.js';
import { CustomAnthropicAdapter } from '../../../src/foundation/llm-provider/custom-anthropic.js';
import { LLMInvalidRequestError } from '../../../src/foundation/llm-provider/request-unicode.js';

const BASE_CONFIG = {
  name: 'test-provider',
  apiKey: 'test-key',
  model: 'test-model',
  maxTokens: 1024,
  temperature: 0.5,
  timeoutMs: 30000,
} as const;

const BAD_MESSAGES = [
  { role: 'user' as const, content: 'a\uD83Db' },
];

const GOOD_MESSAGES = [
  { role: 'user' as const, content: 'hello' },
];

describe('provider adapters reject malformed Unicode before fetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('OpenAIAdapter.call throws LLMInvalidRequestError and does not fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new OpenAIAdapter({ ...BASE_CONFIG, apiFormat: 'openai' });

    await expect(adapter.call({ messages: BAD_MESSAGES })).rejects.toThrow(LLMInvalidRequestError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('OpenAIAdapter.stream throws LLMInvalidRequestError and does not fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new OpenAIAdapter({ ...BASE_CONFIG, apiFormat: 'openai' });

    await expect(async () => {
      for await (const _ of adapter.stream({ messages: BAD_MESSAGES })) { /* noop */ }
    }).rejects.toThrow(LLMInvalidRequestError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('GeminiAdapter.call throws LLMInvalidRequestError and does not fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new GeminiAdapter({ ...BASE_CONFIG, apiFormat: 'gemini' });

    await expect(adapter.call({ messages: BAD_MESSAGES })).rejects.toThrow(LLMInvalidRequestError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('GeminiAdapter.stream throws LLMInvalidRequestError and does not fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new GeminiAdapter({ ...BASE_CONFIG, apiFormat: 'gemini' });

    await expect(async () => {
      for await (const _ of adapter.stream({ messages: BAD_MESSAGES })) { /* noop */ }
    }).rejects.toThrow(LLMInvalidRequestError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('CustomAnthropicAdapter.call throws LLMInvalidRequestError and does not fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new CustomAnthropicAdapter({ ...BASE_CONFIG, apiFormat: 'anthropic' });

    await expect(adapter.call({ messages: BAD_MESSAGES })).rejects.toThrow(LLMInvalidRequestError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('CustomAnthropicAdapter.stream throws LLMInvalidRequestError and does not fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new CustomAnthropicAdapter({ ...BASE_CONFIG, apiFormat: 'anthropic' });

    await expect(async () => {
      for await (const _ of adapter.stream({ messages: BAD_MESSAGES })) { /* noop */ }
    }).rejects.toThrow(LLMInvalidRequestError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('OpenAIAdapter still fetches well-formed request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new OpenAIAdapter({ ...BASE_CONFIG, apiFormat: 'openai' });

    const response = await adapter.call({ messages: GOOD_MESSAGES });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.content).toEqual([{ type: 'text', text: 'ok' }]);
  });
});
