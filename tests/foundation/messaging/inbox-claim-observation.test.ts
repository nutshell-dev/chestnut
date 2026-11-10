import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InboxReader } from '../../../src/foundation/messaging/index.js';
import {
  ClaimObservationPersistenceError,
  type ClaimRecord,
} from '../../../src/foundation/messaging/claim-observation-store.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import {
  decodeProcessRef,
  inspectProcessRef,
  type ProcessRefObservation,
} from '../../../src/foundation/process-exec/index.js';
import { encodeProcessEvidence } from '../../../src/foundation/process-exec/process-evidence.js';

vi.mock(import('../../../src/foundation/process-exec/index.js'), async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/foundation/process-exec/index.js')>();
  return { ...actual, inspectProcessRef: vi.fn() };
});

const NOW = 1_700_000_000_000;
const THRESHOLD_MS = 300_000;
const PENDING_DIR = '/claw/inbox/pending';
const INFLIGHT_DIR = '/claw/inbox/inflight';
const PENDING_TARGET = `${PENDING_DIR}/msg.md`;
const DEFAULT_RAW_NAME = '42_0_msg.md';

type WriteResult = Awaited<ReturnType<FileSystem['writeAtomic']>>;
type CapturedWrite = { targetPath: string; content: string };

function enoent(targetPath: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: ${targetPath}`), { code: 'ENOENT' });
}

function queryFailureObservation(pid: number): ProcessRefObservation {
  const cause = Object.assign(new Error('query backend unavailable'), { code: 'EIO' });
  const error = Object.assign(new Error('signal0 EIO', { cause }), {
    code: 'EIO',
    errno: -5,
    syscall: 'kill',
  });
  return {
    kind: 'unknown',
    reason: 'query_failed',
    evidence: encodeProcessEvidence(NOW - 2, [
      {
        operation: 'inspect',
        outcome: 'start',
        compatibility: 'legacy-v0',
        reference: { version: 0, pid },
      },
      {
        operation: 'observe',
        outcome: {
          kind: 'unknown',
          reason: 'query_failed',
          evidence: [
            { operation: 'signal0', outcome: 'throw', error },
            { operation: 'query_bytes', outcome: 'result', stdout: Buffer.from([0, 1, 255]) },
          ],
        },
      },
      { operation: 'decision', outcome: { kind: 'unknown', reason: 'query_failed' } },
    ]),
  };
}

function goneObservation(pid: number): ProcessRefObservation {
  return {
    kind: 'gone',
    reason: 'absent',
    evidence: encodeProcessEvidence(NOW - 2, [
      {
        operation: 'inspect',
        outcome: 'start',
        compatibility: 'legacy-v0',
        reference: { version: 0, pid },
      },
      { operation: 'signal0', outcome: 'error', error: { code: 'ESRCH' } },
      { operation: 'decision', outcome: { kind: 'gone', reason: 'absent' } },
    ]),
  };
}

function makeAudit() {
  const events: Array<[string, ...unknown[]]> = [];
  return {
    audit: {
      write: (type: string, ...columns: unknown[]) => { events.push([type, ...columns]); },
      preview: (value: string) => value,
      message: (value: string) => value,
      summary: (value: string) => value,
    },
    events,
  };
}

function makeMockFs(options: {
  rawNames?: string[];
  mtimeMs?: number;
  statError?: unknown;
  writeAtomic?: (targetPath: string, content: string) => Promise<WriteResult>;
} = {}): { fs: FileSystem; writes: CapturedWrite[] } {
  const rawNames = options.rawNames ?? [DEFAULT_RAW_NAME];
  const mtimeMs = options.mtimeMs ?? NOW - 1_000;
  const writes: CapturedWrite[] = [];
  const fs = {
    list: vi.fn().mockImplementation((dir: string) => Promise.resolve(
      dir === INFLIGHT_DIR ? rawNames.map(name => ({ name })) : [],
    )),
    stat: vi.fn().mockImplementation(() => {
      if (options.statError !== undefined) return Promise.reject(options.statError);
      return Promise.resolve({
        mtime: { getTime: () => mtimeMs } as Date,
        ctime: new Date(mtimeMs),
        size: 1,
        isDirectory: false,
        isFile: true,
      });
    }),
    read: vi.fn().mockImplementation((targetPath: string) => (
      targetPath.includes('.staging')
        ? Promise.resolve('message content')
        : Promise.reject(enoent(targetPath))
    )),
    move: vi.fn().mockResolvedValue(undefined),
    ensureDir: vi.fn().mockResolvedValue(undefined),
    mkdirExclusiveSync: vi.fn(),
    writeAtomic: vi.fn().mockImplementation(async (targetPath: string, content: string) => {
      writes.push({ targetPath, content });
      return options.writeAtomic
        ? options.writeAtomic(targetPath, content)
        : { kind: 'durable' };
    }),
    writeExclusiveSync: vi.fn(),
    deleteSync: vi.fn(),
  } as unknown as FileSystem;
  return { fs, writes };
}

function makeReader(fs: FileSystem, audit: ReturnType<typeof makeAudit>['audit']): InboxReader {
  return new InboxReader(
    PENDING_DIR,
    '/claw/inbox/done',
    '/claw/inbox/failed',
    fs,
    audit,
    INFLIGHT_DIR,
  );
}

function capturedRecords(writes: CapturedWrite[]): ClaimRecord[] {
  return writes
    .map(({ content }) => JSON.parse(content) as Partial<ClaimRecord>)
    .filter((record): record is ClaimRecord => record.event !== undefined);
}

function legacyReference(pid: number, startTime?: string) {
  const decoded = decodeProcessRef({
    version: 0,
    pid,
    ...(startTime !== undefined && { startTime }),
  });
  if (decoded.kind !== 'decoded') throw new Error('expected a valid legacy test reference');
  return decoded;
}

async function persistenceError(promise: Promise<unknown>): Promise<ClaimObservationPersistenceError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ClaimObservationPersistenceError);
    return error as ClaimObservationPersistenceError;
  }
  throw new Error('expected claim observation persistence failure');
}

describe('InboxReader claim observation and recovery decisions', () => {
  beforeEach(() => {
    vi.mocked(inspectProcessRef).mockReset();
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retains a fresh claim after EIO and persists the complete unknown facts before its decision', async () => {
    const observed = queryFailureObservation(42);
    vi.mocked(inspectProcessRef).mockReturnValue(observed);
    const { fs, writes } = makeMockFs();
    const { audit } = makeAudit();

    const result = await makeReader(fs, audit).init();

    expect(result).toEqual({ kind: 'ready', recovered: 0 });
    expect(fs.move).not.toHaveBeenCalled();
    expect(fs.writeExclusiveSync).not.toHaveBeenCalled();
    const records = capturedRecords(writes);
    expect(records).toHaveLength(2);
    const processFacts = { decoded: legacyReference(42), observed };
    expect(records[0]).toMatchObject({
      version: 1,
      sequence: 1,
      atMs: NOW,
      sourceDir: INFLIGHT_DIR,
      rawName: DEFAULT_RAW_NAME,
      originalName: 'msg.md',
      event: 'process_observed',
    });
    expect(records[0].process).toEqual(processFacts);
    expect(records[1]).toMatchObject({
      sequence: 2,
      rawName: DEFAULT_RAW_NAME,
      originalName: 'msg.md',
      event: 'decision',
      lease: { thresholdMs: THRESHOLD_MS, observedAtMs: NOW, valueMs: NOW - 1_000 },
      decision: { kind: 'retain', reason: 'lease_active' },
    });
    expect(records[1].process).toEqual(processFacts);
    expect(inspectProcessRef).toHaveBeenCalledWith(legacyReference(42).value);
  });

  it('does not stat or reclaim an over-age nonzero-startTime claim with an unknown owner', async () => {
    const startTime = 'Mon Jan 01 00:00:00 2020';
    const rawName = `42_${Buffer.from(startTime).toString('hex')}_msg.md`;
    const observed = queryFailureObservation(42);
    vi.mocked(inspectProcessRef).mockReturnValue(observed);
    const { fs, writes } = makeMockFs({ rawNames: [rawName], mtimeMs: NOW - THRESHOLD_MS });
    const { audit } = makeAudit();

    await makeReader(fs, audit).init();

    expect(fs.stat).not.toHaveBeenCalled();
    expect(fs.move).not.toHaveBeenCalled();
    expect(fs.writeExclusiveSync).not.toHaveBeenCalled();
    const records = capturedRecords(writes);
    const processFacts = { decoded: legacyReference(42, startTime), observed };
    expect(records[0].process).toEqual(processFacts);
    expect(records[1].process).toEqual(processFacts);
    expect(records[1].lease).toBeUndefined();
    expect(records[1].decision).toEqual({ kind: 'retain', reason: 'unknown' });
  });

  it('reclaims a gone owner only after complete observation and decision records are durable', async () => {
    const startTime = 'Mon Jan 01 00:00:00 2020';
    const rawName = `42_${Buffer.from(startTime).toString('hex')}_msg.md`;
    const observed = goneObservation(42);
    vi.mocked(inspectProcessRef).mockReturnValue(observed);
    const { fs, writes } = makeMockFs({ rawNames: [rawName] });
    const { audit } = makeAudit();

    const result = await makeReader(fs, audit).init();

    expect(result).toEqual({ kind: 'ready', recovered: 1 });
    expect(fs.stat).not.toHaveBeenCalled();
    expect(fs.move).toHaveBeenCalledWith(
      `${INFLIGHT_DIR}/${rawName}`,
      expect.stringMatching(/^\/claw\/inbox\/pending\/\.tmp_[0-9a-f]{8}_msg\.md\.staging$/),
    );
    expect(fs.writeExclusiveSync).toHaveBeenCalledWith(PENDING_TARGET, 'message content');
    const records = capturedRecords(writes);
    const processFacts = { decoded: legacyReference(42, startTime), observed };
    expect(records.map(record => record.event)).toEqual(['process_observed', 'decision']);
    expect(records[0].process).toEqual(processFacts);
    expect(records[1].process).toEqual(processFacts);
    expect(records[1].lease).toBeUndefined();
    expect(records[1].decision).toEqual({ kind: 'reclaim', reason: 'process_gone' });
  });

  it('reclaims an over-age startTime=0 claim by lease without rewriting unknown as gone', async () => {
    const observed = queryFailureObservation(42);
    vi.mocked(inspectProcessRef).mockReturnValue(observed);
    const { fs, writes } = makeMockFs({ mtimeMs: NOW - THRESHOLD_MS });
    const { audit } = makeAudit();

    await makeReader(fs, audit).init();

    expect(fs.writeExclusiveSync).toHaveBeenCalledWith(PENDING_TARGET, 'message content');
    const records = capturedRecords(writes);
    const processFacts = { decoded: legacyReference(42), observed };
    expect(records[0].process).toEqual(processFacts);
    expect(records[1].process).toEqual(processFacts);
    expect(records[1].lease).toEqual({
      thresholdMs: THRESHOLD_MS,
      observedAtMs: NOW,
      valueMs: NOW - THRESHOLD_MS,
    });
    expect(records[1].decision).toEqual({ kind: 'reclaim', reason: 'lease_elapsed' });
  });

  it('keeps a no-PID legacy name on the mtime-only lease path', async () => {
    const { fs, writes } = makeMockFs({
      rawNames: ['legacy-no-pid.md'],
      mtimeMs: NOW - THRESHOLD_MS,
    });
    const { audit } = makeAudit();

    await makeReader(fs, audit).init();

    expect(inspectProcessRef).not.toHaveBeenCalled();
    expect(fs.writeExclusiveSync).toHaveBeenCalledWith(
      `${PENDING_DIR}/legacy-no-pid.md`,
      'message content',
    );
    const records = capturedRecords(writes);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      event: 'decision',
      lease: { thresholdMs: THRESHOLD_MS, observedAtMs: NOW, valueMs: NOW - THRESHOLD_MS },
      decision: { kind: 'reclaim', reason: 'lease_elapsed' },
    });
    expect(records[0].process).toBeUndefined();
  });

  it('records source_absent without restoring when stat reports ENOENT', async () => {
    const observed = queryFailureObservation(42);
    vi.mocked(inspectProcessRef).mockReturnValue(observed);
    const { fs, writes } = makeMockFs({ statError: enoent('inflight source') });
    const { audit } = makeAudit();

    const result = await makeReader(fs, audit).init();

    expect(result).toEqual({ kind: 'ready', recovered: 0 });
    expect(fs.move).not.toHaveBeenCalled();
    expect(fs.writeExclusiveSync).not.toHaveBeenCalled();
    const records = capturedRecords(writes);
    const processFacts = { decoded: legacyReference(42), observed };
    expect(records).toHaveLength(2);
    expect(records[0].process).toEqual(processFacts);
    expect(records[1].process).toEqual(processFacts);
    expect(records[1].lease).toBeUndefined();
    expect(records[1].decision).toEqual({ kind: 'skip', reason: 'source_absent' });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'does not expire a non-finite mtime (%s)',
    async mtimeMs => {
      const observed = queryFailureObservation(42);
      vi.mocked(inspectProcessRef).mockReturnValue(observed);
      const { fs, writes } = makeMockFs({ mtimeMs });
      const { audit } = makeAudit();

      await makeReader(fs, audit).init();

      expect(fs.move).not.toHaveBeenCalled();
      const records = capturedRecords(writes);
      const processFacts = { decoded: legacyReference(42), observed };
      expect(records[0].process).toEqual(processFacts);
      expect(records[1].process).toEqual(processFacts);
      expect(records[1].lease).toEqual({
        thresholdMs: THRESHOLD_MS,
        observedAtMs: NOW,
        valueMsText: String(mtimeMs),
      });
      expect(records[1].decision).toEqual({ kind: 'retain', reason: 'lease_active' });
    },
  );

  it('retains an invalid legacy reference without stat or lease fallback', async () => {
    const rawName = '9007199254740992_0_msg.md';
    const { fs, writes } = makeMockFs({ rawNames: [rawName], mtimeMs: NOW - THRESHOLD_MS });
    const { audit } = makeAudit();

    await makeReader(fs, audit).init();

    expect(inspectProcessRef).not.toHaveBeenCalled();
    expect(fs.stat).not.toHaveBeenCalled();
    expect(fs.move).not.toHaveBeenCalled();
    const decoded = decodeProcessRef({ version: 0, pid: 9_007_199_254_740_992 });
    const records = capturedRecords(writes);
    expect(records).toHaveLength(2);
    expect(records[0].process).toEqual({ decoded });
    expect(records[1].process).toEqual({ decoded });
    expect(records[1].lease).toBeUndefined();
    expect(records[1].decision).toEqual({ kind: 'retain', reason: 'invalid_reference' });
  });

  it('blocks source and target changes when the observation record throws', async () => {
    const observed = goneObservation(42);
    vi.mocked(inspectProcessRef).mockReturnValue(observed);
    const writeError = new Error('record write failed');
    const { fs } = makeMockFs({
      writeAtomic: async (_targetPath, content) => {
        if (content.includes('"event":"process_observed"')) throw writeError;
        return { kind: 'durable' };
      },
    });
    const { audit } = makeAudit();

    const error = await persistenceError(makeReader(fs, audit).init());

    expect(error.cause).toBe(writeError);
    expect(error.pendingRecord.event).toBe('process_observed');
    expect(error.pendingRecord.process).toEqual({ decoded: legacyReference(42), observed });
    expect(fs.move).not.toHaveBeenCalled();
    expect(fs.writeExclusiveSync).not.toHaveBeenCalled();
  });

  it.each([
    'committed_platform_limited',
    'committed_durability_unknown',
  ] as const)('blocks source and target changes after a %s reclaim decision', async kind => {
    const observed = goneObservation(42);
    vi.mocked(inspectProcessRef).mockReturnValue(observed);
    const durabilityError = Object.assign(new Error(`directory fsync: ${kind}`), { code: 'EIO' });
    const writeResult: WriteResult = { kind, error: durabilityError };
    const { fs } = makeMockFs({
      writeAtomic: async (_targetPath, content) => (
        content.includes('"event":"decision"') ? writeResult : { kind: 'durable' }
      ),
    });
    const { audit } = makeAudit();

    const error = await persistenceError(makeReader(fs, audit).init());

    expect(error.cause).toBe(durabilityError);
    expect(error.writeResult).toBe(writeResult);
    expect(error.pendingRecord.event).toBe('decision');
    expect(error.pendingRecord.decision).toEqual({ kind: 'reclaim', reason: 'process_gone' });
    expect(error.pendingRecord.process).toEqual({ decoded: legacyReference(42), observed });
    expect(fs.move).not.toHaveBeenCalled();
    expect(fs.writeExclusiveSync).not.toHaveBeenCalled();
  });

  it('preserves both stat and storage errors when the stat_failed decision cannot be stored', async () => {
    const originalStatError = Object.assign(new Error('stat EIO'), {
      code: 'EIO',
      detail: 'original-stat-fact',
    });
    const storageError = new Error('decision record failed');
    const { fs } = makeMockFs({
      rawNames: ['legacy-no-pid.md'],
      statError: originalStatError,
      writeAtomic: async (_targetPath, content) => {
        if (content.includes('"event":"decision"')) throw storageError;
        return { kind: 'durable' };
      },
    });
    const { audit, events } = makeAudit();

    const error = await persistenceError(makeReader(fs, audit).init());

    expect(error.originalStatError).toBe(originalStatError);
    expect(error.cause).toBe(storageError);
    expect(error.pendingRecord).toMatchObject({
      rawName: 'legacy-no-pid.md',
      originalName: 'legacy-no-pid.md',
      event: 'decision',
      decision: { kind: 'skip', reason: 'stat_failed' },
    });
    expect(error.pendingRecord.process).toBeUndefined();
    expect(error.pendingRecord.lease).toBeUndefined();
    expect(fs.move).not.toHaveBeenCalled();
    expect(fs.writeExclusiveSync).not.toHaveBeenCalled();
    expect(events.some(event =>
      event[0] === 'inbox_move_failed' && String(event).includes('op=reconcile_stat')
    )).toBe(true);
  });

  it('returns typed claim partial_failure from active drain without changing source or target', async () => {
    const observed = goneObservation(42);
    vi.mocked(inspectProcessRef).mockReturnValue(observed);
    const writeError = new Error('active decision record failed');
    const { fs } = makeMockFs({
      writeAtomic: async (_targetPath, content) => {
        if (content.includes('"event":"decision"')) throw writeError;
        return { kind: 'durable' };
      },
    });
    const { audit } = makeAudit();

    const result = await makeReader(fs, audit).drainAndDeliver();

    expect(result.kind).toBe('partial_failure');
    if (result.kind !== 'partial_failure') throw new Error('unreachable');
    expect(result.stage).toBe('claim');
    expect(result.entry).toBe(DEFAULT_RAW_NAME);
    expect(result.error).toBeInstanceOf(ClaimObservationPersistenceError);
    expect((result.error as ClaimObservationPersistenceError).cause).toBe(writeError);
    expect(result.entries).toEqual([]);
    expect(result.handles).toEqual([]);
    expect(result.transientErrors).toBe(0);
    expect(result.permanentErrors).toBe(0);
    expect(fs.move).not.toHaveBeenCalled();
    expect(fs.writeExclusiveSync).not.toHaveBeenCalled();
    expect(fs.list).not.toHaveBeenCalledWith(PENDING_DIR, { includeDirs: false });
  });

  it('keeps the first completed restore and stops when the second entry decision fails', async () => {
    const startTime = 'Mon Jan 01 00:00:00 2020';
    const startTimeHex = Buffer.from(startTime).toString('hex');
    const firstRawName = `42_${startTimeHex}_first.md`;
    const secondRawName = `42_${startTimeHex}_second.md`;
    const observed = goneObservation(42);
    vi.mocked(inspectProcessRef).mockReturnValue(observed);
    const writeError = new Error('second decision record failed');
    const { fs } = makeMockFs({
      rawNames: [firstRawName, secondRawName],
      writeAtomic: async (_targetPath, content) => {
        if (content.includes(secondRawName) && content.includes('"event":"decision"')) {
          throw writeError;
        }
        return { kind: 'durable' };
      },
    });
    const { audit } = makeAudit();

    const error = await persistenceError(makeReader(fs, audit).init());

    expect(error.entry).toBe(secondRawName);
    expect(error.cause).toBe(writeError);
    expect(error.pendingRecord.process).toEqual({
      decoded: legacyReference(42, startTime),
      observed,
    });
    expect(fs.move).toHaveBeenCalledTimes(1);
    expect(fs.move).toHaveBeenCalledWith(
      `${INFLIGHT_DIR}/${firstRawName}`,
      expect.stringMatching(/^\/claw\/inbox\/pending\/\.tmp_[0-9a-f]{8}_first\.md\.staging$/),
    );
    expect(fs.move).not.toHaveBeenCalledWith(
      `${INFLIGHT_DIR}/${secondRawName}`,
      expect.anything(),
    );
    expect(fs.writeExclusiveSync).toHaveBeenCalledTimes(1);
    expect(fs.writeExclusiveSync).toHaveBeenCalledWith(`${PENDING_DIR}/first.md`, 'message content');
  });
});
