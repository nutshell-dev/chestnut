import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsAsync from 'node:fs/promises';
import * as path from 'node:path';
import { OutboxReader } from '../../../src/foundation/messaging/outbox-reader.js';
import { encodeOutbox } from '../../../src/foundation/messaging/codec-outbox.js';
import type { ClaimDescriptor } from '../../../src/foundation/messaging/claim-record.js';
import * as claimRecordStore from '../../../src/foundation/messaging/claim-record-store.js';
import type { OutboxMessage } from '../../../src/foundation/messaging/types.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import * as processExec from '../../../src/foundation/process-exec/index.js';
import type {
  ProcessEvidence,
  ProcessRef,
  ProcessRefCapture,
} from '../../../src/foundation/process-exec/index.js';
import { cleanupTempDir, createTrackedTempDir } from '../../utils/temp.js';

const CLAIM_NAME_RE = /^mclaim_1_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.md$/i;
const EVIDENCE: ProcessEvidence = {
  version: 1,
  atMs: 1_700_000_000_000,
  facts: [
    { operation: 'capture', outcome: 'fixture', nested: { retained: [true, null, 3] } },
    { id: 0, type: 'Buffer', properties: [], bytesBase64: 'AAE=' },
  ],
};
const CAPTURED: ProcessRefCapture = {
  kind: 'captured',
  value: '{"version":0,"pid":123,"startTime":"fixture"}' as ProcessRef,
  evidence: EVIDENCE,
};
const GONE: ProcessRefCapture = { kind: 'gone', evidence: EVIDENCE };
const UNKNOWN: ProcessRefCapture = {
  kind: 'unknown',
  reason: 'query_failed',
  evidence: EVIDENCE,
};

type ClaimNextResult = Awaited<ReturnType<OutboxReader['claimNext']>>;
type Claimed = Extract<ClaimNextResult, { status: 'claimed' }>;

let root: string;
let clawDir: string;
let pendingDir: string;
let processingDir: string;
let doneDir: string;
let failedDir: string;
let fs: NodeFileSystem;
let reader: OutboxReader;
let auditEvents: Array<[string, ...unknown[]]>;

beforeEach(async () => {
  root = await createTrackedTempDir('outbox-claim-reference-');
  clawDir = path.join(root, 'claw');
  pendingDir = path.join(clawDir, 'outbox/pending');
  processingDir = path.join(clawDir, 'outbox/processing');
  doneDir = path.join(clawDir, 'outbox/done');
  failedDir = path.join(clawDir, 'outbox/failed');
  await Promise.all(
    [pendingDir, processingDir, doneDir].map(dir => fsAsync.mkdir(dir, { recursive: true })),
  );
  fs = new NodeFileSystem({ baseDir: root });
  auditEvents = [];
  reader = new OutboxReader(fs, {
    write: (event: string, ...cols: unknown[]) => { auditEvents.push([event, ...cols]); },
    preview: (value: string) => value,
    message: (value: string) => value,
    summary: (value: string) => value,
  });
  vi.spyOn(processExec, 'captureCurrentProcessRef').mockReturnValue(CAPTURED);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempDir(root);
});

async function writeOriginal(originalName: string, id = 'message-1') {
  const message: OutboxMessage = {
    id,
    type: 'response',
    from: 'clawA',
    to: 'motion',
    content: '原文 body\n第二行 🌰',
    timestamp: '2026-01-01T00:00:00.000Z',
    priority: 'normal',
  };
  const raw = encodeOutbox(message);
  const originalPath = path.join(pendingDir, originalName);
  await fsAsync.writeFile(originalPath, raw, 'utf8');
  return { raw, message, originalPath };
}

async function claim(options: { readContent?: boolean } = {}): Promise<Claimed> {
  const result = await reader.claimNext(clawDir, options);
  expect(result.status).toBe('claimed');
  if (result.status !== 'claimed') throw new Error(`expected claimed result: ${JSON.stringify(result)}`);
  return result;
}

async function mdFiles(dir: string): Promise<string[]> {
  try {
    return (await fsAsync.readdir(dir)).filter(name => name.endsWith('.md')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function readRecord(claimName: string) {
  const claimId = CLAIM_NAME_RE.exec(claimName)?.[1];
  expect(claimId).toBeDefined();
  if (claimId === undefined) throw new Error(`invalid claim name: ${claimName}`);
  const recordPath = path.join(`${processingDir}-claims`, claimId, 'record.json');
  const raw = await fsAsync.readFile(recordPath, 'utf8');
  return { claimId, recordPath, raw, descriptor: JSON.parse(raw) as ClaimDescriptor };
}

async function readSoleRecord() {
  const entries = await fsAsync.readdir(`${processingDir}-claims`, { withFileTypes: true });
  const directories = entries.filter(entry => entry.isDirectory());
  expect(directories).toHaveLength(1);
  return readRecord(`mclaim_1_${directories[0].name}.md`);
}

describe('OutboxReader claim references', () => {
  it.each([
    ['captured', CAPTURED],
    ['gone', GONE],
    ['unknown', UNKNOWN],
  ] as const)('claims a long Unicode original under a short mclaim name with the complete %s capture', async (_kind, capture) => {
    vi.mocked(processExec.captureCurrentProcessRef).mockReturnValue(capture);
    const originalName = `消息-${'长'.repeat(60)}-🌰.md`;
    const { raw, originalPath } = await writeOriginal(originalName);
    const before = Date.now();

    const claimed = await claim();
    const after = Date.now();

    const claimName = path.basename(claimed.claimPath);
    expect(claimName).toMatch(CLAIM_NAME_RE);
    expect(Buffer.byteLength(claimName)).toBeLessThan(Buffer.byteLength(originalName));
    expect(claimed.claimPath).toBe(path.join('outbox/processing', claimName));
    expect(claimed.filename).toBe(originalName);
    expect(claimed.content).toBe(raw);
    await expect(fsAsync.readFile(path.join(clawDir, claimed.claimPath), 'utf8')).resolves.toBe(raw);
    await expect(fsAsync.access(originalPath)).rejects.toMatchObject({ code: 'ENOENT' });

    const { claimId, descriptor } = await readRecord(claimName);
    expect(descriptor).toEqual({
      version: 1,
      claimId,
      channel: 'outbox',
      originalName,
      claimName,
      createdAtMs: expect.any(Number),
      capture,
    });
    expect(descriptor.createdAtMs).toBeGreaterThanOrEqual(before);
    expect(descriptor.createdAtMs).toBeLessThanOrEqual(after);
    expect(descriptor.capture.evidence).toEqual(EVIDENCE);
  });

  it('rejects preparation failure before move instead of returning empty, race_lost, or io_error', async () => {
    const originalName = 'prepare-failure.md';
    const { raw, originalPath } = await writeOriginal(originalName);
    const prepareError = new Error('claim record preparation failed');
    const prepare = vi.spyOn(claimRecordStore, 'prepareClaimRecord').mockRejectedValue(prepareError);
    const move = vi.spyOn(fs, 'move');

    await expect(reader.claimNext(clawDir)).rejects.toBe(prepareError);

    expect(prepare).toHaveBeenCalledWith(fs, processingDir, 'outbox', originalName);
    expect(move).not.toHaveBeenCalled();
    await expect(fsAsync.readFile(originalPath, 'utf8')).resolves.toBe(raw);
    expect(await mdFiles(processingDir)).toEqual([]);
  });

  it('lets only one of two consumers move the message and retains both preparation records', async () => {
    const originalName = 'competing-consumers.md';
    const { raw } = await writeOriginal(originalName);
    const sourcePath = path.join(pendingDir, originalName);
    let arrived = 0;
    let successfulClaimMoves = 0;
    let release!: () => void;
    const bothMoving = new Promise<void>(resolve => { release = resolve; });

    function competingReader() {
      const competingFs = new NodeFileSystem({ baseDir: root });
      const realMove = competingFs.move.bind(competingFs);
      vi.spyOn(competingFs, 'move').mockImplementation(async (fromPath, toPath) => {
        if (fromPath === sourcePath) {
          arrived += 1;
          if (arrived === 2) release();
          await bothMoving;
        }
        await realMove(fromPath, toPath);
        if (fromPath === sourcePath) successfulClaimMoves += 1;
      });
      return new OutboxReader(competingFs, { write: () => { /* audit is not under test */ } });
    }

    const results = await Promise.all([
      competingReader().claimNext(clawDir),
      competingReader().claimNext(clawDir),
    ]);

    expect(results.map(result => result.status).sort()).toEqual(['claimed', 'race_lost']);
    expect(successfulClaimMoves).toBe(1);
    const winner = results.find((result): result is Claimed => result.status === 'claimed');
    expect(winner).toBeDefined();
    if (winner === undefined) throw new Error('expected one winning consumer');
    expect(winner.filename).toBe(originalName);
    expect(winner.content).toBe(raw);
    expect(await mdFiles(pendingDir)).toEqual([]);
    expect(await mdFiles(processingDir)).toEqual([path.basename(winner.claimPath)]);
    expect(await mdFiles(doneDir)).toEqual([]);
    expect(await mdFiles(failedDir)).toEqual([]);
    await expect(fsAsync.readFile(path.join(clawDir, winner.claimPath), 'utf8')).resolves.toBe(raw);

    const claimEntries = await fsAsync.readdir(`${processingDir}-claims`, { withFileTypes: true });
    const claimIds = claimEntries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    expect(claimIds).toHaveLength(2);
    expect(new Set(claimIds).size).toBe(2);
    const records = await Promise.all(claimIds.map(claimId => readRecord(`mclaim_1_${claimId}.md`)));
    expect(records.map(record => record.descriptor.claimName).sort()).toEqual(
      claimIds.map(claimId => `mclaim_1_${claimId}.md`).sort(),
    );
    for (const record of records) {
      expect(record.descriptor).toMatchObject({
        channel: 'outbox',
        originalName,
        capture: CAPTURED,
      });
      await expect(fsAsync.readFile(record.recordPath, 'utf8')).resolves.toBe(record.raw);
    }
    expect(records.some(record => record.descriptor.claimName === path.basename(winner.claimPath))).toBe(true);
  });

  it('prepares the mclaim record even when readContent is false', async () => {
    const originalName = 'skip-read.md';
    const { raw } = await writeOriginal(originalName);
    const read = vi.spyOn(fs, 'read');

    const claimed = await claim({ readContent: false });

    expect(claimed.content).toBe('');
    expect(read).not.toHaveBeenCalled();
    expect(path.basename(claimed.claimPath)).toMatch(CLAIM_NAME_RE);
    await expect(fsAsync.readFile(path.join(clawDir, claimed.claimPath), 'utf8')).resolves.toBe(raw);
    const { descriptor } = await readRecord(path.basename(claimed.claimPath));
    expect(descriptor).toMatchObject({ originalName, capture: CAPTURED });
  });

  it('restores the original pending name and retains the record when reading the new claim fails', async () => {
    const originalName = 'read-failure.md';
    const { raw, originalPath } = await writeOriginal(originalName);
    const realRead = fs.read.bind(fs);
    const readError = Object.assign(new Error('EIO claimed read'), { code: 'EIO' });
    vi.spyOn(fs, 'read').mockImplementation(async targetPath => {
      if (targetPath.startsWith(`${processingDir}${path.sep}`)) throw readError;
      return realRead(targetPath);
    });

    const result = await reader.claimNext(clawDir);

    expect(result).toEqual({ status: 'io_error', error: expect.stringContaining('EIO claimed read') });
    expect(await mdFiles(processingDir)).toEqual([]);
    expect(await mdFiles(pendingDir)).toEqual([originalName]);
    await expect(fsAsync.readFile(originalPath, 'utf8')).resolves.toBe(raw);
    const { descriptor, recordPath, raw: recordRaw } = await readSoleRecord();
    expect(descriptor.originalName).toBe(originalName);
    await expect(fsAsync.readFile(recordPath, 'utf8')).resolves.toBe(recordRaw);
  });

  it('quarantines the claimed bytes without overwriting a conflicting original pending target', async () => {
    const originalName = 'read-failure-conflict.md';
    const { raw, originalPath } = await writeOriginal(originalName);
    const realRead = fs.read.bind(fs);
    const readError = Object.assign(new Error('EIO claimed read'), { code: 'EIO' });
    const conflictingBytes = 'concurrent pending content';
    vi.spyOn(fs, 'read').mockImplementation(async targetPath => {
      if (targetPath.startsWith(`${processingDir}${path.sep}`)) {
        await fsAsync.writeFile(originalPath, conflictingBytes, 'utf8');
        throw readError;
      }
      return realRead(targetPath);
    });

    const result = await reader.claimNext(clawDir);

    expect(result).toEqual({ status: 'io_error', error: expect.stringContaining('EIO claimed read') });
    expect(await mdFiles(processingDir)).toEqual([]);
    expect(await mdFiles(pendingDir)).toEqual([originalName]);
    await expect(fsAsync.readFile(originalPath, 'utf8')).resolves.toBe(conflictingBytes);
    const failedFiles = await mdFiles(failedDir);
    expect(failedFiles).toHaveLength(1);
    expect(failedFiles[0].endsWith(`_${originalName}`)).toBe(true);
    await expect(fsAsync.readFile(path.join(failedDir, failedFiles[0]), 'utf8')).resolves.toBe(raw);
    const { descriptor } = await readSoleRecord();
    expect(descriptor.originalName).toBe(originalName);
    expect(auditEvents.some(event =>
      event[0] === 'outbox_stage_quarantine' && String(event).includes('reason=conflict')
    )).toBe(true);
  });

  it('returns recovery_required with a claimPath to the real new file when rollback fails', async () => {
    const originalName = 'rollback-failure.md';
    const { raw } = await writeOriginal(originalName);
    const realRead = fs.read.bind(fs);
    const realMove = fs.move.bind(fs);
    const readError = Object.assign(new Error('EIO claimed read'), { code: 'EIO' });
    const rollbackError = Object.assign(new Error('EPERM rollback'), { code: 'EPERM' });
    vi.spyOn(fs, 'read').mockImplementation(async targetPath => {
      if (targetPath.startsWith(`${processingDir}${path.sep}`)) throw readError;
      return realRead(targetPath);
    });
    vi.spyOn(fs, 'move').mockImplementation(async (fromPath, toPath) => {
      if (fromPath.startsWith(`${processingDir}${path.sep}`) && toPath.includes('.staging')) {
        throw rollbackError;
      }
      return realMove(fromPath, toPath);
    });

    const result = await reader.claimNext(clawDir);

    expect(result.status).toBe('recovery_required');
    if (result.status !== 'recovery_required') throw new Error('unreachable');
    expect(result.readError).toContain('EIO claimed read');
    expect(result.rollbackError).toContain('EPERM rollback');
    expect(result.filename).toBe(originalName);
    expect(path.basename(result.claimPath)).toMatch(CLAIM_NAME_RE);
    const realClaimPath = path.join(clawDir, result.claimPath);
    await expect(fsAsync.readFile(realClaimPath, 'utf8')).resolves.toBe(raw);
    expect(await mdFiles(processingDir)).toEqual([path.basename(result.claimPath)]);
    expect(await mdFiles(pendingDir)).toEqual([]);
    const { descriptor } = await readRecord(path.basename(result.claimPath));
    expect(descriptor).toMatchObject({ originalName, claimName: path.basename(result.claimPath) });
  });

  it.each(['done', 'skip'] as const)('%s settles by original name, retains the record, and does not replay it', async operation => {
    const originalName = `原-${operation}-消息.md`;
    const { raw } = await writeOriginal(originalName, `message-${operation}`);
    const claimed = await claim();
    const claimName = path.basename(claimed.claimPath);
    const { recordPath, raw: recordRaw } = await readRecord(claimName);

    if (operation === 'done') {
      await reader.markDone(clawDir, claimed.claimPath, claimed.filename);
    } else {
      await reader.markSkipped(clawDir, claimed.claimPath, claimed.filename);
    }

    expect(await mdFiles(processingDir)).toEqual([]);
    expect(await mdFiles(pendingDir)).toEqual([]);
    const doneFiles = await mdFiles(doneDir);
    expect(doneFiles).toHaveLength(1);
    expect(doneFiles[0].endsWith(`_${originalName}`)).toBe(true);
    await expect(fsAsync.readFile(path.join(doneDir, doneFiles[0]), 'utf8')).resolves.toBe(raw);
    await expect(fsAsync.readFile(recordPath, 'utf8')).resolves.toBe(recordRaw);
    const auditName = operation === 'done' ? 'outbox_delivered' : 'outbox_skipped';
    expect(auditEvents.some(event =>
      event[0] === auditName && String(event).includes(`file=${originalName}`)
    )).toBe(true);

    await reader.init(clawDir);

    expect(await mdFiles(pendingDir)).toEqual([]);
    expect(await mdFiles(processingDir)).toEqual([]);
    expect(await mdFiles(doneDir)).toEqual(doneFiles);
    await expect(fsAsync.readFile(recordPath, 'utf8')).resolves.toBe(recordRaw);
    await expect(reader.claimNext(clawDir)).resolves.toEqual({ status: 'empty' });
  });
});
