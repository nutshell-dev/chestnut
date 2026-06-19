import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BaseAnthropicAdapter, type AnthropicRequestBody } from '../../../src/foundation/llm-provider/base-anthropic.js';
import { OpenAIAdapter } from '../../../src/foundation/llm-provider/openai.js';
import { GeminiAdapter } from '../../../src/foundation/llm-provider/gemini.js';
import { CustomAnthropicAdapter } from '../../../src/foundation/llm-provider/custom-anthropic.js';
import type { Message, ProviderConfig } from '../../../src/foundation/llm-provider/types.js';

const METADATA_FIELDS = ['origin', 'systemSubtype', 'addedAt', 'trimmed'] as const;

const messagesWithMetadata: Message[] = [
  {
    role: 'user',
    content: 'hello',
    origin: 'user',
    addedAt: '2026-06-19T12:00:00Z',
  },
  {
    role: 'user',
    content: '[system message] heartbeat',
    origin: 'system',
    systemSubtype: 'heartbeat',
    addedAt: '2026-06-19T12:00:30Z',
    trimmed: {
      trimmedAt: '2026-06-19T13:00:00Z',
      originalContentBytes: 5000,
    },
  },
  {
    role: 'assistant',
    content: [{ type: 'text', text: 'hi' }],
    addedAt: '2026-06-19T12:01:00Z',
  },
];

function assertNoMetadata(messages: Array<Record<string, unknown>>) {
  for (const m of messages) {
    for (const key of METADATA_FIELDS) {
      expect(m[key]).toBeUndefined();
    }
  }
}

function makeProviderConfig(apiFormat: ProviderConfig['apiFormat']): ProviderConfig {
  return {
    name: 'test',
    apiKey: 'test-key',
    model: 'test-model',
    temperature: 0.7,
    timeoutMs: 1000,
    apiFormat,
  };
}

class TestAnthropicAdapter extends BaseAnthropicAdapter {
  readonly name = 'test-anthropic';
  readonly model = 'test-model';
  protected readonly config = makeProviderConfig('anthropic');

  call() {
    throw new Error('not implemented');
  }

  exposeBody(options: { messages: Message[]; system?: string; maxTokens?: number }) {
    return this.buildBaseRequestBody(options);
  }
}

describe('sanitize integration with provider build payload', () => {
  it('base-anthropic buildBaseRequestBody strips metadata', () => {
    const adapter = new TestAnthropicAdapter();
    const body = adapter.exposeBody({ messages: messagesWithMetadata });
    expect(body.messages.length).toBeGreaterThanOrEqual(2);
    assertNoMetadata(body.messages as Array<Record<string, unknown>>);
  });

  describe('OpenAIAdapter', () => {
    let originalFetch: typeof fetch;
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
      fetchMock = vi.fn();
      globalThis.fetch = fetchMock;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('call body messages exclude metadata', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          id: '1',
          object: 'chat.completion',
          created: 0,
          model: 'test-model',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          }],
        }),
      } as unknown as Response);

      const adapter = new OpenAIAdapter(makeProviderConfig('openai'));
      await adapter.call({ messages: messagesWithMetadata });

      expect(fetchMock).toHaveBeenCalled();
      const [, init] = fetchMock.mock.calls[0];
      const body = JSON.parse(init.body as string);
      assertNoMetadata(body.messages as Array<Record<string, unknown>>);
    });
  });

  describe('GeminiAdapter', () => {
    let originalFetch: typeof fetch;
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
      fetchMock = vi.fn();
      globalThis.fetch = fetchMock;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('call body contents exclude metadata', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          candidates: [{
            content: {
              role: 'model',
              parts: [{ text: 'ok' }],
            },
            finishReason: 'STOP',
          }],
        }),
      } as unknown as Response);

      const adapter = new GeminiAdapter(makeProviderConfig('gemini'));
      await adapter.call({ messages: messagesWithMetadata });

      expect(fetchMock).toHaveBeenCalled();
      const [, init] = fetchMock.mock.calls[0];
      const body = JSON.parse(init.body as string);
      // contents is array of { role, parts } entries; metadata must not leak
      const flatMessages = (body.contents as Array<Record<string, unknown>>).flatMap(c => {
        const parts = Array.isArray(c.parts) ? c.parts : [];
        return parts.map(p => ({ role: c.role, ...(p as Record<string, unknown>) }));
      });
      assertNoMetadata(flatMessages);
    });
  });

  describe('CustomAnthropicAdapter', () => {
    let originalFetch: typeof fetch;
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
      fetchMock = vi.fn();
      globalThis.fetch = fetchMock;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('call body messages exclude metadata', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'test-model',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
        }),
      } as unknown as Response);

      const adapter = new CustomAnthropicAdapter(makeProviderConfig('anthropic'));
      await adapter.call({ messages: messagesWithMetadata });

      expect(fetchMock).toHaveBeenCalled();
      const [, init] = fetchMock.mock.calls[0];
      const body = JSON.parse(init.body as string);
      assertNoMetadata(body.messages as Array<Record<string, unknown>>);
    });
  });
});
