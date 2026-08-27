import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const configSchemaSource = readFileSync(
  new URL('../../../src/foundation/llm-orchestrator/config-schema.ts', import.meta.url),
  'utf8',
);

describe('LLMOrchestrator LLMOrchestratorConfigShape dead surface', () => {
  it('does not retain the zero-caller inferred config type', () => {
    expect(configSchemaSource).not.toMatch(/\bLLMOrchestratorConfigShape\b/);
  });
});
