import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsAsync from 'node:fs/promises';
import * as path from 'node:path';
import { InboxReader } from '../../../src/foundation/messaging/inbox-reader.js';
import { OutboxReader } from '../../../src/foundation/messaging/outbox-reader.js';
import {
  ClaimObservationPersistenceError,
  type ClaimRecord,
} from '../../../src/foundation/messaging/claim-observation-store.js';
import { ClaimRecordUnavailableError } from '../../../src/foundation/messaging/claim-record.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import {
  captureCurrentProcessRef,
  decodeProcessRef,
  type ProcessRefCapture,
} from '../../../src/foundation/process-exec/index.js';
import { cleanupTempDir, createTrackedTempDir } from '../../utils/temp.js';

const CHANNELS = ['inbox', 'outbox'] as const;
type Channel = typeof CHANNELS[number];
type Captured = Extract<ProcessRefCapture, { kind: 'captured' }>;

const NOW = 1_700_000_000_000;
const STALE_THRESHOLD_MS = 300_000;
const STALE_MS = STALE_THRESHOLD_MS + 1_000;
const CLAIM_ID = '123e4567-e89b-42d3-a456-426614174000';
const OTHER_CLAIM_ID = '223e4567-e89b-42d3-a456-426614174000';
const noopAudit = { write: () => { /* reader audit is not under test */ } };
const CAPTURE_EVIDENCE = {
  version: 1 as const,
  atMs: NOW - 2_000,
  facts: [
    { operation: 'capture', outcome: 'fixture', complete: { retained: [true, null, 3] } },
    { operation: 'decision', outcome: { source: 'complete-public-fixture' } },
  ],
};

let root: string;

beforeEach(async () => {
  root = await createTrackedTempDir('claim-reference-recovery-');
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempDir(root);
});

function dirs(channel: Channel) {
  if (channel === 'inbox') {
    const base = path.join(root, 'custom-inbox');
    return {
      clawDir: base,
      pendingDir: path.join(base, 'pending'),
      doneDir: path.join(base, 'done'),
      failedDir: path.join(base, 'failed'),
      // Deliberately neither the default name nor a sibling derived by string replacement.
      sourceDir: path.join(base, 'held-messages'),
    };
  }
  const clawDir = path.join(root, 'outbox-claw');
  return {
    clawDir,
    pendingDir: path.join(clawDir, 'outbox', 'pending'),
    doneDir: path.join(clawDir, 'outbox', 'done'),
    failedDir: path.join(clawDir, 'outbox', 'failed'),
    sourceDir: path.join(clawDir, 'outbox', 'processing'),
  };
}

function makeFs(): NodeFileSystem {
  return new NodeFileSystem({ baseDir: root });
}

function makeReader(channel: Channel, fs = makeFs()): InboxReader | OutboxReader {
  const layout = dirs(channel);
  return channel === 'inbox'
    ? new InboxReader(
        layout.pendingDir,
        layout.doneDir,
        layout.failedDir,
        fs,
        noopAudit,
        layout.sourceDir,
      )
    : new OutboxReader(fs, noopAudit);
}

async function initialize(channel: Channel, fs = makeFs()): Promise<void> {
  const reader = makeReader(channel, fs);
  if (channel === 'inbox') {
    const result = await (reader as InboxReader).init();
    expect(result.kind).toBe('ready');
  } else {
    await (reader as OutboxReader).init(dirs(channel).clawDir);
  }
}

function liveCapture(): Captured {
  const captured = captureCurrentProcessRef();
  expect(captured.kind, JSON.stringify(captured)).toBe('captured');
  if (captured.kind !== 'captured') throw new Error('expected a captured current process reference');
  return JSON.parse(JSON.stringify(captured)) as Captured;
}

function capturedObservedAs(kind: 'unknown' | 'gone'): Captured {
  const captured = liveCapture();
  const reference = JSON.parse(captured.value) as {
    startTime: string;
    source: { hostname: string };
  };
  if (kind === 'unknown') {
    reference.source.hostname = `foreign-${reference.source.hostname}`;
  } else {
    reference.startTime = reference.startTime === 'Mon Jan  1 00:00:00 2020'
      ? 'Tue Jan  2 00:00:00 2020'
      : 'Mon Jan  1 00:00:00 2020';
  }
  captured.value = JSON.stringify(reference) as Captured['value'];
  return captured;
}

function uncaptured(kind: 'unknown' | 'gone'): ProcessRefCapture {
  return kind === 'unknown'
    ? { kind, reason: 'query_failed', evidence: CAPTURE_EVIDENCE }
    : { kind, evidence: CAPTURE_EVIDENCE };
}

type SeedOptions = {
  originalName?: string;
  content?: string;
  stale?: boolean;
  claimId?: string;
  recordOverrides?: Record<string, unknown>;
  rawRecord?: string;
  writeRecord?: boolean;
};

async function seedClaim(channel: Channel, capture: ProcessRefCapture, options: SeedOptions = {}) {
  const layout = dirs(channel);
  const claimId = options.claimId ?? CLAIM_ID;
  const rawName = `mclaim_1_${claimId}.md`;
  const originalName = options.originalName ?? `${channel}-original.md`;
  const content = options.content ?? `${channel} reserved claim content`;
  const sourcePath = path.join(layout.sourceDir, rawName);
  const recordPath = `${layout.sourceDir}-claims/${claimId}/record.json`;
  const descriptor = {
    version: 1,
    claimId,
    channel,
    originalName,
    claimName: rawName,
    createdAtMs: NOW - 10_000,
    capture: JSON.parse(JSON.stringify(capture)) as ProcessRefCapture,
    extension: { retained: ['raw', 1, true] },
    ...options.recordOverrides,
  };
  const raw = options.rawRecord ?? `${JSON.stringify(descriptor, null, 2)}\n`;
  await fsAsync.mkdir(layout.sourceDir, { recursive: true });
  await fsAsync.writeFile(sourcePath, content, 'utf8');
  const mtime = new Date(options.stale === true ? NOW - STALE_MS : NOW);
  await fsAsync.utimes(sourcePath, mtime, mtime);
  if (options.writeRecord !== false) {
    await fsAsync.mkdir(path.dirname(recordPath), { recursive: true });
    await fsAsync.writeFile(recordPath, raw, 'utf8');
  }
  return {
    ...layout,
    claimId,
    rawName,
    originalName,
    content,
    sourcePath,
    targetPath: path.join(layout.pendingDir, originalName),
    recordPath,
    descriptor,
    raw,
  };
}

async function mdFiles(dir: string): Promise<string[]> {
  try {
    return (await fsAsync.readdir(dir)).filter(name => name.endsWith('.md')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function observationRecords(channel: Channel): Promise<ClaimRecord[]> {
  const observationRoot = `${dirs(channel).sourceDir}-observations`;
  let entries;
  try {
    entries = await fsAsync.readdir(observationRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records: ClaimRecord[] = [];
  for (const entry of entries.filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const attemptDir = path.join(observationRoot, entry.name);
    const names = (await fsAsync.readdir(attemptDir))
      .filter(name => /^\d+\.json$/.test(name))
      .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    for (const name of names) {
      records.push(JSON.parse(await fsAsync.readFile(path.join(attemptDir, name), 'utf8')) as ClaimRecord);
    }
  }
  return records;
}

async function unavailable(promise: Promise<unknown>): Promise<ClaimRecordUnavailableError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ClaimRecordUnavailableError);
    return error as ClaimRecordUnavailableError;
  }
  throw new Error('expected ClaimRecordUnavailableError');
}

async function persistenceFailure(promise: Promise<unknown>): Promise<ClaimObservationPersistenceError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ClaimObservationPersistenceError);
    return error as ClaimObservationPersistenceError;
  }
  throw new Error('expected ClaimObservationPersistenceError');
}

describe('mclaim_ process-reference recovery with real NodeFS', () => {
  it.each(CHANNELS)('%s retains an over-age live v1 capture without using its lease', async channel => {
    const claim = await seedClaim(channel, liveCapture(), { stale: true });

    await initialize(channel);

    expect(await mdFiles(claim.sourceDir)).toEqual([claim.rawName]);
    expect(await fsAsync.readFile(claim.sourcePath, 'utf8')).toBe(claim.content);
    expect(await mdFiles(claim.pendingDir)).toEqual([]);
    const records = await observationRecords(channel);
    expect(records.map(record => record.event)).toEqual(['process_observed', 'decision']);
    expect(records[1].decision).toEqual({ kind: 'retain', reason: 'alive' });
    expect(records[1].process?.observed).toMatchObject({ kind: 'alive' });
  });

  it.each(CHANNELS)('%s retains an over-age captured unknown owner', async channel => {
    const claim = await seedClaim(channel, capturedObservedAs('unknown'), { stale: true });

    await initialize(channel);

    expect(await mdFiles(claim.sourceDir)).toEqual([claim.rawName]);
    expect(await mdFiles(claim.pendingDir)).toEqual([]);
    const records = await observationRecords(channel);
    expect(records[1].decision).toEqual({ kind: 'retain', reason: 'unknown' });
    expect(records[1].process?.observed).toMatchObject({
      kind: 'unknown',
      reason: 'identity_unverifiable',
    });
  });

  it.each(CHANNELS)('%s restores a captured gone owner under its original name with exact raw/facts', async channel => {
    const capture = capturedObservedAs('gone');
    const claim = await seedClaim(channel, capture, { stale: false });

    await initialize(channel);

    expect(await mdFiles(claim.sourceDir)).toEqual([]);
    expect(await mdFiles(claim.pendingDir)).toEqual([claim.originalName]);
    expect(await fsAsync.readFile(claim.targetPath, 'utf8')).toBe(claim.content);
    const records = await observationRecords(channel);
    expect(records.map(record => record.event)).toEqual(['process_observed', 'decision']);
    const [observation, decision] = records;
    expect(observation.claim).toEqual({ recordPath: claim.recordPath, raw: claim.raw });
    expect(decision.claim).toEqual({ recordPath: claim.recordPath, raw: claim.raw });
    const decoded = decodeProcessRef(capture.value);
    expect(decoded.kind).toBe('decoded');
    if (decoded.kind !== 'decoded') throw new Error('expected valid captured reference');
    expect(observation.process?.decoded).toStrictEqual(JSON.parse(JSON.stringify(decoded)));
    expect(observation.process?.observed).toMatchObject({
      kind: 'gone',
      reason: 'identity_changed',
      evidence: { version: 1, atMs: NOW },
    });
    expect(observation.process?.observed?.evidence.facts.length).toBeGreaterThan(0);
    // Observation and decision must retain the identical complete facts, including
    // transient OS-query evidence whose child PID cannot be reproduced by a second query.
    expect(decision.process).toStrictEqual(observation.process);
    expect(decision.decision).toEqual({ kind: 'reclaim', reason: 'process_gone' });
  });

  it.each(CHANNELS.flatMap(channel => ([
    { channel, captureKind: 'unknown' as const, stale: false },
    { channel, captureKind: 'unknown' as const, stale: true },
    { channel, captureKind: 'gone' as const, stale: false },
    { channel, captureKind: 'gone' as const, stale: true },
  ])))(
    '$channel uses only the mtime lease for $captureKind capture (stale=$stale)',
    async ({ channel, captureKind, stale }) => {
      const claim = await seedClaim(channel, uncaptured(captureKind), { stale });

      await initialize(channel);

      const records = await observationRecords(channel);
      expect(records.map(record => record.event)).toEqual(['claim_observed', 'decision']);
      expect(records[0].process).toBeUndefined();
      expect(records[0].claim).toEqual({ recordPath: claim.recordPath, raw: claim.raw });
      expect(records[1].process).toBeUndefined();
      expect(records[1].lease).toEqual({
        thresholdMs: STALE_THRESHOLD_MS,
        observedAtMs: NOW,
        valueMs: stale ? NOW - STALE_MS : NOW,
      });
      expect(records[1].decision).toEqual(stale
        ? { kind: 'reclaim', reason: 'lease_elapsed' }
        : { kind: 'retain', reason: 'lease_active' });
      expect(await mdFiles(claim.sourceDir)).toEqual(stale ? [] : [claim.rawName]);
      expect(await mdFiles(claim.pendingDir)).toEqual(stale ? [claim.originalName] : []);
      if (stale) expect(await fsAsync.readFile(claim.targetPath, 'utf8')).toBe(claim.content);
    },
  );

  it.each(CHANNELS.flatMap(channel => ([
    { channel, label: 'missing', writeRecord: false, issue: 'missing' },
    { channel, label: 'bad JSON', rawRecord: '{"version":1,', issue: 'invalid' },
    { channel, label: 'future schema', recordOverrides: { version: 2 }, issue: 'unsupported' },
    {
      channel,
      label: 'claimId binding',
      recordOverrides: { claimId: OTHER_CLAIM_ID },
      issue: 'invalid',
    },
    {
      channel,
      label: 'claimName binding',
      recordOverrides: { claimName: `mclaim_1_${OTHER_CLAIM_ID}.md` },
      issue: 'invalid',
    },
    {
      channel,
      label: 'channel binding',
      recordOverrides: { channel: channel === 'inbox' ? 'outbox' : 'inbox' },
      issue: 'invalid',
    },
  ])))('$channel rejects $label records without legacy/mtime fallback', async testCase => {
    const claim = await seedClaim(testCase.channel, uncaptured('gone'), {
      stale: true,
      writeRecord: testCase.writeRecord,
      rawRecord: testCase.rawRecord,
      recordOverrides: testCase.recordOverrides,
    });

    const error = await unavailable(initialize(testCase.channel));

    expect(error.entry).toBe(claim.rawName);
    expect(error.issue.kind).toBe(testCase.issue);
    expect(await mdFiles(claim.sourceDir)).toEqual([claim.rawName]);
    expect(await fsAsync.readFile(claim.sourcePath, 'utf8')).toBe(claim.content);
    expect(await mdFiles(claim.pendingDir)).toEqual([]);
    const records = await observationRecords(testCase.channel);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      rawName: claim.rawName,
      originalName: claim.rawName,
      event: 'claim_observed',
      claim: { issue: error.issue },
    });
    expect(records[0].process).toBeUndefined();
  });

  it.each(CHANNELS.flatMap(channel => ([
    { channel, mode: 'invalid' as const, issue: 'invalid' },
    { channel, mode: 'future' as const, issue: 'unsupported' },
  ])))('$channel records and rejects a $mode decoded process reference', async ({
    channel,
    mode,
    issue,
  }) => {
    const capture = liveCapture();
    if (mode === 'invalid') {
      capture.value = 'not-a-process-reference' as Captured['value'];
    } else {
      const reference = JSON.parse(capture.value) as Record<string, unknown>;
      capture.value = JSON.stringify({ ...reference, version: 2 }) as Captured['value'];
    }
    const claim = await seedClaim(channel, capture, { stale: true });

    const error = await unavailable(initialize(channel));

    expect(error.issue.kind).toBe(issue);
    expect(error.raw).toBe(claim.raw);
    expect(await mdFiles(claim.sourceDir)).toEqual([claim.rawName]);
    expect(await mdFiles(claim.pendingDir)).toEqual([]);
    const records = await observationRecords(channel);
    expect(records.map(record => record.event)).toEqual(['process_observed', 'decision']);
    const expectedFacts = { decoded: decodeProcessRef(capture.value) };
    expect(expectedFacts.decoded.kind).toBe(mode === 'invalid' ? 'invalid' : 'unsupported_version');
    expect(records[0].process).toEqual(expectedFacts);
    expect(records[1].process).toEqual(expectedFacts);
    expect(records[1].decision).toEqual({ kind: 'retain', reason: 'invalid_reference' });
    expect(records[1].claim).toEqual({ recordPath: claim.recordPath, raw: claim.raw });
  });

  it.each(CHANNELS)('%s reconciles reserved records alongside legacy filename formats', async channel => {
    const claim = await seedClaim(channel, uncaptured('unknown'), {
      originalName: 'new.md',
      content: 'new descriptor content',
      stale: true,
    });
    const legacy = channel === 'inbox'
      ? [
          { name: `${process.pid}_0_legacy.md`, content: 'legacy PID content' },
          { name: 'plain.md', content: 'legacy no-PID content' },
        ]
      : [
          { name: `cli_${process.pid}_abc123_legacy.md`, content: 'legacy PID content' },
          { name: 'cli_legacy_plain.md', content: 'legacy no-PID content' },
        ];
    const staleDate = new Date(NOW - STALE_MS);
    for (const item of legacy) {
      const legacyPath = path.join(claim.sourceDir, item.name);
      await fsAsync.writeFile(legacyPath, item.content, 'utf8');
      await fsAsync.utimes(legacyPath, staleDate, staleDate);
    }

    await initialize(channel);

    expect(await mdFiles(claim.sourceDir)).toEqual([]);
    expect(await mdFiles(claim.pendingDir)).toEqual(['legacy.md', 'new.md', 'plain.md']);
    expect(await fsAsync.readFile(claim.targetPath, 'utf8')).toBe('new descriptor content');
    expect(await fsAsync.readFile(path.join(claim.pendingDir, 'legacy.md'), 'utf8')).toBe('legacy PID content');
    expect(await fsAsync.readFile(path.join(claim.pendingDir, 'plain.md'), 'utf8')).toBe('legacy no-PID content');
    const records = await observationRecords(channel);
    expect(records.find(record => record.rawName === claim.rawName && record.event === 'decision'))
      .toMatchObject({ decision: { kind: 'reclaim', reason: 'lease_elapsed' } });
    if (channel === 'inbox') {
      expect(claim.sourceDir).toBe(path.join(root, 'custom-inbox', 'held-messages'));
      expect(claim.recordPath).toBe(`${claim.sourceDir}-claims/${CLAIM_ID}/record.json`);
    }
  });

  it.each(CHANNELS)('%s preserves both claim read and observation storage errors', async channel => {
    const claim = await seedClaim(channel, uncaptured('unknown'), { stale: true });
    const fs = makeFs();
    const read = fs.read.bind(fs);
    const writeAtomic = fs.writeAtomic.bind(fs);
    const readError = Object.assign(new Error(`${channel} descriptor EIO`), { code: 'EIO' });
    const storageError = new Error(`${channel} observation storage failed`);
    vi.spyOn(fs, 'read').mockImplementation(async targetPath => {
      if (targetPath === claim.recordPath) throw readError;
      return read(targetPath);
    });
    vi.spyOn(fs, 'writeAtomic').mockImplementation(async (targetPath, content) => {
      if (targetPath.includes('-observations') && content.includes('"event":"claim_observed"')) {
        throw storageError;
      }
      return writeAtomic(targetPath, content);
    });

    const error = await persistenceFailure(initialize(channel, fs));

    expect(error.originalClaimReadError).toBe(readError);
    expect(error.cause).toBe(storageError);
    expect(error.entry).toBe(claim.rawName);
    expect(error.pendingRecord).toMatchObject({
      rawName: claim.rawName,
      originalName: claim.rawName,
      event: 'claim_observed',
      claim: {
        recordPath: claim.recordPath,
        issue: { kind: 'io', code: 'EIO' },
      },
    });
    expect(await mdFiles(claim.sourceDir)).toEqual([claim.rawName]);
    expect(await mdFiles(claim.pendingDir)).toEqual([]);
  });

  it('active inbox drain turns an unavailable descriptor into claim partial_failure', async () => {
    const claim = await seedClaim('inbox', uncaptured('unknown'), {
      stale: true,
      writeRecord: false,
    });
    const fs = makeFs();
    const list = vi.spyOn(fs, 'list');
    const reader = makeReader('inbox', fs) as InboxReader;

    const result = await reader.drainAndDeliver();

    expect(result.kind).toBe('partial_failure');
    if (result.kind !== 'partial_failure') throw new Error('unreachable');
    expect(result.stage).toBe('claim');
    expect(result.entry).toBe(claim.rawName);
    expect(result.error).toBeInstanceOf(ClaimRecordUnavailableError);
    expect((result.error as ClaimRecordUnavailableError).issue.kind).toBe('missing');
    expect(result.entries).toEqual([]);
    expect(result.handles).toEqual([]);
    expect(list).not.toHaveBeenCalledWith(claim.pendingDir, { includeDirs: false });
    expect(await mdFiles(claim.sourceDir)).toEqual([claim.rawName]);
    expect(await mdFiles(claim.pendingDir)).toEqual([]);
  });

  it('active inbox drain turns observation persistence failure into claim partial_failure', async () => {
    const claim = await seedClaim('inbox', uncaptured('unknown'), { stale: false });
    const fs = makeFs();
    const writeAtomic = fs.writeAtomic.bind(fs);
    const list = vi.spyOn(fs, 'list');
    const storageError = new Error('active descriptor observation failed');
    vi.spyOn(fs, 'writeAtomic').mockImplementation(async (targetPath, content) => {
      if (targetPath.includes('-observations') && content.includes('"event":"claim_observed"')) {
        throw storageError;
      }
      return writeAtomic(targetPath, content);
    });
    const reader = makeReader('inbox', fs) as InboxReader;

    const result = await reader.drainAndDeliver();

    expect(result.kind).toBe('partial_failure');
    if (result.kind !== 'partial_failure') throw new Error('unreachable');
    expect(result.stage).toBe('claim');
    expect(result.entry).toBe(claim.rawName);
    expect(result.error).toBeInstanceOf(ClaimObservationPersistenceError);
    expect((result.error as ClaimObservationPersistenceError).cause).toBe(storageError);
    expect(result.entries).toEqual([]);
    expect(result.handles).toEqual([]);
    expect(list).not.toHaveBeenCalledWith(claim.pendingDir, { includeDirs: false });
    expect(await mdFiles(claim.sourceDir)).toEqual([claim.rawName]);
    expect(await mdFiles(claim.pendingDir)).toEqual([]);
  });
});
