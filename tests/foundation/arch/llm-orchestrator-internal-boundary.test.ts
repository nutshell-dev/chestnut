import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (file: string): string => readFileSync(
  new URL(`../../../src/foundation/llm-orchestrator/${file}`, import.meta.url),
  'utf8',
);

const lowerLayers = [
  'invocation-executor.ts',
  'probe-controller.ts',
  'provider-runtime.ts',
  'recovery-ledger.ts',
] as const;

describe('Phase2064 LLM orchestrator internal dependency boundaries', () => {
  it('lower layers never import the Facade or retain the Executor host callback', () => {
    for (const file of lowerLayers) {
      const source = read(file);
      expect(source, file).not.toMatch(/from ['"]\.\/orchestrator\.js['"]/);
      expect(source, file).not.toMatch(/\bInvocationExecutorHost\b|\bhost\s*:/);
    }
    expect(read('invocation-executor.ts')).not.toMatch(/export interface InvocationExecutorHost/);
  });

  it('only InstanceStateStore persists instance state', () => {
    for (const file of lowerLayers) {
      const source = read(file);
      expect(source, file).not.toMatch(/\bsaveLLMInstanceState\b|\bwriteAtomicSync\b|\bwriteFileSync\b|from ['"]node:fs['"]/);
    }
    expect(read('instance-state-store.ts')).toMatch(/\bsaveLLMInstanceState\b/);
    expect(read('recovery-ledger.ts')).toMatch(/\bstore\.commit\(/);
  });

  it('Facade assembles and delegates without provider/recovery projections or probe algorithm', () => {
    const facade = read('orchestrator.ts');
    expect(facade).toMatch(/new LLMProbeController\(/);
    expect(facade).toMatch(/await this\.probeController\.close\(\);\s*await this\.providerRuntime\.close\(\);/);
    for (const forbidden of [
      'providerStates', 'recoveryState', 'lastSuccessProvider', 'currentStreamingProvider',
      'inflightProbe', 'probeCursor', 'probeAbort', 'commitInstanceCandidate',
      'recordProviderSuccess', 'toRecoveryFailures', 'sdkClientCache',
    ]) {
      expect(facade).not.toMatch(new RegExp(`\\b${forbidden}\\b`));
    }
  });
});
