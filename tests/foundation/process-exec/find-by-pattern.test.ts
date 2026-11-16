import { EventEmitter } from 'events';
import type { spawn } from 'child_process';
import { describe, expect, it, vi } from 'vitest';

import {
  findByLiteralPatternAsync,
  findByPatternAsync,
  type FindByPatternOptions,
} from '../../../src/foundation/process-exec/find-by-pattern.js';
import { ProcessListUnavailable } from '../../../src/foundation/process-exec/errors.js';

type ChildDouble = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};
type SpawnMock = ReturnType<typeof vi.fn>;

function makeChild(): ChildDouble {
  const child = new EventEmitter() as ChildDouble;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn().mockReturnValue(true);
  return child;
}

function asSpawn(child: ChildDouble): ReturnType<typeof spawn> {
  return child as unknown as ReturnType<typeof spawn>;
}

function findAsync(
  pattern: string,
  spawnMock: SpawnMock,
  options: FindByPatternOptions = {},
): ReturnType<typeof findByPatternAsync> {
  return findByPatternAsync(pattern, {
    ...options,
    spawnProcess: spawnMock as unknown as typeof spawn,
  });
}

function findLiteralAsync(
  pattern: string,
  spawnMock: SpawnMock,
): ReturnType<typeof findByLiteralPatternAsync> {
  return findByLiteralPatternAsync(pattern, { spawnProcess: spawnMock as unknown as typeof spawn });
}

function finish(
  child: ChildDouble,
  status: number | null,
  stdout = '',
  stderr = '',
  signal: NodeJS.Signals | null = null,
): void {
  if (stdout) child.stdout.emit('data', Buffer.from(stdout));
  if (stderr) child.stderr.emit('data', Buffer.from(stderr));
  child.emit('close', status, signal);
}

async function unavailableFrom(pending: Promise<unknown>): Promise<ProcessListUnavailable> {
  const error: unknown = await pending.then(() => undefined, err => err);
  expect(error).toBeInstanceOf(ProcessListUnavailable);
  if (!(error instanceof ProcessListUnavailable)) throw new Error('expected ProcessListUnavailable');
  return error;
}

describe('bounded process listing', () => {
  it('pgrep status=1 is no match and never invokes ps', async () => {
    const pgrep = makeChild();
    const spawnMock = vi.fn().mockReturnValue(asSpawn(pgrep));
    const pending = findAsync('daemon', spawnMock);
    finish(pgrep, 1);

    await expect(pending).resolves.toEqual([]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('literal async query escapes input and decodes ps output', async () => {
    const spawnMock = vi.fn().mockImplementation((command: string) => {
      const child = makeChild();
      queueMicrotask(() => {
        if (command === 'pgrep') finish(child, 0, '123\n');
        else finish(child, 0, ' 123 node daemon.js\n');
      });
      return asSpawn(child);
    });

    await expect(findLiteralAsync('a.b', spawnMock)).resolves.toEqual([
      { pid: 123, command: 'node daemon.js' },
    ]);
    expect(spawnMock).toHaveBeenNthCalledWith(1, 'pgrep', ['-f', 'a\\.b'], expect.any(Object));
  });

  it('timeout kills the child and preserves typed evidence', async () => {
    // Advance exactly to the configured listing deadline.
    const LISTING_TIMEOUT_MS = 25;
    vi.useFakeTimers();
    try {
      const pgrep = makeChild();
      const spawnMock = vi.fn().mockReturnValue(asSpawn(pgrep));
      const pending = unavailableFrom(findAsync('daemon', spawnMock, { timeoutMs: LISTING_TIMEOUT_MS }));
      await vi.advanceTimersByTimeAsync(LISTING_TIMEOUT_MS);
      const err = await pending;

      expect(pgrep.kill).toHaveBeenCalledWith('SIGKILL');
      expect(err).toMatchObject({
        backendId: 'posix-ps',
        operation: 'pgrep',
        classification: 'timeout',
        status: null,
        causeCode: 'ETIMEDOUT',
        evidence: { backendId: 'posix-ps', code: 'ETIMEDOUT', classification: 'timeout' },
      });
      pgrep.emit('close', null, 'SIGKILL');
      expect(pgrep.listenerCount('close')).toBe(0);
      expect(pgrep.listenerCount('error')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('pre-abort does not spawn and retains the abort reason', async () => {
    const controller = new AbortController();
    const reason = Object.assign(new Error('stop before spawn'), { code: 'ABORT_ERR' });
    controller.abort(reason);
    const spawnMock = vi.fn();

    const err = await unavailableFrom(findAsync('daemon', spawnMock, { signal: controller.signal }));
    expect(spawnMock).not.toHaveBeenCalled();
    expect(err.backendId).toBe('posix-ps');
    expect(err.classification).toBe('abort');
    expect(err.cause).toBe(reason);
    expect(err.causeCode).toBe('ABORT_ERR');
  });

  it('mid-abort kills once, removes subscriptions, and ignores late close/error', async () => {
    const controller = new AbortController();
    const pgrep = makeChild();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const spawnMock = vi.fn().mockReturnValue(asSpawn(pgrep));
    const pending = unavailableFrom(findAsync('daemon', spawnMock, { signal: controller.signal }));
    controller.abort(new Error('stop in flight'));
    const err = await pending;

    expect(err.classification).toBe('abort');
    expect(pgrep.kill).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    pgrep.emit('error', new Error('late kill error'));
    pgrep.emit('close', null, 'SIGKILL');
    expect(pgrep.kill).toHaveBeenCalledTimes(1);
    expect(pgrep.listenerCount('close')).toBe(0);
    expect(pgrep.listenerCount('error')).toBe(0);
    expect(pgrep.stdout.listenerCount('data')).toBe(0);
  });

  it('nonzero pgrep retains status and stderr instead of becoming no-match', async () => {
    const pgrep = makeChild();
    const spawnMock = vi.fn().mockReturnValue(asSpawn(pgrep));
    const pending = unavailableFrom(findAsync('daemon', spawnMock));
    finish(pgrep, 3, '', 'sysmond service not found\n');
    const err = await pending;

    expect(err).toMatchObject({
      backendId: 'posix-ps',
      operation: 'pgrep',
      classification: 'nonzero_exit',
      status: 3,
      stderr: 'sysmond service not found\n',
    });
    expect(err.cause).toBeInstanceOf(Error);
    expect((err.cause as Error).message).toContain('sysmond service not found');
  });

  it('ps failure is typed unavailable, never blank-command success', async () => {
    const spawnMock = vi.fn().mockImplementation((command: string) => {
      const child = makeChild();
      queueMicrotask(() => {
        if (command === 'pgrep') finish(child, 0, '123\n');
        else finish(child, 2, '', 'ps permission denied\n');
      });
      return asSpawn(child);
    });

    const err = await unavailableFrom(findAsync('daemon', spawnMock));
    expect(err).toMatchObject({
      backendId: 'posix-ps',
      operation: 'ps',
      classification: 'nonzero_exit',
      status: 2,
      stderr: 'ps permission denied\n',
    });
  });

  it('ENOENT retains the original cause and OS code', async () => {
    const pgrep = makeChild();
    const cause = Object.assign(new Error('spawn pgrep ENOENT'), { code: 'ENOENT' });
    const spawnMock = vi.fn().mockReturnValue(asSpawn(pgrep));
    const pending = unavailableFrom(findAsync('daemon', spawnMock));
    pgrep.emit('error', cause);
    const err = await pending;

    expect(err.cause).toBe(cause);
    expect(err.backendId).toBe('posix-ps');
    expect(err.causeCode).toBe('ENOENT');
    expect(err.evidence.code).toBe('ENOENT');
    expect(err.classification).toBe('spawn_error');
  });

  it('maxBuffer kills the child and reports ENOBUFS', async () => {
    const pgrep = makeChild();
    const spawnMock = vi.fn().mockReturnValue(asSpawn(pgrep));
    const pending = unavailableFrom(findAsync('daemon', spawnMock, { maxBuffer: 4 }));
    pgrep.stdout.emit('data', Buffer.from('12345\n'));
    const err = await pending;

    expect(pgrep.kill).toHaveBeenCalledWith('SIGKILL');
    expect(err.backendId).toBe('posix-ps');
    expect(err.classification).toBe('max_buffer');
    expect(err.causeCode).toBe('ENOBUFS');
    pgrep.emit('close', null, 'SIGKILL');
  });

  it('an unfinished child does not synchronously block the event loop', async () => {
    const pgrep = makeChild();
    const spawnMock = vi.fn().mockReturnValue(asSpawn(pgrep));
    let settled = false;
    const pending = findAsync('daemon', spawnMock).finally(() => { settled = true; });

    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    finish(pgrep, 1);
    await expect(pending).resolves.toEqual([]);
  });

  it('rejects malformed pgrep output instead of dropping unreadable PIDs', async () => {
    const pgrep = makeChild();
    const spawnMock = vi.fn().mockReturnValue(asSpawn(pgrep));
    const pending = unavailableFrom(findAsync('daemon', spawnMock));
    finish(pgrep, 0, '123\nnot-a-pid\n');

    const err = await pending;
    expect(err).toMatchObject({
      backendId: 'posix-ps',
      operation: 'pgrep',
      classification: 'parse_error',
    });
    expect(err.evidenceChain).toEqual([err.evidence]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('rejects empty pgrep success output instead of treating it as no-match', async () => {
    const pgrep = makeChild();
    const spawnMock = vi.fn().mockReturnValue(asSpawn(pgrep));
    const pending = unavailableFrom(findAsync('daemon', spawnMock));
    finish(pgrep, 0, ' \n');

    const err = await pending;
    expect(err).toMatchObject({
      backendId: 'posix-ps',
      operation: 'pgrep',
      classification: 'parse_error',
    });
  });

  it('rejects malformed ps rows instead of returning partial process information', async () => {
    const spawnMock = vi.fn().mockImplementation((command: string) => {
      const child = makeChild();
      queueMicrotask(() => {
        if (command === 'pgrep') finish(child, 0, '123\n');
        else finish(child, 0, '123 node daemon.js\nmalformed-row\n');
      });
      return asSpawn(child);
    });

    const err = await unavailableFrom(findAsync('daemon', spawnMock));
    expect(err).toMatchObject({
      backendId: 'posix-ps',
      operation: 'ps',
      classification: 'parse_error',
    });
    expect((err.cause as Error).message).toContain('malformed-row');
  });
});
