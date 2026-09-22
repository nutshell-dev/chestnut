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
// phase 1780: misrouted 路径走 owner 常量（messaging dirs.ts barrel），不内联复制
import { INBOX_MISROUTED_DIR } from '../../src/foundation/messaging/index.js';

import type { Message } from '../../src/foundation/dialog-store/index.js';
import type { RuntimeTestInternals } from '../helpers/runtime-test-internals.js';
import type { AuditLog } from '../../src/foundation/audit/types.js';
import { StepAbortError } from '../../src/core/step-executor/index.js';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';
import { createTestRuntime, createMockLLMConfig, createMockLLM } from './_runtime-test-helpers.js';
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
        await fs.rm(path.join(dir, f), { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
      }
    }
    await fs.rm(path.join(clawDir, 'HEARTBEAT.md'), { force: true }).catch(() => { /* silent: cleanup */ });
    const dialogFile = path.join(clawDir, 'dialog', 'current.json');
    await fs.rm(dialogFile, { force: true }).catch(() => { /* silent: cleanup */ });
  });

  afterAll(async () => {
    for (const r of runtimesToStop.splice(0)) {
      await r.stop().catch(() => { /* silent: shutdown */ });
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

      await createTestEventLoop({ runtime: sharedRuntime, clawDir, clawId: 'test-claw' }).run();

      // The .tmp file is skipped but the .md is processed
      expect(mockLLM.call).toHaveBeenCalledTimes(1);
    });

    // Step H (phase1895) 语义变迁记录：phase 379 的「good 被处理 + broken 移 failed/」
    //  drain 级容错在现行架构不可达——EventLoop 入口 gate（computeTurnRequestFingerprint
    // → peekPending）对 malformed pending fail-closed（PendingViewError → eventloop_fatal），
    // 整轮不进入 prepareInbox。原两例（moved to failed/ + inbox_failed audit）退役，
    // 改以现行等价行为断言（fail-closed tick）保持 malformed 输入的可观察性。
    it('malformed frontmatter in pending fail-closes the tick (eventloop_fatal), no LLM call', async () => {
      await writePendingMsg('good.md', validMsgContent('g1', 'good'));
      await writePendingMsg('broken.md', '---\ntype: message\nno-closing-dashes-ever');

      const mockLLM = createMockLLM([{
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
      }]);
      (sharedRuntime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

      await createTestEventLoop({ runtime: sharedRuntime, clawDir, clawId: 'test-claw' }).run();

      // gate fail-closed：无 turn、无消息被领取
      expect(mockLLM.call).not.toHaveBeenCalled();
      const pendingFiles = await fs.readdir(path.join(clawDir, 'inbox', 'pending'));
      expect(pendingFiles.some(f => f.endsWith('good.md'))).toBe(true);
      expect(pendingFiles.some(f => f.endsWith('broken.md'))).toBe(true);
      const inflightFiles = await fs.readdir(path.join(clawDir, 'inbox', 'inflight')).catch(() => [] as string[]);
      expect(inflightFiles.filter(f => f.endsWith('.md'))).toHaveLength(0);
      // fail-closed 留证：eventloop_fatal reason=non_llm_error（PendingViewError）
      const fatalEntry = mockAuditWrite.mock.calls.find(
        c => c[0] === 'eventloop_fatal' && c.some((col: unknown) => String(col).includes('reason=non_llm_error')),
      );
      expect(fatalEntry).toBeDefined();
      expect(fatalEntry!.some((col: unknown) => String(col).includes('Pending view incomplete'))).toBe(true);
    });

    it('heartbeat type without HEARTBEAT.md returns base text', async () => {
      // No HEARTBEAT.md in clawDir — heartbeat catch block returns base
      await writePendingMsg('hb.md', `---\nid: hb1\ntype: heartbeat\nfrom: system\npriority: normal\ntimestamp: ${new Date().toISOString()}\n---\n\n`);

      const mockLLM = createMockLLM([{
        content: [{ type: 'text', text: 'checked' }],
        stop_reason: 'end_turn',
      }]);
      (sharedRuntime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

      await createTestEventLoop({ runtime: sharedRuntime, clawDir, clawId: 'test-claw' }).run();

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

      await createTestEventLoop({ runtime: sharedRuntime, clawDir, clawId: 'test-claw' }).run();

      const callArgs = mockLLM.call.mock.calls[0][0];
      const userMsg = callArgs.messages.find((m: { role: string }) => m.role === 'user');
      expect(userMsg?.content).toContain('Heartbeat triggered');
      expect(userMsg?.content).toContain('Check disk space');
    });

    it('messages with to: a different agent are skipped from injection', async () => {
      const doneDir = path.join(clawDir, 'inbox', 'done');
      const misroutedDir = path.join(clawDir, INBOX_MISROUTED_DIR);

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

      // EventLoop 单 owner 驱动 drain（addressed → done/、unaddressed → misrouted/）
      await createTestEventLoop({ runtime: sharedRuntime, clawDir, clawId: 'test-claw' }).run();

      // Only the message addressed to test-claw should be injected into LLM context
      const callArgs = mockLLM.call.mock.calls[0][0];
      const userMsg = callArgs.messages.find((m: { role: string }) => m.role === 'user');
      expect(userMsg?.content).toContain('Message for me');
      expect(userMsg?.content).not.toContain('Message for subagent');

      // phase 442: addressed → done/, unaddressed → misrouted/ (隔离、不混 done)
      const doneFiles = await fs.readdir(doneDir);
      expect(doneFiles.some(f => f.endsWith('for-me.md'))).toBe(true);
      expect(doneFiles.some(f => f.endsWith('for-subagent.md'))).toBe(false);
      const misroutedFiles = await fs.readdir(misroutedDir);
      expect(misroutedFiles.some(f => f.endsWith('for-subagent.md'))).toBe(true);

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

      await createTestEventLoop({ runtime: sharedRuntime, clawDir, clawId: 'test-claw' }).run();

      // No LLM turn should be triggered（旧 count=0 的现行等价断言；
      // 现行 EventLoop 空工作不 drain，误路由消息留待下次有真实工作时随批分流）
      expect(mockLLM.call).not.toHaveBeenCalled();
      const doneDir = path.join(clawDir, 'inbox', 'done');
      expect((await fs.readdir(doneDir)).filter(f => f.endsWith('.md'))).toHaveLength(0);
    });

    it('inbox_unaddressed audit event written for messages to other agents', async () => {
      // Step H: 现行 EventLoop 空工作不 drain——加一条 addressed 伴随消息让本批
      // 真实 drain，unaddressed 分流审计行为（_splitAndAuditEntries）不变。
      await writePendingMsg('companion.md', validMsgContent('v1', 'hello'));
      await writePendingMsg(
        'unaddressed.md',
        `---\nid: msg1\ntype: message\nfrom: motion\nto: other-claw\npriority: normal\ntimestamp: ${new Date().toISOString()}\n---\n\nNot for me`,
      );

      const mockLLM = createMockLLM([{
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
      }]);
      (sharedRuntime as unknown as { llm: typeof mockLLM }).llm = mockLLM;

      await createTestEventLoop({ runtime: sharedRuntime, clawDir, clawId: 'test-claw' }).run();

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

      await createTestEventLoop({ runtime: sharedRuntime, clawDir, clawId: 'test-claw' }).run();

      // phase 379: mock-call count assertion
      const doneCalls = mockAuditWrite.mock.calls.filter(c => c[0] === 'inbox_done');
      expect(doneCalls.length).toBe(2);
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

      // Create a message with 'from' field
      const content = `---
id: test-msg
type: message
from: motion
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

      // 现行 EventLoop 架构：turn 失败不冒泡，经 dispatchError 落 eventloop_fatal 审计。
      // 原「rejects + runtime_catch_unhandled」的等价强度 = LLM 零成功调用 + FATAL 审计。
      await createTestEventLoop({ runtime, clawDir, clawId: 'test-claw' }).run();

      // phase 71: audit-only fallback、0 outbox transmit
      expect(auditWrites.some(a => a[0] === 'eventloop_fatal' && a.some(c => c === 'reason=non_llm_error') && a.some(c => String(c).includes('LLM API crashed')))).toBe(true);
    });

    // UserInterrupt should NOT notify sender (user aborted, not a real error)
    // 用自家子类 runtime — 不进 shared 池
    it('should NOT notify sender on UserInterrupt', async () => {
      // Use a subclass to inject UserInterrupt without going through real LLM+loop
      class UserInterruptRuntime extends Runtime {
        protected override async _runReact(_messages: Message[]) {
          throw new StepAbortError({ kind: 'user_interrupt' });
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

      // 真实 pending 消息驱动 EventLoop drain → turn 被注入的 UserInterrupt 中断
      await writePendingMsg('msg.md', validMsgContent('msg1', 'hi'));

      // 中断证据：turn_interrupted audit（processTurn handleTurnInterrupt 直写）
      const auditWrites: string[][] = [];
      vi.spyOn((runtime as unknown as RuntimeTestInternals).auditWriter, 'write').mockImplementation((type: string, ...args: string[]) => {
        auditWrites.push([type, ...args]);
      });

      await createTestEventLoop({ runtime, clawDir, clawId: 'test-claw' }).run();

      const interruptedCall = auditWrites.find(a => a[0] === 'turn_interrupted');
      expect(interruptedCall).toBeDefined();
      expect(interruptedCall!.some(c => String(c).includes('cause=user_interrupt'))).toBe(true);

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
      await createTestEventLoop({ runtime: sharedRuntime, clawDir, clawId: 'test-claw' }).run();

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
      await createTestEventLoop({ runtime: sharedRuntime, clawDir, clawId: 'test-claw' }).run();

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
      await createTestEventLoop({ runtime: sharedRuntime, clawDir, clawId: 'test-claw' }).run();

      const userMsg = mockLLM.call.mock.calls[0][0].messages.find((m: any) => m.role === 'user');
      expect(userMsg?.content).toContain('2h ago');
    });

    it('phase 1847: prepareInbox 不发 inbox_inject；formatPreparedInbox 单项格式化成功后才发（file=原文件名）', async () => {
      await writePendingMsg('audit-timing.md', validMsgContent('at1', 'timing'));

      // 准备阶段：领取 + 分流，不发格式化交付审计
      const prepared = await sharedRuntime.prepareInbox();
      expect(prepared.entries).toHaveLength(1);
      expect(mockAuditWrite.mock.calls.filter(c => c[0] === 'inbox_inject')).toHaveLength(0);

      // 格式化阶段：单项成功后才发原 INBOX_INJECT 列，file = handle.originalFileName
      const formatted = await sharedRuntime.formatPreparedInbox(prepared);
      expect(formatted.count).toBe(1);
      const injectCalls = mockAuditWrite.mock.calls.filter(c => c[0] === 'inbox_inject');
      expect(injectCalls).toHaveLength(1);
      expect(injectCalls[0].some((col: unknown) => String(col) === 'file=audit-timing.md')).toBe(true);

      // 结算清理（防泄漏到后续用例）
      await sharedRuntime.ackHandles(prepared.entries.map(e => e.handle), 'normal_turn_end');
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

      await createTestEventLoop({ runtime: sharedRuntime, clawDir, clawId: 'test-claw' }).run();

      // phase 379: mock-call assertion
      const injectEntry = mockAuditWrite.mock.calls.find(c => c[0] === 'inbox_inject');
      expect(injectEntry).toBeDefined();
      // 原始 type 应在 audit 日志中可见，不应是 'message'
      expect(injectEntry!.some((col: unknown) => col === 'type=watchdog_claw_inactivity')).toBe(true);
    });
  });
});
