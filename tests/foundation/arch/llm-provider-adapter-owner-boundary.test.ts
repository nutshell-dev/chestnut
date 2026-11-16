import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const orchestratorTypes = read('../../../src/foundation/llm-orchestrator/types.ts');
const orchestratorRuntime = read('../../../src/foundation/llm-orchestrator/provider-runtime.ts');
const providerBarrel = read('../../../src/foundation/llm-provider/index.ts');
const providerCallFacade = read('../../../src/foundation/llm-provider/capabilities/call.ts');
const fixtures = [
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
].map(read);

describe('ProviderFactory owner boundary', () => {
  it('keeps adapter construction behind the L1 connection factory capability', () => {
    expect(providerBarrel).toMatch(/export \* as llmProviderCall from '\.\/capabilities\/call\.js';/);
    expect(providerCallFacade).toMatch(/\bProviderFactory\b/);
    expect(providerCallFacade).toMatch(/\bcreateProviderFromConnection\b/);
    expect(orchestratorTypes).toMatch(/providerFactory:\s*ProviderFactory/);
    expect(orchestratorRuntime).toMatch(/this\.providerFactory\.create\(connection\)/);
    expect(orchestratorRuntime).not.toMatch(/\bcreateLLMProvider\b/);
  });

  it('uses connection-based DI in orchestration fixtures', () => {
    for (const fixture of fixtures) {
      expect(fixture).not.toMatch(/\bcreateProviderAdapter\b/);
      expect(fixture).not.toMatch(/\bProviderConfig\b/);
    }
  });
});
