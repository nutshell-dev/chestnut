/**
 * daemon-loop dedicated unit test (phase 1157 / r127 H fork)
 *
 * 覆盖: waitForInbox timeout + watcher + error paths,
 *       startDaemonLoop lifecycle (stop resolves + prevents further ticks),
 *       EventLoop delegation (daemon-loop 只负责进程级生命周期，不再直接调度 turn)。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsNative from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { startDaemonLoop } from '../../src/daemon/daemon-loop.js';
import { waitForInbox } from '../../src/core/event-loop/inbox-watcher.js';
import { EventLoop } from '../../src/core/event-loop/index.js';
import { EVENTLOOP_AUDIT_EVENTS } from '../../src/core/event-loop/audit-events.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import type { FileSystem } from '../../src/foundation/fs/types.js';
import type { AuditLog } from '../../src/foundation/audit/index.js';
import type { Runtime, TurnResult } from '../../src/core/runtime/index.js';
import type { Watcher, WatchEvent } from '../../src/foundation/file-watcher/index.js';
import { MESSAGING_AUDIT_EVENTS } from '../../src/foundation/messaging/audit-events.js';
import { LLMContextExceededError } from '../../src/foundation/llm-orchestrator/index.js';
import type { Message, ToolDefinition } from '../../src/foundation/llm-provider/types.js';
import type { InboxHandle, InboxMessage } from '../../src/foundation/messaging/types.js';



/**
 * 给 chokidar watcher 完成内部 fs.watch 注册 / ready 触发的 budget.
 * Derivation: chokidar typical ready ≤ 20ms / ×2.5 safety = 50ms.
 */
const WATCHER_SETUP_BUDGET_MS = 50;

describe('daemon-loop dedicated unit (phase 1157 / r127 H fork)', () => {
  let agentDir: string;
  let inboxPendingDir: string;
  const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

  beforeEach(() => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    agentDir = path.join(os.tmpdir(), `daemon-loop-test-${randomUUID()}`);
    fsNative.mkdirSync(agentDir, { recursive: true });
    inboxPendingDir = path.join(agentDir, 'inbox', 'pending');
    fsNative.mkdirSync(inboxPendingDir, { recursive: true });
    fsNative.mkdirSync(path.join(agentDir, 'contract', 'active'), { recursive: true });
  });

  afterEach(() => {
    fsNative.rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function createMockAudit(): AuditLog & { entries: [string, ...(string | number)[]][] } {
    const entries: [string, ...(string | number)[]][] = [];
    return {
      entries,
      write: (type: string, ...cols: (string | number)[]) => {
        entries.push([type, ...cols]);
      },
    };
  }

  // --------------------------------------------------------------------------
  // waitForInbox
  // --------------------------------------------------------------------------

  describe('waitForInbox', () => {
    it('反向 1：空 inbox 时 timeout 兜底 resolve', async () => {
      const fs = new NodeFileSystem({ baseDir: path.join(agentDir, '..') });
      const audit = createMockAudit();
      const TIMEOUT_MS = 100;

      const start = Date.now();
      await waitForInbox(fs, audit, inboxPendingDir, TIMEOUT_MS);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(TIMEOUT_MS - 20);
      expect(elapsed).toBeLessThan(TIMEOUT_MS + 400);
    });

    it('反向 2：inbox 出现 file 时 watcher 触发提前 resolve（不走 timeout）', async () => {
      const fs = new NodeFileSystem({ baseDir: path.join(agentDir, '..') });
      const audit = createMockAudit();
      const TIMEOUT_MS = 5000;

      const promise = waitForInbox(fs, audit, inboxPendingDir, TIMEOUT_MS);

      await new Promise(r => setTimeout(r, WATCHER_SETUP_BUDGET_MS));
      fsNative.writeFileSync(path.join(inboxPendingDir, 'test.md'), '# hello');

      const start = Date.now();
      await promise;
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(TIMEOUT_MS / 5);
    });

    it('反向 3：fs.ensureDirSync 抛错时 audit 记录 + promise 仍 resolve', async () => {
      const audit = createMockAudit();
      const mockFs = {
        ensureDirSync: vi.fn(() => {
          throw new Error('ensureDir failed');
        }),
        resolve: vi.fn((p: string) => p),
      } as unknown as FileSystem;

      await waitForInbox(mockFs, audit, inboxPendingDir, 50);

      expect(audit.entries.length).toBeGreaterThanOrEqual(1);
      expect(audit.entries[0][0]).toBe(MESSAGING_AUDIT_EVENTS.INBOX_WATCHER_FAILED);
      const cols = audit.entries[0].slice(1) as string[];
      expect(cols.some(c => c.includes('ensureDir failed'))).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // startDaemonLoop lifecycle
  // --------------------------------------------------------------------------

  describe('startDaemonLoop', () => {
    // phase 783: mock eventLoop.run() wall time budget、防止 while 循环空转导致 watcher 堆积
    const EVENTLOOP_TICK_MS = 30;
    // daemon-loop startup settle budget / stop() 前给 while tick 足够启动
    const EVENTLOOP_STARTUP_MS = 10;

    interface FakeWatcher extends Watcher {
      close: ReturnType<typeof vi.fn>;
      _setCallback: (cb: (event: WatchEvent) => void) => void;
      _trigger: (event: WatchEvent) => void;
    }

    function createFakeWatcher(): FakeWatcher {
      let callback: ((event: WatchEvent) => void) | undefined;
      return {
        close: vi.fn(() => Promise.resolve()),
        isActive: vi.fn(() => true),
        getPath: vi.fn((p: string) => p),
        _setCallback: (cb: (event: WatchEvent) => void) => { callback = cb; },
        _trigger: (event: WatchEvent) => { callback?.(event); },
      } as unknown as FakeWatcher;
    }

    it('stop() 后 promise resolve + 不再起新 tick', async () => {
      const audit = createMockAudit();
      const fakeWatcher = createFakeWatcher();
      const run = vi.fn().mockImplementation(async () => {
        await new Promise(r => setTimeout(r, EVENTLOOP_TICK_MS));
      });
      const abort = vi.fn();
      const eventLoop = { run, abort } as unknown as EventLoop;

      const { promise, stop } = startDaemonLoop({
        fsFactory,
        eventLoop,
        agentDir,
        clawId: 'test-claw',
        label: '[test daemon]',
        audit,
        createWatcher: () => fakeWatcher,
      });

      await new Promise(r => setTimeout(r, EVENTLOOP_STARTUP_MS));
      stop();
      await promise;

      expect(run).toHaveBeenCalledTimes(1);
      expect(abort).not.toHaveBeenCalled();
      expect(fakeWatcher.close).toHaveBeenCalledTimes(1);
    });

    it('interrupt watcher 触发时调用 eventLoop.abort()', async () => {
      const audit = createMockAudit();
      const fakeWatcher = createFakeWatcher();
      let blockResolve: (() => void) | undefined;
      const run = vi.fn().mockImplementation(() => new Promise<void>(r => { blockResolve = r; }));
      const abort = vi.fn();
      const eventLoop = { run, abort } as unknown as EventLoop;

      const { promise, stop } = startDaemonLoop({
        fsFactory,
        eventLoop,
        agentDir,
        clawId: 'test-claw',
        label: '[test daemon]',
        audit,
        createWatcher: (_path, callback) => {
          fakeWatcher._setCallback(callback);
          return fakeWatcher;
        },
      });

      await new Promise(r => setTimeout(r, EVENTLOOP_STARTUP_MS));

      // 模拟 interrupt 文件出现，触发 watcher callback
      fsNative.writeFileSync(path.join(agentDir, 'interrupt'), 'abort');
      fakeWatcher._trigger({ type: 'add', path: path.join(agentDir, 'interrupt') });
      expect(abort).toHaveBeenCalledTimes(1);

      stop();
      expect(blockResolve).toBeDefined();
      blockResolve!();
      await promise;

      expect(fakeWatcher.close).toHaveBeenCalledTimes(1);
    });

    it('daemon 连续 blocked outer ticks 不会重复 drain/ack/nack/LLM', async () => {
      const audit = createMockAudit();
      const ctxErr = new LLMContextExceededError('test-provider', 400, 'context length exceeded');
      const processTurn = vi.fn().mockResolvedValue({ status: 'failed', error: ctxErr } as TurnResult);
      const nackHandles = vi.fn().mockResolvedValue(undefined);
      const ackHandles = vi.fn().mockResolvedValue(undefined);
      const reactiveTrim = vi.fn().mockResolvedValue({
        status: 'no_progress',
        before: 1000,
        after: 1000,
        reason: 'already_within_target',
        newMessages: [],
        archived: false,
      });

      let drainCall = 0;
      const runtime = {
        drainInbox: vi.fn().mockImplementation(async () => {
          drainCall++;
          if (drainCall === 1) {
            return {
              injected: [{ role: 'user', content: 'hi' } as Message],
              sources: [{ text: 'hi', type: 'user_chat' }],
              count: 1,
              infos: [] as InboxMessage[],
              addressedHandles: ['handle-1'],
            };
          }
          return { injected: [] as Message[], sources: [] as any[], count: 0, infos: [] as InboxMessage[], addressedHandles: [] as InboxHandle[] };
        }),
        getSystemPrompt: vi.fn().mockResolvedValue('sys'),
        getToolsForLLM: vi.fn().mockReturnValue([] as ToolDefinition[]),
        getMessages: vi.fn().mockResolvedValue([] as Message[]),
        proactiveTrimIfNeeded: vi.fn().mockImplementation((m: Message[]) => m),
        processTurn,
        ackHandles,
        nackHandles,
        reactiveTrim,
        abort: vi.fn(),
        computeTurnRequestFingerprint: vi.fn().mockResolvedValue('fp'),
        peekPendingTurnFacts: vi.fn().mockResolvedValue({ addressed: [], controls: [] }),
      } as unknown as Runtime;

      const eventLoop = new EventLoop({
        runtime: runtime as Runtime,
        fsFactory,
        agentDir,
        clawId: 'test-claw',
        audit,
        inbox: { pendingDir: inboxPendingDir, fallbackTimeoutMs: 30 },
      });
      const fakeWatcher = createFakeWatcher();

      const { promise, stop } = startDaemonLoop({
        fsFactory,
        eventLoop,
        agentDir,
        clawId: 'test-claw',
        label: '[test daemon]',
        audit,
        createWatcher: () => fakeWatcher,
      });

      // 等 daemon 跑至少 2 个 blocked ticks；250ms 包含 fallback 30ms × 至少 2 ticks
      // 的调度 overhead，只用于观测窗口，不作为产品行为契约。
      const BLOCKED_TICK_OBSERVATION_MS = 250;
      await new Promise(r => setTimeout(r, BLOCKED_TICK_OBSERVATION_MS));
      stop();
      await promise;

      expect(processTurn).toHaveBeenCalledTimes(1);
      expect(runtime.drainInbox).toHaveBeenCalledTimes(1);
      expect(nackHandles).toHaveBeenCalledTimes(1);
      expect(ackHandles).not.toHaveBeenCalled();
      expect(
        audit.entries.filter(e => e[0] === EVENTLOOP_AUDIT_EVENTS.CONTEXT_BLOCKED_GATE).length,
      ).toBeGreaterThanOrEqual(2);
    });
  });
});
