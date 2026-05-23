/**
 * Phase 1139 — gemini-sse-parser SSE 解析语义 dedicated unit test
 *
 * 补充 phase 1022 sse-abort-body-cancel.test.ts 仅覆盖 abort/cancel 行为
 * 覆盖: chunk buffer 拼接 / JSON.parse / done event / functionCall vs text part / malformed line
 */
import { describe, it, expect, vi } from 'vitest';
import { parseGeminiSSEStream } from '../../../src/foundation/llm-provider/gemini-sse-parser.js';
import { LLMRateLimitError } from '../../../src/foundation/llm-provider/errors.js';
import type { StreamChunk } from '../../../src/foundation/llm-provider/types.js';

function makeMockResponse(chunks: string[]): Response {
  let index = 0;
  const readerMock = {
    read: async () => {
      if (index >= chunks.length) return { done: true, value: undefined };
      const chunk = chunks[index++];
      return { done: false, value: new TextEncoder().encode(chunk) };
    },
    cancel: vi.fn(() => Promise.resolve()),
    releaseLock: vi.fn(),
  };
  return {
    body: { getReader: () => readerMock } as unknown as ReadableStream<Uint8Array>,
  } as unknown as Response;
}

const noopHandle = { abort: () => {}, signal: new AbortController().signal, enterStreamPhase: () => {} };

async function drain(response: Response, onParseError?: any): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of parseGeminiSSEStream(response, noopHandle as any, 60_000, 'gemini', onParseError)) {
    out.push(chunk);
  }
  return out;
}

describe('parseGeminiSSEStream — SSE 解析语义', () => {
  it('case 1: text part 单 chunk 完整事件 → text_delta yield', async () => {
    const sseLine = JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text: 'hello' }] }, finishReason: '' }],
    });
    const response = makeMockResponse([`data: ${sseLine}\n\n`]);
    const chunks = await drain(response);
    expect(chunks).toEqual([{ type: 'text_delta', delta: 'hello' }]);
  });

  it('case 2: chunk 跨行 buffer 拼接 → 2 read 凑齐 1 完整事件', async () => {
    const sseLine = JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text: 'world' }] }, finishReason: '' }],
    });
    const half1 = `data: ${sseLine.slice(0, 20)}`;
    const half2 = `${sseLine.slice(20)}\n\n`;
    const response = makeMockResponse([half1, half2]);
    const chunks = await drain(response);
    expect(chunks).toEqual([{ type: 'text_delta', delta: 'world' }]);
  });

  it('case 3: malformed JSON line skip + onStreamParseError 回调', async () => {
    const onParseError = vi.fn();
    const response = makeMockResponse([`data: {invalid json\n\n`]);
    const chunks = await drain(response, onParseError);
    expect(chunks).toEqual([]);
    expect(onParseError).toHaveBeenCalledTimes(1);
    expect(onParseError.mock.calls[0][0]).toMatchObject({ provider: 'gemini', error: expect.any(String) });
  });

  it('case 4: finishReason STOP → done chunk with end_turn + usageMetadata', async () => {
    const sseLine = JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
    });
    const response = makeMockResponse([`data: ${sseLine}\n\n`]);
    const chunks = await drain(response);
    expect(chunks).toContainEqual({
      type: 'done',
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 20 },
    });
  });

  it('case 5: functionCall part → tool_use_start + tool_use_delta', async () => {
    const sseLine = JSON.stringify({
      candidates: [{
        content: { role: 'model', parts: [{ functionCall: { name: 'read', args: { path: 'a.ts' } } }] },
        finishReason: '',
      }],
    });
    const response = makeMockResponse([`data: ${sseLine}\n\n`]);
    const chunks = await drain(response);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({ type: 'tool_use_start', toolUse: { name: 'read' } });
    expect(chunks[1]).toMatchObject({ type: 'tool_use_delta', toolUse: { name: 'read', partialInput: '{"path":"a.ts"}' } });
  });

  it('case 6 (bonus): SSE-level 429 error → LLMRateLimitError throw', async () => {
    const sseLine = JSON.stringify({ error: { code: 429, message: 'rate limited', status: 'RESOURCE_EXHAUSTED' } });
    const response = makeMockResponse([`data: ${sseLine}\n\n`]);
    await expect(drain(response)).rejects.toThrow(LLMRateLimitError);
  });
});
