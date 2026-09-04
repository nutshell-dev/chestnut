import { describe, it, expect } from 'vitest';
import {
  LLMError,
  LLMAuthError,
  LLMModelNotFoundError,
  LLMRateLimitError,
  LLMTimeoutError,
  LLMNetworkError,
} from '../../../src/foundation/llm-provider/errors.js';
import { LLMInvalidRequestError } from '../../../src/foundation/llm-provider/request-unicode.js';
import { classifyLLMError, LLMAllProvidersFailedError } from '../../../src/foundation/llm-orchestrator/errors.js';

describe('orchestrator classifyLLMError (phase 451 Step C)', () => {
  // phase 1776: quota 类从 permanent 拆出——配额时间窗语义（EventLoop 退避），非配置类永久
  it('quota keyword in plain Error → quota', () => {
    expect(classifyLLMError(new Error('quota exceeded'))).toBe('quota');
  });

  it('insufficient credit keyword → quota', () => {
    expect(classifyLLMError(new Error('insufficient credit'))).toBe('quota');
  });

  it('billing keyword → quota', () => {
    expect(classifyLLMError(new Error('billing issue'))).toBe('quota');
  });

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
    expect(classifyLLMError(new LLMInvalidRequestError('openai', 'invalid_unicode'))).toBe('permanent');
  });

  it('LLMAllProvidersFailedError with all invalid_request → permanent', () => {
    const err = new LLMAllProvidersFailedError([
      { provider: 'openai', error: new LLMInvalidRequestError('openai', 'invalid_unicode') },
      { provider: 'anthropic', error: new LLMInvalidRequestError('anthropic', 'invalid_unicode') },
    ]);
    expect(classifyLLMError(err)).toBe('permanent');
  });

  it('LLMAllProvidersFailedError mixed permanent+transient → transient', () => {
    const err = new LLMAllProvidersFailedError([
      { provider: 'openai', error: new LLMInvalidRequestError('openai', 'invalid_unicode') },
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

  // phase 1776: 'usage limit' 覆盖 Kimi k3 5h 窗文案；LLMAuthError 403 + quota
  // message 时 quota 优先于 instanceof permanent（时间窗语义 ≠ 配置类永久）。
  it('usage limit keyword (Kimi 5h window) → quota', () => {
    expect(classifyLLMError(new Error("You've reached your 5-hour usage limit."))).toBe('quota');
  });

  it('LLMAuthError 403 with quota message → quota (quota 优先于 instanceof)', () => {
    expect(classifyLLMError(new LLMAuthError('anthropic', 403, "You've reached your 5-hour usage limit."))).toBe('quota');
  });

  it('LLMAllProvidersFailedError [quota] → quota', () => {
    const err = new LLMAllProvidersFailedError([
      { provider: 'kimi', error: new Error('quota exceeded') },
    ]);
    expect(classifyLLMError(err)).toBe('quota');
  });

  it('LLMAllProvidersFailedError [quota, transient] → transient（transient 优先可重试）', () => {
    const err = new LLMAllProvidersFailedError([
      { provider: 'kimi', error: new Error('quota exceeded') },
      { provider: 'openai', error: new LLMNetworkError('openai', new Error('ECONNRESET')) },
    ]);
    expect(classifyLLMError(err)).toBe('transient');
  });

  it('LLMAllProvidersFailedError [quota, rate_limit] → rate_limit（Retry-After 驱动优先）', () => {
    const err = new LLMAllProvidersFailedError([
      { provider: 'kimi', error: new Error('quota exceeded') },
      { provider: 'openai', error: new LLMRateLimitError('openai') },
    ]);
    expect(classifyLLMError(err)).toBe('rate_limit');
  });

  it('LLMAllProvidersFailedError [permanent, quota] → quota（quota 优先于 permanent）', () => {
    const err = new LLMAllProvidersFailedError([
      { provider: 'openai', error: new LLMInvalidRequestError('openai', 'invalid_unicode') },
      { provider: 'kimi', error: new Error('quota exceeded') },
    ]);
    expect(classifyLLMError(err)).toBe('quota');
  });
});
