import { legacyTestProviderFactory } from '../helpers/llm-provider.js';
import { vi } from 'vitest';
import { Runtime } from '../../src/core/runtime/index.js';
import { makeRuntimeDeps, TEST_LLM_RETRY_DELAY_MS } from '../helpers/runtime-deps.js';
import type { LLMOrchestratorConfig, LLMStreamChunk } from '../../src/foundation/llm-orchestrator/types.js';
import type { LLMResponse } from '../../src/foundation/llm-provider/types.js';
import type { AuditLog } from '../../src/foundation/audit/types.js';
import { TEST_LLM_TIMEOUT_MS } from '../helpers/test-timeouts.js';

/**
 * Convert LLMResponse to stream chunks for mock
 */
export async function* responseToStreamChunks(response: LLMResponse): AsyncIterableIterator<LLMStreamChunk> {
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

export async function createTestRuntime(options: {
  clawId: string;
  clawDir: string;
  llmConfig: LLMOrchestratorConfig;
  maxSteps?: number;
  toolProfile?: string;
  maxConcurrentTasks?: number;
  /** phase 379: optional AuditLog override (passed through to makeRuntimeDeps) */
  auditOverride?: AuditLog;
}) {
  const deps = await makeRuntimeDeps({
    clawDir: options.clawDir,
    clawId: options.clawId,
    llmConfig: options.llmConfig,
    auditOverride: options.auditOverride,
  });
  return new Runtime({
    ...options,
    dependencies: deps,
  });
}

export function createMockLLMConfig(): LLMOrchestratorConfig {
  return {
    primary: {
      providerId: 'mock',
      authentication: { kind: 'api_key', value: 'test-key' },
      model: 'test-model',
      defaults: {
        maxTokens: 1024,
        temperature: 0.7,
        timeoutMs: TEST_LLM_TIMEOUT_MS,
      },
      apiFormat: 'anthropic',
    },
    maxAttempts: 1,
    retryDelayMs: TEST_LLM_RETRY_DELAY_MS,
    events: { emit: () => {} },
    providerFactory: legacyTestProviderFactory(connection => ({ name: connection.providerId, model: connection.model }) as never,),
  };
}

export function createMockLLM(responses: LLMResponse[]) {
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
