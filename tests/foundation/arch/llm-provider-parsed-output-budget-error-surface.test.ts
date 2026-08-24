import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const helpersSource = readFileSync(
  new URL('../../../src/foundation/llm-provider/_helpers.ts', import.meta.url),
  'utf8',
);

describe('LLMProvider parsed output budget error surface', () => {
  it('keeps the parsed result interface local while preserving the parser contract', () => {
    expect(helpersSource).not.toMatch(/export\s+interface\s+ParsedOutputBudgetError\b/);
    expect(helpersSource).toMatch(/interface\s+ParsedOutputBudgetError\s*\{[\s\S]*?contextLimit:\s*number;[\s\S]*?inputTokens:\s*number;[\s\S]*?requestedMaxTokens:\s*number;[\s\S]*?\}/);
    expect(helpersSource).toMatch(/export\s+function\s+parseOutputBudgetError\s*\(message:\s*string\)\s*:\s*ParsedOutputBudgetError\s*\|\s*null/);
  });
});
