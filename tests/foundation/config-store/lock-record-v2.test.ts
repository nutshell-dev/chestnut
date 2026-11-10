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
  ProcessRefCapture,
} from '../../../src/foundation/process-exec/index.js';
import { cleanupTempDir, createTrackedTempDir } from '../../utils/temp.js';

const FAST = { acquireTimeoutMs: 80, staleMs: 0, pollMs: 5 } as const;
const OLD = new Date(Date.now() - 120_000).toISOString();
const EVIDENCE: ProcessEvidence = {
  version: 1,
  atMs: 123,
  facts: [{ operation: 'capture', outcome: 'fixture', detail: { retained: true } }],
};
const REF = JSON.stringify({
  version: 1,
  pid: 1234,
  startTime: 'Tue Nov 10 13:27:59 2026',
  source: { platform: 'darwin', hostname: 'test-host', tzEnv: null, timeZone: 'UTC' },
  basis: 'posix-lstart-second',
  capturedAtMs: 1_794_883_200_000,
}) as ProcessRef;
const CAPTURED: ProcessRefCapture = { kind: 'captured', value: REF, evidence: EVIDENCE };
const UNKNOWN: ProcessRefCapture = {
  kind: 'unknown', reason: 'unsupported', evidence: EVIDENCE,
};
const GONE: ProcessRefCapture = { kind: 'gone', evidence: EVIDENCE };
const LOCK_ENTRIES = [false, true] as const;

let tempDir: string;
let configPath: string;
let nodeFs: NodeFileSystem;
const deps = { fsFactory: () => nodeFs };

beforeEach(async () => {
  tempDir = await createTrackedTempDir('config-lock-record-v2-');
  configPath = path.join(tempDir, 'config.yaml');
  nodeFs = new NodeFileSystem({ baseDir: tempDir });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempDir(tempDir);
});

function runLock(
  asyncEntry: boolean,
  fn: () => void,
  opts: { acquireTimeoutMs: number; staleMs: number; pollMs: number } = FAST,
): Promise<unknown> {
  return asyncEntry
    ? withYamlConfigLockAsync(deps, configPath, async () => { fn(); }, opts)
    : withYamlConfigLock(deps, configPath, fn, opts);
}

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

type StoredSelfCapture = {
  version: number;
  attemptId: string;
  sequence: number;
  atMs: number;
  event: 'self_capture';
  capture: ProcessRefCapture;
};

function readJsonRecords(): Array<Record<string, unknown>> {
  const dirName = 'config.yaml.lock-observations';
  if (!fs.existsSync(path.join(tempDir, dirName))) return [];
  return new NodeFileSystem({ baseDir: tempDir })
    .listSync(dirName, { recursive: true })
    .filter(entry => entry.isFile && /^\d{6}\.json$/.test(entry.name))
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(entry => JSON.parse(nodeFs.readSync(entry.path)) as Record<string, unknown>);
}

function readSelfCaptures(): StoredSelfCapture[] {
  return readJsonRecords()
    .filter(record => record.event === 'self_capture')
    .map(record => record as unknown as StoredSelfCapture);
}

function expectRereadableCapture(capture: ProcessRefCapture): StoredSelfCapture {
  const records = readSelfCaptures();
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    version: 1,
    sequence: 1,
    event: 'self_capture',
    capture,
  });
  expect(records[0].capture).toEqual(capture);
  expect(JSON.parse(JSON.stringify(records[0]))).toEqual(records[0]);
  return records[0];
}

describe('ConfigStore v2 lock records', () => {
  it.each(LOCK_ENTRIES)('persists capture before publishing a complete v2 reference (async=%s)', async asyncEntry => {
    const capture = vi.spyOn(processExec, 'captureCurrentProcessRef').mockReturnValue(CAPTURED);
    let publishedRaw = '';
    let attemptId = '';

    await runLock(asyncEntry, () => {
      publishedRaw = fs.readFileSync(`${configPath}.lock`, 'utf8');
      const payload = JSON.parse(publishedRaw) as {
        lock_version: number;
        token: string;
        createdAt: string;
        observationAttemptId: string;
        holder: { kind: 'reference'; ref: string } | { kind: 'unknown' };
      };
      expect(Object.keys(payload).sort()).toEqual([
        'createdAt', 'holder', 'lock_version', 'observationAttemptId', 'token',
      ]);
      expect(payload).toMatchObject({
        lock_version: 2,
        holder: { kind: 'reference', ref: REF },
      });
      expect(payload.token.length).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(payload.createdAt))).toBe(false);
      expect(payload).not.toHaveProperty('pid');
      expect(payload).not.toHaveProperty('process_start_time');
      if (payload.holder.kind !== 'reference') throw new Error('expected a reference holder');
      expect(processExec.decodeProcessRef(payload.holder.ref)).toEqual({ kind: 'decoded', value: REF });
      const record = expectRereadableCapture(CAPTURED);
      attemptId = record.attemptId;
      expect(payload.observationAttemptId).toBe(attemptId);
    });

    expect(capture).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(`${configPath}.lock`)).toBe(false);
    expect(attemptId).not.toBe('');
    // A successful token release does not remove or rewrite the capture evidence.
    expect(readSelfCaptures()[0]).toEqual(expectRereadableCapture(CAPTURED));
  });

  it.each([
    ['unknown', false, UNKNOWN],
    ['unknown', true, UNKNOWN],
    ['gone', false, GONE],
    ['gone', true, GONE],
  ] as const)('persists the full %s capture and publishes holder unknown (async=%s)', async (
    _label,
    asyncEntry,
    captureResult,
  ) => {
    const capture = vi.spyOn(processExec, 'captureCurrentProcessRef').mockReturnValue(captureResult);

    await runLock(asyncEntry, () => {
      const payload = JSON.parse(fs.readFileSync(`${configPath}.lock`, 'utf8')) as Record<string, unknown>;
      expect(payload).toMatchObject({ lock_version: 2, holder: { kind: 'unknown' } });
      expect(payload).not.toHaveProperty('pid');
      expect(payload).not.toHaveProperty('process_start_time');
    });

    expect(capture).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(`${configPath}.lock`)).toBe(false);
    expectRereadableCapture(captureResult);
  });

  it.each(LOCK_ENTRIES)('does not let a competitor reclaim an unknown holder (async=%s)', async asyncEntry => {
    const raw = JSON.stringify({
      lock_version: 2,
      token: 'unknown-owner',
      createdAt: OLD,
      observationAttemptId: 'unknown-owner-attempt',
      holder: { kind: 'unknown' },
    });
    fs.writeFileSync(`${configPath}.lock`, raw);
    const capture = vi.spyOn(processExec, 'captureCurrentProcessRef').mockReturnValue(UNKNOWN);
    const decode = vi.spyOn(processExec, 'decodeProcessRef');
    const inspect = vi.spyOn(processExec, 'inspectProcessRef');
    let calls = 0;

    await catchStoreError(runLock(asyncEntry, () => { calls += 1; }), 'lock_timeout');

    expect(calls).toBe(0);
    expect(fs.readFileSync(`${configPath}.lock`, 'utf8')).toBe(raw);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(decode).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    expectRereadableCapture(UNKNOWN);
  });

  it.each(LOCK_ENTRIES)('fails before lock publication when capture throws (async=%s)', async asyncEntry => {
    const original = new Error('capture exploded');
    vi.spyOn(processExec, 'captureCurrentProcessRef').mockImplementation(() => { throw original; });
    let calls = 0;

    const error = await catchStoreError(runLock(asyncEntry, () => { calls += 1; }), 'lock_indeterminate');

    expect(calls).toBe(0);
    expect(fs.existsSync(`${configPath}.lock`)).toBe(false);
    expect(fs.existsSync(`${configPath}.lock-observations`)).toBe(false);
    expect(error.message).toContain('config.yaml.lock-observations/');
    expect(error.cause).toMatchObject({
      kind: 'process_capture_failed',
      lockName: 'config.yaml.lock',
      attemptId: expect.any(String),
      attemptDir: expect.stringContaining('config.yaml.lock-observations/'),
      error: original,
    });
  });

  it.each(LOCK_ENTRIES)('fails before lock publication when capture evidence cannot be recorded (async=%s)', async asyncEntry => {
    vi.spyOn(processExec, 'captureCurrentProcessRef').mockReturnValue(CAPTURED);
    const originalWrite = nodeFs.writeAtomicSync.bind(nodeFs);
    const original = new Error('capture record write failed');
    vi.spyOn(nodeFs, 'writeAtomicSync').mockImplementation((relativePath, content) => {
      if (relativePath.endsWith('000001.json')) throw original;
      return originalWrite(relativePath, content);
    });
    let calls = 0;

    const error = await catchStoreError(runLock(asyncEntry, () => { calls += 1; }), 'lock_indeterminate');

    expect(calls).toBe(0);
    expect(fs.existsSync(`${configPath}.lock`)).toBe(false);
    expect(error.cause).toMatchObject({
      kind: 'lock_observation_persistence_failed',
      error: original,
      recordPath: expect.stringMatching(/000001\.json$/),
      targetPath: expect.stringMatching(/000001\.json$/),
      record: { event: 'self_capture', capture: CAPTURED },
    });
  });

  it.each([
    ['capture', false],
    ['capture', true],
    ['record', false],
    ['record', true],
  ] as const)('charges %s persistence time to the original deadline (async=%s)', async (
    stage,
    asyncEntry,
  ) => {
    const initialNow = Date.now();
    let now = initialNow;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.spyOn(processExec, 'captureCurrentProcessRef').mockImplementation(() => {
      if (stage === 'capture') now += 100;
      return CAPTURED;
    });
    if (stage === 'record') {
      const originalWrite = nodeFs.writeAtomicSync.bind(nodeFs);
      vi.spyOn(nodeFs, 'writeAtomicSync').mockImplementation((relativePath, content) => {
        const result = originalWrite(relativePath, content);
        if (relativePath.endsWith('000001.json')) now += 100;
        return result;
      });
    }
    let calls = 0;

    await catchStoreError(runLock(asyncEntry, () => { calls += 1; }, {
      acquireTimeoutMs: 50,
      staleMs: 0,
      pollMs: 1,
    }), 'lock_timeout');

    expect(calls).toBe(0);
    expect(fs.existsSync(`${configPath}.lock`)).toBe(false);
    expectRereadableCapture(CAPTURED);
  });

  it('keeps legacy process mechanisms and OS identity access out of ConfigStore production', () => {
    const productionDir = path.resolve(process.cwd(), 'src/foundation/config-store');
    const sources = fs.readdirSync(productionDir)
      .filter(name => name.endsWith('.ts'))
      .map(name => fs.readFileSync(path.join(productionDir, name), 'utf8'))
      .join('\n');
    expect(sources).not.toMatch(/\b(?:isAlive|getProcessStartTime|makeProcessStartTime)\b/);
    expect(sources).not.toMatch(/\bprocess\.(?:pid|platform)\b/);

    // Business createdAt probing remains ConfigStore's responsibility; no OS
    // process start time may be parsed here under cover of that exception.
    const dateParseLines = sources.split('\n').filter(line => line.includes('Date.parse'));
    expect(dateParseLines.length).toBeGreaterThan(0);
    expect(dateParseLines.every(line => line.includes('createdAt'))).toBe(true);
  });
});
