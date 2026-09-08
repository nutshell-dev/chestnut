/**
 * Phase 1806: running cancellation typed outcome（AT-D2 治理）。
 *
 * - settle 三分支保留：fulfilled / rejected（携带 formatErr error）/ timeout（携带
 *   timeoutMs，不再 throw 旁路）。
 * - terminal convergence 正交维度：done/failed 落地 → converged；读不到/未落地 →
 *   not_observed，不猜测。
 * - legacy cancel() 只做明确投影：fulfilled/rejected → void；timeout → 维持 throw。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { InMemoryShortIdIndex } from '../../../src/core/async-task-system/short-id-index.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import { CANCEL_SETTLE_TIMEOUT_MS } from '../../../src/core/async-task-system/constants.js';
import {
  TASKS_QUEUES_DONE_DIR,
} from '../../../src/core/async-task-system/dirs.js';
import { makeTaskSystemDeps } from '../../helpers/task-system.js';
import { makeAudit } from '../../helpers/audit.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { WatcherFactory, WatchEvent } from '../../../src/foundation/file-watcher/index.js';

function makeMockWatcherFactory(): WatcherFactory {
  return (_path: string, _callback: (event: WatchEvent) => void) => ({
    close: vi.fn().mockResolvedValue(undefined),
    isActive: vi.fn().mockReturnValue(true),
    getPath: vi.fn().mockReturnValue(_path),
  });
}

describe('cancel running typed outcome (phase 1806)', () => {
  let system: AsyncTaskSystem;
  let mockFs: FileSystem;
  let auditEvents: Array<[string, ...(string | number)[]]>;

  function makeSystem(existsImpl?: (path: string) => Promise<boolean>) {
    mockFs = {
      ensureDir: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      resolve: vi.fn((p: string) => `/abs/${p}`),
      ...(existsImpl ? { exists: vi.fn(existsImpl) } : {}),
    } as unknown as FileSystem;
    const { audit, events } = makeAudit();
    auditEvents = events;
    system = new AsyncTaskSystem('/tmp/claw', mockFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      ...makeTaskSystemDeps(),
      createWatcher: makeMockWatcherFactory(),
    });
  }

  beforeEach(() => { makeSystem(); });

  afterEach(async () => {
    await system.shutdown(1).catch(() => { /* silent: shutdown */ });
  });

  function injectRunning(taskId: string, promise: Promise<void>) {
    const abortController = new AbortController();
    (system as unknown as { executingTasks: Map<string, unknown> })
      .executingTasks.set(taskId, { abortController, promise });
    return abortController;
  }

  it('fulfilled：settle.kind=fulfilled + terminal=not_observed + CANCELLED audit 保留', async () => {
    const taskId = 'task-fulfill-on-cancel';
    injectRunning(taskId, Promise.resolve());

    const outcome = await system.cancelDetailed(taskId);

    expect(outcome).toEqual({
      kind: 'running_cancelled',
      taskId,
      settle: { kind: 'fulfilled' },
      terminal: 'not_observed',
    });
    expect(auditEvents.some(e => e[0] === TASK_AUDIT_EVENTS.CANCEL_PROMISE_REJECTED)).toBe(false);
    expect(auditEvents).toContainEqual(expect.arrayContaining([
      TASK_AUDIT_EVENTS.CANCELLED,
      expect.stringContaining(`fullTaskId=${taskId}`),
      'from=running',
    ]));
  });

  it('rejected：settle.kind=rejected 携带原始 error + CANCEL_PROMISE_REJECTED audit 保留', async () => {
    const taskId = 'task-reject-on-cancel';
    const promise = Promise.reject(new Error('abort-cleanup-explosion'));
    promise.catch(() => { /* silent: prevent unhandled rejection */ });
    injectRunning(taskId, promise);

    const outcome = await system.cancelDetailed(taskId);

    expect(outcome.kind).toBe('running_cancelled');
    if (outcome.kind !== 'running_cancelled') throw new Error('unreachable');
    expect(outcome.settle.kind).toBe('rejected');
    if (outcome.settle.kind !== 'rejected') throw new Error('unreachable');
    expect(outcome.settle.error).toContain('abort-cleanup-explosion');
    expect(auditEvents).toContainEqual(expect.arrayContaining([
      TASK_AUDIT_EVENTS.CANCEL_PROMISE_REJECTED,
      expect.stringContaining('error=abort-cleanup-explosion'),
    ]));
    expect(auditEvents.some(e => e[0] === TASK_AUDIT_EVENTS.CANCELLED)).toBe(true);
  });

  it('timeout：settle.kind=timeout 携带 timeoutMs + cancelDetailed 不 throw + 无 CANCELLED audit', async () => {
    vi.useFakeTimers();
    const taskId = 'task-never-settles';
    injectRunning(taskId, new Promise<void>(() => { /* intentionally non-cooperative */ }));

    try {
      const outcomePromise = system.cancelDetailed(taskId);
      await vi.advanceTimersByTimeAsync(CANCEL_SETTLE_TIMEOUT_MS);
      const outcome = await outcomePromise;

      expect(outcome).toEqual({
        kind: 'running_cancelled',
        taskId,
        settle: { kind: 'timeout', timeoutMs: CANCEL_SETTLE_TIMEOUT_MS },
        terminal: 'not_observed',
      });
      expect(auditEvents).toContainEqual(expect.arrayContaining([
        TASK_AUDIT_EVENTS.CANCEL_SETTLE_TIMEOUT,
        expect.stringContaining(`timeout_ms=${CANCEL_SETTLE_TIMEOUT_MS}`),
      ]));
      expect(auditEvents.some(e => e[0] === TASK_AUDIT_EVENTS.CANCELLED)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('terminal converged：settle 后文件已落 done/ → terminal=converged', async () => {
    const taskId = 'task-converged-on-disk';
    makeSystem(async (p: string) => p === `${TASKS_QUEUES_DONE_DIR}/${taskId}.json`);
    injectRunning(taskId, Promise.resolve());

    const outcome = await system.cancelDetailed(taskId);

    expect(outcome.kind).toBe('running_cancelled');
    if (outcome.kind !== 'running_cancelled') throw new Error('unreachable');
    expect(outcome.terminal).toBe('converged');
  });

  it('terminal not_observed：仍在 running（done/failed 均无）→ 不猜测 converged', async () => {
    const taskId = 'task-still-running-on-disk';
    makeSystem(async () => false);
    injectRunning(taskId, Promise.resolve());

    const outcome = await system.cancelDetailed(taskId);

    expect(outcome.kind).toBe('running_cancelled');
    if (outcome.kind !== 'running_cancelled') throw new Error('unreachable');
    expect(outcome.terminal).toBe('not_observed');
  });

  it('legacy cancel() 投影：fulfilled/rejected → void；timeout → 维持 throw', async () => {
    // fulfilled → void
    injectRunning('task-legacy-ok', Promise.resolve());
    await expect(system.cancel('task-legacy-ok')).resolves.toBeUndefined();

    // rejected → void（不抛原始 rejection）
    const rejecting = Promise.reject(new Error('legacy-boom'));
    rejecting.catch(() => { /* silent: prevent unhandled rejection */ });
    injectRunning('task-legacy-reject', rejecting);
    await expect(system.cancel('task-legacy-reject')).resolves.toBeUndefined();

    // timeout → 维持原 throw 行为
    vi.useFakeTimers();
    try {
      injectRunning('task-legacy-timeout', new Promise<void>(() => { /* non-cooperative */ }));
      const cancelPromise = system.cancel('task-legacy-timeout');
      const rejection = expect(cancelPromise).rejects.toThrow(/cancellation timed out/);
      await vi.advanceTimersByTimeAsync(CANCEL_SETTLE_TIMEOUT_MS);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});
