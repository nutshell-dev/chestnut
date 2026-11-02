import { describe, it, expect } from 'vitest';
import {
  LLMError,
  LLMAuthError,
  LLMModelNotFoundError,
  LLMRateLimitError,
  LLMQuotaError,
  LLMTimeoutError,
  LLMNetworkError,
} from '../../../src/foundation/llm-provider/errors.js';
import { LLMInvalidRequestError } from '../../../src/foundation/llm-provider/request-unicode.js';
import { classifyLLMError, LLMAllProvidersFailedError } from '../../../src/foundation/llm-orchestrator/errors.js';

describe('orchestrator classifyLLMError (phase 451 Step C)', () => {
  // Phase 2037: quota 类只消费 L1 typed evidence，不从普通 Error 文本猜测。
  it('LLMQuotaError → quota', () => {
    expect(classifyLLMError(new LLMQuotaError('kimi', 'quota exceeded'))).toBe('quota');
  });

  it.each(['quota exceeded', 'insufficient credit', 'billing issue'])(
    'plain Error keyword %s → unknown',
    (message) => {
      expect(classifyLLMError(new Error(message))).toBe('unknown');
    },
  );

  it('LLMAuthError without quota keyword → permanent', () => {
    expect(classifyLLMError(new LLMAuthError('anthropic', 401))).toBe('permanent');
  });

  it('LLMModelNotFoundError → permanent', () => {
    expect(classifyLLMError(new LLMModelNotFoundError('anthropic', 'missing'))).toBe('permanent');
  });

  it('LLMRateLimitError → rate_limit', () => {
    expect(classifyLLMError(new LLMRateLimitError('anthropic'))).toBe('rate_limit');
  });

  it('LLMNetworkError → transient', () => {
    expect(classifyLLMError(new LLMNetworkError('openai', new Error('ECONNRESET')))).toBe('transient');
  });

  it('LLMTimeoutError → transient', () => {
    expect(classifyLLMError(new LLMTimeoutError('anthropic', 60_000))).toBe('transient');
  });

  it('base LLMError → transient', () => {
    expect(classifyLLMError(new LLMError('something'))).toBe('transient');
  });

  it('LLMInvalidRequestError → permanent', () => {
    expect(classifyLLMError(new LLMInvalidRequestError('openai', 'provider_json_parse_rejected'))).toBe('permanent');
  });

  it('LLMAllProvidersFailedError with all invalid_request → permanent', () => {
    const err = new LLMAllProvidersFailedError([
      { provider: 'openai', error: new LLMInvalidRequestError('openai', 'provider_json_parse_rejected') },
      { provider: 'anthropic', error: new LLMInvalidRequestError('anthropic', 'provider_json_parse_rejected') },
    ]);
    expect(classifyLLMError(err)).toBe('permanent');
  });

  it('LLMAllProvidersFailedError mixed permanent+transient → transient', () => {
    const err = new LLMAllProvidersFailedError([
      { provider: 'openai', error: new LLMInvalidRequestError('openai', 'provider_json_parse_rejected') },
      { provider: 'anthropic', error: new LLMNetworkError('anthropic', new Error('timeout')) },
    ]);
    expect(classifyLLMError(err)).toBe('transient');
  });

  it('LLMAllProvidersFailedError all rate_limit → rate_limit', () => {
    const err = new LLMAllProvidersFailedError([
      { provider: 'openai', error: new LLMRateLimitError('openai') },
      { provider: 'anthropic', error: new LLMRateLimitError('anthropic') },
    ]);
    expect(classifyLLMError(err)).toBe('rate_limit');
  });

  it('unrecognized plain Error → unknown', () => {
    expect(classifyLLMError(new Error('unexpected'))).toBe('unknown');
  });

  it('usage limit keyword in plain Error → unknown', () => {
    expect(classifyLLMError(new Error("You've reached your 5-hour usage limit."))).toBe('unknown');
  });

  it('LLMAuthError 403 with quota message → permanent（不再文本改判）', () => {
    expect(classifyLLMError(new LLMAuthError('anthropic', 403, "You've reached your 5-hour usage limit."))).toBe('permanent');
  });

  it('LLMAllProvidersFailedError [quota] → quota', () => {
    const err = new LLMAllProvidersFailedError([
      { provider: 'kimi', error: new LLMQuotaError('kimi', 'quota exceeded') },
    ]);
    expect(classifyLLMError(err)).toBe('quota');
  });

  it('LLMAllProvidersFailedError [quota, transient] → transient（transient 优先可重试）', () => {
    const err = new LLMAllProvidersFailedError([
      { provider: 'kimi', error: new LLMQuotaError('kimi', 'quota exceeded') },
      { provider: 'openai', error: new LLMNetworkError('openai', new Error('ECONNRESET')) },
    ]);
    expect(classifyLLMError(err)).toBe('transient');
  });

  it('LLMAllProvidersFailedError [quota, rate_limit] → rate_limit（Retry-After 驱动优先）', () => {
    const err = new LLMAllProvidersFailedError([
      { provider: 'kimi', error: new LLMQuotaError('kimi', 'quota exceeded') },
      { provider: 'openai', error: new LLMRateLimitError('openai') },
    ]);
    expect(classifyLLMError(err)).toBe('rate_limit');
  });

  it('LLMAllProvidersFailedError [permanent, quota] → quota（quota 优先于 permanent）', () => {
    const err = new LLMAllProvidersFailedError([
      { provider: 'openai', error: new LLMInvalidRequestError('openai', 'provider_json_parse_rejected') },
      { provider: 'kimi', error: new LLMQuotaError('kimi', 'quota exceeded') },
    ]);
    expect(classifyLLMError(err)).toBe('quota');
  });
});
