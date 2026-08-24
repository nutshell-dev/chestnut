import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LLMError } from '../../../src/foundation/llm-provider/index.js';
import * as orchestratorBarrel from '../../../src/foundation/llm-orchestrator/index.js';
import * as orchestratorErrors from '../../../src/foundation/llm-orchestrator/errors.js';

const sources = [
  '../../../src/foundation/llm-orchestrator/orchestrator.ts',
  '../../../tests/foundation/llm-service.test.ts',
].map(path => readFileSync(new URL(path, import.meta.url), 'utf8'));
const sdkSource = readFileSync(new URL('../../../src/index.ts', import.meta.url), 'utf8');

describe('LLMError base owner boundary', () => {
  it('is owner-only and both class callers depend on LLMProvider', () => {
    expect('LLMError' in orchestratorBarrel).toBe(false);
    expect('LLMError' in orchestratorErrors).toBe(false);
    for (const source of sources) {
      expect(source).toMatch(/import\s*(?:type\s*)?\{[^}]*LLMError[^}]*\}\s*from\s*['"][^'"]*llm-provider\/(?:index|errors)\.js['"]/s);
    }
  });

  it('keeps generic classification/hint and SDK owner aggregation', () => {
    const error = new LLMError('generic provider failure');
    expect(orchestratorErrors.classifyLLMError(error)).toBe('transient');
    expect(orchestratorErrors.getUserActionHint(error)).toBeNull();
    expect(sdkSource).toMatch(/export\s*\{[^}]*LLMError[^}]*\}\s*from\s*['"]\.\/foundation\/llm-provider\/index\.js['"]/s);
  });
});
