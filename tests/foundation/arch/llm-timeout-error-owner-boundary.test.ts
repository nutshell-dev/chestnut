import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LLMTimeoutError } from '../../../src/foundation/llm-provider/index.js';
import * as orchestratorBarrel from '../../../src/foundation/llm-orchestrator/index.js';
import * as orchestratorErrors from '../../../src/foundation/llm-orchestrator/errors.js';

const sources = [
  '../../../src/foundation/llm-orchestrator/orchestrator.ts',
  '../../../src/core/step-executor/llm-stream-collector.ts',
  '../../../tests/foundation/llm/abort-helper.test.ts',
  '../../../tests/foundation/llm-service.test.ts',
  '../../../tests/foundation/llm.test.ts',
  '../../../tests/core/step-executor/llm-stream-collector-invariants.test.ts',
].map(path => readFileSync(new URL(path, import.meta.url), 'utf8'));
const sdkSource = readFileSync(new URL('../../../src/index.ts', import.meta.url), 'utf8');

describe('LLMTimeoutError owner boundary', () => {
  it('is owner-only and all class callers depend on LLMProvider', () => {
    expect('LLMTimeoutError' in orchestratorBarrel).toBe(false);
    expect('LLMTimeoutError' in orchestratorErrors).toBe(false);
    for (const source of sources) {
      expect(source).toMatch(/import\s*\{[^}]*LLMTimeoutError[^}]*\}\s*from\s*['"][^'"]*llm-provider\/(?:index|errors)\.js['"]/s);
    }
  });

  it('keeps field, classification, hint and SDK owner aggregation', () => {
    const error = new LLMTimeoutError('p', 60_000);
    expect(error.timeoutMs).toBe(60_000);
    expect(orchestratorErrors.classifyLLMError(error)).toBe('transient');
    expect(orchestratorErrors.getUserActionHint(error)).toBe('check_endpoint');
    expect(sdkSource).toMatch(/export\s*\{[^}]*LLMTimeoutError[^}]*\}\s*from\s*['"]\.\/foundation\/llm-provider\/index\.js['"]/s);
  });
});
