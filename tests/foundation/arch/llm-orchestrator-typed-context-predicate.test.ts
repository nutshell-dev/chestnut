import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const errorsSource = readFileSync(
  new URL('../../../src/foundation/llm-orchestrator/errors.ts', import.meta.url),
  'utf8',
);

describe('LLMOrchestrator context predicate surface（Phase 1960）', () => {
  it('L2b 不重复解析 provider 文本', () => {
    expect(errorsSource).not.toMatch(/maximum context length/i);
    expect(errorsSource).not.toMatch(/prompt is too long/i);
    expect(errorsSource).not.toMatch(/reduce the length of/i);
    expect(errorsSource).not.toMatch(/context\.\{0,30\}/);
    expect(errorsSource).not.toMatch(/CONTEXT_EXCEEDED_PATTERNS|TEXT_CONTEXT_RE/);
  });

  it('isContextExceededError 只消费 typed evidence 并递归聚合', () => {
    expect(errorsSource).toMatch(/err instanceof LLMContextExceededError/);
    expect(errorsSource).toMatch(/err instanceof LLMOutputBudgetExceededError/);
    expect(errorsSource).toMatch(/err instanceof LLMAllProvidersFailedError/);
    expect(errorsSource).toMatch(/failures\.some\(/);
    expect(errorsSource).toMatch(/isContextExceededError\(failure\.error\)/);
  });
});
