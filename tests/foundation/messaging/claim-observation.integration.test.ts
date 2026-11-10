import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { InboxReader, OutboxReader } from '../../../src/foundation/messaging/index.js';
import { encodeInbox } from '../../../src/foundation/messaging/codec-inbox.js';
import type { ClaimRecord } from '../../../src/foundation/messaging/claim-observation-store.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import {
  decodeProcessRef,
  inspectProcessRef,
  type ProcessRef,
} from '../../../src/foundation/process-exec/index.js';
import { cleanupTempDir, createTrackedTempDir } from '../../utils/temp.js';

type Kind = 'inbox' | 'outbox';
type ReadyFile = {
  pid: number;
  files: { originalName: string; rawName: string; content: string }[];
};
type Holder = {
  child: ChildProcess;
  done: Promise<void>;
  result: { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };
  barrierDir: string;
  readyPath: string;
};

const START_TIME = 'Mon Jan 01 00:00:00 2020';
const START_HEX = Buffer.from(START_TIME).toString('hex');
const WAIT_LIMIT_MS = 30_000;
// Poll the atomic ready barrier without assuming child scheduling latency.
const WAIT_POLL_MS = 10;
const supported = process.platform === 'darwin' || process.platform === 'linux';
const noopAudit = { write: () => { /* silent: integration does not require audit */ } };
const HOLDER_SCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const scenario = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const files = [];
for (const item of scenario.items) {
  const rawName = scenario.kind === 'inbox'
    ? process.pid + '_' + item.startHex + '_' + item.originalName
    : 'cli_' + process.pid + '_' + item.startHex + '_abc123_' + item.originalName;
  fs.writeFileSync(path.join(scenario.sourceDir, rawName), item.content);
  files.push({ originalName: item.originalName, rawName, content: item.content });
}
const ready = { pid: process.pid, files };
const temporary = scenario.readyPath + '.' + process.pid + '.tmp';
fs.writeFileSync(temporary, JSON.stringify(ready));
fs.renameSync(temporary, scenario.readyPath);
const timer = setInterval(() => {
  if (!fs.existsSync(scenario.releasePath)) return;
  clearInterval(timer);
  process.exit(0);
}, 10);
`;

let tempDir: string;
let holders: Holder[];

beforeEach(async () => {
  tempDir = await createTrackedTempDir('messaging-claim-observation-');
  holders = [];
});

afterEach(async () => {
  for (const holder of holders) {
    if (holder.child.exitCode === null && holder.child.signalCode === null) {
      holder.child.kill('SIGKILL');
    }
  }
  await Promise.all(holders.map(holder => holder.done));
  await cleanupTempDir(tempDir);
});

function dirs(kind: Kind) {
  return kind === 'inbox'
    ? {
        sourceDir: path.join(tempDir, 'inbox', 'inflight'),
        pendingDir: path.join(tempDir, 'inbox', 'pending'),
        doneDir: path.join(tempDir, 'inbox', 'done'),
      }
    : {
        sourceDir: path.join(tempDir, 'outbox', 'processing'),
        pendingDir: path.join(tempDir, 'outbox', 'pending'),
        doneDir: path.join(tempDir, 'outbox', 'done'),
      };
}

function messageContent(id: string, body: string): string {
  return encodeInbox({
    id,
    type: 'message',
    from: 'integration',
    to: 'claw',
    content: body,
    priority: 'normal',
    timestamp: new Date().toISOString(),
  });
}

function startHolder(kind: Kind): Holder {
  const { sourceDir, pendingDir } = dirs(kind);
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.mkdirSync(pendingDir, { recursive: true });
  const barrierDir = path.join(tempDir, `barrier-${kind}`);
  fs.mkdirSync(barrierDir, { recursive: true });
  const items = [
    { originalName: 'zero.md', startHex: '0' },
    { originalName: 'start.md', startHex: START_HEX },
  ].map(item => ({
    ...item,
    content: messageContent(`${kind}-${item.originalName}`, `${kind}:${item.originalName}`),
  }));
  const scenarioPath = path.join(barrierDir, 'scenario.json');
  const readyPath = path.join(barrierDir, 'ready.json');
  const releasePath = path.join(barrierDir, 'release');
  fs.writeFileSync(scenarioPath, JSON.stringify({ kind, sourceDir, items, readyPath, releasePath }));
  const child = spawn(process.execPath, ['-e', HOLDER_SCRIPT, scenarioPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'test' },
  });
  const result: Holder['result'] = { code: null, signal: null, stdout: '', stderr: '' };
  child.stdout.on('data', (data: Buffer) => { result.stdout += data.toString(); });
  child.stderr.on('data', (data: Buffer) => { result.stderr += data.toString(); });
  const holder: Holder = {
    child,
    result,
    barrierDir,
    readyPath,
    done: new Promise<void>(resolve => {
      child.once('close', (code, signal) => {
        result.code = code;
        result.signal = signal;
        resolve();
      });
    }),
  };
  holders.push(holder);
  return holder;
}

function holderDetail(holder: Holder): string {
  return `pid=${holder.child.pid}; code=${holder.result.code}; signal=${holder.result.signal}\n` +
    `stdout=${holder.result.stdout}\nstderr=${holder.result.stderr}`;
}

async function waitForReady(holder: Holder): Promise<ReadyFile> {
  const deadline = Date.now() + WAIT_LIMIT_MS;
  for (;;) {
    if (fs.existsSync(holder.readyPath)) {
      return JSON.parse(fs.readFileSync(holder.readyPath, 'utf8')) as ReadyFile;
    }
    if (holder.result.code !== null || holder.result.signal !== null) {
      throw new Error(`holder exited before ready\n${holderDetail(holder)}`);
    }
    if (Date.now() >= deadline) throw new Error(`ready barrier timeout\n${holderDetail(holder)}`);
    await new Promise<void>(resolve => setTimeout(resolve, WAIT_POLL_MS));
  }
}

function releaseHolder(holder: Holder): void {
  const releasePath = path.join(holder.barrierDir, 'release');
  const temporary = `${releasePath}.tmp`;
  fs.writeFileSync(temporary, 'release');
  fs.renameSync(temporary, releasePath);
}

function makeReader(kind: Kind): InboxReader | OutboxReader {
  const { pendingDir, doneDir } = dirs(kind);
  const fileSystem = new NodeFileSystem({ baseDir: tempDir });
  return kind === 'inbox'
    ? new InboxReader(
        pendingDir,
        doneDir,
        path.join(tempDir, 'inbox', 'failed'),
        fileSystem,
        noopAudit,
      )
    : new OutboxReader(fileSystem, noopAudit);
}

async function initReader(kind: Kind): Promise<void> {
  if (kind === 'inbox') {
    await (makeReader(kind) as InboxReader).init();
  } else {
    await (makeReader(kind) as OutboxReader).init('.');
  }
}

function readRecords(kind: Kind): ClaimRecord[] {
  const root = `${dirs(kind).sourceDir}-observations`;
  if (!fs.existsSync(root)) return [];
  const records: ClaimRecord[] = [];
  const attempts = fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  for (const attempt of attempts) {
    const attemptDir = path.join(root, attempt);
    const names = fs.readdirSync(attemptDir)
      .filter(name => /^\d+\.json$/.test(name))
      .sort((left, right) => parseInt(left, 10) - parseInt(right, 10));
    for (const name of names) {
      const record = JSON.parse(fs.readFileSync(path.join(attemptDir, name), 'utf8')) as ClaimRecord;
      expect(JSON.parse(JSON.stringify(record))).toEqual(record);
      records.push(record);
    }
  }
  return records;
}

function assertCompleteFacts(records: ClaimRecord[]): void {
  const observations = records.filter(record => record.event === 'process_observed');
  expect(observations).toHaveLength(2);
  for (const observation of observations) {
    expect(observation.process?.observed?.kind).toBe('unknown');
    const decision = records.find(record =>
      record.event === 'decision'
      && record.attemptId === observation.attemptId
      && record.rawName === observation.rawName);
    expect(decision, JSON.stringify(records)).toBeDefined();
    expect(decision?.process).toEqual(observation.process);
    const decoded = observation.process?.decoded;
    expect(decoded?.kind).toBe('decoded');
    if (decoded?.kind === 'decoded') {
      expect(decodeProcessRef(decoded.value)).toEqual(decoded);
      expect(observation.process?.observed?.evidence).toBeDefined();
    }
  }
}

function mdFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter(name => name.endsWith('.md')).sort();
}

async function settleRecovered(kind: Kind, expected: ReadyFile['files']): Promise<void> {
  const { doneDir } = dirs(kind);
  if (kind === 'inbox') {
    const reader = makeReader(kind) as InboxReader;
    const drained = await reader.drainAndDeliver();
    expect(drained.kind).toBe('complete');
    expect(drained.entries).toHaveLength(2);
    for (const handle of drained.handles) await reader.ack(handle);
  } else {
    const reader = makeReader(kind) as OutboxReader;
    for (let count = 0; count < expected.length; count += 1) {
      const claimed = await reader.claimNext('.');
      expect(claimed.status).toBe('claimed');
      if (claimed.status !== 'claimed') throw new Error('expected outbox claim');
      const expectedFile = expected.find(file => file.originalName === claimed.filename);
      expect(expectedFile).toBeDefined();
      expect(claimed.content).toBe(expectedFile?.content);
      await reader.markDone('.', claimed.claimPath, claimed.filename);
    }
  }
  expect(mdFiles(doneDir)).toHaveLength(2);
}

async function exerciseRealHolder(kind: Kind): Promise<void> {
  const holder = startHolder(kind);
  const ready = await waitForReady(holder);
  expect(ready.pid).toBe(holder.child.pid);
  const { sourceDir, pendingDir } = dirs(kind);

  await initReader(kind);

  expect(mdFiles(pendingDir)).toEqual([]);
  for (const file of ready.files) {
    expect(fs.readFileSync(path.join(sourceDir, file.rawName), 'utf8')).toBe(file.content);
  }
  const liveRecords = readRecords(kind);
  expect(liveRecords).toHaveLength(4);
  assertCompleteFacts(liveRecords);
  const liveDecisions = liveRecords.filter(record => record.event === 'decision');
  expect(liveDecisions).toHaveLength(2);
  expect(liveDecisions.map(record => record.decision)).toEqual(expect.arrayContaining([
    { kind: 'retain', reason: 'lease_active' },
    { kind: 'retain', reason: 'unknown' },
  ]));
  const startRecord = liveRecords.find(record =>
    record.event === 'process_observed' && record.rawName.endsWith('_start.md'));
  const startDecoded = startRecord?.process?.decoded;
  expect(startDecoded?.kind).toBe('decoded');
  if (startDecoded?.kind !== 'decoded') throw new Error('missing live legacy reference');
  expect(inspectProcessRef(startDecoded.value)).toMatchObject({ kind: 'unknown' });

  releaseHolder(holder);
  await holder.done;
  expect(holder.result.code, holderDetail(holder)).toBe(0);
  expect(inspectProcessRef(startDecoded.value as ProcessRef)).toMatchObject({
    kind: 'gone',
    reason: 'absent',
  });

  await initReader(kind);

  expect(mdFiles(pendingDir)).toEqual(['start.md', 'zero.md']);
  expect(mdFiles(sourceDir)).toEqual([]);
  for (const file of ready.files) {
    expect(fs.readFileSync(path.join(pendingDir, file.originalName), 'utf8')).toBe(file.content);
  }
  const goneRecords = readRecords(kind);
  expect(goneRecords).toHaveLength(8);
  const newDecisions = goneRecords.filter(record =>
    record.event === 'decision' && !liveRecords.some(old =>
      old.attemptId === record.attemptId && old.sequence === record.sequence));
  expect(newDecisions).toHaveLength(2);
  expect(newDecisions.every(record =>
    record.decision?.kind === 'reclaim' && record.decision.reason === 'process_gone'
  )).toBe(true);
  for (const decision of newDecisions) {
    const observation = goneRecords.find(record =>
      record.event === 'process_observed'
      && record.attemptId === decision.attemptId
      && record.rawName === decision.rawName);
    expect(observation?.process?.observed).toMatchObject({ kind: 'gone', reason: 'absent' });
    expect(decision.process).toEqual(observation?.process);
  }

  // Evidence is not a recovery authorization cache and is retained across restart/settlement.
  await initReader(kind);
  expect(readRecords(kind)).toEqual(goneRecords);
  await settleRecovered(kind, ready.files);
  expect(readRecords(kind)).toEqual(goneRecords);
}

describe.skipIf(!supported)('Messaging legacy claim real process observations', () => {
  it('retains a live inbox holder, reclaims both legacy formats after close, and preserves content/evidence', async () => {
    await exerciseRealHolder('inbox');
  }, 60_000);

  it('retains a live outbox holder, reclaims both legacy formats after close, and preserves content/evidence', async () => {
    await exerciseRealHolder('outbox');
  }, 60_000);
});
