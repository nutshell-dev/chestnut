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
    mocks.reader.start.mockReset();
    mocks.reader.stop.mockClear();
  });

  afterEach(() => {
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
  });
});
