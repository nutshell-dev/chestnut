import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LLMRateLimitError } from '../../../src/foundation/llm-provider/index.js';
import * as orchestratorBarrel from '../../../src/foundation/llm-orchestrator/index.js';
import * as orchestratorErrors from '../../../src/foundation/llm-orchestrator/errors.js';

const sources = [
  '../../../src/foundation/llm-orchestrator/orchestrator.ts',
  '../../../src/core/event-loop/event-loop.ts',
  '../../../tests/foundation/llm-orchestrator/hedge.test.ts',
  '../../../tests/core/event-loop/event-loop.test.ts',
  '../../../tests/foundation/llm.test.ts',
].map(path => readFileSync(new URL(path, import.meta.url), 'utf8'));
const sdkSource = readFileSync(new URL('../../../src/index.ts', import.meta.url), 'utf8');

describe('LLMRateLimitError owner boundary', () => {
  it('is owner-only and all class callers depend on LLMProvider', () => {
    expect('LLMRateLimitError' in orchestratorBarrel).toBe(false);
    expect('LLMRateLimitError' in orchestratorErrors).toBe(false);
    for (const source of sources) {
      expect(source).toMatch(/import\s*\{[^}]*LLMRateLimitError[^}]*\}\s*from\s*['"][^'"]*llm-provider\/(?:index|errors)\.js['"]/s);
    }
  });

  it('keeps classification, hint, retry-after extraction and SDK aggregation', () => {
    const withRetryAfter = new LLMRateLimitError('p', 42);
    expect(orchestratorErrors.classifyLLMError(withRetryAfter)).toBe('rate_limit');
    expect(orchestratorErrors.getUserActionHint(withRetryAfter)).toBe('wait_retry_after');
    expect(orchestratorErrors.getRetryAfterSec(withRetryAfter)).toBe(42);
    expect(orchestratorErrors.getRetryAfterSec(new LLMRateLimitError('p'))).toBeUndefined();
    expect(sdkSource).toMatch(/export\s*\{[^}]*LLMRateLimitError[^}]*\}\s*from\s*['"]\.\/foundation\/llm-provider\/index\.js['"]/s);
  });
});
