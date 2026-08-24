import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const orchestratorTypes = read('../../../src/foundation/llm-orchestrator/types.ts');
const providerBarrel = read('../../../src/foundation/llm-provider/index.ts');
const callers = [
  '../../../src/foundation/llm-orchestrator/orchestrator.ts',
  '../../../tests/core/_runtime-test-helpers.ts',
  '../../../tests/core/agent-executor.test.ts',
  '../../../tests/core/react.test.ts',
  '../../../tests/core/runtime-chat-stop-reset.test.ts',
  '../../../tests/core/runtime-regime-switch-atomic.test.ts',
  '../../../tests/core/runtime-regime-switch-identity-diff.test.ts',
  '../../../tests/core/runtime-regime-switch.test.ts',
  '../../../tests/core/runtime-stop-reset.test.ts',
  '../../../tests/core/step-executor.test.ts',
  '../../../tests/core/step-executor/abort-handling.test.ts',
  '../../../tests/core/step-executor/callback-invariants.test.ts',
  '../../../tests/core/task-subagent.test.ts',
  '../../../tests/core/task.test.ts',
  '../../../tests/foundation/llm-orchestrator/hedge-cleanup-invariants.test.ts',
  '../../../tests/foundation/llm-orchestrator/hedge-primary-success-race-lost.test.ts',
  '../../../tests/foundation/llm-orchestrator/hedge-state-machine-cluster.test.ts',
  '../../../tests/foundation/llm-orchestrator/hedge.test.ts',
  '../../../tests/foundation/llm-orchestrator/orchestrator-misc-invariants.test.ts',
  '../../../tests/foundation/llm-orchestrator/orchestrator.test.ts',
  '../../../tests/foundation/llm-orchestrator/stream-idle-probe.test.ts',
  '../../../tests/foundation/llm-service.test.ts',
  '../../../tests/foundation/llm.test.ts',
].map(read);

describe('StreamChunk owner boundary', () => {
  it('is exported only by LLMProvider and all external callers use owner', () => {
    expect(providerBarrel).toMatch(/export\s+type\s*\{[^}]*\bStreamChunk\b[^}]*\}\s*from\s*['"]\.\/types\.js['"]/s);
    expect(orchestratorTypes).not.toMatch(/export\s+type\s*\{[^}]*\bStreamChunk\b[^}]*\}/s);
    for (const caller of callers) {
      expect(caller).toMatch(/import\s+(?:type\s*)?\{[^}]*\bStreamChunk\b[^}]*\}\s*from\s*['"][^'"]*llm-provider\/(?:index|types)\.js['"]/s);
    }
  });

  it('keeps the internal owner import and stream signature', () => {
    expect(orchestratorTypes).toMatch(/import\s+type\s*\{[^}]*\bStreamChunk\b[^}]*\}\s*from\s*['"]\.\.\/llm-provider\/index\.js['"]/s);
    expect(orchestratorTypes).toMatch(/stream\(options:\s*LLMCallOptions\):\s*AsyncIterableIterator<StreamChunk>/);
  });
});
