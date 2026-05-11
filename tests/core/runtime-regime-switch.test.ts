/**
 * Runtime regime switch tests — phase 521 + phase 539
 *
 * Covers L5.G1-G4 + phase 539 identity-only diff:
 * - G1: messages 继承 default 'all'
 * - G2: 枚举字符串接口 'all' | 'none' | 'last-turn'
 * - G3: 每 turn 末自动检测
 * - G4: tool_use 悬空自动 repair
 * - phase 539: identity-only diff (agents + skills) / dynamic parts (memory, contract) 不触发
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { TestRuntime } from '../helpers/test-runtime.js';
import { makeRuntimeDeps } from '../helpers/runtime-deps.js';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';
import type { LLMOrchestratorConfig } from '../../src/foundation/llm-orchestrator/types.js';
import type { LLMResponse } from '../../src/types/message.js';
import type { StreamChunk } from '../../src/foundation/llm-orchestrator/types.js';
import type { Message } from '../../src/types/message.js';
import { DialogStore } from '../../src/foundation/dialog-store/index.js';

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
      timeoutMs: 30000,
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

describe('Runtime regime switch (phase 521)', () => {
  let tempDir: string;
  let clawDir: string;
  const runtimesToStop: TestRuntime[] = [];

  beforeEach(async () => {
    tempDir = await createTempDir();
    clawDir = path.join(tempDir, 'claws', 'test-claw');
  });

  afterEach(async () => {
    for (const r of runtimesToStop.splice(0)) {
      await r.stop().catch(() => {});
    }
    await cleanupTempDir(tempDir);
  });

  it('首 turn lastIdentityHash undefined / 不触发 archive', async () => {
    const deps = await makeRuntimeDeps({ clawDir, clawId: 'test-claw' });
    const runtime = new TestRuntime({
      clawId: 'test-claw',
      clawDir,
      llmConfig: createMockLLMConfig(),
      dependencies: deps,
    });
    runtimesToStop.push(runtime);

    const mockLLM = createMockLLM([{
      content: [{ type: 'text', text: 'Hello' }],
      stop_reason: 'end_turn',
    }]);

    await runtime.initialize();
    // Spy AFTER initialize to exclude startup archive
    const archiveSpy = vi.spyOn(deps.sessionManager, 'archive').mockResolvedValue(undefined);
    runtime.testSetLLM(mockLLM);

    // Mock buildSystemPromptForRegime so _runReact gets a consistent value
    vi.spyOn(deps.contextInjector, 'buildSystemPromptForRegime').mockResolvedValue({ full: 'prompt-A', identityHash: 'identity-A' });

    await runtime.chat('Hi!');

    expect(archiveSpy).toHaveBeenCalledTimes(0);
  });

  it('turn 2 identityHash 不变 / 不触发 archive', async () => {
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
    // Spy AFTER initialize to exclude startup archive
    const archiveSpy = vi.spyOn(deps.sessionManager, 'archive').mockResolvedValue(undefined);
    runtime.testSetLLM(mockLLM);

    vi.spyOn(deps.contextInjector, 'buildSystemPromptForRegime').mockResolvedValue({ full: 'same-prompt', identityHash: 'same-identity' });

    await runtime.chat('Message 1');
    await runtime.chat('Message 2');

    expect(archiveSpy).toHaveBeenCalledTimes(0);
  });

  it('turn 2 identityHash 变 / archive + new instance + inherited all', async () => {
    const deps = await makeRuntimeDeps({ clawDir, clawId: 'test-claw' });
    // factorySpy BEFORE Runtime construction so the closure captures the spy
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
    // archiveSpy AFTER initialize to exclude startup archive
    const archiveSpy = vi.spyOn(deps.sessionManager, 'archive').mockResolvedValue(undefined);
    runtime.testSetLLM(mockLLM);

    // Turn 1: identity A; Turn 2: identity B (regime change)
    vi.spyOn(deps.contextInjector, 'buildSystemPromptForRegime')
      .mockResolvedValueOnce({ full: 'system-prompt-A', identityHash: 'identity-A' })
      .mockResolvedValueOnce({ full: 'system-prompt-B', identityHash: 'identity-B' });

    await runtime.chat('Message 1');
    await runtime.chat('Message 2');

    expect(archiveSpy).toHaveBeenCalledTimes(1);
    expect(factorySpy).toHaveBeenCalledTimes(1);
    expect(factorySpy).toHaveBeenCalledWith('system-prompt-B');
  });

  it('strategy "none" / inherited 0 messages', async () => {
    const deps = await makeRuntimeDeps({ clawDir, clawId: 'test-claw' });
    const factorySpy = vi.spyOn(deps, 'dialogStoreFactory');

    const runtime = new TestRuntime({
      clawId: 'test-claw',
      clawDir,
      llmConfig: createMockLLMConfig(),
      regimeSwitchStrategy: 'none',
      dependencies: deps,
    });
    runtimesToStop.push(runtime);

    vi.spyOn(deps.sessionManager, 'archive').mockResolvedValue(undefined);

    const mockLLM = createMockLLM([
      { content: [{ type: 'text', text: 'First' }], stop_reason: 'end_turn' },
      { content: [{ type: 'text', text: 'Second' }], stop_reason: 'end_turn' },
    ]);

    await runtime.initialize();
    runtime.testSetLLM(mockLLM);

    vi.spyOn(deps.contextInjector, 'buildSystemPromptForRegime')
      .mockResolvedValueOnce({ full: 'system-prompt-A', identityHash: 'identity-A' })
      .mockResolvedValueOnce({ full: 'system-prompt-B', identityHash: 'identity-B' });

    await runtime.chat('Message 1');
    await runtime.chat('Message 2');

    expect(factorySpy).toHaveBeenCalledTimes(1);
    expect(factorySpy).toHaveBeenCalledWith('system-prompt-B');
  });

  it('strategy "last-turn" / inherited 最近 user msg 起切片', async () => {
    const deps = await makeRuntimeDeps({ clawDir, clawId: 'test-claw' });
    const factorySpy = vi.spyOn(deps, 'dialogStoreFactory');

    const runtime = new TestRuntime({
      clawId: 'test-claw',
      clawDir,
      llmConfig: createMockLLMConfig(),
      regimeSwitchStrategy: 'last-turn',
      dependencies: deps,
    });
    runtimesToStop.push(runtime);

    vi.spyOn(deps.sessionManager, 'archive').mockResolvedValue(undefined);

    const mockLLM = createMockLLM([
      { content: [{ type: 'text', text: 'First' }], stop_reason: 'end_turn' },
      { content: [{ type: 'text', text: 'Second' }], stop_reason: 'end_turn' },
    ]);

    await runtime.initialize();
    runtime.testSetLLM(mockLLM);

    // Manually seed messages to simulate multi-turn history
    // [user A, assistant A, user B, assistant B]
    const seededMessages: Message[] = [
      { role: 'user', content: 'user-A' },
      { role: 'assistant', content: 'assistant-A' },
      { role: 'user', content: 'user-B' },
      { role: 'assistant', content: 'assistant-B' },
    ];
    await deps.sessionManager.save(seededMessages);

    vi.spyOn(deps.contextInjector, 'buildSystemPromptForRegime')
      .mockResolvedValueOnce({ full: 'system-prompt-A', identityHash: 'identity-A' })
      .mockResolvedValueOnce({ full: 'system-prompt-B', identityHash: 'identity-B' });

    // Need two chats to trigger regime switch (first sets lastIdentityHash)
    await runtime.chat('Message 1');
    await runtime.chat('Message 2');

    // factory should create new DialogStore with 'system-prompt-B'
    expect(factorySpy).toHaveBeenCalledTimes(1);
    expect(factorySpy).toHaveBeenCalledWith('system-prompt-B');
  });

  it('tool_use 悬空 / DialogStore.repair 被调用', async () => {
    const deps = await makeRuntimeDeps({ clawDir, clawId: 'test-claw' });
    const runtime = new TestRuntime({
      clawId: 'test-claw',
      clawDir,
      llmConfig: createMockLLMConfig(),
      dependencies: deps,
    });
    runtimesToStop.push(runtime);

    vi.spyOn(deps.sessionManager, 'archive').mockResolvedValue(undefined);
    const repairSpy = vi.spyOn(DialogStore, 'repair');

    const mockLLM = createMockLLM([
      { content: [{ type: 'text', text: 'First' }], stop_reason: 'end_turn' },
      { content: [{ type: 'text', text: 'Second' }], stop_reason: 'end_turn' },
    ]);

    await runtime.initialize();
    runtime.testSetLLM(mockLLM);

    // Seed messages with an incomplete tool_use at the end
    const seededMessages: Message[] = [
      { role: 'user', content: 'user-A' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Using tool' },
          { type: 'tool_use', id: 'tu1', name: 'old_tool', input: {} },
        ] as any,
      },
    ];
    await deps.sessionManager.save(seededMessages);

    vi.spyOn(deps.contextInjector, 'buildSystemPromptForRegime')
      .mockResolvedValueOnce({ full: 'system-prompt-A', identityHash: 'identity-A' })
      .mockResolvedValueOnce({ full: 'system-prompt-B', identityHash: 'identity-B' });

    await runtime.chat('Message 2');

    expect(repairSpy).toHaveBeenCalled();
  });

  it('regime_switch audit event 载荷完整', async () => {
    const deps = await makeRuntimeDeps({ clawDir, clawId: 'test-claw' });
    const runtime = new TestRuntime({
      clawId: 'test-claw',
      clawDir,
      llmConfig: createMockLLMConfig(),
      regimeSwitchStrategy: 'last-turn',
      dependencies: deps,
    });
    runtimesToStop.push(runtime);

    vi.spyOn(deps.sessionManager, 'archive').mockResolvedValue(undefined);

    const auditSpy = vi.spyOn(deps.auditWriter, 'write');

    const mockLLM = createMockLLM([
      { content: [{ type: 'text', text: 'First' }], stop_reason: 'end_turn' },
      { content: [{ type: 'text', text: 'Second' }], stop_reason: 'end_turn' },
    ]);

    await runtime.initialize();
    runtime.testSetLLM(mockLLM);

    // Seed 5 messages: [user, assistant, user, assistant, user]
    // last-turn should inherit from last user = 1 message (just the last user)
    const seededMessages: Message[] = [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
    ];
    await deps.sessionManager.save(seededMessages);

    vi.spyOn(deps.contextInjector, 'buildSystemPromptForRegime')
      .mockResolvedValueOnce({ full: 'system-prompt-A', identityHash: 'identity-A' })
      .mockResolvedValueOnce({ full: 'system-prompt-B', identityHash: 'identity-B' });

    // Need two chats to trigger regime switch (first sets lastIdentityHash)
    await runtime.chat('Message 1');
    await runtime.chat('Message 2');

    const regimeSwitchCall = auditSpy.mock.calls.find(c => c[0] === 'regime_switch');
    expect(regimeSwitchCall).toBeDefined();
    expect(regimeSwitchCall![1]).toBe('strategy=last-turn');
    expect(regimeSwitchCall![2]).toMatch(/^inherited=/);
    expect(regimeSwitchCall![3]).toMatch(/^discarded=/);
  });
});

describe('phase 539: identity-only diff', () => {
  let tempDir: string;
  let clawDir: string;
  const runtimesToStop: Runtime[] = [];

  beforeEach(async () => {
    tempDir = await createTempDir();
    clawDir = path.join(tempDir, 'claws', 'test-claw');
  });

  afterEach(async () => {
    for (const r of runtimesToStop.splice(0)) {
      await r.stop().catch(() => {});
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

    // Turn 1: full includes memory-v1, identityHash = agents+skills (no memory)
    // Turn 2: full includes memory-v2, identityHash same = agents+skills
    vi.spyOn(deps.contextInjector, 'buildSystemPromptForRegime')
      .mockResolvedValueOnce({ full: 'agents\n\nmemory-v1\n\nskills', identityHash: 'agents\n\nskills' })
      .mockResolvedValueOnce({ full: 'agents\n\nmemory-v2\n\nskills', identityHash: 'agents\n\nskills' });

    await runtime.chat('Message 1');
    await runtime.chat('Message 2');

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
    // identityHash excludes contract, so no regime switch
    vi.spyOn(deps.contextInjector, 'buildSystemPromptForRegime')
      .mockResolvedValueOnce({ full: 'agents\n\ncontract-unchecked', identityHash: 'agents\n\nskills' })
      .mockResolvedValueOnce({ full: 'agents\n\ncontract-checked', identityHash: 'agents\n\nskills' });

    await runtime.chat('Message 1');
    await runtime.chat('Message 2');

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
    // identityHash excludes contract
    vi.spyOn(deps.contextInjector, 'buildSystemPromptForRegime')
      .mockResolvedValueOnce({ full: 'agents\n\ncontract-A', identityHash: 'agents\n\nskills' })
      .mockResolvedValueOnce({ full: 'agents\n\ncontract-B', identityHash: 'agents\n\nskills' });

    await runtime.chat('Message 1');
    await runtime.chat('Message 2');

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
    // identityHash changes because agents changed
    vi.spyOn(deps.contextInjector, 'buildSystemPromptForRegime')
      .mockResolvedValueOnce({ full: 'agents-v1\n\nskills', identityHash: 'agents-v1\n\nskills' })
      .mockResolvedValueOnce({ full: 'agents-v2\n\nskills', identityHash: 'agents-v2\n\nskills' });

    await runtime.chat('Message 1');
    await runtime.chat('Message 2');

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
    // identityHash changes because skills changed
    vi.spyOn(deps.contextInjector, 'buildSystemPromptForRegime')
      .mockResolvedValueOnce({ full: 'agents\n\nS1', identityHash: 'agents\n\nS1' })
      .mockResolvedValueOnce({ full: 'agents\n\nS1\nS2', identityHash: 'agents\n\nS1\nS2' });

    await runtime.chat('Message 1');
    await runtime.chat('Message 2');

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

    vi.spyOn(deps.contextInjector, 'buildSystemPromptForRegime')
      .mockResolvedValueOnce({ full: 'system-prompt-A', identityHash: 'identity-A' })
      .mockResolvedValueOnce({ full: 'system-prompt-B', identityHash: 'identity-B' });

    const result = await runtime.chat('Message 1');
    expect(result).toBe('First'); // turn 1 still returns normally

    const result2 = await runtime.chat('Message 2');
    expect(result2).toBe('Second'); // turn 2 also returns normally despite factory throw

    const failedCall = auditSpy.mock.calls.find(c => c[0] === 'regime_switch_failed');
    expect(failedCall).toBeDefined();
    expect(failedCall![1]).toMatch(/reason=fac/);
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

    vi.spyOn(deps.contextInjector, 'buildSystemPromptForRegime')
      .mockResolvedValueOnce({ full: 'system-prompt-A', identityHash: 'identity-A' })
      .mockResolvedValueOnce({ full: 'system-prompt-B', identityHash: 'identity-B' })
      .mockResolvedValueOnce({ full: 'system-prompt-B', identityHash: 'identity-B' });

    // Turn 1: sets lastIdentityHash = 'identity-A'
    await runtime.chat('Message 1');

    // Turn 2: identity changed, factory throws, audit failed, lastIdentityHash NOT updated
    await runtime.chat('Message 2');

    // Factory should have been called once (threw)
    expect(factorySpy).toHaveBeenCalledTimes(1);

    const failedCall = auditSpy.mock.calls.find(c => c[0] === 'regime_switch_failed');
    expect(failedCall).toBeDefined();

    // Turn 3: same identity as turn 2, factory succeeds (retry)
    // Because lastIdentityHash is still 'identity-A', and identityHash is 'identity-B', it retries
    await runtime.chat('Message 3');

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

    await runtime.chat('Message 1');
    await runtime.chat('Message 2');

    // With custom systemPromptBuilder, identityHash = full systemPrompt
    // Any change triggers regime switch (compatible with phase 521 behavior)
    expect(archiveSpy).toHaveBeenCalledTimes(1);
  });
});
