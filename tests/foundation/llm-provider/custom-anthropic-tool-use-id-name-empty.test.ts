import { describe, it, expect, vi, afterEach } from 'vitest';
import { CustomAnthropicAdapter } from '../../../src/foundation/llm-provider/custom-anthropic.js';

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

describe('CustomAnthropicAdapter — tool_use_start id/name observability', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('triggers onStreamParseError when content_block_start tool_use missing id', async () => {
    const adapter = new CustomAnthropicAdapter({
      name: 'test-cap',
      model: 'claude-test',
      apiKey: 'k',
      baseUrl: 'https://example.invalid',
    } as any);

    const handler = vi.fn();
    adapter.onStreamParseError = handler;

    const sse = createSSEStreamResponse([
      'event: content_block_start',
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"foo"}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
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
      provider: 'test-cap',
      error: expect.stringContaining('tool_use missing id or name'),
    }));
  });

  it('triggers onStreamParseError when missing name (id present)', async () => {
    const adapter = new CustomAnthropicAdapter({
      name: 'test-cap',
      model: 'claude-test',
      apiKey: 'k',
      baseUrl: 'https://example.invalid',
    } as any);

    const handler = vi.fn();
    adapter.onStreamParseError = handler;

    const sse = createSSEStreamResponse([
      'event: content_block_start',
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"tool_123"}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
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
      provider: 'test-cap',
      error: expect.stringContaining('tool_use missing id or name'),
    }));
  });

  it('does NOT trigger callback for valid tool_use with both id and name', async () => {
    const adapter = new CustomAnthropicAdapter({
      name: 'test-cap',
      model: 'claude-test',
      apiKey: 'k',
      baseUrl: 'https://example.invalid',
    } as any);

    const handler = vi.fn();
    adapter.onStreamParseError = handler;

    const sse = createSSEStreamResponse([
      'event: content_block_start',
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"tool_1","name":"foo"}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sse));

    const yields: any[] = [];
    for await (const chunk of adapter.stream({ messages: [], maxTokens: 10 })) {
      yields.push(chunk);
    }

    const start = yields.find(y => y.type === 'tool_use_start');
    expect(start).toBeDefined();
    expect(start.toolUse.id).toBe('tool_1');
    expect(start.toolUse.name).toBe('foo');
    expect(handler).not.toHaveBeenCalled();
  });
});
