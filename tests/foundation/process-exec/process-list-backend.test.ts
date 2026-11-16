import { EventEmitter } from 'events';
import { spawnSync, type spawn } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createProcessListBackends,
  findByPatternAsync,
  findByPatternSyncForCli,
} from '../../../src/foundation/process-exec/find-by-pattern.js';
import {
  ProcessListUnavailable,
  type ProcessListEvidence,
} from '../../../src/foundation/process-exec/errors.js';
import {
  findByPatternWithBackends,
  findByPatternWithBackendsSyncForCli,
  selectProcessListBackend,
  type BackendProbe,
  type ProcessListBackend,
} from '../../../src/foundation/process-exec/process-list-backend.js';

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

  it('returns no-match without invoking the companion query command', () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce({
        stdout: `${process.pid}\n`, stderr: '', status: 0, signal: null,
      } as unknown as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({
        stdout: `${process.pid} node self\n`, stderr: '', status: 0, signal: null,
      } as unknown as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({
        stdout: '', stderr: '', status: 1, signal: null,
      } as unknown as ReturnType<typeof spawnSync>);

    expect(findByPatternSyncForCli('missing-daemon')).toEqual([]);
    expect(spawnSync).toHaveBeenCalledTimes(3);
  });

  it('uses the same POSIX backend identity for sync and async nonzero exits', async () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce({
        stdout: `${process.pid}\n`, stderr: '', status: 0, signal: null,
      } as unknown as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({
        stdout: `${process.pid} node self\n`, stderr: '', status: 0, signal: null,
      } as unknown as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({
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


function evidence(
  backendId: string,
  classification: ProcessListEvidence['classification'],
): ProcessListEvidence {
  return {
    backendId,
    operation: 'probe',
    classification,
    status: null,
    signal: null,
    stderr: classification === 'available' ? '' : `${backendId} rejected`,
  };
}

function fakeBackend(options: {
  id: string;
  probe: BackendProbe;
  find?: () => Promise<Array<{ pid: number; command: string }>>;
  findSync?: () => Array<{ pid: number; command: string }>;
}): ProcessListBackend {
  return {
    id: options.id,
    probe: vi.fn().mockResolvedValue(options.probe),
    probeSyncForCli: vi.fn().mockReturnValue(options.probe),
    findByPattern: vi.fn(options.find ?? (() => Promise.resolve([]))),
    findByPatternSyncForCli: vi.fn(options.findSync ?? (() => [])),
  };
}

describe('capability registry and evidence-preserving fallback', () => {
  it('selects the first available backend and preserves rejected probe evidence', async () => {
    const unavailableCause = new Error('restricted API');
    const first = fakeBackend({
      id: 'restricted-api',
      probe: {
        kind: 'unavailable',
        backendId: 'restricted-api',
        evidence: [evidence('restricted-api', 'spawn_error')],
        error: unavailableCause,
      },
    });
    const second = fakeBackend({
      id: 'verified-api',
      probe: {
        kind: 'available',
        backendId: 'verified-api',
        evidence: [evidence('verified-api', 'available')],
      },
    });
    const third = fakeBackend({
      id: 'unused-api',
      probe: { kind: 'available', backendId: 'unused-api', evidence: [] },
    });

    const selected = await selectProcessListBackend([first, second, third], 'chestnut');
    expect(selected.backend.id).toBe('verified-api');
    expect(selected.evidence.map(item => item.backendId)).toEqual(['restricted-api', 'verified-api']);
    expect(third.probe).not.toHaveBeenCalled();
  });

  it('falls back after an unavailable probe without converting failure to no-match', async () => {
    const first = fakeBackend({
      id: 'missing-api',
      probe: {
        kind: 'unavailable',
        backendId: 'missing-api',
        evidence: [evidence('missing-api', 'unsupported')],
        error: new Error('missing'),
      },
    });
    const second = fakeBackend({
      id: 'working-api',
      probe: {
        kind: 'available',
        backendId: 'working-api',
        evidence: [evidence('working-api', 'available')],
      },
      find: () => Promise.resolve([{ pid: 42, command: 'node daemon.js' }]),
    });

    await expect(findByPatternWithBackends('daemon', {}, [first, second])).resolves.toEqual([
      { pid: 42, command: 'node daemon.js' },
    ]);
    expect(first.findByPattern).not.toHaveBeenCalled();
  });

  it('keeps prior probe and query evidence when every backend fails', async () => {
    const probeCause = new Error('probe denied');
    const first = fakeBackend({
      id: 'restricted-api',
      probe: {
        kind: 'unavailable',
        backendId: 'restricted-api',
        evidence: [evidence('restricted-api', 'spawn_error')],
        error: probeCause,
      },
    });
    const queryCause = new Error('malformed response');
    const queryError = new ProcessListUnavailable('daemon', queryCause, {
      backendId: 'broken-api',
      operation: 'parse',
      classification: 'parse_error',
    });
    const second = fakeBackend({
      id: 'broken-api',
      probe: {
        kind: 'available',
        backendId: 'broken-api',
        evidence: [evidence('broken-api', 'available')],
      },
      find: () => Promise.reject(queryError),
    });

    const error = await asyncUnavailable(findByPatternWithBackends('daemon', {}, [first, second]));
    expect(error).toMatchObject({
      code: 'PROCESS_LIST_UNAVAILABLE',
      backendId: 'registry',
      operation: 'backend',
      classification: 'unsupported',
    });
    expect(error.evidenceChain.map(item => [item.backendId, item.classification])).toEqual([
      ['restricted-api', 'spawn_error'],
      ['broken-api', 'available'],
      ['broken-api', 'parse_error'],
    ]);
    expect(error.stderr).toContain('restricted-api');
    expect(error.cause).toBeInstanceOf(AggregateError);
    const causes = (error.cause as AggregateError).errors as unknown[];
    expect(causes[0]).toBe(probeCause);
    expect(causes[1]).toBeInstanceOf(ProcessListUnavailable);
    expect((causes[1] as ProcessListUnavailable).cause).toBe(queryCause);
  });

  it('never converts all-probe failure into an empty match', async () => {
    const backends = ['a', 'b'].map(id => fakeBackend({
      id,
      probe: {
        kind: 'unavailable',
        backendId: id,
        evidence: [evidence(id, 'unsupported')],
        error: new Error(`${id} unavailable`),
      },
    }));

    await expect(findByPatternWithBackends('chestnut', {}, backends)).rejects.toMatchObject({
      code: 'PROCESS_LIST_UNAVAILABLE',
      classification: 'unsupported',
    });
    expect(backends[0]!.findByPattern).not.toHaveBeenCalled();
    expect(backends[1]!.findByPattern).not.toHaveBeenCalled();
  });

  it('treats an empty result as success and does not probe later backends', async () => {
    const first = fakeBackend({
      id: 'empty-api',
      probe: { kind: 'available', backendId: 'empty-api', evidence: [] },
      find: () => Promise.resolve([]),
    });
    const second = fakeBackend({
      id: 'later-api',
      probe: { kind: 'available', backendId: 'later-api', evidence: [] },
    });

    await expect(findByPatternWithBackends('none', {}, [first, second])).resolves.toEqual([]);
    expect(second.probe).not.toHaveBeenCalled();
  });

  it('uses one backend identity and equivalent result semantics for sync and async', async () => {
    const backend = fakeBackend({
      id: 'parity-api',
      probe: {
        kind: 'available',
        backendId: 'parity-api',
        evidence: [evidence('parity-api', 'available')],
      },
      find: () => Promise.resolve([{ pid: 7, command: 'node parity.js' }]),
      findSync: () => [{ pid: 7, command: 'node parity.js' }],
    });

    const asyncResult = await findByPatternWithBackends('parity', {}, [backend]);
    const syncResult = findByPatternWithBackendsSyncForCli('parity', [backend]);
    expect(asyncResult).toEqual(syncResult);
    expect(backend.id).toBe('parity-api');
  });
});


describe('POSIX production probe boundaries', () => {
  it('preserves partial probe evidence and the requested pattern when ps fails', async () => {
    const spawnProcess = vi.fn().mockImplementation((command: string) => {
      const child = makeChild();
      queueMicrotask(() => {
        if (command === 'pgrep') {
          child.emit('close', 1, null);
        } else {
          child.stderr.emit('data', Buffer.from('ps denied\n'));
          child.emit('close', 2, null);
        }
      });
      return asSpawn(child);
    });

    const error = await asyncUnavailable(selectProcessListBackend(
      createProcessListBackends(),
      'daemon',
      { spawnProcess: spawnProcess as unknown as typeof spawn },
    ));
    expect(error.pattern).toBe('daemon');
    expect(error).toMatchObject({ operation: 'ps', classification: 'nonzero_exit', status: 2 });
    expect(error.evidenceChain.map(item => [item.operation, item.classification])).toEqual([
      ['pgrep', 'available'],
      ['ps', 'nonzero_exit'],
    ]);
  });

  it('forwards pre-abort to the production probe without spawning', async () => {
    const controller = new AbortController();
    const reason = Object.assign(new Error('stop probe'), { code: 'ABORT_ERR' });
    controller.abort(reason);
    const spawnProcess = vi.fn();

    const error = await asyncUnavailable(selectProcessListBackend(
      createProcessListBackends(),
      'daemon',
      {
        signal: controller.signal,
        spawnProcess: spawnProcess as unknown as typeof spawn,
      },
    ));
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(error.pattern).toBe('daemon');
    expect(error.classification).toBe('abort');
    expect(error.cause).toBe(reason);
  });

  it('retains successful pgrep evidence when the sync ps probe fails', () => {
    vi.mocked(spawnSync).mockReset();
    vi.mocked(spawnSync)
      .mockReturnValueOnce({
        stdout: '', stderr: '', status: 1, signal: null,
      } as unknown as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({
        stdout: '', stderr: 'ps denied\n', status: 2, signal: null,
      } as unknown as ReturnType<typeof spawnSync>);

    const error = syncUnavailable(() => findByPatternSyncForCli('daemon'));
    expect(error.pattern).toBe('daemon');
    expect(error.evidenceChain.map(item => [item.operation, item.classification])).toEqual([
      ['pgrep', 'available'],
      ['ps', 'nonzero_exit'],
    ]);
  });
});
