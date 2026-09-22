/**
 * Runtime SignalAudit integration tests
 */

import type { RuntimeTestInternals } from '../helpers/runtime-test-internals.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { Runtime } from '../../src/core/runtime/index.js';
import { makeRuntimeDeps } from '../helpers/runtime-deps.js';
import { writeSessionWithIncompleteToolUse } from '../helpers/session-fixtures.js';

import type { Message } from '../../src/foundation/dialog-store/index.js';
import { StepAbortError } from '../../src/core/step-executor/index.js';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';
import { createTestRuntime, createMockLLMConfig, createMockLLM } from './_runtime-test-helpers.js';
import { createTestEventLoop } from '../helpers/test-event-loop.js';
import { processRuntimeMessage } from '../helpers/process-runtime-message.js';

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


describe('Runtime SignalAudit', () => {
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

  describe('processBatch() — signal interrupts do not send outbox notifications', () => {
    class SignalTestRuntime extends Runtime {
      public reactThrow: unknown = null;

      protected override async _runReact(_messages: Message[]) {
        if (this.reactThrow) throw this.reactThrow;
      }
    }

    let tempDir2: string;
    let clawDir2: string;
    const signalRuntimes: Runtime[] = [];

    beforeEach(async () => {
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      tempDir2 = path.join(tmpdir(), `chestnut-signal-test-${randomUUID()}`);
      clawDir2 = path.join(tempDir2, 'claws', 'sig-claw');
      await fs.mkdir(clawDir2, { recursive: true });
    });

    afterEach(async () => {
      for (const r of signalRuntimes.splice(0)) {
        await r.stop().catch(() => { /* silent: shutdown */ });
      }
      await fs.rm(tempDir2, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    });

    async function makeSignalRuntime() {
      const deps = await makeRuntimeDeps({ clawDir: clawDir2, clawId: 'sig-claw' });
      const r = new SignalTestRuntime({
        clawId: 'sig-claw',
        clawDir: clawDir2,
        llmConfig: createMockLLMConfig(),
        dependencies: deps,
      });
      signalRuntimes.push(r);
      await r.initialize();
      // 真实 pending 消息（EventLoop drain → turn 注入信号中断）
      const content = `---
id: msg1
type: message
from: sender-claw
to: sig-claw
priority: normal
timestamp: ${new Date().toISOString()}
---

hi
`;
      await fs.writeFile(path.join(clawDir2, 'inbox', 'pending', 'msg1.md'), content);
      return r;
    }

    async function outboxFiles() {
      const dir = path.join(clawDir2, 'outbox', 'pending');
      return (await fs.readdir(dir)).filter(f => f.endsWith('.md'));
    }

    it('IdleTimeoutSignal — no outbox notification sent', async () => {
      const r = await makeSignalRuntime();
      r.reactThrow = new StepAbortError({ kind: 'idle_timeout', ms: 30000 });
      await createTestEventLoop({ runtime: r, clawDir: clawDir2, clawId: 'sig-claw' }).run();
      expect(await outboxFiles()).toHaveLength(0);
    });

    it('PriorityInboxInterrupt — no outbox notification sent', async () => {
      const r = await makeSignalRuntime();
      r.reactThrow = new StepAbortError({ kind: 'step_yield' });
      await createTestEventLoop({ runtime: r, clawDir: clawDir2, clawId: 'sig-claw' }).run();
      expect(await outboxFiles()).toHaveLength(0);
    });

    it('UserInterrupt — no outbox notification sent', async () => {
      const r = await makeSignalRuntime();
      r.reactThrow = new StepAbortError({ kind: 'user_interrupt' });
      await createTestEventLoop({ runtime: r, clawDir: clawDir2, clawId: 'sig-claw' }).run();
      expect(await outboxFiles()).toHaveLength(0);
    });

    it('phase 71: generic Error → audit-only eventloop_fatal reason=non_llm_error', async () => {
      const r = await makeSignalRuntime();
      r.reactThrow = new Error('unexpected crash');
      const auditWrites: string[][] = [];
      vi.spyOn((r as unknown as RuntimeTestInternals).auditWriter, 'write').mockImplementation((type: string, ...args: string[]) => {
        auditWrites.push([type, ...args]);
      });
      await createTestEventLoop({ runtime: r, clawDir: clawDir2, clawId: 'sig-claw' }).run();
      // Step H: 旧 helper 的 runtime_catch_unhandled 已随 processBatch 退役；
      // 现行等价面 = EventLoop fallbackHandler 的 FATAL 审计（error= 列含原 message）。
      expect(auditWrites.some(a => a[0] === 'eventloop_fatal' && a.some(c => String(c).includes('reason=non_llm_error')) && a.some(c => String(c).includes('unexpected crash')))).toBe(true);
    });
  });

  // ─── onProviderInfo ───────────────────────────────────────────────────────────

  describe('onProviderInfo', () => {
    let piTempDir: string;
    let piClawDir: string;
    const piRuntimes: Runtime[] = [];

    beforeEach(async () => {
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      piTempDir = path.join(tmpdir(), `chestnut-pi-test-${randomUUID()}`);
      piClawDir = path.join(piTempDir, 'claws', 'pi-claw');
      await fs.mkdir(piClawDir, { recursive: true });
    });

    afterEach(async () => {
      for (const r of piRuntimes.splice(0)) {
        await r.stop().catch(() => { /* silent: shutdown */ });
      }
      await fs.rm(piTempDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    });

    it('首个 text_delta 触发 onProviderInfo，携带 getProviderInfo() 返回值', async () => {
      const runtime = await createTestRuntime({
        clawId: 'pi-claw',
        clawDir: piClawDir,
        llmConfig: createMockLLMConfig(),
      });
      piRuntimes.push(runtime);
      const mockLLM = createMockLLM([{
        content: [{ type: 'text', text: 'Hello' }],
        stop_reason: 'end_turn',
      }]);
      mockLLM.getProviderInfo.mockReturnValue({ name: 'anthropic', model: 'claude-opus-4-6', isFallback: false });

      await runtime.initialize();
      (runtime as unknown as RuntimeTestInternals).llm = mockLLM;

      const onProviderInfo = vi.fn();
      await processRuntimeMessage(runtime, { role: 'user', content: 'Hi' }, { onProviderInfo });

      expect(onProviderInfo).toHaveBeenCalledTimes(1);
      expect(onProviderInfo).toHaveBeenCalledWith({ name: 'anthropic', model: 'claude-opus-4-6', isFallback: false });
    });

    it('同一 turn 多个 delta 只触发一次', async () => {
      const runtime = await createTestRuntime({
        clawId: 'pi-claw',
        clawDir: piClawDir,
        llmConfig: createMockLLMConfig(),
      });
      piRuntimes.push(runtime);

      // 用自定义 stream mock 产生多个 text_delta
      const multiDeltaLLM = {
        call: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'abc' }], stop_reason: 'end_turn' }),
        stream: vi.fn(async function* () {
          yield { type: 'text_delta', delta: 'a' };
          yield { type: 'text_delta', delta: 'b' };
          yield { type: 'text_delta', delta: 'c' };
          yield { type: 'done' };
        }),
        close: vi.fn(),
        healthCheck: vi.fn().mockResolvedValue(true),
        getProviderInfo: vi.fn().mockReturnValue({ name: 'anthropic', model: 'claude-opus-4-6', isFallback: false }),
      };

      await runtime.initialize();
      (runtime as unknown as RuntimeTestInternals).llm = multiDeltaLLM;

      const onProviderInfo = vi.fn();
      await processRuntimeMessage(runtime, { role: 'user', content: 'Hi' }, { onProviderInfo });

      expect(onProviderInfo).toHaveBeenCalledTimes(1);
    });

    it('fallback provider 时 isFallback=true 被传递', async () => {
      const runtime = await createTestRuntime({
        clawId: 'pi-claw',
        clawDir: piClawDir,
        llmConfig: createMockLLMConfig(),
      });
      piRuntimes.push(runtime);
      const mockLLM = createMockLLM([{
        content: [{ type: 'text', text: 'Hi' }],
        stop_reason: 'end_turn',
      }]);
      mockLLM.getProviderInfo.mockReturnValue({ name: 'openai', model: 'gpt-4o', isFallback: true });

      await runtime.initialize();
      (runtime as unknown as RuntimeTestInternals).llm = mockLLM;

      const onProviderInfo = vi.fn();
      await processRuntimeMessage(runtime, { role: 'user', content: 'Hi' }, { onProviderInfo });

      expect(onProviderInfo).toHaveBeenCalledWith(
        expect.objectContaining({ isFallback: true, name: 'openai' })
      );
    });

    it('连续两个 turn 各触发一次（每 turn 独立计数）', async () => {
      const runtime = await createTestRuntime({
        clawId: 'pi-claw',
        clawDir: piClawDir,
        llmConfig: createMockLLMConfig(),
      });
      piRuntimes.push(runtime);
      const mockLLM = createMockLLM([
        { content: [{ type: 'text', text: 'First' }], stop_reason: 'end_turn' },
        { content: [{ type: 'text', text: 'Second' }], stop_reason: 'end_turn' },
      ]);
      await runtime.initialize();
      (runtime as unknown as RuntimeTestInternals).llm = mockLLM;

      const onProviderInfo = vi.fn();
      await processRuntimeMessage(runtime, { role: 'user', content: 'Turn 1' }, { onProviderInfo });
      await processRuntimeMessage(runtime, { role: 'user', content: 'Turn 2' }, { onProviderInfo });

      expect(onProviderInfo).toHaveBeenCalledTimes(2);
    });
  });

});
