/**
 * Runtime regime switch — phase 539 identity-only diff tests
 * (phase 1302 split from runtime-regime-switch.test.ts for parallel file run)
 *
 * Covers phase 539 identity-only diff:
 * - identity content = agents + skills only
 * - dynamic parts (memory, contract) 不触发 regime switch
 * - skill register/unregister + AGENTS.md edit DOES trigger
 * - switch failure auto-retries next turn
 *
 * Mirror phase 1296 / 1301 split SOP.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
// eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { TestRuntime } from '../helpers/test-runtime.js';
import { makeRuntimeDeps } from '../helpers/runtime-deps.js';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';
import type { LLMOrchestratorConfig } from '../../src/foundation/llm-orchestrator/types.js';
import type { LLMResponse } from '../../src/foundation/llm-provider/types.js';
import type { StreamChunk } from '../../src/foundation/llm-orchestrator/types.js';
import type { Message } from '../../src/foundation/llm-provider/types.js';
import { DialogStore } from '../../src/foundation/dialog-store/index.js';
import { TEST_LLM_TIMEOUT_MS } from '../helpers/test-timeouts.js';

async function* responseToStreamChunks(response: LLMResponse): AsyncIterableIterator<StreamChunk> {
  for (const block of response.content) {
    if (block.type === 'text') {
      yield { type: 'text_delta', delta: (block as { text: string }).text };
    } else if (block.type === 'tool_use') {
      const toolBlock = block as { id: string; name: string; input: unknown };
      yield {
        type: 'tool_use_start',
        toolUse: { id: toolBlock.id, name: toolBlock.name, partialInput: '' },
      };
      yield {
        type: 'tool_use_delta',
        toolUse: { id: '', name: '', partialInput: JSON.stringify(toolBlock.input) },
      };
    }
  }
  yield { type: 'done' };
}

function createMockLLMConfig(): LLMOrchestratorConfig {
  return {
    primary: {
      name: 'mock',
      apiKey: 'test-key',
      model: 'test-model',
      maxTokens: 1024,
      temperature: 0.7,
      timeoutMs: TEST_LLM_TIMEOUT_MS,
      apiFormat: 'anthropic' as const,
    },
    maxAttempts: 1,
    retryDelayMs: 100,
  };
}

function createMockLLM(responses: LLMResponse[]) {
  let index = 0;
  const callMock = vi.fn(async () => {
    const response = responses[index++] || responses[responses.length - 1];
    return response;
  });
  return {
    call: callMock,
    stream: vi.fn((...args: unknown[]) => {
      const result = callMock(...args);
      if (result instanceof Promise) {
        return (async function* () {
          const response = await result;
          yield* responseToStreamChunks(response as LLMResponse);
        })();
      }
      return responseToStreamChunks(result as LLMResponse);
    }),
    close: vi.fn(),
    healthCheck: vi.fn().mockResolvedValue(true),
    getProviderInfo: vi.fn().mockReturnValue({ name: 'mock', model: 'test', isFallback: false }),
  };
}

describe('phase 539: identity-only diff', () => {
  let tempDir: string;
  let clawDir: string;
  const runtimesToStop: Runtime[] = [];

  beforeEach(async () => {
    tempDir = await createTempDir();
    clawDir = path.join(tempDir, 'claws', 'test-claw');
  });

  afterEach(async () => {
    vi.restoreAllMocks(); // phase 711 P1-P3.1：防 DialogStore.repair 静态 spy 跨 worker leak
    for (const r of runtimesToStop.splice(0)) {
      await r.stop().catch(() => { /* silent: shutdown */ });
    }
    await cleanupTempDir(tempDir);
  });

  it('MEMORY.md edit does NOT trigger regime switch', async () => {
    const deps = await makeRuntimeDeps({ clawDir, clawId: 'test-claw' });
    const runtime = new TestRuntime({
      clawId: 'test-claw',
      clawDir,
      llmConfig: createMockLLMConfig(),
      dependencies: deps,
    });
    runtimesToStop.push(runtime);

    const mockLLM = createMockLLM([
      { content: [{ type: 'text', text: 'First' }], stop_reason: 'end_turn' },
      { content: [{ type: 'text', text: 'Second' }], stop_reason: 'end_turn' },
    ]);

    await runtime.initialize();
    const archiveSpy = vi.spyOn(deps.sessionManager, 'archive').mockResolvedValue(undefined);
    runtime.testSetLLM(mockLLM);

    // Turn 1: full includes memory-v1, identityContent = agents+skills (no memory)
    // Turn 2: full includes memory-v2, identityContent same = agents+skills
    vi.spyOn(runtime.contextInjector, 'buildSystemPromptForRegime')
      .mockResolvedValueOnce({ full: 'agents\n\nmemory-v1\n\nskills', identityContent: 'agents\n\nskills' })
      .mockResolvedValueOnce({ full: 'agents\n\nmemory-v2\n\nskills', identityContent: 'agents\n\nskills' });

    await runtime.processWithMessage({ role: 'user', content: 'Message 1' });
    await runtime.processWithMessage({ role: 'user', content: 'Message 2' });

    expect(archiveSpy).toHaveBeenCalledTimes(0);
  });

  it('contract subtask checkbox does NOT trigger regime switch', async () => {
    const deps = await makeRuntimeDeps({ clawDir, clawId: 'test-claw' });
    const runtime = new TestRuntime({
      clawId: 'test-claw',
      clawDir,
      llmConfig: createMockLLMConfig(),
      dependencies: deps,
    });
    runtimesToStop.push(runtime);

    const mockLLM = createMockLLM([
      { content: [{ type: 'text', text: 'First' }], stop_reason: 'end_turn' },
      { content: [{ type: 'text', text: 'Second' }], stop_reason: 'end_turn' },
    ]);

    await runtime.initialize();
    const archiveSpy = vi.spyOn(deps.sessionManager, 'archive').mockResolvedValue(undefined);
    runtime.testSetLLM(mockLLM);

    // Turn 1: contract with subtask unchecked
    // Turn 2: contract with subtask checked
    // identityContent excludes contract, so no regime switch
    vi.spyOn(runtime.contextInjector, 'buildSystemPromptForRegime')
      .mockResolvedValueOnce({ full: 'agents\n\ncontract-unchecked', identityContent: 'agents\n\nskills' })
      .mockResolvedValueOnce({ full: 'agents\n\ncontract-checked', identityContent: 'agents\n\nskills' });

    await runtime.processWithMessage({ role: 'user', content: 'Message 1' });
    await runtime.processWithMessage({ role: 'user', content: 'Message 2' });

    expect(archiveSpy).toHaveBeenCalledTimes(0);
  });

  it('contract title/goal change does NOT trigger regime switch', async () => {
    const deps = await makeRuntimeDeps({ clawDir, clawId: 'test-claw' });
    const runtime = new TestRuntime({
      clawId: 'test-claw',
      clawDir,
      llmConfig: createMockLLMConfig(),
      dependencies: deps,
    });
    runtimesToStop.push(runtime);

    const mockLLM = createMockLLM([
      { content: [{ type: 'text', text: 'First' }], stop_reason: 'end_turn' },
      { content: [{ type: 'text', text: 'Second' }], stop_reason: 'end_turn' },
    ]);

    await runtime.initialize();
    const archiveSpy = vi.spyOn(deps.sessionManager, 'archive').mockResolvedValue(undefined);
    runtime.testSetLLM(mockLLM);

    // Turn 1: contract title='A' goal='X'
    // Turn 2: contract title='B' goal='Y'
    // identityContent excludes contract
    vi.spyOn(runtime.contextInjector, 'buildSystemPromptForRegime')
      .mockResolvedValueOnce({ full: 'agents\n\ncontract-A', identityContent: 'agents\n\nskills' })
      .mockResolvedValueOnce({ full: 'agents\n\ncontract-B', identityContent: 'agents\n\nskills' });

    await runtime.processWithMessage({ role: 'user', content: 'Message 1' });
    await runtime.processWithMessage({ role: 'user', content: 'Message 2' });

    expect(archiveSpy).toHaveBeenCalledTimes(0);
  });

  it('AGENTS.md edit DOES trigger regime switch', async () => {
    const deps = await makeRuntimeDeps({ clawDir, clawId: 'test-claw' });
    const factorySpy = vi.spyOn(deps, 'dialogStoreFactory');

    const runtime = new TestRuntime({
      clawId: 'test-claw',
      clawDir,
      llmConfig: createMockLLMConfig(),
      dependencies: deps,
    });
    runtimesToStop.push(runtime);

    const mockLLM = createMockLLM([
      { content: [{ type: 'text', text: 'First' }], stop_reason: 'end_turn' },
      { content: [{ type: 'text', text: 'Second' }], stop_reason: 'end_turn' },
    ]);

    await runtime.initialize();
    const archiveSpy = vi.spyOn(deps.sessionManager, 'archive').mockResolvedValue(undefined);
    runtime.testSetLLM(mockLLM);

    // Turn 1: AGENTS.md = "v1"
    // Turn 2: AGENTS.md = "v2"
    // identityContent changes because agents changed
    vi.spyOn(runtime.contextInjector, 'buildSystemPromptForRegime')
      .mockResolvedValueOnce({ full: 'agents-v1\n\nskills', identityContent: 'agents-v1\n\nskills' })
      .mockResolvedValueOnce({ full: 'agents-v2\n\nskills', identityContent: 'agents-v2\n\nskills' });

    await runtime.processWithMessage({ role: 'user', content: 'Message 1' });
    await runtime.processWithMessage({ role: 'user', content: 'Message 2' });

    expect(archiveSpy).toHaveBeenCalledTimes(1);
    expect(factorySpy).toHaveBeenCalledTimes(1);
  });

  it('skill register/unregister DOES trigger regime switch', async () => {
    const deps = await makeRuntimeDeps({ clawDir, clawId: 'test-claw' });
    const runtime = new TestRuntime({
      clawId: 'test-claw',
      clawDir,
      llmConfig: createMockLLMConfig(),
      dependencies: deps,
    });
    runtimesToStop.push(runtime);

    const mockLLM = createMockLLM([
      { content: [{ type: 'text', text: 'First' }], stop_reason: 'end_turn' },
      { content: [{ type: 'text', text: 'Second' }], stop_reason: 'end_turn' },
    ]);

    await runtime.initialize();
    const archiveSpy = vi.spyOn(deps.sessionManager, 'archive').mockResolvedValue(undefined);
    runtime.testSetLLM(mockLLM);

    // Turn 1: skills = "S1"
    // Turn 2: skills = "S1\nS2"
    // identityContent changes because skills changed
    vi.spyOn(runtime.contextInjector, 'buildSystemPromptForRegime')
      .mockResolvedValueOnce({ full: 'agents\n\nS1', identityContent: 'agents\n\nS1' })
      .mockResolvedValueOnce({ full: 'agents\n\nS1\nS2', identityContent: 'agents\n\nS1\nS2' });

    await runtime.processWithMessage({ role: 'user', content: 'Message 1' });
    await runtime.processWithMessage({ role: 'user', content: 'Message 2' });

    expect(archiveSpy).toHaveBeenCalledTimes(1);
  });

  it('switch failure does not abort turn', async () => {
    const deps = await makeRuntimeDeps({ clawDir, clawId: 'test-claw' });
    const auditSpy = vi.spyOn(deps.auditWriter, 'write');

    // Mock factory to throw BEFORE Runtime construction so the closure captures the spy
    vi.spyOn(deps, 'dialogStoreFactory').mockImplementation(() => {
      throw new Error('fac');
    });

    const runtime = new TestRuntime({
      clawId: 'test-claw',
      clawDir,
      llmConfig: createMockLLMConfig(),
      dependencies: deps,
    });
    runtimesToStop.push(runtime);

    const mockLLM = createMockLLM([
      { content: [{ type: 'text', text: 'First' }], stop_reason: 'end_turn' },
      { content: [{ type: 'text', text: 'Second' }], stop_reason: 'end_turn' },
    ]);

    await runtime.initialize();
    runtime.testSetLLM(mockLLM);

    vi.spyOn(runtime.contextInjector, 'buildSystemPromptForRegime')
      .mockResolvedValueOnce({ full: 'system-prompt-A', identityContent: 'identity-A' })
      .mockResolvedValueOnce({ full: 'system-prompt-B', identityContent: 'identity-B' });

    await runtime.processWithMessage({ role: 'user', content: 'Message 1' }); // turn 1 still returns normally

    await runtime.processWithMessage({ role: 'user', content: 'Message 2' }); // turn 2 also returns normally despite factory throw

    const failedCall = auditSpy.mock.calls.find(c => c[0] === 'regime_switch_failed');
    expect(failedCall).toBeDefined();
    // phase 573: 加 trace_id extras 后 reason col 不再固定在 index [1]、改用 find
    expect(failedCall!.find((c: unknown) => typeof c === 'string' && c.startsWith('reason='))).toMatch(/reason=fac/);
  });

  it('switch failure auto-retries next turn', async () => {
    const deps = await makeRuntimeDeps({ clawDir, clawId: 'test-claw' });
    const auditSpy = vi.spyOn(deps.auditWriter, 'write');

    let throwCount = 0;
    const originalFactory = deps.dialogStoreFactory;
    const factorySpy = vi.spyOn(deps, 'dialogStoreFactory').mockImplementation((systemPrompt: string) => {
      throwCount++;
      if (throwCount === 1) {
        throw new Error('fac');
      }
      return originalFactory(systemPrompt);
    });

    const runtime = new TestRuntime({
      clawId: 'test-claw',
      clawDir,
      llmConfig: createMockLLMConfig(),
      dependencies: deps,
    });
    runtimesToStop.push(runtime);

    const archiveSpy = vi.spyOn(deps.sessionManager, 'archive').mockResolvedValue(undefined);

    const mockLLM = createMockLLM([
      { content: [{ type: 'text', text: 'First' }], stop_reason: 'end_turn' },
      { content: [{ type: 'text', text: 'Second' }], stop_reason: 'end_turn' },
      { content: [{ type: 'text', text: 'Third' }], stop_reason: 'end_turn' },
    ]);

    await runtime.initialize();
    runtime.testSetLLM(mockLLM);

    vi.spyOn(runtime.contextInjector, 'buildSystemPromptForRegime')
      .mockResolvedValueOnce({ full: 'system-prompt-A', identityContent: 'identity-A' })
      .mockResolvedValueOnce({ full: 'system-prompt-B', identityContent: 'identity-B' })
      .mockResolvedValueOnce({ full: 'system-prompt-B', identityContent: 'identity-B' });

    // Turn 1: sets lastIdentityHash = 'identity-A'
    await runtime.processWithMessage({ role: 'user', content: 'Message 1' });

    // Turn 2: identity changed, factory throws, audit failed, lastIdentityHash NOT updated
    await runtime.processWithMessage({ role: 'user', content: 'Message 2' });

    // Factory should have been called once (threw)
    expect(factorySpy).toHaveBeenCalledTimes(1);

    const failedCall = auditSpy.mock.calls.find(c => c[0] === 'regime_switch_failed');
    expect(failedCall).toBeDefined();

    // Turn 3: same identity as turn 2, factory succeeds (retry)
    // Because lastIdentityHash is still 'identity-A', and identityContent is 'identity-B', it retries
    await runtime.processWithMessage({ role: 'user', content: 'Message 3' });

    // Factory should have been called twice (first threw, second succeeded)
    expect(factorySpy).toHaveBeenCalledTimes(2);

    const regimeSwitchCall = auditSpy.mock.calls.find(c => c[0] === 'regime_switch');
    expect(regimeSwitchCall).toBeDefined();
  });

  it('custom systemPromptBuilder falls back to full-prompt diff', async () => {
    const deps = await makeRuntimeDeps({ clawDir, clawId: 'test-claw' });
    const runtime = new TestRuntime({
      clawId: 'test-claw',
      clawDir,
      llmConfig: createMockLLMConfig(),
      systemPromptBuilder: async () => 'custom-prompt',
      dependencies: deps,
    });
    runtimesToStop.push(runtime);

    const mockLLM = createMockLLM([
      { content: [{ type: 'text', text: 'First' }], stop_reason: 'end_turn' },
      { content: [{ type: 'text', text: 'Second' }], stop_reason: 'end_turn' },
    ]);

    await runtime.initialize();
    const archiveSpy = vi.spyOn(deps.sessionManager, 'archive').mockResolvedValue(undefined);
    runtime.testSetLLM(mockLLM);

    // Mock buildSystemPrompt so the fallback path gets different prompts
    vi.spyOn(runtime as any, 'buildSystemPrompt')
      .mockResolvedValueOnce('custom-prompt-A')
      .mockResolvedValueOnce('custom-prompt-B');

    await runtime.processWithMessage({ role: 'user', content: 'Message 1' });
    await runtime.processWithMessage({ role: 'user', content: 'Message 2' });

    // With custom systemPromptBuilder, identityContent = full systemPrompt
    // Any change triggers regime switch (compatible with phase 521 behavior)
    expect(archiveSpy).toHaveBeenCalledTimes(1);
  });
});
