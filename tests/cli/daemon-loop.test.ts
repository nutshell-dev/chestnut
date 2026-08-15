/**
 * daemon-loop tests
 *
 * fix 7 — waitForInbox done() idempotency (settled guard prevents double-resolve)
 *
 * Note (phase 361): fix 9 (interrupt poller circuit breaker test) 已删 —
 * polling-specific test (vi.advanceTimersByTime 200ms × 21) 不再适用 event-driven
 * file-watcher 架构. circuit breaker 契约现由 tests/daemon/interrupt-watcher.test.ts 覆盖.
 *
 * Phase 783: startDaemonLoop 改为接收 EventLoop 实例；本文件只测 daemon 进程级
 * 生命周期，LLM retry / chain iteration 等调度语义迁至 tests/core/event-loop。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { startDaemonLoop } from '../../src/daemon/daemon-loop.js';
import { waitForInbox } from '../../src/core/event-loop/inbox-watcher.js';
import type { AuditLog } from '../../src/foundation/audit/index.js';
import type { Watcher } from '../../src/foundation/file-watcher/types.js';
import type { FileSystem } from '../../src/foundation/fs/types.js';
import { createWatcher } from '../../src/foundation/file-watcher/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import type { EventLoop } from '../../src/core/event-loop/index.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

// Module-level mock so ESM named exports are replaceable
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, unlinkSync: vi.fn(actual.unlinkSync) };
});

vi.mock('../../src/foundation/file-watcher/index.js', () => ({
  createWatcher: vi.fn(),
}));

// ─── daemon-loop lifecycle ────────────────────────────────────────────────────

describe('startDaemonLoop - EventLoop delegation', () => {
  const EVENTLOOP_TICK_MS = 30;   // mock run wall time budget
  const EVENTLOOP_STARTUP_MS = 10; // daemon-loop startup settle budget

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('delegates each tick to eventLoop.run() and stops cleanly', async () => {
    const mockAudit = { write: vi.fn(), preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s) };
    const run = vi.fn().mockImplementation(async () => {
      await new Promise(r => setTimeout(r, EVENTLOOP_TICK_MS));
    });
    const abort = vi.fn();
    const eventLoop = { run, abort } as unknown as EventLoop;

    const { stop } = startDaemonLoop({
      fsFactory,
      eventLoop,
      agentDir: '/tmp/daemon-delegation-test',
      clawId: 'daemon-delegation-test',
      label: '[delegation-test]',
      audit: mockAudit as unknown as AuditLog,
    });

    await new Promise(r => setTimeout(r, EVENTLOOP_STARTUP_MS));
    stop();

    expect(run).toHaveBeenCalledTimes(1);
    expect(abort).not.toHaveBeenCalled();
  });
});

// ─── waitForInbox ──────────────────────────────────────────────────────────────

describe('waitForInbox', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('resolves when createWatcher callback fires (new file)', async () => {
    vi.useFakeTimers();

    let capturedCallback: (() => void) | null = null;
    const mockWatcher = { close: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(createWatcher).mockImplementation((_absPath, cb) => {
      capturedCallback = cb;
      return mockWatcher as unknown as Watcher;
    });

    let listCallCount = 0;
    const mockFs = {
      ensureDirSync: vi.fn(),
      resolve: vi.fn((p: string) => p),
      listSync: vi.fn(() => {
        listCallCount++;
        return listCallCount <= 2 ? [] : [{ name: 'msg1.md', isDirectory: false }];
      }),
    } as unknown as FileSystem;
    const mockAudit = { write: vi.fn(), preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s) } as unknown as AuditLog;

    const promise = waitForInbox(mockFs, mockAudit, '/tmp/inbox', 60_000);

    await Promise.resolve();
    expect(capturedCallback).not.toBeNull();

    capturedCallback!();

    await expect(promise).resolves.toBeUndefined();
    expect(mockWatcher.close).toHaveBeenCalled();
  });

  it('resolves on timeout when no file arrives', async () => {
    vi.useFakeTimers();

    const mockWatcher = { close: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(createWatcher).mockReturnValue(mockWatcher as unknown as Watcher);

    const mockFs = {
      ensureDirSync: vi.fn(),
      resolve: vi.fn((p: string) => p),
      listSync: vi.fn().mockReturnValue([]),
    } as unknown as FileSystem;
    const mockAudit = { write: vi.fn(), preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s) } as unknown as AuditLog;

    const promise = waitForInbox(mockFs, mockAudit, '/tmp/inbox', 1_000);

    vi.advanceTimersByTime(1_001);

    await expect(promise).resolves.toBeUndefined();
    expect(mockWatcher.close).toHaveBeenCalled();
  });

  it('resolves immediately when ensureDirSync throws', async () => {
    vi.useFakeTimers();

    const mockFs = {
      ensureDirSync: vi.fn(() => { throw new Error('EACCES'); }),
      resolve: vi.fn((p: string) => p),
    } as unknown as FileSystem;
    const mockAudit = { write: vi.fn(), preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s) } as unknown as AuditLog;

    const promise = waitForInbox(mockFs, mockAudit, '/tmp/inbox', 60_000);

    await expect(promise).resolves.toBeUndefined();
  });

  it('settled guard: multiple done() triggers only one resolve', async () => {
    vi.useFakeTimers();

    let capturedCallback: (() => void) | null = null;
    const mockWatcher = { close: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(createWatcher).mockImplementation((_absPath, cb) => {
      capturedCallback = cb;
      return mockWatcher as unknown as Watcher;
    });

    let listCallCount2 = 0;
    const mockFs = {
      ensureDirSync: vi.fn(),
      resolve: vi.fn((p: string) => p),
      listSync: vi.fn(() => {
        listCallCount2++;
        return listCallCount2 <= 2 ? [] : [{ name: 'new.md', isDirectory: false }];
      }),
    } as unknown as FileSystem;
    const mockAudit = { write: vi.fn(), preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s) } as unknown as AuditLog;

    const promise = waitForInbox(mockFs, mockAudit, '/tmp/inbox', 1_000);
    await Promise.resolve();

    capturedCallback!();
    vi.advanceTimersByTime(1_001);

    await expect(promise).resolves.toBeUndefined();
    expect(mockWatcher.close).toHaveBeenCalledTimes(1);
  });
});
