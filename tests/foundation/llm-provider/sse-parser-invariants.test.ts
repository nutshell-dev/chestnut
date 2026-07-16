import { describe, expect, it, vi } from 'vitest';
import { parseAnthropicSSEStream as parseCustomAnthropic } from '../../../src/foundation/llm-provider/custom-anthropic-sse-parser.js';
import { LLMRateLimitError } from '../../../src/foundation/llm-provider/errors.js';
import { parseGeminiSSEStream } from '../../../src/foundation/llm-provider/gemini-sse-parser.js';
import { parseSSEStream as parseOpenAI } from '../../../src/foundation/llm-provider/openai-sse-parser.js';
import type { StreamChunk } from '../../../src/foundation/llm-provider/types.js';

/**
 * Phase 1139 — gemini-sse-parser SSE 解析语义 dedicated unit test
 *
 * 补充 phase 1022 sse-abort-body-cancel.test.ts 仅覆盖 abort/cancel 行为
 * 覆盖: chunk buffer 拼接 / JSON.parse / done event / functionCall vs text part / malformed line
 */

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

/**
 * Phase 1022 r124 H fork — SSE parser finally reader.cancel() 释放 TCP buffered chunk
 *
 * 反向 3 项:
 *   (1) abort 后 reader.cancel 被调 (mock fetch response + AbortController abort 模拟)
 *   (2) 正常完成 stream 后 reader.cancel 仍被调 (no-op safe per spec)
 *   (3) reader.cancel throw 时 finally 兜底不外溢 (defensive try/catch)
 *
 * 3 parser site verify:
 *   - openai-sse-parser.ts
 *   - gemini-sse-parser.ts
 *   - custom-anthropic-sse-parser.ts
 */

function makeCancelableMockResponse(chunks: string[]): { response: Response; cancelSpy: ReturnType<typeof vi.fn> } {
  const cancelSpy = vi.fn(() => Promise.resolve());
  let index = 0;
  const readerMock = {
    read: async () => {
      if (index >= chunks.length) return { done: true, value: undefined };
      const chunk = chunks[index++];
      return { done: false, value: new TextEncoder().encode(chunk) };
    },
    cancel: cancelSpy,
    releaseLock: vi.fn(),
  };
  const response = {
    body: {
      getReader: () => readerMock,
      cancel: vi.fn(),
    } as unknown as ReadableStream<Uint8Array>,
  } as unknown as Response;
  return { response, cancelSpy };
}

const cancelNoopHandle = { abort: () => {}, signal: new AbortController().signal, enterStreamPhase: () => {} };

describe.each([
  ['openai-sse-parser', parseOpenAI],
  ['gemini-sse-parser', parseGeminiSSEStream],
  ['custom-anthropic-sse-parser', parseCustomAnthropic],
])('phase 1022 — %s reader.cancel in finally', (name, parser) => {
  it('正常完成 stream → reader.cancel 被调 (no-op safe)', async () => {
    const { response, cancelSpy } = makeCancelableMockResponse(['data: {"event": "done"}\n\n']);
    const gen = parser(response, cancelNoopHandle as any, 60_000, 'test-provider');
    for await (const _ of gen) { /* drain */ }
    expect(cancelSpy).toHaveBeenCalled();
  });

  it('caller break (return) → finally reader.cancel 被调', async () => {
    const { response, cancelSpy } = makeCancelableMockResponse(['data: chunk1\n\n', 'data: chunk2\n\n']);
    const gen = parser(response, cancelNoopHandle as any, 60_000, 'test-provider');
    for await (const _ of gen) { break; }
    expect(cancelSpy).toHaveBeenCalled();
  });

  it('reader.cancel throw → finally 兜底不外溢 (defensive try/catch)', async () => {
    const { response, cancelSpy } = makeCancelableMockResponse(['data: done\n\n']);
    cancelSpy.mockImplementationOnce(() => Promise.reject(new Error('mock cancel throw')));
    const gen = parser(response, cancelNoopHandle as any, 60_000, 'test-provider');
    // 不抛 (try/catch defensive)
    await expect(async () => {
      for await (const _ of gen) { /* drain */ }
    }).not.toThrow();
  });
});
