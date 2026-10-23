/**
 * Phase 1979: probe 预算统一（LLM_PROBE_MAX_TOKENS = 64）。
 *
 * - probeLLMConnection / checkLLMConnectionFor 经 mock orchestrator 断言 maxTokens；
 * - orchestrator._minimalProbe 为私有路径，以源文件断言常量使用（无第二套 1-token 预算）。
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderConfig } from '../../src/foundation/llm-provider/index.js';

const mocks = vi.hoisted(() => ({ call: vi.fn() }));

vi.mock('../../src/foundation/llm-orchestrator/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/llm-orchestrator/index.js')>();
  return {
    ...actual,
    createLLMOrchestrator: () => ({ call: mocks.call }),
  };
});

import { LLM_PROBE_MAX_TOKENS } from '../../src/foundation/llm-orchestrator/index.js';
import { checkLLMConnectionFor, classifyLLMError, probeLLMConnection } from '../../src/cli/llm-connection-check.js';

function providerConfig(): ProviderConfig {
  return {
    name: 'p',
    apiKey: 'k',
    model: 'm',
    temperature: 0.7,
    timeoutMs: 30_000,
    apiFormat: 'openai',
    baseUrl: 'https://api.test.invalid/v1',
  };
}

describe('Phase 1979 probe budget', () => {
  beforeEach(() => {
    mocks.call.mockReset().mockResolvedValue({ content: [], stop_reason: 'end_turn' });
  });

  it('LLM_PROBE_MAX_TOKENS = 64', () => {
    expect(LLM_PROBE_MAX_TOKENS).toBe(64);
  });

  it('probeLLMConnection 使用共享常量', async () => {
    await probeLLMConnection({
      config: { primary: providerConfig() },
      identity: 'id',
    } as unknown as Parameters<typeof probeLLMConnection>[0]);
    expect(mocks.call).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: LLM_PROBE_MAX_TOKENS }));
  });

  it('checkLLMConnectionFor 使用共享常量', async () => {
    await checkLLMConnectionFor(providerConfig());
    expect(mocks.call).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: LLM_PROBE_MAX_TOKENS }));
  });

  it('MiniMax 400 thinking 文案 → 分类 model（不是 auth）', () => {
    const err = new Error(
      'invalid params, model "MiniMax-M3.1-Flash" requires adaptive thinking; thinking.type="disabled" (2013)',
    );
    expect(classifyLLMError(err)).toBe('model');
  });

  it('orchestrator._minimalProbe 使用常量、无固定 1-token 预算', () => {
    const source = readFileSync(
      new URL('../../src/foundation/llm-orchestrator/orchestrator.ts', import.meta.url),
      'utf8',
    );
    expect(source).toMatch(/maxTokens:\s*LLM_PROBE_MAX_TOKENS/);
    expect(source).not.toMatch(/maxTokens:\s*1\b/);
  });
});
