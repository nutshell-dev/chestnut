import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const configSchemaSource = readFileSync(
  new URL('../../../src/foundation/llm-orchestrator/config-schema.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/llm-orchestrator/index.ts', import.meta.url),
  'utf8',
);

describe('LLMOrchestrator circuitBreakerConfigSchema deep surface', () => {
  it('keeps the nested circuit breaker schema local behind the parent config schema', () => {
    expect(configSchemaSource).not.toMatch(/export\s+const\s+circuitBreakerConfigSchema\b/);
    expect(configSchemaSource).toMatch(
      /(?:^|\n)const\s+circuitBreakerConfigSchema\s*=\s*z\.object\(\{/,
    );
    expect(configSchemaSource).toMatch(
      /failure_threshold:\s*z\.number\(\)\.min\(1\)\.max\(20\)\.default\(3\),/,
    );
    expect(configSchemaSource).toMatch(
      /reset_timeout_ms:\s*z\.number\(\)\.min\(1000\)\.max\(3600000\)\.default\(DEFAULT_RESET_TIMEOUT_MS\),/,
    );
    expect(configSchemaSource).toMatch(
      /circuit_breaker:\s*circuitBreakerConfigSchema\.default\(\{\s*failure_threshold:\s*3,\s*reset_timeout_ms:\s*DEFAULT_RESET_TIMEOUT_MS,\s*\}\),/,
    );
    expect(barrelSource).toMatch(
      /export\s*\{[^}]*\bllmOrchestratorConfigSchema\b[^}]*\}\s*from\s*'\.\/config-schema\.js';/,
    );
    expect(barrelSource).not.toMatch(/\bcircuitBreakerConfigSchema\b/);
  });
});
