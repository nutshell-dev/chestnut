/**
 * daemon-loop tests
 *
 * fix 7 — waitForInbox done() idempotency (settled guard prevents double-resolve)
 * fix 9 — interrupt poller circuit breaker (disables after 20 consecutive errors)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsNative from 'fs';
import { waitForInbox, startDaemonLoop } from '../../src/daemon/daemon-loop.js';
import type { Runtime } from '../../src/core/runtime/index.js';
import type { AuditLog } from '../../src/foundation/audit/index.js';
import type { Watcher } from '../../src/foundation/file-watcher/types.js';
import type { FileSystem } from '../../src/foundation/fs/types.js';
import { createWatcher } from '../../src/foundation/file-watcher/index.js';
import { IdleTimeoutSignal, UserInterrupt, PriorityInboxInterrupt } from '../../src/core/signals.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });
import { LLMAllProvidersFailedError } from '../../src/foundation/llm-orchestrator/errors.js';

// Module-level mock so ESM named exports are replaceable
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, unlinkSync: vi.fn(actual.unlinkSync) };
});

vi.mock('../../src/foundation/file-watcher/index.js', () => ({
  createWatcher: vi.fn(),
}));

// ─── fix 9: interrupt poller circuit breaker ──────────────────────────────────

describe('startDaemonLoop interrupt poller circuit breaker', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    // unlinkSync is already replaced by the module-level vi.mock above
    vi.mocked(fsNative.unlinkSync).mockImplementation(() => {
      throw new Error('eperm');
    });
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(fsNative.unlinkSync).mockRestore();
    errSpy.mockRestore();

  });

  it('disables interrupt poller after 20 consecutive errors', async () => {
    // processBatch returns 0 → daemon goes to waitForInbox
    // The try block starts the interrupt poller, then awaits processBatch/waitForInbox
    // We want to advance timers to trigger the poller 20 times
    const mockAudit = { write: vi.fn() };
    const processBatch = vi.fn().mockResolvedValue(0);
    const mockRuntime = {
      processBatch,
      abort: vi.fn(),
      retryLastTurn: vi.fn(),
    } as unknown as Runtime;

    const { stop } = startDaemonLoop({
      fsFactory,
      runtime: mockRuntime,
      agentDir: '/tmp/test-agent-fix9',
      clawId: 'test-agent-fix9',
      label: '[test-fix9]',
      audit: mockAudit as unknown as AuditLog,
      inbox: { pendingDir: '/tmp/test-inbox-fix9', fallbackTimeoutMs: 60_000 },
    });

    // Let processBatch resolve (tick microtasks)
    await Promise.resolve();

    // Advance 200ms × 21 to trigger the poller 20+ times
    for (let i = 0; i < 21; i++) {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    }

    // phase 1154 α-2: wait emit 已删除 / 仅检查 poller disabled
    expect(mockAudit.write).toHaveBeenCalledWith(
      'daemon_loop_interrupt_poller_disabled',
      expect.stringContaining('error_count='),
      expect.stringContaining('last_error='),
    );

    stop();
    // Advance to flush waitForInbox timeout so the loop can terminate cleanly
    vi.advanceTimersByTime(60_001);
    await Promise.resolve();
  });
});

// ─── LLM retry ────────────────────────────────────────────────────────────────

/** Flush the microtask queue n times to let async code advance */
async function flushMicrotasks(n = 6) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

describe('startDaemonLoop - LLM retry', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('LLM error triggers retryLastTurn after exponential delay', async () => {
    vi.useFakeTimers();
    const mockAudit = { write: vi.fn() };
    const retryLastTurn = vi.fn().mockResolvedValue(undefined);
    const processBatch = vi.fn()
      .mockRejectedValueOnce(new LLMAllProvidersFailedError([{ provider: 'test', error: new Error('network unreachable') }]))
      .mockResolvedValue(0);

    const mockRuntime = { processBatch, retryLastTurn, abort: vi.fn() } as unknown as Runtime;

    const { stop } = startDaemonLoop({
      fsFactory,
      runtime: mockRuntime,
      agentDir: '/tmp/daemon-llm-retry-test',
      clawId: 'daemon-llm-retry-test',
      label: '[retry-test]',
      audit: mockAudit as unknown as AuditLog,
      inbox: { pendingDir: '/tmp/daemon-llm-retry-test/inbox/pending', fallbackTimeoutMs: 1_000 },
    });

    // Let processBatch throw and catch block reach the 30s setTimeout
    await flushMicrotasks();

    // Advance past the retry delay
    vi.advanceTimersByTime(30_001);
    await flushMicrotasks();

    // retryLastTurn must have been called
    expect(retryLastTurn).toHaveBeenCalledTimes(1);

    // AuditLog: llm_retry attempt=1
    expect(mockAudit.write).toHaveBeenCalledWith(
      'daemon_loop_llm_retry',
      'attempt=1',
      'max=3',
      'delay_ms=30000',
      expect.stringContaining('error=All LLM providers failed'),
    );

    stop();
    vi.advanceTimersByTime(1_001);
    await flushMicrotasks();
  });

  it('LLM max retries exhausted logs error to console', async () => {
    vi.useFakeTimers();
    const mockAudit = { write: vi.fn() };
    // processBatch throws once; retryLastTurn always throws → 3 retries → max exceeded
    const processBatch  = vi.fn().mockRejectedValueOnce(new LLMAllProvidersFailedError([{ provider: 'test', error: new Error('network unreachable') }]));
    const retryLastTurn = vi.fn().mockRejectedValue(new LLMAllProvidersFailedError([{ provider: 'test', error: new Error('network unreachable on retry') }]));
    const mockRuntime = { processBatch, retryLastTurn, abort: vi.fn() } as unknown as Runtime;

    const { stop } = startDaemonLoop({
      fsFactory,
      runtime: mockRuntime,
      agentDir: '/tmp/agent-max-retry',
      clawId: 'agent-max-retry',
      label: '[max-retry-test]',
      audit: mockAudit as unknown as AuditLog,
      inbox: { pendingDir: '/tmp/agent-max-retry/inbox/pending', fallbackTimeoutMs: 100 },
    });

    // Iteration 1: processBatch throws → wait 30 s
    await flushMicrotasks();
    vi.advanceTimersByTime(30_001);
    await flushMicrotasks();

    // Iteration 2: retryLastTurn throws → wait 60 s
    vi.advanceTimersByTime(60_001);
    await flushMicrotasks();

    // Iteration 3: retryLastTurn throws → wait 120 s
    vi.advanceTimersByTime(120_001);
    await flushMicrotasks();

    // Iteration 4: retryLastTurn throws → llmRetryCount=3 >= MAX → else branch → audit fatal
    // AuditLog: llm_retry × 3 + fatal
    expect(mockAudit.write).toHaveBeenCalledWith(
      'daemon_loop_llm_retry',
      'attempt=1',
      'max=3',
      'delay_ms=30000',
      expect.stringContaining('error=All LLM providers failed'),
    );
    expect(mockAudit.write).toHaveBeenCalledWith(
      'daemon_loop_llm_retry',
      'attempt=2',
      'max=3',
      'delay_ms=60000',
      expect.stringContaining('error=All LLM providers failed'),
    );
    expect(mockAudit.write).toHaveBeenCalledWith(
      'daemon_loop_llm_retry',
      'attempt=3',
      'max=3',
      'delay_ms=120000',
      expect.stringContaining('error=All LLM providers failed'),
    );
    expect(mockAudit.write).toHaveBeenCalledWith(
      'daemon_loop_fatal',
      'reason=max_retries_exhausted',
      expect.stringContaining('error=All LLM providers failed'),
    );

    stop();
    vi.advanceTimersByTime(200);
    await flushMicrotasks();
  });

  it('non-LLM error does not set llmRetryPending and skips retryLastTurn', async () => {
    vi.useFakeTimers();
    const mockAudit = { write: vi.fn() };

    const retryLastTurn = vi.fn();
    const processBatch  = vi.fn()
      .mockRejectedValueOnce(new Error('Unexpected disk I/O failure'))
      .mockResolvedValue(0);
    const mockRuntime = { processBatch, retryLastTurn, abort: vi.fn() } as unknown as Runtime;

    const { stop } = startDaemonLoop({
      fsFactory,
      runtime: mockRuntime,
      agentDir: '/tmp/non-llm-error-test',
      clawId: 'non-llm-error-test',
      label: '[non-llm-test]',
      audit: mockAudit as unknown as AuditLog,
      inbox: { pendingDir: '/tmp/non-llm-error-test/inbox/pending', fallbackTimeoutMs: 500 },
    });

    await flushMicrotasks();

    // Non-LLM error goes straight to waitForInbox (no retry delay)
    // retryLastTurn must never be called
    expect(retryLastTurn).not.toHaveBeenCalled();

    // AuditLog: fatal non_llm_error
    expect(mockAudit.write).toHaveBeenCalledWith(
      'daemon_loop_fatal',
      'reason=non_llm_error',
      expect.stringContaining('error=Unexpected disk I/O failure'),
    );

    stop();
    vi.advanceTimersByTime(600);
    await flushMicrotasks();
  });
});

// ─── interrupt audit ───────────────────────────────────────────────────────────

describe('startDaemonLoop - interrupt audit', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('IdleTimeoutSignal triggers daemon_loop_interrupt cause=idle_timeout', async () => {
    vi.useFakeTimers();
    const mockAudit = { write: vi.fn() };
    const processBatch = vi.fn().mockRejectedValueOnce(new IdleTimeoutSignal(1000));

    const mockRuntime = { processBatch, retryLastTurn: vi.fn(), abort: vi.fn() } as unknown as Runtime;

    const { stop } = startDaemonLoop({
      fsFactory,
      runtime: mockRuntime,
      agentDir: '/tmp/idle-test',
      clawId: 'idle-test',
      label: '[idle-test]',
      audit: mockAudit as unknown as AuditLog,
      inbox: { pendingDir: '/tmp/idle-test/inbox/pending', fallbackTimeoutMs: 1_000 },
    });

    await flushMicrotasks();
    vi.advanceTimersByTime(1_001);
    await flushMicrotasks();

    expect(mockAudit.write).toHaveBeenCalledWith(
      'daemon_loop_interrupt',
      'cause=idle_timeout',
      'recovery_delay_ms=1000',
    );

    stop();
    vi.advanceTimersByTime(1_001);
    await flushMicrotasks();
  });

  it('UserInterrupt triggers daemon_loop_interrupt cause=user_interrupt', async () => {
    vi.useFakeTimers();
    const mockAudit = { write: vi.fn() };
    const processBatch = vi.fn().mockRejectedValueOnce(new UserInterrupt());

    const mockRuntime = { processBatch, retryLastTurn: vi.fn(), abort: vi.fn() } as unknown as Runtime;

    const { stop } = startDaemonLoop({
      fsFactory,
      runtime: mockRuntime,
      agentDir: '/tmp/user-test',
      clawId: 'user-test',
      label: '[user-test]',
      audit: mockAudit as unknown as AuditLog,
      inbox: { pendingDir: '/tmp/user-test/inbox/pending', fallbackTimeoutMs: 1_000 },
    });

    await flushMicrotasks();
    vi.advanceTimersByTime(1_001);
    await flushMicrotasks();

    expect(mockAudit.write).toHaveBeenCalledWith(
      'daemon_loop_interrupt',
      'cause=user_interrupt',
    );

    stop();
    vi.advanceTimersByTime(1_001);
    await flushMicrotasks();
  });

  it('PriorityInboxInterrupt triggers daemon_loop_interrupt cause=priority_inbox', async () => {
    vi.useFakeTimers();
    const mockAudit = { write: vi.fn() };
    const processBatch = vi.fn().mockRejectedValueOnce(new PriorityInboxInterrupt());

    const mockRuntime = { processBatch, retryLastTurn: vi.fn(), abort: vi.fn() } as unknown as Runtime;

    const { stop } = startDaemonLoop({
      fsFactory,
      runtime: mockRuntime,
      agentDir: '/tmp/priority-test',
      clawId: 'priority-test',
      label: '[priority-test]',
      audit: mockAudit as unknown as AuditLog,
      inbox: { pendingDir: '/tmp/priority-test/inbox/pending', fallbackTimeoutMs: 1_000 },
    });

    await flushMicrotasks();

    expect(mockAudit.write).toHaveBeenCalledWith(
      'daemon_loop_interrupt',
      'cause=priority_inbox',
      'recovery_delay_ms=0',
    );

    stop();
    vi.advanceTimersByTime(1_001);
    await flushMicrotasks();
  });
});

// ─── iteration audit ───────────────────────────────────────────────────────────

describe('startDaemonLoop - iteration audit', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('chain reaction triggers daemon_loop_iteration type=chain with chain_total', async () => {
    vi.useFakeTimers();
    const mockAudit = { write: vi.fn() };
    // First call injects 2 → chain loop → 1 → 0 (terminate)
    const processBatch = vi.fn()
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);

    const mockRuntime = { processBatch, retryLastTurn: vi.fn(), abort: vi.fn() } as unknown as Runtime;

    const { stop } = startDaemonLoop({
      fsFactory,
      runtime: mockRuntime,
      agentDir: '/tmp/chain-test',
      clawId: 'chain-test',
      label: '[chain-test]',
      audit: mockAudit as unknown as AuditLog,
      inbox: { pendingDir: '/tmp/chain-test/inbox/pending', fallbackTimeoutMs: 1_000 },
    });

    await flushMicrotasks();

    expect(mockAudit.write).toHaveBeenCalledWith(
      'daemon_loop_iteration',
      'type=chain',
      'injected=2',
      'chain_total=3',
    );

    stop();
    vi.advanceTimersByTime(1_001);
    await flushMicrotasks();
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

    // mock createWatcher 捕获 callback 供手动触发
    let capturedCallback: (() => void) | null = null;
    const mockWatcher = { close: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(createWatcher).mockImplementation((_absPath, cb) => {
      capturedCallback = cb;
      return mockWatcher as unknown as Watcher;
    });

    const mockFs = {
      ensureDirSync: vi.fn(),
      resolve: vi.fn((p: string) => p),
    } as unknown as FileSystem;
    const mockAudit = { write: vi.fn() } as unknown as AuditLog;

    const promise = waitForInbox(mockFs, mockAudit, '/tmp/inbox', 60_000);

    await Promise.resolve();
    expect(capturedCallback).not.toBeNull();

    // 手动触发 callback 模拟新文件到达
    capturedCallback!();

    await expect(promise).resolves.toBeUndefined();
    expect(mockWatcher.close).toHaveBeenCalled();
  });

  it('resolves on timeout when no file arrives', async () => {
    vi.useFakeTimers();

    const mockWatcher = { close: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(createWatcher).mockReturnValue(mockWatcher as unknown as Watcher);

    const mockFs = { ensureDirSync: vi.fn(), resolve: vi.fn((p: string) => p) } as unknown as FileSystem;
    const mockAudit = { write: vi.fn() } as unknown as AuditLog;

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
    const mockAudit = { write: vi.fn() } as unknown as AuditLog;

    const promise = waitForInbox(mockFs, mockAudit, '/tmp/inbox', 60_000);

    // catch 块 void done() 应立即 resolve（不需 advance timer）
    await expect(promise).resolves.toBeUndefined();
  });

  it('settled guard: multiple done() triggers only one resolve', async () => {
    // 可选 4 it：验证 fix 7
    vi.useFakeTimers();

    let capturedCallback: (() => void) | null = null;
    const mockWatcher = { close: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(createWatcher).mockImplementation((_absPath, cb) => {
      capturedCallback = cb;
      return mockWatcher as unknown as Watcher;
    });

    const mockFs = { ensureDirSync: vi.fn(), resolve: vi.fn((p: string) => p) } as unknown as FileSystem;
    const mockAudit = { write: vi.fn() } as unknown as AuditLog;

    const promise = waitForInbox(mockFs, mockAudit, '/tmp/inbox', 1_000);
    await Promise.resolve();

    // 同时触发 callback + timeout
    capturedCallback!();
    vi.advanceTimersByTime(1_001);

    await expect(promise).resolves.toBeUndefined();
    // close 只调用一次
    expect(mockWatcher.close).toHaveBeenCalledTimes(1);
  });
});
