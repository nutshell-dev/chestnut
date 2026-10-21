import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const helpersSource = readFileSync(
  new URL('../../../src/foundation/llm-provider/_helpers.ts', import.meta.url),
  'utf8',
);
const piAiErrorsSource = readFileSync(
  // phase 1964 Step C：实现拆至 pi-ai-classify.ts（pi-ai-errors.ts 为 facade）
  new URL('../../../src/foundation/llm-provider/pi-ai-classify.ts', import.meta.url),
  'utf8',
);
const piAiSupportSource = readFileSync(
  // phase 1964 Step B：实现拆至 pi-ai-runtime.ts（pi-ai-support.ts 为 facade）
  new URL('../../../src/foundation/llm-provider/pi-ai-runtime.ts', import.meta.url),
  'utf8',
);

describe('LLMProvider context-exceeded predicate surface', () => {
  it('uses the upstream pi-ai predicate instead of a local pattern list', () => {
    expect(piAiSupportSource).toMatch(/isContextOverflow\s*:\s*typeof\s+PiAi\.isContextOverflow/);
    expect(piAiSupportSource).toMatch(/isContextOverflow:\s*main\.isContextOverflow/);
    expect(piAiErrorsSource).toMatch(/isContextOverflow/);
    expect(piAiErrorsSource).toMatch(/classifyCapturedHttpError/);
    expect(piAiErrorsSource).not.toMatch(/TEXT_CONTEXT_RE|CONTEXT_EXCEEDED_PATTERNS/);
  });

  it('keeps _helpers as a status mapper without local context text matching', () => {
    expect(helpersSource).not.toMatch(/CONTEXT_EXCEEDED_PATTERNS|isContextExceededMessage/);
    expect(helpersSource).not.toMatch(/status\s*===\s*400\s*&&\s*isContextExceededMessage/);
    expect(helpersSource).toMatch(/status\s*===\s*413/);
  });

  it('does not lock the upstream pattern count (no toHaveLength(7))', () => {
    expect(helpersSource).not.toMatch(/toHaveLength\(7\)/);
    expect(piAiErrorsSource).not.toMatch(/toHaveLength\(7\)/);
  });
});
