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
import type { InboxMessage } from '../../src/foundation/messaging/types.js';
import type { Message } from '../../src/foundation/llm-provider/types.js';
import { IdleTimeoutSignal, PriorityInboxInterrupt, UserInterrupt } from '../../src/core/signals.js';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';
import { createTestRuntime, createMockLLMConfig, createMockLLM } from './_runtime-test-helpers.js';


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
      await r.stop().catch(() => {});
    }
    await cleanupTempDir(tempDir);
  });

  describe('processBatch() — signal interrupts do not send outbox notifications', () => {
    class SignalTestRuntime extends Runtime {
      public drainResult: {
        injected: Message[];
        sources: Array<{ text: string; type: string }>;
        count: number;
        infos: Array<{ meta: Record<string, string>; body?: string }>;
        addressedHandles: any[];
      } = { injected: [], sources: [], count: 0, infos: [], addressedHandles: [] };
      public reactThrow: unknown = null;

      protected override async _drainOwnInbox() {
        return this.drainResult as any;
      }

      protected override async _runReact(_messages: Message[]) {
        if (this.reactThrow) throw this.reactThrow;
      }
    }

    let tempDir2: string;
    let clawDir2: string;
    const signalRuntimes: Runtime[] = [];

    beforeEach(async () => {
      tempDir2 = path.join(tmpdir(), `clawforum-signal-test-${randomUUID()}`);
      clawDir2 = path.join(tempDir2, 'claws', 'sig-claw');
      await fs.mkdir(clawDir2, { recursive: true });
    });

    afterEach(async () => {
      for (const r of signalRuntimes.splice(0)) {
        await r.stop().catch(() => {});
      }
      await fs.rm(tempDir2, { recursive: true, force: true }).catch(() => {});
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
      r.drainResult = {
        injected: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        sources: [],
        count: 1,
        infos: [{
          id: 'msg1',
          type: 'message',
          from: 'sender-claw',
          to: 'sig-claw',
          content: 'hi',
          priority: 'normal',
          timestamp: new Date().toISOString(),
        } as InboxMessage],
        addressedHandles: [],
      };
      return r;
    }

    async function outboxFiles() {
      const dir = path.join(clawDir2, 'outbox', 'pending');
      return (await fs.readdir(dir)).filter(f => f.endsWith('.md'));
    }

    it('IdleTimeoutSignal — no outbox notification sent', async () => {
      const r = await makeSignalRuntime();
      r.reactThrow = new IdleTimeoutSignal(30000);
      await expect(r.processBatch()).rejects.toBeInstanceOf(IdleTimeoutSignal);
      expect(await outboxFiles()).toHaveLength(0);
    });

    it('PriorityInboxInterrupt — no outbox notification sent', async () => {
      const r = await makeSignalRuntime();
      r.reactThrow = new PriorityInboxInterrupt();
      await expect(r.processBatch()).rejects.toBeInstanceOf(PriorityInboxInterrupt);
      expect(await outboxFiles()).toHaveLength(0);
    });

    it('UserInterrupt — no outbox notification sent', async () => {
      const r = await makeSignalRuntime();
      r.reactThrow = new UserInterrupt();
      await expect(r.processBatch()).rejects.toBeInstanceOf(UserInterrupt);
      expect(await outboxFiles()).toHaveLength(0);
    });

    it('generic Error — outbox notification IS sent to sender', async () => {
      const r = await makeSignalRuntime();
      r.reactThrow = new Error('unexpected crash');
      await expect(r.processBatch()).rejects.toThrow('unexpected crash');
      const files = await outboxFiles();
      expect(files.length).toBeGreaterThan(0);
    });
  });

  // ─── onProviderInfo ───────────────────────────────────────────────────────────

  describe('onProviderInfo', () => {
    let piTempDir: string;
    let piClawDir: string;
    const piRuntimes: Runtime[] = [];

    beforeEach(async () => {
      piTempDir = path.join(tmpdir(), `clawforum-pi-test-${randomUUID()}`);
      piClawDir = path.join(piTempDir, 'claws', 'pi-claw');
      await fs.mkdir(piClawDir, { recursive: true });
    });

    afterEach(async () => {
      for (const r of piRuntimes.splice(0)) {
        await r.stop().catch(() => {});
      }
      await fs.rm(piTempDir, { recursive: true, force: true }).catch(() => {});
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
      await runtime.chat('Hi', { onProviderInfo });

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
      await runtime.chat('Hi', { onProviderInfo });

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
      await runtime.chat('Hi', { onProviderInfo });

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
      await runtime.chat('Turn 1', { onProviderInfo });
      await runtime.chat('Turn 2', { onProviderInfo });

      expect(onProviderInfo).toHaveBeenCalledTimes(2);
    });
  });

});
