/**
 * Runtime DrainInbox — notification + time formatting + misc tests
 * (phase 1301 split from runtime-draininbox.test.ts for parallel file run)
 *
 * Split point: L286 (notify-on-error) onwards.
 * Pattern: phase 1296 runtime-signal-audit split mirror.
 * Estimated wall: ~2s (vs original combined 3985ms / -50% parallel).
 */

import type { RuntimeTestInternals } from '../helpers/runtime-test-internals.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { Runtime } from '../../src/core/runtime/index.js';
import { makeRuntimeDeps } from '../helpers/runtime-deps.js';
import type { InboxMessage } from '../../src/foundation/messaging/types.js';
import type { Message } from '../../src/foundation/llm-provider/types.js';
import { UserInterrupt } from '../../src/core/signals.js';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';
import { createTestRuntime, createMockLLMConfig, createMockLLM } from './_runtime-test-helpers.js';


describe('Runtime DrainInbox — notification + time + misc', () => {
  let tempDir: string;
  let clawDir: string;
  const runtimesToStop: Runtime[] = [];

  function trackRuntime(r: Runtime): Runtime {
    runtimesToStop.push(r);
    return r;
  }

  beforeEach(async () => {
    tempDir = await createTempDir();
    clawDir = path.join(tempDir, 'claws', 'test-claw');
  });

  afterEach(async () => {
    for (const r of runtimesToStop.splice(0)) {
      await r.stop().catch(() => {});
    }
    await cleanupTempDir(tempDir);
  });

  describe('_drainOwnInbox notify + time formatting', () => {
    async function makeRuntime() {
      const runtime = trackRuntime(await createTestRuntime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
      }));
      await runtime.initialize();
      return runtime;
    }

    function writePendingMsg(pendingDir: string, filename: string, content: string) {
      return fs.writeFile(path.join(pendingDir, filename), content);
    }

    // H3 fix: non-MaxSteps errors should notify sender via outbox
    it('should notify sender when LLM throws non-MaxSteps error (H3)', async () => {
      const runtime = trackRuntime(await createTestRuntime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
      }));
      await runtime.initialize();

      // Create a message with 'source' field
      const pendingDir = path.join(clawDir, 'inbox', 'pending');
      const content = `---
id: test-msg
type: message
source: motion
contract_id: test-contract
priority: normal
timestamp: ${new Date().toISOString()}
---

Test message`;
      await fs.writeFile(path.join(pendingDir, 'msg.md'), content);

      // Mock LLM that throws a non-MaxSteps error
      const failingLLM = {
        call: vi.fn().mockRejectedValue(new Error('LLM API crashed')),
        stream: vi.fn().mockImplementation(async function* () {
          throw new Error('LLM API crashed');
        }),
        close: vi.fn(),
      };
      (runtime as unknown as { llm: typeof failingLLM }).llm = failingLLM;

      // Should throw the error
      await expect(runtime.processBatch()).rejects.toThrow('LLM API crashed');

      // Verify error response was written to outbox
      const outboxDir = path.join(clawDir, 'outbox', 'pending');
      const outboxFiles = await fs.readdir(outboxDir);
      const responseFiles = outboxFiles.filter(f => f.endsWith('.md'));
      expect(responseFiles.length).toBeGreaterThan(0);

      // Verify the error response content
      const responseContent = await fs.readFile(
        path.join(outboxDir, responseFiles[0]),
        'utf-8'
      );
      expect(responseContent).toContain('type: response');
      expect(responseContent).toContain('to: "motion"');
      expect(responseContent).toContain('contract_id: "test-contract"');
      expect(responseContent).toContain('Error: LLM API crashed');
    });

    // UserInterrupt should NOT notify sender (user aborted, not a real error)
    it('should NOT notify sender on UserInterrupt', async () => {
      // Use a subclass to inject UserInterrupt without going through real LLM+loop
      class UserInterruptRuntime extends Runtime {
        protected override async _drainOwnInbox() {
          return {
            injected: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
            sources: [],
            count: 1,
            infos: [{
              id: 'msg1',
              type: 'message',
              from: 'motion',
              to: 'test-claw',
              content: 'hi',
              priority: 'normal',
              timestamp: new Date().toISOString(),
              metadata: { contract_id: 'test-contract' },
            } as InboxMessage],
            addressedHandles: [],
          };
        }
        protected override async _runReact(_messages: Message[]) {
          throw new UserInterrupt();
        }
      }

      const deps = await makeRuntimeDeps({ clawDir, clawId: 'test-claw' });
      const runtime = trackRuntime(new UserInterruptRuntime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
        dependencies: deps,
      }));
      await runtime.initialize();

      await expect(runtime.processBatch()).rejects.toBeInstanceOf(UserInterrupt);

      // Verify NO error response was written to outbox
      const outboxDir = path.join(clawDir, 'outbox', 'pending');
      const outboxFiles = await fs.readdir(outboxDir);
      const responseFiles = outboxFiles.filter(f => f.endsWith('.md'));
      expect(responseFiles.length).toBe(0);
    });

    it('injected message includes time-ago suffix when timestamp is set', async () => {
      const runtime = await makeRuntime();
      const pendingDir = path.join(clawDir, 'inbox', 'pending');

      // 15 分钟前的消息
      const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      await writePendingMsg(
        pendingDir,
        'old.md',
        `---\nid: m1\ntype: message\nfrom: motion\npriority: normal\ntimestamp: ${fifteenMinAgo}\n---\n\nHello`,
      );

      const mockLLM = createMockLLM([{ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }]);
      (runtime as unknown as RuntimeTestInternals).llm = mockLLM;
      await runtime.processBatch();

      const userMsg = mockLLM.call.mock.calls[0][0].messages.find((m: any) => m.role === 'user');
      expect(userMsg?.content).toContain('15m ago');
    });

    it('injected message shows seconds for very recent timestamp', async () => {
      const runtime = await makeRuntime();
      const pendingDir = path.join(clawDir, 'inbox', 'pending');

      // 5 秒前
      const fiveSecsAgo = new Date(Date.now() - 5_000).toISOString();
      await writePendingMsg(
        pendingDir,
        'fresh.md',
        `---\nid: m2\ntype: message\nfrom: motion\npriority: normal\ntimestamp: ${fiveSecsAgo}\n---\n\nFresh`,
      );

      const mockLLM = createMockLLM([{ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }]);
      (runtime as unknown as RuntimeTestInternals).llm = mockLLM;
      await runtime.processBatch();

      const userMsg = mockLLM.call.mock.calls[0][0].messages.find((m: any) => m.role === 'user');
      expect(userMsg?.content).toMatch(/\ds ago/);
    });

    it('injected message shows hours for timestamps over 60 minutes old', async () => {
      const runtime = await makeRuntime();
      const pendingDir = path.join(clawDir, 'inbox', 'pending');

      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      await writePendingMsg(
        pendingDir,
        'old2.md',
        `---\nid: m3\ntype: message\nfrom: motion\npriority: normal\ntimestamp: ${twoHoursAgo}\n---\n\nBody`,
      );

      const mockLLM = createMockLLM([{ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }]);
      (runtime as unknown as RuntimeTestInternals).llm = mockLLM;
      await runtime.processBatch();

      const userMsg = mockLLM.call.mock.calls[0][0].messages.find((m: any) => m.role === 'user');
      expect(userMsg?.content).toContain('2h ago');
    });

    it('inbox_inject audit 日志对 watchdog 消息显示原始 type（B.p257-1）', async () => {
      const runtime = await makeRuntime();
      const pendingDir = path.join(clawDir, 'inbox', 'pending');

      // watchdog 发来的消息：type 为 watchdog_claw_inactivity（白名单外）
      // decodeInbox 后 type='message', extraMeta.__original_type='watchdog_claw_inactivity'
      await writePendingMsg(
        pendingDir,
        'watchdog-msg.md',
        [
          '---',
          'id: wd-001',
          'type: watchdog_claw_inactivity',  // 白名单外，decode 后变 message
          'from: watchdog',
          `to: test-claw`,
          'priority: high',
          `timestamp: ${new Date().toISOString()}`,
          '---',
          '',
          'Claw inactive',
        ].join('\n'),
      );

      const mockLLM = createMockLLM([{ role: 'assistant', content: 'ok' }]);
      (runtime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

      await runtime.processBatch();

      const auditLog = await fs.readFile(path.join(clawDir, 'audit.tsv'), 'utf-8');
      const entries = auditLog.trim().split('\n').map(line => line.split('\t'));
      const injectEntry = entries.find((e: string[]) => e[2] === 'inbox_inject');
      expect(injectEntry).toBeDefined();
      // 原始 type 应在 audit 日志中可见，不应是 'message'
      expect(injectEntry!.some((col: string) => col === 'type=watchdog_claw_inactivity')).toBe(true);
    });
  });
});
