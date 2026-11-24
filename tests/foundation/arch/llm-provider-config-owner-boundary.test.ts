import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { auditProviderSource } from './llm-provider-capability-surface-helpers.js';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const providerBarrel = read('../../../src/foundation/llm-provider/index.ts');
const providerConfigFacade = read('../../../src/foundation/llm-provider/capabilities/config-contract.ts');
const identitySource = read('../../../src/core/llm-configuration/identity.ts');
const orchestratorTypes = read('../../../src/foundation/llm-orchestrator/types.ts');
const orchestratorRuntime = read('../../../src/foundation/llm-orchestrator/provider-runtime.ts');
const orchestratorBarrel = read('../../../src/foundation/llm-orchestrator/index.ts');
const sdkBarrel = read('../../../src/index.ts');
const ordinaryCallers = [
  '../../../src/core/runtime/runtime.ts',
  '../../../src/core/llm-configuration/selection.ts',
  '../../../src/core/llm-configuration/identity.ts',
  '../../../src/assembly/core-infrastructure.ts',
  '../../../src/cli/llm-connection-check.ts',
  '../../../src/cli/setup-provider-probe.ts',
  '../../../src/cli/commands/config.ts',
].map(read);

describe('ProviderInput owner boundary', () => {
  it('exports input contracts without exposing legacy config projections at the ordinary facade', () => {
    expect(providerBarrel).toMatch(/export \* as llmProviderCall from '\.\/capabilities\/call\.js';/);
    expect(providerConfigFacade).toMatch(/toProviderInput/);
    expect(providerConfigFacade).not.toMatch(/toProviderConnection|providerConnectionFromResolvedConfig|\bProviderConfig\b/);
    expect(sdkBarrel).toMatch(/\bProviderInput\b/);
    expect(sdkBarrel).toMatch(/\bProviderFactory\b/);
    expect(sdkBarrel).toMatch(/@deprecated[\s\S]*ProviderConnection/);
    expect(orchestratorBarrel).not.toMatch(/\bProviderConfig\b/);
  });

  it('keeps L1 descriptors and credential helpers out of L4 identity projection', () => {
    expect(providerConfigFacade).toMatch(/providerInputIdentity/);
    expect(identitySource).toMatch(/llmProviderConfigContract\.ProviderInput/);
    expect(identitySource).not.toMatch(
      /\bllmProviderCall\b|\bdescribeProviderInput\b|\bpiAiCredentialRef\b|\bProviderDescriptor\b|\bcacheKey\b/,
    );
  });

  it('keeps legacy config and credential runtime out of the L2 public config', () => {
    expect(orchestratorTypes).toMatch(/primary:\s*ProviderCandidateConfig/);
    expect(orchestratorTypes).toMatch(/fallbacks\?:\s*ProviderCandidateConfig\[\]/);
    expect(orchestratorTypes).toMatch(/providerFactory:\s*ProviderFactory/);
    for (const source of [orchestratorTypes, orchestratorRuntime]) {
      expect(source).not.toMatch(/\bProviderConnection\b/);
      expect(source).not.toMatch(/\bProviderConfig\b/);
      expect(source).not.toMatch(/\bcredentialStore\b/);
      expect(source).not.toMatch(/\bcreateProviderAdapter\b/);
      expect(source).not.toMatch(/\bcreateLLMProvider\s*\(/);
    }
  });

  it('prevents ordinary callers from reconstructing legacy provider configs or connections', () => {
    for (const caller of ordinaryCallers) {
      expect(caller).not.toMatch(/\bProviderConfig\b/);
      expect(caller).not.toMatch(/\bProviderConnection\b/);
      expect(caller).not.toMatch(/\btoProviderConfig\b/);
      expect(caller).not.toMatch(/\btoProviderConnection\b/);
      expect(caller).not.toMatch(/\bcreateLLMProvider\s*\(/);
      expect(caller).not.toMatch(/\bcreateProviderFromConnection\b/);
    }
  });

  it('rejects namespace type queries, legacy factories and config projection destructuring', () => {
    const fixtures = [
      ['src/foundation/llm-orchestrator/fixture.ts', "import type { llmProviderCall } from '../llm-provider/index.js'; type Legacy = llmProviderCall.ProviderConnection;", 'llmProviderCall.ProviderConnection'],
      ['src/assembly/fixture.ts', "import { llmProviderCall } from '../foundation/llm-provider/index.js'; llmProviderCall.createProviderFromConnection;", 'llmProviderCall.createProviderFromConnection'],
      ['src/core/llm-configuration/fixture.ts', "import { llmProviderConfigContract } from '../../foundation/llm-provider/index.js'; const { toProviderConnection } = llmProviderConfigContract;", 'llmProviderConfigContract.toProviderConnection'],
    ] as const;
    for (const [file, source, expected] of fixtures) {
      expect(auditProviderSource(file, source).violations.join('\n')).toContain(expected);
    }
  });
});
