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
import type { Watcher, WatcherErrorContext } from '../../src/foundation/file-watcher/index.js';
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
// Phase 1958 Step D：typed InboxWaitResult —— 观察失败不再折叠为正常 resolve。

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

    await expect(promise).resolves.toEqual({ kind: 'new_file' });
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

    // 干净 timeout（无观察错误）不得误报为观察失败
    await expect(promise).resolves.toEqual({ kind: 'timeout' });
    expect(mockWatcher.close).toHaveBeenCalled();
  });

  it('ensureDirSync throws → observation_failed(init)，不折叠为正常 resolve', async () => {
    vi.useFakeTimers();

    const mockFs = {
      ensureDirSync: vi.fn(() => { throw new Error('EACCES'); }),
      resolve: vi.fn((p: string) => p),
      // Phase 1958 Step D: snapshot 先行——提供正常空 list，让失败点落在 init
      listSync: vi.fn().mockReturnValue([]),
    } as unknown as FileSystem;
    const mockAudit = { write: vi.fn(), preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s) } as unknown as AuditLog;

    const promise = waitForInbox(mockFs, mockAudit, '/tmp/inbox', 60_000);

    await expect(promise).resolves.toEqual({
      kind: 'observation_failed',
      error: expect.stringContaining('EACCES'),
      context: 'init',
    });
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

    await expect(promise).resolves.toEqual({ kind: 'new_file' });
    expect(mockWatcher.close).toHaveBeenCalledTimes(1);
  });

  it('snapshot listSync 非 ENOENT 错误 → observation_failed(snapshot)，不以空基线继续', async () => {
    vi.useFakeTimers();

    const mockWatcher = { close: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(createWatcher).mockReturnValue(mockWatcher as unknown as Watcher);
    const mockFs = {
      ensureDirSync: vi.fn(),
      resolve: vi.fn((p: string) => p),
      listSync: vi.fn(() => { throw new Error('EIO: disk gone'); }),
    } as unknown as FileSystem;
    const mockAudit = { write: vi.fn(), preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s) } as unknown as AuditLog;

    const promise = waitForInbox(mockFs, mockAudit, '/tmp/inbox', 60_000);

    await expect(promise).resolves.toEqual({
      kind: 'observation_failed',
      error: expect.stringContaining('EIO'),
      context: 'snapshot',
    });
    // 基线不可信 → 不建 watcher 假装观察
    expect(mockWatcher.close).not.toHaveBeenCalled();
    expect(mockAudit.write).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('path=/tmp/inbox'),
      'context=snapshot',
      expect.stringContaining('EIO'),
    );
  });

  it('watcher 回调后 listSync 失败 → observation_failed(list)，不等 timeout 落地', async () => {
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
        // snapshot + init 复查成功；watcher 回调触发的检查失败
        if (listCallCount <= 2) return [];
        throw new Error('EPERM: list denied');
      }),
    } as unknown as FileSystem;
    const mockAudit = { write: vi.fn(), preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s) } as unknown as AuditLog;

    const promise = waitForInbox(mockFs, mockAudit, '/tmp/inbox', 60_000);
    await Promise.resolve();
    capturedCallback!();

    await expect(promise).resolves.toEqual({
      kind: 'observation_failed',
      error: expect.stringContaining('EPERM'),
      context: 'list',
    });
  });

  it('watcher onError(watch) 致命错误 → observation_failed(watch)', async () => {
    vi.useFakeTimers();

    let capturedOnError: ((err: Error, context: WatcherErrorContext) => void) | null = null;
    const mockWatcher = { close: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(createWatcher).mockImplementation((_absPath, _cb, options) => {
      capturedOnError = options?.onError ?? null;
      return mockWatcher as unknown as Watcher;
    });
    const mockFs = {
      ensureDirSync: vi.fn(),
      resolve: vi.fn((p: string) => p),
      listSync: vi.fn().mockReturnValue([]),
    } as unknown as FileSystem;
    const mockAudit = { write: vi.fn(), preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s) } as unknown as AuditLog;

    const promise = waitForInbox(mockFs, mockAudit, '/tmp/inbox', 60_000);
    await Promise.resolve();
    expect(capturedOnError).not.toBeNull();
    capturedOnError!(new Error('watch died'), 'watch');

    await expect(promise).resolves.toEqual({
      kind: 'observation_failed',
      error: 'watch died',
      context: 'watch',
    });
  });

  it('close 失败不覆盖更早的观察失败（首个错误优先）', async () => {
    vi.useFakeTimers();

    let capturedCallback: (() => void) | null = null;
    const mockWatcher = { close: vi.fn().mockRejectedValue(new Error('close EIO')) };
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
        if (listCallCount <= 2) return [];
        throw new Error('EPERM: list denied');
      }),
    } as unknown as FileSystem;
    const mockAudit = { write: vi.fn(), preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s) } as unknown as AuditLog;

    const promise = waitForInbox(mockFs, mockAudit, '/tmp/inbox', 60_000);
    await Promise.resolve();
    capturedCallback!();

    // 原始 list 观察失败保留，不被 close 错误覆盖
    await expect(promise).resolves.toEqual({
      kind: 'observation_failed',
      error: expect.stringContaining('EPERM'),
      context: 'list',
    });
    // close 失败仍单独留证
    expect(mockAudit.write).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('path=/tmp/inbox'),
      'context=close',
      expect.stringContaining('close EIO'),
    );
  });

  it('干净 timeout 后 close 失败 → observation_failed(close)（非正常 idle）', async () => {
    vi.useFakeTimers();

    const mockWatcher = { close: vi.fn().mockRejectedValue(new Error('close EIO')) };
    vi.mocked(createWatcher).mockReturnValue(mockWatcher as unknown as Watcher);
    const mockFs = {
      ensureDirSync: vi.fn(),
      resolve: vi.fn((p: string) => p),
      listSync: vi.fn().mockReturnValue([]),
    } as unknown as FileSystem;
    const mockAudit = { write: vi.fn(), preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s) } as unknown as AuditLog;

    const promise = waitForInbox(mockFs, mockAudit, '/tmp/inbox', 1_000);
    vi.advanceTimersByTime(1_001);

    await expect(promise).resolves.toEqual({
      kind: 'observation_failed',
      error: expect.stringContaining('close EIO'),
      context: 'close',
    });
  });

  it('abort → aborted（不误报为观察失败）', async () => {
    vi.useFakeTimers();

    const mockWatcher = { close: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(createWatcher).mockReturnValue(mockWatcher as unknown as Watcher);
    const mockFs = {
      ensureDirSync: vi.fn(),
      resolve: vi.fn((p: string) => p),
      listSync: vi.fn().mockReturnValue([]),
    } as unknown as FileSystem;
    const mockAudit = { write: vi.fn(), preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s) } as unknown as AuditLog;

    const controller = new AbortController();
    const promise = waitForInbox(mockFs, mockAudit, '/tmp/inbox', 60_000, controller.signal);
    controller.abort();

    await expect(promise).resolves.toEqual({ kind: 'aborted' });
  });
});
