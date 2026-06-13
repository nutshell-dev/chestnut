/**
 * Task system + SubAgent tests
 */

import { describe, expect, vi } from 'vitest';
import { test } from '../helpers/task-test-fixture.js';
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
import type { LLMResponse } from '../../src/foundation/llm-provider/types.js';
import type { LLMOrchestrator } from '../../src/foundation/llm-orchestrator/index.js';
import type { StreamChunk } from '../../src/foundation/llm-orchestrator/types.js';
import { TASK_AUDIT_EVENTS } from '../../src/core/async-task-system/audit-events.js';
import { SUBAGENT_AUDIT_EVENTS } from '../../src/core/subagent/audit-events.js';
import { TEST_LLM_TIMEOUT_MS, SUBAGENT_DEFAULT_TIMEOUT_MS, SUBAGENT_WAIT_TIMEOUT_MS, SUBAGENT_LONG_TIMEOUT_MS } from '../helpers/test-timeouts.js';
import { SUBAGENT_TIMEOUT_MS } from '../../src/core/subagent/constants.js';
import { makeAudit, makeMockAudit, waitForAuditEvent } from '../helpers/audit.js';
import { createTestTaskSystem, createMockWatcherFactory } from '../helpers/task-system.js';
import { waitFor } from '../helpers/wait-for.js';

/**
 * Mock slow stream chunk 间隔 (50ms): 等 abort signal 中段触发 / 慢逐 chunk yield.
 * Derivation: > microtask flush / 给 mid-execution cancel 触发窗口.
 */
const MOCK_SLOW_STREAM_GAP_MS = 50;

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

  describe('AsyncTaskSystem', () => {
    test('should schedule subagent and return taskId', async ({ ctx }) => {
      // Recreate with hanging LLM so task stays in running state for verification
      await ctx.taskSystem.shutdown(1);
      ctx.replaceTaskSystem(createTestTaskSystem(ctx.tempDir, ctx.mockFs, makeAudit().audit, createHangingMockLLM(), { createWatcher: ctx.createWatcher }));
      await ctx.taskSystem.initialize();
      ctx.taskSystem.startDispatch();
      
      const taskId = await ctx.taskSystem.scheduleSubAgent({
        kind: 'subagent',
        mode: 'standard',
        intent: 'Test task',
        timeoutMs: SUBAGENT_DEFAULT_TIMEOUT_MS,
        maxSteps: 10,
        parentClawId: 'parent-claw',
      });

      expect(taskId).toBeDefined();
      expect(typeof taskId).toBe('string');

      // Wait for dispatch to move from pending to running (file on disk)
      await waitFor(() => ctx.mockFs.exists(`tasks/queues/running/${taskId}.json`));

      // Check task is tracked in running list
      expect(ctx.taskSystem.listRunning()).toContain(taskId);
    });

    test('should pass subagent task through watcher → ingest → dispatch chain (phase163)', async ({ ctx }) => {
      await ctx.taskSystem.shutdown(1);
      ctx.replaceTaskSystem(createTestTaskSystem(ctx.tempDir, ctx.mockFs, makeAudit().audit, createHangingMockLLM(), { createWatcher: ctx.createWatcher }));
      await ctx.taskSystem.initialize();
      ctx.taskSystem.startDispatch();

      const taskId = await ctx.taskSystem.scheduleSubAgent({
        kind: 'subagent',
        mode: 'standard',
        intent: 'watcher chain probe',
        timeoutMs: SUBAGENT_DEFAULT_TIMEOUT_MS,
        maxSteps: 5,
        parentClawId: 'parent-claw',
      });

      // 1. scheduleSubAgent 写文件后立即可见于 pending/
      expect(await ctx.mockFs.exists(`tasks/queues/pending/${taskId}.json`)).toBe(true);

      // 2. watcher 拾起 → _ingestPendingFile → _dispatch → movePendingToRunning（异步，给足时间）
      await waitFor(async () => {
        return await ctx.mockFs.exists(`tasks/queues/running/${taskId}.json`);
      }, 10000); // was 3000

      // 3. pending/ 文件已被移走
      expect(await ctx.mockFs.exists(`tasks/queues/pending/${taskId}.json`)).toBe(false);
      expect(await ctx.mockFs.exists(`tasks/queues/running/${taskId}.json`)).toBe(true);

      // 4. listRunning 反映状态
      expect(ctx.taskSystem.listRunning()).toContain(taskId);
    });

    test('should move task to done when completed', async ({ ctx }) => {
      // Recreate with mock LLM that returns quickly
      await ctx.taskSystem.shutdown(1);
      const { audit, events, emitter } = makeAudit();
      ctx.replaceTaskSystem(createTestTaskSystem(ctx.tempDir, ctx.mockFs, audit, createMockLLM([{
        content: [{ type: 'text', text: 'Task result' }],
        stop_reason: 'end_turn',
      }]), { createWatcher: ctx.createWatcher }));
      await ctx.taskSystem.initialize();
      ctx.taskSystem.startDispatch();

      const taskId = await ctx.taskSystem.scheduleSubAgent({
        kind: 'subagent',
        mode: 'standard',
        intent: 'Simple task',
        timeoutMs: SUBAGENT_DEFAULT_TIMEOUT_MS,
        maxSteps: 5,
        parentClawId: 'parent-claw',
      });

      // Wait for TASK_COMPLETED audit event (phase 1143 — was waitFor fs poll, flaky)
      await waitForAuditEvent(emitter, events, TASK_AUDIT_EVENTS.TASK_COMPLETED);

      // Allow brief fs flush after audit event (R1: emit may slightly precede writeAtomic).
      // Budget derive: typical fs.move on local tmpfs ~5ms × CI safety (×200) = 1000ms.
      // 比 default 5s budget 紧 5×、保 regression 可见（若 move 真退化到 >1s 立 fail-loud）。
      const POST_AUDIT_FS_FLUSH_BUDGET_MS = 1000;
      await waitFor(() => ctx.mockFs.exists(`tasks/queues/done/${taskId}.json`), POST_AUDIT_FS_FLUSH_BUDGET_MS);

      // Task should be moved to done
      const doneExists = await ctx.mockFs.exists(`tasks/queues/done/${taskId}.json`);
      expect(doneExists).toBe(true);

      // Running file should not exist
      const runningExists = await ctx.mockFs.exists(`tasks/queues/running/${taskId}.json`);
      expect(runningExists).toBe(false);

      // phase 805: runSubagent 不再创建 tasks/subagents/<id>/ orphan empty dir
      // (sub-3 fix: 该 dir 0 业务用途，line 77 derive 后仅 ensureDir 无 fs 写入)
    });

    test('should deliver subagent result to inbox/pending/*.md (bypass transport)', async ({ ctx }) => {
      await ctx.taskSystem.shutdown(1);
      const { audit, events, emitter } = makeAudit();
      ctx.replaceTaskSystem(createTestTaskSystem(ctx.tempDir, ctx.mockFs, audit, createMockLLM([{
        content: [{ type: 'text', text: 'Subagent output' }],
        stop_reason: 'end_turn',
      }]), { createWatcher: ctx.createWatcher }));
      await ctx.taskSystem.initialize();
      ctx.taskSystem.startDispatch();

      const taskId = await ctx.taskSystem.scheduleSubAgent({
        kind: 'subagent',
        mode: 'standard',
        intent: 'Deliver result',
        timeoutMs: SUBAGENT_DEFAULT_TIMEOUT_MS,
        maxSteps: 5,
        parentClawId: 'motion',
      });

      // Wait for TASK_COMPLETED instead of polling inbox (phase 779 Step C)
      await waitForAuditEvent(emitter, events, TASK_AUDIT_EVENTS.TASK_COMPLETED);

      const inboxDir = path.join(ctx.tempDir, 'inbox', 'pending');

      // Result must be in inbox/pending/ (relative to clawDir=ctx.tempDir), NOT in claws/motion/inbox
      const inboxFiles = await fs.readdir(inboxDir).catch(() => [] as string[]);
      expect(inboxFiles.length).toBeGreaterThan(0);
      expect(inboxFiles.every((f: string) => f.endsWith('.md'))).toBe(true);

      // Parse the message and verify frontmatter (phase 259: use static fs at top)
      const content = await fs.readFile(path.join(inboxDir, inboxFiles[0]), 'utf-8');
      expect(content).toContain('from: "subagent"');
      expect(content).toContain('to: "motion"');
      expect(content).toContain(`"resultRef":"tasks/queues/results/${taskId}/result.txt"`);
    });

    test('should cancel task', async ({ ctx }) => {
      // Use a slow but cancellable mock LLM
      // It yields text slowly so we can cancel mid-execution
      async function* slowStream(): AsyncIterableIterator<StreamChunk> {
        yield { type: 'text_delta', delta: 'Starting' };
        // Wait a bit, then check for abort
        await new Promise(r => setTimeout(r, MOCK_SLOW_STREAM_GAP_MS));
        yield { type: 'text_delta', delta: '...' };
        await new Promise(r => setTimeout(r, MOCK_SLOW_STREAM_GAP_MS));
        yield { type: 'text_delta', delta: '...' };
        await new Promise(r => setTimeout(r, MOCK_SLOW_STREAM_GAP_MS));
        yield { type: 'done' };
      }
      
      await ctx.taskSystem.shutdown(1);
      ctx.replaceTaskSystem(createTestTaskSystem(ctx.tempDir, ctx.mockFs, makeAudit().audit, {
        call: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'Completed' }],
          stop_reason: 'end_turn',
        }),
        stream: vi.fn().mockReturnValue(slowStream()),
        close: vi.fn(),
        healthCheck: vi.fn().mockResolvedValue(true),
        getProviderInfo: vi.fn().mockReturnValue({ name: 'mock', model: 'test', isFallback: false }),
      } as unknown as LLMOrchestrator, { createWatcher: ctx.createWatcher }));
      await ctx.taskSystem.initialize();
      ctx.taskSystem.startDispatch();
      
      const taskId = await ctx.taskSystem.scheduleSubAgent({
        kind: 'subagent',
        mode: 'standard',
        intent: 'Long running task',
        timeoutMs: SUBAGENT_TIMEOUT_MS,  // phase 1159: 用 src 真常量替 magic 300000
        maxSteps: 10,
        parentClawId: 'parent-claw',
      });

      // Wait for task to be dispatched to running
      await waitFor(() => ctx.taskSystem.listRunning().includes(taskId));

      // Verify task is in running state
      expect(ctx.taskSystem.listRunning()).toContain(taskId);

      await ctx.taskSystem.cancel(taskId);

      // Task should be removed from running
      expect(ctx.taskSystem.listRunning()).not.toContain(taskId);
      const runningExists = await ctx.mockFs.exists(`tasks/queues/running/${taskId}.json`);
      expect(runningExists).toBe(false);
    });

    test('should write task_completed event to audit on subagent success', async ({ ctx }) => {
      await ctx.taskSystem.shutdown(1);
      const { audit, events, emitter } = makeAudit();
      ctx.replaceTaskSystem(createTestTaskSystem(ctx.tempDir, ctx.mockFs, audit, createMockLLM([{
        content: [{ type: 'text', text: 'task done' }],
        stop_reason: 'end_turn',
      }]), { createWatcher: ctx.createWatcher }));
      await ctx.taskSystem.initialize();
      ctx.taskSystem.startDispatch();

      const taskId = await ctx.taskSystem.scheduleSubAgent({
        kind: 'subagent',
        mode: 'standard',
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
            expect.stringContaining('taskId='),
          ]),
        ])
      );
    });

    test('should write task_completed err to audit when subagent times out', async ({ ctx }) => {
      await ctx.taskSystem.shutdown(1);
      const { audit, events, emitter } = makeAudit();
      ctx.replaceTaskSystem(createTestTaskSystem(ctx.tempDir, ctx.mockFs, audit, createAbortableHangingMockLLM(), { createWatcher: ctx.createWatcher }));
      await ctx.taskSystem.initialize();
      ctx.taskSystem.startDispatch();

      const taskId = await ctx.taskSystem.scheduleSubAgent({
        kind: 'subagent',
        mode: 'standard',
        intent: 'This will time out',
        timeoutMs: 300,   // 300ms，触发 SubAgent timeout
        maxSteps: 5,
        parentClawId: 'test-claw',
      });

      // 等待超时触发 + 任务完成 + inbox 写入
      await waitFor(async () => {
        const files = await fs.readdir(path.join(ctx.tempDir, 'inbox', 'pending')).catch(() => []);
        return (files as string[]).filter(f => f.endsWith('.md')).length > 0;
      });

      // inbox 中有 is_error: true 的消息（验证 executeTask catch 被执行）
      const inboxDir = path.join(ctx.tempDir, 'inbox', 'pending');
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
            expect.stringContaining('taskId='),
            'err',
            expect.stringMatching(/^elapsed_ms=\d+$/),
          ]),
        ])
      );

      // phase 805: runSubagent 不再创建 tasks/subagents/<id>/ orphan empty dir (sub-3 fix)
    });

    test('should write fallback inbox message when main sendResult fails', async ({ ctx }) => {
      // 第一次对 inbox/pending 的写入失败，第二次（fallback）成功
      let inboxWriteAttempts = 0;
      const patchedFs = new NodeFileSystem({ baseDir: ctx.tempDir });
      const originalWriteAtomic = patchedFs.writeAtomic.bind(patchedFs);
      patchedFs.writeAtomic = async (filePath: string, content: string) => {
        if (filePath.startsWith('inbox/pending/') && inboxWriteAttempts++ === 0) {
          throw new Error('Simulated inbox write failure');
        }
        return originalWriteAtomic(filePath, content);
      };

      const { factory: patchedWatcher } = createMockWatcherFactory(patchedFs);
      const failSystem = createTestTaskSystem(ctx.tempDir, patchedFs, makeAudit().audit, createMockLLM([{
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
      }]), { createWatcher: patchedWatcher });
      await failSystem.initialize();
      failSystem.startDispatch();

      const taskId = await failSystem.scheduleSubAgent({
        kind: 'subagent',
        mode: 'standard',
        intent: 'test fallback',
        timeoutMs: SUBAGENT_LONG_TIMEOUT_MS,
        maxSteps: 5,
        parentClawId: 'test-claw',
      });

      await waitFor(async () => {
        const files = await fs.readdir(path.join(ctx.tempDir, 'inbox', 'pending')).catch(() => []);
        return (files as string[]).filter(f => f.endsWith('.md')).length > 0;
      });
      await failSystem.shutdown(1000);

      // fallback 消息应该存在于 inbox
      const inboxDir = path.join(ctx.tempDir, 'inbox', 'pending');
      const files = await fs.readdir(inboxDir).catch(() => [] as string[]);
      const mdFiles = (files as string[]).filter(f => f.endsWith('.md'));
      expect(mdFiles.length).toBeGreaterThan(0);

      // fallback 消息包含 taskId 和 is_error
      const content = await fs.readFile(path.join(inboxDir, mdFiles[0]), 'utf-8');
      expect(content).toContain(taskId);
      expect(content).toContain('is_error');
    });

    test('should write fallback inbox message when movePendingToRunning fails', async ({ ctx }) => {
      const patchedFs = new NodeFileSystem({ baseDir: ctx.tempDir });
      const originalMove = patchedFs.move.bind(patchedFs);
      patchedFs.move = async (from: string, to: string) => {
        if (from.startsWith('tasks/queues/pending/') && to.startsWith('tasks/queues/running/')) {
          throw new Error('Simulated move failure');
        }
        return originalMove(from, to);
      };

      const { audit } = makeAudit();
      const { factory: patchedWatcher } = createMockWatcherFactory(patchedFs);
      const failSystem = createTestTaskSystem(ctx.tempDir, patchedFs, audit, createMockLLM([{
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
      }]), { createWatcher: patchedWatcher });
      await failSystem.initialize();
      failSystem.startDispatch();

      const taskId = await failSystem.scheduleSubAgent({
        kind: 'subagent',
        mode: 'standard',
        intent: 'test move failure',
        timeoutMs: SUBAGENT_LONG_TIMEOUT_MS,
        maxSteps: 5,
        parentClawId: 'test-claw',
      });

      const inboxDir = path.join(ctx.tempDir, 'inbox', 'pending');
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
        15000, // was 10000
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

    test('should write TASK_SHUTDOWN_TIMEOUT audit event when shutdown times out', async ({ ctx }) => {
      await ctx.taskSystem.shutdown(1);
      const { audit, events, emitter } = makeAudit();
      ctx.replaceTaskSystem(createTestTaskSystem(ctx.tempDir, ctx.mockFs, audit, createHangingMockLLM(), { createWatcher: ctx.createWatcher }));
      await ctx.taskSystem.initialize();
      ctx.taskSystem.startDispatch();

      const taskId = await ctx.taskSystem.scheduleSubAgent({
        kind: 'subagent',
        mode: 'standard',
        intent: 'Hanging task',
        timeoutMs: SUBAGENT_DEFAULT_TIMEOUT_MS,
        maxSteps: 5,
        parentClawId: 'test-claw',
      });

      // Wait for task to be dispatched to running
      await waitFor(() => ctx.taskSystem.listRunning().includes(taskId));

      // Shutdown with 1ms timeout to force timeout path
      await ctx.taskSystem.shutdown(1);

      // Wait for cleanups to drain before asserting audit events (phase 779 Step B/C)
      await waitForAuditEvent(emitter, events, TASK_AUDIT_EVENTS.SHUTDOWN_TIMEOUT);

      expect(events).toEqual(
        expect.arrayContaining([
          expect.arrayContaining([TASK_AUDIT_EVENTS.SHUTDOWN_TIMEOUT]),
        ])
      );
    });

    test('should not throw when shutdown times out with null auditWriter', async ({ ctx }) => {
      await ctx.taskSystem.shutdown(1);
      ctx.replaceTaskSystem(createTestTaskSystem(ctx.tempDir, ctx.mockFs, { write: () => {} } as any, createHangingMockLLM(), { createWatcher: ctx.createWatcher }));
      await ctx.taskSystem.initialize();
      ctx.taskSystem.startDispatch();

      const taskId = await ctx.taskSystem.scheduleSubAgent({
        kind: 'subagent',
        mode: 'standard',
        intent: 'Hanging task',
        timeoutMs: SUBAGENT_DEFAULT_TIMEOUT_MS,
        maxSteps: 5,
        parentClawId: 'test-claw',
      });

      // Wait for task to be dispatched to running
      await waitFor(() => ctx.taskSystem.listRunning().includes(taskId));

      // Should not throw even with null auditWriter
      await expect(ctx.taskSystem.shutdown(1)).resolves.not.toThrow();
    });

    describe('addPostProcessor / postProcessor field', () => {
      test('should throw when registering duplicate name', ({ ctx }) => {
        const mockProcessor = vi.fn();
        ctx.taskSystem.addPostProcessor('test-proc', mockProcessor as any);
        expect(() => ctx.taskSystem.addPostProcessor('test-proc', mockProcessor as any)).toThrow(
          'PostProcessor "test-proc" already registered',
        );
      });

      test('should call postProcessor on success path', async ({ ctx }) => {
        await ctx.taskSystem.shutdown(1);
        const { audit, events, emitter } = makeAudit();
        const mockProcessor = vi.fn().mockResolvedValue('transformed-result');
        ctx.replaceTaskSystem(createTestTaskSystem(ctx.tempDir, ctx.mockFs, audit, createMockLLM([{
          content: [{ type: 'text', text: 'raw result' }],
          stop_reason: 'end_turn',
        }]), { createWatcher: ctx.createWatcher }));
        ctx.taskSystem.addPostProcessor('test-proc', mockProcessor as any);
        await ctx.taskSystem.initialize();
        ctx.taskSystem.startDispatch();

        await ctx.taskSystem.scheduleSubAgent({
          kind: 'subagent',
            mode: 'standard',
          intent: 'Test postProcessor',
          timeoutMs: SUBAGENT_DEFAULT_TIMEOUT_MS,
          maxSteps: 5,
          parentClawId: 'motion',
          postProcessor: 'test-proc',
        });

        // TASK_COMPLETED 在 subagent-executor.ts sendResult 之后 emit，
        // 是 inbox 文件写入的因果后置单调信号（取代 polling inbox 目录）。
        await waitForAuditEvent(emitter, events, TASK_AUDIT_EVENTS.TASK_COMPLETED);
        const inboxDir = path.join(ctx.tempDir, 'inbox', 'pending');

        expect(mockProcessor).toHaveBeenCalledTimes(1);
        const callArgs = mockProcessor.mock.calls[0];
        expect(callArgs[0]).toBe('raw result');
        expect(callArgs[2]).toBe(false); // isError
        expect(callArgs[3]).toBe(ctx.mockFs); // fs
        expect(callArgs[4]).toBe(audit); // audit

        // Inbox should contain transformed result
        const inboxFiles = await fs.readdir(inboxDir).catch(() => [] as string[]);
        const mdFiles = (inboxFiles as string[]).filter(f => f.endsWith('.md'));
        const content = await fs.readFile(path.join(inboxDir, mdFiles[0]), 'utf-8');
        expect(content).toContain('transformed-result');
      });

      test('should call postProcessor on error path with isError=true', async ({ ctx }) => {
        await ctx.taskSystem.shutdown(1);
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
        ctx.replaceTaskSystem(createTestTaskSystem(ctx.tempDir, ctx.mockFs, audit, undefined, { createWatcher: ctx.createWatcher }));
        ctx.taskSystem.addPostProcessor('test-proc-err', capturingProcessor as any);
        await ctx.taskSystem.initialize();
        ctx.taskSystem.startDispatch();

        const taskId = await ctx.taskSystem.scheduleSubAgent({
          kind: 'subagent',
            mode: 'standard',
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

      test('should audit when postProcessor name not found in registry', async ({ ctx }) => {
        await ctx.taskSystem.shutdown(1);
        const { audit, events, emitter } = makeAudit();
        ctx.replaceTaskSystem(createTestTaskSystem(ctx.tempDir, ctx.mockFs, audit, createMockLLM([{
          content: [{ type: 'text', text: 'raw result' }],
          stop_reason: 'end_turn',
        }]), { createWatcher: ctx.createWatcher }));
        await ctx.taskSystem.initialize();
        ctx.taskSystem.startDispatch();

        const taskId = await ctx.taskSystem.scheduleSubAgent({
          kind: 'subagent',
            mode: 'standard',
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
});
