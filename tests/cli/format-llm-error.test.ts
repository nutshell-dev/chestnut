/**
 * Phase 451 Step B — formatLLMError display template invariant tests.
 * Phase 515: 缩进归一（结果行顶格、字段缩进 2）。
 */

import { describe, it, expect } from 'vitest';

const { formatLLMError, LLM_ERROR_LABELS } = await import('../../src/cli/llm-connection-check.js');

describe('formatLLMError', () => {
  it('includes label, provider, message and hint when all provided', () => {
    const lines = formatLLMError({
      errorType: 'model',
      message: 'model not found',
      provider: 'anthropic',
      hint: 'Check that model name matches provider docs exactly.',
    });

    expect(lines).toEqual([
      `✗ ${LLM_ERROR_LABELS.model}`,
      '  Provider: anthropic',
      '  model not found',
      '  Hint: Check that model name matches provider docs exactly.',
    ]);
  });

  it('omits provider and hint lines when missing', () => {
    const lines = formatLLMError({
      errorType: 'auth',
      message: '401 Unauthorized',
    });

    expect(lines).toEqual([
      `✗ ${LLM_ERROR_LABELS.auth}`,
      '  401 Unauthorized',
    ]);
    expect(lines.some(l => l.includes('Provider:'))).toBe(false);
    expect(lines.some(l => l.includes('Hint:'))).toBe(false);
  });

  it('truncates message longer than 200 chars with ellipsis', () => {
    const longMessage = 'X'.repeat(250);
    const lines = formatLLMError({
      errorType: 'network',
      message: longMessage,
    });

    const messageLine = lines.find(l => l.startsWith('  '))!;
    expect(messageLine).toBe(`  ${'X'.repeat(200)}...`);
  });

  it('does not truncate message at exactly 200 chars', () => {
    const exact = 'Y'.repeat(200);
    const lines = formatLLMError({
      errorType: 'unknown',
      message: exact,
    });

    const messageLine = lines.find(l => l.startsWith('  '))!;
    expect(messageLine).toBe(`  ${exact}`);
    expect(messageLine).not.toContain('...');
  });

  it('capitalizes are not mutated; hint is passed through as-is', () => {
    const lines = formatLLMError({
      errorType: 'rate_limit',
      message: '429',
      hint: 'Wait a few seconds.',
    });

    expect(lines).toContain('  Hint: Wait a few seconds.');
  });
});
