import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAIAdapter } from '../../../src/foundation/llm-provider/openai.js';

function createSSEStreamResponse(lines: string[]): Response {
  const sseText = lines.join('\n') + '\n';
  const encoder = new TextEncoder();
  let sent = false;
  const stream = new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(encoder.encode(sseText));
      } else {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('OpenAIAdapter — tool_use buffer incomplete observability', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('triggers onStreamParseError when stream ends with buffer missing name', async () => {
    const adapter = new OpenAIAdapter({
      name: 'test-openai',
      model: 'gpt-4',
      apiKey: 'k',
      baseUrl: 'https://example.invalid',
    } as any);

    const handler = vi.fn();
    adapter.onStreamParseError = handler;

    const sse = createSSEStreamResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1"}]}}]}',
      '',
      'data: [DONE]',
      '',
    ]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sse));

    const yields: any[] = [];
    for await (const chunk of adapter.stream({ messages: [], maxTokens: 10 })) {
      yields.push(chunk);
    }

    expect(yields.find(y => y.type === 'tool_use_start')).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'test-openai',
      error: expect.stringContaining('buffer incomplete'),
    }));
  });

  it('triggers onStreamParseError when stream ends with buffer missing id', async () => {
    const adapter = new OpenAIAdapter({
      name: 'test-openai',
      model: 'gpt-4',
      apiKey: 'k',
      baseUrl: 'https://example.invalid',
    } as any);

    const handler = vi.fn();
    adapter.onStreamParseError = handler;

    const sse = createSSEStreamResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"foo"}}]}}]}',
      '',
      'data: [DONE]',
      '',
    ]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sse));

    const yields: any[] = [];
    for await (const chunk of adapter.stream({ messages: [], maxTokens: 10 })) {
      yields.push(chunk);
    }

    expect(yields.find(y => y.type === 'tool_use_start')).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'test-openai',
      error: expect.stringContaining('buffer incomplete'),
    }));
  });

  it('does NOT trigger callback for complete tool_call with id and name', async () => {
    const adapter = new OpenAIAdapter({
      name: 'test-openai',
      model: 'gpt-4',
      apiKey: 'k',
      baseUrl: 'https://example.invalid',
    } as any);

    const handler = vi.fn();
    adapter.onStreamParseError = handler;

    const sse = createSSEStreamResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"foo"}}]}}]}',
      '',
      'data: [DONE]',
      '',
    ]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sse));

    const yields: any[] = [];
    for await (const chunk of adapter.stream({ messages: [], maxTokens: 10 })) {
      yields.push(chunk);
    }

    const start = yields.find(y => y.type === 'tool_use_start');
    expect(start).toBeDefined();
    expect(start.toolUse.id).toBe('call_1');
    expect(start.toolUse.name).toBe('foo');
    expect(handler).not.toHaveBeenCalled();
  });
});
