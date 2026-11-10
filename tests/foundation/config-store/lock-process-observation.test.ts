import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ConfigStoreError,
  isConfigStoreError,
  withYamlConfigLock,
  withYamlConfigLockAsync,
} from '../../../src/foundation/config-store/index.js';
import type { ConfigStoreErrorCode } from '../../../src/foundation/config-store/errors.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import * as processExec from '../../../src/foundation/process-exec/index.js';
import type {
  ProcessEvidence,
  ProcessRef,
  ProcessRefDecode,
  ProcessRefObservation,
} from '../../../src/foundation/process-exec/index.js';
import { cleanupTempDir, createTrackedTempDir } from '../../utils/temp.js';

const OLD = new Date(Date.now() - 120_000).toISOString();
const FAST = { acquireTimeoutMs: 80, staleMs: 0, pollMs: 5 } as const;
const EVIDENCE: ProcessEvidence = { version: 1, atMs: 0, facts: [] };

let tempDir: string;
let configPath: string;
let nodeFs: NodeFileSystem;
const deps = { fsFactory: () => nodeFs };

beforeEach(async () => {
  tempDir = await createTrackedTempDir('config-lock-observation-');
  configPath = path.join(tempDir, 'config.yaml');
  nodeFs = new NodeFileSystem({ baseDir: tempDir });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempDir(tempDir);
});

async function catchStoreError(
  promise: Promise<unknown>,
  code: ConfigStoreErrorCode,
): Promise<ConfigStoreError> {
  try {
    await promise;
  } catch (error) {
    expect(isConfigStoreError(error)).toBe(true);
    expect(error).toBeInstanceOf(ConfigStoreError);
    expect((error as ConfigStoreError).code).toBe(code);
    return error as ConfigStoreError;
  }
  throw new Error(`expected ConfigStoreError with code "${code}"`);
}

function writeLock(raw: string): void {
  fs.writeFileSync(`${configPath}.lock`, raw);
}

function legacyRaw(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    token: 'old-holder',
    pid: 1234,
    process_start_time: 'Sat Jan  1 00:00:00 2000',
    createdAt: OLD,
    ...extra,
  });
}

function v2Raw(holder: unknown = { kind: 'reference', ref: 'opaque-ref' }): string {
  return JSON.stringify({
    lock_version: 2,
    token: 'v2-holder',
    createdAt: OLD,
    observationAttemptId: 'writer-attempt',
    holder,
    // Legacy fields must never be used as a v2 fallback.
    pid: 1234,
    process_start_time: 'Sat Jan  1 00:00:00 2000',
  });
}

function mockOutcome(outcome: ProcessRefObservation) {
  const decode = vi.spyOn(processExec, 'decodeProcessRef').mockReturnValue({
    kind: 'decoded',
    value: 'decoded-opaque-ref' as ProcessRef,
  });
  const inspect = vi.spyOn(processExec, 'inspectProcessRef').mockReturnValue(outcome);
  return { decode, inspect };
}

function runLock(fn: () => void, asyncEntry = false): Promise<unknown> {
  return asyncEntry
    ? withYamlConfigLockAsync(deps, configPath, async () => { fn(); }, FAST)
    : withYamlConfigLock(deps, configPath, fn, FAST);
}

type StoredRecord = {
  version: number;
  attemptId: string;
  sequence: number;
  atMs: number;
  event: string;
  lockRaw: string;
  decoded?: ProcessRefDecode;
  outcome: { kind: string; reason?: string };
  decision: string;
};

function observationEntries(): Array<{ path: string; name: string; isFile: boolean }> {
  const dirName = 'config.yaml.lock-observations';
  if (!fs.existsSync(path.join(tempDir, dirName))) return [];
  return new NodeFileSystem({ baseDir: tempDir })
    .listSync(dirName, { recursive: true })
    .map(entry => ({ path: entry.path, name: entry.name, isFile: entry.isFile }));
}

function readRecords(): StoredRecord[] {
  return observationEntries()
    .filter(entry => entry.isFile && /^\d{6}\.json$/.test(entry.name))
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(entry => JSON.parse(nodeFs.readSync(entry.path)) as StoredRecord);
}

describe('ConfigStore persisted holder observations', () => {
  it('reclaims a v2 holder only after persisting decoded and complete gone evidence', async () => {
    const raw = v2Raw();
    writeLock(raw);
    mockOutcome({ kind: 'gone', reason: 'absent', evidence: EVIDENCE });
    let calls = 0;

    await runLock(() => { calls += 1; }, true);

    expect(calls).toBe(1);
    expect(fs.existsSync(`${configPath}.lock`)).toBe(false);
    const records = readRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      version: 1,
      sequence: 1,
      event: 'holder_observation',
      lockRaw: raw,
      decoded: { kind: 'decoded', value: 'decoded-opaque-ref' },
      outcome: { kind: 'gone', reason: 'absent', evidence: EVIDENCE },
      decision: 'consider_reclaim',
    });
    expect(JSON.parse(JSON.stringify(records[0]))).toEqual(records[0]);
    const index = observationEntries().find(entry =>
      entry.isFile && entry.name === `${records[0].attemptId}.json`);
    expect(index).toBeDefined();
    expect(JSON.parse(nodeFs.readSync(index!.path))).toEqual({
      version: 1,
      attemptId: records[0].attemptId,
      configFileName: 'config.yaml',
    });
  });

  it.each([
    ['alive', { kind: 'alive', evidence: EVIDENCE } as const, false],
    ['unknown', {
      kind: 'unknown', reason: 'identity_unverifiable', evidence: EVIDENCE,
    } as const, true],
  ])('does not reclaim an %s observation and preserves the original lock', async (
    _label,
    outcome,
    asyncEntry,
  ) => {
    const raw = v2Raw();
    writeLock(raw);
    mockOutcome(outcome);
    let calls = 0;

    const error = await catchStoreError(runLock(() => { calls += 1; }, asyncEntry), 'lock_timeout');

    expect(calls).toBe(0);
    expect(fs.readFileSync(`${configPath}.lock`, 'utf8')).toBe(raw);
    expect(error.message).toContain('config.yaml.lock-observations/');
    const records = readRecords();
    expect(records.length).toBeGreaterThan(0);
    expect(records[0].outcome).toEqual(outcome);
    expect(records[0].decision).toBe('wait');
    expect(records.map(record => record.sequence)).toEqual(
      records.map((_, index) => index + 1),
    );
  });

  it('adapts legacy PID-only records through the L1 v0 decoder without interpreting time', async () => {
    const raw = JSON.stringify({ pid: 4321, createdAt: OLD });
    writeLock(raw);
    const { decode } = mockOutcome({
      kind: 'unknown', reason: 'identity_unverifiable', evidence: EVIDENCE,
    });

    await catchStoreError(runLock(() => {}), 'lock_timeout');

    expect(decode).toHaveBeenCalledWith({ version: 0, pid: 4321, startTime: undefined });
    expect(readRecords()[0].lockRaw).toBe(raw);
  });

  it.each([
    ['invalid', {
      kind: 'invalid', reason: 'malformed_json', evidence: EVIDENCE,
    } as const],
    ['unsupported', { kind: 'unsupported_version', evidence: EVIDENCE } as const],
  ])('persists decode %s as wait without calling inspect', async (_label, decoded) => {
    const raw = v2Raw();
    writeLock(raw);
    vi.spyOn(processExec, 'decodeProcessRef').mockReturnValue(decoded);
    const inspect = vi.spyOn(processExec, 'inspectProcessRef');
    let calls = 0;

    await catchStoreError(runLock(() => { calls += 1; }), 'lock_timeout');

    expect(calls).toBe(0);
    expect(inspect).not.toHaveBeenCalled();
    expect(fs.readFileSync(`${configPath}.lock`, 'utf8')).toBe(raw);
    // Decode failures do not query the OS, so identical raw facts are deduplicated.
    expect(readRecords()).toHaveLength(1);
    expect(readRecords()[0]).toMatchObject({ decoded, outcome: decoded, decision: 'wait' });
  });

  it.each([
    ['empty', ''],
    ['partial', '{"token":'],
    ['null', 'null'],
    ['array', '[]'],
  ])('records a changed %s shell once and never queries the OS', async (_label, raw) => {
    writeLock(raw);
    const decode = vi.spyOn(processExec, 'decodeProcessRef');
    const inspect = vi.spyOn(processExec, 'inspectProcessRef');
    let calls = 0;

    await catchStoreError(runLock(() => { calls += 1; }), 'lock_timeout');

    expect(calls).toBe(0);
    expect(decode).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    expect(fs.readFileSync(`${configPath}.lock`, 'utf8')).toBe(raw);
    expect(readRecords()).toHaveLength(1);
    expect(readRecords()[0]).toMatchObject({
      lockRaw: raw,
      outcome: { kind: 'unverifiable', reason: 'malformed_lock' },
      decision: 'wait',
    });
  });

  it.each([
    ['future version', 'unsupported_lock_version'],
    ['unknown holder', 'holder_unverifiable'],
    ['missing token', 'invalid_lock_token'],
    ['missing attempt id', 'invalid_observation_attempt_id'],
  ])('keeps an unverifiable v2/future envelope conservative: %s', async (
    _label,
    expectedReason,
  ) => {
    let payload: Record<string, unknown>;
    if (_label === 'future version') {
      payload = JSON.parse(v2Raw()) as Record<string, unknown>;
      payload.lock_version = 3;
    } else {
      payload = JSON.parse(v2Raw({ kind: 'unknown' })) as Record<string, unknown>;
      if (_label === 'missing token') delete payload.token;
      if (_label === 'missing attempt id') delete payload.observationAttemptId;
    }
    const raw = JSON.stringify(payload);
    writeLock(raw);
    const decode = vi.spyOn(processExec, 'decodeProcessRef');
    const inspect = vi.spyOn(processExec, 'inspectProcessRef');

    await catchStoreError(runLock(() => {}), 'lock_timeout');

    expect(decode).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    expect(fs.readFileSync(`${configPath}.lock`, 'utf8')).toBe(raw);
    expect(readRecords()).toHaveLength(1);
    expect(readRecords()[0].outcome).toEqual({
      kind: 'unverifiable', reason: expectedReason,
    });
  });

  it('treats observationAttemptId only as correlation, never as a read path', async () => {
    const payload = JSON.parse(v2Raw({ kind: 'unknown' })) as Record<string, unknown>;
    payload.observationAttemptId = '../../outside';
    const raw = JSON.stringify(payload);
    writeLock(raw);

    await catchStoreError(runLock(() => {}), 'lock_timeout');

    expect(readRecords()).toHaveLength(1);
    expect(fs.existsSync(path.join(tempDir, 'outside'))).toBe(false);
    expect(fs.readFileSync(`${configPath}.lock`, 'utf8')).toBe(raw);
  });

  it.each(['decode', 'inspect'] as const)('wraps an unexpected L1 %s throw without reclaiming', async stage => {
    const raw = legacyRaw();
    writeLock(raw);
    const original = new Error(`unexpected ${stage}`);
    vi.spyOn(processExec, 'decodeProcessRef').mockReturnValue({
      kind: 'decoded', value: 'decoded-opaque-ref' as ProcessRef,
    });
    if (stage === 'decode') {
      vi.spyOn(processExec, 'decodeProcessRef').mockImplementation(() => { throw original; });
    } else {
      vi.spyOn(processExec, 'inspectProcessRef').mockImplementation(() => { throw original; });
    }
    let calls = 0;

    const error = await catchStoreError(runLock(() => { calls += 1; }), 'lock_indeterminate');

    expect(calls).toBe(0);
    expect(fs.readFileSync(`${configPath}.lock`, 'utf8')).toBe(raw);
    expect(readRecords()).toHaveLength(0);
    expect(error.cause).toMatchObject({
      kind: 'process_observation_failed',
      lockName: 'config.yaml.lock',
      lockRaw: raw,
      error: original,
    });
  });

  it('fails closed when the attempt directory cannot be claimed and retains the full pending record', async () => {
    const raw = legacyRaw();
    writeLock(raw);
    mockOutcome({ kind: 'gone', reason: 'absent', evidence: EVIDENCE });
    const original = new Error('mkdir denied');
    vi.spyOn(nodeFs, 'mkdirExclusiveSync').mockImplementation(() => { throw original; });
    let calls = 0;

    const error = await catchStoreError(runLock(() => { calls += 1; }), 'lock_indeterminate');

    expect(calls).toBe(0);
    expect(fs.readFileSync(`${configPath}.lock`, 'utf8')).toBe(raw);
    expect(error.cause).toMatchObject({
      kind: 'lock_observation_persistence_failed',
      error: original,
      targetPath: expect.stringContaining('config.yaml.lock-observations/'),
      record: {
        event: 'holder_observation',
        lockRaw: raw,
        outcome: { kind: 'gone', reason: 'absent' },
        decision: 'consider_reclaim',
      },
    });
  });

  it('retains the pending record, target path and original error when record writing throws', async () => {
    const raw = legacyRaw();
    writeLock(raw);
    mockOutcome({ kind: 'gone', reason: 'absent', evidence: EVIDENCE });
    const originalWrite = nodeFs.writeAtomicSync.bind(nodeFs);
    const original = new Error('record write failed');
    vi.spyOn(nodeFs, 'writeAtomicSync').mockImplementation((relativePath, content) => {
      if (relativePath.endsWith('000001.json')) throw original;
      return originalWrite(relativePath, content);
    });
    let calls = 0;

    const error = await catchStoreError(runLock(() => { calls += 1; }), 'lock_indeterminate');

    expect(calls).toBe(0);
    expect(fs.readFileSync(`${configPath}.lock`, 'utf8')).toBe(raw);
    expect(error.cause).toMatchObject({
      kind: 'lock_observation_persistence_failed',
      error: original,
      targetPath: expect.stringMatching(/000001\.json$/),
      recordPath: expect.stringMatching(/000001\.json$/),
      record: { lockRaw: raw, decision: 'consider_reclaim' },
    });
  });

  it.each([
    ['committed_platform_limited'],
    ['committed_durability_unknown'],
  ] as const)('stops after %s and preserves the committed result without retrying', async kind => {
    const raw = legacyRaw();
    writeLock(raw);
    mockOutcome({ kind: 'gone', reason: 'absent', evidence: EVIDENCE });
    const originalWrite = nodeFs.writeAtomicSync.bind(nodeFs);
    const original = Object.assign(new Error(`durability: ${kind}`), { code: 'EIO' });
    const writeResult = { kind, error: original };
    const write = vi.spyOn(nodeFs, 'writeAtomicSync').mockImplementation((relativePath, content) => {
      const actual = originalWrite(relativePath, content);
      if (relativePath.endsWith('000001.json')) {
        expect(actual.kind).toBe('durable');
        return writeResult;
      }
      return actual;
    });
    let calls = 0;

    const error = await catchStoreError(runLock(() => { calls += 1; }), 'lock_indeterminate');

    expect(calls).toBe(0);
    expect(write).toHaveBeenCalledTimes(2); // index + one committed record; no overwrite retry
    expect(fs.readFileSync(`${configPath}.lock`, 'utf8')).toBe(raw);
    expect(error.cause).toMatchObject({
      kind: 'lock_observation_persistence_failed',
      error: original,
      writeResult,
      record: { lockRaw: raw, decision: 'consider_reclaim' },
    });
    // The committed bytes remain readable even though their durability is not accepted.
    expect(readRecords()).toHaveLength(1);
  });

  it('persists a late gone observation but does not reclaim after the original deadline', async () => {
    const raw = legacyRaw();
    writeLock(raw);
    const initialNow = Date.now();
    let now = initialNow;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.spyOn(processExec, 'decodeProcessRef').mockReturnValue({
      kind: 'decoded', value: 'decoded-opaque-ref' as ProcessRef,
    });
    vi.spyOn(processExec, 'inspectProcessRef').mockImplementation(() => {
      now += 100;
      return { kind: 'gone', reason: 'absent', evidence: EVIDENCE };
    });
    let calls = 0;

    const error = await catchStoreError(withYamlConfigLock(deps, configPath, () => {
      calls += 1;
    }, { acquireTimeoutMs: 50, staleMs: 0, pollMs: 5 }), 'lock_timeout');

    expect(calls).toBe(0);
    expect(fs.readFileSync(`${configPath}.lock`, 'utf8')).toBe(raw);
    expect(error.message).toContain('config.yaml.lock-observations/');
    expect(readRecords()).toHaveLength(1);
    expect(readRecords()[0]).toMatchObject({
      outcome: { kind: 'gone', reason: 'absent' },
      decision: 'consider_reclaim',
    });
  });

  it('rechecks identity after observation and restores a replacement token instead of deleting it', async () => {
    const raw = legacyRaw();
    writeLock(raw);
    const replacement = JSON.stringify({
      token: 'new-holder',
      pid: 7777,
      createdAt: new Date().toISOString(),
    });
    vi.spyOn(processExec, 'decodeProcessRef').mockReturnValue({
      kind: 'decoded', value: 'decoded-opaque-ref' as ProcessRef,
    });
    vi.spyOn(processExec, 'inspectProcessRef')
      .mockImplementationOnce(() => {
        fs.writeFileSync(`${configPath}.lock`, replacement);
        return { kind: 'gone', reason: 'absent', evidence: EVIDENCE };
      })
      .mockReturnValue({
        kind: 'unknown', reason: 'identity_unverifiable', evidence: EVIDENCE,
      });
    let calls = 0;

    await catchStoreError(runLock(() => { calls += 1; }), 'lock_timeout');

    expect(calls).toBe(0);
    expect(fs.readFileSync(`${configPath}.lock`, 'utf8')).toBe(replacement);
    expect(readRecords()[0]).toMatchObject({ lockRaw: raw, decision: 'consider_reclaim' });
    expect(fs.readdirSync(tempDir).filter(name => name.includes('.reclaim-'))).toEqual([]);
  });

  it('keeps the original business exception object for both public lock entries', async () => {
    const syncError = new Error('sync business failure');
    const asyncError = new Error('async business failure');

    await expect(withYamlConfigLock(deps, configPath, () => { throw syncError; }, FAST))
      .rejects.toBe(syncError);
    await expect(withYamlConfigLockAsync(deps, configPath, async () => { throw asyncError; }, FAST))
      .rejects.toBe(asyncError);
    expect(fs.existsSync(`${configPath}.lock`)).toBe(false);
  });
});
