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
  it('keeps the orchestrator-owned code type local behind the error classes', () => {
    expect(errorsSource).not.toMatch(/export\s+type\s+OrchestratorErrorCode\b/);
    // phase 1722 F: breaker-open code 归 LLMOrchestrator，union 两名成员均由本模块自有类型约束
    expect(errorsSource).toMatch(
      /(?:^|\n)type\s+OrchestratorErrorCode\s*=\s*'LLM_ALL_PROVIDERS_FAILED'\s*\|\s*'LLM_CIRCUIT_BREAKER_OPEN';/,
    );
    expect(errorsSource).toMatch(
      /readonly\s+code:\s*OrchestratorErrorCode\s*=\s*'LLM_ALL_PROVIDERS_FAILED';/,
    );
    expect(errorsSource).toMatch(
      /readonly\s+code:\s*OrchestratorErrorCode\s*=\s*'LLM_CIRCUIT_BREAKER_OPEN';/,
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
