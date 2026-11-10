import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { FileNotFoundError } from '../../../src/foundation/fs/index.js';
import * as processExec from '../../../src/foundation/process-exec/index.js';
import type {
  ProcessEvidence,
  ProcessRef,
  ProcessRefCapture,
  ProcessRefDecode,
  ProcessRefObservation,
} from '../../../src/foundation/process-exec/index.js';
import { withSkillStateLock } from '../../../src/foundation/skill-system/state-lock.js';
import { SkillVersionError } from '../../../src/foundation/skill-system/version-types.js';
import { cleanupTempDir, createTrackedTempDir } from '../../utils/temp.js';

const NOW = 1_800_000_000_000;
const EVIDENCE: ProcessEvidence = { version: 1, atMs: 0, facts: [] };
const REF = 'decoded-ref' as ProcessRef;
const SELF_CAPTURE: ProcessRefCapture = {
  kind: 'captured', value: 'self-ref' as ProcessRef, evidence: EVIDENCE,
};

type StoredRecord = {
  version: number;
  event: string;
  attemptId: string;
  sequence: number;
  atMs: number;
  lockRaw: string;
  process: { decoded?: ProcessRefDecode; observed?: ProcessRefObservation };
  lease?: { source: string; valueMs: number | null; valueMsText?: string; limitMs: number };
  decision: { kind: string; reason: string } | 'stop';
};

let tempDir: string;
let nodeFs: NodeFileSystem;

beforeEach(async () => {
  tempDir = await createTrackedTempDir('skill-state-lock-');
  nodeFs = new NodeFileSystem({ baseDir: tempDir });
  vi.spyOn(processExec, 'captureCurrentProcessRef').mockReturnValue(SELF_CAPTURE);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempDir(tempDir);
});

function writeLock(raw: string): void {
  fs.writeFileSync(path.join(tempDir, 'state.lock'), raw);
}

function v2Raw(holder: unknown = { kind: 'unknown' }, at: unknown = NOW): string {
  return JSON.stringify({
    lock_version: 2,
    at,
    observationAttemptId: 'writer-attempt',
    holder,
    pid: 99999999,
  });
}

function mockDecode(decoded: ProcessRefDecode = { kind: 'decoded', value: REF }) {
  return vi.spyOn(processExec, 'decodeProcessRef').mockReturnValue(decoded);
}

function mockObservation(observed: ProcessRefObservation) {
  const decode = mockDecode();
  const inspect = vi.spyOn(processExec, 'inspectProcessRef').mockReturnValue(observed);
  return { decode, inspect };
}

function readRecords(): StoredRecord[] {
  const dir = path.join(tempDir, 'state-lock-observations');
  if (!fs.existsSync(dir)) return [];
  return new NodeFileSystem({ baseDir: tempDir })
    .listSync('state-lock-observations', { recursive: true })
    .filter(entry => entry.isFile && /^\d{6}\.json$/.test(entry.name))
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(entry => JSON.parse(nodeFs.readSync(entry.path)) as StoredRecord)
    .filter(record => record.event !== 'self_capture');
}

async function catchStoreError(promise: Promise<unknown>): Promise<SkillVersionError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SkillVersionError);
    expect((error as SkillVersionError).kind).toBe('store_error');
    return error as SkillVersionError;
  }
  throw new Error('expected SkillVersionError(store_error)');
}

/** Simulate the other owner releasing only after N durable wait decisions. */
function releaseAfterWaits(count = 1): ReturnType<typeof vi.spyOn> {
  const original = nodeFs.writeAtomicSync.bind(nodeFs);
  let waits = 0;
  return vi.spyOn(nodeFs, 'writeAtomicSync').mockImplementation((relativePath, content) => {
    const result = original(relativePath, content);
    if (content.includes('"event":"holder_decision"') && content.includes('"kind":"wait"')) {
      waits += 1;
      if (waits === count) nodeFs.deleteSync('state.lock');
    }
    return result;
  });
}

describe('SkillSystem state lock persisted observations', () => {
  it('adapts legacy pid through L1 v0 and persists gone facts before process_gone takeover', async () => {
    const raw = JSON.stringify({ pid: 4321, at: NOW });
    writeLock(raw);
    const observed = { kind: 'gone', reason: 'absent', evidence: EVIDENCE } as const;
    const { decode, inspect } = mockObservation(observed);
    let calls = 0;

    await withSkillStateLock(nodeFs, async () => {
      calls += 1;
      const current = JSON.parse(nodeFs.readSync('state.lock')) as Record<string, unknown>;
      expect(Object.keys(current).sort()).toEqual([
        'at', 'holder', 'lock_version', 'observationAttemptId',
      ]);
      expect(current).toMatchObject({
        lock_version: 2,
        holder: { kind: 'reference', ref: SELF_CAPTURE.kind === 'captured' ? SELF_CAPTURE.value : '' },
      });
      expect(current).not.toHaveProperty('pid');
    });

    expect(calls).toBe(1);
    expect(decode).toHaveBeenCalledWith({ version: 0, pid: 4321, startTime: undefined });
    expect(inspect).toHaveBeenCalledWith(REF);
    expect(readRecords()).toHaveLength(1);
    expect(readRecords()[0]).toMatchObject({
      version: 1,
      event: 'holder_decision',
      sequence: 2,
      lockRaw: raw,
      process: { decoded: { kind: 'decoded', value: REF }, observed },
      decision: { kind: 'takeover', reason: 'process_gone' },
    });
    expect(readRecords()[0].lease).toBeUndefined();
    const index = JSON.parse(nodeFs.readSync(
      `state-lock-observations/${readRecords()[0].attemptId}.json`,
    )) as Record<string, unknown>;
    expect(index).toEqual({
      version: 1,
      attemptId: readRecords()[0].attemptId,
      lockFileName: 'state.lock',
    });
    expect(fs.existsSync(path.join(tempDir, 'state.lock'))).toBe(false);
  });

  it('keeps a fresh alive v2 holder, records every OS observation, then acquires after release', async () => {
    const raw = v2Raw({ kind: 'reference', ref: 'opaque-ref' });
    writeLock(raw);
    const observed = { kind: 'alive', evidence: EVIDENCE } as const;
    const { decode } = mockObservation(observed);
    releaseAfterWaits(2);
    let calls = 0;

    await withSkillStateLock(nodeFs, async () => { calls += 1; });

    expect(calls).toBe(1);
    expect(decode).toHaveBeenCalledTimes(2);
    expect(decode).toHaveBeenCalledWith('opaque-ref');
    const records = readRecords();
    expect(records).toHaveLength(2);
    expect(records.map(record => record.sequence)).toEqual([2, 3]);
    for (const record of records) {
      expect(record).toMatchObject({
        lockRaw: raw,
        process: { decoded: { kind: 'decoded', value: REF }, observed },
        lease: { source: 'at', valueMs: NOW, limitMs: 30_000 },
        decision: { kind: 'wait', reason: 'held' },
      });
    }
  });

  it('never treats unknown as death, but retains independent lease_elapsed takeover', async () => {
    const fresh = v2Raw();
    writeLock(fresh);
    const decode = vi.spyOn(processExec, 'decodeProcessRef');
    const inspect = vi.spyOn(processExec, 'inspectProcessRef');
    releaseAfterWaits();
    await withSkillStateLock(nodeFs, async () => undefined);
    expect(decode).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    expect(readRecords()[0].decision).toEqual({ kind: 'wait', reason: 'unknown' });

    await cleanupTempDir(tempDir);
    tempDir = await createTrackedTempDir('skill-state-lock-');
    nodeFs = new NodeFileSystem({ baseDir: tempDir });
    const expired = v2Raw({ kind: 'unknown' }, NOW - 30_001);
    writeLock(expired);
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    let calls = 0;
    await withSkillStateLock(nodeFs, async () => { calls += 1; });
    expect(calls).toBe(1);
    expect(readRecords()[0]).toMatchObject({
      process: {},
      decision: { kind: 'takeover', reason: 'lease_elapsed' },
    });
  });

  it('allows an independently expired alive holder only as lease_elapsed, never process_gone', async () => {
    const raw = v2Raw({ kind: 'reference', ref: 'opaque-ref' }, NOW - 30_001);
    writeLock(raw);
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    mockObservation({ kind: 'alive', evidence: EVIDENCE });

    await withSkillStateLock(nodeFs, async () => undefined);

    expect(readRecords()[0]).toMatchObject({
      process: { observed: { kind: 'alive' } },
      decision: { kind: 'takeover', reason: 'lease_elapsed' },
    });
  });

  it('allows an independently expired invalid reference only as lease_elapsed', async () => {
    const raw = JSON.stringify({ pid: -1, at: NOW - 30_001 });
    writeLock(raw);
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const decoded = { kind: 'invalid', reason: 'invalid_v0_shape_or_pid', evidence: EVIDENCE } as const;
    mockDecode(decoded);
    const inspect = vi.spyOn(processExec, 'inspectProcessRef');

    await withSkillStateLock(nodeFs, async () => undefined);

    expect(inspect).not.toHaveBeenCalled();
    expect(readRecords()[0]).toMatchObject({
      process: { decoded },
      decision: { kind: 'takeover', reason: 'lease_elapsed' },
    });
  });

  it('persists decoder invalid facts without inspect and does not confuse them with death', async () => {
    const raw = JSON.stringify({ pid: -1, at: NOW });
    writeLock(raw);
    const decoded = { kind: 'invalid', reason: 'invalid_v0_shape_or_pid', evidence: EVIDENCE } as const;
    const decode = mockDecode(decoded);
    const inspect = vi.spyOn(processExec, 'inspectProcessRef');
    releaseAfterWaits();

    await withSkillStateLock(nodeFs, async () => undefined);

    expect(decode).toHaveBeenCalledWith({ version: 0, pid: -1, startTime: undefined });
    expect(inspect).not.toHaveBeenCalled();
    expect(readRecords()[0]).toMatchObject({
      process: { decoded },
      decision: { kind: 'wait', reason: 'unknown' },
    });
  });

  it.each([
    ['malformed JSON', '{"pid":'],
    ['null', 'null'],
    ['array', '[]'],
    ['invalid v2 holder', v2Raw({ kind: 'reference', ref: '' }, 0)],
  ])('uses only mtime lease rules for a corrupt known lock: %s', async (_label, raw) => {
    writeLock(raw);
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    nodeFs.utimesSync('state.lock', new Date(0), new Date(NOW - 30_001));
    const decode = vi.spyOn(processExec, 'decodeProcessRef');

    await withSkillStateLock(nodeFs, async () => undefined);

    expect(decode).not.toHaveBeenCalled();
    expect(readRecords()[0]).toMatchObject({
      lockRaw: raw,
      process: {},
      lease: { source: 'mtime', valueMs: NOW - 30_001 },
      decision: { kind: 'takeover', reason: 'lease_elapsed' },
    });
  });

  it('waits on a future lock version forever rather than reclaiming it by age or legacy fields', async () => {
    const raw = JSON.stringify({
      lock_version: 3,
      pid: 99999999,
      at: NOW - 120_000,
      holder: { kind: 'reference', ref: 'future-ref' },
    });
    writeLock(raw);
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const decode = vi.spyOn(processExec, 'decodeProcessRef');
    const stat = vi.spyOn(nodeFs, 'stat');
    releaseAfterWaits();

    await withSkillStateLock(nodeFs, async () => undefined);

    expect(decode).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
    expect(readRecords()[0]).toMatchObject({
      process: {},
      decision: { kind: 'wait', reason: 'unsupported_version' },
    });
    expect(readRecords()[0].lease).toBeUndefined();
  });

  it.each([
    ['expired at', NOW - 30_001, 'takeover'],
    ['exactly at threshold', NOW - 30_000, 'wait'],
    ['future at', NOW + 30_001, 'wait'],
  ])('applies strict lease comparison for %s', async (_label, at, expected) => {
    const raw = JSON.stringify({ at });
    writeLock(raw);
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    if (expected === 'wait') releaseAfterWaits();

    await withSkillStateLock(nodeFs, async () => undefined);

    expect(readRecords()[0].lease).toMatchObject({ source: 'at', valueMs: at });
    expect(readRecords()[0].decision.kind).toBe(expected);
  });

  it('prioritizes a finite positive at over an independently expired mtime', async () => {
    writeLock(JSON.stringify({ at: NOW }));
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    nodeFs.utimesSync('state.lock', new Date(0), new Date(0));
    const stat = vi.spyOn(nodeFs, 'stat');
    releaseAfterWaits();

    await withSkillStateLock(nodeFs, async () => undefined);

    expect(stat).not.toHaveBeenCalled();
    expect(readRecords()[0].decision).toEqual({ kind: 'wait', reason: 'unknown' });
  });

  it.each([
    ['expired', NOW - 30_001, 'takeover'],
    ['equal', NOW - 30_000, 'wait'],
  ])('uses mtime when at is invalid: %s boundary', async (_label, mtime, expected) => {
    writeLock(JSON.stringify({ at: 0 }));
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    nodeFs.utimesSync('state.lock', new Date(0), new Date(mtime));
    if (expected === 'wait') releaseAfterWaits();

    await withSkillStateLock(nodeFs, async () => undefined);

    expect(readRecords()[0].lease).toMatchObject({ source: 'mtime', valueMs: mtime });
    expect(readRecords()[0].decision.kind).toBe(expected);
  });

  it('waits on non-finite mtime and retains its exact non-JSON value category', async () => {
    writeLock('{}');
    const original = nodeFs.stat.bind(nodeFs);
    vi.spyOn(nodeFs, 'stat').mockImplementation(async relativePath => ({
      ...await original(relativePath),
      mtime: new Date(Number.NaN),
    }));
    releaseAfterWaits();

    await withSkillStateLock(nodeFs, async () => undefined);

    expect(readRecords()[0].lease).toMatchObject({
      source: 'mtime', valueMs: null, valueMsText: 'NaN',
    });
    expect(readRecords()[0].decision).toEqual({ kind: 'wait', reason: 'unknown' });
  });

  it.each(['read', 'stat'] as const)('retries %s ENOENT as absent without deleting the observed lock', async operation => {
    writeLock(operation === 'read' ? '{}' : JSON.stringify({ at: 0 }));
    const originalDelete = nodeFs.delete.bind(nodeFs);
    const deletion = vi.spyOn(nodeFs, 'delete').mockImplementation(originalDelete);
    if (operation === 'read') {
      vi.spyOn(nodeFs, 'read').mockImplementationOnce(async () => {
        nodeFs.deleteSync('state.lock');
        throw new FileNotFoundError('state.lock');
      });
    } else {
      vi.spyOn(nodeFs, 'stat').mockImplementationOnce(async () => {
        nodeFs.deleteSync('state.lock');
        throw new FileNotFoundError('state.lock');
      });
    }
    let calls = 0;

    await withSkillStateLock(nodeFs, async () => {
      calls += 1;
      expect(deletion).not.toHaveBeenCalled();
    });

    expect(calls).toBe(1);
    expect(deletion).toHaveBeenCalledTimes(1); // normal release only
    expect(readRecords()[0]).toMatchObject({
      process: {},
      decision: { kind: 'retry', reason: 'absent' },
    });
  });

  it('wraps a non-ENOENT read error with the original exception and stops', async () => {
    writeLock('{}');
    const original = Object.assign(new Error('read EIO'), { code: 'EIO' });
    vi.spyOn(nodeFs, 'read').mockRejectedValue(original);
    const deletion = vi.spyOn(nodeFs, 'delete');
    let calls = 0;

    const error = await catchStoreError(withSkillStateLock(nodeFs, async () => { calls += 1; }));

    expect(calls).toBe(0);
    expect(deletion).not.toHaveBeenCalled();
    expect(error.cause).toMatchObject({ operation: 'read', error: original });
    expect(readRecords()).toHaveLength(0);
  });

  it('persists prior process facts before stat EIO, then preserves the original error', async () => {
    const raw = JSON.stringify({ pid: 1234, at: 0 });
    writeLock(raw);
    const observed = { kind: 'unknown', reason: 'identity_unverifiable', evidence: EVIDENCE } as const;
    mockObservation(observed);
    const original = Object.assign(new Error('stat EIO'), { code: 'EIO' });
    vi.spyOn(nodeFs, 'stat').mockRejectedValue(original);
    const deletion = vi.spyOn(nodeFs, 'delete');
    let calls = 0;

    const error = await catchStoreError(withSkillStateLock(nodeFs, async () => { calls += 1; }));

    expect(calls).toBe(0);
    expect(deletion).not.toHaveBeenCalled();
    expect(error.cause).toMatchObject({
      operation: 'stat',
      lockRaw: raw,
      processFacts: { decoded: { kind: 'decoded', value: REF }, observed },
      error: original,
      recordPath: expect.stringMatching(/000002\.json$/),
    });
    expect(readRecords()[0]).toMatchObject({
      event: 'observation_before_io_failure',
      lockRaw: raw,
      process: { decoded: { kind: 'decoded', value: REF }, observed },
      operation: 'stat',
      decision: 'stop',
    });
  });

  it.each(['decode', 'inspect'] as const)('wraps an unexpected L1 %s throw and never reclaims', async stage => {
    const raw = JSON.stringify({ pid: process.pid, at: NOW - 120_000 });
    writeLock(raw);
    const original = new Error(`unexpected ${stage}`);
    if (stage === 'decode') {
      vi.spyOn(processExec, 'decodeProcessRef').mockImplementation(() => { throw original; });
    } else {
      mockDecode();
      vi.spyOn(processExec, 'inspectProcessRef').mockImplementation(() => { throw original; });
    }
    const deletion = vi.spyOn(nodeFs, 'delete');
    let calls = 0;

    const error = await catchStoreError(withSkillStateLock(nodeFs, async () => { calls += 1; }));

    expect(calls).toBe(0);
    expect(deletion).not.toHaveBeenCalled();
    expect(error.cause).toMatchObject({ lockRaw: raw, error: original });
    expect(readRecords()).toHaveLength(0);
  });

  it('does not bypass L1 for a legacy lock owned by this same process', async () => {
    const raw = JSON.stringify({ pid: process.pid, at: NOW });
    writeLock(raw);
    const { decode, inspect } = mockObservation({
      kind: 'unknown', reason: 'identity_unverifiable', evidence: EVIDENCE,
    });
    releaseAfterWaits();

    await withSkillStateLock(nodeFs, async () => undefined);

    expect(decode).toHaveBeenCalledWith({ version: 0, pid: process.pid, startTime: undefined });
    expect(inspect).toHaveBeenCalledWith(REF);
    expect(readRecords()[0].decision).toEqual({ kind: 'wait', reason: 'unknown' });
  });

  it('stops on evidence write failure with pendingRecord and original error, without fn/delete', async () => {
    const raw = JSON.stringify({ pid: 4321, at: NOW });
    writeLock(raw);
    mockObservation({ kind: 'gone', reason: 'absent', evidence: EVIDENCE });
    const originalWrite = nodeFs.writeAtomicSync.bind(nodeFs);
    const original = new Error('evidence write failed');
    vi.spyOn(nodeFs, 'writeAtomicSync').mockImplementation((relativePath, content) => {
      if (content.includes('"event":"holder_decision"')) throw original;
      return originalWrite(relativePath, content);
    });
    const deletion = vi.spyOn(nodeFs, 'delete');
    let calls = 0;

    const error = await catchStoreError(withSkillStateLock(nodeFs, async () => { calls += 1; }));

    expect(calls).toBe(0);
    expect(deletion).not.toHaveBeenCalled();
    expect(error.cause).toMatchObject({
      kind: 'state_lock_observation_persistence_failed',
      lockRaw: raw,
      pendingRecord: {
        event: 'holder_decision',
        lockRaw: raw,
        decision: { kind: 'takeover', reason: 'process_gone' },
      },
      recordPath: expect.stringMatching(/000002\.json$/),
      error: original,
    });
    expect(error.evidence[0]).toContain('state-lock-observations/');
  });

  it.each([
    ['committed_platform_limited'],
    ['committed_durability_unknown'],
  ] as const)('stops on %s evidence and retains the complete writeResult without retrying', async kind => {
    const raw = JSON.stringify({ pid: 4321, at: NOW });
    writeLock(raw);
    mockObservation({ kind: 'gone', reason: 'absent', evidence: EVIDENCE });
    const originalWrite = nodeFs.writeAtomicSync.bind(nodeFs);
    const original = Object.assign(new Error(`durability ${kind}`), { code: 'EIO' });
    const writeResult = { kind, error: original };
    const write = vi.spyOn(nodeFs, 'writeAtomicSync').mockImplementation((relativePath, content) => {
      const actual = originalWrite(relativePath, content);
      if (content.includes('"event":"holder_decision"')) {
        expect(actual.kind).toBe('durable');
        return writeResult;
      }
      return actual;
    });
    const deletion = vi.spyOn(nodeFs, 'delete');
    let calls = 0;

    const error = await catchStoreError(withSkillStateLock(nodeFs, async () => { calls += 1; }));

    expect(calls).toBe(0);
    expect(deletion).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(3); // index + capture + one committed decision; no retry
    expect(error.cause).toMatchObject({
      pendingRecord: { lockRaw: raw },
      writeResult,
      error: original,
    });
    expect(readRecords()).toHaveLength(1); // committed bytes remain readable
  });

  it('retains both stat and evidence errors when the before-I/O record itself fails', async () => {
    writeLock(JSON.stringify({ at: 0 }));
    const statError = Object.assign(new Error('first stat failure'), { code: 'EIO' });
    const evidenceError = new Error('second evidence failure');
    vi.spyOn(nodeFs, 'stat').mockRejectedValue(statError);
    const originalWrite = nodeFs.writeAtomicSync.bind(nodeFs);
    vi.spyOn(nodeFs, 'writeAtomicSync').mockImplementation((relativePath, content) => {
      if (content.includes('"event":"observation_before_io_failure"')) throw evidenceError;
      return originalWrite(relativePath, content);
    });
    let calls = 0;

    const error = await catchStoreError(withSkillStateLock(nodeFs, async () => { calls += 1; }));

    expect(calls).toBe(0);
    expect(error.cause).toMatchObject({
      operation: 'stat',
      statError,
      error: evidenceError,
      pendingRecord: { event: 'observation_before_io_failure', decision: 'stop' },
    });
  });

  it('rethrows fn errors unchanged and still releases the v2 writer lock', async () => {
    const original = new Error('critical section failure');

    const actual = await withSkillStateLock(nodeFs, async () => { throw original; }).catch(error => error);

    expect(actual).toBe(original);
    expect(fs.existsSync(path.join(tempDir, 'state.lock'))).toBe(false);
    expect(readRecords()).toHaveLength(0);
  });
});
