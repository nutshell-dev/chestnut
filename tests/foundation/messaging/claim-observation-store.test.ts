import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import * as fsAsync from 'node:fs/promises';
import * as path from 'node:path';
import {
  ClaimObservationPersistenceError,
  ClaimObservationStore,
} from '../../../src/foundation/messaging/claim-observation-store.js';
import type {
  ClaimLease,
  ClaimRecord,
} from '../../../src/foundation/messaging/claim-observation-store.js';
import type { ClaimProcessFacts } from '../../../src/foundation/messaging/claim-process-observation.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import type { ProcessRef } from '../../../src/foundation/process-exec/index.js';
import { cleanupTempDir, createTrackedTempDir } from '../../utils/temp.js';

const NOW = 1_700_000_000_000;
const RAW_NAME = '42_0_original.md';
const ORIGINAL_NAME = 'original.md';
const PROCESS: ClaimProcessFacts = {
  decoded: { kind: 'decoded', value: 'legacy-reference' as ProcessRef },
  observed: {
    kind: 'unknown',
    reason: 'query_failed',
    evidence: {
      version: 1,
      atMs: NOW - 2,
      facts: [
        { operation: 'signal0', outcome: 'error', error: { code: 'EIO' } },
        { id: 0, type: 'Buffer', properties: [], bytesBase64: 'AAE=' },
      ],
    },
  },
};
const LEASE: ClaimLease = {
  thresholdMs: 300_000,
  observedAtMs: NOW - 1,
  valueMs: NOW - 300_001,
};

let root: string;
let sourceDir: string;
let fs: NodeFileSystem;

beforeEach(async () => {
  root = await createTrackedTempDir('claim-observation-store-');
  sourceDir = path.join(root, 'inbox/inflight');
  await fsAsync.mkdir(sourceDir, { recursive: true });
  fs = new NodeFileSystem({ baseDir: root });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempDir(root);
});

function observationInput() {
  return { rawName: RAW_NAME, originalName: ORIGINAL_NAME, process: PROCESS };
}

function decisionInput() {
  return {
    ...observationInput(),
    lease: LEASE,
    decision: { kind: 'reclaim', reason: 'lease_elapsed' } as const,
  };
}

async function catchPersistenceError(promise: Promise<unknown>): Promise<ClaimObservationPersistenceError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ClaimObservationPersistenceError);
    return error as ClaimObservationPersistenceError;
  }
  throw new Error('expected ClaimObservationPersistenceError');
}

async function readPersisted(): Promise<{
  attemptId: string;
  index: unknown;
  indexPath: string;
  records: ClaimRecord[];
  recordPaths: string[];
}> {
  const observationDir = `${sourceDir}-observations`;
  const entries = await fsAsync.readdir(observationDir, { withFileTypes: true });
  const indexEntry = entries.find(entry => entry.isFile() && entry.name.endsWith('.json'));
  expect(indexEntry).toBeDefined();
  const attemptId = indexEntry!.name.slice(0, -'.json'.length);
  const indexPath = path.join(observationDir, indexEntry!.name);
  const attemptDir = path.join(observationDir, attemptId);
  const recordNames = (await fsAsync.readdir(attemptDir))
    .filter(name => name.endsWith('.json'))
    .sort();
  const recordPaths = recordNames.map(name => path.join(attemptDir, name));
  const records = await Promise.all(recordPaths.map(async recordPath =>
    JSON.parse(await fsAsync.readFile(recordPath, 'utf8')) as ClaimRecord));
  return {
    attemptId,
    index: JSON.parse(await fsAsync.readFile(indexPath, 'utf8')) as unknown,
    indexPath,
    records,
    recordPaths,
  };
}

describe('ClaimObservationStore', () => {
  it('lazily creates no observation resources before the first record', () => {
    new ClaimObservationStore(fs, sourceDir);

    expect(existsSync(`${sourceDir}-observations`)).toBe(false);
  });

  it('durably persists complete JSON records, index first, with advancing sequences', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const write = vi.spyOn(fs, 'writeAtomic');
    const store = new ClaimObservationStore(fs, sourceDir);

    await store.recordObservation(observationInput());
    await store.recordDecision(decisionInput());

    const persisted = await readPersisted();
    expect(write.mock.calls.map(([targetPath]) => targetPath)).toEqual([
      persisted.indexPath,
      persisted.recordPaths[0],
      persisted.recordPaths[1],
    ]);
    expect(persisted.index).toEqual({
      version: 1,
      attemptId: persisted.attemptId,
      sourceDir,
    });
    expect(persisted.records).toEqual([
      {
        version: 1,
        attemptId: persisted.attemptId,
        sequence: 1,
        atMs: NOW,
        sourceDir,
        rawName: RAW_NAME,
        originalName: ORIGINAL_NAME,
        event: 'process_observed',
        process: PROCESS,
      },
      {
        version: 1,
        attemptId: persisted.attemptId,
        sequence: 2,
        atMs: NOW,
        sourceDir,
        rawName: RAW_NAME,
        originalName: ORIGINAL_NAME,
        event: 'decision',
        process: PROCESS,
        lease: LEASE,
        decision: { kind: 'reclaim', reason: 'lease_elapsed' },
      },
    ]);
    expect(persisted.records[0].process).toEqual(PROCESS);
  });

  it('preserves the pending decision, both errors, and poisons the store after a record throw', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const originalStatError = Object.assign(new Error('stat EIO'), { code: 'EIO', detail: 'original' });
    const writeError = new Error('record write failed');
    const realWrite = fs.writeAtomic.bind(fs);
    const write = vi.spyOn(fs, 'writeAtomic')
      .mockImplementationOnce(async (targetPath, content) => realWrite(targetPath, content))
      .mockRejectedValueOnce(writeError);
    const store = new ClaimObservationStore(fs, sourceDir);

    const error = await catchPersistenceError(store.recordDecision({
      rawName: RAW_NAME,
      originalName: ORIGINAL_NAME,
      process: PROCESS,
      decision: { kind: 'skip', reason: 'stat_failed' },
    }, { originalStatError }));

    expect(error.code).toBe('CLAIM_OBSERVATION_PERSISTENCE_FAILED');
    expect(error.entry).toBe(RAW_NAME);
    expect(error.rawName).toBe(RAW_NAME);
    expect(error.cause).toBe(writeError);
    expect(error.originalStatError).toBe(originalStatError);
    expect(error.writeResult).toBeUndefined();
    expect(error.stage).toBe('write_record');
    expect(error.targetPath).toBe(error.recordPath);
    expect(error.recordPath).toMatch(/000001\.json$/);
    expect(error.pendingRecord).toEqual({
      version: 1,
      attemptId: error.pendingRecord.attemptId,
      sequence: 1,
      atMs: NOW,
      sourceDir,
      rawName: RAW_NAME,
      originalName: ORIGINAL_NAME,
      event: 'decision',
      process: PROCESS,
      decision: { kind: 'skip', reason: 'stat_failed' },
    });
    expect(error.message).toContain('write_record');
    expect(error.message).toContain(error.recordPath);
    await expect(store.recordObservation(observationInput())).rejects.toBe(error);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it.each([
    'committed_platform_limited',
    'committed_durability_unknown',
  ] as const)('stops after a %s record without rewriting committed bytes', async kind => {
    const durabilityError = Object.assign(new Error(`directory fsync: ${kind}`), { code: 'EIO' });
    const writeResult = { kind, error: durabilityError };
    const realWrite = fs.writeAtomic.bind(fs);
    const write = vi.spyOn(fs, 'writeAtomic').mockImplementation(async (targetPath, content) => {
      const actual = await realWrite(targetPath, content);
      return content.includes('"event":"process_observed"') ? writeResult : actual;
    });
    const store = new ClaimObservationStore(fs, sourceDir);

    const error = await catchPersistenceError(store.recordObservation(observationInput()));

    expect(error.cause).toBe(durabilityError);
    expect(error.writeResult).toBe(writeResult);
    expect(error.pendingRecord.sequence).toBe(1);
    expect(error.stage).toBe('write_record');
    expect(error.targetPath).toBe(error.recordPath);
    expect(error.message).toContain(kind);
    expect(write).toHaveBeenCalledTimes(2);
    await expect(fsAsync.readFile(error.recordPath, 'utf8'))
      .resolves.toBe(JSON.stringify(error.pendingRecord));
    await expect(store.recordDecision(decisionInput())).rejects.toBe(error);
    expect(write).toHaveBeenCalledTimes(2);
    await expect(fsAsync.readFile(error.recordPath, 'utf8'))
      .resolves.toBe(JSON.stringify(error.pendingRecord));
  });

  it('distinguishes index and pending-record paths when index durability is not accepted', async () => {
    const durabilityError = Object.assign(new Error('index directory fsync failed'), { code: 'EINVAL' });
    const writeResult = { kind: 'committed_platform_limited' as const, error: durabilityError };
    const realWrite = fs.writeAtomic.bind(fs);
    const write = vi.spyOn(fs, 'writeAtomic')
      .mockImplementationOnce(async (targetPath, content) => {
        await realWrite(targetPath, content);
        return writeResult;
      });
    const store = new ClaimObservationStore(fs, sourceDir);

    const error = await catchPersistenceError(store.recordObservation(observationInput()));

    expect(error.cause).toBe(durabilityError);
    expect(error.writeResult).toBe(writeResult);
    expect(error.stage).toBe('write_index');
    expect(error.targetPath).toMatch(/\/[^/]+\.json$/);
    expect(error.targetPath).not.toBe(error.recordPath);
    expect(error.recordPath).toMatch(/000001\.json$/);
    expect(error.pendingRecord).toMatchObject({
      attemptId: path.basename(error.targetPath, '.json'),
      sequence: 1,
      event: 'process_observed',
      process: PROCESS,
    });
    expect(error.message).toContain('write_index');
    expect(error.message).toContain(error.targetPath);
    expect(error.message).toContain(error.recordPath);
    await expect(fsAsync.readFile(error.targetPath, 'utf8')).resolves.toBe(JSON.stringify({
      version: 1,
      attemptId: error.pendingRecord.attemptId,
      sourceDir,
    }));
    expect(existsSync(error.recordPath)).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('retries an EEXIST directory claim with fresh UUIDs and then initializes once', async () => {
    const realMkdir = fs.mkdirExclusiveSync.bind(fs);
    const collision = () => Object.assign(new Error('attempt already exists'), { code: 'EEXIST' });
    const mkdir = vi.spyOn(fs, 'mkdirExclusiveSync')
      .mockImplementationOnce(() => { throw collision(); })
      .mockImplementationOnce(() => { throw collision(); })
      .mockImplementation(realMkdir);
    const store = new ClaimObservationStore(fs, sourceDir);

    await store.recordObservation(observationInput());
    await store.recordDecision(decisionInput());

    const persisted = await readPersisted();
    const claimedPaths = mkdir.mock.calls.map(([targetPath]) => targetPath);
    expect(claimedPaths).toHaveLength(3);
    expect(new Set(claimedPaths).size).toBe(3);
    expect(claimedPaths[2]).toBe(path.join(`${sourceDir}-observations`, persisted.attemptId));
    expect(persisted.records.map(record => record.sequence)).toEqual([1, 2]);
    expect(persisted.records.every(record => record.attemptId === persisted.attemptId)).toBe(true);
  });

  it('fails with the complete pending record after three EEXIST claims and stays poisoned', async () => {
    const collision = Object.assign(new Error('attempt already exists'), { code: 'EEXIST' });
    const mkdir = vi.spyOn(fs, 'mkdirExclusiveSync').mockImplementation(() => { throw collision; });
    const write = vi.spyOn(fs, 'writeAtomic');
    const store = new ClaimObservationStore(fs, sourceDir);

    const error = await catchPersistenceError(store.recordObservation(observationInput()));

    expect(mkdir).toHaveBeenCalledTimes(3);
    expect(write).not.toHaveBeenCalled();
    expect(error.cause).toBe(collision);
    expect(error.stage).toBe('claim_directory');
    expect(error.targetPath).toBe(mkdir.mock.calls[2][0]);
    expect(error.recordPath).toBe(path.join(error.targetPath, '000001.json'));
    expect(error.pendingRecord).toEqual({
      version: 1,
      attemptId: path.basename(error.targetPath),
      sequence: 1,
      atMs: error.pendingRecord.atMs,
      sourceDir,
      rawName: RAW_NAME,
      originalName: ORIGINAL_NAME,
      event: 'process_observed',
      process: PROCESS,
    });
    expect(error.message).toContain('claim_directory');
    expect(error.message).toContain(error.targetPath);
    expect(error.message).toContain(error.recordPath);
    await expect(store.recordDecision(decisionInput())).rejects.toBe(error);
    expect(mkdir).toHaveBeenCalledTimes(3);
    expect(write).not.toHaveBeenCalled();
  });
});
