import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { createShadowTool } from '../../../src/core/shadow-system/index.js';
import type { Message, ToolDefinition } from '../../../src/foundation/llm-provider/types.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { ToolRegistryImpl } from '../../../src/foundation/tools/registry.js';
import { createDoneTool, DONE_TOOL_NAME } from '../../../src/core/subagent/index.js';

import { NoopAuditWriter } from '../../../src/core/subagent/noop-writers.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import type { LLMResponse, StreamChunk } from '../../../src/foundation/llm-provider/types.js';

/**
 * Convert LLMResponse to stream chunks for mock
 * (duplicate from tests/core/task.test.ts:30+49 per Step A decision Q4 YAGNI)
 */
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

function createMockLLM(responses: LLMResponse[]): LLMOrchestrator {
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
  } as unknown as LLMOrchestrator;
}

describe('shadow integration (phase 784, real SubAgent path)', () => {
  let tempDir: string;
  let fs: NodeFileSystem;
  let registry: ToolRegistryImpl;
  let shadowTool: ReturnType<typeof createShadowTool>;


  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  beforeEach(async () => {
    tempDir = await createTempDir('phase784-shadow-');
    fs = new NodeFileSystem({ baseDir: tempDir });
    registry = new ToolRegistryImpl();
    registry.register(createDoneTool());
    shadowTool = createShadowTool({
      getTurnSnapshot: () => ({
        systemPrompt: 'sp',
        tools: [] as ToolDefinition[],
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-shadow-1', name: 'shadow', input: { task: 'X' } }] },
        ],
      }),
    });
  });

  function makeBaseCtx(mockLLM: LLMOrchestrator): ExecContextImpl {
    return new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: tempDir,
      syncDir: path.join(tempDir, 'tasks', 'sync'),
      profile: 'full',
      fs,
      auditWriter: new NoopAuditWriter(),
      llm: mockLLM,
      registry,
      currentToolUseId: 'tu-shadow-1',
      maxSteps: 10,
    });
  }

  it('done capture: shadow LLM calls done → finalResult is captured.result, source=done', async () => {
    const mockLLM = createMockLLM([
      {
        content: [
          { type: 'text', text: 'I will submit' },
          { type: 'tool_use', id: 'call-done-1', name: DONE_TOOL_NAME, input: { result: 'Task X completed' } },
        ],
        stop_reason: 'tool_use',
      },
    ]);
    const baseCtx = makeBaseCtx(mockLLM);

    const result = await shadowTool.execute({ task: 'Test done capture', async: false }, baseCtx);

    expect(result.success).toBe(true);
    expect(result.content).toBe('Task X completed');
    expect(result.metadata?.source).toBe('done');
  });

  it('text fallback: shadow LLM ends with text only (no done) → finalResult is text, source=text (phase 780 isolation regression)', async () => {
    const mockLLM = createMockLLM([
      {
        content: [{ type: 'text', text: 'Done without submit_subtask tool' }],
        stop_reason: 'end_turn',
      },
    ]);
    const baseCtx = makeBaseCtx(mockLLM);

    const result = await shadowTool.execute({ task: 'Test text fallback', async: false }, baseCtx);

    expect(result.success).toBe(true);
    expect(result.content).toBe('Done without submit_subtask tool');
    expect(result.metadata?.source).toBe('text');
  });
});
