import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const providerBarrel = read('../../../src/foundation/llm-provider/index.ts');
const providerConfigFacade = read('../../../src/foundation/llm-provider/capabilities/config-contract.ts');
const orchestratorTypes = read('../../../src/foundation/llm-orchestrator/types.ts');
const orchestratorRuntime = read('../../../src/foundation/llm-orchestrator/provider-runtime.ts');
const orchestratorBarrel = read('../../../src/foundation/llm-orchestrator/index.ts');
const sdkBarrel = read('../../../src/index.ts');
const ordinaryCallers = [
  '../../../src/core/runtime/runtime.ts',
  '../../../src/assembly/core-infrastructure.ts',
  '../../../src/cli/llm-connection-check.ts',
].map(read);

describe('ProviderConnection owner boundary', () => {
  it('exports neutral connection contracts without exposing legacy config at the root', () => {
    expect(providerBarrel).toMatch(/export \* as llmProviderCall from '\.\/capabilities\/call\.js';/);
    expect(providerConfigFacade).toMatch(/toProviderConnection/);
    expect(sdkBarrel).toMatch(/\bProviderConnection\b/);
    expect(sdkBarrel).toMatch(/\bProviderFactory\b/);
    expect(sdkBarrel).not.toMatch(/\bProviderConfig\b/);
    expect(orchestratorBarrel).not.toMatch(/\bProviderConfig\b/);
  });

  it('keeps legacy config and credential runtime out of the L2 public config', () => {
    expect(orchestratorTypes).toMatch(/primary:\s*ProviderConnection/);
    expect(orchestratorTypes).toMatch(/fallbacks\?:\s*ProviderConnection\[\]/);
    expect(orchestratorTypes).toMatch(/providerFactory:\s*ProviderFactory/);
    for (const source of [orchestratorTypes, orchestratorRuntime]) {
      expect(source).not.toMatch(/\bProviderConfig\b/);
      expect(source).not.toMatch(/\bcredentialStore\b/);
      expect(source).not.toMatch(/\bcreateProviderAdapter\b/);
      expect(source).not.toMatch(/\bcreateLLMProvider\s*\(/);
    }
  });

  it('prevents ordinary callers from reconstructing legacy provider configs', () => {
    for (const caller of ordinaryCallers) {
      expect(caller).not.toMatch(/\bProviderConfig\b/);
      expect(caller).not.toMatch(/\btoProviderConfig\b/);
      expect(caller).not.toMatch(/\bcreateLLMProvider\s*\(/);
    }
  });
});
