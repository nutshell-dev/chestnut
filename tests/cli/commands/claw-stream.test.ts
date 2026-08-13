/**
 * claw-stream command tests (phase 447 Step B; phase 1377 Step B shutdown owner).
 *
 * Coverage: parseStartMode (10 cases) + claw-not-exists error path + deterministic
 * shutdown owner tests (signal / daemon-dead happy paths and stop-rejection
 * convergence). The shutdown suite captures registered signal handlers and injects
 * reader / audit / process-manager / process seams — it never registers listeners or
 * intervals against the real test process.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { streamCommand, parseStartMode } from '../../../src/cli/commands/claw-stream.js';
import type { StreamReader } from '../../../src/foundation/stream/index.js';
import { CLI_AUDIT_EVENTS } from '../../../src/cli/audit-events.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { makeClawCommandDeps, type FakeClawCommandDeps } from '../../helpers/claw-command-deps.js';

const fsFactory = (dir: string) => ({ baseDir: dir }) as unknown as ReturnType<FakeClawCommandDeps['fsFactory']>;

// ---------------------------------------------------------------------------
// vi.hoisted narrow mock state — owner seams captured once at module load and
// reset per test via resetShutdownMocks(). No module-level listeners/intervals.
// ---------------------------------------------------------------------------
const shutdownMocks = vi.hoisted(() => {
  const signalHandlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  const reader = {
    start: vi.fn<(offset?: number) => void>(),
    stop: vi.fn<() => Promise<void>>(),
  };
  const audit = {
    write: vi.fn<(type: string, ...cols: (string | number)[]) => void>(),
    message: vi.fn<(s: string) => string>(),
  };
  const aliveStatus = { value: { alive: false, reason: 'not_running' as const } };
  const procExec = {
    isAlive: vi.fn<(pid: number) => boolean>(),
    isPidArgvMatching: vi.fn<(pid: number, name: string) => boolean>(),
  };
  const exitCodes: number[] = [];
  const stdoutWrites: string[] = [];
  const stderrWrites: string[] = [];
  return {
    signalHandlers,
    reader,
    audit,
    aliveStatus,
    procExec,
    exitCodes,
    stdoutWrites,
    stderrWrites,
  };
});

vi.mock('../../../src/core/claw-topology/index.js', () => ({
  getRelativeClawDir: vi.fn((name: string) => path.join('claws', name)),
  getClawConfigPath: vi.fn((name: string) => path.join('/tmp/chestnut/claws', name, 'config.yaml')),
  getChestnutRoot: vi.fn(() => '/tmp/chestnut'),
  resolveClawDaemonDir: vi.fn((name: string) => path.join('/tmp/chestnut/claws', name, 'daemon')),
}));

vi.mock('../../../src/assembly/config/global-config-path.js', () => ({
  getGlobalConfigPath: vi.fn(() => '/tmp/chestnut/config.yaml'),
}));

vi.mock('../../../src/foundation/stream/index.js', () => ({
  STREAM_FILE: 'stream.jsonl',
  createStreamReader: vi.fn(() => shutdownMocks.reader as unknown as StreamReader),
  findRecentTurnStartOffset: vi.fn(() => 0),
}));

vi.mock('../../../src/foundation/audit/index.js', () => ({
  createSystemAudit: vi.fn(() => shutdownMocks.audit as unknown as AuditLog),
}));

vi.mock('../../../src/foundation/process-manager/index.js', () => ({
  createProcessManagerForCLI: vi.fn(() => ({
    getAliveStatus: vi.fn(() => shutdownMocks.aliveStatus.value),
  })),
}));

vi.mock('../../../src/foundation/process-exec/index.js', () => ({
  isAlive: (...args: unknown[]) => shutdownMocks.procExec.isAlive(...args as [number]),
  isPidArgvMatching: (...args: unknown[]) => shutdownMocks.procExec.isPidArgvMatching(...args as [number, string]),
}));

describe('parseStartMode', () => {
  it('default (no args) → recent-turn', () => {
    expect(parseStartMode([])).toEqual({ kind: 'recent-turn' });
  });

  it('--from-now → now', () => {
    expect(parseStartMode(['--from-now'])).toEqual({ kind: 'now' });
  });

  it('--include-history → history', () => {
    expect(parseStartMode(['--include-history'])).toEqual({ kind: 'history' });
  });

  it('--from-recent-turn → recent-turn (explicit)', () => {
    expect(parseStartMode(['--from-recent-turn'])).toEqual({ kind: 'recent-turn' });
  });

  it('--from-offset 100 → offset 100', () => {
    expect(parseStartMode(['--from-offset', '100'])).toEqual({ kind: 'offset', value: 100 });
  });

  it('--from-offset 0 → offset 0 (boundary)', () => {
    expect(parseStartMode(['--from-offset', '0'])).toEqual({ kind: 'offset', value: 0 });
  });

  it('--from-offset non-integer → CliError', () => {
    expect(() => parseStartMode(['--from-offset', 'abc'])).toThrow();
    expect(() => parseStartMode(['--from-offset', 'abc'])).toThrow(/non-negative/);
  });

  it('--from-offset negative → CliError', () => {
    expect(() => parseStartMode(['--from-offset', '-5'])).toThrow();
  });

  it('--from-offset missing value → CliError', () => {
    expect(() => parseStartMode(['--from-offset'])).toThrow();
  });

  it('multiple flags: first matched wins', () => {
    expect(parseStartMode(['--from-now', '--include-history'])).toEqual({ kind: 'now' });
  });
});

describe('streamCommand', () => {
  let commandDeps: FakeClawCommandDeps;

  beforeEach(() => {
    commandDeps = makeClawCommandDeps(fsFactory);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('throws CliError when claw does not exist', async () => {
    commandDeps.rootConfig.loadClaw.mockReturnValue(undefined);
    await expect(streamCommand(commandDeps, 'nonexistent-claw'))
      .rejects.toThrow(/does not exist/);
  });
});

// ---------------------------------------------------------------------------
// phase 1377 Step B: deterministic shutdown owner tests.
// ---------------------------------------------------------------------------
describe('streamCommand shutdown owner', () => {
  let commandDeps: FakeClawCommandDeps;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let onSpy: ReturnType<typeof vi.spyOn>;
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
  let stderrWriteSpy: ReturnType<typeof vi.spyOn>;
  let unhandledRejections: unknown[];
  let unhandledListener: (reason: unknown) => void;

  function captured(signal: string): ((...args: unknown[]) => void) | undefined {
    return shutdownMocks.signalHandlers[signal]?.[0];
  }

  // Flush all already-scheduled microtasks without relying on timers.
  async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
  }

  beforeEach(() => {
    commandDeps = makeClawCommandDeps(fsFactory);

    shutdownMocks.signalHandlers.SIGINT = [];
    shutdownMocks.signalHandlers.SIGTERM = [];
    shutdownMocks.exitCodes.length = 0;
    shutdownMocks.stdoutWrites.length = 0;
    shutdownMocks.stderrWrites.length = 0;
    shutdownMocks.reader.start.mockReset();
    shutdownMocks.reader.stop.mockReset();
    shutdownMocks.reader.stop.mockResolvedValue(undefined);
    shutdownMocks.audit.write.mockReset();
    shutdownMocks.audit.message.mockReset();
    shutdownMocks.audit.message.mockImplementation((s: string) => s);
    shutdownMocks.aliveStatus.value = { alive: false, reason: 'not_running' };
    shutdownMocks.procExec.isAlive.mockReset();
    shutdownMocks.procExec.isAlive.mockReturnValue(true);
    shutdownMocks.procExec.isPidArgvMatching.mockReset();
    shutdownMocks.procExec.isPidArgvMatching.mockReturnValue(true);

    onSpy = vi.spyOn(process, 'on').mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      if (!shutdownMocks.signalHandlers[event]) shutdownMocks.signalHandlers[event] = [];
      shutdownMocks.signalHandlers[event].push(handler);
      return process;
    });
    // process.exit seam: records code but does NOT throw — keeps the test seam's
    // throw from being misread as a production rejection.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null | undefined) => {
      shutdownMocks.exitCodes.push(typeof code === 'number' ? code : 0);
      return undefined as never;
    });
    stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      shutdownMocks.stdoutWrites.push(String(chunk));
      return true;
    });
    stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      shutdownMocks.stderrWrites.push(String(chunk));
      return true;
    });

    unhandledRejections = [];
    unhandledListener = (reason: unknown) => { unhandledRejections.push(reason); };
    process.on('unhandledRejection', unhandledListener);
  });

  afterEach(() => {
    process.removeListener('unhandledRejection', unhandledListener);
    vi.restoreAllMocks();
  });

  it('SIGINT + resolved stop → stop once + exit(0) once', async () => {
    await streamCommand(commandDeps, 'test-claw');
    expect(shutdownMocks.reader.start).toHaveBeenCalledTimes(1);

    const handler = captured('SIGINT');
    expect(handler).toBeTypeOf('function');
    handler!();
    await flushMicrotasks();

    expect(shutdownMocks.reader.stop).toHaveBeenCalledTimes(1);
    expect(shutdownMocks.exitCodes).toEqual([0]);
    expect(unhandledRejections).toEqual([]);
  });

  it('SIGTERM + resolved stop → stop once + exit(0) once', async () => {
    await streamCommand(commandDeps, 'test-claw');

    const handler = captured('SIGTERM');
    expect(handler).toBeTypeOf('function');
    handler!();
    await flushMicrotasks();

    expect(shutdownMocks.reader.stop).toHaveBeenCalledTimes(1);
    expect(shutdownMocks.exitCodes).toEqual([0]);
    expect(unhandledRejections).toEqual([]);
  });

  it('daemon-dead emits one daemon_stopped line, stop once, exit 1', async () => {
    shutdownMocks.aliveStatus.value = { alive: true, reason: 'running', pid: 12345 };
    vi.useFakeTimers();
    try {
      await streamCommand(commandDeps, 'test-claw');

      // The first liveness tick sees a dead daemon → triggers shutdown.
      shutdownMocks.procExec.isAlive.mockReturnValue(false);

      await vi.advanceTimersByTimeAsync(2000);
      await flushMicrotasks();

      const daemonStoppedLines = shutdownMocks.stdoutWrites.filter((l) => l.includes('"daemon_stopped"'));
      expect(daemonStoppedLines).toEqual([JSON.stringify({ type: 'daemon_stopped' }) + '\n']);
      expect(shutdownMocks.reader.stop).toHaveBeenCalledTimes(1);
      expect(shutdownMocks.exitCodes).toEqual([1]);
      expect(unhandledRejections).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('SIGINT stop rejection → typed failure audit, stderr, exit(1), no unhandledRejection', async () => {
    shutdownMocks.reader.stop.mockRejectedValue(new Error('watcher close failed'));

    await streamCommand(commandDeps, 'test-claw');
    captured('SIGINT')!();
    await flushMicrotasks();

    expect(shutdownMocks.audit.write).toHaveBeenCalledWith(
      CLI_AUDIT_EVENTS.STREAM_SHUTDOWN_FAILED,
      'claw_id=test-claw',
      'reason=sigint',
      'error=watcher close failed',
    );
    expect(shutdownMocks.audit.write).toHaveBeenCalledTimes(1);

    const stderr = shutdownMocks.stderrWrites.join('');
    expect(stderr).toContain('[stream]');
    expect(stderr).toContain('test-claw');
    expect(stderr).toContain('sigint');
    expect(stderr).toContain('watcher close failed');

    expect(shutdownMocks.exitCodes).toEqual([1]);
    expect(unhandledRejections).toEqual([]);
  });

  it('concurrent SIGINT + SIGTERM share single chain: stop/audit/exit once, first reason wins', async () => {
    let rejectStop!: (err: Error) => void;
    shutdownMocks.reader.stop.mockReturnValue(
      new Promise<void>((_resolve, reject) => { rejectStop = reject; }),
    );

    await streamCommand(commandDeps, 'test-claw');
    captured('SIGINT')!();
    captured('SIGTERM')!();

    rejectStop(new Error('watcher close failed'));
    await flushMicrotasks();

    expect(shutdownMocks.reader.stop).toHaveBeenCalledTimes(1);
    expect(shutdownMocks.audit.write).toHaveBeenCalledTimes(1);
    expect(shutdownMocks.audit.write).toHaveBeenCalledWith(
      CLI_AUDIT_EVENTS.STREAM_SHUTDOWN_FAILED,
      'claw_id=test-claw',
      'reason=sigint',
      'error=watcher close failed',
    );
    expect(shutdownMocks.exitCodes).toEqual([1]);
    expect(unhandledRejections).toEqual([]);
  });

  it('audit helper throw does not prevent stderr + exit(1); shutdown promise never rejects', async () => {
    shutdownMocks.reader.stop.mockRejectedValue(new Error('watcher close failed'));
    shutdownMocks.audit.message.mockImplementation(() => { throw new Error('audit boom'); });

    await streamCommand(commandDeps, 'test-claw');
    captured('SIGINT')!();
    await flushMicrotasks();

    const stderr = shutdownMocks.stderrWrites.join('');
    expect(stderr).toContain('watcher close failed');
    expect(stderr.toLowerCase()).toContain('audit');
    expect(shutdownMocks.exitCodes).toEqual([1]);
    expect(unhandledRejections).toEqual([]);
  });
});
