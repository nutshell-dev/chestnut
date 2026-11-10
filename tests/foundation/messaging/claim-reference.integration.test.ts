import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { InboxReader } from '../../../src/foundation/messaging/inbox-reader.js';
import type { ClaimDescriptor } from '../../../src/foundation/messaging/claim-record.js';
import { encodeInbox } from '../../../src/foundation/messaging/codec-inbox.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import {
  decodeProcessRef,
  inspectProcessRef,
  type ProcessRefCapture,
} from '../../../src/foundation/process-exec/index.js';
import { cleanupTempDir, createTrackedTempDir } from '../../utils/temp.js';

const CHANNEL = 'inbox';
type Channel = typeof CHANNEL;
type ReadyFile = {
  pid: number;
  claimName: string;
  recordPath: string;
  recordRaw: string;
  selfCapture: ProcessRefCapture;
};
type ChildResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};
type ChildHandle = {
  child: ChildProcess;
  result: ChildResult;
  done: Promise<void>;
  barrierDir: string;
};

const ORIGINAL_NAME = 'phase2096-消息-🌰.md';
const MESSAGE_ID = 'phase2096-real-claim';
const MESSAGE_BODY = 'first line\n中文与 🌰\n\nlast line with trailing newline\n';
const WAIT_LIMIT_MS = 30_000;
const WAIT_POLL_MS = 10;
const noopAudit = { write: () => { /* audit is outside this process integration */ } };

let bundleDir: string;
let fixtureBundle: string;
let tempDir: string;
let messageBytes: Buffer;
let children: ChildHandle[];

function resolveEsbuildBin(): string {
  const pnpmDir = path.resolve(process.cwd(), 'node_modules/.pnpm');
  const candidates = fs.readdirSync(pnpmDir).filter(name => name.startsWith('esbuild@')).sort();
  for (const candidate of candidates) {
    const bin = path.join(pnpmDir, candidate, 'node_modules/esbuild/bin/esbuild');
    if (fs.existsSync(bin)) return bin;
  }
  throw new Error('esbuild bin not found under node_modules/.pnpm');
}

function fixtureSource(): string {
  const inboxReader = path.resolve(process.cwd(), 'src/foundation/messaging/inbox-reader.ts');
  const nodeFs = path.resolve(process.cwd(), 'src/foundation/fs/node-fs.ts');
  const processExec = path.resolve(process.cwd(), 'src/foundation/process-exec/index.ts');
  return `
import * as fs from 'node:fs';
import * as path from 'node:path';
import { InboxReader } from ${JSON.stringify(inboxReader)};
import { NodeFileSystem } from ${JSON.stringify(nodeFs)};
import { captureCurrentProcessRef } from ${JSON.stringify(processExec)};

const scenario = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const readyPath = path.join(scenario.barrierDir, 'ready.json');
const releasePath = path.join(scenario.barrierDir, 'release');
const waitLimitMs = 30000;
const waitPollMs = 10;

async function waitForRelease() {
  const deadline = Date.now() + waitLimitMs;
  while (!fs.existsSync(releasePath)) {
    if (Date.now() >= deadline) throw new Error('release barrier timeout: ' + releasePath);
    await new Promise(resolve => setTimeout(resolve, waitPollMs));
  }
}

try {
  if (scenario.channel !== 'inbox') throw new Error('unsupported channel: ' + scenario.channel);
  const selfCapture = captureCurrentProcessRef();
  if (selfCapture.kind !== 'captured') {
    throw new Error('real current-process capture failed: ' + JSON.stringify(selfCapture));
  }
  const fileSystem = new NodeFileSystem({ baseDir: scenario.rootDir });
  const reader = new InboxReader(
    scenario.pendingDir,
    scenario.doneDir,
    scenario.failedDir,
    fileSystem,
    { write: () => { /* no audit sink needed in the child */ } },
    scenario.inflightDir,
  );
  const drained = await reader.drainAndDeliver();
  if (drained.kind !== 'complete') {
    throw new Error('drainAndDeliver failed: ' + JSON.stringify(drained) + '; error=' + String(drained.error));
  }
  if (drained.entries.length !== 1 || drained.handles.length !== 1) {
    throw new Error('expected one entry/handle: ' + JSON.stringify(drained));
  }
  const entry = drained.entries[0];
  const handle = drained.handles[0];
  if (entry.message.id !== scenario.messageId || entry.message.content !== scenario.messageBody) {
    throw new Error('delivered message changed: ' + JSON.stringify(entry.message));
  }
  if (handle.originalFileName !== scenario.originalName || handle.filePath !== entry.filePath) {
    throw new Error('entry/handle identity mismatch: ' + JSON.stringify({ entry, handle }));
  }
  const claimName = path.basename(handle.filePath);
  const match = /^mclaim_1_([0-9a-f-]+)\.md$/i.exec(claimName);
  if (match === null) throw new Error('production claim is not mclaim_1: ' + claimName);
  const recordPath = path.join(scenario.inflightDir + '-claims', match[1], 'record.json');
  const ready = {
    pid: process.pid,
    claimName,
    recordPath,
    recordRaw: fs.readFileSync(recordPath, 'utf8'),
    selfCapture,
  };
  const temporary = readyPath + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(ready));
  fs.renameSync(temporary, readyPath);
  await waitForRelease();
  process.stdout.write('CLAIM_HOLDER|ok\\n');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
`;
}

function dirs(channel: Channel) {
  switch (channel) {
    case 'inbox': {
      const base = path.join(tempDir, 'inbox');
      return {
        pendingDir: path.join(base, 'pending'),
        doneDir: path.join(base, 'done'),
        failedDir: path.join(base, 'failed'),
        inflightDir: path.join(base, 'inflight'),
      };
    }
  }
}

function makeReader(channel: Channel): InboxReader {
  const layout = dirs(channel);
  switch (channel) {
    case 'inbox':
      return new InboxReader(
        layout.pendingDir,
        layout.doneDir,
        layout.failedDir,
        new NodeFileSystem({ baseDir: tempDir }),
        noopAudit,
        layout.inflightDir,
      );
  }
}

function childDetail(holder: ChildHandle): string {
  return `pid=${holder.child.pid}; code=${holder.result.code}; signal=${holder.result.signal}\n`
    + `stdout=${holder.result.stdout}\nstderr=${holder.result.stderr}`;
}

function startHolder(channel: Channel): ChildHandle {
  const layout = dirs(channel);
  const barrierDir = path.join(tempDir, `barrier-${channel}`);
  fs.mkdirSync(barrierDir, { recursive: true });
  const scenarioPath = path.join(barrierDir, 'scenario.json');
  fs.writeFileSync(scenarioPath, JSON.stringify({
    channel,
    rootDir: tempDir,
    ...layout,
    barrierDir,
    originalName: ORIGINAL_NAME,
    messageId: MESSAGE_ID,
    messageBody: MESSAGE_BODY,
  }));
  const child = spawn(process.execPath, [fixtureBundle, scenarioPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'test' },
  });
  const result: ChildResult = { code: null, signal: null, stdout: '', stderr: '' };
  child.stdout.on('data', (data: Buffer) => { result.stdout += data.toString(); });
  child.stderr.on('data', (data: Buffer) => { result.stderr += data.toString(); });
  const holder: ChildHandle = {
    child,
    result,
    barrierDir,
    done: new Promise<void>(resolve => {
      child.once('close', (code, signal) => {
        result.code = code;
        result.signal = signal;
        resolve();
      });
    }),
  };
  children.push(holder);
  return holder;
}

async function waitForReady(holder: ChildHandle): Promise<ReadyFile> {
  const readyPath = path.join(holder.barrierDir, 'ready.json');
  const deadline = Date.now() + WAIT_LIMIT_MS;
  for (;;) {
    if (fs.existsSync(readyPath)) {
      return JSON.parse(fs.readFileSync(readyPath, 'utf8')) as ReadyFile;
    }
    if (holder.result.code !== null || holder.result.signal !== null) {
      throw new Error(`holder exited before ready\n${childDetail(holder)}`);
    }
    if (Date.now() >= deadline) throw new Error(`ready barrier timeout\n${childDetail(holder)}`);
    await new Promise<void>(resolve => setTimeout(resolve, WAIT_POLL_MS));
  }
}

function releaseHolder(holder: ChildHandle): void {
  const releasePath = path.join(holder.barrierDir, 'release');
  const temporary = `${releasePath}.tmp`;
  fs.writeFileSync(temporary, 'release');
  fs.renameSync(temporary, releasePath);
}

function mdFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => name.endsWith('.md')).sort();
}

function descriptorFrom(ready: ReadyFile): ClaimDescriptor {
  const descriptor = JSON.parse(ready.recordRaw) as ClaimDescriptor;
  expect(descriptor).toMatchObject({
    version: 1,
    channel: CHANNEL,
    originalName: ORIGINAL_NAME,
    claimName: ready.claimName,
  });
  return descriptor;
}

beforeAll(async () => {
  bundleDir = await createTrackedTempDir('messaging-claim-reference-build-');
  const fixtureSourcePath = path.join(bundleDir, 'claim-holder.ts');
  fixtureBundle = path.join(bundleDir, 'claim-holder.mjs');
  fs.writeFileSync(fixtureSourcePath, fixtureSource());
  execFileSync(resolveEsbuildBin(), [
    fixtureSourcePath,
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--target=node20',
    `--outfile=${fixtureBundle}`,
  ], { stdio: 'pipe' });
}, 60_000);

beforeEach(async () => {
  tempDir = await createTrackedTempDir('messaging-claim-reference-process-');
  children = [];
  messageBytes = Buffer.from(encodeInbox({
    id: MESSAGE_ID,
    type: 'message',
    from: 'phase2096-integration',
    to: 'claw',
    content: MESSAGE_BODY,
    priority: 'normal',
    timestamp: '2026-11-10T12:00:00.000Z',
    metadata: { trace: 'real-process-claim' },
  }));
  const layout = dirs(CHANNEL);
  fs.mkdirSync(layout.pendingDir, { recursive: true });
  fs.writeFileSync(path.join(layout.pendingDir, ORIGINAL_NAME), messageBytes);
});

afterEach(async () => {
  for (const holder of children) {
    if (holder.child.exitCode === null && holder.child.signalCode === null) {
      holder.child.kill('SIGKILL');
    }
  }
  await Promise.all(children.map(holder => holder.done));
  await cleanupTempDir(tempDir);
});

afterAll(async () => {
  await cleanupTempDir(bundleDir);
});

describe('Messaging mclaim real process reference', () => {
  it('retains a live inbox claim, then restores its original name, exact bytes, and record after normal exit', async () => {
    const layout = dirs(CHANNEL);
    const holder = startHolder(CHANNEL);
    const ready = await waitForReady(holder);
    expect(ready.pid).toBe(holder.child.pid);
    const claimPath = path.join(layout.inflightDir, ready.claimName);
    expect(mdFiles(layout.pendingDir)).toEqual([]);
    expect(mdFiles(layout.inflightDir)).toEqual([ready.claimName]);
    expect(fs.readFileSync(claimPath)).toEqual(messageBytes);
    const descriptor = descriptorFrom(ready);
    if (descriptor.capture.kind !== 'captured') {
      throw new Error(`production claim was not captured: ${ready.recordRaw}`);
    }
    const decoded = decodeProcessRef(descriptor.capture.value);
    expect(decoded.kind, JSON.stringify(decoded)).toBe('decoded');
    if (decoded.kind !== 'decoded') throw new Error(JSON.stringify(decoded));
    expect(JSON.parse(decoded.value)).toMatchObject({ pid: ready.pid });
    expect(inspectProcessRef(decoded.value)).toMatchObject({ kind: 'alive' });
    if (ready.selfCapture.kind !== 'captured') {
      throw new Error(`child self-capture was not captured: ${JSON.stringify(ready.selfCapture)}`);
    }
    const selfDecoded = decodeProcessRef(ready.selfCapture.value);
    expect(selfDecoded.kind, JSON.stringify(selfDecoded)).toBe('decoded');
    if (selfDecoded.kind !== 'decoded') throw new Error(JSON.stringify(selfDecoded));
    expect(JSON.parse(selfDecoded.value)).toMatchObject({
      pid: ready.pid,
      startTime: JSON.parse(decoded.value).startTime,
    });

    const liveInit = await makeReader(CHANNEL).init();
    expect(liveInit).toEqual({ kind: 'ready', recovered: 0 });
    expect(mdFiles(layout.pendingDir)).toEqual([]);
    expect(mdFiles(layout.inflightDir)).toEqual([ready.claimName]);
    expect(fs.readFileSync(claimPath)).toEqual(messageBytes);
    expect(fs.readFileSync(ready.recordPath, 'utf8')).toBe(ready.recordRaw);

    releaseHolder(holder);
    await holder.done;
    expect(holder.result.code, childDetail(holder)).toBe(0);
    expect(holder.result.signal, childDetail(holder)).toBeNull();
    expect(holder.result.stdout, childDetail(holder)).toContain('CLAIM_HOLDER|ok');
    expect(inspectProcessRef(decoded.value)).toMatchObject({ kind: 'gone', reason: 'absent' });

    const recoveredInit = await makeReader(CHANNEL).init();
    expect(recoveredInit).toEqual({ kind: 'ready', recovered: 1 });
    expect(mdFiles(layout.inflightDir)).toEqual([]);
    expect(mdFiles(layout.pendingDir)).toEqual([ORIGINAL_NAME]);
    expect(fs.readFileSync(path.join(layout.pendingDir, ORIGINAL_NAME))).toEqual(messageBytes);
    expect(fs.readFileSync(ready.recordPath, 'utf8')).toBe(ready.recordRaw);
    expect(descriptorFrom(ready)).toEqual(descriptor);
  }, 60_000);
});
