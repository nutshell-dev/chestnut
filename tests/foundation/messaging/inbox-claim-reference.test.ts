import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsAsync from 'node:fs/promises';
import * as path from 'node:path';
import { InboxReader } from '../../../src/foundation/messaging/inbox-reader.js';
import type { InboxDeliveryResult } from '../../../src/foundation/messaging/inbox-reader.js';
import { decodeInbox, encodeInbox } from '../../../src/foundation/messaging/codec-inbox.js';
import type { ClaimDescriptor } from '../../../src/foundation/messaging/claim-record.js';
import * as claimRecordStore from '../../../src/foundation/messaging/claim-record-store.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import * as processExec from '../../../src/foundation/process-exec/index.js';
import type { ProcessRef, ProcessRefCapture } from '../../../src/foundation/process-exec/index.js';
import type { InboxMessage } from '../../../src/foundation/messaging/types.js';
import { cleanupTempDir, createTrackedTempDir } from '../../utils/temp.js';

const CLAIM_NAME_RE = /^mclaim_1_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.md$/i;
const CAPTURE: ProcessRefCapture = {
  kind: 'captured',
  value: '{"version":0,"pid":123,"startTime":"fixture"}' as ProcessRef,
  evidence: {
    version: 1,
    atMs: 1_700_000_000_000,
    facts: [
      { operation: 'capture', outcome: 'fixture', nested: { retained: [true, null, 3] } },
      { id: 0, type: 'Buffer', properties: [], bytesBase64: 'AAE=' },
    ],
  },
};

let root: string;
let pendingDir: string;
let doneDir: string;
let failedDir: string;
let inflightDir: string;
let misroutedDir: string;
let fs: NodeFileSystem;
let reader: InboxReader;

beforeEach(async () => {
  root = await createTrackedTempDir('inbox-claim-reference-');
  pendingDir = path.join(root, 'inbox/pending');
  doneDir = path.join(root, 'inbox/done');
  failedDir = path.join(root, 'inbox/failed');
  inflightDir = path.join(root, 'custom/inflight-active');
  misroutedDir = path.join(root, 'custom/misrouted-active');
  await Promise.all(
    [pendingDir, doneDir, failedDir, inflightDir, misroutedDir]
      .map(dir => fsAsync.mkdir(dir, { recursive: true })),
  );
  fs = new NodeFileSystem({ baseDir: root });
  reader = new InboxReader(pendingDir, doneDir, failedDir, fs, {
    write() { /* noop */ },
  }, inflightDir, misroutedDir);
  vi.spyOn(processExec, 'captureCurrentProcessRef').mockReturnValue(CAPTURE);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempDir(root);
});

async function writeOriginal(
  originalName: string,
  id = 'message-1',
  timestamp = '2026-01-01T00:00:00.000Z',
): Promise<{ raw: string; message: InboxMessage; originalPath: string }> {
  const message: InboxMessage = {
    id,
    type: 'message',
    from: 'sender',
    to: 'receiver',
    content: '原文 body\n第二行',
    priority: 'normal',
    timestamp,
    metadata: { contract_id: 'contract-1', note: '元数据', hash: 'claim-hash' },
  };
  const raw = encodeInbox(message);
  const originalPath = path.join(pendingDir, originalName);
  await fsAsync.writeFile(originalPath, raw, 'utf8');
  return { raw, message, originalPath };
}

async function drainOne(): Promise<Extract<InboxDeliveryResult, { kind: 'complete' }>> {
  const result = await reader.drainAndDeliver();
  expect(result.kind).toBe('complete');
  if (result.kind !== 'complete') throw new Error('expected complete drain');
  expect(result.entries).toHaveLength(1);
  expect(result.handles).toHaveLength(1);
  return result;
}

async function readRecord(claimName: string): Promise<{
  claimId: string;
  recordPath: string;
  raw: string;
  descriptor: ClaimDescriptor;
}> {
  const claimId = CLAIM_NAME_RE.exec(claimName)?.[1];
  expect(claimId).toBeDefined();
  if (claimId === undefined) throw new Error(`invalid claim name: ${claimName}`);
  const recordPath = path.join(`${inflightDir}-claims`, claimId, 'record.json');
  const raw = await fsAsync.readFile(recordPath, 'utf8');
  return { claimId, recordPath, raw, descriptor: JSON.parse(raw) as ClaimDescriptor };
}

describe('InboxReader claim references', () => {
  it('drains a long Unicode original to a short mclaim name with complete durable evidence', async () => {
    const originalName = `消息-${'长'.repeat(60)}-🌰.md`;
    const { raw, message } = await writeOriginal(originalName);
    const before = Date.now();

    const drained = await drainOne();
    const after = Date.now();

    const handle = drained.handles[0];
    const claimName = path.basename(handle.filePath);
    expect(claimName).toMatch(CLAIM_NAME_RE);
    expect(Buffer.byteLength(claimName)).toBeLessThan(Buffer.byteLength(originalName));
    expect(handle.originalFileName).toBe(originalName);
    expect(drained.entries[0].filePath).toBe(handle.filePath);
    expect(drained.entries[0].message).toEqual(message);
    expect(drained.entries[0].message.metadata).toEqual({
      contract_id: 'contract-1', note: '元数据', hash: 'claim-hash',
    });
    await expect(fsAsync.readFile(handle.filePath, 'utf8')).resolves.toBe(raw);
    expect(decodeInbox(await fsAsync.readFile(handle.filePath, 'utf8'))).toEqual(message);

    const { claimId, recordPath, descriptor } = await readRecord(claimName);
    expect(recordPath).toBe(path.join(`${inflightDir}-claims`, claimId, 'record.json'));
    expect(descriptor).toEqual({
      version: 1,
      claimId,
      channel: 'inbox',
      originalName,
      claimName,
      createdAtMs: expect.any(Number),
      capture: CAPTURE,
    });
    expect(descriptor.createdAtMs).toBeGreaterThanOrEqual(before);
    expect(descriptor.createdAtMs).toBeLessThanOrEqual(after);
    expect(descriptor.capture).toEqual(CAPTURE);

    await expect(reader.findByExtraMeta('hash', 'claim-hash')).resolves.toEqual({
      file: claimName,
      location: 'inflight',
    });
    await expect(reader.peekUnsettled({
      type: 'message', from: 'sender', contractId: 'contract-1',
    })).resolves.toEqual([{ id: message.id, location: 'inflight' }]);
  });

  it.each(['ack', 'nack', 'defer', 'misroute'] as const)(
    '%s settles by original name and retains the claim record',
    async operation => {
      const originalName = `原-${operation}-消息.md`;
      const { raw } = await writeOriginal(originalName, `message-${operation}`);
      const drained = await drainOne();
      const handle = drained.handles[0];
      const claimName = path.basename(handle.filePath);
      const { recordPath, raw: recordRaw } = await readRecord(claimName);

      let settledPath: string;
      if (operation === 'ack') {
        await reader.ack(handle);
        const [settledName] = await fsAsync.readdir(doneDir);
        expect(settledName.endsWith(originalName)).toBe(true);
        settledPath = path.join(doneDir, settledName);
      } else if (operation === 'nack') {
        await reader.nack(handle, 'retry');
        settledPath = path.join(pendingDir, originalName);
      } else if (operation === 'defer') {
        await reader.defer(handle, 'budget');
        settledPath = path.join(pendingDir, originalName);
      } else {
        await reader.markMisrouted(handle);
        const [settledName] = await fsAsync.readdir(misroutedDir);
        expect(settledName.endsWith(originalName)).toBe(true);
        settledPath = path.join(misroutedDir, settledName);
      }

      expect(path.basename(settledPath).endsWith(originalName)).toBe(true);
      await expect(fsAsync.readFile(settledPath, 'utf8')).resolves.toBe(raw);
      await expect(fsAsync.readdir(inflightDir)).resolves.toEqual([]);
      await expect(fsAsync.readFile(recordPath, 'utf8')).resolves.toBe(recordRaw);
    },
  );

  it('keeps the first delivery and later pending entries unchanged when the second prepare fails', async () => {
    const first = await writeOriginal('01-first.md', 'first', '2026-01-01T00:00:01.000Z');
    const second = await writeOriginal('02-second.md', 'second', '2026-01-01T00:00:02.000Z');
    const third = await writeOriginal('03-third.md', 'third', '2026-01-01T00:00:03.000Z');
    const actualPrepare = claimRecordStore.prepareClaimRecord;
    const prepareError = new Error('second prepare failed');
    let prepareCalls = 0;
    const prepare = vi.spyOn(claimRecordStore, 'prepareClaimRecord').mockImplementation(async (...args) => {
      prepareCalls += 1;
      if (prepareCalls === 2) throw prepareError;
      return actualPrepare(...args);
    });

    const result = await reader.drainAndDeliver();

    expect(result.kind).toBe('partial_failure');
    if (result.kind !== 'partial_failure') throw new Error('expected partial failure');
    expect(result.stage).toBe('claim');
    expect(result.entry).toBe('02-second.md');
    expect(result.error).toBe(prepareError);
    expect(result.entries.map(entry => entry.message.id)).toEqual(['first']);
    expect(result.handles).toHaveLength(1);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare).toHaveBeenNthCalledWith(2, fs, inflightDir, 'inbox', '02-second.md');

    const firstHandle = result.handles[0];
    expect(firstHandle.originalFileName).toBe('01-first.md');
    await expect(fsAsync.readFile(firstHandle.filePath, 'utf8')).resolves.toBe(first.raw);
    await readRecord(path.basename(firstHandle.filePath));
    await expect(fsAsync.readdir(pendingDir)).resolves.toEqual(['02-second.md', '03-third.md']);
    await expect(fsAsync.readFile(second.originalPath, 'utf8')).resolves.toBe(second.raw);
    await expect(fsAsync.readFile(third.originalPath, 'utf8')).resolves.toBe(third.raw);
  });

  it('retains the prepared record and original pending bytes when move fails', async () => {
    const originalName = 'move-failure.md';
    const { raw, originalPath } = await writeOriginal(originalName);
    const moveError = Object.assign(new Error('move failed'), { code: 'EIO' });
    vi.spyOn(fs, 'move').mockRejectedValue(moveError);

    const result = await reader.drainAndDeliver();

    expect(result.kind).toBe('partial_failure');
    if (result.kind !== 'partial_failure') throw new Error('expected partial failure');
    expect(result.stage).toBe('move');
    expect(result.entry).toBe(originalName);
    expect(result.error).toBe(moveError);
    expect(result.entries).toEqual([]);
    expect(result.handles).toEqual([]);
    await expect(fsAsync.readFile(originalPath, 'utf8')).resolves.toBe(raw);
    await expect(fsAsync.readdir(inflightDir)).resolves.toEqual([]);

    const claimEntries = await fsAsync.readdir(`${inflightDir}-claims`, { withFileTypes: true });
    const claimDirectories = claimEntries.filter(entry => entry.isDirectory());
    expect(claimDirectories).toHaveLength(1);
    const recordPath = path.join(`${inflightDir}-claims`, claimDirectories[0].name, 'record.json');
    const descriptor = JSON.parse(await fsAsync.readFile(recordPath, 'utf8')) as ClaimDescriptor;
    expect(descriptor.originalName).toBe(originalName);
    expect(descriptor.claimName).toBe(`mclaim_1_${claimDirectories[0].name}.md`);
    expect(descriptor.capture).toEqual(CAPTURE);
  });
});
