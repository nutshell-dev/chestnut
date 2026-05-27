/**
 * Runtime stopRequested per-turn reset tests — phase 786 / P0.14
 *
 * Covers:
 * - stopRequested reset to false at start of each _runReact turn
 * - regression: turn N done call does not silence turn N+1
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { Runtime } from '../../src/core/runtime/runtime.js';
import { makeRuntimeDeps } from '../helpers/runtime-deps.js';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';
import type { LLMOrchestratorConfig } from '../../src/foundation/llm-orchestrator/types.js';
import type { LLMResponse } from '../../src/foundation/llm-provider/types.js';
import type { StreamChunk } from '../../src/foundation/llm-orchestrator/types.js';
import type { Message } from '../../src/foundation/llm-provider/types.js';
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

describe('runtime stopRequested per-turn reset (phase 786 / P0.14)', () => {
  let tempDir: string;
  let clawDir: string;
  const runtimesToStop: Runtime[] = [];

  beforeEach(async () => {
    vi.restoreAllMocks();
    tempDir = path.join(tmpdir(), `claw-test-${randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
    clawDir = path.join(tempDir, 'claws', 'test-claw');
  });

  afterEach(async () => {
    for (const r of runtimesToStop.splice(0)) {
      await r.stop().catch(() => {});
    }
    await cleanupTempDir(tempDir);
  });

  it('resets stopRequested to false at the start of each _runReact turn', async () => {
    const deps = await makeRuntimeDeps({ clawDir, clawId: 'test-claw' });
    const runtime = new Runtime({
      clawId: 'test-claw',
      clawDir,
      llmConfig: createMockLLMConfig(),
      dependencies: deps,
    });
    runtimesToStop.push(runtime);

    const mockLLM = createMockLLM([{
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    }]);

    await runtime.initialize();
    (runtime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

    // Simulate previous turn's done call leaving stopRequested=true
    runtime.execContext.stopRequested = true;

    vi.spyOn(runtime.contextInjector, 'buildSystemPromptForRegime').mockResolvedValue({
      full: 'test-prompt',
      identityContent: 'test-hash',
    });

    await (runtime as unknown as { _runReact: (m: Message[]) => Promise<void> })._runReact([
      { role: 'user', content: 'test' },
    ]);

    // stopRequested was reset to false at turn start
    expect(runtime.execContext.stopRequested).toBe(false);
    // LLM was actually called (not early-exited)
    expect(mockLLM.call).toHaveBeenCalledTimes(1);
  });

  it('regression: turn N done call does not silence turn N+1', async () => {
    const deps = await makeRuntimeDeps({ clawDir, clawId: 'test-claw' });
    const runtime = new Runtime({
      clawId: 'test-claw',
      clawDir,
      llmConfig: createMockLLMConfig(),
      dependencies: deps,
    });
    runtimesToStop.push(runtime);

    const mockLLM = createMockLLM([
      { content: [{ type: 'text', text: 'turn 1 ok' }], stop_reason: 'end_turn' },
      { content: [{ type: 'text', text: 'turn 2 ok' }], stop_reason: 'end_turn' },
    ]);

    await runtime.initialize();
    (runtime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

    vi.spyOn(runtime.contextInjector, 'buildSystemPromptForRegime').mockResolvedValue({
      full: 'test-prompt',
      identityContent: 'test-hash',
    });

    // Turn 1
    await (runtime as unknown as { _runReact: (m: Message[]) => Promise<void> })._runReact([
      { role: 'user', content: 'turn 1' },
    ]);

    // Simulate done tool execution setting stopRequested=true after turn 1
    runtime.execContext.stopRequested = true;

    // Turn 2 — without the reset fix, this would silently empty-return
    await (runtime as unknown as { _runReact: (m: Message[]) => Promise<void> })._runReact([
      { role: 'user', content: 'turn 2' },
    ]);

    // Verify turn 2 LLM was called (not silent empty due to sticky stopRequested)
    expect(mockLLM.call).toHaveBeenCalledTimes(2);
  });
});
