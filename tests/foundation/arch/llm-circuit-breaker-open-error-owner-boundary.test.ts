import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LLMCircuitBreakerOpenError } from '../../../src/foundation/llm-provider/index.js';
import * as orchestratorErrors from '../../../src/foundation/llm-orchestrator/errors.js';

const orchestratorSource = readFileSync(
  new URL('../../../src/foundation/llm-orchestrator/orchestrator.ts', import.meta.url),
  'utf8',
);

describe('LLMCircuitBreakerOpenError owner boundary', () => {
  it('is owned by LLMProvider and absent from the Orchestrator deep surface', () => {
    const error = new LLMCircuitBreakerOpenError('test-provider');
    expect(error.code).toBe('LLM_CIRCUIT_BREAKER_OPEN');
    expect('LLMCircuitBreakerOpenError' in orchestratorErrors).toBe(false);
  });

  it('is consumed directly from the owner barrel by the Orchestrator implementation', () => {
    expect(orchestratorSource).toMatch(
      /import\s*\{[^}]*LLMCircuitBreakerOpenError[^}]*\}\s*from\s*['"]\.\.\/llm-provider\/index\.js['"]/s,
    );
    expect(orchestratorSource).not.toMatch(
      /import\s*\{[^}]*LLMCircuitBreakerOpenError[^}]*\}\s*from\s*['"]\.\/errors\.js['"]/s,
    );
  });
});
