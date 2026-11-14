import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsAsync from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { encodeProcessEvidence } from '../../../src/foundation/process-exec/process-evidence.js';
import {
  ClaimObservationPersistenceError,
  type ClaimRecord,
} from '../../../src/foundation/messaging/claim-observation-store.js';
import type {
  RecoveryIoEvidence,
  RecoveryIoOperation,
} from '../../../src/foundation/messaging/recovery-io-evidence.js';
import {
  createInboxReader,
  createOutboxReader,
  type InboxInitResult,
  type OutboxInitResult,
} from '../../../src/foundation/messaging/index.js';
import { cleanupTempDir, createTrackedTempDir } from '../../utils/temp.js';

type Channel = 'inbox' | 'outbox';
type FaultOperation = 'list' | 'stat' | 'move' | 'read' | 'delete' | 'restore';
type AuditEvent = [string, ...unknown[]];

let root: string;
let clawRoot: string;
let fs: NodeFileSystem;

beforeEach(async () => {
  root = await createTrackedTempDir('recovery-io-evidence-');
  clawRoot = path.join(root, 'claw');
  fs = new NodeFileSystem({ baseDir: root });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempDir(root);
});

function makeAudit(): {
  audit: {
    write: (type: string, ...columns: unknown[]) => void;
    preview: (value: string) => string;
    message: (value: string) => string;
    summary: (value: string) => string;
  };
  events: AuditEvent[];
} {
  const events: AuditEvent[] = [];
  return {
    audit: {
      write: (type, ...columns) => { events.push([type, ...columns]); },
      preview: value => value,
      message: value => value,
      summary: value => value,
    },
    events,
  };
}

function dirs(channel: Channel): {
  sourceDir: string;
  pendingDir: string;
  rawName: string;
  originalName: string;
} {
  return channel === 'inbox'
    ? {
        sourceDir: path.join(clawRoot, 'inbox/inflight'),
        pendingDir: path.join(clawRoot, 'inbox/pending'),
        rawName: 'legacy.md',
        originalName: 'legacy.md',
      }
    : {
        sourceDir: path.join(clawRoot, 'outbox/processing'),
        pendingDir: path.join(clawRoot, 'outbox/pending'),
        rawName: 'cli_legacy_msg.md',
        originalName: 'msg.md',
      };
}

async function seedClaim(channel: Channel): Promise<string> {
  const layout = dirs(channel);
  await fsAsync.mkdir(layout.sourceDir, { recursive: true });
  const sourcePath = path.join(layout.sourceDir, layout.rawName);
  await fsAsync.writeFile(sourcePath, 'message content', 'utf8');
  const old = new Date(Date.now() - 600_000);
  await fsAsync.utimes(sourcePath, old, old);
  return sourcePath;
}

async function seedStage(channel: Channel): Promise<{ stagePath: string; targetPath: string }> {
  const layout = dirs(channel);
  await fsAsync.mkdir(layout.pendingDir, { recursive: true });
  const stagePath = path.join(layout.pendingDir, '.tmp_deadbeef_msg.md.staging');
  await fsAsync.writeFile(stagePath, 'message content', 'utf8');
  return { stagePath, targetPath: path.join(layout.pendingDir, 'msg.md') };
}

function init(channel: Channel, audit: ReturnType<typeof makeAudit>['audit']): Promise<InboxInitResult | OutboxInitResult> {
  return channel === 'inbox'
    ? createInboxReader(fs, audit, clawRoot).init()
    : createOutboxReader({ clawRoot, fs, audit }).init();
}

async function recoveryRecords(sourceDir: string): Promise<ClaimRecord[]> {
  const observationDir = `${sourceDir}-observations`;
  if (!existsSync(observationDir)) return [];
  const records: ClaimRecord[] = [];
  for (const entry of await fsAsync.readdir(observationDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const attemptDir = path.join(observationDir, entry.name);
    for (const name of await fsAsync.readdir(attemptDir)) {
      if (!name.endsWith('.json')) continue;
      const record = JSON.parse(await fsAsync.readFile(path.join(attemptDir, name), 'utf8')) as ClaimRecord;
      if (record.event === 'recovery_io') records.push(record);
    }
  }
  return records.sort((a, b) => a.atMs - b.atMs || a.sequence - b.sequence);
}

function expectCallerError(
  result: InboxInitResult | OutboxInitResult,
  error: unknown,
  stage: string,
  failurePath: string,
): void {
  expect(result.kind).toBe('degraded');
  if (result.kind !== 'degraded') throw new Error('unreachable');
  expect(result.error).toBe(error);
  expect(result.stage).toBe(stage);
  if ('path' in result) expect(result.path).toBe(failurePath);
}

async function expectEvidence(options: {
  channel: Channel;
  sourceDir?: string;
  events: AuditEvent[];
  error: unknown;
  operation: RecoveryIoOperation;
  stage: string;
  path: string;
  code: string;
  rawName?: string;
}): Promise<ClaimRecord> {
  const records = await recoveryRecords(options.sourceDir ?? dirs(options.channel).sourceDir);
  expect(records).toHaveLength(1);
  const record = records[0];
  expect(record.event).toBe('recovery_io');
  expect(record.recovery).toMatchObject({
    operation: options.operation,
    stage: options.stage,
    path: options.path,
    code: options.code,
  });
  expect(record.recovery?.error.facts).toEqual(encodeProcessEvidence(0, [options.error]).facts);
  if (options.rawName === undefined) {
    expect(record).not.toHaveProperty('rawName');
    expect(record).not.toHaveProperty('originalName');
  } else {
    expect(record.rawName).toBe(options.rawName);
  }
  const audit = options.events.find(event => event[0] === 'messaging_recovery_io_failed');
  expect(audit).toBeDefined();
  const column = String(audit?.[1]);
  expect(column.startsWith('evidence=')).toBe(true);
  const audited = JSON.parse(column.slice('evidence='.length)) as RecoveryIoEvidence;
  expect(audited).toEqual(record.recovery);
  return record;
}

describe.each<Channel>(['inbox', 'outbox'])('%s recovery I/O evidence', channel => {
  it('persists list failure without inventing a filename and preserves lossless thrown facts', async () => {
    const layout = dirs(channel);
    const cause = { detail: 'backend unavailable' } as { detail: string; parent?: unknown };
    const original = Object.assign(new Error('list failed', { cause }), {
      code: 'EIO',
      custom: { attempt: 3 },
    }) as Error & { self?: unknown };
    cause.parent = original;
    original.self = original;
    vi.spyOn(fs, 'list').mockImplementation(async targetPath => {
      if (targetPath === layout.sourceDir) throw original;
      return [];
    });
    const { audit, events } = makeAudit();

    const result = await init(channel, audit);

    expectCallerError(result, original, 'list', layout.sourceDir);
    await expectEvidence({
      channel,
      events,
      error: original,
      operation: 'list',
      stage: 'list',
      path: layout.sourceDir,
      code: 'EIO',
    });
  });

  it('returns stat failure and durably records operation/stat with the same path and code', async () => {
    const sourcePath = await seedClaim(channel);
    const original = Object.assign(new Error('stat denied'), { code: 'EACCES' });
    vi.spyOn(fs, 'stat').mockImplementation(async targetPath => {
      if (targetPath === sourcePath) throw original;
      throw new Error(`unexpected stat: ${targetPath}`);
    });
    const { audit, events } = makeAudit();

    const result = await init(channel, audit);

    expectCallerError(result, original, 'read', sourcePath);
    await expectEvidence({
      channel,
      events,
      error: original,
      operation: 'stat',
      stage: 'read',
      path: sourcePath,
      code: 'EACCES',
      rawName: dirs(channel).rawName,
    });
    expect(existsSync(path.join(dirs(channel).pendingDir, dirs(channel).originalName))).toBe(false);
  });

  it('returns the original move failure, records it, and can recover after restart', async () => {
    const sourcePath = await seedClaim(channel);
    const original = Object.assign(new Error('move EIO'), { code: 'EIO' });
    const realMove = fs.move.bind(fs);
    let injected = false;
    const move = vi.spyOn(fs, 'move').mockImplementation(async (from, to) => {
      if (!injected && from === sourcePath) {
        injected = true;
        throw original;
      }
      return realMove(from, to);
    });
    const { audit, events } = makeAudit();

    const result = await init(channel, audit);

    expectCallerError(result, original, 'move', sourcePath);
    const record = await expectEvidence({
      channel,
      events,
      error: original,
      operation: 'move',
      stage: 'move',
      path: sourcePath,
      code: 'EIO',
      rawName: dirs(channel).rawName,
    });
    expect(record.recovery?.sourcePath).toBe(sourcePath);
    expect(record.recovery?.targetPath).toMatch(/\.tmp_[0-9a-f]{8}_.+\.staging$/);
    expect(record.recovery?.completedActions).toEqual([]);
    move.mockRestore();
    const restarted = await init(channel, makeAudit().audit);
    expect(restarted).toEqual({ kind: 'ready', recovered: 1 });
    await expect(fsAsync.readFile(
      path.join(dirs(channel).pendingDir, dirs(channel).originalName),
      'utf8',
    )).resolves.toBe('message content');
  });

  it.each<FaultOperation>(['read', 'delete', 'restore'])(
    'persists staged %s failure before returning or throwing the original error',
    async operation => {
      const { stagePath, targetPath } = await seedStage(channel);
      const original = Object.assign(new Error(`${operation} failed`), { code: 'EIO' });
      const failurePath = operation === 'restore' ? targetPath : stagePath;
      if (operation === 'read') {
        const realRead = fs.read.bind(fs);
        vi.spyOn(fs, 'read').mockImplementation(async target => {
          if (target === stagePath) throw original;
          return realRead(target);
        });
      } else if (operation === 'delete') {
        const realDelete = fs.deleteSync.bind(fs);
        vi.spyOn(fs, 'deleteSync').mockImplementation(target => {
          if (target === stagePath) throw original;
          realDelete(target);
        });
      } else {
        const realPublish = fs.writeExclusiveSync.bind(fs);
        vi.spyOn(fs, 'writeExclusiveSync').mockImplementation((target, content) => {
          if (target === targetPath) throw original;
          realPublish(target, content);
        });
      }
      const { audit, events } = makeAudit();

      let thrown: unknown;
      let result: InboxInitResult | OutboxInitResult | undefined;
      try {
        result = await init(channel, audit);
      } catch (error) {
        thrown = error;
      }

      if (channel === 'inbox') expect(thrown).toBe(original);
      else expectCallerError(result!, original, operation === 'read' ? 'read' : 'move', failurePath);
      const record = await expectEvidence({
        channel,
        sourceDir: dirs(channel).pendingDir,
        events,
        error: original,
        operation,
        stage: channel === 'inbox'
          ? 'recover_stage'
          : operation === 'read' ? 'read' : 'move',
        path: failurePath,
        code: 'EIO',
        rawName: path.basename(stagePath),
      });
      expect(record.recovery?.sourcePath).toBe(operation === 'restore' ? stagePath : failurePath);
      expect(record.recovery?.targetPath).toBe(targetPath);
      expect(record.recovery?.completedActions).toEqual(
        operation === 'delete' ? ['stage_existing', 'publish'] : ['stage_existing'],
      );
    },
  );

  it('delivers both recovery and record-write errors and stops subsequent recovery', async () => {
    const layout = dirs(channel);
    const original = Object.assign(new Error('list EIO'), { code: 'EIO' });
    const storage = Object.assign(new Error('evidence write failed'), { code: 'ENOSPC' });
    vi.spyOn(fs, 'list').mockImplementation(async targetPath => {
      if (targetPath === layout.sourceDir) throw original;
      return [];
    });
    const realWrite = fs.writeAtomic.bind(fs);
    const write = vi.spyOn(fs, 'writeAtomic').mockImplementation(async (targetPath, content) => {
      if (content.includes('"event":"recovery_io"')) throw storage;
      return realWrite(targetPath, content);
    });
    const read = vi.spyOn(fs, 'read');
    const move = vi.spyOn(fs, 'move');
    const { audit, events } = makeAudit();

    let thrown: unknown;
    try {
      await init(channel, audit);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ClaimObservationPersistenceError);
    const failure = thrown as ClaimObservationPersistenceError;
    expect(failure.originalRecoveryError).toBe(original);
    expect(failure.cause).toBe(storage);
    expect(failure.originalStatError).toBeUndefined();
    expect(failure.pendingRecord.event).toBe('recovery_io');
    expect(failure.pendingRecord.recovery).toMatchObject({
      operation: 'list', stage: 'list', path: layout.sourceDir, code: 'EIO',
    });
    expect(failure.pendingRecord).not.toHaveProperty('rawName');
    expect(events.some(event => event[0] === 'messaging_recovery_io_failed')).toBe(true);
    expect(read).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('treats an ENOENT stat race as source absence, not a recovery I/O failure', async () => {
    const sourcePath = await seedClaim(channel);
    const original = Object.assign(new Error('source vanished'), { code: 'ENOENT' });
    vi.spyOn(fs, 'stat').mockImplementation(async targetPath => {
      if (targetPath === sourcePath) throw original;
      throw new Error(`unexpected stat: ${targetPath}`);
    });
    const { audit, events } = makeAudit();

    const result = await init(channel, audit);

    expect(result).toEqual({ kind: 'ready', recovered: 0 });
    expect(await recoveryRecords(dirs(channel).sourceDir)).toEqual([]);
    expect(events.some(event => event[0] === 'messaging_recovery_io_failed')).toBe(false);
    expect(events.some(event => event[0] === 'outbox_claim_failed')).toBe(false);
  });
});
