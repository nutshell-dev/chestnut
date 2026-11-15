import { describe, expect, it } from 'vitest';
import {
  LLMEmptyResponseError,
  LLMNetworkError,
  LLMQuotaError,
} from '../../../src/foundation/llm-provider/errors.js';
import {
  LLMAllProvidersFailedError,
  classifyLLMError,
} from '../../../src/foundation/llm-orchestrator/errors.js';

describe('LLMAllProvidersFailedError structured evidence', () => {
  it('按候选顺序保留 family、typed code、身份、序位、localSkip 和原始 Error', () => {
    const networkCause = new Error('ECONNRESET');
    const network = new LLMNetworkError('openai', networkCause);
    const quota = new LLMQuotaError('kimi', 'quota exceeded', { retryAfter: 12, resetAtMs: 1234 });
    const aggregate = new LLMAllProvidersFailedError([
      { provider: 'openai', providerId: 'provider-a', attemptIndex: 2, error: network },
      { provider: 'kimi', providerId: 'provider-b', attemptIndex: 3, localSkip: false, error: quota },
    ]);

    expect(aggregate.failures[0]?.error).toBe(network);
    expect(aggregate.evidence).toMatchObject([
      {
        family: 'transient', provider: 'openai', providerId: 'provider-a', attemptIndex: 2,
        errorCode: 'LLM_NETWORK_FAILED',
        cause: { code: 'LLM_NETWORK_FAILED', cause: { message: 'ECONNRESET' } },
      },
      {
        family: 'quota', provider: 'kimi', providerId: 'provider-b', attemptIndex: 3,
        localSkip: false, errorCode: 'LLM_QUOTA_EXCEEDED',
        cause: { retryAfter: 12, resetAtMs: 1234 },
      },
    ]);
    expect(JSON.parse(JSON.stringify(aggregate))).toMatchObject({
      code: 'LLM_ALL_PROVIDERS_FAILED', evidenceVersion: 1, evidenceComplete: true,
      failures: aggregate.evidence,
    });
  });

  it('消费 orchestrator 已决定的 errorClass，不在聚合或恢复前重分类', () => {
    const aggregate = new LLMAllProvidersFailedError([{
      provider: 'anthropic',
      error: new LLMEmptyResponseError('anthropic'),
      errorClass: 'unknown',
    }]);
    expect(aggregate.evidence[0]?.family).toBe('unknown');
    expect(classifyLLMError(aggregate)).toBe('unknown');
  });

  it('嵌套 aggregate 保留子候选证据', () => {
    const nested = new LLMAllProvidersFailedError([{
      provider: 'openai', providerId: 'nested-a', error: new LLMNetworkError('openai'),
    }]);
    const outer = new LLMAllProvidersFailedError([{ provider: 'aggregate', error: nested }]);
    expect(outer.evidence[0]).toMatchObject({
      family: 'transient',
      errorCode: 'LLM_ALL_PROVIDERS_FAILED',
      cause: { failures: [{ provider: 'openai', providerId: 'nested-a', errorCode: 'LLM_NETWORK_FAILED' }] },
    });
  });

  it('cause 有界且 redact 常见 secret，不展开对象 cause', () => {
    const secret = 'sk-super-secret-value-123456';
    const cause = new Error(`Authorization: Bearer ${secret}`, {
      cause: { apiKey: secret, token: 'oauth-secret' },
    });
    const aggregate = new LLMAllProvidersFailedError([{
      provider: 'openai', error: new LLMNetworkError('openai', cause),
    }]);
    const serialized = JSON.stringify(aggregate.toJSON());
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('oauth-secret');
    expect(serialized).toContain('<redacted>');
    expect(serialized).toContain('NonErrorCause');
  });

  it.each([
    'ghp_abcdefghijklmnopqrstuvwxyz1234567890',
    'AIzaabcdefghijklmnopqrstuvwxyz1234567890',
  ])('整个 toJSON 不泄露常见 provider token：%s', (secret) => {
    const aggregate = new LLMAllProvidersFailedError([{
      provider: 'provider',
      error: new LLMNetworkError('provider', new Error(`401 Unauthorized: ${secret}`)),
    }]);
    expect(JSON.stringify(aggregate.toJSON())).not.toContain(secret);
  });

  it('JSON credential 字段在整个 toJSON 中 redact', () => {
    const aggregate = new LLMAllProvidersFailedError([{
      provider: 'provider', error: new Error('{"access_token":"opaque-secret-value"}'),
    }]);
    expect(JSON.stringify(aggregate.toJSON())).not.toContain('opaque-secret-value');
  });

  it('缺候选身份或 cause 降级时显式 incomplete', () => {
    const aggregate = new LLMAllProvidersFailedError([{
      provider: 'provider', error: new Error('failed', { cause: { token: 'not-expanded' } }),
    }]);
    expect(aggregate.toJSON().evidenceComplete).toBe(false);
    aggregate.cause = { accessToken: 'not-expanded' };
    expect(aggregate.toJSON().evidenceComplete).toBe(false);
  });

  it('诱导性普通 Error 文本不会伪造 typed family 或 errorCode', () => {
    const aggregate = new LLMAllProvidersFailedError([{
      provider: 'unknown', error: new Error('quota exceeded; context length exceeded; unauthorized'),
    }]);
    expect(aggregate.evidence[0]).toMatchObject({ family: 'unknown' });
    expect(aggregate.evidence[0]?.errorCode).toBeUndefined();
  });
});
