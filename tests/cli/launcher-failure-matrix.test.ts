import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LauncherActivityMapper, LauncherEventMapper } from '../../src/cli/launcher-envelope-producer.js';
import { executeLauncherSend } from '../../src/cli/commands/launcher-send.js';
import { executeLauncherStart } from '../../src/cli/commands/launcher-start.js';
import { runLauncherStream } from '../../src/cli/commands/launcher-stream.js';
import { readLauncherDaemon, readLauncherSnapshot } from '../../src/cli/commands/launcher-runtime.js';
import { deliverClawMessage } from '../../src/cli/commands/claw-send.js';
import type { DaemonState, LauncherSnapshotPayload } from '../../src/cli-protocol/index.js';

const mocks = vi.hoisted(() => ({
  reader: { start: vi.fn(), stop: vi.fn(async () => {}) },
  onEvent: undefined as ((event: unknown) => void) | undefined,
  bootstrap: vi.fn(),
}));

vi.mock('../../src/cli/start-bootstrap.js', () => ({
  ensureStartBootstrap: mocks.bootstrap,
  getOnboardingStatus: vi.fn(() => ({ state: 'not_found' })),
}));

vi.mock('../../src/cli/commands/launcher-runtime.js', () => ({
  readLauncherDaemon: vi.fn(),
  readLauncherSnapshot: vi.fn(),
}));
vi.mock('../../src/cli/commands/claw-send.js', () => ({ deliverClawMessage: vi.fn() }));
vi.mock('../../src/cli/commands/claw-target.js', () => ({
  assertPublishedClaw: vi.fn(() => ({ clawDir: '/tmp/motion', clawId: 'motion' })),
}));
vi.mock('../../src/foundation/stream/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/foundation/stream/index.js')>()),
  STREAM_FILE: 'stream.jsonl',
  createStreamReader: vi.fn((_fs: unknown, _file: unknown, onEvent: (event: unknown) => void) => {
    mocks.onEvent = onEvent;
    return mocks.reader;
  }),
}));
vi.mock('../../src/cli/action-scope.js', () => ({ actionAuditFor: vi.fn(() => ({ write: vi.fn() })) }));

function daemon(state: DaemonState) {
  return { state };
}

function snapshot() {
  const payload: LauncherSnapshotPayload = {
    workspace: { claw: 'motion' }, initialization: 'ready', daemon: daemon('running'),
    capabilities: {}, active: false, messages: [],
  };
  return {
    payload, tailOffset: 0, clawDir: '/tmp/motion',
    mapper: new LauncherEventMapper(), activityMapper: new LauncherActivityMapper('motion'),
  };
}

const deps = {
  fsFactory: vi.fn(), rootConfig: { getInitializationState: vi.fn(() => 'ready') },
} as never;

describe('launcher v2 failure matrix', () => {
  let stdout: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    process.exitCode = undefined;
    vi.spyOn(process, 'on').mockImplementation(() => process);
    vi.mocked(deliverClawMessage).mockResolvedValue(undefined);
    vi.mocked(readLauncherSnapshot).mockReturnValue(snapshot());
    mocks.bootstrap.mockResolvedValue({
      verified: {}, daemon: { state: 'running' }, onboarding: { state: 'created', contractId: 'onboarding' },
    });
    mocks.reader.start.mockReset();
    mocks.reader.stop.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  function envelopes() {
    return stdout.mock.calls.map(call => JSON.parse(String(call[0]))) as Array<Record<string, any>>;
  }

  it('persists but never reports processing while the daemon is stopped', async () => {
    vi.mocked(readLauncherDaemon).mockReturnValue(daemon('stopped'));
    const result = await executeLauncherSend(deps, { requestId: 'r1', text: 'ping' });
    expect(result).toMatchObject({ kind: 'send_ack', payload: { delivery: 'persisted', daemon: 'stopped' } });
  });

  it('rejects start before supervision when initialization is not ready', async () => {
    const ensureSupervision = vi.fn();
    const notReadyDeps = { rootConfig: { getInitializationState: () => 'absent' } } as never;
    await expect(executeLauncherStart(notReadyDeps, {}, { ensureSupervision })).rejects.toThrow(/setup first/);
    expect(ensureSupervision).not.toHaveBeenCalled();
  });

  it('does not return ready when shared onboarding bootstrap fails', async () => {
    mocks.bootstrap.mockRejectedValue(new Error('contract recovery failed'));
    await expect(executeLauncherStart(deps, {}, { ensureSupervision: vi.fn() }))
      .rejects.toThrow('contract recovery failed');
    expect(readLauncherDaemon).not.toHaveBeenCalled();
  });

  it('returns ready only after bootstrap and includes its onboarding fact', async () => {
    vi.mocked(readLauncherDaemon).mockReturnValue(daemon('running'));
    const result = await executeLauncherStart(deps, {}, { ensureSupervision: vi.fn() });
    expect(result).toMatchObject({
      kind: 'daemon', payload: { state: 'running', detail: 'ready', onboarding: 'created' },
    });
    expect(mocks.bootstrap.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(readLauncherDaemon).mock.invocationCallOrder[0]);
  });

  it('emits daemon stopped and terminal when a running daemon dies', async () => {
    vi.mocked(readLauncherDaemon).mockReturnValue(daemon('running'));
    await runLauncherStream(deps, {});
    vi.mocked(readLauncherDaemon).mockReturnValue(daemon('stopped'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(envelopes()).toContainEqual(expect.objectContaining({ kind: 'daemon', payload: { state: 'stopped' } }));
    expect(envelopes().at(-1)).toMatchObject({ kind: 'terminal', payload: { reason: 'stopped' } });
    expect(mocks.reader.stop).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(0);
  });

  it('reconnects with a fresh snapshot and explicit resync_required', async () => {
    vi.mocked(readLauncherDaemon).mockReturnValue(daemon('stopped'));
    await runLauncherStream(deps, { afterSequence: 3 });
    expect(envelopes()[0]).toMatchObject({
      kind: 'snapshot', sequence: 1,
      payload: { afterSequence: 3, resync: 'resync_required' },
    });
    expect(envelopes()[1]).toMatchObject({ kind: 'daemon', sequence: 2 });
    expect(envelopes()[2]).toMatchObject({ kind: 'terminal', sequence: 3, payload: { reason: 'stopped' } });
    expect(mocks.reader.start).not.toHaveBeenCalled();
  });

  it('releases its timer and both signal handlers exactly once after a signal', async () => {
    vi.mocked(readLauncherDaemon).mockReturnValue(daemon('running'));
    const remove = vi.spyOn(process, 'removeListener');
    await runLauncherStream(deps, {});
    const registrations = vi.mocked(process.on).mock.calls.filter(([event]) => event === 'SIGINT' || event === 'SIGTERM');
    expect(registrations).toHaveLength(2);
    const interrupt = registrations.find(([event]) => event === 'SIGINT')![1];
    const terminate = registrations.find(([event]) => event === 'SIGTERM')![1];
    interrupt();
    terminate();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.reader.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    for (const [event, handler] of registrations) expect(remove).toHaveBeenCalledWith(event, handler);
    expect(envelopes().filter(envelope => envelope.kind === 'terminal')).toHaveLength(1);
  });

  it('still stops the reader when terminal output fails during startup rollback', async () => {
    vi.mocked(readLauncherDaemon).mockReturnValue(daemon('running'));
    mocks.reader.start.mockImplementation(() => { throw new Error('start failed'); });
    const diagnostic = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdout.mockImplementation((data) => {
      if (JSON.parse(String(data)).kind === 'terminal') throw new Error('terminal output failed');
      return true;
    });
    await expect(runLauncherStream(deps, {})).resolves.toBeUndefined();
    expect(mocks.reader.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(diagnostic.mock.calls.flat().join('')).toContain('terminal output failed');
    expect(process.exitCode).toBe(1);
  });


  it('preserves startup, output, stop and diagnostic failures together after cleanup', async () => {
    vi.mocked(readLauncherDaemon).mockReturnValue(daemon('running'));
    const startError = new Error('start failure');
    const outputError = new Error('output failure');
    const stopError = new Error('stop failure');
    const diagnosticError = new Error('diagnostic failure');
    mocks.reader.start.mockImplementation(() => { throw startError; });
    mocks.reader.stop.mockRejectedValueOnce(stopError);
    stdout.mockImplementation((data) => {
      if (JSON.parse(String(data)).kind === 'terminal') throw outputError;
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => { throw diagnosticError; });
    const result = await runLauncherStream(deps, {}).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors).toEqual([startError, outputError, stopError, diagnosticError]);
    expect(mocks.reader.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(process.exitCode).toBe(1);
  });

  it('leaves unrelated signal listeners installed after stream shutdown', async () => {
    const other = vi.fn();
    process.addListener('SIGINT', other);
    try {
      vi.mocked(readLauncherDaemon).mockReturnValue(daemon('running'));
      await runLauncherStream(deps, {});
      const handler = vi.mocked(process.on).mock.calls.find(([event]) => event === 'SIGINT')![1];
      handler();
      await vi.advanceTimersByTimeAsync(0);
      expect(process.listeners('SIGINT')).toContain(other);
      expect(other).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      process.removeListener('SIGINT', other);
    }
  });

});
