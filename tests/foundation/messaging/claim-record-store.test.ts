import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as fsAsync from 'node:fs/promises';
import * as path from 'node:path';

const { captureMock, newUuidMock } = vi.hoisted(() => ({
  captureMock: vi.fn(),
  newUuidMock: vi.fn(),
}));

vi.mock('../../../src/foundation/node-utils/index.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/foundation/node-utils/index.js')>(),
  newUuid: newUuidMock,
}));

vi.mock('../../../src/foundation/process-exec/index.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/foundation/process-exec/index.js')>(),
  captureCurrentProcessRef: captureMock,
}));

import {
  ClaimPreparationError,
  prepareClaimRecord,
} from '../../../src/foundation/messaging/claim-record-store.js';
import type { ClaimChannel } from '../../../src/foundation/messaging/claim-record.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import type {
  ProcessEvidence,
  ProcessRef,
  ProcessRefCapture,
} from '../../../src/foundation/process-exec/index.js';
import { cleanupTempDir, createTrackedTempDir } from '../../utils/temp.js';

const NOW = 1_700_000_000_000;
const UUID = '123e4567-e89b-42d3-a456-426614174000';
const UUID_2 = '223e4567-e89b-42d3-a456-426614174000';
const UUID_3 = '323e4567-e89b-42d3-a456-426614174000';
const ORIGINAL_NAME = 'original.md';
const ORIGINAL_BYTES = 'original message bytes\n';
const EVIDENCE: ProcessEvidence = {
  version: 1,
  atMs: NOW - 1,
  facts: [
    { operation: 'capture', outcome: 'fixture', nested: { retained: [true, null, 3] } },
    { id: 0, type: 'Buffer', properties: [], bytesBase64: 'AAE=' },
  ],
};
const CAPTURED: ProcessRefCapture = {
  kind: 'captured',
  value: '{"version":0,"pid":123}' as ProcessRef,
  evidence: EVIDENCE,
};
const GONE: ProcessRefCapture = { kind: 'gone', evidence: EVIDENCE };
const UNKNOWN: ProcessRefCapture = {
  kind: 'unknown',
  reason: 'query_failed',
  evidence: EVIDENCE,
};

let root: string;
let sourceDir: string;
let sourcePath: string;
let fs: NodeFileSystem;

function useClaimIds(...claimIds: string[]): void {
  newUuidMock.mockReset();
  newUuidMock.mockImplementation(randomUUID);
  for (const claimId of claimIds) newUuidMock.mockReturnValueOnce(claimId);
}

beforeEach(async () => {
  root = await createTrackedTempDir('claim-record-store-');
  sourceDir = path.join(root, 'custom/inflight');
  sourcePath = path.join(sourceDir, ORIGINAL_NAME);
  await fsAsync.mkdir(sourceDir, { recursive: true });
  await fsAsync.writeFile(sourcePath, ORIGINAL_BYTES, 'utf8');
  fs = new NodeFileSystem({ baseDir: root });
  useClaimIds(UUID);
  captureMock.mockReset();
  captureMock.mockReturnValue(CAPTURED);
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempDir(root);
});

function paths(claimId = UUID) {
  const claimsDir = `${sourceDir}-claims`;
  return {
    claimsDir,
    claimDirectory: `${claimsDir}/${claimId}`,
    indexPath: `${claimsDir}/${claimId}.json`,
    recordPath: `${claimsDir}/${claimId}/record.json`,
  };
}

function prepare(channel: ClaimChannel = 'inbox', originalName = ORIGINAL_NAME) {
  return prepareClaimRecord(fs, sourceDir, channel, originalName);
}

function expectedDescriptor(capture: ProcessRefCapture, claimId = UUID) {
  return {
    version: 1 as const,
    claimId,
    channel: 'inbox' as const,
    originalName: ORIGINAL_NAME,
    claimName: `mclaim_1_${claimId}.md`,
    createdAtMs: NOW,
    capture,
  };
}

async function catchPreparation(promise: Promise<unknown>): Promise<ClaimPreparationError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ClaimPreparationError);
    return error as ClaimPreparationError;
  }
  throw new Error('expected ClaimPreparationError');
}

describe('prepareClaimRecord', () => {
  it.each([
    ['captured', CAPTURED],
    ['gone', GONE],
    ['unknown', UNKNOWN],
  ] as const)('durably writes index then the complete %s capture', async (_kind, capture) => {
    captureMock.mockReturnValue(capture);
    const write = vi.spyOn(fs, 'writeAtomic');
    const expectedPaths = paths();

    const prepared = await prepare();

    expect(prepared).toEqual({
      claimName: `mclaim_1_${UUID}.md`,
      recordPath: expectedPaths.recordPath,
      descriptor: expectedDescriptor(capture),
    });
    expect(prepared.descriptor.capture).toEqual(capture);
    expect(prepared.descriptor.capture.evidence).toEqual(EVIDENCE);
    expect(write.mock.calls.map(([targetPath]) => targetPath)).toEqual([
      expectedPaths.indexPath,
      expectedPaths.recordPath,
    ]);
    await expect(fsAsync.readFile(expectedPaths.indexPath, 'utf8')).resolves.toBe(JSON.stringify({
      version: 1,
      claimId: UUID,
    }));
    await expect(fsAsync.readFile(expectedPaths.recordPath, 'utf8'))
      .resolves.toBe(JSON.stringify(expectedDescriptor(capture)));
  });

  it.each([
    ['inbox', 'nested/original.md'],
    ['inbox', 'bad\0name.md'],
    ['inbox', 'original.txt'],
    ['outbox', 'archive..md'],
  ] as const)('rejects unsafe %s originalName %j before any preparation', async (
    channel,
    originalName,
  ) => {
    const mkdir = vi.spyOn(fs, 'mkdirExclusiveSync');
    const write = vi.spyOn(fs, 'writeAtomic');

    await expect(prepare(channel, originalName)).rejects.toBeInstanceOf(TypeError);

    expect(newUuidMock).not.toHaveBeenCalled();
    expect(captureMock).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(existsSync(`${sourceDir}-claims`)).toBe(false);
  });

  it('retries real UUID directory collisions without overwriting or moving existing data', async () => {
    useClaimIds(UUID, UUID_2, UUID_3);
    for (const claimId of [UUID, UUID_2]) {
      const old = paths(claimId);
      await fsAsync.mkdir(old.claimDirectory, { recursive: true });
      await fsAsync.writeFile(old.indexPath, `old index ${claimId}`, 'utf8');
      await fsAsync.writeFile(old.recordPath, `old record ${claimId}`, 'utf8');
    }
    const mkdir = vi.spyOn(fs, 'mkdirExclusiveSync');
    const write = vi.spyOn(fs, 'writeAtomic');
    const move = vi.spyOn(fs, 'move');
    const moveSync = vi.spyOn(fs, 'moveSync');
    const moveDir = vi.spyOn(fs, 'moveDir');
    const moveDirSync = vi.spyOn(fs, 'moveDirSync');
    const deleteFile = vi.spyOn(fs, 'delete');
    const removeDir = vi.spyOn(fs, 'removeDir');
    const removeDirSync = vi.spyOn(fs, 'removeDirSync');

    const prepared = await prepare();

    expect(mkdir.mock.calls.map(([targetPath]) => targetPath)).toEqual([
      paths(UUID).claimDirectory,
      paths(UUID_2).claimDirectory,
      paths(UUID_3).claimDirectory,
    ]);
    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(prepared.descriptor).toEqual(expectedDescriptor(CAPTURED, UUID_3));
    expect(prepared.recordPath).toBe(paths(UUID_3).recordPath);
    expect(write).toHaveBeenCalledTimes(2);
    for (const claimId of [UUID, UUID_2]) {
      const old = paths(claimId);
      await expect(fsAsync.readFile(old.indexPath, 'utf8')).resolves.toBe(`old index ${claimId}`);
      await expect(fsAsync.readFile(old.recordPath, 'utf8')).resolves.toBe(`old record ${claimId}`);
    }
    await expect(fsAsync.readFile(sourcePath, 'utf8')).resolves.toBe(ORIGINAL_BYTES);
    for (const mutation of [move, moveSync, moveDir, moveDirSync, deleteFile, removeDir, removeDirSync]) {
      expect(mutation).not.toHaveBeenCalled();
    }
    expect(Object.keys(prepared).sort()).toEqual(['claimName', 'descriptor', 'recordPath']);
  });

  it('fails after three EEXIST claims with the final candidate paths and original cause', async () => {
    useClaimIds(UUID, UUID_2, UUID_3);
    const cause = Object.assign(new Error('claim directory exists'), { code: 'EEXIST' });
    const mkdir = vi.spyOn(fs, 'mkdirExclusiveSync').mockImplementation(() => { throw cause; });
    const write = vi.spyOn(fs, 'writeAtomic');

    const error = await catchPreparation(prepare());

    expect(mkdir).toHaveBeenCalledTimes(3);
    expect(write).not.toHaveBeenCalled();
    expect(captureMock).not.toHaveBeenCalled();
    expect(error.code).toBe('CLAIM_PREPARATION_FAILED');
    expect(error.entry).toBe(ORIGINAL_NAME);
    expect(error.stage).toBe('claim_directory');
    expect(error.targetPath).toBe(paths(UUID_3).claimDirectory);
    expect(error.recordPath).toBe(paths(UUID_3).recordPath);
    expect(error.cause).toBe(cause);
    expect(error.capture).toBeUndefined();
    expect(error.descriptor).toBeUndefined();
    expect(error.writeResult).toBeUndefined();
    expect(error.message).toContain('claim_directory');
    expect(error.message).toContain(error.targetPath);
    expect(error.message).toContain(paths(UUID_3).recordPath);
  });

  it('wraps a non-EEXIST directory permission failure without retrying', async () => {
    const cause = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const mkdir = vi.spyOn(fs, 'mkdirExclusiveSync').mockImplementation(() => { throw cause; });
    const write = vi.spyOn(fs, 'writeAtomic');

    const error = await catchPreparation(prepare());

    expect(mkdir).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
    expect(captureMock).not.toHaveBeenCalled();
    expect(error.stage).toBe('claim_directory');
    expect(error.targetPath).toBe(paths().claimDirectory);
    expect(error.recordPath).toBe(paths().recordPath);
    expect(error.cause).toBe(cause);
    expect(error.capture).toBeUndefined();
    expect(error.descriptor).toBeUndefined();
  });

  it('preserves a capture throw without inventing unknown or writing a descriptor', async () => {
    const cause = new Error('capture exploded');
    captureMock.mockImplementation(() => { throw cause; });
    const write = vi.spyOn(fs, 'writeAtomic');

    const error = await catchPreparation(prepare());

    expect(error.stage).toBe('capture');
    expect(error.targetPath).toBe(paths().recordPath);
    expect(error.recordPath).toBe(paths().recordPath);
    expect(error.cause).toBe(cause);
    expect(error.capture).toBeUndefined();
    expect(error.descriptor).toBeUndefined();
    expect(error.writeResult).toBeUndefined();
    expect(write).not.toHaveBeenCalled();
    await expect(fsAsync.readdir(paths().claimDirectory)).resolves.toEqual([]);
  });

  it.each(['write_index', 'write_record'] as const)(
    'retains complete pending evidence after a %s throw',
    async stage => {
      const cause = Object.assign(new Error(`${stage} failed`), { code: 'EIO' });
      const targetPath = stage === 'write_index' ? paths().indexPath : paths().recordPath;
      const realWrite = fs.writeAtomic.bind(fs);
      const write = vi.spyOn(fs, 'writeAtomic').mockImplementation(async (target, content) => {
        if (target === targetPath) throw cause;
        return realWrite(target, content);
      });

      const error = await catchPreparation(prepare());

      expect(error.entry).toBe(ORIGINAL_NAME);
      expect(error.stage).toBe(stage);
      expect(error.targetPath).toBe(targetPath);
      expect(error.recordPath).toBe(paths().recordPath);
      expect(error.cause).toBe(cause);
      expect(error.capture).toEqual(CAPTURED);
      expect(error.descriptor).toEqual(expectedDescriptor(CAPTURED));
      expect(error.writeResult).toBeUndefined();
      expect(error.message).toContain(stage);
      expect(error.message).toContain(targetPath);
      expect(write).toHaveBeenCalledTimes(stage === 'write_index' ? 1 : 2);
      expect(existsSync(paths().recordPath)).toBe(false);
      if (stage === 'write_record') {
        await expect(fsAsync.readFile(paths().indexPath, 'utf8')).resolves.toBe(JSON.stringify({
          version: 1,
          claimId: UUID,
        }));
      }
    },
  );

  it.each([
    ['write_index', 'committed_platform_limited'],
    ['write_index', 'committed_durability_unknown'],
    ['write_record', 'committed_platform_limited'],
    ['write_record', 'committed_durability_unknown'],
  ] as const)('stops without rewriting after %s returns %s', async (stage, kind) => {
    const durabilityError = Object.assign(new Error(`${stage}: ${kind}`), { code: 'EIO' });
    const writeResult = { kind, error: durabilityError };
    const targetPath = stage === 'write_index' ? paths().indexPath : paths().recordPath;
    const realWrite = fs.writeAtomic.bind(fs);
    const write = vi.spyOn(fs, 'writeAtomic').mockImplementation(async (target, content) => {
      const actual = await realWrite(target, content);
      return target === targetPath ? writeResult : actual;
    });

    const error = await catchPreparation(prepare());

    expect(error.stage).toBe(stage);
    expect(error.targetPath).toBe(targetPath);
    expect(error.recordPath).toBe(paths().recordPath);
    expect(error.cause).toBe(durabilityError);
    expect(error.capture).toEqual(CAPTURED);
    expect(error.descriptor).toEqual(expectedDescriptor(CAPTURED));
    expect(error.writeResult).toBe(writeResult);
    expect(error.message).toContain(kind);
    expect(write).toHaveBeenCalledTimes(stage === 'write_index' ? 1 : 2);
    const expectedBytes = stage === 'write_index'
      ? JSON.stringify({ version: 1, claimId: UUID })
      : JSON.stringify(expectedDescriptor(CAPTURED));
    await expect(fsAsync.readFile(targetPath, 'utf8')).resolves.toBe(expectedBytes);
    if (stage === 'write_index') expect(existsSync(paths().recordPath)).toBe(false);
    expect(write).toHaveBeenCalledTimes(stage === 'write_index' ? 1 : 2);
  });

  it.each(['write_index', 'write_record'] as const)(
    'classifies %s JSON serialization failure with all available fields',
    async stage => {
      if (stage === 'write_index') {
        useClaimIds(1n as unknown as string);
      } else {
        captureMock.mockReturnValue({
          kind: 'unknown',
          reason: 'query_failed',
          evidence: { ...EVIDENCE, facts: [1n] },
        });
      }
      const write = vi.spyOn(fs, 'writeAtomic');
      const expectedPaths = paths(stage === 'write_index' ? '1' : UUID);

      const error = await catchPreparation(prepare());

      expect(error.stage).toBe(stage);
      expect(error.targetPath).toBe(
        stage === 'write_index' ? expectedPaths.indexPath : expectedPaths.recordPath,
      );
      expect(error.recordPath).toBe(expectedPaths.recordPath);
      expect(error.cause).toBeInstanceOf(TypeError);
      expect((error.cause as Error).message).toContain('BigInt');
      expect(error.capture).toBeDefined();
      expect(error.descriptor).toBeDefined();
      expect(error.writeResult).toBeUndefined();
      expect(write).toHaveBeenCalledTimes(stage === 'write_index' ? 0 : 1);
      expect(existsSync(expectedPaths.recordPath)).toBe(false);
      if (stage === 'write_index') {
        expect(error.descriptor?.claimId).toBe(1n);
      } else {
        expect(error.capture).toEqual({
          kind: 'unknown',
          reason: 'query_failed',
          evidence: { ...EVIDENCE, facts: [1n] },
        });
      }
    },
  );
});
