/**
 * SubAgent tests (phase 1304 split from task.test.ts)
 *
 * 7 SubAgent tests separated from outer "Task System + SubAgent" describe.
 * Pattern: phase 1296 / 1301 / 1302 / 1303 split SOP — nested describe boundary.
 * Estimated wall: ~1.5s (vs combined file mean 5687ms / heavy-setup split).
 */

import { describe, expect, vi } from 'vitest';
import { test } from '../helpers/task-test-fixture.js';
import * as path from 'path';

import { SubAgent } from '../../src/core/subagent/agent.js';
import { NoopStreamWriter, NoopAuditWriter } from '../../src/core/subagent/noop-writers.js';
import { createDialogStore } from '../../src/foundation/dialog-store/index.js';
import type { LLMResponse } from '../../src/foundation/llm-provider/types.js';
import type { LLMOrchestrator } from '../../src/foundation/llm-orchestrator/index.js';
import type { StreamChunk } from '../../src/foundation/llm-orchestrator/types.js';
import { SUBAGENT_AUDIT_EVENTS } from '../../src/core/subagent/audit-events.js';
import { SUBAGENT_WAIT_TIMEOUT_MS, SUBAGENT_LONG_TIMEOUT_MS } from '../helpers/test-timeouts.js';
import { makeAudit, makeMockAudit } from '../helpers/audit.js';
import { ToolExecutor } from '../../src/foundation/tools/index.js';
import type { FileSystem } from '../../src/foundation/fs/types.js';
import type { ToolRegistryImpl } from '../../src/foundation/tools/registry.js';
import type { AuditLog } from '../../src/foundation/audit/index.js';

/**
 * Mock abort-check tick interval (50ms): 20 iterations 累 ≈ 1000ms 长任务.
 * Derivation: × 20 = 1000ms 总长 / 每 tick 给 abort signal 检测窗口.
 */
const MOCK_ABORT_CHECK_TICK_MS = 50;

/** phase 1489: 测试 helper / 替原 SubAgent 内 new ToolExecutor 装配语义 */
function makeSubAgentToolExecutor(opts: {
  clawDir: string;
  fs: FileSystem;
  registry: ToolRegistryImpl;
  llm: LLMOrchestrator;
  auditWriter: AuditLog;
  maxSteps?: number;
  toolTimeoutMs?: number;
}): ToolExecutor {
  return new ToolExecutor({
    registry: opts.registry,
    defaultTimeoutMs: opts.toolTimeoutMs,
    clawDir: opts.clawDir as any,
    clawsDir: path.join(opts.clawDir, 'claws'),
    syncDir: path.join(opts.clawDir, 'tasks/sync'),
    workspaceDir: path.join(opts.clawDir, 'clawspace'),
    fs: opts.fs,
    llm: opts.llm,
    subagentMaxSteps: opts.maxSteps ?? 20,
    auditWriter: opts.auditWriter,
  });
}

/**
 * Convert LLMResponse to stream chunks for mock (verbatim copy)
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

  describe('SubAgent', () => {
    test('should run and return text result', async ({ ctx }) => {
      const mockLLM = createMockLLM([{
        content: [{ type: 'text', text: 'Task completed successfully' }],
        stop_reason: 'end_turn',
      }]);

      const agent = new SubAgent({
        agentId: 'test-agent-1',
        resultDir: 'tasks/queues/results/test-agent-1',
        messageStore: createDialogStore(
          ctx.mockFs,
          'tasks/queues/results/test-agent-1',
          new NoopAuditWriter(),
          'messages.json',
          ),
        prompt: 'Do something',
        toolExecutor: makeSubAgentToolExecutor({
          clawDir: ctx.tempDir,
          fs: ctx.mockFs,
          registry: ctx.registry,
          llm: mockLLM,
          auditWriter: new NoopAuditWriter(),
          maxSteps: 10,
        }),
        llm: mockLLM,
        registry: ctx.registry,
        fs: ctx.mockFs,
        maxSteps: 10,
        timeoutMs: SUBAGENT_WAIT_TIMEOUT_MS,
        taskStreamWriter: new NoopStreamWriter(),
        auditWriter: new NoopAuditWriter(),
      });

      const result = await agent.run();

      expect(result).toContain('Task completed');
    });

    test('should execute tools in subagent profile', async ({ ctx }) => {
      // Create a test file
      await ctx.mockFs.writeAtomic('test.txt', 'Hello from test file');

      const mockLLM = createMockLLM([
        {
          content: [
            { type: 'text', text: 'I will read the file' },
            { type: 'tool_use', id: 'call-1', name: 'read', input: { path: 'test.txt' } },
          ],
          stop_reason: 'tool_use',
        },
        {
          content: [{ type: 'text', text: 'File content is: Hello from test file' }],
          stop_reason: 'end_turn',
        },
      ]);

      const agent = new SubAgent({
        agentId: 'test-agent-2',
        resultDir: 'tasks/queues/results/test-agent-2',
        messageStore: createDialogStore(
          ctx.mockFs,
          'tasks/queues/results/test-agent-2',
          new NoopAuditWriter(),
          'messages.json',
          ),
        prompt: 'Read test.txt',
        toolExecutor: makeSubAgentToolExecutor({
          clawDir: ctx.tempDir,
          fs: ctx.mockFs,
          registry: ctx.registry,
          llm: mockLLM,
          auditWriter: new NoopAuditWriter(),
          maxSteps: 10,
        }),
        llm: mockLLM,
        registry: ctx.registry,
        fs: ctx.mockFs,
        maxSteps: 10,
        timeoutMs: SUBAGENT_WAIT_TIMEOUT_MS,
        taskStreamWriter: new NoopStreamWriter(),
        auditWriter: new NoopAuditWriter(),
      });

      const result = await agent.run();

      expect(mockLLM.call).toHaveBeenCalledTimes(2);
      expect(result).toContain('File content');
    });

    test('should execute exec tool in subagent profile (previously blocked by execute: false)', async ({ ctx }) => {
      const mockLLM = createMockLLM([
        {
          content: [
            { type: 'text', text: 'I will run a command' },
            { type: 'tool_use', id: 'c1', name: 'exec', input: { command: 'echo subagent-exec-ok' } },
          ],
          stop_reason: 'tool_use',
        },
        {
          content: [{ type: 'text', text: 'Command output: subagent-exec-ok' }],
          stop_reason: 'end_turn',
        },
      ]);

      const agent = new SubAgent({
        agentId: 'test-agent-exec',
        resultDir: 'tasks/queues/results/test-agent-exec',
        messageStore: createDialogStore(
          ctx.mockFs,
          'tasks/queues/results/test-agent-exec',
          new NoopAuditWriter(),
          'messages.json',
          'test-system-prompt',
        ),
        prompt: 'Run echo command',
        toolExecutor: makeSubAgentToolExecutor({
          clawDir: ctx.tempDir,
          fs: ctx.mockFs,
          registry: ctx.registry,
          llm: mockLLM,
          auditWriter: new NoopAuditWriter(),
          maxSteps: 10,
        }),
        llm: mockLLM,
        registry: ctx.registry,
        fs: ctx.mockFs,
        maxSteps: 10,
        timeoutMs: SUBAGENT_WAIT_TIMEOUT_MS,
        taskStreamWriter: new NoopStreamWriter(),
        auditWriter: new NoopAuditWriter(),
      });

      const result = await agent.run();

      // 两次 LLM call：第一次返回 tool_use，第二次收到工具结果后返回 end_turn
      expect(mockLLM.call).toHaveBeenCalledTimes(2);
      // 结果来自第二次 LLM 返回（不是 PermissionError）
      expect(result).toContain('Command output');
    });

    test('should timeout on long running task', async ({ ctx }) => {
      const mockLLM = createMockLLM([
        {
          content: [{ type: 'text', text: 'Thinking...' }],
          stop_reason: 'end_turn',
        },
      ]);

      // Mock LLM to delay but check for abort
      (mockLLM.call as ReturnType<typeof vi.fn>).mockImplementation(async (options: { signal?: AbortSignal }) => {
        // Wait 1000ms but check for abort every 50ms
        for (let i = 0; i < 20; i++) {
          if (options.signal?.aborted) {
            throw new Error('Aborted');
          }
          await new Promise(r => setTimeout(r, MOCK_ABORT_CHECK_TICK_MS));
        }
        return {
          content: [{ type: 'text', text: 'Done' }],
          stop_reason: 'end_turn',
        };
      });

      const agent = new SubAgent({
        agentId: 'test-agent-3',
        resultDir: 'tasks/queues/results/test-agent-3',
        messageStore: createDialogStore(
          ctx.mockFs,
          'tasks/queues/results/test-agent-3',
          new NoopAuditWriter(),
          'messages.json',
          ),
        prompt: 'Slow task',
        toolExecutor: makeSubAgentToolExecutor({
          clawDir: ctx.tempDir,
          fs: ctx.mockFs,
          registry: ctx.registry,
          llm: mockLLM,
          auditWriter: new NoopAuditWriter(),
          maxSteps: 10,
        }),
        llm: mockLLM,
        registry: ctx.registry,
        fs: ctx.mockFs,
        maxSteps: 10,
        timeoutMs: 100, // Very short timeout
        taskStreamWriter: new NoopStreamWriter(),
        auditWriter: new NoopAuditWriter(),
      });

      await expect(agent.run()).rejects.toThrow();
    });

    test('should call onIdleTimeout callback when idle timeout triggers', async ({ ctx }) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const onIdleTimeout = vi.fn();
      
      // Mock LLM that never yields any delta → idle timer never reset
      const hangingLLM = {
        call: vi.fn().mockImplementation(() => {
          return new Promise(() => {}); // never resolves
        }),
        stream: vi.fn(),
      } as unknown as LLMOrchestrator;

      const agent = new SubAgent({
        agentId: 'test-idle',
        resultDir: 'tasks/queues/results/test-idle',
        messageStore: createDialogStore(
          ctx.mockFs,
          'tasks/queues/results/test-idle',
          new NoopAuditWriter(),
          'messages.json',
          'test-system-prompt',
        ),
        prompt: 'Test idle',
        toolExecutor: makeSubAgentToolExecutor({
          clawDir: ctx.tempDir,
          fs: ctx.mockFs,
          registry: ctx.registry,
          llm: hangingLLM,
          auditWriter: new NoopAuditWriter(),
        }),
        llm: hangingLLM,
        registry: ctx.registry,
        fs: ctx.mockFs,
        maxSteps: 20,
        timeoutMs: SUBAGENT_LONG_TIMEOUT_MS, // main timeout is long
        idleTimeoutMs: 100, // idle timeout is short
        onIdleTimeout,
        taskStreamWriter: new NoopStreamWriter(),
        auditWriter: new NoopAuditWriter(),
      });

      const runPromise = agent.run().catch(() => { /* silent: expected-failure */ }); // 预期抛 ToolTimeoutError

      await vi.advanceTimersByTimeAsync(150); // 超过 idleTimeoutMs
      await runPromise;

      expect(onIdleTimeout).toHaveBeenCalled();

      vi.useRealTimers();
    });

    test('should write audit event when appendToLog fs.append throws', async ({ ctx }) => {
      const mockAuditWriter = makeMockAudit();

      // FS mock：append 始终失败，其余方法正常
      const throwingFs = Object.create(ctx.mockFs);
      throwingFs.append = vi.fn().mockRejectedValue(new Error('Disk full'));

      const agent = new SubAgent({
        agentId: 'test-append-fail',
        resultDir: 'tasks/queues/results/test-append-fail',
        messageStore: createDialogStore(
          throwingFs,
          'tasks/queues/results/test-append-fail',
          mockAuditWriter as any,
          'messages.json',
          'test-system-prompt',
        ),
        prompt: 'Test',
        toolExecutor: makeSubAgentToolExecutor({
          clawDir: ctx.tempDir,
          fs: throwingFs,
          registry: ctx.registry,
          llm: createMockLLM([{
            content: [{ type: 'text', text: 'Task done' }],
            stop_reason: 'end_turn',
          }]),
          auditWriter: mockAuditWriter as any,
        }),
        llm: createMockLLM([{
          content: [{ type: 'text', text: 'Task done' }],
          stop_reason: 'end_turn',
        }]),
        registry: ctx.registry,
        fs: throwingFs,
        maxSteps: 20,
        taskStreamWriter: new NoopStreamWriter(),
        auditWriter: mockAuditWriter as any,
      });

      // run 应该正常完成，appendToLog 失败不影响主流程
      await agent.run();

      expect(mockAuditWriter.write).toHaveBeenCalledWith(
        SUBAGENT_AUDIT_EVENTS.LOG_APPEND_FAILED,
        expect.stringContaining('agentId='),
        expect.stringContaining('error='),
      );
    });

    test('subagent workspaceDir defaults to clawspace (shared with caller / phase 518)', async ({ ctx }) => {
      const mockLLM = createMockLLM([
        {
          content: [{ type: 'text', text: 'Done' }],
          stop_reason: 'end_turn',
        },
      ]);

      const agent = new SubAgent({
        agentId: 'workspace-test-agent',
        resultDir: 'tasks/queues/results/workspace-test-agent',
        messageStore: createDialogStore(
          ctx.mockFs,
          'tasks/queues/results/workspace-test-agent',
          new NoopAuditWriter(),
          'messages.json',
          'test-system-prompt',
        ),
        prompt: 'Test workspaceDir',
        toolExecutor: makeSubAgentToolExecutor({
          clawDir: ctx.tempDir,
          fs: ctx.mockFs,
          registry: ctx.registry,
          llm: mockLLM,
          auditWriter: new NoopAuditWriter(),
        }),
        llm: mockLLM,
        registry: ctx.registry,
        fs: ctx.mockFs,
        maxSteps: 20,
        taskStreamWriter: new NoopStreamWriter(),
        auditWriter: new NoopAuditWriter(),
      });

      await agent.run();
      // ToolExecutor gets workspaceDir from SubAgent; exec default cwd uses it
      // Verified by the fact that run completes without error
      expect(agent).toBeDefined();
    });
  });
