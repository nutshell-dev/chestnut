import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const orchestratorTypes = readFileSync(new URL('../../../src/foundation/llm-orchestrator/types.ts', import.meta.url), 'utf8');
const providerBarrel = readFileSync(new URL('../../../src/foundation/llm-provider/index.ts', import.meta.url), 'utf8');
const callers = [
  '../../../src/foundation/llm-orchestrator/orchestrator.ts',
  '../../../tests/foundation/llm-service.test.ts',
  '../../../tests/foundation/llm-orchestrator/hedge.test.ts',
  '../../../tests/foundation/llm-orchestrator/orchestrator.test.ts',
  '../../../tests/foundation/llm-orchestrator/sdk-cache-invariants.test.ts',
  '../../../tests/foundation/llm-orchestrator/hedge-cleanup-invariants.test.ts',
  '../../../tests/foundation/llm-orchestrator/hedge-state-machine-cluster.test.ts',
  '../../../tests/foundation/llm-orchestrator/stream-idle-probe.test.ts',
  '../../../tests/foundation/llm-orchestrator/orchestrator-misc-invariants.test.ts',
  '../../../tests/foundation/llm-orchestrator/hedge-primary-success-race-lost.test.ts',
  '../../../tests/foundation/llm-orchestrator/getProviderInfo-current-streaming.test.ts',
  '../../../tests/core/integration/context-manager-orchestrator-failover.test.ts',
].map(path => readFileSync(new URL(path, import.meta.url), 'utf8'));

describe('ProviderAdapter owner boundary', () => {
  it('is exported only by LLMProvider and all external callers use owner', () => {
    expect(providerBarrel).toMatch(/export\s+type\s*\{[^}]*\bProviderAdapter\b[^}]*\}\s*from\s*['"]\.\/types\.js['"]/s);
    expect(orchestratorTypes).not.toMatch(/export\s+type\s*\{[^}]*\bProviderAdapter\b[^}]*\}/s);
    for (const caller of callers) {
      expect(caller).toMatch(/import\s+(?:type\s*)?\{[^}]*\bProviderAdapter\b[^}]*\}\s*from\s*['"][^'"]*llm-provider\/(?:index|types)\.js['"]/s);
    }
  });

  it('keeps the internal owner import and adapter factory DI', () => {
    expect(orchestratorTypes).toMatch(/import\s+type\s*\{[^}]*\bProviderAdapter\b[^}]*\}\s*from\s*['"]\.\.\/llm-provider\/index\.js['"]/s);
    expect(orchestratorTypes).toMatch(/createAnthropicAdapter\?:\s*\(config:\s*ProviderConfig\)\s*=>\s*ProviderAdapter/);
  });
});
