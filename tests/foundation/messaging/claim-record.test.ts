import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsAsync from 'node:fs/promises';
import * as path from 'node:path';
import {
  ClaimRecordUnavailableError,
  loadClaimDescriptor,
} from '../../../src/foundation/messaging/claim-record.js';
import type { ClaimChannel } from '../../../src/foundation/messaging/claim-record.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { decodeProcessRef } from '../../../src/foundation/process-exec/index.js';
import { cleanupTempDir, createTrackedTempDir } from '../../utils/temp.js';

const UUID = '123e4567-e89b-42d3-a456-426614174000';
const OTHER_UUID = '223e4567-e89b-42d3-a456-426614174000';
const RAW_NAME = `mclaim_1_${UUID}.md`;
const EVIDENCE = {
  version: 1,
  atMs: 1_700_000_000_001,
  facts: [
    { operation: 'capture', outcome: 'fixture', nested: { retained: [true, null, 3] } },
    { id: 0, type: 'Buffer', properties: [], bytesBase64: 'AAE=' },
  ],
  unknownEvidenceField: { retained: true },
};
const CAPTURED = {
  kind: 'captured',
  value: 'opaque-reference-for-L1',
  evidence: EVIDENCE,
  unknownCaptureField: 'retained',
};

let root: string;
let sourceDir: string;
let recordPath: string;
let fs: NodeFileSystem;

beforeEach(async () => {
  root = await createTrackedTempDir('claim-record-');
  sourceDir = path.join(root, 'custom/inflight');
  recordPath = `${sourceDir}-claims/${UUID}/record.json`;
  await fsAsync.mkdir(sourceDir, { recursive: true });
  fs = new NodeFileSystem({ baseDir: root });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempDir(root);
});

function descriptor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    claimId: UUID,
    channel: 'inbox',
    originalName: 'original.md',
    claimName: RAW_NAME,
    createdAtMs: 1_700_000_000_000,
    capture: CAPTURED,
    unknownDescriptorField: { retained: ['complete', 1] },
    ...overrides,
  };
}

async function writeRecord(value: unknown = descriptor(), raw?: string): Promise<string> {
  const content = raw ?? JSON.stringify(value, null, 2);
  await fsAsync.mkdir(path.dirname(recordPath), { recursive: true });
  await fsAsync.writeFile(recordPath, content, 'utf8');
  return content;
}

async function catchUnavailable(promise: Promise<unknown>): Promise<ClaimRecordUnavailableError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ClaimRecordUnavailableError);
    return error as ClaimRecordUnavailableError;
  }
  throw new Error('expected ClaimRecordUnavailableError');
}

function load(rawName = RAW_NAME, channel: ClaimChannel = 'inbox') {
  return loadClaimDescriptor(fs, sourceDir, rawName, channel);
}

describe('loadClaimDescriptor', () => {
  it('preserves the exact raw JSON and every public/unknown field without decoding captured.value', async () => {
    const value = descriptor();
    const raw = `${JSON.stringify(value, null, 2)}\n`;
    await writeRecord(value, raw);

    const loaded = await load();

    expect(loaded.recordPath).toBe(recordPath);
    expect(loaded.raw).toBe(raw);
    expect(loaded.descriptor).toEqual(value);
    expect(loaded.descriptor.capture).toEqual(CAPTURED);
    expect(loaded.descriptor.capture.kind).toBe('captured');
    if (loaded.descriptor.capture.kind === 'captured') {
      expect(decodeProcessRef(loaded.descriptor.capture.value).kind).toBe('invalid');
    }
  });

  it.each([
    { kind: 'gone', evidence: EVIDENCE, captureExtension: 1 },
    { kind: 'unknown', reason: 'query_failed', evidence: EVIDENCE, captureExtension: 2 },
  ] as const)('retains the complete public $kind capture and evidence', async capture => {
    const value = descriptor({ capture });
    await writeRecord(value);

    const loaded = await load();

    expect(loaded.descriptor.capture).toEqual(capture);
    expect(loaded.descriptor.capture.evidence).toEqual(EVIDENCE);
  });

  it('uses the actual custom sourceDir to derive the record path', async () => {
    sourceDir = path.join(root, 'another/custom-processing');
    recordPath = `${sourceDir}-claims/${UUID}/record.json`;
    await writeRecord();

    await expect(load()).resolves.toMatchObject({ recordPath });
  });

  it.each([
    'mclaim_2_123e4567-e89b-42d3-a456-426614174000.md',
    'mclaim_future.md',
    'mclaim_1_not-a-uuid.md',
    'mclaim_1_123e4567-e89b-42d3-a456-426614174000.txt',
    'mclaim_1_123e4567-e89b-42d3-a456-426614174000.md.extra',
  ])('fails closed for reserved bad/future source name %s', async rawName => {
    const read = vi.spyOn(fs, 'read');

    const error = await catchUnavailable(load(rawName));

    expect(error.entry).toBe(rawName);
    expect(error.rawName).toBe(rawName);
    expect(error.issue.kind).toMatch(/invalid|unsupported/);
    expect(error.recordPath).toBeUndefined();
    expect(error.raw).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects a non-reserved direct input instead of treating it as legacy', async () => {
    const error = await catchUnavailable(load('42_0_original.md'));
    expect(error.issue.kind).toBe('invalid');
  });

  it('classifies a missing record and retains its derived path and original cause', async () => {
    const error = await catchUnavailable(load());

    expect(error.issue.kind).toBe('missing');
    expect(error.issue.code).toBe('FS_NOT_FOUND');
    expect(error.recordPath).toBe(recordPath);
    expect(error.raw).toBeUndefined();
    expect(error.cause).toMatchObject({ code: 'FS_NOT_FOUND' });
  });

  it('retains malformed raw JSON and its SyntaxError cause', async () => {
    const raw = '{"version":1,"claimId":';
    await writeRecord(undefined, raw);

    const error = await catchUnavailable(load());

    expect(error.issue.kind).toBe('invalid');
    expect(error.recordPath).toBe(recordPath);
    expect(error.raw).toBe(raw);
    expect(error.cause).toBeInstanceOf(SyntaxError);
  });

  it('classifies an I/O failure with code and the identical original cause', async () => {
    const cause = Object.assign(new Error('descriptor EIO'), { code: 'EIO' });
    vi.spyOn(fs, 'read').mockRejectedValue(cause);

    const error = await catchUnavailable(load());

    expect(error.issue).toMatchObject({ kind: 'io', code: 'EIO' });
    expect(error.issue.detail).toContain('descriptor EIO');
    expect(error.recordPath).toBe(recordPath);
    expect(error.raw).toBeUndefined();
    expect(error.cause).toBe(cause);
  });

  it.each([
    ['future schema', { version: 2 }, 'unsupported'],
    ['invalid schema version', { version: '1' }, 'invalid'],
    ['id binding', { claimId: OTHER_UUID }, 'invalid'],
    ['channel binding', { channel: 'outbox' }, 'invalid'],
    ['name binding', { claimName: `mclaim_1_${OTHER_UUID}.md` }, 'invalid'],
    ['created time', { createdAtMs: null }, 'invalid'],
    ['non-object record', null, 'invalid'],
  ] as const)('retains raw and rejects %s', async (_label, override, kind) => {
    const value = override === null ? null : descriptor(override);
    const raw = await writeRecord(value);

    const error = await catchUnavailable(load());

    expect(error.issue.kind).toBe(kind);
    expect(error.recordPath).toBe(recordPath);
    expect(error.raw).toBe(raw);
  });

  it('rejects a valid record presented to the other channel', async () => {
    await writeRecord(descriptor({ channel: 'outbox' }));

    const error = await catchUnavailable(load(RAW_NAME, 'inbox'));

    expect(error.issue).toMatchObject({ kind: 'invalid' });
    expect(error.issue.detail).toContain('channel');
  });

  it.each([
    '',
    '.',
    '..',
    'nested/original.md',
    'nested\\original.md',
    'bad\0name.md',
    'bad:name.md',
    'original.txt',
    42,
  ])('rejects unsafe originalName %j', async originalName => {
    const raw = await writeRecord(descriptor({ originalName }));

    const error = await catchUnavailable(load());

    expect(error.issue.kind).toBe('invalid');
    expect(error.issue.detail).toContain('originalName');
    expect(error.raw).toBe(raw);
  });

  it('applies the additional outbox double-dot ban without changing inbox compatibility', async () => {
    const value = descriptor({ originalName: 'archive..md' });
    await writeRecord(value);

    await expect(load()).resolves.toMatchObject({
      descriptor: { originalName: 'archive..md' },
    });
    await writeRecord(descriptor({ channel: 'outbox', originalName: 'archive..md' }));
    const error = await catchUnavailable(load(RAW_NAME, 'outbox'));
    expect(error.issue.kind).toBe('invalid');
    expect(error.issue.detail).toContain('originalName');
  });

  it.each([
    ['missing captured value', { kind: 'captured', evidence: EVIDENCE }, 'invalid'],
    ['future capture kind', { kind: 'future', evidence: EVIDENCE }, 'unsupported'],
    ['missing unknown reason', { kind: 'unknown', evidence: EVIDENCE }, 'invalid'],
    [
      'future unknown reason',
      { kind: 'unknown', reason: 'future_reason', evidence: EVIDENCE },
      'unsupported',
    ],
    [
      'future evidence',
      { kind: 'gone', evidence: { ...EVIDENCE, version: 2 } },
      'unsupported',
    ],
    [
      'invalid evidence time',
      { kind: 'gone', evidence: { ...EVIDENCE, atMs: null } },
      'invalid',
    ],
    [
      'invalid evidence facts',
      { kind: 'gone', evidence: { ...EVIDENCE, facts: {} } },
      'invalid',
    ],
  ] as const)('rejects %s while retaining the complete raw record', async (
    _label,
    capture,
    kind,
  ) => {
    const raw = await writeRecord(descriptor({ capture }));

    const error = await catchUnavailable(load());

    expect(error.issue.kind).toBe(kind);
    expect(error.raw).toBe(raw);
    expect(error.recordPath).toBe(recordPath);
  });
});
