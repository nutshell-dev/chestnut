/**
 * Runtime RetryOutboxInterrupt integration tests
 */

import type { RuntimeTestInternals } from '../helpers/runtime-test-internals.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { Runtime } from '../../src/core/runtime/index.js';
import { makeRuntimeDeps } from '../helpers/runtime-deps.js';
import { MaxStepsExceededError } from '../../src/core/agent-executor/errors.js';
import type { InboxMessage } from '../../src/foundation/messaging/types.js';
import type { Message } from '../../src/foundation/llm-provider/types.js';
import { IdleTimeoutSignal, PriorityInboxInterrupt, UserInterrupt } from '../../src/core/signals.js';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';
import { createTestRuntime, createMockLLMConfig, createMockLLM } from './_runtime-test-helpers.js';
import { handleTurnInterrupt } from '../../src/core/runtime/error-response.js';


describe('Runtime RetryOutboxInterrupt', () => {
  let tempDir: string;
  let clawDir: string;
  const runtimesToStop: Runtime[] = [];

  function trackRuntime(r: Runtime): Runtime {
    runtimesToStop.push(r);
    return r;
  }

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

  describe('retryLastTurn()', () => {
    it('returns immediately when session has no messages (empty session guard)', async () => {
      const runtime = trackRuntime(await createTestRuntime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
      }));
      await runtime.initialize();

      const mockLLM = createMockLLM([]);
      (runtime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

      // No messages have been exchanged — session is empty
      await expect(runtime.retryLastTurn()).resolves.toBeUndefined();

      // LLM must NOT have been called
      expect(mockLLM.call).not.toHaveBeenCalled();
      expect(mockLLM.stream).not.toHaveBeenCalled();
    });

    it('replays last turn by calling LLM with existing session messages', async () => {
      const runtime = trackRuntime(await createTestRuntime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
      }));
      await runtime.initialize();

      // Populate session via chat()
      const firstLLM = createMockLLM([{
        content: [{ type: 'text', text: 'Initial answer' }],
        stop_reason: 'end_turn',
      }]);
      (runtime as unknown as { llm: typeof firstLLM }).llm = firstLLM;
      await runtime.chat('What is 2+2?');

      // Now replace LLM and retry — should call the NEW LLM with the saved session
      const retryLLM = createMockLLM([{
        content: [{ type: 'text', text: 'Retry answer' }],
        stop_reason: 'end_turn',
      }]);
      (runtime as unknown as { llm: typeof retryLLM }).llm = retryLLM;

      await runtime.retryLastTurn();

      expect(retryLLM.call).toHaveBeenCalledTimes(1);
      const callArg = retryLLM.call.mock.calls[0][0];
      // The session messages from the first chat() exchange are included
      expect(callArg.messages.map((m: any) => m.role)).toEqual(['user', 'assistant']);
    });

    it('cleans up AbortController even when _runReact throws', async () => {
      const runtime = trackRuntime(await createTestRuntime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
      }));
      await runtime.initialize();

      // Build a session first
      const setupLLM = createMockLLM([
        { content: [{ type: 'text', text: 'setup' }], stop_reason: 'end_turn' },
      ]);
      (runtime as unknown as { llm: typeof setupLLM }).llm = setupLLM;
      await runtime.chat('setup');

      // Replace LLM with one that throws
      const failingLLM = {
        call: vi.fn().mockRejectedValue(new Error('LLM network error')),
        stream: vi.fn().mockImplementation(async function* () { throw new Error('LLM network error'); }),
        close: vi.fn(),
        healthCheck: vi.fn().mockResolvedValue(true),
      };
      (runtime as unknown as { llm: typeof failingLLM }).llm = failingLLM;

      await expect(runtime.retryLastTurn()).rejects.toThrow('LLM network error');

      // finally block must have cleared the AbortController
      expect((runtime as unknown as { currentAbortController: unknown }).currentAbortController).toBeNull();
    });

    it('cleans up AbortController on successful completion', async () => {
      const runtime = trackRuntime(await createTestRuntime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
      }));
      await runtime.initialize();

      // Build a session first
      const mockLLM = createMockLLM([
        { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' },
        { content: [{ type: 'text', text: 'retry ok' }], stop_reason: 'end_turn' },
      ]);
      (runtime as unknown as { llm: typeof mockLLM }).llm = mockLLM;
      await runtime.chat('setup');

      await runtime.retryLastTurn();

      // AbortController must be null after retryLastTurn resolves
      expect((runtime as unknown as { currentAbortController: unknown }).currentAbortController).toBeNull();
    });
  });

  // ─── processBatch() outbox error-path edge cases ──────────────────────────

  describe('processBatch() — outbox error notification edge cases', () => {
    /**
     * 子类覆盖 _drainOwnInbox 和 _runReact，
     * 绕过真实 LLM / FS 调用，专注测试 catch 块行为。
     */
    class TestRuntime extends Runtime {
      public drainResult: {
        injected: Message[];
        sources: Array<{ text: string; type: string }>;
        count: number;
        infos: InboxMessage[];
        addressedHandles: any[];
      } = { injected: [], sources: [], count: 0, infos: [], addressedHandles: [] };
      public reactError: Error | null = null;

      protected override async _drainOwnInbox() {
        return this.drainResult;
      }

      protected override async _runReact(_messages: Message[]) {
        if (this.reactError) throw this.reactError;
      }
    }

    let testClawDir: string;
    let testTempDir: string;
    const edgeRuntimes: Runtime[] = [];

    beforeEach(async () => {
      testTempDir = path.join(tmpdir(), `chestnut-runtime-edge-${randomUUID()}`);
      testClawDir = path.join(testTempDir, 'claws', 'edge-claw');
      await fs.mkdir(testClawDir, { recursive: true });
    });

    afterEach(async () => {
      for (const r of edgeRuntimes.splice(0)) {
        await r.stop().catch(() => {});
      }
      await fs.rm(testTempDir, { recursive: true, force: true }).catch(() => {});
    });

    async function makeTestRuntime() {
      const deps = await makeRuntimeDeps({ clawDir: testClawDir, clawId: 'edge-claw' });
      return new TestRuntime({
        clawId: 'edge-claw',
        clawDir: testClawDir,
        llmConfig: createMockLLMConfig(),
        dependencies: deps,
      });
    }

    it('MaxStepsExceededError 通知 sender 并重抛错误', async () => {
      const runtime = await makeTestRuntime();
      edgeRuntimes.push(runtime);
      await runtime.initialize();

      runtime.drainResult = {
        injected: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        sources: [],
        count: 1,
        infos: [{
          id: 'msg1',
          type: 'message',
          from: 'sender-claw',
          to: 'edge-claw',
          content: 'hello',
          priority: 'normal',
          timestamp: new Date().toISOString(),
          contract_id: 'c-1',
        } as InboxMessage],
        addressedHandles: [],
      };
      runtime.reactError = new MaxStepsExceededError(10);

      // 错误应被重抛
      await expect(runtime.processBatch()).rejects.toThrow(MaxStepsExceededError);

      // outbox 应写入了错误响应
      const outboxDir = path.join(testClawDir, 'outbox', 'pending');
      const files = (await fs.readdir(outboxDir)).filter(f => f.endsWith('.md'));
      expect(files.length).toBeGreaterThan(0);

      const content = await fs.readFile(path.join(outboxDir, files[0]), 'utf-8');
      expect(content).toContain('Maximum steps');
      expect(content).toContain('sender-claw');
    });

    it('outbox write 失败不影响原始错误重抛', async () => {
      const runtime = await makeTestRuntime();
      edgeRuntimes.push(runtime);
      await runtime.initialize();

      runtime.drainResult = {
        injected: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        sources: [],
        count: 1,
        infos: [{
          id: 'msg1',
          type: 'message',
          from: 'sender-claw',
          to: 'edge-claw',
          content: 'hello',
          priority: 'normal',
          timestamp: new Date().toISOString(),
        } as InboxMessage],
        addressedHandles: [],
      };
      const originalError = new Error('LLM exploded');
      runtime.reactError = originalError;

      // 注入一个会抛出的 outboxWriter
      (runtime as unknown as RuntimeTestInternals).outboxWriter = {
        write: async () => { throw new Error('outbox disk full'); },
      };

      // 应抛出原始错误，而非 outbox 错误
      const err = await runtime.processBatch().catch(e => e);
      expect(err).toBe(originalError);
      expect(err.message).toBe('LLM exploded');
    });

    it('MaxStepsExceededError 时 outbox.write 失败 → audit outbox_write_failed scenario=max_steps_exhausted', async () => {
      const runtime = await makeTestRuntime();
      edgeRuntimes.push(runtime);
      await runtime.initialize();

      runtime.drainResult = {
        injected: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        sources: [],
        count: 1,
        infos: [{
          id: 'msg1',
          type: 'message',
          from: 'sender-claw',
          to: 'edge-claw',
          content: 'hello',
          priority: 'normal',
          timestamp: new Date().toISOString(),
          contract_id: 'c-1',
        } as InboxMessage],
        addressedHandles: [],
      };
      runtime.reactError = new MaxStepsExceededError(10);

      const audit: string[] = [];
      vi.spyOn((runtime as unknown as RuntimeTestInternals).auditWriter, 'write').mockImplementation((type: string, ...args: string[]) => {
        audit.push([type, ...args].join('\t'));
      });
      vi.spyOn((runtime as unknown as RuntimeTestInternals).outboxWriter, 'write').mockRejectedValue(new Error('outbox disk full'));

      await expect(runtime.processBatch()).rejects.toThrow(MaxStepsExceededError);

      expect(audit.some(e => /^outbox_write_failed\tcontext=error_response\tscenario=max_steps_exhausted\treason=outbox disk full$/.test(e))).toBe(true);
    });

    it('non-interrupt error 时 outbox.write 失败 → audit outbox_write_failed scenario=non_interrupt_error', async () => {
      const runtime = await makeTestRuntime();
      edgeRuntimes.push(runtime);
      await runtime.initialize();

      runtime.drainResult = {
        injected: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        sources: [],
        count: 1,
        infos: [{
          id: 'msg1',
          type: 'message',
          from: 'sender-claw',
          to: 'edge-claw',
          content: 'hello',
          priority: 'normal',
          timestamp: new Date().toISOString(),
          contract_id: 'c-1',
        } as InboxMessage],
        addressedHandles: [],
      };
      const originalError = new Error('LLM crash injected');
      runtime.reactError = originalError;

      const audit: string[] = [];
      vi.spyOn((runtime as unknown as RuntimeTestInternals).auditWriter, 'write').mockImplementation((type: string, ...args: string[]) => {
        audit.push([type, ...args].join('\t'));
      });
      vi.spyOn((runtime as unknown as RuntimeTestInternals).outboxWriter, 'write').mockRejectedValue(new Error('outbox io err'));

      const err = await runtime.processBatch().catch(e => e);
      expect(err).toBe(originalError);

      expect(audit.some(e => /^outbox_write_failed\tcontext=error_response\tscenario=non_interrupt_error\treason=outbox io err$/.test(e))).toBe(true);
    });
  });

  // ─── handleTurnInterrupt dispatch (phase 27 Step C: extracted to error-response.ts) ──

  describe('handleTurnInterrupt()', () => {
    const makeMockAudit = () => ({ write: vi.fn() });

    it('IdleTimeoutSignal → onTurnInterrupted("idle_timeout", message with seconds)', () => {
      const onTurnInterrupted = vi.fn();
      const onTurnError = vi.fn();
      const audit = makeMockAudit();
      handleTurnInterrupt(new IdleTimeoutSignal(30000), audit, { onTurnInterrupted, onTurnError });
      expect(onTurnInterrupted).toHaveBeenCalledWith('idle_timeout', expect.stringContaining('30s'));
      expect(onTurnError).not.toHaveBeenCalled();
      expect(audit.write).toHaveBeenCalledWith('turn_interrupted', 'cause=idle_timeout', 'idle_timeout_ms=30000');
    });

    it('PriorityInboxInterrupt → onTurnInterrupted("priority_inbox")', () => {
      const onTurnInterrupted = vi.fn();
      const onTurnError = vi.fn();
      const audit = makeMockAudit();
      handleTurnInterrupt(new PriorityInboxInterrupt(), audit, { onTurnInterrupted, onTurnError });
      expect(onTurnInterrupted).toHaveBeenCalledWith('priority_inbox', expect.any(String));
      expect(onTurnError).not.toHaveBeenCalled();
      expect(audit.write).toHaveBeenCalledWith('turn_interrupted', 'cause=priority_inbox');
    });

    it('UserInterrupt → onTurnInterrupted("user_interrupt")', () => {
      const onTurnInterrupted = vi.fn();
      const onTurnError = vi.fn();
      const audit = makeMockAudit();
      handleTurnInterrupt(new UserInterrupt(), audit, { onTurnInterrupted, onTurnError });
      expect(onTurnInterrupted).toHaveBeenCalledWith('user_interrupt');  // 无 message，让 viewport 自行决定显示
      expect(onTurnError).not.toHaveBeenCalled();
      expect(audit.write).toHaveBeenCalledWith('turn_interrupted', 'cause=user_interrupt');
    });

    it('Error → onTurnError with message', () => {
      const onTurnInterrupted = vi.fn();
      const onTurnError = vi.fn();
      const audit = makeMockAudit();
      handleTurnInterrupt(new Error('LLM failure'), audit, { onTurnInterrupted, onTurnError });
      expect(onTurnError).toHaveBeenCalledWith('LLM failure');
      expect(onTurnInterrupted).not.toHaveBeenCalled();
      expect(audit.write).toHaveBeenCalledWith('turn_error', 'error=LLM failure');
    });

    it('non-Error value → onTurnError with string', () => {
      const onTurnError = vi.fn();
      const audit = makeMockAudit();
      handleTurnInterrupt('raw string error', audit, { onTurnError });
      expect(onTurnError).toHaveBeenCalledWith('raw string error');
    });
  });

  // ─── processBatch outbox exclusion for signal interrupts ─────────────────────
});
