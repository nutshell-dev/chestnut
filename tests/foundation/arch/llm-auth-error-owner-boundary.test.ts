import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LLMAuthError } from '../../../src/foundation/llm-provider/index.js';
import * as orchestratorBarrel from '../../../src/foundation/llm-orchestrator/index.js';
import * as orchestratorErrors from '../../../src/foundation/llm-orchestrator/errors.js';

// Phase 1826: EventLoop 不再消费 LLMAuthError（provider 类阻断归 LLMOrchestrator owner）。
const sources = [
  '../../../tests/foundation/llm-orchestrator/hedge.test.ts',
  '../../../tests/foundation/llm-orchestrator/orchestrator-misc-invariants.test.ts',
].map(path => readFileSync(new URL(path, import.meta.url), 'utf8'));
const sdkSource = readFileSync(new URL('../../../src/index.ts', import.meta.url), 'utf8');

describe('LLMAuthError owner boundary', () => {
  it('is owner-only and all class callers depend on LLMProvider', () => {
    expect('LLMAuthError' in orchestratorBarrel).toBe(false);
    expect('LLMAuthError' in orchestratorErrors).toBe(false);
    for (const source of sources) {
      expect(source).toMatch(/import\s*\{[^}]*LLMAuthError[^}]*\}\s*from\s*['"][^'"]*llm-provider\/(?:index|errors)\.js['"]/s);
    }
  });

  it('keeps classification/hints and SDK owner aggregation', () => {
    expect(orchestratorErrors.classifyLLMError(new LLMAuthError('p', 401))).toBe('permanent');
    expect(orchestratorErrors.getUserActionHint(new LLMAuthError('p', 401))).toBe('rotate_api_key');
    expect(orchestratorErrors.getUserActionHint(new LLMAuthError('p', 401, 'insufficient credits'))).toBe('check_quota');
    expect(sdkSource).toMatch(/export\s*\{[^}]*LLMAuthError[^}]*\}\s*from\s*['"]\.\/foundation\/llm-provider\/index\.js['"]/s);
  });
});
