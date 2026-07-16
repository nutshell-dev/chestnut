import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseOutputBudgetError } from '../../../src/foundation/llm-provider/_helpers.js';
import { LLM_PROVIDER_AUDIT_EVENTS } from '../../../src/foundation/llm-provider/audit-events.js';
import { CustomAnthropicAdapter } from '../../../src/foundation/llm-provider/custom-anthropic.js';
import {
  LLMContextExceededError,
  LLMOutputBudgetExceededError,
} from '../../../src/foundation/llm-provider/errors.js';

/**
 * anthropic guards invariants — mechanical merge of the following source files
 * (no assertion logic changed):
 *  - base-anthropic-empty-id-guard.test.ts
 *  - base-anthropic-orphan-guard.test.ts
 *  - base-anthropic-empty-content-guard.test.ts
 */


describe('base-anthropic-empty-id-guard', () => {
  describe('base-anthropic empty id guard (phase 1274)', () => {
    it('反向: tool_use_id 空串 → skip + TOOL_RESULT_MISSING_ID audit', () => {
      const auditWrites: unknown[][] = [];
      const mockAudit = { write: (type: string, ...cols: unknown[]) => auditWrites.push([type, ...cols]) , preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s};

      const adapter = new CustomAnthropicAdapter({
        name: 'test-provider',
        apiKey: 'test',
        model: 'test-model',
        maxTokens: 1024,
        temperature: 0.5,
        timeoutMs: 30000,
        apiFormat: 'anthropic',
        auditLog: mockAudit as any,
      });

      const messages = [
        {
          role: 'user' as const,
          content: [{ type: 'tool_result' as const, tool_use_id: '', content: 'x' }],
        },
      ];

      const result = (adapter as any).formatMessages(messages);

      const allToolResults = result.flatMap((m: any) =>
        Array.isArray(m.content) ? m.content.filter((b: any) => b.type === 'tool_result') : []
      );
      expect(allToolResults).toHaveLength(0);
      expect(auditWrites[0][0]).toBe(LLM_PROVIDER_AUDIT_EVENTS.TOOL_RESULT_MISSING_ID);
    });
  });
});

describe('base-anthropic-orphan-guard', () => {
  describe('base-anthropic orphan guard (phase 1274)', () => {
    it('反向: 孤儿 tool_result → skip + TOOL_RESULT_ORPHAN_ID audit', () => {
      const auditWrites: unknown[][] = [];
      const mockAudit = { write: (type: string, ...cols: unknown[]) => auditWrites.push([type, ...cols]) , preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s};

      const adapter = new CustomAnthropicAdapter({
        name: 'test-provider',
        apiKey: 'test',
        model: 'test-model',
        maxTokens: 1024,
        temperature: 0.5,
        timeoutMs: 30000,
        apiFormat: 'anthropic',
        auditLog: mockAudit as any,
      });

      const messages = [
        {
          role: 'assistant' as const,
          content: [{ type: 'tool_use' as const, id: 'A', name: 'foo', input: {} }],
        },
        {
          role: 'user' as const,
          content: [{ type: 'tool_result' as const, tool_use_id: 'A', content: 'ok' }],
        },
        {
          role: 'user' as const,
          content: [{ type: 'tool_result' as const, tool_use_id: 'B-orphan', content: 'fake' }],
        },
      ];

      const result = (adapter as any).formatMessages(messages);

      // No B-orphan block in output
      const allToolResults = result.flatMap((m: any) =>
        Array.isArray(m.content) ? m.content.filter((b: any) => b.type === 'tool_result') : []
      );
      expect(allToolResults.some((b: any) => b.tool_use_id === 'B-orphan')).toBe(false);
      expect(allToolResults.some((b: any) => b.tool_use_id === 'A')).toBe(true);

      // Audit hit TOOL_RESULT_ORPHAN_ID once
      expect(auditWrites.filter(w => w[0] === LLM_PROVIDER_AUDIT_EVENTS.TOOL_RESULT_ORPHAN_ID)).toHaveLength(1);
    });
  });
});

describe('base-anthropic-empty-content-guard', () => {
  describe('base-anthropic empty content guard (phase 1274)', () => {
    it('反向: assistant content [] → skip 整条 + ASSISTANT_EMPTY_CONTENT_SKIPPED audit', () => {
      const auditWrites: unknown[][] = [];
      const mockAudit = { write: (type: string, ...cols: unknown[]) => auditWrites.push([type, ...cols]) , preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s};

      const adapter = new CustomAnthropicAdapter({
        name: 'test-provider',
        apiKey: 'test',
        model: 'test-model',
        maxTokens: 1024,
        temperature: 0.5,
        timeoutMs: 30000,
        apiFormat: 'anthropic',
        auditLog: mockAudit as any,
      });

      const messages = [
        {
          role: 'assistant' as const,
          content: [],
        },
      ];

      const result = (adapter as any).formatMessages(messages);

      expect(result.filter((m: any) => m.role === 'assistant')).toHaveLength(0);
      expect(auditWrites[0][0]).toBe(LLM_PROVIDER_AUDIT_EVENTS.ASSISTANT_EMPTY_CONTENT_SKIPPED);
    });

    it('反向: dropThinking 后 assistant 只剩 thinking → skip 整条 + ASSISTANT_EMPTY_CONTENT_SKIPPED audit', () => {
      const auditWrites: unknown[][] = [];
      const mockAudit = { write: (type: string, ...cols: unknown[]) => auditWrites.push([type, ...cols]) , preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s};

      const adapter = new CustomAnthropicAdapter({
        name: 'test-provider',
        apiKey: 'test',
        model: 'test-model',
        maxTokens: 1024,
        temperature: 0.5,
        timeoutMs: 30000,
        apiFormat: 'anthropic',
        dropThinkingBlocks: true,
        auditLog: mockAudit as any,
      });

      const messages = [
        {
          role: 'assistant' as const,
          content: [{ type: 'thinking' as const, thinking: '...' }],
        },
      ];

      const result = (adapter as any).formatMessages(messages);

      expect(result.filter((m: any) => m.role === 'assistant')).toHaveLength(0);
      expect(auditWrites[0][0]).toBe(LLM_PROVIDER_AUDIT_EVENTS.ASSISTANT_EMPTY_CONTENT_SKIPPED);
    });
  });
});

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

  it('retries stream when thinking is disabled even if thinkingBudgetTokens is set', async () => {
    const adapter = new CustomAnthropicAdapter({
      name: 'test-cap',
      model: 'claude-test',
      apiKey: 'k',
      baseUrl: 'https://example.invalid',
      maxTokens: 200000,
      temperature: 0.5,
      timeoutMs: 30000,
      apiFormat: 'anthropic',
      thinking: false,
      thinkingBudgetTokens: 100000,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce(createJsonResponse({ error: { message: BUDGET_ERROR_MESSAGE } }, 400))
        .mockResolvedValueOnce(createSSEStreamResponse(createSuccessSSEEvents())),
    );

    const chunks: unknown[] = [];
    for await (const chunk of adapter.stream({ messages: [], maxTokens: 393216 })) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThan(0);
  });

  it('throws LLMContextExceededError when effective thinking budget equals adjusted max_tokens (stream)', async () => {
    const THINKING_BUDGET_EQUALS_ADJUSTED_MESSAGE =
      "This model's maximum context length is 105000 tokens. However, you requested " +
      '105000 tokens (55000 in the messages, 50000 in the completions).';

    const adapter = new CustomAnthropicAdapter({
      name: 'test-cap',
      model: 'claude-test',
      apiKey: 'k',
      baseUrl: 'https://example.invalid',
      maxTokens: 200000,
      temperature: 0.5,
      timeoutMs: 30000,
      apiFormat: 'anthropic',
      thinking: true,
      thinkingBudgetTokens: 50000,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        createJsonResponse({ error: { message: THINKING_BUDGET_EQUALS_ADJUSTED_MESSAGE } }, 400),
      ),
    );

    await expect(
      (async () => {
        for await (const _chunk of adapter.stream({ messages: [], maxTokens: 60000 })) {
          // no-op
        }
      })(),
    ).rejects.toBeInstanceOf(LLMContextExceededError);
  });

  it('writes OUTPUT_BUDGET_ADJUSTED audit before throwing thinking budget conflict (stream)', async () => {
    const THINKING_BUDGET_EQUALS_ADJUSTED_MESSAGE =
      "This model's maximum context length is 105000 tokens. However, you requested " +
      '105000 tokens (55000 in the messages, 50000 in the completions).';

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
      thinking: true,
      thinkingBudgetTokens: 50000,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        createJsonResponse({ error: { message: THINKING_BUDGET_EQUALS_ADJUSTED_MESSAGE } }, 400),
      ),
    );

    await expect(
      (async () => {
        for await (const _chunk of adapter.stream({ messages: [], maxTokens: 60000 })) {
          // no-op
        }
      })(),
    ).rejects.toBeInstanceOf(LLMContextExceededError);

    const audit = writes.find(e => e[0] === LLM_PROVIDER_AUDIT_EVENTS.OUTPUT_BUDGET_ADJUSTED);
    expect(audit).toBeDefined();
    expect(audit).toEqual(
      expect.arrayContaining([
        LLM_PROVIDER_AUDIT_EVENTS.OUTPUT_BUDGET_ADJUSTED,
        expect.stringContaining('provider=test-cap'),
        expect.stringContaining('original_max_tokens=60000'),
        expect.stringContaining('adjusted_max_tokens=50000'),
        expect.stringContaining('context_limit=105000'),
        expect.stringContaining('input_tokens=55000'),
      ]),
    );
  });
});

const OUTPUT_BUDGET_ERROR_MESSAGE =
  "This model's maximum context length is 1048565 tokens. However, you requested " +
  '1052788 tokens (659572 in the messages, 393216 in the completions).';

const SUCCESS_RESPONSE = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-test',
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: 'ok' }],
  usage: { input_tokens: 10, output_tokens: 1 },
};

function createOutputBudgetJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('parseOutputBudgetError', () => {
  it('parses Anthropic output-budget error message', () => {
    const parsed = parseOutputBudgetError(OUTPUT_BUDGET_ERROR_MESSAGE);
    expect(parsed).toEqual({
      contextLimit: 1048565,
      inputTokens: 659572,
      requestedMaxTokens: 393216,
    });
  });

  it('parses singular "completion" in Anthropic output-budget error message', () => {
    const message =
      "This model's maximum context length is 1048565 tokens. However, you requested " +
      '1052788 tokens (659572 in the messages, 393216 in the completion).';
    const parsed = parseOutputBudgetError(message);
    expect(parsed).toEqual({
      contextLimit: 1048565,
      inputTokens: 659572,
      requestedMaxTokens: 393216,
    });
  });

  it('returns null for unrelated messages', () => {
    expect(parseOutputBudgetError('invalid request')).toBeNull();
    expect(parseOutputBudgetError('context_length_exceeded')).toBeNull();
  });
});

describe('LLMOutputBudgetExceededError', () => {
  it('exposes parsed fields and code', () => {
    const err = new LLMOutputBudgetExceededError('test', 1000, 900, 200, OUTPUT_BUDGET_ERROR_MESSAGE);
    expect(err.code).toBe('LLM_OUTPUT_BUDGET_EXCEEDED');
    expect(err.provider).toBe('test');
    expect(err.contextLimit).toBe(1000);
    expect(err.inputTokens).toBe(900);
    expect(err.requestedMaxTokens).toBe(200);
    expect(err.message).toBe(OUTPUT_BUDGET_ERROR_MESSAGE);
  });
});

describe('CustomAnthropicAdapter — output budget exceeded', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('retries once with adjusted max_tokens when API reports output budget exceeded', async () => {
    const auditWrites: unknown[][] = [];
    const mockAudit = {
      write: (type: string, ...cols: unknown[]) => auditWrites.push([type, ...cols]),
      preview: (s: string) => s,
    };

    const adapter = new CustomAnthropicAdapter({
      name: 'test-cap',
      model: 'claude-test',
      apiKey: 'k',
      baseUrl: 'https://example.invalid',
      maxTokens: 200000,
      temperature: 0.5,
      timeoutMs: 30000,
      apiFormat: 'anthropic',
      auditLog: mockAudit as any,
    });

    let firstRequestBody: unknown;
    let retryRequestBody: unknown;

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        const requestBody = JSON.parse(init.body as string);
        if (firstRequestBody === undefined) {
          firstRequestBody = requestBody;
          return createOutputBudgetJsonResponse(
            { error: { message: OUTPUT_BUDGET_ERROR_MESSAGE } },
            400,
          );
        }
        retryRequestBody = requestBody;
        return createOutputBudgetJsonResponse(SUCCESS_RESPONSE, 200);
      }),
    );

    const result = await adapter.call({ messages: [], maxTokens: 393216 });

    expect(result.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(firstRequestBody).toMatchObject({ max_tokens: 393216 });
    expect(retryRequestBody).toMatchObject({
      max_tokens: 1048565 - 659572,
    });

    const audit = auditWrites.find(e => e[0] === LLM_PROVIDER_AUDIT_EVENTS.OUTPUT_BUDGET_ADJUSTED);
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

  it('throws LLMContextExceededError when adjusted budget is not positive', async () => {
    const auditWrites: unknown[][] = [];
    const mockAudit = {
      write: (type: string, ...cols: unknown[]) => auditWrites.push([type, ...cols]),
      preview: (s: string) => s,
    };

    const adapter = new CustomAnthropicAdapter({
      name: 'test-cap',
      model: 'claude-test',
      apiKey: 'k',
      baseUrl: 'https://example.invalid',
      maxTokens: 200000,
      temperature: 0.5,
      timeoutMs: 30000,
      apiFormat: 'anthropic',
      auditLog: mockAudit as any,
    });

    const message =
      "This model's maximum context length is 1000 tokens. However, you requested " +
      '1100 tokens (1000 in the messages, 100 in the completions).';

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(createOutputBudgetJsonResponse({ error: { message } }, 400)),
    );

    await expect(adapter.call({ messages: [], maxTokens: 100 })).rejects.toBeInstanceOf(
      LLMContextExceededError,
    );

    const audit = auditWrites.find(e => e[0] === LLM_PROVIDER_AUDIT_EVENTS.OUTPUT_BUDGET_ADJUSTED);
    expect(audit).toBeDefined();
    expect(audit).toEqual(expect.arrayContaining([expect.stringContaining('reason=nonpositive_adjusted')]));
  });

  it('falls back to original error path for non-output-budget 400 errors', async () => {
    const adapter = new CustomAnthropicAdapter({
      name: 'test-cap',
      model: 'claude-test',
      apiKey: 'k',
      baseUrl: 'https://example.invalid',
      maxTokens: 200000,
      temperature: 0.5,
      timeoutMs: 30000,
      apiFormat: 'anthropic',
    } as any);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(createOutputBudgetJsonResponse({ error: { message: 'invalid_request: bad model' } }, 400)),
    );

    await expect(adapter.call({ messages: [], maxTokens: 100 })).rejects.toMatchObject({
      name: 'LLMError',
    });
  });
});

