/**
 * Runtime DrainInbox integration tests
 */

import type { RuntimeTestInternals } from '../helpers/runtime-test-internals.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { Runtime } from '../../src/core/runtime/index.js';
import { makeRuntimeDeps } from '../helpers/runtime-deps.js';
import type { InboxMessage } from '../../src/foundation/messaging/types.js';
import type { Message } from '../../src/foundation/llm-provider/types.js';
import { IdleTimeoutSignal, UserInterrupt } from '../../src/core/signals.js';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';
import { createTestRuntime, createMockLLMConfig, createMockLLM } from './_runtime-test-helpers.js';


describe('Runtime DrainInbox', () => {
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

  describe('_drainOwnInbox edge cases', () => {
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

    function validMsgContent(id: string, body: string, priority = 'normal') {
      return `---\nid: ${id}\ntype: message\nfrom: motion\npriority: ${priority}\ntimestamp: ${new Date().toISOString()}\n---\n\n${body}\n`;
    }

    it('non-.md files in inbox/pending are ignored', async () => {
      const runtime = await makeRuntime();
      const pendingDir = path.join(clawDir, 'inbox', 'pending');

      // One valid message + one non-.md intruder
      await writePendingMsg(pendingDir, 'valid.md', validMsgContent('v1', 'hello'));
      await writePendingMsg(pendingDir, 'stray.tmp', 'not a markdown file');

      const mockLLM = createMockLLM([{
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
      }]);
      (runtime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

      const count = await runtime.processBatch();

      // The .tmp file is skipped but the .md is processed
      expect(count).toBe(1);
    });

    it('malformed frontmatter .md files are moved to failed/', async () => {
      const runtime = await makeRuntime();
      const pendingDir = path.join(clawDir, 'inbox', 'pending');
      const failedDir = path.join(clawDir, 'inbox', 'failed');

      // Good message alongside broken one
      await writePendingMsg(pendingDir, 'good.md', validMsgContent('g1', 'good'));
      // File starts with --- but has no closing ---, so decodeInbox throws
      await writePendingMsg(pendingDir, 'broken.md', '---\ntype: message\nno-closing-dashes-ever');

      const mockLLM = createMockLLM([{
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
      }]);
      (runtime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

      // Should not throw; only the good message is processed
      await expect(runtime.processBatch()).resolves.toBe(1);

      // Broken file should end up in failed/
      const failedFiles = await fs.readdir(failedDir);
      expect(failedFiles.some(f => f.endsWith('broken.md'))).toBe(true);
    });

    it('heartbeat type without HEARTBEAT.md returns base text', async () => {
      const runtime = await makeRuntime();
      const pendingDir = path.join(clawDir, 'inbox', 'pending');

      // No HEARTBEAT.md in clawDir — heartbeat catch block returns base
      await writePendingMsg(pendingDir, 'hb.md', `---\nid: hb1\ntype: heartbeat\nfrom: system\npriority: normal\ntimestamp: ${new Date().toISOString()}\n---\n\n`);

      const mockLLM = createMockLLM([{
        content: [{ type: 'text', text: 'checked' }],
        stop_reason: 'end_turn',
      }]);
      (runtime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

      await runtime.processBatch();

      const callArgs = mockLLM.call.mock.calls[0][0];
      const userMsg = callArgs.messages.find((m: { role: string }) => m.role === 'user');
      expect(userMsg?.content).toContain('Heartbeat triggered');
      // No checklist appended when HEARTBEAT.md is absent
      expect(userMsg?.content).not.toContain('\n\n');
    });

    it('heartbeat type with HEARTBEAT.md appends checklist', async () => {
      const runtime = await makeRuntime();
      const pendingDir = path.join(clawDir, 'inbox', 'pending');

      // Write HEARTBEAT.md to clawDir
      await fs.writeFile(path.join(clawDir, 'HEARTBEAT.md'), '- Check disk space\n- Verify connections\n');

      await writePendingMsg(pendingDir, 'hb.md', `---\nid: hb2\ntype: heartbeat\nfrom: system\npriority: normal\ntimestamp: ${new Date().toISOString()}\n---\n\n`);

      const mockLLM = createMockLLM([{
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
      }]);
      (runtime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

      await runtime.processBatch();

      const callArgs = mockLLM.call.mock.calls[0][0];
      const userMsg = callArgs.messages.find((m: { role: string }) => m.role === 'user');
      expect(userMsg?.content).toContain('Heartbeat triggered');
      expect(userMsg?.content).toContain('Check disk space');
    });

    it('messages with to: a different agent are skipped from injection', async () => {
      const runtime = await makeRuntime();
      const pendingDir = path.join(clawDir, 'inbox', 'pending');
      const doneDir = path.join(clawDir, 'inbox', 'done');

      // Write two messages: one to this agent, one to a subagent
      await writePendingMsg(
        pendingDir,
        'for-me.md',
        `---\nid: msg1\ntype: message\nfrom: motion\nto: test-claw\npriority: normal\ntimestamp: ${new Date().toISOString()}\n---\n\nMessage for me`,
      );
      await writePendingMsg(
        pendingDir,
        'for-subagent.md',
        `---\nid: msg2\ntype: message\nfrom: task_system\nto: some-subagent-uuid\npriority: normal\ntimestamp: ${new Date().toISOString()}\n---\n\nMessage for subagent`,
      );

      const mockLLM = createMockLLM([{
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
      }]);
      (runtime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

      // processBatch drains inbox (2 files moved to done)
      await runtime.processBatch();

      // Only the message addressed to test-claw should be injected into LLM context
      const callArgs = mockLLM.call.mock.calls[0][0];
      const userMsg = callArgs.messages.find((m: { role: string }) => m.role === 'user');
      expect(userMsg?.content).toContain('Message for me');
      expect(userMsg?.content).not.toContain('Message for subagent');

      // Both files should be moved to done/
      const doneFiles = await fs.readdir(doneDir);
      expect(doneFiles.some(f => f.endsWith('for-me.md'))).toBe(true);
      expect(doneFiles.some(f => f.endsWith('for-subagent.md'))).toBe(true);

      // AuditLog log should show inbox_unaddressed for the subagent message
      const auditLog = await fs.readFile(path.join(clawDir, 'audit.tsv'), 'utf-8');
      const entries = auditLog.trim().split('\n').map(line => line.split('\t'));
      const unaddressedEntry = entries.find((e: string[]) => e[2] === 'inbox_unaddressed');
      expect(unaddressedEntry).toBeDefined();
      expect(unaddressedEntry[6]).toContain('to=some-subagent-uuid');
    });

    it('should return 0 and not call LLM when all inbox messages are addressed to other agents', async () => {
      const runtime = await makeRuntime();
      const pendingDir = path.join(clawDir, 'inbox', 'pending');

      // Both messages are addressed to other agents, not to 'test-claw'
      await writePendingMsg(
        pendingDir,
        'not-for-me-1.md',
        `---\nid: msg1\ntype: message\nfrom: task_system\nto: some-subagent-uuid\npriority: normal\ntimestamp: ${new Date().toISOString()}\n---\n\nSubagent result`,
      );
      await writePendingMsg(
        pendingDir,
        'not-for-me-2.md',
        `---\nid: msg2\ntype: message\nfrom: task_system\nto: another-subagent\npriority: normal\ntimestamp: ${new Date().toISOString()}\n---\n\nAnother result`,
      );

      const mockLLM = createMockLLM([]);
      (runtime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

      const count = await runtime.processBatch();

      // count fix: returns injectedInfos.length (0), not fileInfos.length (2)
      expect(count).toBe(0);
      // No LLM turn should be triggered
      expect(mockLLM.call).not.toHaveBeenCalled();
    });

    it('inbox_unaddressed audit event written for messages to other agents', async () => {
      const runtime = await makeRuntime();
      const pendingDir = path.join(clawDir, 'inbox', 'pending');

      await writePendingMsg(
        pendingDir,
        'unaddressed.md',
        `---\nid: msg1\ntype: message\nfrom: motion\nto: other-claw\npriority: normal\ntimestamp: ${new Date().toISOString()}\n---\n\nNot for me`,
      );

      const mockLLM = createMockLLM([]);
      (runtime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

      await runtime.processBatch();

      const auditLog = await fs.readFile(path.join(clawDir, 'audit.tsv'), 'utf-8');
      const entries = auditLog.trim().split('\n').map(line => line.split('\t'));
      const entry = entries.find((e: string[]) => e[2] === 'inbox_unaddressed');
      expect(entry).toBeDefined();
      expect(entry!.some((col: string) => col.includes('to=other-claw'))).toBe(true);
    });

    it('inbox_done audit event written for every processed file', async () => {
      const runtime = await makeRuntime();
      const pendingDir = path.join(clawDir, 'inbox', 'pending');

      await writePendingMsg(pendingDir, 'a.md', validMsgContent('a1', 'hello a'));
      await writePendingMsg(pendingDir, 'b.md', validMsgContent('b1', 'hello b'));

      const mockLLM = createMockLLM([{
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
      }]);
      (runtime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

      await runtime.processBatch();

      const auditLog = await fs.readFile(path.join(clawDir, 'audit.tsv'), 'utf-8');
      const entries = auditLog.trim().split('\n').map(line => line.split('\t'));
      const doneEntries = entries.filter((e: string[]) => e[2] === 'inbox_done');
      expect(doneEntries.length).toBe(2);
    });

    it('inbox_failed audit event written for malformed message', async () => {
      const runtime = await makeRuntime();
      const pendingDir = path.join(clawDir, 'inbox', 'pending');

      await writePendingMsg(pendingDir, 'good.md', validMsgContent('g1', 'good'));
      await writePendingMsg(pendingDir, 'broken.md', '---\ntype: message\nno-closing-dashes-ever');

      const mockLLM = createMockLLM([{
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
      }]);
      (runtime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

      await runtime.processBatch();

      const auditLog = await fs.readFile(path.join(clawDir, 'audit.tsv'), 'utf-8');
      const entries = auditLog.trim().split('\n').map(line => line.split('\t'));
      const failedEntry = entries.find((e: string[]) => e[2] === 'inbox_failed');
      expect(failedEntry).toBeDefined();
      expect(failedEntry!.some((col: string) => col.includes('reason=Malformed frontmatter: missing closing ---'))).toBe(true);
    });

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
      expect(responseContent).toContain('# RESPONSE');
      expect(responseContent).toContain('**To:** motion');
      expect(responseContent).toContain('**Contract:** test-contract');
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
              contract_id: 'test-contract',
            } as InboxMessage],
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

    // Note: "timestamp missing" test removed because decodeInbox always fills a default
    // timestamp, so this edge case no longer exists on the InboxReader path.
  });

  // ─── retryLastTurn() ──────────────────────────────────────────────────────
});
