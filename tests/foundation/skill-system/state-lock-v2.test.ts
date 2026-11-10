import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import * as processExec from '../../../src/foundation/process-exec/index.js';
import {
  decodeProcessRef,
  type ProcessEvidence,
  type ProcessRef,
  type ProcessRefCapture,
} from '../../../src/foundation/process-exec/index.js';
import { withSkillStateLock } from '../../../src/foundation/skill-system/state-lock.js';
import { SkillVersionError } from '../../../src/foundation/skill-system/version-types.js';
import { cleanupTempDir, createTrackedTempDir } from '../../utils/temp.js';

const EVIDENCE: ProcessEvidence = { version: 1, atMs: 0, facts: [] };
const SELF_REF = JSON.stringify({ version: 0, pid: 1234 }) as ProcessRef;
const CAPTURED: ProcessRefCapture = { kind: 'captured', value: SELF_REF, evidence: EVIDENCE };

type EvidenceRecord = {
  version: number;
  event: string;
  attemptId: string;
  sequence: number;
  atMs: number;
  capture?: ProcessRefCapture;
  lockRaw?: string;
  decision?: { kind: string; reason: string } | 'stop';
};

let tempDir: string;
let nodeFs: NodeFileSystem;

beforeEach(async () => {
  tempDir = await createTrackedTempDir('skill-state-lock-v2-');
  nodeFs = new NodeFileSystem({ baseDir: tempDir });
  vi.spyOn(processExec, 'captureCurrentProcessRef').mockReturnValue(CAPTURED);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempDir(tempDir);
});

function readEvidence(): EvidenceRecord[] {
  const root = path.join(tempDir, 'state-lock-observations');
  if (!fs.existsSync(root)) return [];
  return new NodeFileSystem({ baseDir: tempDir })
    .listSync('state-lock-observations', { recursive: true })
    .filter(entry => entry.isFile && /^\d{6}\.json$/.test(entry.name))
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(entry => {
      const record = JSON.parse(nodeFs.readSync(entry.path)) as EvidenceRecord;
      expect(JSON.parse(JSON.stringify(record))).toEqual(record);
      return record;
    });
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

function lockPath(): string {
  return path.join(tempDir, 'state.lock');
}

describe('SkillSystem v2 state lock writer', () => {
  it('persists capture before a decodable v2 reference and retains evidence after release', async () => {
    let calls = 0;
    let raw = '';

    await withSkillStateLock(nodeFs, async () => {
      calls += 1;
      raw = nodeFs.readSync('state.lock');
      const payload = JSON.parse(raw) as {
        lock_version: number;
        observationAttemptId: string;
        holder: { kind: string; ref?: string };
      };
      expect(Object.keys(payload).sort()).toEqual([
        'at', 'holder', 'lock_version', 'observationAttemptId',
      ]);
      expect(payload.lock_version).toBe(2);
      expect(payload.holder).toEqual({ kind: 'reference', ref: SELF_REF });
      expect(payload).not.toHaveProperty('pid');
      expect(decodeProcessRef(payload.holder.ref)).toEqual({ kind: 'decoded', value: SELF_REF });
      const capture = readEvidence().find(record => record.event === 'self_capture');
      expect(capture).toMatchObject({
        version: 1,
        sequence: 1,
        attemptId: payload.observationAttemptId,
        capture: CAPTURED,
      });
    });

    expect(calls).toBe(1);
    expect(fs.existsSync(lockPath())).toBe(false);
    expect(readEvidence()).toHaveLength(1);
    expect(readEvidence()[0].capture).toEqual(CAPTURED);
    expect(raw).not.toContain('"pid":1234');
  });

  it.each([
    [{ kind: 'unknown', reason: 'permission_denied', evidence: EVIDENCE } as const],
    [{ kind: 'gone', evidence: EVIDENCE } as const],
  ])('writes an unknown holder without discarding the complete $kind capture', async capture => {
    vi.mocked(processExec.captureCurrentProcessRef).mockReturnValue(capture);
    let calls = 0;

    await withSkillStateLock(nodeFs, async () => {
      calls += 1;
      expect(JSON.parse(nodeFs.readSync('state.lock'))).toMatchObject({
        lock_version: 2,
        holder: { kind: 'unknown' },
      });
    });

    expect(calls).toBe(1);
    expect(readEvidence()).toHaveLength(1);
    expect(readEvidence()[0]).toMatchObject({ event: 'self_capture', capture });
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it('fails before creating a lock when capture throws and retains the original object', async () => {
    const original = new Error('capture exploded');
    vi.mocked(processExec.captureCurrentProcessRef).mockImplementation(() => { throw original; });
    let calls = 0;

    const error = await catchStoreError(withSkillStateLock(nodeFs, async () => { calls += 1; }));

    expect(calls).toBe(0);
    expect(fs.existsSync(lockPath())).toBe(false);
    expect(readEvidence()).toEqual([]);
    expect(error.cause).toMatchObject({ operation: 'capture', error: original });
    expect(error.evidence[0]).toContain('state-lock-observations/');
  });

  it.each(['index', 'record'] as const)('does not publish a lock when the %s write fails', async target => {
    const originalWrite = nodeFs.writeAtomicSync.bind(nodeFs);
    const original = new Error(`${target} write failed`);
    vi.spyOn(nodeFs, 'writeAtomicSync').mockImplementation((relativePath, content) => {
      if (target === 'record' && content.includes('"event":"self_capture"')) throw original;
      if (target === 'index' && /state-lock-observations\/[^/]+\.json$/.test(relativePath)) {
        throw original;
      }
      return originalWrite(relativePath, content);
    });
    let calls = 0;

    const error = await catchStoreError(withSkillStateLock(nodeFs, async () => { calls += 1; }));

    expect(calls).toBe(0);
    expect(fs.existsSync(lockPath())).toBe(false);
    expect(error.cause).toMatchObject({
      kind: 'state_lock_observation_persistence_failed',
      pendingRecord: { event: 'self_capture', capture: CAPTURED },
      error: original,
    });
  });

  it.each([
    ['committed_platform_limited'],
    ['committed_durability_unknown'],
  ] as const)('stops on %s capture evidence without retrying or publishing', async kind => {
    const originalWrite = nodeFs.writeAtomicSync.bind(nodeFs);
    const original = Object.assign(new Error(`durability ${kind}`), { code: 'EIO' });
    const writeResult = { kind, error: original };
    const write = vi.spyOn(nodeFs, 'writeAtomicSync').mockImplementation((relativePath, content) => {
      const actual = originalWrite(relativePath, content);
      if (content.includes('"event":"self_capture"')) {
        expect(actual.kind).toBe('durable');
        return writeResult;
      }
      return actual;
    });
    let calls = 0;

    const error = await catchStoreError(withSkillStateLock(nodeFs, async () => { calls += 1; }));

    expect(calls).toBe(0);
    expect(fs.existsSync(lockPath())).toBe(false);
    expect(write).toHaveBeenCalledTimes(2); // index + committed capture; no blind retry
    expect(error.cause).toMatchObject({
      pendingRecord: { event: 'self_capture' },
      writeResult,
      error: original,
    });
    expect(readEvidence()).toHaveLength(1);
  });

  it('can retry normally after a transient capture-evidence failure', async () => {
    const originalWrite = nodeFs.writeAtomicSync.bind(nodeFs);
    const original = new Error('transient capture evidence failure');
    let armed = true;
    vi.spyOn(nodeFs, 'writeAtomicSync').mockImplementation((relativePath, content) => {
      if (armed && content.includes('"event":"self_capture"')) {
        armed = false;
        throw original;
      }
      return originalWrite(relativePath, content);
    });
    let calls = 0;

    const error = await catchStoreError(withSkillStateLock(nodeFs, async () => { calls += 1; }));
    expect(error.cause).toMatchObject({ error: original });
    expect(fs.existsSync(lockPath())).toBe(false);

    await withSkillStateLock(nodeFs, async () => { calls += 1; });
    expect(calls).toBe(1);
    expect(fs.existsSync(lockPath())).toBe(false);
    expect(readEvidence()).toHaveLength(1);
  });
});
