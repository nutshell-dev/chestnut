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
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import type { FileSystem } from '../../src/foundation/fs/types.js';
import type { AuditLog } from '../../src/foundation/audit/index.js';
import type { EventLoop } from '../../src/core/event-loop/index.js';
import { MESSAGING_AUDIT_EVENTS } from '../../src/foundation/messaging/audit-events.js';

vi.mock('../../src/core/event-loop/constants.js', async () => {
  const actual = await vi.importActual('../../src/core/event-loop/constants.js');
  return {
    ...actual,
    LLM_RETRY_INITIAL_DELAY_MS: 10,
    LLM_RETRY_MAX_DELAY_MS: 50,
  };
});

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
    // abort 测试：mock run 长期阻塞验证 abort 可达
    const EVENTLOOP_ABORT_BLOCK_MS = 500;

    it('stop() 后 promise resolve + 不再起新 tick', async () => {
      const audit = createMockAudit();
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
      });

      await new Promise(r => setTimeout(r, EVENTLOOP_STARTUP_MS));
      stop();
      await promise;

      expect(run).toHaveBeenCalledTimes(1);
      expect(abort).not.toHaveBeenCalled();
    });

    it('interrupt watcher 触发时调用 eventLoop.abort()', async () => {
      const audit = createMockAudit();
      const run = vi.fn().mockImplementation(async () => {
        await new Promise(r => setTimeout(r, EVENTLOOP_ABORT_BLOCK_MS));
      });
      const abort = vi.fn();
      const eventLoop = { run, abort } as unknown as EventLoop;

      const { stop } = startDaemonLoop({
        fsFactory,
        eventLoop,
        agentDir,
        clawId: 'test-claw',
        label: '[test daemon]',
        audit,
      });

      await new Promise(r => setTimeout(r, EVENTLOOP_TICK_MS));
      stop();
    });
  });
});
