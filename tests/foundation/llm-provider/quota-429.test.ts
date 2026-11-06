import { describe, expect, it } from 'vitest';
import { throwHttpErrorResponse } from '../../../src/foundation/llm-provider/_helpers.js';
import { classifyCapturedHttpError } from '../../../src/foundation/llm-provider/pi-ai-classify.js';
import { LLMQuotaError, LLMRateLimitError } from '../../../src/foundation/llm-provider/errors.js';

const RESET_BODY = JSON.stringify({
  error: {
    code: 'AccountQuotaExceeded',
    message: 'Account quota exceeded. It will reset at 2026-10-05 00:00:00 +0800 CST.',
  },
});

describe('Phase 2056 quota-aware HTTP 429 classification', () => {
  it('classifies AccountQuotaExceeded from error.code even when display text omits it', async () => {
    const error = await throwHttpErrorResponse('provider', 'model', new Response(RESET_BODY, {
      status: 429,
      headers: { 'retry-after': '60' },
    })).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LLMQuotaError);
    expect(error).not.toBeInstanceOf(LLMRateLimitError);
    expect(error).toMatchObject({
      rawMessage: 'Account quota exceeded. It will reset at 2026-10-05 00:00:00 +0800 CST.',
      retryAfter: 60,
      resetAtMs: Date.parse('2026-10-04T16:00:00.000Z'),
    });
  });

  it('preserves captured raw body and maps AllocationQuota to typed quota evidence', async () => {
    const body = '{"error":{"code":"Throttling.AllocationQuota","message":"allocation quota exhausted"}}';
    const error = await classifyCapturedHttpError('bedrock', 'model', {
      status: 429,
      body,
      retryAfter: '7',
    });

    expect(error).toBeInstanceOf(LLMQuotaError);
    expect(error).toMatchObject({ rawMessage: body, retryAfter: 7, resetAtMs: undefined });
  });

  it('preserves fractional reset lower bounds without probing early', async () => {
    const milliseconds = await throwHttpErrorResponse('provider', 'model', new Response(
      'AccountQuotaExceeded; quota reset at 2026-10-05T00:00:00.900Z',
      { status: 429 },
    )).catch((caught: unknown) => caught);
    expect(milliseconds).toMatchObject({ resetAtMs: Date.parse('2026-10-05T00:00:00.900Z') });

    const subMillisecond = await throwHttpErrorResponse('provider', 'model', new Response(
      'AccountQuotaExceeded; quota reset at 2026-10-05T00:00:00.0001Z',
      { status: 429 },
    )).catch((caught: unknown) => caught);
    expect(subMillisecond).toMatchObject({ resetAtMs: Date.parse('2026-10-05T00:00:00.001Z') });
  });

  it('keeps ordinary 429 responses on rate-limit semantics', async () => {
    const error = await classifyCapturedHttpError('provider', 'model', {
      status: 429,
      body: '{"error":{"message":"too many requests; current quota is unavailable"}}',
      retryAfter: '5',
    });

    expect(error).toBeInstanceOf(LLMRateLimitError);
    expect(error).not.toBeInstanceOf(LLMQuotaError);
    expect(error).toMatchObject({ retryAfter: 5 });
  });

  it('accepts Z and colon offsets but rejects reset dates without an explicit timezone', async () => {
    const zoned = await throwHttpErrorResponse('provider', 'model', new Response(
      'AccountQuotaExceeded; quota reset at 2026-10-05T00:00:00Z',
      { status: 429 },
    )).catch((caught: unknown) => caught);
    expect(zoned).toMatchObject({ resetAtMs: Date.parse('2026-10-05T00:00:00.000Z') });

    const unzoned = await throwHttpErrorResponse('provider', 'model', new Response(
      'AccountQuotaExceeded; quota reset at 2026-10-05 00:00:00',
      { status: 429 },
    )).catch((caught: unknown) => caught);
    expect(unzoned).toBeInstanceOf(LLMQuotaError);
    expect(unzoned).toMatchObject({ resetAtMs: undefined });
  });
});
