import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsAsync from 'node:fs/promises';
import * as path from 'node:path';
import {
  createOutboxReader,
  OutboxClaimBindingError,
  OutboxMoveFailed,
  OutboxSettlementRequired,
  type OutboxClaimHandle,
  type OutboxReader,
} from '../../../src/foundation/messaging/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { cleanupTempDir, createTrackedTempDir } from '../../utils/temp.js';

const noopAudit = { write: () => undefined };

async function mdFiles(dir: string): Promise<string[]> {
  try {
    return (await fsAsync.readdir(dir)).filter(name => name.endsWith('.md')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

describe('OutboxReader bound settlement and failed recovery', () => {
  let root: string;
  let clawRoot: string;
  let pendingDir: string;
  let processingDir: string;
  let failedDir: string;
  let fs: NodeFileSystem;
  let reader: OutboxReader;
  let events: Array<[string, ...unknown[]]>;

  beforeEach(async () => {
    root = await createTrackedTempDir('outbox-settlement-');
    clawRoot = path.join(root, 'claw-a');
    pendingDir = path.join(clawRoot, 'outbox/pending');
    processingDir = path.join(clawRoot, 'outbox/processing');
    failedDir = path.join(clawRoot, 'outbox/failed');
    await fsAsync.mkdir(pendingDir, { recursive: true });
    await fsAsync.writeFile(path.join(pendingDir, 'message.md'), 'message body', 'utf8');
    fs = new NodeFileSystem({ baseDir: root });
    events = [];
    reader = createOutboxReader({
      clawRoot,
      fs,
      audit: { write: (event, ...cols) => { events.push([event, ...cols]); } },
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(root);
  });

  async function claim(): Promise<Extract<Awaited<ReturnType<OutboxReader['claimNext']>>, { status: 'claimed' }>> {
    const result = await reader.claimNext();
    expect(result.status).toBe('claimed');
    if (result.status !== 'claimed') throw new Error('expected claim');
    return result;
  }

  it('rejects cross-reader, cross-root, clone, and bare-path settlement without moving the claim', async () => {
    const claimed = await claim();
    const otherRoot = path.join(root, 'claw-b');
    await fsAsync.mkdir(path.join(otherRoot, 'outbox/pending'), { recursive: true });
    await fsAsync.writeFile(path.join(otherRoot, 'outbox/pending/sentinel.md'), 'untouched');
    const sameRootReader = createOutboxReader({ clawRoot, fs, audit: noopAudit });
    const otherRootReader = createOutboxReader({ clawRoot: otherRoot, fs, audit: noopAudit });
    const clone = { ...claimed } as OutboxClaimHandle;
    const bare = { claimPath: claimed.claimPath, filename: claimed.filename } as OutboxClaimHandle;

    await expect(sameRootReader.markDone(claimed)).rejects.toBeInstanceOf(OutboxClaimBindingError);
    await expect(otherRootReader.markFailed(claimed, new Error('foreign'))).rejects.toBeInstanceOf(OutboxClaimBindingError);
    await expect(reader.markSkipped(clone)).rejects.toBeInstanceOf(OutboxClaimBindingError);
    await expect(clone.markSkipped()).rejects.toBeInstanceOf(OutboxClaimBindingError);
    await expect(reader.markDone(bare)).rejects.toBeInstanceOf(OutboxClaimBindingError);

    await expect(fsAsync.readFile(path.join(clawRoot, claimed.claimPath), 'utf8')).resolves.toBe('message body');
    await expect(fsAsync.readFile(path.join(otherRoot, 'outbox/pending/sentinel.md'), 'utf8')).resolves.toBe('untouched');
    expect(await mdFiles(processingDir)).toEqual([path.basename(claimed.claimPath)]);
  });

  it('rejects repeated settlement and permits only one concurrent settler', async () => {
    const claimed = await claim();
    const first = await Promise.allSettled([claimed.markDone(), claimed.markSkipped()]);
    expect(first.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(first.filter(result => result.status === 'rejected')).toHaveLength(1);
    await fsAsync.writeFile(path.join(clawRoot, claimed.claimPath), 'must not be moved');
    await expect(claimed.markDone()).rejects.toBeInstanceOf(OutboxClaimBindingError);
    await expect(fsAsync.readFile(path.join(clawRoot, claimed.claimPath), 'utf8'))
      .resolves.toBe('must not be moved');
    expect(await mdFiles(path.join(clawRoot, 'outbox/done'))).toHaveLength(1);
    expect(await mdFiles(processingDir)).toEqual([path.basename(claimed.claimPath)]);
  });

  it('surfaces settlement failure after the processing directory is deleted', async () => {
    const claimed = await claim();
    await fsAsync.rm(processingDir, { recursive: true });

    await expect(claimed.markDone()).rejects.toBeInstanceOf(OutboxMoveFailed);
    expect(await mdFiles(path.join(clawRoot, 'outbox/done'))).toEqual([]);
  });

  it('settles processing to failed and atomically persists the original reason', async () => {
    const claimed = await claim();
    const consumeError = new Error('consumer exploded');

    await claimed.markFailed(consumeError);

    expect(await mdFiles(processingDir)).toEqual([]);
    const failedMessages = await mdFiles(failedDir);
    expect(failedMessages).toHaveLength(1);
    const reasonFiles = (await fsAsync.readdir(failedDir)).filter(name => name.endsWith('.reason.json'));
    expect(reasonFiles).toHaveLength(1);
    const record = JSON.parse(await fsAsync.readFile(path.join(failedDir, reasonFiles[0]), 'utf8')) as {
      reason: string;
      claim_path: string;
      original_filename: string;
    };
    expect(record).toMatchObject({
      reason: 'consumer exploded',
      claim_path: claimed.claimPath,
      original_filename: claimed.filename,
    });
    expect(events.some(event => event[0] === 'outbox_failed' && String(event).includes('reason=consumer exploded'))).toBe(true);
    const restarted = createOutboxReader({ clawRoot, fs, audit: noopAudit });
    await expect(restarted.init()).resolves.toEqual({ kind: 'ready', recovered: 0 });
    await expect(restarted.claimNext()).resolves.toEqual({ status: 'empty' });
  });

  it('throws settlement_required with both errors when reason persistence fails', async () => {
    const claimed = await claim();
    const consumeError = new Error('consume failed');
    const persistenceError = new Error('reason write failed');
    vi.spyOn(fs, 'writeAtomicExisting').mockRejectedValue(persistenceError);

    const error = await claimed.markFailed(consumeError).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OutboxSettlementRequired);
    expect(error).toMatchObject({
      status: 'settlement_required',
      claimPath: claimed.claimPath,
      filename: claimed.filename,
      error: consumeError,
      settlementError: persistenceError,
    });
    expect(await mdFiles(processingDir)).toEqual([path.basename(claimed.claimPath)]);
    expect(events.some(event => event[0] === 'outbox_failed')).toBe(false);
    expect(events.some(event =>
      event[0] === 'outbox_settlement_failed'
      && String(event).includes('reason=consume failed')
      && String(event).includes('settlement_reason=reason write failed')
    )).toBe(true);
  });
});
