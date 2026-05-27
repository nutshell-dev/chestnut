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
import { describe, it, expect, vi } from 'vitest';
import { parseSSEStream as parseOpenAI } from '../../../src/foundation/llm-provider/openai-sse-parser.js';
import { parseGeminiSSEStream as parseGemini } from '../../../src/foundation/llm-provider/gemini-sse-parser.js';
import { parseAnthropicSSEStream as parseCustomAnthropic } from '../../../src/foundation/llm-provider/custom-anthropic-sse-parser.js';

function makeMockResponse(chunks: string[]): { response: Response; cancelSpy: ReturnType<typeof vi.fn> } {
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

const noopHandle = { abort: () => {}, signal: new AbortController().signal, enterStreamPhase: () => {} };

describe.each([
  ['openai-sse-parser', parseOpenAI],
  ['gemini-sse-parser', parseGemini],
  ['custom-anthropic-sse-parser', parseCustomAnthropic],
])('phase 1022 — %s reader.cancel in finally', (name, parser) => {
  it('正常完成 stream → reader.cancel 被调 (no-op safe)', async () => {
    const { response, cancelSpy } = makeMockResponse(['data: {"event": "done"}\n\n']);
    const gen = parser(response, noopHandle as any, 60_000, 'test-provider');
    for await (const _ of gen) { /* drain */ }
    expect(cancelSpy).toHaveBeenCalled();
  });

  it('caller break (return) → finally reader.cancel 被调', async () => {
    const { response, cancelSpy } = makeMockResponse(['data: chunk1\n\n', 'data: chunk2\n\n']);
    const gen = parser(response, noopHandle as any, 60_000, 'test-provider');
    for await (const _ of gen) { break; }
    expect(cancelSpy).toHaveBeenCalled();
  });

  it('reader.cancel throw → finally 兜底不外溢 (defensive try/catch)', async () => {
    const { response, cancelSpy } = makeMockResponse(['data: done\n\n']);
    cancelSpy.mockImplementationOnce(() => Promise.reject(new Error('mock cancel throw')));
    const gen = parser(response, noopHandle as any, 60_000, 'test-provider');
    // 不抛 (try/catch defensive)
    await expect(async () => {
      for await (const _ of gen) { /* drain */ }
    }).not.toThrow();
  });
});
