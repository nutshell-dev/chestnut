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
import { IdleTimeoutSignal, PriorityInboxInterrupt, UserInterrupt } from '../../src/core/step-executor/signals.js';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';
import { createTestRuntime, createMockLLMConfig, createMockLLM } from './_runtime-test-helpers.js';
import { handleTurnInterrupt } from '../../src/core/runtime/runtime.js';
import { runLegacyBatch } from '../helpers/legacy-process-batch.js';


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
      await r.stop().catch(() => { /* silent: shutdown */ });
    }
    await cleanupTempDir(tempDir);
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
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      testTempDir = path.join(tmpdir(), `chestnut-runtime-edge-${randomUUID()}`);
      testClawDir = path.join(testTempDir, 'claws', 'edge-claw');
      await fs.mkdir(testClawDir, { recursive: true });
    });

    afterEach(async () => {
      for (const r of edgeRuntimes.splice(0)) {
        await r.stop().catch(() => { /* silent: shutdown */ });
      }
      await fs.rm(testTempDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
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

    it('phase 1121 Step B: MaxStepsExceededError 不再 markCrashed、仍重抛错误', async () => {
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
          metadata: { contract_id: 'c-1' },
        } as InboxMessage],
        addressedHandles: [],
      };
      runtime.reactError = new MaxStepsExceededError(10);

      const markSpy = vi.spyOn((runtime as any).contractManager, 'markCorrupted').mockResolvedValue(undefined);

      // 错误应被重抛
      await expect(runLegacyBatch(runtime)).rejects.toThrow(MaxStepsExceededError);

      // phase 1121 Step B: process failure 不再 mutate Contract
      expect(markSpy).not.toHaveBeenCalled();
      markSpy.mockRestore();
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
      const err = await runLegacyBatch(runtime).catch(e => e);
      expect(err).toBe(originalError);
      expect(err.message).toBe('LLM exploded');
    });

    it('phase 71: MaxStepsExceededError 且 contract_id 缺失 → audit-only runtime_catch_unhandled', async () => {
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
      runtime.reactError = new MaxStepsExceededError(10);

      const audit: string[] = [];
      vi.spyOn((runtime as unknown as RuntimeTestInternals).auditWriter, 'write').mockImplementation((type: string, ...args: string[]) => {
        audit.push([type, ...args].join('\t'));
      });

      await expect(runLegacyBatch(runtime)).rejects.toThrow(MaxStepsExceededError);

      expect(audit.some(e => /^runtime_catch_unhandled\tpath=agent_loop_crash_no_contract/.test(e))).toBe(true);
    });

    it('phase 71: non-interrupt error → audit-only runtime_catch_unhandled', async () => {
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

      const err = await runLegacyBatch(runtime).catch(e => e);
      expect(err).toBe(originalError);

      expect(audit.some(e => /^runtime_catch_unhandled\tpath=non_interrupt_error/.test(e))).toBe(true);
    });
  });

  // ─── handleTurnInterrupt dispatch (phase 27 Step C: extracted to error-response.ts) ──

  describe('handleTurnInterrupt()', () => {
    const makeMockAudit = () => ({
      write: vi.fn(),
      preview: vi.fn((s: string) => s),
      message: vi.fn((s: string) => s),
      summary: vi.fn((s: string) => s),
    });

    it('IdleTimeoutSignal → onTurnInterrupted("idle_timeout", message with seconds)', () => {
      const onTurnInterrupted = vi.fn();
      const onTurnError = vi.fn();
      const audit = makeMockAudit();
      handleTurnInterrupt(new IdleTimeoutSignal(30000), audit, { onTurnInterrupted, onTurnError });
      expect(onTurnInterrupted).toHaveBeenCalledWith('idle_timeout', expect.stringContaining('30s'));
      expect(onTurnError).not.toHaveBeenCalled();
      // phase 571: 加 trace_id col（test 不传 traceId、col 形态 trace_id=）
      expect(audit.write).toHaveBeenCalledWith('turn_interrupted', 'cause=idle_timeout', 'idle_timeout_ms=30000', 'trace_id=');
    });

    it('PriorityInboxInterrupt → onTurnInterrupted("priority_inbox")', () => {
      const onTurnInterrupted = vi.fn();
      const onTurnError = vi.fn();
      const audit = makeMockAudit();
      handleTurnInterrupt(new PriorityInboxInterrupt(), audit, { onTurnInterrupted, onTurnError });
      expect(onTurnInterrupted).toHaveBeenCalledWith('priority_inbox', expect.any(String));
      expect(onTurnError).not.toHaveBeenCalled();
      expect(audit.write).toHaveBeenCalledWith('turn_interrupted', 'cause=priority_inbox', 'trace_id=');
    });

    it('UserInterrupt → onTurnInterrupted("user_interrupt")', () => {
      const onTurnInterrupted = vi.fn();
      const onTurnError = vi.fn();
      const audit = makeMockAudit();
      handleTurnInterrupt(new UserInterrupt(), audit, { onTurnInterrupted, onTurnError });
      expect(onTurnInterrupted).toHaveBeenCalledWith('user_interrupt');  // 无 message，让 viewport 自行决定显示
      expect(onTurnError).not.toHaveBeenCalled();
      expect(audit.write).toHaveBeenCalledWith('turn_interrupted', 'cause=user_interrupt', 'trace_id=');
    });

    it('Error → onTurnError with message', () => {
      const onTurnInterrupted = vi.fn();
      const onTurnError = vi.fn();
      const audit = makeMockAudit();
      handleTurnInterrupt(new Error('LLM failure'), audit, { onTurnInterrupted, onTurnError });
      expect(onTurnError).toHaveBeenCalledWith('LLM failure');
      expect(onTurnInterrupted).not.toHaveBeenCalled();
      expect(audit.write).toHaveBeenCalledWith('turn_error', 'error=LLM failure', 'trace_id=');
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
