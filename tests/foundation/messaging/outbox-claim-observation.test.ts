import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OutboxReader } from '../../../src/foundation/messaging/index.js';
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
const PROCESSING_DIR = '/claw/outbox/processing';
const PENDING_TARGET = '/claw/outbox/pending/msg.md';
const DEFAULT_RAW_NAME = 'cli_42_0_abc123_msg.md';

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
  rawName?: string;
  mtimeMs?: number;
  statError?: unknown;
  writeAtomic?: (targetPath: string, content: string) => Promise<WriteResult>;
} = {}): { fs: FileSystem; writes: CapturedWrite[] } {
  const rawName = options.rawName ?? DEFAULT_RAW_NAME;
  const mtimeMs = options.mtimeMs ?? NOW - 1_000;
  const writes: CapturedWrite[] = [];
  const fs = {
    list: vi.fn().mockImplementation((dir: string) => Promise.resolve(
      dir === PROCESSING_DIR ? [{ name: rawName }] : [],
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

describe('OutboxReader claim observation and recovery decisions', () => {
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

    await new OutboxReader(fs, audit).init('/claw');

    expect(fs.move).not.toHaveBeenCalled();
    expect(fs.writeExclusiveSync).not.toHaveBeenCalled();
    const records = capturedRecords(writes);
    expect(records).toHaveLength(2);
    const processFacts = { decoded: legacyReference(42), observed };
    expect(records[0]).toMatchObject({
      version: 1,
      sequence: 1,
      atMs: NOW,
      sourceDir: PROCESSING_DIR,
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

  it('reclaims a gone owner only after both observation and decision records are durable', async () => {
    const startTime = 'Mon Jan 01 00:00:00 2020';
    const rawName = `cli_42_${Buffer.from(startTime).toString('hex')}_abc123_msg.md`;
    const observed = goneObservation(42);
    vi.mocked(inspectProcessRef).mockReturnValue(observed);
    const { fs, writes } = makeMockFs({ rawName });
    const { audit } = makeAudit();

    await new OutboxReader(fs, audit).init('/claw');

    expect(fs.move).toHaveBeenCalledWith(
      `${PROCESSING_DIR}/${rawName}`,
      expect.stringMatching(/^\/claw\/outbox\/pending\/\.tmp_[0-9a-f]{8}_msg\.md\.staging$/),
    );
    expect(fs.writeExclusiveSync).toHaveBeenCalledWith(PENDING_TARGET, 'message content');
    const records = capturedRecords(writes);
    expect(records.map(record => record.event)).toEqual(['process_observed', 'decision']);
    expect(records[0].process).toEqual({ decoded: legacyReference(42, startTime), observed });
    expect(records[1].decision).toEqual({ kind: 'reclaim', reason: 'process_gone' });
  });

  it('does not turn an over-age nonzero-startTime claim into a lease recovery', async () => {
    const startTime = 'Mon Jan 01 00:00:00 2020';
    const rawName = `cli_42_${Buffer.from(startTime).toString('hex')}_abc123_msg.md`;
    const observed = queryFailureObservation(42);
    vi.mocked(inspectProcessRef).mockReturnValue(observed);
    const { fs, writes } = makeMockFs({ rawName, mtimeMs: NOW - THRESHOLD_MS });
    const { audit } = makeAudit();

    await new OutboxReader(fs, audit).init('/claw');

    expect(fs.move).not.toHaveBeenCalled();
    expect(fs.writeExclusiveSync).not.toHaveBeenCalled();
    const records = capturedRecords(writes);
    expect(records[1].lease).toEqual({
      thresholdMs: THRESHOLD_MS,
      observedAtMs: NOW,
      valueMs: NOW - THRESHOLD_MS,
    });
    expect(records[1].decision).toEqual({ kind: 'retain', reason: 'unknown' });
  });

  it.each([
    { label: 'zero startTime', rawName: 'cli_42_0_abc123_msg.md' },
    { label: 'PID-only token', rawName: 'cli_42_abc123_msg.md' },
  ])('reclaims an over-age $label claim by lease without rewriting unknown as gone', async ({ rawName }) => {
    const observed = queryFailureObservation(42);
    vi.mocked(inspectProcessRef).mockReturnValue(observed);
    const { fs, writes } = makeMockFs({ rawName, mtimeMs: NOW - THRESHOLD_MS });
    const { audit } = makeAudit();

    await new OutboxReader(fs, audit).init('/claw');

    expect(fs.writeExclusiveSync).toHaveBeenCalledWith(PENDING_TARGET, 'message content');
    const records = capturedRecords(writes);
    expect(records[0].process).toEqual({ decoded: legacyReference(42), observed });
    expect(records[1].decision).toEqual({ kind: 'reclaim', reason: 'lease_elapsed' });
    expect(records[1].process).toEqual({ decoded: legacyReference(42), observed });
  });

  it('keeps a no-PID legacy name on the mtime-only lease path', async () => {
    const { fs, writes } = makeMockFs({
      rawName: 'cli_legacy_msg.md',
      mtimeMs: NOW - THRESHOLD_MS,
    });
    const { audit } = makeAudit();

    await new OutboxReader(fs, audit).init('/claw');

    expect(inspectProcessRef).not.toHaveBeenCalled();
    expect(fs.writeExclusiveSync).toHaveBeenCalledWith(PENDING_TARGET, 'message content');
    const records = capturedRecords(writes);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      event: 'decision',
      lease: { thresholdMs: THRESHOLD_MS, observedAtMs: NOW, valueMs: NOW - THRESHOLD_MS },
      decision: { kind: 'reclaim', reason: 'lease_elapsed' },
    });
    expect(records[0].process).toBeUndefined();
  });

  it.each([
    { label: 'non-finite', mtimeMs: Number.NaN, leaseValue: { valueMsText: 'NaN' } },
    { label: 'future', mtimeMs: NOW + THRESHOLD_MS, leaseValue: { valueMs: NOW + THRESHOLD_MS } },
  ])('does not expire a $label mtime', async ({ mtimeMs, leaseValue }) => {
    vi.mocked(inspectProcessRef).mockReturnValue(queryFailureObservation(42));
    const { fs, writes } = makeMockFs({ mtimeMs });
    const { audit } = makeAudit();

    await new OutboxReader(fs, audit).init('/claw');

    expect(fs.move).not.toHaveBeenCalled();
    const records = capturedRecords(writes);
    expect(records[1].lease).toEqual({
      thresholdMs: THRESHOLD_MS,
      observedAtMs: NOW,
      ...leaseValue,
    });
    expect(records[1].decision).toEqual({ kind: 'retain', reason: 'lease_active' });
  });

  it('blocks source and target changes when the reclaim decision is not durable', async () => {
    const observed = goneObservation(42);
    vi.mocked(inspectProcessRef).mockReturnValue(observed);
    const durabilityError = Object.assign(new Error('directory fsync failed'), { code: 'EIO' });
    const writeResult: WriteResult = {
      kind: 'committed_durability_unknown',
      error: durabilityError,
    };
    const { fs } = makeMockFs({
      writeAtomic: async (_targetPath, content) => (
        content.includes('"event":"decision"') ? writeResult : { kind: 'durable' }
      ),
    });
    const { audit } = makeAudit();

    const error = await persistenceError(new OutboxReader(fs, audit).init('/claw'));

    expect(error.cause).toBe(durabilityError);
    expect(error.writeResult).toBe(writeResult);
    expect(error.pendingRecord.event).toBe('decision');
    expect(error.pendingRecord.decision).toEqual({ kind: 'reclaim', reason: 'process_gone' });
    expect(error.pendingRecord.process).toEqual({ decoded: legacyReference(42), observed });
    expect(fs.move).not.toHaveBeenCalled();
    expect(fs.writeExclusiveSync).not.toHaveBeenCalled();
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

    const error = await persistenceError(new OutboxReader(fs, audit).init('/claw'));

    expect(error.cause).toBe(writeError);
    expect(error.pendingRecord.event).toBe('process_observed');
    expect(error.pendingRecord.process).toEqual({ decoded: legacyReference(42), observed });
    expect(fs.move).not.toHaveBeenCalled();
    expect(fs.writeExclusiveSync).not.toHaveBeenCalled();
  });

  it('does not inspect or move after stat failure and preserves both stat and storage errors', async () => {
    const originalStatError = Object.assign(new Error('stat EIO'), {
      code: 'EIO',
      detail: 'original-stat-fact',
    });
    const storageError = new Error('decision record failed');
    const { fs } = makeMockFs({
      statError: originalStatError,
      writeAtomic: async (_targetPath, content) => {
        if (content.includes('"event":"decision"')) throw storageError;
        return { kind: 'durable' };
      },
    });
    const { audit, events } = makeAudit();

    const error = await persistenceError(new OutboxReader(fs, audit).init('/claw'));

    expect(error.originalStatError).toBe(originalStatError);
    expect(error.cause).toBe(storageError);
    expect(error.pendingRecord).toMatchObject({
      rawName: DEFAULT_RAW_NAME,
      originalName: 'msg.md',
      event: 'decision',
      decision: { kind: 'skip', reason: 'stat_failed' },
    });
    expect(error.pendingRecord.process).toBeUndefined();
    expect(error.pendingRecord.lease).toBeUndefined();
    expect(inspectProcessRef).not.toHaveBeenCalled();
    expect(fs.move).not.toHaveBeenCalled();
    expect(fs.writeExclusiveSync).not.toHaveBeenCalled();
    expect(events.some(event =>
      event[0] === 'outbox_claim_failed' && String(event).includes('op=reconcile_stat')
    )).toBe(true);
  });

  it('records source_absent without observing when stat reports ENOENT', async () => {
    const { fs, writes } = makeMockFs({ statError: enoent('processing source') });
    const { audit } = makeAudit();

    await new OutboxReader(fs, audit).init('/claw');

    expect(inspectProcessRef).not.toHaveBeenCalled();
    expect(fs.move).not.toHaveBeenCalled();
    expect(fs.writeExclusiveSync).not.toHaveBeenCalled();
    const records = capturedRecords(writes);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      event: 'decision',
      decision: { kind: 'skip', reason: 'source_absent' },
    });
  });

  it('retains an invalid legacy reference even when its mtime lease is over age', async () => {
    const rawName = 'cli_9007199254740992_0_abc123_msg.md';
    const { fs, writes } = makeMockFs({ rawName, mtimeMs: NOW - THRESHOLD_MS });
    const { audit } = makeAudit();

    await new OutboxReader(fs, audit).init('/claw');

    expect(inspectProcessRef).not.toHaveBeenCalled();
    expect(fs.move).not.toHaveBeenCalled();
    const records = capturedRecords(writes);
    expect(records).toHaveLength(2);
    expect(records[0].process?.observed).toBeUndefined();
    expect(records[0].process?.decoded.kind).toBe('invalid');
    expect(records[1].decision).toEqual({ kind: 'retain', reason: 'invalid_reference' });
  });
});
