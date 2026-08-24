import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const helpersSource = readFileSync(
  new URL('../../../src/foundation/llm-provider/_helpers.ts', import.meta.url),
  'utf8',
);
const behaviorTestSource = readFileSync(
  new URL('../llm-provider/helpers-invariants.test.ts', import.meta.url),
  'utf8',
);

describe('LLMProvider context-exceeded predicate surface', () => {
  it('keeps the predicate local and tests patterns through the owner classifier', () => {
    expect(helpersSource).not.toMatch(/export\s+function\s+isContextExceededMessage\b/);
    expect(helpersSource).toMatch(/function\s+isContextExceededMessage\s*\(text:\s*string\)\s*:\s*boolean/);
    expect(helpersSource).toMatch(/status\s*===\s*400\s*&&\s*isContextExceededMessage\(resolvedErrorText\)/);
    expect(helpersSource.match(/^\s*\/.*\/i,?$/gm)).toHaveLength(7);
    expect(behaviorTestSource).not.toMatch(/\bisContextExceededMessage\b/);
    expect(behaviorTestSource).toMatch(/throwHttpErrorResponse/);
  });
});
