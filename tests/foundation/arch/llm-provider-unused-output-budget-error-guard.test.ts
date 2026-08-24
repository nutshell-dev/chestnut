import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const helpersSource = readFileSync(
  new URL('../../../src/foundation/llm-provider/_helpers.ts', import.meta.url),
  'utf8',
);
const errorsSource = readFileSync(
  new URL('../../../src/foundation/llm-provider/errors.ts', import.meta.url),
  'utf8',
);

describe('LLMProvider unused output budget error guard surface', () => {
  it('has no dead type guard while retaining the error class and parser', () => {
    expect(helpersSource).not.toMatch(/\bisOutputBudgetExceededError\b/);
    expect(helpersSource).not.toMatch(/import[^;]*\bLLMOutputBudgetExceededError\b[^;]*from\s+['"]\.\/errors\.js['"]/);
    expect(helpersSource).toMatch(/export\s+function\s+parseOutputBudgetError\s*\(/);
    expect(errorsSource).toMatch(/export\s+class\s+LLMOutputBudgetExceededError\s+extends\s+LLMError/);
  });
});
