import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { observeProcess } from '../../../src/foundation/process-exec/process-observation.js';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));

const PID = 12345;
const START = 'Tue Nov 10 13:27:59 2026';
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const errno = (code: string) => Object.assign(new Error(`probe ${code}`), { code });
function result(overrides: Partial<SpawnSyncReturns<Buffer>> = {}): SpawnSyncReturns<Buffer> {
  const stdout = Buffer.from(`${START}    \n`);
  const stderr = Buffer.alloc(0);
  return { pid: 4321, status: 0, signal: null, stdout, stderr, output: [null, stdout, stderr], ...overrides };
}
function platform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...originalPlatform, value });
}

beforeEach(() => {
  platform('darwin');
  vi.spyOn(process, 'kill').mockReturnValue(true);
  vi.mocked(spawnSync).mockReturnValue(result());
});
afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform);
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe('observeProcess facts', () => {
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid PID %s without OS actions', pid => {
    expect(observeProcess(pid)).toEqual({ kind: 'unknown', pid, reason: 'invalid_pid', evidence: [] });
    expect(process.kill).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it.each(['win32', 'freebsd', 'aix'] as const)('reports %s as unsupported without probing', host => {
    platform(host);
    expect(observeProcess(PID)).toEqual({ kind: 'unknown', pid: PID, reason: 'unsupported_platform', evidence: [] });
    expect(process.kill).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it.each(['darwin', 'linux'] as const)('preserves successful raw results and query order on %s', host => {
    platform(host);
    const raw = result();
    vi.mocked(spawnSync).mockReturnValue(raw);
    const observation = observeProcess(PID);
    expect(observation).toEqual({
      kind: 'alive', pid: PID, startTime: START,
      evidence: [
        { operation: 'signal0', outcome: 'ok' },
        { operation: 'start_time', outcome: 'result', raw },
        { operation: 'signal0', outcome: 'ok' },
      ],
    });
    const query = observation.evidence[1];
    if (query.operation !== 'start_time' || query.outcome !== 'result') throw new Error('missing raw query');
    expect(query.raw).toBe(raw);
    expect(query.raw.stdout).toBe(raw.stdout);
    expect(process.kill).toHaveBeenNthCalledWith(1, PID, 0);
    expect(process.kill).toHaveBeenNthCalledWith(2, PID, 0);
    expect(process.kill).toHaveBeenCalledTimes(2);
    expect(spawnSync).toHaveBeenCalledExactlyOnceWith('ps', ['-p', String(PID), '-o', 'lstart='], {
      env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 1000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL',
    });
    expect(vi.mocked(process.kill).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(spawnSync).mock.invocationCallOrder[0]);
    expect(vi.mocked(spawnSync).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(process.kill).mock.invocationCallOrder[1]);
  });

  it.each(['ESRCH', 'EPERM', 'EIO'])('keeps the initial %s error', code => {
    const error = errno(code);
    vi.mocked(process.kill).mockImplementationOnce(() => { throw error; });
    const observation = observeProcess(PID);
    expect(observation).toMatchObject(code === 'ESRCH' ? { kind: 'gone' } : { kind: 'unknown', reason: 'probe_failed' });
    expect(observation.evidence).toEqual([{ operation: 'signal0', outcome: 'error', error }]);
    expect(spawnSync).not.toHaveBeenCalled();
    expect(process.kill).toHaveBeenCalledTimes(1);
  });

  const failures = [
    ['tool missing', { error: errno('ENOENT'), status: null }],
    ['timeout', { error: errno('ETIMEDOUT'), status: null, signal: 'SIGKILL' }],
    ['output overflow', { error: errno('ENOBUFS'), status: null }],
    ['signal', { status: null, signal: 'SIGTERM' }],
    ['exit one with no output', { status: 1, stdout: Buffer.alloc(0) }],
    ['other exit with diagnostics', { status: 2, stderr: Buffer.from('ps failed') }],
    ['successful exit with diagnostics', { stderr: Buffer.from('warning') }],
    ['empty output', { stdout: Buffer.alloc(0) }],
    ['only whitespace', { stdout: Buffer.from('  \n') }],
  ] satisfies [string, Partial<SpawnSyncReturns<Buffer>>][];
  it.each(failures)('%s stays unknown after a successful second presence probe', (_name, overrides) => {
    const raw = result(overrides);
    vi.mocked(spawnSync).mockReturnValue(raw);
    expect(observeProcess(PID)).toEqual({ kind: 'unknown', pid: PID, reason: 'start_time_unavailable', evidence: [
      { operation: 'signal0', outcome: 'ok' },
      { operation: 'start_time', outcome: 'result', raw },
      { operation: 'signal0', outcome: 'ok' },
    ] });
    expect(process.kill).toHaveBeenCalledTimes(2);
  });

  it.each([`${START}\n${START}\n`, 'not a date', 'Tue Nov 10 99:27:59 2026', 'Tue Nov 00 13:27:59 2026', 'Tue Nov 10 13:60:59 2026'])('rejects malformed start time %s', text => {
    const raw = result({ stdout: Buffer.from(text) });
    vi.mocked(spawnSync).mockReturnValue(raw);
    expect(observeProcess(PID)).toMatchObject({ kind: 'unknown', reason: 'malformed_start_time', evidence: [
      { operation: 'signal0', outcome: 'ok' }, { operation: 'start_time', outcome: 'result', raw }, { operation: 'signal0', outcome: 'ok' },
    ] });
  });

  it('preserves an unexpected thrown value and still performs the second probe', () => {
    const error = { detail: Buffer.from('native failure'), cause: new Error('inner') };
    vi.mocked(spawnSync).mockImplementationOnce(() => { throw error; });
    expect(observeProcess(PID)).toEqual({ kind: 'unknown', pid: PID, reason: 'start_time_unavailable', evidence: [
      { operation: 'signal0', outcome: 'ok' }, { operation: 'start_time', outcome: 'throw', error }, { operation: 'signal0', outcome: 'ok' },
    ] });
  });

  it.each(['ESRCH', 'EPERM', 'EIO'])('retains both query failure and second probe %s', code => {
    const raw = result({ error: errno('ENOBUFS'), stdout: Buffer.from('partial'), stderr: Buffer.from('diagnostic') });
    const error = errno(code);
    vi.mocked(spawnSync).mockReturnValue(raw);
    vi.mocked(process.kill).mockReturnValueOnce(true).mockImplementationOnce(() => { throw error; });
    const observation = observeProcess(PID);
    expect(observation).toMatchObject(code === 'ESRCH' ? { kind: 'gone' } : { kind: 'unknown', reason: 'probe_failed' });
    expect(observation.evidence).toEqual([
      { operation: 'signal0', outcome: 'ok' }, { operation: 'start_time', outcome: 'result', raw }, { operation: 'signal0', outcome: 'error', error },
    ]);
  });

  it('does not return alive if the process exits after a successful ps query', () => {
    const raw = result();
    const error = errno('ESRCH');
    vi.mocked(spawnSync).mockReturnValue(raw);
    vi.mocked(process.kill).mockReturnValueOnce(true).mockImplementationOnce(() => { throw error; });
    expect(observeProcess(PID)).toEqual({ kind: 'gone', pid: PID, evidence: [
      { operation: 'signal0', outcome: 'ok' }, { operation: 'start_time', outcome: 'result', raw }, { operation: 'signal0', outcome: 'error', error },
    ] });
  });
});
