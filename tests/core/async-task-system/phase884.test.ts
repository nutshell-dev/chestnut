/**
 * Phase 884: startDispatch contract + dispatch loop resilience
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { InMemoryShortIdIndex } from '../../../src/core/async-task-system/short-id-index.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import { makeTaskSystemDeps } from '../../helpers/task-system.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import type { WatcherFactory } from '../../../src/foundation/file-watcher/index.js';

function makeMockAudit(): { audit: AuditLog; events: Array<[string, ...(string | number)[]]> } {
  const events: Array<[string, ...(string | number)[]]> = [];
  const audit: AuditLog = {
    write: (type: string, ...cols: (string | number)[]) => {
      events.push([type, ...cols]);
    },
    preview: (s: string) => s,
    message: (s: string) => s,
    summary: (s: string) => s,
  };
  return { audit, events };
}

function makeMockWatcherFactory(): WatcherFactory {
  return vi.fn((_path, _callback, _opts) => ({
    close: vi.fn().mockResolvedValue(undefined),
    isActive: () => true,
    getPath: () => _path,
  }));
}

function makeBaseMockFs(): FileSystem {
  return {
    ensureDir: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(true),
    list: vi.fn().mockResolvedValue([]),
    resolve: vi.fn((p: string) => `/abs/${p}`),
    read: vi.fn().mockResolvedValue(''),
    move: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    writeAtomic: vi.fn().mockResolvedValue(undefined),
  } as unknown as FileSystem;
}

describe('phase 884: startDispatch + dispatch loop resilience', () => {
  let system: AsyncTaskSystem;
  let mockFs: FileSystem;
  let auditEvents: Array<[string, ...(string | number)[]]>;

  beforeEach(() => {
    mockFs = makeBaseMockFs();
    const { audit, events } = makeMockAudit();
    auditEvents = events;

    system = new AsyncTaskSystem('/tmp/claw', mockFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      createWatcher: makeMockWatcherFactory(),
      ...makeTaskSystemDeps(),
    });
  });

  afterEach(async () => {
    await system.shutdown(1).catch(() => { /* silent: shutdown */ });
  });

  it('startDispatch rejects when watcher initial scan fails', async () => {
    const scanError = new Error('pending dir unreadable');
    mockFs.list = vi.fn().mockRejectedValue(scanError);

    await expect(system.startDispatch()).rejects.toThrow(scanError);

    const recoveryFailedEvents = auditEvents.filter(
      e => e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED && e.some(
        c => typeof c === 'string' && c.includes('context=initial_scan_pending_failed'),
      ),
    );
    expect(recoveryFailedEvents.length).toBe(1);
    expect(recoveryFailedEvents[0]).toEqual(
      expect.arrayContaining([
        TASK_AUDIT_EVENTS.RECOVERY_FAILED,
        expect.stringContaining('source=system'),
        expect.stringContaining('context=initial_scan_pending_failed'),
        expect.stringContaining('error='),
      ]),
    );
  });

  it('startDispatch is idempotent', async () => {
    const loopSpy = vi.spyOn(system as any, '_runDispatchLoop');

    await system.startDispatch();
    await system.startDispatch();

    expect(loopSpy).toHaveBeenCalledTimes(1);
  });

  it('dispatch loop retries after _getPendingTasks failure and audits the error', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    await system.initialize();
    await system.startDispatch();

    let calls = 0;
    (system as any)._getPendingTasks = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        throw new Error('transient listing failure');
      }
      return [];
    });

    await vi.waitFor(
      () => auditEvents.some(
        e => e[0] === TASK_AUDIT_EVENTS.INVARIANT_VIOLATION && e.some(
          c => typeof c === 'string' && c.includes('kind=dispatch_loop_error'),
        ),
      ),
      { timeout: 5000 },
    );

    await vi.advanceTimersByTimeAsync(1100);

    await vi.waitFor(() => calls >= 2, { timeout: 5000 });
    expect(calls).toBeGreaterThanOrEqual(2);

    vi.useRealTimers();
    await system.shutdown(1).catch(() => { /* silent: shutdown */ });
  });
});
