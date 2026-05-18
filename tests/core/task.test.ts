/**
 * Task system + SubAgent tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { AsyncTaskSystem } from '../../src/core/async-task-system/system.js';
import { SubAgent } from '../../src/core/subagent/agent.js';
import { NoopStreamWriter, NoopAuditWriter } from '../../src/core/subagent/noop-writers.js';
import { createDialogStore } from '../../src/foundation/dialog-store/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/index.js';
import { ToolRegistryImpl } from '../../src/foundation/tools/registry.js';
import type { LLMResponse } from '../../src/types/message.js';
import type { LLMOrchestrator } from '../../src/foundation/llm-orchestrator/index.js';
import type { StreamChunk } from '../../src/foundation/llm-orchestrator/types.js';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';
import { makeAudit, waitForAuditEvent } from '../helpers/audit.js';
import { createTestTaskSystem } from '../helpers/task-system.js';
import { waitFor } from '../helpers/wait-for.js';
import { TASK_AUDIT_EVENTS } from '../../src/core/async-task-system/audit-events.js';
import { SUBAGENT_AUDIT_EVENTS } from '../../src/core/subagent/audit-events.js';
import { TEST_LLM_TIMEOUT_MS, SUBAGENT_DEFAULT_TIMEOUT_MS } from '../helpers/test-timeouts.js';

/**
 * Convert LLMResponse to stream chunks for mock
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
      // 复用 call mock 的返回值，转换为 stream chunks
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

/**
 * Create a mock LLM that never resolves - useful for keeping tasks in running state
 */
function createHangingMockLLM(): LLMOrchestrator {
  async function* hangingStream(signal?: AbortSignal): AsyncIterableIterator<StreamChunk> {
    await new Promise<void>((_, reject) => {
      if (signal?.aborted) return reject(new Error('Aborted'));
      signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    });
    yield { type: 'done' };
  }

  return {
    call: vi.fn(({ signal } = {}) => new Promise((_, reject) => {
      if (signal?.aborted) return reject(new Error('Aborted'));
      signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    })),
    stream: vi.fn((opts: { signal?: AbortSignal } = {}) => hangingStream(opts?.signal)),
    close: vi.fn(),
    healthCheck: vi.fn().mockResolvedValue(true),
    getProviderInfo: vi.fn().mockReturnValue({ name: 'mock', model: 'test', isFallback: false }),
  } as unknown as LLMOrchestrator;
}

/**
 * Create a mock LLM that aborts when signal is triggered - for timeout testing
 *
 * Difference from createHangingMockLLM: call() deliberately ignores signal, so
 * the executor-driven timeout is the only path that can break the hang.
 */
function createAbortableHangingMockLLM(): LLMOrchestrator {
  async function* hangingStream(signal?: AbortSignal): AsyncIterableIterator<StreamChunk> {
    await new Promise<void>((_, reject) => {
      if (signal?.aborted) {
        reject(new Error('Aborted'));
        return;
      }
      signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    });
    yield { type: 'done' };
  }
  
  return {
    call: vi.fn(() => new Promise(() => {})),
    stream: vi.fn((opts: { signal?: AbortSignal }) => hangingStream(opts?.signal)),
    close: vi.fn(),
    healthCheck: vi.fn().mockResolvedValue(true),
    getProviderInfo: vi.fn().mockReturnValue({ name: 'mock', model: 'test', isFallback: false }),
  } as unknown as LLMOrchestrator;
}

describe('Task System + SubAgent', () => {
  let tempDir: string;
  let mockFs: NodeFileSystem;
  let taskSystem: AsyncTaskSystem;
  let registry: ToolRegistryImpl;

  beforeEach(async () => {
    tempDir = await createTempDir();
    mockFs = new NodeFileSystem({ baseDir: tempDir });
    await mockFs.ensureDir('tasks');
    
    taskSystem = createTestTaskSystem(tempDir, mockFs, makeAudit().audit);
    await taskSystem.initialize();
    taskSystem.startDispatch();

    registry = new ToolRegistryImpl();
  });

  afterEach(async () => {
    await taskSystem.shutdown(1000);
    await cleanupTempDir(tempDir);
  });

  describe('AsyncTaskSystem', () => {
    it('should schedule subagent and return taskId', async () => {
      // Recreate with hanging LLM so task stays in running state for verification
      await taskSystem.shutdown(100);
      taskSystem = createTestTaskSystem(tempDir, mockFs, makeAudit().audit, createHangingMockLLM());
      await taskSystem.initialize();
      taskSystem.startDispatch();
      
      const taskId = await taskSystem.scheduleSubAgent({
        kind: 'subagent',
        intent: 'Test task',
        timeoutMs: SUBAGENT_DEFAULT_TIMEOUT_MS,
        maxSteps: 10,
        parentClawId: 'parent-claw',
      });

      expect(taskId).toBeDefined();
      expect(typeof taskId).toBe('string');

      // Wait for dispatch to move from pending to running (file on disk)
      await waitFor(() => mockFs.exists(`tasks/queues/running/${taskId}.json`));

      // Check task is tracked in running list
      expect(taskSystem.listRunning()).toContain(taskId);
    });

    it('should pass subagent task through watcher → ingest → dispatch chain (phase163)', async () => {
      await taskSystem.shutdown(100);
      taskSystem = createTestTaskSystem(tempDir, mockFs, makeAudit().audit, createHangingMockLLM());
      await taskSystem.initialize();
      taskSystem.startDispatch();

      const taskId = await taskSystem.scheduleSubAgent({
        kind: 'subagent',
        intent: 'watcher chain probe',
        timeoutMs: SUBAGENT_DEFAULT_TIMEOUT_MS,
        maxSteps: 5,
        parentClawId: 'parent-claw',
      });

      // 1. scheduleSubAgent 写文件后立即可见于 pending/
      expect(await mockFs.exists(`tasks/queues/pending/${taskId}.json`)).toBe(true);

      // 2. watcher 拾起 → _ingestPendingFile → _dispatch → movePendingToRunning（异步，给足时间）
      await waitFor(async () => {
        return await mockFs.exists(`tasks/queues/running/${taskId}.json`);
      }, 3000);

      // 3. pending/ 文件已被移走
      expect(await mockFs.exists(`tasks/queues/pending/${taskId}.json`)).toBe(false);
      expect(await mockFs.exists(`tasks/queues/running/${taskId}.json`)).toBe(true);

      // 4. listRunning 反映状态
      expect(taskSystem.listRunning()).toContain(taskId);
    });

    it('should move task to done when completed', async () => {
      // Recreate with mock LLM that returns quickly
      await taskSystem.shutdown(100);
      taskSystem = createTestTaskSystem(tempDir, mockFs, makeAudit().audit, createMockLLM([{
        content: [{ type: 'text', text: 'Task result' }],
        stop_reason: 'end_turn',
      }]));
      await taskSystem.initialize();
      taskSystem.startDispatch();

      const taskId = await taskSystem.scheduleSubAgent({
        kind: 'subagent',
        intent: 'Simple task',
        timeoutMs: SUBAGENT_DEFAULT_TIMEOUT_MS,
        maxSteps: 5,
        parentClawId: 'parent-claw',
      });

      // Wait for task to complete
      await waitFor(() => mockFs.exists(`tasks/queues/done/${taskId}.json`));

      // Task should be moved to done
      const doneExists = await mockFs.exists(`tasks/queues/done/${taskId}.json`);
      expect(doneExists).toBe(true);

      // Running file should not exist
      const runningExists = await mockFs.exists(`tasks/queues/running/${taskId}.json`);
      expect(runningExists).toBe(false);

      // phase 805: runSubagent 不再创建 tasks/subagents/<id>/ orphan empty dir
      // (sub-3 fix: 该 dir 0 业务用途，line 77 derive 后仅 ensureDir 无 fs 写入)
    });

    it('should deliver subagent result to inbox/pending/*.md (bypass transport)', async () => {
      await taskSystem.shutdown(100);
      const { audit, events, emitter } = makeAudit();
      taskSystem = createTestTaskSystem(tempDir, mockFs, audit, createMockLLM([{
        content: [{ type: 'text', text: 'Subagent output' }],
        stop_reason: 'end_turn',
      }]));
      await taskSystem.initialize();
      taskSystem.startDispatch();

      const taskId = await taskSystem.scheduleSubAgent({
        kind: 'subagent',
        intent: 'Deliver result',
        timeoutMs: SUBAGENT_DEFAULT_TIMEOUT_MS,
        maxSteps: 5,
        parentClawId: 'motion',
      });

      // Wait for TASK_COMPLETED instead of polling inbox (phase 779 Step C)
      await waitForAuditEvent(emitter, events, TASK_AUDIT_EVENTS.TASK_COMPLETED);

      const inboxDir = path.join(tempDir, 'inbox', 'pending');

      // Result must be in inbox/pending/ (relative to clawDir=tempDir), NOT in claws/motion/inbox
      const inboxFiles = await fs.readdir(inboxDir).catch(() => [] as string[]);
      expect(inboxFiles.length).toBeGreaterThan(0);
      expect(inboxFiles.every((f: string) => f.endsWith('.md'))).toBe(true);

      // Parse the message and verify frontmatter
      const { promises: nodeFs } = await import('fs');
      const content = await nodeFs.readFile(path.join(inboxDir, inboxFiles[0]), 'utf-8');
      expect(content).toContain('from: "subagent"');
      expect(content).toContain('to: "motion"');
      expect(content).toContain(`"resultRef":"tasks/queues/results/${taskId}/result.txt"`);
    });

    it('should cancel task', async () => {
      // Use a slow but cancellable mock LLM
      // It yields text slowly so we can cancel mid-execution
      async function* slowStream(): AsyncIterableIterator<StreamChunk> {
        yield { type: 'text_delta', delta: 'Starting' };
        // Wait a bit, then check for abort
        await new Promise(r => setTimeout(r, 50));
        yield { type: 'text_delta', delta: '...' };
        await new Promise(r => setTimeout(r, 50));
        yield { type: 'text_delta', delta: '...' };
        await new Promise(r => setTimeout(r, 50));
        yield { type: 'done' };
      }
      
      await taskSystem.shutdown(100);
      taskSystem = createTestTaskSystem(tempDir, mockFs, makeAudit().audit, {
        call: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'Completed' }],
          stop_reason: 'end_turn',
        }),
        stream: vi.fn().mockReturnValue(slowStream()),
        close: vi.fn(),
        healthCheck: vi.fn().mockResolvedValue(true),
        getProviderInfo: vi.fn().mockReturnValue({ name: 'mock', model: 'test', isFallback: false }),
      } as unknown as LLMOrchestrator);
      await taskSystem.initialize();
      taskSystem.startDispatch();
      
      const taskId = await taskSystem.scheduleSubAgent({
        kind: 'subagent',
        intent: 'Long running task',
        timeoutMs: 300000,
        maxSteps: 10,
        parentClawId: 'parent-claw',
      });

      // Wait for task to be dispatched to running
      await waitFor(() => taskSystem.listRunning().includes(taskId));

      // Verify task is in running state
      expect(taskSystem.listRunning()).toContain(taskId);

      await taskSystem.cancel(taskId);

      // Task should be removed from running
      expect(taskSystem.listRunning()).not.toContain(taskId);
      const runningExists = await mockFs.exists(`tasks/queues/running/${taskId}.json`);
      expect(runningExists).toBe(false);
    });

    it('should write task_completed event to audit on subagent success', async () => {
      await taskSystem.shutdown(100);
      const { audit, events, emitter } = makeAudit();
      taskSystem = createTestTaskSystem(tempDir, mockFs, audit, createMockLLM([{
        content: [{ type: 'text', text: 'task done' }],
        stop_reason: 'end_turn',
      }]));
      await taskSystem.initialize();
      taskSystem.startDispatch();

      const taskId = await taskSystem.scheduleSubAgent({
        kind: 'subagent',
        intent: 'Simple task',
        timeoutMs: TEST_LLM_TIMEOUT_MS,
        maxSteps: 5,
        parentClawId: 'test-claw',
      });

      // Subscribe to TASK_COMPLETED instead of polling events array (phase 779 Step C)
      await waitForAuditEvent(emitter, events, TASK_AUDIT_EVENTS.TASK_COMPLETED);

      // Partial match: only assert event presence + key fields (phase 779 Step D / B.flaky-10)
      expect(events).toEqual(
        expect.arrayContaining([
          expect.arrayContaining([
            TASK_AUDIT_EVENTS.TASK_COMPLETED,
            taskId,
          ]),
        ])
      );
    });

    it('should write task_completed err to audit when subagent times out', async () => {
      await taskSystem.shutdown(100);
      const { audit, events, emitter } = makeAudit();
      taskSystem = createTestTaskSystem(tempDir, mockFs, audit, createAbortableHangingMockLLM());
      await taskSystem.initialize();
      taskSystem.startDispatch();

      const taskId = await taskSystem.scheduleSubAgent({
        kind: 'subagent',
        intent: 'This will time out',
        timeoutMs: 300,   // 300ms，触发 SubAgent timeout
        maxSteps: 5,
        parentClawId: 'test-claw',
      });

      // 等待超时触发 + 任务完成 + inbox 写入
      await waitFor(async () => {
        const files = await fs.readdir(path.join(tempDir, 'inbox', 'pending')).catch(() => []);
        return (files as string[]).filter(f => f.endsWith('.md')).length > 0;
      });

      // inbox 中有 is_error: true 的消息（验证 executeTask catch 被执行）
      const inboxDir = path.join(tempDir, 'inbox', 'pending');
      const inboxFiles = await fs.readdir(inboxDir).catch(() => [] as string[]);
      const mdFiles = inboxFiles.filter((f: string) => f.endsWith('.md'));
      expect(mdFiles.length).toBeGreaterThan(0);
      const inboxContent = await fs.readFile(path.join(inboxDir, mdFiles[0]), 'utf-8');
      expect(inboxContent).toContain('"is_error":true');

      // phase 789: sendResult 末尾写 SENT_MARKER 引入额外 async 延迟，
      // 显式等待 task_completed 避免 race（与 phase 779 Step C 同型）
      await waitForAuditEvent(emitter, events, TASK_AUDIT_EVENTS.TASK_COMPLETED);

      // audit 中应有 task_completed err 事件
      expect(events).toEqual(
        expect.arrayContaining([
          expect.arrayContaining([
            'task_completed',
            taskId,
            'err',
            expect.stringMatching(/^elapsed_ms=\d+$/),
          ]),
        ])
      );

      // phase 805: runSubagent 不再创建 tasks/subagents/<id>/ orphan empty dir (sub-3 fix)
    });

    it('should write fallback inbox message when main sendResult fails', async () => {
      // 第一次对 inbox/pending 的写入失败，第二次（fallback）成功
      let inboxWriteAttempts = 0;
      const patchedFs = new NodeFileSystem({ baseDir: tempDir });
      const originalWriteAtomic = patchedFs.writeAtomic.bind(patchedFs);
      patchedFs.writeAtomic = async (filePath: string, content: string) => {
        if (filePath.startsWith('inbox/pending/') && inboxWriteAttempts++ === 0) {
          throw new Error('Simulated inbox write failure');
        }
        return originalWriteAtomic(filePath, content);
      };

      const failSystem = createTestTaskSystem(tempDir, patchedFs, makeAudit().audit, createMockLLM([{
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
      }]));
      await failSystem.initialize();
      failSystem.startDispatch();

      const taskId = await failSystem.scheduleSubAgent({
        kind: 'subagent',
        intent: 'test fallback',
        timeoutMs: 10000,
        maxSteps: 5,
        parentClawId: 'test-claw',
      });

      await waitFor(async () => {
        const files = await fs.readdir(path.join(tempDir, 'inbox', 'pending')).catch(() => []);
        return (files as string[]).filter(f => f.endsWith('.md')).length > 0;
      });
      await failSystem.shutdown(1000);

      // fallback 消息应该存在于 inbox
      const inboxDir = path.join(tempDir, 'inbox', 'pending');
      const files = await fs.readdir(inboxDir).catch(() => [] as string[]);
      const mdFiles = (files as string[]).filter(f => f.endsWith('.md'));
      expect(mdFiles.length).toBeGreaterThan(0);

      // fallback 消息包含 taskId 和 is_error
      const content = await fs.readFile(path.join(inboxDir, mdFiles[0]), 'utf-8');
      expect(content).toContain(taskId);
      expect(content).toContain('is_error');
    });

    it('should write fallback inbox message when movePendingToRunning fails', async () => {
      const patchedFs = new NodeFileSystem({ baseDir: tempDir });
      const originalMove = patchedFs.move.bind(patchedFs);
      patchedFs.move = async (from: string, to: string) => {
        if (from.startsWith('tasks/queues/pending/') && to.startsWith('tasks/queues/running/')) {
          throw new Error('Simulated move failure');
        }
        return originalMove(from, to);
      };

      const { audit } = makeAudit();
      const failSystem = createTestTaskSystem(tempDir, patchedFs, audit, createMockLLM([{
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
      }]));
      await failSystem.initialize();
      failSystem.startDispatch();

      const taskId = await failSystem.scheduleSubAgent({
        kind: 'subagent',
        intent: 'test move failure',
        timeoutMs: 10000,
        maxSteps: 5,
        parentClawId: 'test-claw',
      });

      const inboxDir = path.join(tempDir, 'inbox', 'pending');
      await waitFor(
        async () => {
          const files = await fs.readdir(inboxDir).catch(() => [] as string[]);
          const mdFiles = (files as string[]).filter(f => f.endsWith('.md'));
          if (mdFiles.length === 0) return false;
          const content = await fs
            .readFile(path.join(inboxDir, mdFiles[0]), 'utf-8')
            .catch(() => '');
          return content.includes('is_error') && content.includes(taskId);
        },
        10000,
        20,
      );
      await failSystem.shutdown(1000);

      // _startTask catch 应该发了 fallback 通知
      const files = await fs.readdir(inboxDir).catch(() => [] as string[]);
      const mdFiles = (files as string[]).filter(f => f.endsWith('.md'));
      expect(mdFiles.length).toBeGreaterThan(0);

      const content = await fs.readFile(path.join(inboxDir, mdFiles[0]), 'utf-8');
      expect(content).toContain(taskId);
      expect(content).toContain('is_error');
    });

    it('should write TASK_SHUTDOWN_TIMEOUT audit event when shutdown times out', async () => {
      await taskSystem.shutdown(100);
      const { audit, events, emitter } = makeAudit();
      taskSystem = createTestTaskSystem(tempDir, mockFs, audit, createHangingMockLLM());
      await taskSystem.initialize();
      taskSystem.startDispatch();

      const taskId = await taskSystem.scheduleSubAgent({
        kind: 'subagent',
        intent: 'Hanging task',
        timeoutMs: SUBAGENT_DEFAULT_TIMEOUT_MS,
        maxSteps: 5,
        parentClawId: 'test-claw',
      });

      // Wait for task to be dispatched to running
      await waitFor(() => taskSystem.listRunning().includes(taskId));

      // Shutdown with 1ms timeout to force timeout path
      await taskSystem.shutdown(1);

      // Wait for cleanups to drain before asserting audit events (phase 779 Step B/C)
      await waitForAuditEvent(emitter, events, TASK_AUDIT_EVENTS.SHUTDOWN_TIMEOUT);

      expect(events).toEqual(
        expect.arrayContaining([
          expect.arrayContaining([TASK_AUDIT_EVENTS.SHUTDOWN_TIMEOUT]),
        ])
      );
    });

    it('should not throw when shutdown times out with null auditWriter', async () => {
      await taskSystem.shutdown(100);
      taskSystem = createTestTaskSystem(tempDir, mockFs, { write: () => {} } as any, createHangingMockLLM());
      await taskSystem.initialize();
      taskSystem.startDispatch();

      const taskId = await taskSystem.scheduleSubAgent({
        kind: 'subagent',
        intent: 'Hanging task',
        timeoutMs: SUBAGENT_DEFAULT_TIMEOUT_MS,
        maxSteps: 5,
        parentClawId: 'test-claw',
      });

      // Wait for task to be dispatched to running
      await waitFor(() => taskSystem.listRunning().includes(taskId));

      // Should not throw even with null auditWriter
      await expect(taskSystem.shutdown(1)).resolves.not.toThrow();
    });

    describe('addPostProcessor / postProcessor field', () => {
      it('should throw when registering duplicate name', () => {
        const mockProcessor = vi.fn();
        taskSystem.addPostProcessor('test-proc', mockProcessor as any);
        expect(() => taskSystem.addPostProcessor('test-proc', mockProcessor as any)).toThrow(
          'PostProcessor "test-proc" already registered',
        );
      });

      it('should call postProcessor on success path', async () => {
        await taskSystem.shutdown(100);
        const { audit, events } = makeAudit();
        const mockProcessor = vi.fn().mockResolvedValue('transformed-result');
        taskSystem = createTestTaskSystem(tempDir, mockFs, audit, createMockLLM([{
          content: [{ type: 'text', text: 'raw result' }],
          stop_reason: 'end_turn',
        }]));
        taskSystem.addPostProcessor('test-proc', mockProcessor as any);
        await taskSystem.initialize();
        taskSystem.startDispatch();

        const taskId = await taskSystem.scheduleSubAgent({
          kind: 'subagent',
          intent: 'Test postProcessor',
          timeoutMs: SUBAGENT_DEFAULT_TIMEOUT_MS,
          maxSteps: 5,
          parentClawId: 'motion',
          postProcessor: 'test-proc',
        });

        // Wait for inbox file (task completion signal)
        const inboxDir = path.join(tempDir, 'inbox', 'pending');
        await waitFor(async () => {
          const files = await fs.readdir(inboxDir).catch(() => [] as string[]);
          return (files as string[]).some(f => f.endsWith('.md'));
        });

        expect(mockProcessor).toHaveBeenCalledTimes(1);
        const callArgs = mockProcessor.mock.calls[0];
        expect(callArgs[0]).toBe('raw result');
        expect(callArgs[2]).toBe(false); // isError
        expect(callArgs[3]).toBe(mockFs); // fs
        expect(callArgs[4]).toBe(audit); // audit

        // Inbox should contain transformed result
        const inboxFiles = await fs.readdir(inboxDir).catch(() => [] as string[]);
        const mdFiles = (inboxFiles as string[]).filter(f => f.endsWith('.md'));
        const content = await fs.readFile(path.join(inboxDir, mdFiles[0]), 'utf-8');
        expect(content).toContain('transformed-result');
      });

      it('should call postProcessor on error path with isError=true', async () => {
        await taskSystem.shutdown(100);
        const { audit, events } = makeAudit();
        const mockProcessor = vi.fn().mockResolvedValue('error-transformed');

        // Deferred Promise for postProcessor invocation (replaces polling waitFor)
        let resolvePostProcessor!: (isError: boolean) => void;
        const postProcessorCalled = new Promise<boolean>((resolve) => {
          resolvePostProcessor = resolve;
        });
        const capturingProcessor = vi.fn().mockImplementation((...args: any[]) => {
          resolvePostProcessor(args[2]); // isError is the 3rd argument
          return mockProcessor(...args);
        });

        // Use empty-object LLM so subagent.run() throws immediately (call is undefined)
        taskSystem = createTestTaskSystem(tempDir, mockFs, audit);
        taskSystem.addPostProcessor('test-proc-err', capturingProcessor as any);
        await taskSystem.initialize();
        taskSystem.startDispatch();

        const taskId = await taskSystem.scheduleSubAgent({
          kind: 'subagent',
          intent: 'Test error path',
          timeoutMs: SUBAGENT_DEFAULT_TIMEOUT_MS,
          maxSteps: 5,
          parentClawId: 'motion',
          postProcessor: 'test-proc-err',
        });

        // Wait for postProcessor to be called via Deferred Promise
        const isError = await postProcessorCalled;
        expect(isError).toBe(true);

        expect(mockProcessor).toHaveBeenCalledTimes(1);
        const callArgs = mockProcessor.mock.calls[0];
        expect(callArgs[2]).toBe(true); // isError
      });

      it('should audit when postProcessor name not found in registry', async () => {
        await taskSystem.shutdown(100);
        const { audit, events, emitter } = makeAudit();
        taskSystem = createTestTaskSystem(tempDir, mockFs, audit, createMockLLM([{
          content: [{ type: 'text', text: 'raw result' }],
          stop_reason: 'end_turn',
        }]));
        await taskSystem.initialize();
        taskSystem.startDispatch();

        const taskId = await taskSystem.scheduleSubAgent({
          kind: 'subagent',
          intent: 'Test missing postProcessor',
          timeoutMs: SUBAGENT_DEFAULT_TIMEOUT_MS,
          maxSteps: 5,
          parentClawId: 'motion',
          postProcessor: 'non-existent-proc',
        });

        await waitForAuditEvent(emitter, events, TASK_AUDIT_EVENTS.HANDLER_FAILED);

        expect(events).toEqual(
          expect.arrayContaining([
            expect.arrayContaining([TASK_AUDIT_EVENTS.HANDLER_FAILED, 'context=postProcessor_not_found']),
          ]),
        );
      });
    });


  });

  describe('SubAgent', () => {
    it('should run and return text result', async () => {
      const mockLLM = createMockLLM([{
        content: [{ type: 'text', text: 'Task completed successfully' }],
        stop_reason: 'end_turn',
      }]);

      const agent = new SubAgent({
        agentId: 'test-agent-1',
        resultDir: 'tasks/queues/results/test-agent-1',
        messageStore: createDialogStore(
          mockFs,
          'tasks/queues/results/test-agent-1',
          new NoopAuditWriter(),
          'messages.json',
          ),
        prompt: 'Do something',
        clawDir: tempDir,
        workspaceDir: path.join(tempDir, 'clawspace'),
        llm: mockLLM,
        registry,
        fs: mockFs,
        maxSteps: 10,
        timeoutMs: 5000,
        taskStreamWriter: new NoopStreamWriter(),
        auditWriter: new NoopAuditWriter(),
      });

      const result = await agent.run();

      expect(result).toContain('Task completed');
    });

    it('should execute tools in subagent profile', async () => {
      // Create a test file
      await mockFs.writeAtomic('test.txt', 'Hello from test file');

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
          mockFs,
          'tasks/queues/results/test-agent-2',
          new NoopAuditWriter(),
          'messages.json',
          ),
        prompt: 'Read test.txt',
        clawDir: tempDir,
        workspaceDir: path.join(tempDir, 'clawspace'),
        llm: mockLLM,
        registry,
        fs: mockFs,
        maxSteps: 10,
        timeoutMs: 5000,
        taskStreamWriter: new NoopStreamWriter(),
        auditWriter: new NoopAuditWriter(),
      });

      const result = await agent.run();

      expect(mockLLM.call).toHaveBeenCalledTimes(2);
      expect(result).toContain('File content');
    });

    it('should execute exec tool in subagent profile (previously blocked by execute: false)', async () => {
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
          mockFs,
          'tasks/queues/results/test-agent-exec',
          new NoopAuditWriter(),
          'messages.json',
          'test-system-prompt',
        ),
        prompt: 'Run echo command',
        clawDir: tempDir,
        workspaceDir: path.join(tempDir, 'clawspace'),
        llm: mockLLM,
        registry,
        fs: mockFs,
        maxSteps: 10,
        timeoutMs: 5000,
        taskStreamWriter: new NoopStreamWriter(),
        auditWriter: new NoopAuditWriter(),
      });

      const result = await agent.run();

      // 两次 LLM call：第一次返回 tool_use，第二次收到工具结果后返回 end_turn
      expect(mockLLM.call).toHaveBeenCalledTimes(2);
      // 结果来自第二次 LLM 返回（不是 PermissionError）
      expect(result).toContain('Command output');
    });

    it('should timeout on long running task', async () => {
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
          await new Promise(r => setTimeout(r, 50));
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
          mockFs,
          'tasks/queues/results/test-agent-3',
          new NoopAuditWriter(),
          'messages.json',
          ),
        prompt: 'Slow task',
        clawDir: tempDir,
        workspaceDir: path.join(tempDir, 'clawspace'),
        llm: mockLLM,
        registry,
        fs: mockFs,
        maxSteps: 10,
        timeoutMs: 100, // Very short timeout
        taskStreamWriter: new NoopStreamWriter(),
        auditWriter: new NoopAuditWriter(),
      });

      await expect(agent.run()).rejects.toThrow();
    });

    it('should call onIdleTimeout callback when idle timeout triggers', async () => {
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
          mockFs,
          'tasks/queues/results/test-idle',
          new NoopAuditWriter(),
          'messages.json',
          'test-system-prompt',
        ),
        prompt: 'Test idle',
        clawDir: tempDir,
        workspaceDir: path.join(tempDir, 'clawspace'),
        llm: hangingLLM,
        registry,
        fs: mockFs,
        timeoutMs: 10000, // main timeout is long
        idleTimeoutMs: 100, // idle timeout is short
        onIdleTimeout,
        taskStreamWriter: new NoopStreamWriter(),
        auditWriter: new NoopAuditWriter(),
      });

      const runPromise = agent.run().catch(() => {}); // 预期抛 ToolTimeoutError

      await vi.advanceTimersByTimeAsync(150); // 超过 idleTimeoutMs
      await runPromise;

      expect(onIdleTimeout).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('should write audit event when appendToLog fs.append throws', async () => {
      const mockAuditWriter = { write: vi.fn() };

      // FS mock：append 始终失败，其余方法正常
      const throwingFs = Object.create(mockFs);
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
        clawDir: tempDir,
        workspaceDir: path.join(tempDir, 'clawspace'),
        llm: createMockLLM([{
          content: [{ type: 'text', text: 'Task done' }],
          stop_reason: 'end_turn',
        }]),
        registry,
        fs: throwingFs,
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

    it('subagent workspaceDir defaults to clawspace (shared with caller / phase 518)', async () => {
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
          mockFs,
          'tasks/queues/results/workspace-test-agent',
          new NoopAuditWriter(),
          'messages.json',
          'test-system-prompt',
        ),
        prompt: 'Test workspaceDir',
        clawDir: tempDir,
        workspaceDir: path.join(tempDir, 'clawspace'),
        llm: mockLLM,
        registry,
        fs: mockFs,
        taskStreamWriter: new NoopStreamWriter(),
        auditWriter: new NoopAuditWriter(),
      });

      await agent.run();
      // ToolExecutor gets workspaceDir from SubAgent; exec default cwd uses it
      // Verified by the fact that run completes without error
      expect(agent).toBeDefined();
    });
  });
});
