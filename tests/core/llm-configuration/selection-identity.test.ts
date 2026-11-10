import { describe, it, expect } from 'vitest';
import {
  resolveLLMConfig,
  snapshotLLMConfig,
  snapshotLLMConfigInput,
  llmConfigIdentity,
  LLMConfigIdentityMismatchError,
} from '../../../src/core/llm-configuration/index.js';
import { createGlobalConfigSchema } from '../../../src/assembly/config/compose-config.js';

const input = {
  llm: {
    primary: { preset: 'anthropic', api_key: 'sk-fixed-primary', model: 'claude-fixed' },
    fallbacks: [{ preset: 'openai', api_key: 'sk-fixed-fallback', model: 'gpt-fixed' }],
    retry_attempts: 4,
    retry_delay_ms: 1234,
    circuit_breaker: { failure_threshold: 5, reset_timeout_ms: 120000 },
  },
} as const;

const override = {
  llm: { primary: { preset: 'openai', api_key: 'sk-fixed-override', model: 'gpt-override' } },
} as const;

// 由父提交 13493314d 的 Assembly 实现生成，证据见 step-c-parent-fixtures.log。
const BASE_IDENTITY = '5436cf1826518e5be082d43ffaad7c4239f1623693b98c4528511529dd7beaeb';
const OVERRIDE_IDENTITY = 'b89a90a3b2c3548b0b232f1c4ef5ae3057a303070b80d5d2f37c5091c7f52c69';

describe('LLMConfiguration selection / identity', () => {
  it('与父实现的固定配置及 claw 覆盖身份完全一致', () => {
    const global = createGlobalConfigSchema().parse(input);
    expect(snapshotLLMConfig(global).identity).toBe(BASE_IDENTITY);
    expect(snapshotLLMConfig(global, override).identity).toBe(OVERRIDE_IDENTITY);
  });

  it('claw 只覆盖 primary，不改变 global 备用顺序与重试/breaker', () => {
    const global = createGlobalConfigSchema().parse(input);
    const resolved = resolveLLMConfig(global, override);
    expect(resolved.primary.model).toBe('gpt-override');
    expect(resolved.fallbacks?.map(provider => provider.model)).toEqual(['gpt-fixed']);
    expect(resolved.maxAttempts).toBe(4);
    expect(resolved.retryDelayMs).toBe(1234);
    expect(resolved.circuitBreaker).toEqual({ failureThreshold: 5, resetTimeoutMs: 120000 });
  });

  it('draft 与磁盘同形配置身份一致，显式 breaker 与缺省段保持区分', () => {
    const fromInput = snapshotLLMConfigInput(input);
    const fromDisk = snapshotLLMConfig(createGlobalConfigSchema().parse(input));
    expect(fromInput.identity).toBe(BASE_IDENTITY);
    expect(fromInput.identity).toBe(fromDisk.identity);
    expect(fromInput.identity).toBe(llmConfigIdentity(fromInput.config));

    const withoutBreaker = snapshotLLMConfigInput({
      llm: { ...input.llm, circuit_breaker: undefined },
    });
    expect(withoutBreaker.config.circuitBreaker).toBeUndefined();
    expect(withoutBreaker.identity).not.toBe(BASE_IDENTITY);
  });

  it('同 endpoint 不同 key 身份不同，mismatch 保留 typed 摘要证据', () => {
    const first = snapshotLLMConfigInput(input);
    const second = snapshotLLMConfigInput({
      llm: { ...input.llm, primary: { ...input.llm.primary, api_key: 'sk-fixed-other' } },
    });
    expect(second.identity).not.toBe(first.identity);
    const error = new LLMConfigIdentityMismatchError(first.identity, second.identity);
    expect(error.expected).toBe(first.identity);
    expect(error.actual).toBe(second.identity);
    expect(error.message).toContain(first.identity.slice(0, 12));
  });
});
