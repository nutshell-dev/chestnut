import { describe, it, expect, vi, afterEach } from 'vitest';
import { CustomAnthropicAdapter } from '../../../src/foundation/llm-provider/custom-anthropic.js';
import { parseOutputBudgetError } from '../../../src/foundation/llm-provider/_helpers.js';
import { LLMOutputBudgetExceededError, LLMContextExceededError } from '../../../src/foundation/llm-provider/errors.js';
import { LLM_PROVIDER_AUDIT_EVENTS } from '../../../src/foundation/llm-provider/audit-events.js';

const BUDGET_ERROR_MESSAGE =
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

function createJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('parseOutputBudgetError', () => {
  it('parses Anthropic output-budget error message', () => {
    const parsed = parseOutputBudgetError(BUDGET_ERROR_MESSAGE);
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
    const err = new LLMOutputBudgetExceededError('test', 1000, 900, 200, BUDGET_ERROR_MESSAGE);
    expect(err.code).toBe('LLM_OUTPUT_BUDGET_EXCEEDED');
    expect(err.provider).toBe('test');
    expect(err.contextLimit).toBe(1000);
    expect(err.inputTokens).toBe(900);
    expect(err.requestedMaxTokens).toBe(200);
    expect(err.message).toBe(BUDGET_ERROR_MESSAGE);
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
          return createJsonResponse(
            { error: { message: BUDGET_ERROR_MESSAGE } },
            400,
          );
        }
        retryRequestBody = requestBody;
        return createJsonResponse(SUCCESS_RESPONSE, 200);
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
      vi.fn().mockResolvedValue(createJsonResponse({ error: { message } }, 400)),
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
      vi.fn().mockResolvedValue(createJsonResponse({ error: { message: 'invalid_request: bad model' } }, 400)),
    );

    await expect(adapter.call({ messages: [], maxTokens: 100 })).rejects.toMatchObject({
      name: 'LLMError',
    });
  });
});
