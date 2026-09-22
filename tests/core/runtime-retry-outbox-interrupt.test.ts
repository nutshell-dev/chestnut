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

import type { Message } from '../../src/foundation/dialog-store/index.js';
import { StepAbortError } from '../../src/core/step-executor/index.js';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';
import { createMockLLMConfig } from './_runtime-test-helpers.js';
import { handleTurnInterrupt } from '../../src/core/runtime/runtime.js';
import { createTestEventLoop } from '../helpers/test-event-loop.js';

// Step H (phase1895): EventLoop 驱动失败 turn 时 dispatchError fallback 有
// UNKNOWN_ERROR_RECOVERY_DELAY_MS 退避；测试用小值锁状态机。
vi.mock('../../src/core/event-loop/constants.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/core/event-loop/constants.js')>('../../src/core/event-loop/constants.js');
  return {
    ...actual,
    UNKNOWN_ERROR_RECOVERY_DELAY_MS: 10,
    INTERRUPT_RECOVERY_DELAY_MS: 10,
    CONTEXT_TRIM_RETRY_INITIAL_DELAY_MS: 10,
    CONTEXT_TRIM_RETRY_MAX_DELAY_MS: 50,
  };
});


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

  // ─── processBatch() error-path edge cases ─────────────────────────────────

  describe('processBatch() — error propagation edge cases', () => {
    /**
     * 子类覆盖 _runReact 注入 turn 失败；inbox 走真实 pending 消息 +
     * EventLoop 单 owner 驱动（Step H 替代 legacy-process-batch）。
     */
    class TestRuntime extends Runtime {
      public reactError: Error | null = null;

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

    async function writePendingMsg(id: string, extraFrontmatter = ''): Promise<void> {
      const pendingDir = path.join(testClawDir, 'inbox', 'pending');
      await fs.mkdir(pendingDir, { recursive: true });
      const content = `---\nid: ${id}\ntype: message\nfrom: sender-claw\nto: edge-claw\npriority: normal\ntimestamp: ${new Date().toISOString()}\n${extraFrontmatter}---\n\nhello\n`;
      await fs.writeFile(path.join(pendingDir, `${id}.md`), content);
    }

    async function makeTestRuntime() {
      const deps = await makeRuntimeDeps({ clawDir: testClawDir, clawId: 'edge-claw' });
      return new TestRuntime({
        clawId: 'edge-claw',
        clawDir: testClawDir,
        llmConfig: createMockLLMConfig(),
        dependencies: deps,
      });
    }

    it('phase 1121 Step B: MaxStepsExceededError 不再 markCrashed、crash 经 EventLoop 落审计', async () => {
      const runtime = await makeTestRuntime();
      edgeRuntimes.push(runtime);
      await runtime.initialize();

      await writePendingMsg('msg1', 'contract_id: c-1\n');
      runtime.reactError = new MaxStepsExceededError(10);

      const markSpy = vi.spyOn((runtime as any).contractManager, 'markCorrupted').mockResolvedValue(undefined);
      const auditWrites: string[][] = [];
      vi.spyOn((runtime as unknown as RuntimeTestInternals).auditWriter, 'write').mockImplementation((type: string, ...args: string[]) => {
        auditWrites.push([type, ...args]);
      });

      await createTestEventLoop({ runtime, clawDir: testClawDir, clawId: 'edge-claw' }).run();

      // phase 1121 Step B: process failure 不再 mutate Contract
      expect(markSpy).not.toHaveBeenCalled();
      // 现行 EventLoop 架构：agent-loop crash 不冒泡，ack 破热循环 + FATAL 审计留证
      expect(auditWrites.some(a => a[0] === 'eventloop_fatal' && a.some(c => String(c).includes('reason=agent_loop_crash')))).toBe(true);
      markSpy.mockRestore();
    });

    it('non-interrupt failure preserves the original error object', async () => {
      const runtime = await makeTestRuntime();
      edgeRuntimes.push(runtime);
      await runtime.initialize();

      await writePendingMsg('msg1');
      const originalError = new Error('LLM exploded');
      runtime.reactError = originalError;

      // 现行 EventLoop 架构：turn 失败不冒泡；经 processTurn（public entry）
      // 解析为 failed TurnResult 且 error 保持原对象身份。
      let turnError: unknown;
      const processTurnSpy = vi.spyOn(runtime, 'processTurn').mockImplementation(async (...args: any[]) => {
        const result = await Runtime.prototype.processTurn.apply(runtime, args as any);
        turnError = result.error;
        return result;
      });

      await createTestEventLoop({ runtime, clawDir: testClawDir, clawId: 'edge-claw' }).run();

      expect(processTurnSpy).toHaveBeenCalled();
      expect(turnError).toBe(originalError);
      expect((turnError as Error).message).toBe('LLM exploded');
    });

    it('phase 71: MaxStepsExceededError 且 contract_id 缺失 → eventloop_fatal reason=agent_loop_crash', async () => {
      const runtime = await makeTestRuntime();
      edgeRuntimes.push(runtime);
      await runtime.initialize();

      await writePendingMsg('msg1');
      runtime.reactError = new MaxStepsExceededError(10);

      const audit: string[] = [];
      vi.spyOn((runtime as unknown as RuntimeTestInternals).auditWriter, 'write').mockImplementation((type: string, ...args: string[]) => {
        audit.push([type, ...args].join('\t'));
      });

      await createTestEventLoop({ runtime, clawDir: testClawDir, clawId: 'edge-claw' }).run();

      // Step H: 旧 helper 的 runtime_catch_unhandled 已随 processBatch 退役；
      // 现行等价面 = EventLoop agentLoopCrashHandler 的 FATAL 审计。
      expect(audit.some(e => /^eventloop_fatal\treason=agent_loop_crash/.test(e))).toBe(true);
    });

    it('phase 71: non-interrupt error → eventloop_fatal reason=non_llm_error（audit-only）', async () => {
      const runtime = await makeTestRuntime();
      edgeRuntimes.push(runtime);
      await runtime.initialize();

      await writePendingMsg('msg1', 'contract_id: c-1\n');
      const originalError = new Error('LLM crash injected');
      runtime.reactError = originalError;

      const audit: string[] = [];
      vi.spyOn((runtime as unknown as RuntimeTestInternals).auditWriter, 'write').mockImplementation((type: string, ...args: string[]) => {
        audit.push([type, ...args].join('\t'));
      });

      // Step H: 旧 helper 的 runtime_catch_unhandled 已随 processBatch 退役；
      // 现行等价面 = EventLoop fallbackHandler 的 FATAL 审计；
      // 原始错误对象身份经 processTurn TurnResult 保持（见上例同模式）。
      let turnError: unknown;
      vi.spyOn(runtime, 'processTurn').mockImplementation(async (...args: any[]) => {
        const result = await Runtime.prototype.processTurn.apply(runtime, args as any);
        turnError = result.error;
        return result;
      });

      await createTestEventLoop({ runtime, clawDir: testClawDir, clawId: 'edge-claw' }).run();

      expect(turnError).toBe(originalError);
      expect(audit.some(e => /^eventloop_fatal\treason=non_llm_error/.test(e))).toBe(true);
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
      handleTurnInterrupt(new StepAbortError({ kind: 'idle_timeout', ms: 30000 }), audit, { onTurnInterrupted, onTurnError });
      expect(onTurnInterrupted).toHaveBeenCalledWith('idle_timeout', expect.stringContaining('30s'));
      expect(onTurnError).not.toHaveBeenCalled();
      // phase 571: 加 trace_id col（test 不传 traceId、col 形态 trace_id=）
      expect(audit.write).toHaveBeenCalledWith('turn_interrupted', 'cause=idle_timeout', 'idle_timeout_ms=30000', 'trace_id=');
    });

    it('PriorityInboxInterrupt → onTurnInterrupted("priority_inbox")', () => {
      const onTurnInterrupted = vi.fn();
      const onTurnError = vi.fn();
      const audit = makeMockAudit();
      handleTurnInterrupt(new StepAbortError({ kind: 'step_yield' }), audit, { onTurnInterrupted, onTurnError });
      expect(onTurnInterrupted).toHaveBeenCalledWith('priority_inbox', expect.any(String));
      expect(onTurnError).not.toHaveBeenCalled();
      expect(audit.write).toHaveBeenCalledWith('turn_interrupted', 'cause=priority_inbox', 'trace_id=');
    });

    it('UserInterrupt → onTurnInterrupted("user_interrupt")', () => {
      const onTurnInterrupted = vi.fn();
      const onTurnError = vi.fn();
      const audit = makeMockAudit();
      handleTurnInterrupt(new StepAbortError({ kind: 'user_interrupt' }), audit, { onTurnInterrupted, onTurnError });
      expect(onTurnInterrupted).toHaveBeenCalledWith('user_interrupt');  // 无 message，让 viewport 自行决定显示
      expect(onTurnError).not.toHaveBeenCalled();
      expect(audit.write).toHaveBeenCalledWith('turn_interrupted', 'cause=user_interrupt', 'trace_id=');
    });

    it('phase 1857 Step G (SE-D7): StepAbortError 带 evidence → TURN_INTERRUPTED 行含 completed_tools 摘要列', () => {
      const onTurnInterrupted = vi.fn();
      const onTurnError = vi.fn();
      const audit = makeMockAudit();
      const err = new StepAbortError(
        { kind: 'user_interrupt' },
        { completed: [{ toolName: 'write_a', toolUseId: 'toolu_1', success: true }, { toolName: 'write_b', toolUseId: 'toolu_2', success: false }] },
      );
      handleTurnInterrupt(err, audit, { onTurnInterrupted, onTurnError });
      expect(onTurnInterrupted).toHaveBeenCalledWith('user_interrupt');
      expect(audit.write).toHaveBeenCalledWith(
        'turn_interrupted',
        'cause=user_interrupt',
        'trace_id=',
        'completed_tools=2',
        'completed_tool_summary=write_a#toolu_1:ok,write_b#toolu_2:fail',
      );
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
