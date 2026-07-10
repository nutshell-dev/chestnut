import { describe, it, expect, vi, afterEach } from 'vitest';
import { CustomAnthropicAdapter } from '../../../src/foundation/llm-provider/custom-anthropic.js';
import { LLM_PROVIDER_AUDIT_EVENTS } from '../../../src/foundation/llm-provider/audit-events.js';
import { LLMContextExceededError } from '../../../src/foundation/llm-provider/errors.js';

const BUDGET_ERROR_MESSAGE =
  "This model's maximum context length is 1048565 tokens. However, you requested " +
  '1052788 tokens (659572 in the messages, 393216 in the completions).';

const ZERO_BUDGET_ERROR_MESSAGE =
  "This model's maximum context length is 1000 tokens. However, you requested " +
  '1100 tokens (1000 in the messages, 100 in the completions).';

function createJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function createSSEStreamResponse(events: string[]): Response {
  const sseText = events.map(e => `data: ${e}\n\n`).join('');
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

function createSuccessSSEEvents(): string[] {
  return [
    JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } }),
    JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  ];
}

function createAuditSink() {
  const writes: unknown[][] = [];
  return {
    writes,
    sink: {
      write: (type: string, ...cols: unknown[]) => writes.push([type, ...cols]),
      preview: (s: string) => s,
    },
  };
}

describe('CustomAnthropicAdapter — stream output budget exceeded', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('retries stream with adjusted max_tokens on 400 preflight', async () => {
    const { writes, sink } = createAuditSink();
    const adapter = new CustomAnthropicAdapter({
      name: 'test-cap',
      model: 'claude-test',
      apiKey: 'k',
      baseUrl: 'https://example.invalid',
      maxTokens: 200000,
      temperature: 0.5,
      timeoutMs: 30000,
      apiFormat: 'anthropic',
      auditLog: sink as any,
    });

    let firstRequestBody: unknown;
    let retryRequestBody: unknown;

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        const requestBody = JSON.parse(init.body as string);
        if (firstRequestBody === undefined) {
          firstRequestBody = requestBody;
          return createJsonResponse({ error: { message: BUDGET_ERROR_MESSAGE } }, 400);
        }
        retryRequestBody = requestBody;
        return createSSEStreamResponse(createSuccessSSEEvents());
      }),
    );

    const chunks: unknown[] = [];
    for await (const chunk of adapter.stream({ messages: [], maxTokens: 393216 })) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThan(0);
    expect(firstRequestBody).toMatchObject({ max_tokens: 393216, stream: true });
    expect(retryRequestBody).toMatchObject({
      max_tokens: 1048565 - 659572,
      stream: true,
    });

    const audit = writes.find(e => e[0] === LLM_PROVIDER_AUDIT_EVENTS.OUTPUT_BUDGET_ADJUSTED);
    expect(audit).toBeDefined();
    expect(audit).toEqual(
      expect.arrayContaining([
        LLM_PROVIDER_AUDIT_EVENTS.OUTPUT_BUDGET_ADJUSTED,
        expect.stringContaining('provider=test-cap'),
        expect.stringContaining('model=claude-test'),
        expect.stringContaining('original_max_tokens=393216'),
        expect.stringContaining(`adjusted_max_tokens=${1048565 - 659572}`),
        expect.stringContaining('context_limit=1048565'),
        expect.stringContaining('input_tokens=659572'),
      ]),
    );
  });

  it('throws LLMContextExceededError when stream adjusted budget is not positive', async () => {
    const { writes, sink } = createAuditSink();
    const adapter = new CustomAnthropicAdapter({
      name: 'test-cap',
      model: 'claude-test',
      apiKey: 'k',
      baseUrl: 'https://example.invalid',
      maxTokens: 200000,
      temperature: 0.5,
      timeoutMs: 30000,
      apiFormat: 'anthropic',
      auditLog: sink as any,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(createJsonResponse({ error: { message: ZERO_BUDGET_ERROR_MESSAGE } }, 400)),
    );

    await expect(
      (async () => {
        for await (const _chunk of adapter.stream({ messages: [], maxTokens: 100 })) {
          // no-op
        }
      })(),
    ).rejects.toBeInstanceOf(LLMContextExceededError);

    const audit = writes.find(e => e[0] === LLM_PROVIDER_AUDIT_EVENTS.OUTPUT_BUDGET_ADJUSTED);
    expect(audit).toBeDefined();
    expect(audit).toEqual(
      expect.arrayContaining([expect.stringContaining('reason=nonpositive_adjusted')]),
    );
  });
});
