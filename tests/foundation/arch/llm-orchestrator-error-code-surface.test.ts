import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const errorsSource = readFileSync(
  new URL('../../../src/foundation/llm-orchestrator/errors.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/llm-orchestrator/index.ts', import.meta.url),
  'utf8',
);

describe('LLMOrchestrator OrchestratorErrorCode deep surface', () => {
  it('keeps the all-providers-failed code type local behind the error class', () => {
    expect(errorsSource).not.toMatch(/export\s+type\s+OrchestratorErrorCode\b/);
    expect(errorsSource).toMatch(
      /(?:^|\n)type\s+OrchestratorErrorCode\s*=\s*'LLM_ALL_PROVIDERS_FAILED';/,
    );
    expect(errorsSource).toMatch(
      /readonly\s+code:\s*OrchestratorErrorCode\s*=\s*'LLM_ALL_PROVIDERS_FAILED';/,
    );
    expect(errorsSource).toMatch(
      /export\s+class\s+LLMAllProvidersFailedError\s+extends\s+Error\s*\{/,
    );
    expect(barrelSource).toMatch(
      /export\s*\{[^}]*\bLLMAllProvidersFailedError\b[^}]*\}\s*from\s*'\.\/errors\.js';/,
    );
    expect(barrelSource).not.toMatch(/\bOrchestratorErrorCode\b/);
  });
});
