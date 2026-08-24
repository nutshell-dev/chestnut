import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LLMNetworkError } from '../../../src/foundation/llm-provider/index.js';
import * as orchestratorBarrel from '../../../src/foundation/llm-orchestrator/index.js';
import * as orchestratorErrors from '../../../src/foundation/llm-orchestrator/errors.js';

const sources = [
  '../../../tests/foundation/llm-orchestrator/hedge.test.ts',
  '../../../tests/foundation/llm-orchestrator/orchestrator.test.ts',
  '../../../tests/foundation/llm-orchestrator/hedge-cleanup-invariants.test.ts',
  '../../../tests/foundation/llm-orchestrator/hedge-state-machine-cluster.test.ts',
  '../../../tests/foundation/llm-orchestrator/orchestrator-misc-invariants.test.ts',
  '../../../tests/foundation/llm-orchestrator/hedge-primary-success-race-lost.test.ts',
].map(path => readFileSync(new URL(path, import.meta.url), 'utf8'));
const sdkSource = readFileSync(new URL('../../../src/index.ts', import.meta.url), 'utf8');

describe('LLMNetworkError owner boundary', () => {
  it('is owner-only and all class callers depend on LLMProvider', () => {
    expect('LLMNetworkError' in orchestratorBarrel).toBe(false);
    expect('LLMNetworkError' in orchestratorErrors).toBe(false);
    for (const source of sources) {
      expect(source).toMatch(/import\s*\{[^}]*LLMNetworkError[^}]*\}\s*from\s*['"][^'"]*llm-provider\/(?:index|errors)\.js['"]/s);
    }
  });

  it('keeps classification/hint and SDK owner aggregation', () => {
    const error = new LLMNetworkError('p', new Error('ECONNREFUSED'));
    expect(orchestratorErrors.classifyLLMError(error)).toBe('transient');
    expect(orchestratorErrors.getUserActionHint(error)).toBe('check_network');
    expect(sdkSource).toMatch(/export\s*\{[^}]*LLMNetworkError[^}]*\}\s*from\s*['"]\.\/foundation\/llm-provider\/index\.js['"]/s);
  });
});
