import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAIAdapter } from '../../../src/foundation/llm-provider/openai.js';

describe('OpenAIAdapter — onToolArgParseError', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('triggers callback when tool_call.function.arguments is not valid JSON', async () => {
    const adapter = new OpenAIAdapter({
      name: 'test-openai',
      model: 'gpt-4',
      apiKey: 'k',
      baseUrl: 'https://example.invalid',
    } as any);

    const handler = vi.fn();
    adapter.onToolArgParseError = handler;

    // mock fetch with tool_call args = "not-json"
    const mockResponse = {
      choices: [{
        message: {
          role: 'assistant',
          tool_calls: [{
            id: 'call_1',
            function: { name: 'foo', arguments: 'not-json' },
          }],
        },
      }],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(mockResponse), { status: 200 })));

    const resp = await adapter.call({ messages: [], maxTokens: 10 });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      provider: 'test-openai',
      toolName: 'foo',
      rawArgs: 'not-json',
      error: expect.any(String),
    });
    // Fallback: tool_use input carries __parseError + __raw (aligns with Anthropic streaming)
    const toolUse = (resp.content as any[]).find(b => b.type === 'tool_use');
    expect(toolUse.input).toEqual({ __parseError: true, __raw: 'not-json' });
  });
});
