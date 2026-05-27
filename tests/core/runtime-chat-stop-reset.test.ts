/**
 * Runtime.chat() stopRequested reset tests — phase 900
 *
 * Covers:
 * - stopRequested reset to false at chat() entry (symmetric to _runReact:432)
 * - regression: previous abort's stopRequested=true does not silence next chat()
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { TestRuntime } from '../helpers/test-runtime.js';
import { makeRuntimeDeps } from '../helpers/runtime-deps.js';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';
import type { LLMOrchestratorConfig } from '../../src/foundation/llm-orchestrator/types.js';
import type { LLMResponse } from '../../src/foundation/llm-provider/types.js';
import type { StreamChunk } from '../../src/foundation/llm-orchestrator/types.js';
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
    getProviderInfo: vi.fn().mockReturnValue({ name: 'mock', model: 'test-model', isFallback: false }),
  };
}

describe('runtime chat() stopRequested reset (phase 900)', () => {
  let tempDir: string;
  let clawDir: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    tempDir = path.join(tmpdir(), `claw-test-${randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
    clawDir = path.join(tempDir, 'claws', 'test-claw');
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('resets execContext.stopRequested from true to false at chat() entry', async () => {
    const deps = await makeRuntimeDeps({ clawDir, clawId: 'test-claw' });
    const runtime = new TestRuntime({
      clawId: 'test-claw',
      clawDir,
      llmConfig: createMockLLMConfig(),
      dependencies: deps,
    });

    const mockLLM = createMockLLM([{
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    }]);

    await runtime.initialize();
    runtime.testSetLLM(mockLLM);

    vi.spyOn(runtime.contextInjector, 'buildSystemPromptForRegime').mockResolvedValue({
      full: 'test-prompt',
      identityContent: 'test-hash',
    });

    // Simulate previous turn's abort leaving stopRequested=true
    runtime.execContext.stopRequested = true;

    const result = await runtime.chat('test message');

    // stopRequested was reset to false at chat() entry
    expect(runtime.execContext.stopRequested).toBe(false);
    // LLM was actually called (not early-exited due to sticky stopRequested)
    expect(mockLLM.call).toHaveBeenCalledTimes(1);
    // Result is the mock LLM response, not empty string from early exit
    expect(result).toBe('ok');
  });
});
