import { EventEmitter } from 'events';
import { spawnSync, type spawn } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  findByPatternAsync,
  findByPatternSyncForCli,
} from '../../../src/foundation/process-exec/find-by-pattern.js';
import { ProcessListUnavailable } from '../../../src/foundation/process-exec/errors.js';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawnSync: vi.fn() };
});

type ChildDouble = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

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

function syncUnavailable(run: () => unknown): ProcessListUnavailable {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ProcessListUnavailable);
    if (error instanceof ProcessListUnavailable) return error;
  }
  throw new Error('expected synchronous ProcessListUnavailable');
}

async function asyncUnavailable(pending: Promise<unknown>): Promise<ProcessListUnavailable> {
  const error: unknown = await pending.then(() => undefined, err => err);
  expect(error).toBeInstanceOf(ProcessListUnavailable);
  if (error instanceof ProcessListUnavailable) return error;
  throw new Error('expected asynchronous ProcessListUnavailable');
}

describe('process-list backend selection and evidence', () => {
  beforeEach(() => {
    vi.mocked(spawnSync).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns no-match without invoking the companion listing command', () => {
    vi.mocked(spawnSync).mockReturnValue({
      stdout: '', stderr: '', status: 1, signal: null,
    } as unknown as ReturnType<typeof spawnSync>);

    expect(findByPatternSyncForCli('missing-daemon')).toEqual([]);
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it('uses the same POSIX backend identity for sync and async nonzero exits', async () => {
    vi.mocked(spawnSync).mockReturnValue({
      stdout: '', stderr: 'permission denied\n', status: 3, signal: null,
    } as unknown as ReturnType<typeof spawnSync>);
    const syncError = syncUnavailable(() => findByPatternSyncForCli('daemon'));

    const child = makeChild();
    const spawnProcess = vi.fn().mockReturnValue(asSpawn(child));
    const pending = asyncUnavailable(findByPatternAsync('daemon', {
      spawnProcess: spawnProcess as unknown as typeof spawn,
    }));
    child.stderr.emit('data', Buffer.from('permission denied\n'));
    child.emit('close', 3, null);
    const asyncError = await pending;

    expect(syncError.backendId).toBe('posix-ps');
    expect(asyncError.backendId).toBe(syncError.backendId);
    expect(asyncError.evidence).toEqual(syncError.evidence);
    expect(syncError.evidence).toMatchObject({
      operation: 'pgrep',
      classification: 'nonzero_exit',
      status: 3,
      signal: null,
      stderr: 'permission denied\n',
    });
  });

  it('retains the original synchronous command failure and OS code', () => {
    const cause = Object.assign(new Error('spawnSync pgrep ENOENT'), { code: 'ENOENT' });
    vi.mocked(spawnSync).mockImplementation(() => { throw cause; });

    const error = syncUnavailable(() => findByPatternSyncForCli('daemon'));
    expect(error.cause).toBe(cause);
    expect(error).toMatchObject({
      backendId: 'posix-ps',
      operation: 'pgrep',
      classification: 'spawn_error',
      causeCode: 'ENOENT',
      evidence: { backendId: 'posix-ps', code: 'ENOENT' },
    });
  });

  it('reports unsupported hosts through the same typed sync and async boundary', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const spawnProcess = vi.fn();

    const syncError = syncUnavailable(() => findByPatternSyncForCli('daemon'));
    const asyncError = await asyncUnavailable(findByPatternAsync('daemon', {
      spawnProcess: spawnProcess as unknown as typeof spawn,
    }));

    for (const error of [syncError, asyncError]) {
      expect(error).toMatchObject({
        backendId: 'unsupported',
        operation: 'backend',
        classification: 'unsupported',
        status: null,
        signal: null,
        stderr: '',
        evidence: {
          backendId: 'unsupported',
          operation: 'backend',
          classification: 'unsupported',
        },
      });
      expect(error.cause).toBeInstanceOf(Error);
      expect((error.cause as Error).message).toContain('win32');
    }
    expect(spawnSync).not.toHaveBeenCalled();
    expect(spawnProcess).not.toHaveBeenCalled();
  });
});
