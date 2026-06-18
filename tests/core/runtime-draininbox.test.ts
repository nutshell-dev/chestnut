/**
 * Runtime DrainInbox integration tests
 *
 * phase 1393: merged from runtime-draininbox-notify.test.ts
 * (原 phase 1301 split for "parallel file run" 实测收益不如文件启动 overhead)
 *
 * phase 379: 抽 mock AuditLog 注入 (auditOverride seam in makeRuntimeDeps) +
 *   share deps cross-test (beforeAll + beforeEach FS reset) → 解 audit.tsv
 *   磁盘格式耦合 + ~makeRuntimeDeps cost 摊到 1 次 (option C+ / c1)。
 *
 *   Audit assertions 从 `fs.readFile(audit.tsv) → split TSV → entries[2/6]`
 *   迁到 `mockAuditWrite.mock.calls.find/filter(c => c[0] === <type>)`.
 *
 *   Phase 71 test + UserInterrupt test 仍构造各自 runtime (独立 spyOn / 子类) — 不进 shared 池。
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { Runtime } from '../../src/core/runtime/index.js';
import { makeRuntimeDeps } from '../helpers/runtime-deps.js';
import type { InboxMessage } from '../../src/foundation/messaging/types.js';
import type { Message } from '../../src/foundation/llm-provider/types.js';
import type { RuntimeTestInternals } from '../helpers/runtime-test-internals.js';
import type { AuditLog } from '../../src/foundation/audit/types.js';
import { UserInterrupt } from '../../src/core/signals.js';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';
import { createTestRuntime, createMockLLMConfig, createMockLLM } from './_runtime-test-helpers.js';


describe('Runtime DrainInbox', () => {
  let tempDir: string;
  let clawDir: string;
  let mockAuditWrite: ReturnType<typeof vi.fn>;
  let mockAudit: AuditLog;
  let sharedRuntime: Runtime;
  const runtimesToStop: Runtime[] = [];

  function trackRuntime(r: Runtime): Runtime {
    runtimesToStop.push(r);
    return r;
  }

  function writePendingMsg(filename: string, content: string) {
    return fs.writeFile(path.join(clawDir, 'inbox', 'pending', filename), content);
  }

  function validMsgContent(id: string, body: string, priority = 'normal') {
    return `---\nid: ${id}\ntype: message\nfrom: motion\npriority: ${priority}\ntimestamp: ${new Date().toISOString()}\n---\n\n${body}\n`;
  }

  beforeAll(async () => {
    tempDir = await createTempDir();
    clawDir = path.join(tempDir, 'claws', 'test-claw');
    mockAuditWrite = vi.fn();
    mockAudit = {
      __brand: 'AuditLog' as const,
      write: mockAuditWrite,
      preview: (s: string) => s,
      message: (s: string) => s,
      summary: (s: string) => s,
    };
    sharedRuntime = trackRuntime(await createTestRuntime({
      clawId: 'test-claw',
      clawDir,
      llmConfig: createMockLLMConfig(),
      auditOverride: mockAudit,
    }));
    await sharedRuntime.initialize();
  });

  beforeEach(async () => {
    mockAuditWrite.mockClear();
    // FS state reset 跨 test (share runtime 时必)
    for (const subdir of ['inbox/pending', 'inbox/done', 'inbox/failed', 'outbox/pending']) {
      const dir = path.join(clawDir, subdir);
      const files = await fs.readdir(dir).catch(() => []);
      for (const f of files) {
        await fs.rm(path.join(dir, f), { recursive: true, force: true }).catch(() => {});
      }
    }
    await fs.rm(path.join(clawDir, 'HEARTBEAT.md'), { force: true }).catch(() => {});
    const dialogFile = path.join(clawDir, 'dialog', 'current.json');
    await fs.rm(dialogFile, { force: true }).catch(() => {});
  });

  afterAll(async () => {
    for (const r of runtimesToStop.splice(0)) {
      await r.stop().catch(() => {});
    }
    await cleanupTempDir(tempDir);
  });

  describe('_drainOwnInbox edge cases', () => {
    it('non-.md files in inbox/pending are ignored', async () => {
      // One valid message + one non-.md intruder
      await writePendingMsg('valid.md', validMsgContent('v1', 'hello'));
      await writePendingMsg('stray.tmp', 'not a markdown file');

      const mockLLM = createMockLLM([{
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
      }]);
      (sharedRuntime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

      const count = await sharedRuntime.processBatch();

      // The .tmp file is skipped but the .md is processed
      expect(count).toBe(1);
    });

    it('malformed frontmatter .md files are moved to failed/', async () => {
      const failedDir = path.join(clawDir, 'inbox', 'failed');

      // Good message alongside broken one
      await writePendingMsg('good.md', validMsgContent('g1', 'good'));
      // File starts with --- but has no closing ---, so decodeInbox throws
      await writePendingMsg('broken.md', '---\ntype: message\nno-closing-dashes-ever');

      const mockLLM = createMockLLM([{
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
      }]);
      (sharedRuntime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

      // Should not throw; only the good message is processed
      await expect(sharedRuntime.processBatch()).resolves.toBe(1);

      // Broken file should end up in failed/
      const failedFiles = await fs.readdir(failedDir);
      expect(failedFiles.some(f => f.endsWith('broken.md'))).toBe(true);
    });

    it('heartbeat type without HEARTBEAT.md returns base text', async () => {
      // No HEARTBEAT.md in clawDir — heartbeat catch block returns base
      await writePendingMsg('hb.md', `---\nid: hb1\ntype: heartbeat\nfrom: system\npriority: normal\ntimestamp: ${new Date().toISOString()}\n---\n\n`);

      const mockLLM = createMockLLM([{
        content: [{ type: 'text', text: 'checked' }],
        stop_reason: 'end_turn',
      }]);
      (sharedRuntime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

      await sharedRuntime.processBatch();

      const callArgs = mockLLM.call.mock.calls[0][0];
      const userMsg = callArgs.messages.find((m: { role: string }) => m.role === 'user');
      expect(userMsg?.content).toContain('Heartbeat triggered');
      // No checklist appended when HEARTBEAT.md is absent
      expect(userMsg?.content).not.toContain('\n\n');
    });

    it('heartbeat type with HEARTBEAT.md appends checklist', async () => {
      // Write HEARTBEAT.md to clawDir
      await fs.writeFile(path.join(clawDir, 'HEARTBEAT.md'), '- Check disk space\n- Verify connections\n');

      await writePendingMsg('hb.md', `---\nid: hb2\ntype: heartbeat\nfrom: system\npriority: normal\ntimestamp: ${new Date().toISOString()}\n---\n\n`);

      const mockLLM = createMockLLM([{
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
      }]);
      (sharedRuntime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

      await sharedRuntime.processBatch();

      const callArgs = mockLLM.call.mock.calls[0][0];
      const userMsg = callArgs.messages.find((m: { role: string }) => m.role === 'user');
      expect(userMsg?.content).toContain('Heartbeat triggered');
      expect(userMsg?.content).toContain('Check disk space');
    });

    it('messages with to: a different agent are skipped from injection', async () => {
      const doneDir = path.join(clawDir, 'inbox', 'done');

      // Write two messages: one to this agent, one to a subagent
      await writePendingMsg(
        'for-me.md',
        `---\nid: msg1\ntype: message\nfrom: motion\nto: test-claw\npriority: normal\ntimestamp: ${new Date().toISOString()}\n---\n\nMessage for me`,
      );
      await writePendingMsg(
        'for-subagent.md',
        `---\nid: msg2\ntype: message\nfrom: task_system\nto: some-subagent-uuid\npriority: normal\ntimestamp: ${new Date().toISOString()}\n---\n\nMessage for subagent`,
      );

      const mockLLM = createMockLLM([{
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
      }]);
      (sharedRuntime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

      // processBatch drains inbox (2 files moved to done)
      await sharedRuntime.processBatch();

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
      // phase 379: mock-call assertion 替 fs.readFile(audit.tsv) + TSV parse
      const unaddressedCall = mockAuditWrite.mock.calls.find(c => c[0] === 'inbox_unaddressed');
      expect(unaddressedCall).toBeDefined();
      expect(unaddressedCall!.some((col: unknown) => String(col).includes('to=some-subagent-uuid'))).toBe(true);
    });

    it('should return 0 and not call LLM when all inbox messages are addressed to other agents', async () => {
      // Both messages are addressed to other agents, not to 'test-claw'
      await writePendingMsg(
        'not-for-me-1.md',
        `---\nid: msg1\ntype: message\nfrom: task_system\nto: some-subagent-uuid\npriority: normal\ntimestamp: ${new Date().toISOString()}\n---\n\nSubagent result`,
      );
      await writePendingMsg(
        'not-for-me-2.md',
        `---\nid: msg2\ntype: message\nfrom: task_system\nto: another-subagent\npriority: normal\ntimestamp: ${new Date().toISOString()}\n---\n\nAnother result`,
      );

      const mockLLM = createMockLLM([]);
      (sharedRuntime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

      const count = await sharedRuntime.processBatch();

      // count fix: returns injectedInfos.length (0), not fileInfos.length (2)
      expect(count).toBe(0);
      // No LLM turn should be triggered
      expect(mockLLM.call).not.toHaveBeenCalled();
    });

    it('inbox_unaddressed audit event written for messages to other agents', async () => {
      await writePendingMsg(
        'unaddressed.md',
        `---\nid: msg1\ntype: message\nfrom: motion\nto: other-claw\npriority: normal\ntimestamp: ${new Date().toISOString()}\n---\n\nNot for me`,
      );

      const mockLLM = createMockLLM([]);
      (sharedRuntime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

      await sharedRuntime.processBatch();

      // phase 379: mock-call assertion
      const entry = mockAuditWrite.mock.calls.find(c => c[0] === 'inbox_unaddressed');
      expect(entry).toBeDefined();
      expect(entry!.some((col: unknown) => String(col).includes('to=other-claw'))).toBe(true);
    });

    it('inbox_done audit event written for every processed file', async () => {
      await writePendingMsg('a.md', validMsgContent('a1', 'hello a'));
      await writePendingMsg('b.md', validMsgContent('b1', 'hello b'));

      const mockLLM = createMockLLM([{
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
      }]);
      (sharedRuntime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

      await sharedRuntime.processBatch();

      // phase 379: mock-call count assertion
      const doneCalls = mockAuditWrite.mock.calls.filter(c => c[0] === 'inbox_done');
      expect(doneCalls.length).toBe(2);
    });

    it('inbox_failed audit event written for malformed message', async () => {
      await writePendingMsg('good.md', validMsgContent('g1', 'good'));
      await writePendingMsg('broken.md', '---\ntype: message\nno-closing-dashes-ever');

      const mockLLM = createMockLLM([{
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
      }]);
      (sharedRuntime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

      await sharedRuntime.processBatch();

      // phase 379: mock-call assertion
      const failedEntry = mockAuditWrite.mock.calls.find(c => c[0] === 'inbox_failed');
      expect(failedEntry).toBeDefined();
      expect(failedEntry!.some((col: unknown) => String(col).includes('reason=Malformed frontmatter: missing closing ---'))).toBe(true);
    });
  });

  describe('_drainOwnInbox notify + time formatting', () => {
    // phase 71: non-MaxSteps errors → audit-only (writeErrorResponse 整删)
    // 本 test 用 vi.spyOn 拦截 auditWriter — 构造自家 runtime、不进 shared 池
    it('phase 71: non-MaxSteps error → audit-only runtime_catch_unhandled', async () => {
      const runtime = trackRuntime(await createTestRuntime({
        clawId: 'test-claw',
        clawDir,
        llmConfig: createMockLLMConfig(),
      }));
      await runtime.initialize();

      // Create a message with 'source' field
      const content = `---
id: test-msg
type: message
source: motion
contract_id: test-contract
priority: normal
timestamp: ${new Date().toISOString()}
---

Test message`;
      await writePendingMsg('msg.md', content);

      // Mock LLM that throws a non-MaxSteps error
      const failingLLM = {
        call: vi.fn().mockRejectedValue(new Error('LLM API crashed')),
        stream: vi.fn().mockImplementation(async function* () {
          throw new Error('LLM API crashed');
        }),
        close: vi.fn(),
      };
      (runtime as unknown as { llm: typeof failingLLM }).llm = failingLLM;

      const auditWrites: string[][] = [];
      vi.spyOn((runtime as unknown as RuntimeTestInternals).auditWriter, 'write').mockImplementation((type: string, ...args: string[]) => {
        auditWrites.push([type, ...args]);
      });

      // Should throw the error
      await expect(runtime.processBatch()).rejects.toThrow('LLM API crashed');

      // phase 71: audit-only fallback、0 outbox transmit
      expect(auditWrites.some(a => a[0] === 'runtime_catch_unhandled')).toBe(true);
    });

    // UserInterrupt should NOT notify sender (user aborted, not a real error)
    // 用自家子类 runtime — 不进 shared 池
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
      // 15 分钟前的消息
      const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      await writePendingMsg(
        'old.md',
        `---\nid: m1\ntype: message\nfrom: motion\npriority: normal\ntimestamp: ${fifteenMinAgo}\n---\n\nHello`,
      );

      const mockLLM = createMockLLM([{ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }]);
      (sharedRuntime as unknown as RuntimeTestInternals).llm = mockLLM;
      await sharedRuntime.processBatch();

      const userMsg = mockLLM.call.mock.calls[0][0].messages.find((m: any) => m.role === 'user');
      expect(userMsg?.content).toContain('15m ago');
    });

    it('injected message shows seconds for very recent timestamp', async () => {
      // 5 秒前
      const fiveSecsAgo = new Date(Date.now() - 5_000).toISOString();
      await writePendingMsg(
        'fresh.md',
        `---\nid: m2\ntype: message\nfrom: motion\npriority: normal\ntimestamp: ${fiveSecsAgo}\n---\n\nFresh`,
      );

      const mockLLM = createMockLLM([{ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }]);
      (sharedRuntime as unknown as RuntimeTestInternals).llm = mockLLM;
      await sharedRuntime.processBatch();

      const userMsg = mockLLM.call.mock.calls[0][0].messages.find((m: any) => m.role === 'user');
      expect(userMsg?.content).toMatch(/\ds ago/);
    });

    it('injected message shows hours for timestamps over 60 minutes old', async () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      await writePendingMsg(
        'old2.md',
        `---\nid: m3\ntype: message\nfrom: motion\npriority: normal\ntimestamp: ${twoHoursAgo}\n---\n\nBody`,
      );

      const mockLLM = createMockLLM([{ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }]);
      (sharedRuntime as unknown as RuntimeTestInternals).llm = mockLLM;
      await sharedRuntime.processBatch();

      const userMsg = mockLLM.call.mock.calls[0][0].messages.find((m: any) => m.role === 'user');
      expect(userMsg?.content).toContain('2h ago');
    });

    it('inbox_inject audit 日志对 watchdog 消息显示原始 type（B.p257-1）', async () => {
      // watchdog 发来的消息：type 为 watchdog_claw_inactivity（白名单外）
      // decodeInbox 后 type='message', extraMeta.__original_type='watchdog_claw_inactivity'
      await writePendingMsg(
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
      (sharedRuntime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

      await sharedRuntime.processBatch();

      // phase 379: mock-call assertion
      const injectEntry = mockAuditWrite.mock.calls.find(c => c[0] === 'inbox_inject');
      expect(injectEntry).toBeDefined();
      // 原始 type 应在 audit 日志中可见，不应是 'message'
      expect(injectEntry!.some((col: unknown) => col === 'type=watchdog_claw_inactivity')).toBe(true);
    });
  });
});
