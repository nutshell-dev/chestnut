/**
 * daemon-loop dedicated unit test (phase 1157 / r127 H fork)
 *
 * 覆盖: waitForInbox timeout + watcher + error paths,
 *       startDaemonLoop lifecycle (stop resolves + prevents further ticks),
 *       createStreamCallbacks fan-out via streamWriter.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsNative from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { startDaemonLoop } from '../../src/daemon/daemon-loop.js';
import { waitForInbox } from '../../src/daemon/inbox-watcher.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import type { FileSystem } from '../../src/foundation/fs/types.js';
import type { AuditLog } from '../../src/foundation/audit/index.js';
import type { Runtime } from '../../src/core/runtime/index.js';
import type { StreamLog } from '../../src/foundation/stream/types.js';
import { MESSAGING_AUDIT_EVENTS } from '../../src/foundation/messaging/audit-events.js';
import { LLMContextExceededError } from '../../src/foundation/llm-orchestrator/index.js';
import { DAEMON_AUDIT_EVENTS } from '../../src/daemon/audit-events.js';
import { EVENTLOOP_AUDIT_EVENTS } from '../../src/core/event-loop/audit-events.js';

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
 * （仅 waitForInbox 内部 watcher setup race 的 test 仍用此 sleep；phase 370 把 daemon loop 等 iteration 的 sleeps 全改 event Promise）
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

      // phase 1165: 表达「断言 = TIMEOUT_MS ± margin」derivation、替原 magic 80/500
      expect(elapsed).toBeGreaterThanOrEqual(TIMEOUT_MS - 20);  // setup overhead margin (early resolve 反模式 lower bound)
      expect(elapsed).toBeLessThan(TIMEOUT_MS + 400);            // contention safety margin
    });

    it('反向 2：inbox 出现 file 时 watcher 触发提前 resolve（不走 timeout）', async () => {
      const fs = new NodeFileSystem({ baseDir: path.join(agentDir, '..') });
      const audit = createMockAudit();
      const TIMEOUT_MS = 5000;

      const promise = waitForInbox(fs, audit, inboxPendingDir, TIMEOUT_MS);

      // Give watcher time to set up
      await new Promise(r => setTimeout(r, WATCHER_SETUP_BUDGET_MS));
      fsNative.writeFileSync(path.join(inboxPendingDir, 'test.md'), '# hello');

      const start = Date.now();
      await promise;
      const elapsed = Date.now() - start;

      // phase 1165: watcher 应 ≥ 5x 快于 timeout（替原 magic 1000）
      // Should resolve quickly via watcher, not wait full timeout
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
    it('stop() 后 promise resolve + 不再起新 tick', async () => {
      const audit = createMockAudit();
      let processBatchCalled!: () => void;
      const processBatchOnce = new Promise<void>((r) => { processBatchCalled = r; });
      const processBatch = vi.fn().mockImplementation(async () => {
        processBatchCalled();
        return 0;
      });
      const retryLastTurn = vi.fn().mockResolvedValue(undefined);
      const abort = vi.fn();

      const mockRuntime = {
        processBatch,
        retryLastTurn,
        abort,
      } as unknown as Runtime;

      const { promise, stop } = startDaemonLoop({
        runtime: mockRuntime,
        agentDir,
        clawId: 'test-claw',
        label: '[test daemon]',
        audit,
        inbox: { pendingDir: inboxPendingDir, fallbackTimeoutMs: 50 },
        fsFactory,
      });

      // phase 370: processBatch first-call Promise 替原 LOOP_ITERATION sleep
      await processBatchOnce;
      stop();

      // Wait for loop to drain and promise resolve
      await promise;

      expect(processBatch).toHaveBeenCalledTimes(1);
      expect(abort).not.toHaveBeenCalled();
    });

    it('runtime.processBatch 被传入 wrapped callbacks（streamWriter 存在时）', async () => {
      const audit = createMockAudit();
      let processBatchCalled!: () => void;
      const processBatchOnce = new Promise<void>((r) => { processBatchCalled = r; });
      const processBatch = vi.fn().mockImplementation(async () => {
        processBatchCalled();
        return 0;
      });
      const mockRuntime = {
        processBatch,
        retryLastTurn: vi.fn().mockResolvedValue(undefined),
        abort: vi.fn(),
        getCurrentTraceId: vi.fn().mockReturnValue(undefined),
      } as unknown as Runtime;

      const streamWriter: StreamLog = { write: vi.fn() };

      const { promise, stop } = startDaemonLoop({
        runtime: mockRuntime,
        agentDir,
        clawId: 'test-claw',
        label: '[test daemon]',
        audit,
        inbox: { pendingDir: inboxPendingDir, fallbackTimeoutMs: 50 },
        streamWriter,
        fsFactory,
      });

      // phase 370: processBatch first-call Promise 替原 LOOP_ITERATION sleep
      await processBatchOnce;
      stop();
      await promise;

      expect(processBatch).toHaveBeenCalledTimes(1);
      const callbacksArg = processBatch.mock.calls[0][0];
      expect(callbacksArg).toBeDefined();
    });

    it('streamWriter 通过 createStreamCallbacks 收到 turn events', async () => {
      const audit = createMockAudit();
      const streamEvents: Array<{ type: string; [k: string]: unknown }> = [];
      let turnEndSeenResolve!: () => void;
      const turnEndSeen = new Promise<void>((r) => { turnEndSeenResolve = r; });
      const streamWriter: StreamLog = {
        write: (ev) => {
          streamEvents.push(ev);
          if (ev.type === 'turn_end') turnEndSeenResolve();
        },
      };

      const processBatch = vi.fn(async (callbacks?: {
        onTurnStart?: (sources: Array<{ text: string; type: string }>) => void;
        onTurnEnd?: () => void;
      }) => {
        if (callbacks) {
          callbacks.onTurnStart?.([{ text: 'hello', type: 'user' }]);
          callbacks.onTurnEnd?.();
        }
        return 0;
      });

      const mockRuntime = {
        processBatch,
        retryLastTurn: vi.fn().mockResolvedValue(undefined),
        abort: vi.fn(),
        getCurrentTraceId: vi.fn().mockReturnValue(undefined),
      } as unknown as Runtime;

      const { promise, stop } = startDaemonLoop({
        runtime: mockRuntime,
        agentDir,
        clawId: 'test-claw',
        label: '[test daemon]',
        audit,
        inbox: { pendingDir: inboxPendingDir, fallbackTimeoutMs: 50 },
        streamWriter,
        fsFactory,
      });

      // phase 370: turn_end event Promise 替原 DAEMON_MULTI_TICK sleep
      await turnEndSeen;
      stop();
      await promise;

      expect(streamEvents.length).toBeGreaterThanOrEqual(2);
      const turnStart = streamEvents.find(e => e.type === 'turn_start');
      const turnEnd = streamEvents.find(e => e.type === 'turn_end');
      expect(turnStart).toBeDefined();
      expect(turnEnd).toBeDefined();
      expect(turnStart?.sources).toEqual([{ text: 'hello', type: 'user' }]);
    });

    it('context_exceeded 错误走 llmRetryHandler + 耗尽后走 cooldown', async () => {
      const audit = createMockAudit();

      const processBatch = vi.fn().mockImplementation(async () => {
        throw new LLMContextExceededError('test-provider', 400, 'context length exceeded');
      });

      const retryLastTurn = vi.fn().mockImplementation(async () => {
        throw new LLMContextExceededError('test-provider', 400, 'context length exceeded');
      });

      const abort = vi.fn();

      const mockRuntime = {
        processBatch,
        retryLastTurn,
        abort,
      } as unknown as Runtime;

      const { promise, stop } = startDaemonLoop({
        runtime: mockRuntime,
        agentDir,
        clawId: 'test-claw',
        label: '[test daemon]',
        audit,
        inbox: { pendingDir: inboxPendingDir, fallbackTimeoutMs: 50 },
        fsFactory,
      });

      // 等待 cooldown audit 出现，出现后 stop
      const COOLDOWN_AUDIT_POLL_INTERVAL_MS = 5; // 5ms poll 间隔，LLM_RETRY_MAX_DELAY_MS mock 为 50ms、足够 detect
      const start = Date.now();
      while (Date.now() - start < 2000) {
        const cooldownEntries = audit.entries.filter(
          e => e[0] === EVENTLOOP_AUDIT_EVENTS.COOLDOWN &&
            e.some(c => String(c).includes('context_exceeded_exhausted')),
        );
        if (cooldownEntries.length > 0) {
          break;
        }
        await new Promise(r => setTimeout(r, COOLDOWN_AUDIT_POLL_INTERVAL_MS));
      }

      stop();
      await promise;

      expect(processBatch).toHaveBeenCalled();
      expect(retryLastTurn).toHaveBeenCalledTimes(3);

      const retryEntries = audit.entries.filter(e => e[0] === EVENTLOOP_AUDIT_EVENTS.LLM_RETRY);
      expect(retryEntries.length).toBe(3);

      const cooldownEntries = audit.entries.filter(
        e => e[0] === EVENTLOOP_AUDIT_EVENTS.COOLDOWN &&
          e.some(c => String(c).includes('context_exceeded_exhausted')),
      );
      expect(cooldownEntries.length).toBeGreaterThan(0);
    });
  });
});
