import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import {
  ConfigRepairSessionError,
  createConfigRepairWorkspace,
  finishConfigRepairCase,
  runConfigRepairSession,
  startConfigRepairServer,
  type ConfigRepairServer,
  type ConfigRepairSessionResult,
  type ConfigRepairWorkspace,
} from '../helpers/config-repair-session.js';
import {
  captureExecutionTarget,
  terminateExecutionTarget,
} from '../../src/foundation/process-exec/index.js';
import { inspectRetention } from '../utils/resource-retention.js';
import { cleanupTempDir, createTrackedTempDirSync, untrackTempDir } from '../utils/temp.js';

const EXIT_WAIT_TIMEOUT_MS = 5_000;
const SESSION_TIMEOUT_TEST_MS = 1_000;
const EXIT_POLL_MS = 10;
const isolatedHosts: Array<{ host: string; runRoot: string }> = [];
const originalRunRoot = process.env.CHESTNUT_RUN_ROOT;

function useIsolatedRunRoot(): string {
  const host = createTrackedTempDirSync('config-repair-session-isolated-');
  const runRoot = path.join(host, 'run-root');
  isolatedHosts.push({ host, runRoot });
  fs.mkdirSync(runRoot);
  process.env.CHESTNUT_RUN_ROOT = runRoot;
  return runRoot;
}

function httpFixtureDirs(runRoot: string): string[] {
  return fs.readdirSync(runRoot)
    .filter(name => name.startsWith('config-repair-http-'))
    .map(name => path.join(runRoot, name));
}

function discardHttpFixtures(runRoot: string): void {
  for (const dir of httpFixtureDirs(runRoot)) {
    fs.rmSync(dir, { recursive: true, force: true });
    untrackTempDir(dir);
  }
}

async function postJson(baseUrl: string, model: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const request = http.request(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => { resolve(body); });
    });
    request.on('error', reject);
    request.end(JSON.stringify({ model }));
  });
}

function startHangingRequest(baseUrl: string): Promise<void> {
  const request = http.request(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  const settled = new Promise<void>(resolve => {
    request.on('error', () => { resolve(); });
    request.on('close', () => { resolve(); });
  });
  request.end(JSON.stringify({ model: 'hanging-model' }));
  return settled;
}

async function waitForRequest(server: ConfigRepairServer): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (server.requests.length === 0) {
    if (Date.now() >= deadline) throw new Error('HTTP fixture did not record the request');
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
}

async function expectPortRefused(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(1_000);
    socket.once('connect', () => { finish(new Error(`fixture port ${port} still accepts connections`)); });
    socket.once('timeout', () => { finish(new Error(`fixture port ${port} did not refuse promptly`)); });
    socket.once('error', error => {
      if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') finish();
      else finish(error);
    });
  });
}

async function reapIdentity(identity: { leaderPid: number; processGroupId: number }): Promise<void> {
  const capture = captureExecutionTarget(identity);
  if (!('target' in capture)) throw new Error(`controlled session identity cannot be reaped: ${capture.kind}`);
  const terminal = await terminateExecutionTarget(capture.target, 'caller_requested');
  if (terminal.status !== 'gone') {
    throw new Error(`controlled session did not reach a terminal state: ${terminal.status}`);
  }
}

async function reapControlledSession(
  workspace: ConfigRepairWorkspace,
  result: ConfigRepairSessionResult | undefined,
): Promise<void> {
  if (!result) throw new Error('controlled session has no result; preserving its workspace for manual reaping');
  const identities: Array<{ leaderPid: number; processGroupId: number }> = [];
  if (result.ready) {
    identities.push({ leaderPid: result.ready.pid, processGroupId: result.ready.processGroupId });
  } else {
    const readyFile = fs.readdirSync(workspace.root).find(name => name.startsWith('.session-ready-'));
    if (readyFile) {
      const ready = JSON.parse(fs.readFileSync(path.join(workspace.root, readyFile), 'utf8')) as {
        pid: number;
        processGroupId: number;
      };
      identities.push({ leaderPid: ready.pid, processGroupId: ready.processGroupId });
    }
  }
  let workerIdentityAvailable = identities.length > 0;
  if (!workerIdentityAvailable && result.execution.observation) {
    identities.push(result.execution.observation.target);
    workerIdentityAvailable = true;
  }
  if (!workerIdentityAvailable && result.execution.kind !== 'gone') {
    throw new Error('worker identity unavailable; refusing to discard controlled cwd');
  }
  let wrapperIdentityAvailable = false;
  if (result.wrapper.capture && 'target' in result.wrapper.capture) {
    identities.push(result.wrapper.capture.target);
    wrapperIdentityAvailable = true;
  }
  if (!wrapperIdentityAvailable) throw new Error('wrapper identity unavailable; refusing to discard controlled cwd');
  for (const identity of identities) await reapIdentity(identity);
}

function discardControlledWorkspace(workspace: ConfigRepairWorkspace): void {
  for (const dir of [workspace.root, workspace.home]) {
    fs.rmSync(dir, { recursive: true, force: true });
    untrackTempDir(dir);
  }
}

async function waitForExitFile(filePath: string): Promise<void> {
  const deadline = Date.now() + EXIT_WAIT_TIMEOUT_MS;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`finite child did not publish exit: ${filePath}`);
    await new Promise<void>(resolve => setTimeout(resolve, EXIT_POLL_MS));
  }
}

afterEach(async () => {
  if (originalRunRoot === undefined) delete process.env.CHESTNUT_RUN_ROOT;
  else process.env.CHESTNUT_RUN_ROOT = originalRunRoot;
  while (isolatedHosts.length > 0) {
    const { host, runRoot } = isolatedHosts.pop()!;
    untrackTempDir(host);
    const hasUnconfirmedWorkspace = fs.existsSync(runRoot) && fs.readdirSync(runRoot)
      .some(name => name.startsWith('chestnut-config-repair-integration-')
        || name.startsWith('config-repair-http-'));
    if (hasUnconfirmedWorkspace) {
      console.warn(`[test cleanup] Preserved controlled session host for independent reaping: ${host}`);
    } else {
      fs.rmSync(host, { recursive: true, force: true });
    }
  }
  await Promise.resolve();
});

describe('config repair HTTP fixture lifecycle', () => {
  it('closes a listener whose validated address cannot be delivered', async () => {
    const runRoot = useIsolatedRunRoot();
    const primary = new Error('controlled address delivery failure');
    let port: number | undefined;
    let closeConfirmed = false;
    try {
      const failure = await startConfigRepairServer({
        readAddress: server => {
          const address = server.address();
          if (address !== null && typeof address !== 'string') port = address.port;
          throw primary;
        },
      }).catch(error => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure.cause).toBe(primary);
      expect(port).toBeGreaterThan(0);
      await expectPortRefused(port!);
      closeConfirmed = true;
      const [fixtureDir] = httpFixtureDirs(runRoot);
      expect(fixtureDir).toBeDefined();
      expect(inspectRetention(runRoot, fixtureDir)).toMatchObject({
        kind: 'preserve', reasons: ['http_fixture_failed'],
      });
    } finally {
      if (closeConfirmed) discardHttpFixtures(runRoot);
    }
  });

  it('closes a real hanging request without waiting for the runner deadline', async () => {
    const runRoot = useIsolatedRunRoot();
    const server = await startConfigRepairServer();
    const [fixtureDir] = httpFixtureDirs(runRoot);
    server.setBehavior('hang');
    const clientClosed = startHangingRequest(server.baseUrl);
    try {
      await waitForRequest(server);
      await server.close();
      await clientClosed;
      expect(fs.existsSync(fixtureDir)).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('returns the same close settlement and completes its scope only once', async () => {
    const runRoot = useIsolatedRunRoot();
    const server = await startConfigRepairServer();
    const [fixtureDir] = httpFixtureDirs(runRoot);
    const first = server.close();
    const second = server.close();
    expect(second).toBe(first);
    await first;
    await second;
    expect(fs.existsSync(fixtureDir)).toBe(false);
    expect(inspectRetention(runRoot, fixtureDir)).toEqual({ kind: 'allow' });
  });

  it('resets only the in-memory view after persisting request history', async () => {
    const runRoot = useIsolatedRunRoot();
    const server = await startConfigRepairServer();
    const [fixtureDir] = httpFixtureDirs(runRoot);
    try {
      await postJson(server.baseUrl, 'persisted-before-reset');
      expect(server.requests).toHaveLength(1);
      server.resetRequests();
      expect(server.requests).toHaveLength(0);
      const history = fs.readFileSync(path.join(fixtureDir, 'requests.jsonl'), 'utf8')
        .trim().split('\n').map(line => JSON.parse(line) as { model?: string });
      expect(history.map(request => request.model)).toEqual(['persisted-before-reset']);
    } finally {
      await server.close();
    }
    expect(fs.existsSync(fixtureDir)).toBe(false);
  });

  it('records a request write failure before changing the observation view', async () => {
    const runRoot = useIsolatedRunRoot();
    const primary = new Error('controlled request JSONL write failure');
    const server = await startConfigRepairServer({
      appendRequest: () => { throw primary; },
    });
    const [fixtureDir] = httpFixtureDirs(runRoot);
    let closeConfirmed = false;
    try {
      await postJson(server.baseUrl, 'not-observed').catch(() => undefined);
      const failure = await server.close().catch(error => error);
      closeConfirmed = failure.evidence?.state === 'closed';
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure.cause).toBe(primary);
      expect(server.requests).toHaveLength(0);
      expect(fs.existsSync(path.join(fixtureDir, 'requests.jsonl'))).toBe(false);
      expect(inspectRetention(runRoot, fixtureDir)).toMatchObject({
        kind: 'preserve', reasons: ['http_fixture_failed'],
      });
    } finally {
      if (closeConfirmed) discardHttpFixtures(runRoot);
    }
  });

  it('aggregates retention publication failure without replacing the request failure', async () => {
    const runRoot = useIsolatedRunRoot();
    const primary = new Error('controlled request and retention failure');
    const server = await startConfigRepairServer({
      appendRequest: () => { throw primary; },
    });
    const [fixtureDir] = httpFixtureDirs(runRoot);
    const retentionPath = path.join(runRoot, 'test-resource-failures.jsonl');
    fs.rmSync(retentionPath);
    fs.mkdirSync(retentionPath);
    let closeConfirmed = false;
    try {
      await postJson(server.baseUrl, 'retention-failure').catch(() => undefined);
      const failure = await server.close().catch(error => error);
      closeConfirmed = failure.evidence?.state === 'closed';
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure.cause).toBe(primary);
      expect(failure.errors[0]).toBeInstanceOf(AggregateError);
      expect(failure.errors[0].cause).toBe(primary);
      expect(failure.errors.some((error: unknown) =>
        error instanceof Error && error.name === 'RetentionWriteError')).toBe(true);
      expect(fs.existsSync(fixtureDir)).toBe(true);
      expect(server.requests).toHaveLength(0);
    } finally {
      if (closeConfirmed) discardHttpFixtures(runRoot);
    }
  });

  it('cleans a successful server scope without completing a failed case scope', async () => {
    const runRoot = useIsolatedRunRoot();
    const server = await startConfigRepairServer();
    const [fixtureDir] = httpFixtureDirs(runRoot);
    const workspace = createConfigRepairWorkspace(server.baseUrl);
    const primary = new Error('controlled case failure with successful HTTP cleanup');
    const failure = await finishConfigRepairCase(workspace, async () => {
      await postJson(server.baseUrl, 'case-evidence');
      throw primary;
    }, { requests: () => server.requests }).catch(error => error);
    expect(failure).toBe(primary);
    await server.close();
    expect(fs.existsSync(fixtureDir)).toBe(false);
    expect(fs.existsSync(workspace.root)).toBe(true);
    expect(inspectRetention(runRoot, workspace.root)).toMatchObject({
      kind: 'preserve', reasons: ['test_failed'],
    });
    discardControlledWorkspace(workspace);
  });
});

describe('config repair session process lifecycle', () => {
  it('successful finite session cleans its scoped cwd', async context => {
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    expect(workspace.home.startsWith(`${workspace.root}${path.sep}`)).toBe(true);
    await finishConfigRepairCase(workspace, async () => {
      const result = await runConfigRepairSession(workspace, [], [], context.signal, false, {
        mode: 'finite', lifetimeMs: 50,
      });
      expect(result.execution.kind).toBe('gone');
      expect(result.ready?.pid).toBe(result.ready?.processGroupId);
      expect(fs.existsSync(result.exitedPath)).toBe(true);
    });
    expect(fs.existsSync(workspace.root)).toBe(false);
    expect(fs.existsSync(workspace.home)).toBe(false);
  });

  it('finite session supports spaces and quotes in its owned cwd', async context => {
    const host = createTrackedTempDirSync('config-repair-session-path-');
    const runRoot = path.join(host, "run root's nested");
    isolatedHosts.push({ host, runRoot });
    fs.mkdirSync(runRoot);
    process.env.CHESTNUT_RUN_ROOT = runRoot;
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    await finishConfigRepairCase(workspace, async () => {
      const result = await runConfigRepairSession(workspace, [], [], context.signal, false, {
        mode: 'finite', lifetimeMs: 50,
      });
      expect(result.execution.kind).toBe('gone');
      expect(result.ready?.cwd).toContain("run root's nested");
    });
    expect(fs.existsSync(workspace.root)).toBe(false);
  });

  it('pre-cancel does not spawn a process or invent an identity', async () => {
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    await finishConfigRepairCase(workspace, async () => {
      const controller = new AbortController();
      controller.abort(new Error('controlled pre-cancel'));
      const failure = await runConfigRepairSession(workspace, [], [], controller.signal, false, {
        mode: 'finite',
      }).catch(error => error);
      expect(failure).toBeInstanceOf(ConfigRepairSessionError);
      expect((failure as ConfigRepairSessionError).result.execution.kind).toBe('not_started');
      expect((failure as ConfigRepairSessionError).result.ready).toBeUndefined();
    });
  });

  it('runner cancellation waits for the real group terminal state', async () => {
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    await finishConfigRepairCase(workspace, async () => {
      const controller = new AbortController();
      const failure = await runConfigRepairSession(workspace, [], [], controller.signal, false, {
        mode: 'finite', lifetimeMs: 5_000,
        onReady: () => controller.abort(new Error('controlled runner cancellation')),
      }).catch(error => error);
      expect(failure).toBeInstanceOf(ConfigRepairSessionError);
      const result = (failure as ConfigRepairSessionError).result;
      expect(result.execution.kind).toBe('gone');
      expect(result.execution.termination?.status).toBe('gone');
      expect(result.ready?.pid).toBeGreaterThan(1);
    });
  });

  it('timeout preserves the first cause and confirms group exit', async () => {
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    await finishConfigRepairCase(workspace, async () => {
      const failure = await runConfigRepairSession(workspace, [], [], new AbortController().signal, false, {
        mode: 'finite', lifetimeMs: 5_000, timeoutMs: SESSION_TIMEOUT_TEST_MS,
      }).catch(error => error);
      expect(failure).toBeInstanceOf(ConfigRepairSessionError);
      expect((failure as Error).message).toContain('timed out');
      const result = (failure as ConfigRepairSessionError).result;
      expect(result.execution.kind).toBe('gone');
      expect(result.execution.termination?.status).toBe('gone');
    });
  });

  it('SIGKILL interruption has real group evidence without requiring fixture finally', async context => {
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    await finishConfigRepairCase(workspace, async () => {
      const result = await runConfigRepairSession(workspace, [], [], context.signal, false, {
        mode: 'finite', lifetimeMs: 5_000,
        onReady: ready => { process.kill(-ready.processGroupId, 'SIGKILL'); },
      });
      expect(result.execution.kind).toBe('gone');
      expect(fs.existsSync(result.exitedPath)).toBe(false);
    });
  });

  it('handshake read failure retains an unconfirmed worker instead of returning an unstructured error', async () => {
    const runRoot = useIsolatedRunRoot();
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    const fault = Object.assign(new Error('controlled ready read EIO'), { code: 'EIO' });
    let result: ConfigRepairSessionResult | undefined;
    try {
      const failure = await runConfigRepairSession(workspace, [], [], new AbortController().signal, false, {
        mode: 'finite', lifetimeMs: 30_000,
        readReady: () => { throw fault; },
      }).catch(error => error);
      expect(failure).toBeInstanceOf(ConfigRepairSessionError);
      const sessionFailure = failure as ConfigRepairSessionError;
      result = sessionFailure.result;
      expect(sessionFailure.cause).toBe(fault);
      expect(result.execution.kind).toBe('unconfirmed');
      expect(result.execution.capture).toBeUndefined();
      expect(result.wrapper.close.kind).toBe('closed');
      expect(fs.readFileSync(result.evidencePath, 'utf8')).toContain('controlled ready read EIO');
      expect(inspectRetention(runRoot, workspace.root)).toMatchObject({
        kind: 'preserve', reasons: ['unconfirmed_process_group'],
      });
    } finally {
      await reapControlledSession(workspace, result);
      discardControlledWorkspace(workspace);
      await cleanupTempDir(path.dirname(runRoot));
    }
  });

  it('onReady failure terminates the real worker before returning the original error', async () => {
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    await finishConfigRepairCase(workspace, async () => {
      const primary = new Error('controlled onReady failure');
      let identity: { leaderPid: number; processGroupId: number } | undefined;
      const failure = await runConfigRepairSession(workspace, [], [], new AbortController().signal, false, {
        mode: 'finite', lifetimeMs: 5_000,
        onReady: ready => {
          identity = { leaderPid: ready.pid, processGroupId: ready.processGroupId };
          throw primary;
        },
      }).catch(error => error);

      expect(failure).toBeInstanceOf(ConfigRepairSessionError);
      expect(failure.cause).toBe(primary);
      expect(failure.result.execution.kind).toBe('gone');
      expect(identity).toBeDefined();
      if (!identity) throw new Error('ready identity was not captured');
      expect(captureExecutionTarget(identity).kind).toBe('gone');
    });
  });

  it('wrapper exit records the violation, terminates the owned group, and only then releases its cwd', async () => {
    const runRoot = useIsolatedRunRoot();
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    let result: ConfigRepairSessionResult | undefined;
    try {
      const failure = await runConfigRepairSession(workspace, [], [], new AbortController().signal, false, {
        mode: 'orphan', lifetimeMs: 30_000,
      }).catch(error => error);
      expect(failure).toBeInstanceOf(ConfigRepairSessionError);
      result = (failure as ConfigRepairSessionError).result;
      expect(result.execution.kind).toBe('gone');
      expect(result.execution.termination?.status).toBe('gone');
      expect([result.firstStop, ...result.laterStops].some(stop =>
        stop?.reason.includes('wrapper closed before'))).toBe(true);
      expect(result.wrapper.close.kind).toBe('closed');
      expect(result.ready?.groupChildPid).toBeGreaterThan(1);
      expect(fs.existsSync(workspace.root)).toBe(true);
      await waitForExitFile(result.exitedPath);
    } finally {
      await reapControlledSession(workspace, result);
      discardControlledWorkspace(workspace);
      await cleanupTempDir(path.dirname(runRoot));
    }
  });

  it('abort after listener installation keeps the first cause and settles through the same cleanup', async () => {
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    await finishConfigRepairCase(workspace, async () => {
      const controller = new AbortController();
      const primary = new Error('controlled listener-window cancellation');
      const failure = await runConfigRepairSession(workspace, [], [], controller.signal, false, {
        mode: 'finite', lifetimeMs: 30_000,
        readReady: file => {
          const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
          controller.abort(primary);
          return raw;
        },
      }).catch(error => error);
      expect(failure).toBeInstanceOf(ConfigRepairSessionError);
      expect(failure.cause).toBe(primary);
      expect(failure.result.firstStop?.reason).toBe('session cancelled by caller');
      expect(failure.result.execution.kind).toBe('gone');
      expect(failure.result.attempts.filter(attempt =>
        attempt.resource === 'worker_group' && attempt.operation === 'terminate')).toHaveLength(1);
    });
  });

  it('unknown capture settles without waiting for the finite worker and never signals its group', async () => {
    const runRoot = useIsolatedRunRoot();
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    let result: ConfigRepairSessionResult | undefined;
    try {
      const failure = await runConfigRepairSession(workspace, [], [], new AbortController().signal, false, {
        mode: 'finite', lifetimeMs: 30_000,
        captureTarget: identity => {
          const captured = captureExecutionTarget(identity);
          if (captured.kind !== 'captured') throw new Error(`unexpected fixture capture: ${captured.kind}`);
          return { ...captured, kind: 'unknown', reason: 'controlled_unknown_capture' };
        },
      }).catch(error => error);
      expect(failure).toBeInstanceOf(ConfigRepairSessionError);
      result = (failure as ConfigRepairSessionError).result;
      expect(result.execution.kind).toBe('unconfirmed');
      expect(result.execution.capture?.kind).toBe('unknown');
      expect(result.execution.observation?.kind).toBe('alive');
      expect(result.execution.termination).toBeUndefined();
      expect(fs.existsSync(result.exitedPath)).toBe(false);
      expect(inspectRetention(runRoot, workspace.root)).toMatchObject({
        kind: 'preserve', reasons: ['unconfirmed_process_group'],
      });
    } finally {
      await reapControlledSession(workspace, result);
      discardControlledWorkspace(workspace);
      await cleanupTempDir(path.dirname(runRoot));
    }
  });

  it('real signal0 EPERM produces unknown rather than gone and retains the live worker', async () => {
    const runRoot = useIsolatedRunRoot();
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    const actualKill = process.kill.bind(process);
    let killSpy: ReturnType<typeof vi.spyOn> | undefined;
    let result: ConfigRepairSessionResult | undefined;
    try {
      const failure = await runConfigRepairSession(workspace, [], [], new AbortController().signal, false, {
        mode: 'finite', lifetimeMs: 30_000,
        readReady: file => {
          const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid: number };
          const fault = Object.assign(new Error('controlled signal0 EPERM'), { code: 'EPERM' });
          killSpy = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: NodeJS.Signals | 0) => {
            if (pid === raw.pid && signal === 0) throw fault;
            return actualKill(pid, signal);
          });
          return raw;
        },
      }).catch(error => error);
      expect(failure).toBeInstanceOf(ConfigRepairSessionError);
      result = (failure as ConfigRepairSessionError).result;
      expect(result.execution.capture?.kind).toBe('unknown');
      expect(result.execution.kind).toBe('unconfirmed');
      expect(result.execution.termination).toBeUndefined();
      expect(fs.existsSync(result.exitedPath)).toBe(false);
    } finally {
      killSpy?.mockRestore();
      await reapControlledSession(workspace, result);
      discardControlledWorkspace(workspace);
      await cleanupTempDir(path.dirname(runRoot));
    }
  });

  it('gone leader capture still observes a live group and does not authorize termination', async () => {
    const runRoot = useIsolatedRunRoot();
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    let result: ConfigRepairSessionResult | undefined;
    try {
      const failure = await runConfigRepairSession(workspace, [], [], new AbortController().signal, false, {
        mode: 'orphan', lifetimeMs: 30_000,
        captureTarget: identity => {
          const captured = captureExecutionTarget(identity);
          if (captured.kind !== 'captured') throw new Error(`unexpected fixture capture: ${captured.kind}`);
          const { target, evidence } = captured;
          return { kind: 'gone', target, evidence };
        },
      }).catch(error => error);
      expect(failure).toBeInstanceOf(ConfigRepairSessionError);
      result = (failure as ConfigRepairSessionError).result;
      expect(result.execution.capture?.kind).toBe('gone');
      expect(result.execution.observation?.kind).toBe('alive');
      expect(result.execution.termination).toBeUndefined();
      expect(result.execution.kind).toBe('unconfirmed');
    } finally {
      await reapControlledSession(workspace, result);
      discardControlledWorkspace(workspace);
      await cleanupTempDir(path.dirname(runRoot));
    }
  });

  it('onReady and worker termination failures retain both causes and complete wrapper cleanup', async () => {
    const runRoot = useIsolatedRunRoot();
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    const primary = new Error('controlled primary onReady failure');
    const cleanupFault = new Error('controlled worker termination failure');
    let result: ConfigRepairSessionResult | undefined;
    try {
      const failure = await runConfigRepairSession(workspace, [], [], new AbortController().signal, false, {
        mode: 'finite', lifetimeMs: 30_000,
        onReady: () => { throw primary; },
        terminateTarget: async () => { throw cleanupFault; },
      }).catch(error => error);
      expect(failure).toBeInstanceOf(ConfigRepairSessionError);
      expect(failure.cause).toBe(primary);
      result = (failure as ConfigRepairSessionError).result;
      expect(result.execution.kind).toBe('unconfirmed');
      expect(result.errors).toContainEqual({ operation: 'worker_group.terminate', error: cleanupFault });
      expect(result.wrapper.close.kind).toBe('closed');
      const evidence = fs.readFileSync(result.evidencePath, 'utf8');
      expect(evidence).toContain(primary.message);
      expect(evidence).toContain(cleanupFault.message);
    } finally {
      await reapControlledSession(workspace, result);
      discardControlledWorkspace(workspace);
      await cleanupTempDir(path.dirname(runRoot));
    }
  });

  it('handshake EIO and wrapper SIGTERM EPERM are both returned and persisted', async () => {
    const runRoot = useIsolatedRunRoot();
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    const readyFault = Object.assign(new Error('controlled handshake EIO'), { code: 'EIO' });
    const signalFault = Object.assign(new Error('controlled wrapper SIGTERM EPERM'), { code: 'EPERM' });
    const actualKill = process.kill.bind(process);
    let killSpy: ReturnType<typeof vi.spyOn> | undefined;
    let result: ConfigRepairSessionResult | undefined;
    try {
      const failure = await runConfigRepairSession(workspace, [], [], new AbortController().signal, false, {
        mode: 'finite', lifetimeMs: 30_000,
        readReady: () => { throw readyFault; },
        spawnPty: (command, env, cwd) => {
          const options = { cwd, env, stdio: 'pipe' as const, detached: true };
          const child = process.platform === 'darwin'
            ? spawn('script', ['-q', '/dev/null', ...command], options)
            : spawn('script', ['-qec', command.map(value =>
              `'${value.replaceAll("'", "'\\''")}'`).join(' '), '/dev/null'], options);
          if (child.pid === undefined) throw new Error('real PTY wrapper has no PID');
          const wrapperPid = child.pid;
          killSpy = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: NodeJS.Signals | 0) => {
            if (pid === -wrapperPid && signal === 'SIGTERM') throw signalFault;
            return actualKill(pid, signal);
          });
          return child;
        },
      }).catch(error => error);
      expect(failure).toBeInstanceOf(ConfigRepairSessionError);
      expect(failure.cause).toBe(readyFault);
      result = (failure as ConfigRepairSessionError).result;
      expect(result.execution.kind).toBe('unconfirmed');
      expect(result.wrapper.termination?.status).toBe('indeterminate');
      expect(result.wrapper.close.kind).toBe('unconfirmed');
      const evidence = fs.readFileSync(result.evidencePath, 'utf8');
      expect(evidence).toContain('EIO');
      expect(evidence).toContain('EPERM');
      expect(evidence).toContain('SIGTERM');
      expect(inspectRetention(runRoot, workspace.root)).toMatchObject({
        kind: 'preserve', reasons: ['unconfirmed_process_group'],
      });
    } finally {
      killSpy?.mockRestore();
      await reapControlledSession(workspace, result);
      discardControlledWorkspace(workspace);
      await cleanupTempDir(path.dirname(runRoot));
    }
  });

  it('retained publication failure aggregates the session snapshot without losing the first cause', async () => {
    const runRoot = useIsolatedRunRoot();
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    const recordingFault = new Error('controlled retained publication failure');
    const originalRetain = workspace.retention.retain;
    let result: ConfigRepairSessionResult | undefined;
    try {
      workspace.retention.retain = () => { throw recordingFault; };
      const failure = await runConfigRepairSession(workspace, [], [], new AbortController().signal, false, {
        mode: 'finite', lifetimeMs: 30_000,
        captureTarget: identity => {
          const captured = captureExecutionTarget(identity);
          if (captured.kind !== 'captured') throw new Error(`unexpected fixture capture: ${captured.kind}`);
          return { ...captured, kind: 'unknown', reason: 'controlled_unknown_for_retention_failure' };
        },
      }).catch(error => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure.errors[0]).toBeInstanceOf(ConfigRepairSessionError);
      expect(failure.errors.at(-1)).toBe(recordingFault);
      expect(failure.cause).toBe(failure.errors[0]);
      expect(failure.evidence.result.execution.capture.kind).toBe('unknown');
      result = failure.result as ConfigRepairSessionResult;
      expect(fs.existsSync(result.evidencePath)).toBe(true);
      expect(inspectRetention(runRoot, workspace.root)).toMatchObject({
        kind: 'preserve', reasons: ['scope_pending'],
      });
    } finally {
      workspace.retention.retain = originalRetain;
      await reapControlledSession(workspace, result);
      discardControlledWorkspace(workspace);
      await cleanupTempDir(path.dirname(runRoot));
    }
  });

  it('synchronous spawn failure returns not_started evidence without inventing a PID', async () => {
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    await finishConfigRepairCase(workspace, async () => {
      const primary = new Error('controlled synchronous spawn failure');
      const failure = await runConfigRepairSession(workspace, [], [], new AbortController().signal, false, {
        mode: 'finite', spawnPty: () => { throw primary; },
      }).catch(error => error);
      expect(failure).toBeInstanceOf(ConfigRepairSessionError);
      expect(failure.cause).toBe(primary);
      expect(failure.result.execution.kind).toBe('not_started');
      expect(failure.result.wrapper.close.kind).toBe('not_started');
      expect(failure.result.ready).toBeUndefined();
      expect(fs.readFileSync(failure.result.evidencePath, 'utf8')).toContain(primary.message);
    });
  });

  it('invalid capture finishes unconfirmed without observing or signalling an unverified target', async () => {
    const runRoot = useIsolatedRunRoot();
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    let result: ConfigRepairSessionResult | undefined;
    try {
      const failure = await runConfigRepairSession(workspace, [], [], new AbortController().signal, false, {
        mode: 'finite', lifetimeMs: 30_000,
        captureTarget: () => ({
          kind: 'invalid', reason: 'controlled_invalid_capture',
          evidence: { version: 1, atMs: Date.now(), facts: [] },
        }),
      }).catch(error => error);
      expect(failure).toBeInstanceOf(ConfigRepairSessionError);
      result = (failure as ConfigRepairSessionError).result;
      expect(result.execution.capture?.kind).toBe('invalid');
      expect(result.execution.observation).toBeUndefined();
      expect(result.execution.termination).toBeUndefined();
      expect(result.execution.kind).toBe('unconfirmed');
      expect(fs.existsSync(result.exitedPath)).toBe(false);
    } finally {
      await reapControlledSession(workspace, result);
      discardControlledWorkspace(workspace);
      await cleanupTempDir(path.dirname(runRoot));
    }
  });

  it('capture exceptions enter the same bounded cleanup and remain the first cause', async () => {
    const runRoot = useIsolatedRunRoot();
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    const primary = new Error('controlled capture exception');
    let result: ConfigRepairSessionResult | undefined;
    try {
      const failure = await runConfigRepairSession(workspace, [], [], new AbortController().signal, false, {
        mode: 'finite', lifetimeMs: 30_000,
        captureTarget: () => { throw primary; },
      }).catch(error => error);
      expect(failure).toBeInstanceOf(ConfigRepairSessionError);
      expect(failure.cause).toBe(primary);
      result = (failure as ConfigRepairSessionError).result;
      expect(result.execution.kind).toBe('unconfirmed');
      expect(result.errors).toContainEqual({ operation: 'worker_group.capture', error: primary });
      expect(result.execution.termination).toBeUndefined();
      expect(fs.existsSync(result.exitedPath)).toBe(false);
    } finally {
      await reapControlledSession(workspace, result);
      discardControlledWorkspace(workspace);
      await cleanupTempDir(path.dirname(runRoot));
    }
  });

  it.each(['still_alive', 'indeterminate'] as const)(
    'receiver preserves the complete %s termination outcome and retains the live worker',
    async terminationStatus => {
      const runRoot = useIsolatedRunRoot();
      const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
      let result: ConfigRepairSessionResult | undefined;
      try {
        const failure = await runConfigRepairSession(workspace, [], [], new AbortController().signal, false, {
          mode: 'finite', lifetimeMs: 30_000,
          onReady: () => { throw new Error(`force ${terminationStatus} cleanup`); },
          terminateTarget: async target => ({
            status: terminationStatus,
            identity: { leaderPid: target.leaderPid, processGroupId: target.processGroupId },
            trigger: 'caller_requested', termSent: true, killSent: true,
            checkedAt: new Date().toISOString(),
            ...(terminationStatus === 'indeterminate' ? { reason: 'controlled_indeterminate' } : {}),
            evidence: { version: 1, atMs: Date.now(), facts: [] },
          }),
        }).catch(error => error);
        expect(failure).toBeInstanceOf(ConfigRepairSessionError);
        result = (failure as ConfigRepairSessionError).result;
        expect(result.execution.termination).toMatchObject({
          status: terminationStatus, termSent: true, killSent: true,
        });
        expect(result.execution.observation?.kind).toBe('alive');
        expect(result.execution.kind).toBe('unconfirmed');
        expect(fs.existsSync(result.exitedPath)).toBe(false);
      } finally {
        await reapControlledSession(workspace, result);
        discardControlledWorkspace(workspace);
        await cleanupTempDir(path.dirname(runRoot));
      }
    },
  );

  it('ordinary assertion failure preserves repair evidence in the same scope', async () => {
    const runRoot = useIsolatedRunRoot();
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    const primary = new Error('controlled repair assertion failure');
    try {
      const homeSentinel = path.join(workspace.home, 'home-sentinel');
      const request = { model: 'retained-model', headers: { authorization: 'Bearer fixture-only' } };
      const failure = await finishConfigRepairCase(workspace, async () => {
        fs.writeFileSync(homeSentinel, 'still-owned-by-this-case');
        await Promise.resolve();
        throw primary;
      }, { requests: () => [request] }).catch(error => error);
      expect(failure).toBe(primary);
      expect(fs.existsSync(path.join(workspace.root, '.chestnut/llm/config.yaml'))).toBe(true);
      expect(fs.readFileSync(homeSentinel, 'utf8')).toBe('still-owned-by-this-case');
      expect(JSON.parse(fs.readFileSync(path.join(workspace.root, 'http-requests.json'), 'utf8')))
        .toEqual([request]);
      expect(inspectRetention(runRoot, workspace.root)).toMatchObject({
        kind: 'preserve', reasons: ['test_failed'],
      });
    } finally {
      discardControlledWorkspace(workspace);
      await cleanupTempDir(path.dirname(runRoot));
    }
  });

  it('workspace initialization failure retains both root and nested home', () => {
    const runRoot = useIsolatedRunRoot();
    const primary = new Error('controlled workspace initialization failure');
    let root: string | undefined;
    let home: string | undefined;
    try {
      const failure = (() => {
        try {
          createConfigRepairWorkspace('http://127.0.0.1:1/v1', undefined, {
            afterInitialize: (initializedRoot, initializedHome) => {
              root = initializedRoot;
              home = initializedHome;
              fs.writeFileSync(path.join(initializedHome, 'setup-sentinel'), 'retain-me');
              throw primary;
            },
          });
        } catch (error) {
          return error;
        }
      })();
      expect(failure).toBe(primary);
      expect(root).toBeDefined();
      expect(home?.startsWith(`${root}${path.sep}`)).toBe(true);
      expect(fs.readFileSync(path.join(home!, 'setup-sentinel'), 'utf8')).toBe('retain-me');
      expect(inspectRetention(runRoot, root)).toMatchObject({
        kind: 'preserve', reasons: ['fixture_setup_failed'],
      });
    } finally {
      if (root) {
        fs.rmSync(root, { recursive: true, force: true });
        untrackTempDir(root);
      }
    }
  });

  it('request snapshot failure is ordered after the business failure and prevents completion', async () => {
    const runRoot = useIsolatedRunRoot();
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    const primary = new Error('controlled primary before snapshot failure');
    try {
      fs.mkdirSync(path.join(workspace.root, 'http-requests.json'));
      const failure = await finishConfigRepairCase(workspace, async () => {
        throw primary;
      }, { requests: () => [] }).catch(error => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure.cause).toBe(primary);
      expect(failure.errors[0]).toBe(primary);
      expect(failure.errors[1]).toMatchObject({ code: 'EISDIR' });
      expect(inspectRetention(runRoot, workspace.root)).toMatchObject({
        kind: 'preserve', reasons: ['test_failed'],
      });
    } finally {
      discardControlledWorkspace(workspace);
      await cleanupTempDir(path.dirname(runRoot));
    }
  });
});
