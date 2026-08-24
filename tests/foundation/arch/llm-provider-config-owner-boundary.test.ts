import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const providerBarrel = read('../../../src/foundation/llm-provider/index.ts');
const orchestratorTypes = read('../../../src/foundation/llm-orchestrator/types.ts');
const orchestratorBarrel = read('../../../src/foundation/llm-orchestrator/index.ts');
const sdkBarrel = read('../../../src/index.ts');
const callers = [
  '../../../src/foundation/llm-orchestrator/orchestrator.ts',
  '../../../tests/core/integration/context-manager-orchestrator-failover.test.ts',
  '../../../tests/foundation/llm-orchestrator/hedge-cleanup-invariants.test.ts',
  '../../../tests/foundation/llm-orchestrator/hedge-primary-success-race-lost.test.ts',
  '../../../tests/foundation/llm-orchestrator/hedge-state-machine-cluster.test.ts',
  '../../../tests/foundation/llm-orchestrator/hedge.test.ts',
  '../../../tests/foundation/llm-orchestrator/orchestrator-misc-invariants.test.ts',
  '../../../tests/foundation/llm-orchestrator/orchestrator.test.ts',
].map(read);

describe('ProviderConfig owner boundary', () => {
  it('removes Orchestrator forwarding while SDK directly aggregates owner', () => {
    expect(providerBarrel).toMatch(/export\s+type\s*\{[^}]*\bProviderConfig\b[^}]*\}\s*from\s*['"]\.\/types\.js['"]/s);
    expect(orchestratorTypes).not.toMatch(/export\s+type\s+ProviderConfig\s*=/);
    expect(orchestratorBarrel).not.toMatch(/export\s+type\s*\{[^}]*\bProviderConfig\b[^}]*\}\s*from\s*['"]\.\/types\.js['"]/s);
    expect(sdkBarrel).toMatch(/export\s+type\s*\{[^}]*\bProviderConfig\b[^}]*\}\s*from\s*['"]\.\/foundation\/llm-provider\/index\.js['"]/s);
    expect(sdkBarrel).not.toMatch(/export\s+type\s*\{[^}]*\bProviderConfig\b[^}]*\}\s*from\s*['"]\.\/foundation\/llm-orchestrator\/index\.js['"]/s);
    for (const caller of callers) {
      expect(caller).toMatch(/import\s+(?:type\s*)?\{[^}]*\bProviderConfig\b[^}]*\}\s*from\s*['"][^'"]*llm-provider\/(?:index|types)\.js['"]/s);
    }
  });

  it('keeps Orchestrator internal owner use and config signatures', () => {
    expect(orchestratorTypes).toMatch(/import\s+type\s*\{[^}]*\bProviderConfig\b[^}]*\}\s*from\s*['"]\.\.\/llm-provider\/index\.js['"]/s);
    expect(orchestratorTypes).toMatch(/primary:\s*ProviderConfig/);
    expect(orchestratorTypes).toMatch(/fallbacks\?:\s*ProviderConfig\[\]/);
    expect(orchestratorTypes).toMatch(/createAnthropicAdapter\?:\s*\(config:\s*ProviderConfig\)\s*=>\s*ProviderAdapter/);
  });
});
