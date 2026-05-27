/**
 * Runtime regime switch atomicity tests — phase 600 / A.regime-switch-atomicity
 *
 * Covers:
 * - step 5+6 reorder: prepare → save → commit
 * - catch recovery dump to dialog dir
 * - dump failure final fallback audit
 * - happy path commit + success audit
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { TestRuntime } from '../helpers/test-runtime.js';
import { makeRuntimeDeps } from '../helpers/runtime-deps.js';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';
import type { LLMOrchestratorConfig } from '../../src/foundation/llm-orchestrator/types.js';
import type { LLMResponse } from '../../src/foundation/llm-provider/types.js';
import type { StreamChunk } from '../../src/foundation/llm-orchestrator/types.js';
import type { Message } from '../../src/foundation/llm-provider/types.js';
import { RUNTIME_AUDIT_EVENTS } from '../../src/core/runtime/runtime-audit-events.js';
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

describe('Runtime regime switch atomicity (phase 600 / A.regime-switch-atomicity)', () => {
  let tempDir: string;
  let clawDir: string;
  const runtimesToStop: TestRuntime[] = [];

  beforeEach(async () => {
    vi.restoreAllMocks();
    tempDir = await createTempDir();
    clawDir = path.join(tempDir, 'claws', 'test-claw');
  });

  afterEach(async () => {
    for (const r of runtimesToStop.splice(0)) {
      await r.stop().catch(() => {});
    }
    await cleanupTempDir(tempDir);
  });

  it('step 6 newSessionManager.save throws → oldSessionManager 不变（reorder 真生效）', async () => {
    const deps = await makeRuntimeDeps({ clawDir, clawId: 'test-claw' });
    const originalFactory = deps.dialogStoreFactory;

    // Mock factory BEFORE Runtime construction so the closure captures it
    vi.spyOn(deps, 'dialogStoreFactory').mockImplementation(() => {
      const newSm = originalFactory();
      vi.spyOn(newSm, 'save').mockRejectedValue(new Error('save-fail'));
      return newSm;
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
    vi.spyOn(deps.sessionManager, 'archive').mockResolvedValue(undefined);
    runtime.testSetLLM(mockLLM);

    // Capture old session manager reference AFTER initialize
    const oldSessionManager = runtime.testGetSessionManager();

    vi.spyOn(runtime.contextInjector, 'buildSystemPromptForRegime')
      .mockResolvedValueOnce({ full: 'system-prompt-A', identityContent: 'identity-A' })
      .mockResolvedValueOnce({ full: 'system-prompt-B', identityContent: 'identity-B' });

    await runtime.chat('Message 1');
    await runtime.chat('Message 2');

    // sessionManager should still be the old one because save threw before commit
    expect(runtime.testGetSessionManager()).toBe(oldSessionManager);
    // lastIdentityHash should NOT be updated (D7 自愈)
    expect(runtime.testGetLastIdentityHash()).toBe('identity-A');
  });

  it('step 6 save throws → recovery file dump 到 dialog dir', async () => {
    const deps = await makeRuntimeDeps({ clawDir, clawId: 'test-claw' });
    const originalFactory = deps.dialogStoreFactory;

    // Mock factory BEFORE Runtime construction
    vi.spyOn(deps, 'dialogStoreFactory').mockImplementation(() => {
      const newSm = originalFactory();
      vi.spyOn(newSm, 'save').mockRejectedValue(new Error('save-fail'));
      return newSm;
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
    vi.spyOn(deps.sessionManager, 'archive').mockResolvedValue(undefined);
    runtime.testSetLLM(mockLLM);

    // Seed messages to verify recovery content
    const seededMessages: Message[] = [
      { role: 'user', content: 'user-A' },
      { role: 'assistant', content: 'assistant-A' },
    ];
    await deps.sessionManager.save({ systemPrompt: 'test-system-prompt', messages: seededMessages, toolsForLLM: [] });

    vi.spyOn(runtime.contextInjector, 'buildSystemPromptForRegime')
      .mockResolvedValueOnce({ full: 'system-prompt-A', identityContent: 'identity-A' })
      .mockResolvedValueOnce({ full: 'system-prompt-B', identityContent: 'identity-B' });

    await runtime.chat('Message 1');
    await runtime.chat('Message 2');

    // Verify recovery file exists in dialog dir
    const dialogDir = path.join(clawDir, 'dialog');
    const files = await fs.readdir(dialogDir);
    const recoveryFiles = files.filter(f => /^regime-switch-recovery-\d+\.json$/.test(f));
    expect(recoveryFiles.length).toBe(1);

    const recoveryFile = recoveryFiles[0];
    const recoveryPath = path.join(dialogDir, recoveryFile);
    const recoveryContent = JSON.parse(await fs.readFile(recoveryPath, 'utf-8'));

    expect(recoveryContent.systemPrompt).toBe('system-prompt-B');
    expect(Array.isArray(recoveryContent.original)).toBe(true);
    expect(recoveryContent.original.length).toBeGreaterThanOrEqual(seededMessages.length);
    // original contains seeded messages at the beginning
    expect(recoveryContent.original[0]).toEqual(seededMessages[0]);
    expect(recoveryContent.original[1]).toEqual(seededMessages[1]);
    expect(recoveryContent.strategy).toBe('all');
    expect(recoveryContent.reason).toBe('save-fail');
    expect(recoveryContent.timestamp).toBeDefined();
  });

  it('save throws + dump throws → final fallback audit (phase=save_and_dump)', async () => {
    const deps = await makeRuntimeDeps({ clawDir, clawId: 'test-claw' });
    const originalFactory = deps.dialogStoreFactory;

    // Mock factory BEFORE Runtime construction
    vi.spyOn(deps, 'dialogStoreFactory').mockImplementation(() => {
      const newSm = originalFactory();
      vi.spyOn(newSm, 'save').mockRejectedValue(new Error('save-fail'));
      return newSm;
    });

    const runtime = new TestRuntime({
      clawId: 'test-claw',
      clawDir,
      llmConfig: createMockLLMConfig(),
      dependencies: deps,
    });
    runtimesToStop.push(runtime);

    const auditSpy = vi.spyOn(deps.auditWriter, 'write');

    const mockLLM = createMockLLM([
      { content: [{ type: 'text', text: 'First' }], stop_reason: 'end_turn' },
      { content: [{ type: 'text', text: 'Second' }], stop_reason: 'end_turn' },
    ]);

    await runtime.initialize();
    vi.spyOn(deps.sessionManager, 'archive').mockResolvedValue(undefined);
    runtime.testSetLLM(mockLLM);

    // Mock systemFs.writeAtomic to throw ONLY on recovery path
    const originalWriteAtomic = deps.systemFs.writeAtomic.bind(deps.systemFs);
    vi.spyOn(deps.systemFs, 'writeAtomic').mockImplementation(async (filePath: string, content: string) => {
      if (typeof filePath === 'string' && filePath.includes('regime-switch-recovery')) {
        throw new Error('dump-fail');
      }
      return originalWriteAtomic(filePath, content);
    });

    vi.spyOn(runtime.contextInjector, 'buildSystemPromptForRegime')
      .mockResolvedValueOnce({ full: 'system-prompt-A', identityContent: 'identity-A' })
      .mockResolvedValueOnce({ full: 'system-prompt-B', identityContent: 'identity-B' });

    await runtime.chat('Message 1');
    await runtime.chat('Message 2');

    const failedCall = auditSpy.mock.calls.find(c =>
      c[0] === RUNTIME_AUDIT_EVENTS.REGIME_SWITCH_FAILED && c[1] === 'phase=save_and_dump'
    );
    expect(failedCall).toBeDefined();
    expect(failedCall![2]).toMatch(/^recovery_path=/);
    expect(failedCall![3]).toMatch(/^save_reason=/);
    expect(failedCall![3]).toContain('save-fail');
    expect(failedCall![4]).toMatch(/^dump_reason=/);
    expect(failedCall![4]).toContain('dump-fail');
    expect(failedCall![5]).toMatch(/^inherited_count=/);
  });

  it('happy path：save 成功 → commit this.sessionManager + audit REGIME_SWITCH', async () => {
    const deps = await makeRuntimeDeps({ clawDir, clawId: 'test-claw' });
    const originalFactory = deps.dialogStoreFactory;

    let capturedNewSessionManager: unknown;

    // Mock factory BEFORE Runtime construction to capture new instance
    vi.spyOn(deps, 'dialogStoreFactory').mockImplementation(() => {
      const newSm = originalFactory();
      capturedNewSessionManager = newSm;
      return newSm;
    });

    const runtime = new TestRuntime({
      clawId: 'test-claw',
      clawDir,
      llmConfig: createMockLLMConfig(),
      dependencies: deps,
    });
    runtimesToStop.push(runtime);

    const auditSpy = vi.spyOn(deps.auditWriter, 'write');

    const mockLLM = createMockLLM([
      { content: [{ type: 'text', text: 'First' }], stop_reason: 'end_turn' },
      { content: [{ type: 'text', text: 'Second' }], stop_reason: 'end_turn' },
    ]);

    await runtime.initialize();
    vi.spyOn(deps.sessionManager, 'archive').mockResolvedValue(undefined);
    runtime.testSetLLM(mockLLM);

    // Seed messages
    const seededMessages: Message[] = [
      { role: 'user', content: 'user-A' },
      { role: 'assistant', content: 'assistant-A' },
    ];
    await deps.sessionManager.save({ systemPrompt: 'test-system-prompt', messages: seededMessages, toolsForLLM: [] });

    vi.spyOn(runtime.contextInjector, 'buildSystemPromptForRegime')
      .mockResolvedValueOnce({ full: 'system-prompt-A', identityContent: 'identity-A' })
      .mockResolvedValueOnce({ full: 'system-prompt-B', identityContent: 'identity-B' });

    await runtime.chat('Message 1');
    await runtime.chat('Message 2');

    // sessionManager should be the new one
    expect(runtime.testGetSessionManager()).toBe(capturedNewSessionManager);
    // lastIdentityHash should be updated
    expect(runtime.testGetLastIdentityHash()).toBe('identity-B');

    // Audit success
    const regimeSwitchCall = auditSpy.mock.calls.find(c => c[0] === RUNTIME_AUDIT_EVENTS.REGIME_SWITCH);
    expect(regimeSwitchCall).toBeDefined();
    expect(regimeSwitchCall![1]).toBe('strategy=all');
    expect(regimeSwitchCall![2]).toMatch(/^inherited=/);
    expect(regimeSwitchCall![3]).toMatch(/^discarded=/);
  });
});
