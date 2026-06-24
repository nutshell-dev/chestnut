import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { testClawDaemonDir, testMotionDaemonDir } from '../helpers/daemon-dir.js';
import { createDaemonCommand, _resetDaemonSignalHandlers } from '../../src/daemon/daemon.js';

let stopFn: (() => void) | null = null;

vi.mock('../../src/daemon/daemon-loop.js', () => ({
  startDaemonLoop: vi.fn(() => {
    let resolve: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    stopFn = () => resolve();
    return { promise, stop: stopFn };
  }),
}));

vi.mock('../../src/foundation/audit/index.js', () => ({
  createSystemAudit: vi.fn(() => ({
    write: vi.fn(),
    preview: vi.fn((s: string) => s),
    message: vi.fn((s: string) => s),
    summary: vi.fn((s: string) => s),
  })),
}));

vi.mock('../../src/core/claw-topology/claw-instance-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/claw-topology/claw-instance-paths.js')>();
  return {
    ...actual,
    getClawDir: vi.fn(() => '/tmp/test-claw'),
    getNamedSubrootDir: vi.fn(() => '/tmp/test-motion'),
    getClawConfigPath: vi.fn(() => '/tmp/test-claw/config.yaml'),
  };
});
vi.mock('../../src/assembly/config-load.js', async () => ({
  loadGlobalConfig: vi.fn(() => ({})),
  isInitialized: vi.fn(),
  saveGlobalConfig: vi.fn(),
  loadClawConfig: vi.fn(() => ({})),
  patchGlobalConfigPrimary: vi.fn(),
  saveClawConfig: vi.fn(),
  clawExists: vi.fn(() => true),
  buildLLMConfig: vi.fn(),
}));

vi.mock('../../src/foundation/process-manager/index.js', () => ({
  createAgentProcessManager: vi.fn(() => ({
    selfWritePid: vi.fn().mockResolvedValue(undefined),
    markReady: vi.fn().mockResolvedValue(undefined),
    selfRemovePid: vi.fn().mockResolvedValue(undefined),
  })),
  makeDaemonDir: (s: string) => s,
  LockConflictError: class LockConflictError extends Error {},
}));

const mockFs = {
  list: vi.fn().mockResolvedValue([]),
  readSync: vi.fn().mockReturnValue('test-agents-md'),
  delete: vi.fn().mockResolvedValue(undefined),
};

const daemonCommand = createDaemonCommand({
  fsFactory: () => mockFs as any,
  assemble: vi.fn().mockResolvedValue({
    runtime: { initialize: vi.fn().mockResolvedValue(undefined) },
    streamWriter: {},
    snapshot: { commit: vi.fn().mockResolvedValue({ ok: true }) },
    auditWriter: { write: vi.fn() },
    heartbeat: null,
  }),
  disassemble: vi.fn().mockResolvedValue(undefined),
  auditEvents: {
    assembleFailed: 'assemble_failed',
    daemonStart: 'daemon_start',
    daemonCrash: 'daemon_crash',
  },
});

async function flushMicrotasks(n = 10): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

describe('daemon signal handler idempotent install (phase 175)', () => {
  beforeEach(() => {
    _resetDaemonSignalHandlers();
    stopFn = null;
  });

  afterEach(() => {
    if (stopFn) {
      stopFn();
      stopFn = null;
    }
    _resetDaemonSignalHandlers();
    vi.clearAllMocks();
  });

  it('case 1: daemonCommand 调 2 次 SIGTERM listener 不增', async () => {
    const before = process.listeners('SIGTERM').length;

    const p1 = daemonCommand('test-claw-1');
    await flushMicrotasks(10);
    const afterFirst = process.listeners('SIGTERM').length;

    if (stopFn) {
      stopFn();
      stopFn = null;
    }
    await p1.catch(() => { /* silent: shutdown */ });

    const p2 = daemonCommand('test-claw-2');
    await flushMicrotasks(10);
    const afterSecond = process.listeners('SIGTERM').length;

    if (stopFn) {
      stopFn();
      stopFn = null;
    }
    await p2.catch(() => { /* silent: shutdown */ });

    expect(afterFirst - before).toBe(1);
    expect(afterSecond).toBe(afterFirst);
  });

  it('case 2: _resetDaemonSignalHandlers 清 0', async () => {
    const beforeTerm = process.listeners('SIGTERM').length;
    const beforeInt = process.listeners('SIGINT').length;
    const beforeUncaught = process.listeners('uncaughtException').length;
    const beforeUnhandled = process.listeners('unhandledRejection').length;

    const p = daemonCommand('test-claw');
    await flushMicrotasks(10);

    expect(process.listeners('SIGTERM').length).toBe(beforeTerm + 1);
    expect(process.listeners('SIGINT').length).toBe(beforeInt + 1);
    expect(process.listeners('uncaughtException').length).toBe(beforeUncaught + 1);
    expect(process.listeners('unhandledRejection').length).toBe(beforeUnhandled + 1);

    if (stopFn) {
      stopFn();
      stopFn = null;
    }
    await p.catch(() => { /* silent: shutdown */ });

    _resetDaemonSignalHandlers();

    expect(process.listeners('SIGTERM').length).toBe(beforeTerm);
    expect(process.listeners('SIGINT').length).toBe(beforeInt);
    expect(process.listeners('uncaughtException').length).toBe(beforeUncaught);
    expect(process.listeners('unhandledRejection').length).toBe(beforeUnhandled);
  });

  it('case 3: 4 handler 全 idempotent', async () => {
    const beforeUncaught = process.listeners('uncaughtException').length;
    const beforeUnhandled = process.listeners('unhandledRejection').length;
    const beforeSigterm = process.listeners('SIGTERM').length;
    const beforeSigint = process.listeners('SIGINT').length;

    const p1 = daemonCommand('test-claw-1');
    await flushMicrotasks(10);

    expect(process.listeners('uncaughtException').length - beforeUncaught).toBe(1);
    expect(process.listeners('unhandledRejection').length - beforeUnhandled).toBe(1);
    expect(process.listeners('SIGTERM').length - beforeSigterm).toBe(1);
    expect(process.listeners('SIGINT').length - beforeSigint).toBe(1);

    if (stopFn) {
      stopFn();
      stopFn = null;
    }
    await p1.catch(() => { /* silent: shutdown */ });

    const p2 = daemonCommand('test-claw-2');
    await flushMicrotasks(10);

    expect(process.listeners('uncaughtException').length - beforeUncaught).toBe(1);
    expect(process.listeners('unhandledRejection').length - beforeUnhandled).toBe(1);
    expect(process.listeners('SIGTERM').length - beforeSigterm).toBe(1);
    expect(process.listeners('SIGINT').length - beforeSigint).toBe(1);

    if (stopFn) {
      stopFn();
      stopFn = null;
    }
    await p2.catch(() => { /* silent: shutdown */ });
  });
});
