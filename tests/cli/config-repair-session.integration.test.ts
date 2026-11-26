import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
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
  type ExecutionTargetCapture,
} from '../../src/foundation/process-exec/index.js';
import { inspectRetention } from '../utils/resource-retention.js';
import { cleanupTempDir, createTrackedTempDirSync, untrackTempDir } from '../utils/temp.js';

const EXIT_WAIT_TIMEOUT_MS = 5_000;
const SESSION_TIMEOUT_TEST_MS = 1_000;
const EXIT_POLL_MS = 10;
const HTTP_REQUEST_WAIT_TIMEOUT_MS = 5_000;
const HTTP_REQUEST_POLL_MS = 10;
const HTTP_PORT_REFUSED_TIMEOUT_MS = 1_000;
const EXTERNAL_CONSUMER_TIMEOUT_MS = 10_000;
const RECLAIM_STALE_AGE_MS = 11 * 60 * 1000;
// Finite lifetime for detached startup-error fixtures; independent cleanup must finish first.
const DETACHED_CHILD_LIFETIME_MS = 30_000;
const LATE_PROMPT_GUARD_TIMEOUT_MS = 5_000;
const CONTROLLED_INPUT_GUARD_TIMEOUT_MS = 5_000;
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

function externalGlobalSetupModuleUrl(runRoot: string): string {
  const configDir = path.join(runRoot, '.config');
  const utilsDir = path.join(runRoot, 'tests', 'utils');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(utilsDir, { recursive: true });
  const globalSetup = fs.readFileSync(
    path.resolve(__dirname, '../../.config/vitest-global-setup.ts'), 'utf8',
  ).replace('../tests/utils/resource-retention.js', '../tests/utils/resource-retention.ts');
  fs.writeFileSync(path.join(configDir, 'vitest-global-setup.ts'), globalSetup);
  fs.copyFileSync(
    path.resolve(__dirname, '../utils/resource-retention.ts'),
    path.join(utilsDir, 'resource-retention.ts'),
  );
  return pathToFileURL(path.join(configDir, 'vitest-global-setup.ts')).href;
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
  const deadline = Date.now() + HTTP_REQUEST_WAIT_TIMEOUT_MS;
  while (server.requests.length === 0) {
    if (Date.now() >= deadline) throw new Error('HTTP fixture did not record the request');
    await new Promise<void>(resolve => setTimeout(resolve, HTTP_REQUEST_POLL_MS));
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
    socket.setTimeout(HTTP_PORT_REFUSED_TIMEOUT_MS);
    socket.once('connect', () => { finish(new Error(`fixture port ${port} still accepts connections`)); });
    socket.once('timeout', () => { finish(new Error(`fixture port ${port} did not refuse promptly`)); });
    socket.once('error', error => {
      if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') finish();
      else finish(error);
    });
  });
}

async function reapIdentity(identity: { leaderPid: number; processGroupId: number }): Promise<void> {
  const callerPgid = (process as NodeJS.Process & { pgid?: number }).pgid;
  if (identity.leaderPid === process.pid || identity.processGroupId === process.pid
    || identity.leaderPid === callerPgid || identity.processGroupId === callerPgid) {
    throw new Error(`Refusing independent reaper access to the caller's own group: ${JSON.stringify(identity)}`);
  }
  const capture = captureExecutionTarget(identity);
  if (capture.kind === 'gone') return;
  if (!('target' in capture)) throw new Error(`controlled session identity cannot be reaped: ${capture.kind}`);
  const terminal = await terminateExecutionTarget(capture.target, 'caller_requested');
  if (terminal.status === 'gone') return;

  const confirmed = captureExecutionTarget(identity);
  if (confirmed.kind === 'gone') return;
  if (confirmed.kind !== 'captured') {
    throw new AggregateError([terminal, confirmed], 'Independent reaper could not reconfirm the owned target');
  }
  try {
    process.kill(identity.leaderPid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  const deadline = Date.now() + EXIT_WAIT_TIMEOUT_MS;
  for (;;) {
    const current = captureExecutionTarget(identity);
    if (current.kind === 'gone') return;
    if (Date.now() >= deadline) {
      throw new AggregateError([terminal, current], 'Independent reaper did not confirm group exit');
    }
    await new Promise<void>(resolve => setTimeout(resolve, EXIT_POLL_MS));
  }
}

function indeterminateTermination(
  target: Parameters<typeof terminateExecutionTarget>[0],
  reason: string,
) {
  return {
    status: 'indeterminate' as const,
    identity: { leaderPid: target.leaderPid, processGroupId: target.processGroupId },
    trigger: 'caller_requested' as const,
    termSent: true,
    killSent: true,
    checkedAt: new Date().toISOString(),
    reason,
    evidence: { version: 1 as const, atMs: Date.now(), facts: [] },
  };
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
    const sidecar = path.join(workspace.root, 'worker-identity.json');
    const readyFile = fs.readdirSync(workspace.root).find(name => name.startsWith('.session-ready-'));
    const identityFile = fs.existsSync(sidecar)
      ? sidecar
      : readyFile ? path.join(workspace.root, readyFile) : undefined;
    if (identityFile) {
      const ready = JSON.parse(fs.readFileSync(identityFile, 'utf8')) as {
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

type ControlledSessionTimerKind = 'work' | 'answer';
type ControlledSessionTimerEvent = Readonly<{
  sequence: number;
  action: 'schedule' | 'cancel' | 'fire' | 'fire-ignored';
  kind: ControlledSessionTimerKind;
  delayMs?: number;
}>;

function createSessionTimerController(logPath: string) {
  const timers: Array<{
    kind: ControlledSessionTimerKind;
    callback: () => void;
    active: boolean;
    cancelled: boolean;
    fired: number;
  }> = [];
  const events: ControlledSessionTimerEvent[] = [];
  fs.writeFileSync(logPath, '');
  const record = (event: ControlledSessionTimerEvent): void => {
    events.push(event);
    fs.appendFileSync(logPath, `${JSON.stringify(event)}\n`);
  };
  return {
    events,
    entry(kind: ControlledSessionTimerKind) {
      return timers.find(timer => timer.kind === kind);
    },
    registrations(kind: ControlledSessionTimerKind): number {
      return events.filter(event => event.action === 'schedule' && event.kind === kind).length;
    },
    schedule(kind: ControlledSessionTimerKind, callback: () => void, delayMs: number): () => void {
      const timer = { kind, callback, active: true, cancelled: false, fired: 0 };
      timers.push(timer);
      record({ sequence: events.length, action: 'schedule', kind, delayMs });
      let cancelCalled = false;
      return () => {
        if (cancelCalled) return;
        cancelCalled = true;
        if (timer.active) {
          timer.active = false;
          timer.cancelled = true;
        }
        record({ sequence: events.length, action: 'cancel', kind });
      };
    },
    fire(kind: ControlledSessionTimerKind): boolean {
      const timer = timers.find(candidate => candidate.kind === kind);
      if (!timer?.active) {
        record({ sequence: events.length, action: 'fire-ignored', kind });
        return false;
      }
      timer.active = false;
      timer.fired += 1;
      record({ sequence: events.length, action: 'fire', kind });
      timer.callback();
      return true;
    },
  };
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

  it('keeps stdout and stderr emitted during termination through final evidence', async () => {
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    await finishConfigRepairCase(workspace, async () => {
      const primary = new Error('controlled stop for final output');
      const failure = await runConfigRepairSession(workspace, [], [], new AbortController().signal, false, {
        mode: 'final-output', lifetimeMs: 30_000,
        onReady: () => { throw primary; },
        spawnPty: (command, env, cwd) => spawn(command[0], command.slice(1), {
          cwd, env, detached: true, stdio: 'pipe',
        }),
      }).catch(error => error);
      expect(failure).toBeInstanceOf(ConfigRepairSessionError);
      expect(failure.cause).toBe(primary);
      expect(failure.result.execution.kind).toBe('gone');
      expect(failure.result.wrapper.close.kind).toBe('closed');
      expect(failure.result.stdout).toContain('FINAL_STDOUT_SENTINEL');
      expect(failure.result.stderr).toContain('FINAL_STDERR_SENTINEL');
      const evidence = fs.readFileSync(failure.result.evidencePath, 'utf8');
      expect(evidence).toContain('FINAL_STDOUT_SENTINEL');
      expect(evidence).toContain('FINAL_STDERR_SENTINEL');
    });
  });

  it('consumes one prompt occurrence only once even when later noise changes the tail', async () => {
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    await finishConfigRepairCase(workspace, async () => {
      const failure = await runConfigRepairSession(workspace, [], [
        { prompt: /PROMPT>/, value: 'first' },
        { prompt: /PROMPT>/, value: 'second' },
      ], new AbortController().signal, false, {
        mode: 'single-prompt', lifetimeMs: 5_000,
      }).catch(error => error);
      expect(failure).toBeInstanceOf(ConfigRepairSessionError);
      expect(failure.result.execution.kind).toBe('gone');
      expect(failure.result.status).toBe(0);
      expect(failure.result.stdout).toContain('noise while processing first answer');
      const input = JSON.parse(
        fs.readFileSync(path.join(workspace.root, 'input-observed.json'), 'utf8'),
      ) as string[];
      expect(input).toHaveLength(1);
      expect(input[0]).toContain('first');
      expect(input[0]).not.toContain('second');
    });
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

  it('initialization and retention failures preserve the first cause and workspace', () => {
    const runRoot = useIsolatedRunRoot();
    const primary = new Error('controlled setup and retention failure');
    let root: string | undefined;
    try {
      const failure = (() => {
        try {
          createConfigRepairWorkspace('http://127.0.0.1:1/v1', undefined, {
            afterInitialize: initializedRoot => {
              root = initializedRoot;
              const record = path.join(runRoot, 'test-resource-failures.jsonl');
              fs.rmSync(record);
              fs.mkdirSync(record);
              throw primary;
            },
          });
        } catch (error) {
          return error;
        }
      })();
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure.cause).toBe(primary);
      expect(failure.errors[0]).toBe(primary);
      expect(failure.errors[1]).toMatchObject({
        name: 'RetentionWriteError', publication: 'not_published',
      });
      expect(fs.existsSync(path.join(root!, '.test-home'))).toBe(true);
    } finally {
      if (root) {
        fs.rmSync(root, { recursive: true, force: true });
        untrackTempDir(root);
      }
    }
  });

  it('published completion with fsync and retained-open failures stops local deletion', async () => {
    const runRoot = useIsolatedRunRoot();
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    const record = path.join(runRoot, 'test-resource-failures.jsonl');
    const completeFault = Object.assign(new Error('controlled complete fsync EIO'), { code: 'EIO' });
    const retainFault = Object.assign(new Error('controlled retain open ENOSPC'), { code: 'ENOSPC' });
    const actualOpen = fs.openSync;
    const actualFsync = fs.fsyncSync;
    let appendCount = 0;
    let ownedFd: number | undefined;
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((file: any, ...args: any[]) => {
      if (file === record && args[0] === 'a') {
        appendCount += 1;
        if (appendCount > 1) throw retainFault;
        ownedFd = actualOpen(file, ...args);
        return ownedFd;
      }
      return actualOpen(file, ...args);
    });
    const fsyncSpy = vi.spyOn(fs, 'fsyncSync').mockImplementation((fd: number) => {
      if (fd === ownedFd) throw completeFault;
      return actualFsync(fd);
    });
    try {
      fs.writeFileSync(path.join(workspace.home, 'sentinel'), 'original evidence');
      const failure = await finishConfigRepairCase(workspace, async () => 42).catch(error => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure.errors[0]).toMatchObject({
        name: 'RetentionWriteError', publication: 'published', cause: completeFault,
      });
      expect(failure.errors[1]).toMatchObject({
        name: 'RetentionWriteError', publication: 'not_published', cause: retainFault,
      });
      expect(appendCount).toBe(2);
      expect(inspectRetention(runRoot, workspace.root)).toEqual({ kind: 'allow' });
      expect(fs.existsSync(workspace.root)).toBe(true);
      expect(fs.readFileSync(path.join(workspace.home, 'sentinel'), 'utf8')).toBe('original evidence');
    } finally {
      openSpy.mockRestore();
      fsyncSpy.mockRestore();
      discardControlledWorkspace(workspace);
      await cleanupTempDir(path.dirname(runRoot));
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


describe('Phase 2237 Z04 HTTP lifecycle regressions', () => {
  it('C22 preserves evidence after a real listen EADDRINUSE failure', async () => {
    const runRoot = useIsolatedRunRoot();
    const blocker = net.createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, '127.0.0.1', () => {
        blocker.off('error', reject);
        resolve();
      });
    });
    const address = blocker.address();
    if (address === null || typeof address === 'string') throw new Error('listen blocker has no port');
    let closeConfirmed = false;
    try {
      const failure = await startConfigRepairServer({
        listen: (server, onListening) => server.listen(address.port, '127.0.0.1', onListening),
      }).catch(error => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure.cause).toMatchObject({ code: 'EADDRINUSE' });
      expect(failure.evidence.closeFacts.callback).toBe('not_listening');
      closeConfirmed = failure.evidence.state === 'closed';
      expect(closeConfirmed).toBe(true);
      const [fixtureDir] = httpFixtureDirs(runRoot);
      expect(inspectRetention(runRoot, fixtureDir)).toMatchObject({
        kind: 'preserve', reasons: ['http_fixture_failed'],
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        blocker.close(error => error ? reject(error) : resolve());
      });
      if (closeConfirmed) discardHttpFixtures(runRoot);
    }
  });

  it('C22 aggregates real socket and running server error events before closing', async () => {
    const runRoot = useIsolatedRunRoot();
    const socketFault = new Error('controlled running socket error');
    const serverFault = new Error('controlled running server error');
    let connected!: net.Socket;
    let owned!: http.Server;
    let connection!: Promise<void>;
    const server = await startConfigRepairServer({
      onListening: instance => {
        owned = instance;
        connection = new Promise<void>(resolve => {
          instance.once('connection', socket => {
            connected = socket;
            resolve();
          });
        });
      },
    });
    const [fixtureDir] = httpFixtureDirs(runRoot);
    const client = net.connect({ host: '127.0.0.1', port: Number(new URL(server.baseUrl).port) });
    let closeConfirmed = false;
    try {
      await connection;
      connected.emit('error', socketFault);
      owned.emit('error', serverFault);
      const failure = await server.close().catch(error => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure.cause).toBe(socketFault);
      expect(failure.errors).toContain(serverFault);
      expect(failure.evidence.errors).toEqual(expect.arrayContaining([
        { operation: 'socket.error', error: socketFault },
        { operation: 'server.error', error: serverFault },
      ]));
      closeConfirmed = failure.evidence.state === 'closed';
      expect(closeConfirmed).toBe(true);
      expect(inspectRetention(runRoot, fixtureDir)).toMatchObject({
        kind: 'preserve', reasons: ['http_fixture_failed'],
      });
    } finally {
      client.destroy();
      if (closeConfirmed) discardHttpFixtures(runRoot);
    }
  });

  it('C22 keeps close failure first when retained publication also fails', async () => {
    const runRoot = useIsolatedRunRoot();
    const closeFault = new Error('controlled server close callback failure');
    let port = 0;
    const server = await startConfigRepairServer({
      onListening: instance => {
        const address = instance.address();
        if (address === null || typeof address === 'string') throw new Error('server has no port');
        port = address.port;
        const actualClose = instance.close.bind(instance);
        instance.close = ((callback?: (error?: Error) => void) => actualClose(
          () => callback?.(closeFault),
        )) as http.Server['close'];
      },
    });
    const [fixtureDir] = httpFixtureDirs(runRoot);
    const retentionPath = path.join(runRoot, 'test-resource-failures.jsonl');
    fs.rmSync(retentionPath);
    fs.mkdirSync(retentionPath);
    let closeConfirmed = false;
    try {
      const failure = await server.close().catch(error => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure.cause).toBe(closeFault);
      expect(failure.errors[0]).toBeInstanceOf(AggregateError);
      expect(failure.errors[0].cause).toBe(closeFault);
      expect(failure.errors[1]).toMatchObject({ name: 'RetentionWriteError' });
      expect(failure.evidence.errors).toContainEqual({ operation: 'server.close', error: closeFault });
      expect(failure.evidence.closeFacts.callback).toBe('error');
      await expectPortRefused(port);
      closeConfirmed = true;
      expect(fs.existsSync(fixtureDir)).toBe(true);
    } finally {
      if (closeConfirmed) discardHttpFixtures(runRoot);
    }
  });

  it('C22 records a close callback arriving after the observation deadline', async () => {
    const runRoot = useIsolatedRunRoot();
    let port = 0;
    let releaseClose: (() => void) | undefined;
    let released = false;
    const server = await startConfigRepairServer({
      onListening: instance => {
        const address = instance.address();
        if (address === null || typeof address === 'string') throw new Error('server has no port');
        port = address.port;
        const actualClose = instance.close.bind(instance);
        instance.close = ((callback?: (error?: Error) => void) => {
          releaseClose = () => {
            released = true;
            callback?.();
          };
          return actualClose(() => { /* hold only the callback past the deadline */ });
        }) as http.Server['close'];
      },
    });
    const [fixtureDir] = httpFixtureDirs(runRoot);
    let closeConfirmed = false;
    try {
      const failure = await server.close().catch(error => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure.evidence.state).toBe('unconfirmed');
      expect(failure.evidence.closeFacts.callback).toBe('deadline');
      expect(failure.evidence.errors.some((entry: { operation: string }) =>
        entry.operation === 'server.close_deadline')).toBe(true);
      await expectPortRefused(port);
      expect(releaseClose).toBeDefined();
      releaseClose!();
      closeConfirmed = true;
      const record = fs.readFileSync(path.join(runRoot, 'test-resource-failures.jsonl'), 'utf8');
      expect(record).toContain('"event":"close_callback"');
      expect(record).toContain('"lateFact"');
      expect(fs.existsSync(fixtureDir)).toBe(true);
    } finally {
      if (!released) releaseClose?.();
      if (closeConfirmed) discardHttpFixtures(runRoot);
    }
  });
});


describe('Phase 2237 Z04 PTY lifecycle regressions', () => {
  it('C02 honors abort after spawn returns but before the ready wait begins', async () => {
    const runRoot = useIsolatedRunRoot();
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    const controller = new AbortController();
    const primary = new Error('controlled spawn-return listener-window abort');
    let result: ConfigRepairSessionResult | undefined;
    try {
      const failure = await runConfigRepairSession(workspace, [], [], controller.signal, false, {
        spawnPty: (_command, env, cwd) => {
          const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${DETACHED_CHILD_LIFETIME_MS})`], {
            cwd, env, detached: true, stdio: 'pipe',
          });
          controller.abort(primary);
          return child;
        },
      }).catch(error => error);
      expect(failure).toBeInstanceOf(ConfigRepairSessionError);
      expect(failure.cause).toBe(primary);
      result = (failure as ConfigRepairSessionError).result;
      expect(result.firstStop).toEqual({ reason: 'session cancelled by caller', cause: primary });
      expect(result.ready).toBeUndefined();
      expect(result.wrapper.close.kind).toBe('closed');
    } finally {
      if (result?.wrapper.capture && 'target' in result.wrapper.capture) {
        await reapIdentity(result.wrapper.capture.target);
      }
      if (result?.wrapper.close.kind === 'closed') discardControlledWorkspace(workspace);
      await cleanupTempDir(path.dirname(runRoot));
    }
  });

  it('C03 handles an asynchronous child error before ready without losing the cause', async () => {
    const runRoot = useIsolatedRunRoot();
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    const primary = new Error('controlled asynchronous child error');
    let result: ConfigRepairSessionResult | undefined;
    try {
      const failure = await runConfigRepairSession(workspace, [], [], new AbortController().signal, false, {
        spawnPty: (_command, env, cwd) => {
          const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${DETACHED_CHILD_LIFETIME_MS})`], {
            cwd, env, detached: true, stdio: 'pipe',
          });
          queueMicrotask(() => child.emit('error', primary));
          return child;
        },
      }).catch(error => error);
      expect(failure).toBeInstanceOf(ConfigRepairSessionError);
      expect(failure.cause).toBe(primary);
      result = (failure as ConfigRepairSessionError).result;
      expect(result.firstStop).toEqual({ reason: 'PTY wrapper emitted error', cause: primary });
      expect(result.errors).toContainEqual({ operation: 'wrapper.error', error: primary });
      expect(result.ready).toBeUndefined();
      expect(result.wrapper.close.kind).toBe('closed');
    } finally {
      if (result?.wrapper.capture && 'target' in result.wrapper.capture) {
        await reapIdentity(result.wrapper.capture.target);
      }
      if (result?.wrapper.close.kind === 'closed') discardControlledWorkspace(workspace);
      await cleanupTempDir(path.dirname(runRoot));
    }
  });

  it('C03 records the no-PID fact before a controlled asynchronous spawn error', async () => {
    const runRoot = useIsolatedRunRoot();
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    let result: ConfigRepairSessionResult | undefined;
    try {
      const failure = await runConfigRepairSession(workspace, [], [], new AbortController().signal, false, {
        spawnPty: (_command, env, cwd) => {
          const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${DETACHED_CHILD_LIFETIME_MS})`], {
            cwd, env, detached: true, stdio: 'pipe',
          });
          Object.defineProperty(child, 'pid', { value: undefined });
          const fault = Object.assign(new Error('controlled asynchronous spawn ENOENT'), { code: 'ENOENT' });
          queueMicrotask(() => child.emit('error', fault));
          return child;
        },
      }).catch(error => error);
      expect(failure).toBeInstanceOf(ConfigRepairSessionError);
      result = (failure as ConfigRepairSessionError).result;
      expect(result.firstStop?.reason).toBe('PTY wrapper has no process identity');
      expect(result.errors.some(entry => entry.operation === 'wrapper.error'
        && (entry.error as NodeJS.ErrnoException).code === 'ENOENT')).toBe(true);
      expect(result.wrapper.capture).toBeUndefined();
      expect(result.ready).toBeUndefined();
      expect(result.wrapper.close.kind).toBe('closed');
      expect(fs.readFileSync(result.evidencePath, 'utf8')).toContain('ENOENT');
    } finally {
      if (result?.wrapper.close.kind === 'closed') discardControlledWorkspace(workspace);
      await cleanupTempDir(path.dirname(runRoot));
    }
  });

  it('C03 reports a real child close before any ready file appears', async () => {
    const runRoot = useIsolatedRunRoot();
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    let result: ConfigRepairSessionResult | undefined;
    try {
      const failure = await runConfigRepairSession(workspace, [], [], new AbortController().signal, false, {
        spawnPty: (_command, env, cwd) => spawn(process.execPath, ['-e', 'process.exit(0)'], {
          cwd, env, detached: true, stdio: 'pipe',
        }),
      }).catch(error => error);
      expect(failure).toBeInstanceOf(ConfigRepairSessionError);
      result = (failure as ConfigRepairSessionError).result;
      expect(result.firstStop?.reason).toBe('PTY wrapper closed before publishing a valid ready identity');
      expect(result.firstStop?.cause).toBeInstanceOf(Error);
      expect(result.status).toBe(0);
      expect(result.ready).toBeUndefined();
      expect(result.wrapper.close).toMatchObject({ kind: 'closed', status: 0 });
      expect(fs.existsSync(result.evidencePath)).toBe(true);
    } finally {
      if (result?.wrapper.capture && 'target' in result.wrapper.capture) {
        await reapIdentity(result.wrapper.capture.target);
      }
      if (result?.wrapper.close.kind === 'closed') discardControlledWorkspace(workspace);
      await cleanupTempDir(path.dirname(runRoot));
    }
  });

  it('C04 times out a missing ready file and independently reaps its sidecar identity', async () => {
    const runRoot = useIsolatedRunRoot();
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    let result: ConfigRepairSessionResult | undefined;
    let reaped = false;
    try {
      const failure = await runConfigRepairSession(workspace, [], [], new AbortController().signal, false, {
        mode: 'no-ready', lifetimeMs: 30_000,
      }).catch(error => error);
      expect(failure).toBeInstanceOf(ConfigRepairSessionError);
      result = (failure as ConfigRepairSessionError).result;
      expect(failure.cause).toBeInstanceOf(Error);
      expect((failure.cause as Error).message).toContain('ready handshake timed out');
      expect(result.ready).toBeUndefined();
      expect(result.execution.capture).toBeUndefined();
      expect(fs.existsSync(path.join(workspace.root, 'worker-identity.json'))).toBe(true);
      await reapControlledSession(workspace, result);
      reaped = true;
    } finally {
      if (reaped) discardControlledWorkspace(workspace);
      await cleanupTempDir(path.dirname(runRoot));
    }
  });

  it.each([
    ['bad-ready-json', 'Unexpected end of JSON input'],
    ['bad-ready-schema', 'PTY ready identity failed validation'],
    ['bad-ready-cwd', 'PTY fixture cwd mismatch'],
  ] as const)('C04 rejects %s without signalling its unvalidated ready identity', async (mode, message) => {
    const runRoot = useIsolatedRunRoot();
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    let result: ConfigRepairSessionResult | undefined;
    let reaped = false;
    try {
      const failure = await runConfigRepairSession(workspace, [], [], new AbortController().signal, false, {
        mode, lifetimeMs: 30_000,
      }).catch(error => error);
      expect(failure).toBeInstanceOf(ConfigRepairSessionError);
      result = (failure as ConfigRepairSessionError).result;
      expect(failure.cause).toBeInstanceOf(Error);
      expect((failure.cause as Error).message).toContain(message);
      expect(result.ready).toBeUndefined();
      expect(result.execution.capture).toBeUndefined();
      expect(result.execution.termination).toBeUndefined();
      expect(fs.existsSync(path.join(workspace.root, 'worker-identity.json'))).toBe(true);
      await reapControlledSession(workspace, result);
      reaped = true;
    } finally {
      if (reaped) discardControlledWorkspace(workspace);
      await cleanupTempDir(path.dirname(runRoot));
    }
  });

  it.each(['gone', 'unknown'] as const)('C06 preserves a gone capture with %s group observation', async observed => {
    const runRoot = useIsolatedRunRoot();
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    const primary = new Error(`controlled gone capture/${observed} observation`);
    let result: ConfigRepairSessionResult | undefined;
    let captureEvidence: Extract<ExecutionTargetCapture, { kind: 'captured' }>['evidence'] | undefined;
    let reaped = false;
    try {
      const failure = await runConfigRepairSession(workspace, [], [], new AbortController().signal, false, {
        mode: 'finite', lifetimeMs: 30_000,
        onReady: () => { throw primary; },
        captureTarget: identity => {
          const captured = captureExecutionTarget(identity);
          if (captured.kind !== 'captured') throw new Error(`unexpected fixture capture: ${captured.kind}`);
          captureEvidence = captured.evidence;
          return { kind: 'gone', target: captured.target, evidence: captured.evidence };
        },
        observeTarget: target => {
          if (!captureEvidence) throw new Error('controlled capture evidence was not installed');
          return observed === 'gone'
            ? { kind: 'gone', reason: 'absent', target, evidence: captureEvidence }
            : { kind: 'unknown', reason: 'controlled_unknown_observation', target, evidence: captureEvidence };
        },
      }).catch(error => error);
      expect(failure).toBeInstanceOf(ConfigRepairSessionError);
      expect(failure.cause).toBe(primary);
      result = (failure as ConfigRepairSessionError).result;
      expect(result.execution.capture?.kind).toBe('gone');
      expect(result.execution.observation?.kind).toBe(observed);
      expect(result.execution.termination).toBeUndefined();
      expect(result.execution.kind).toBe(observed === 'gone' ? 'gone' : 'unconfirmed');
      await reapControlledSession(workspace, result);
      reaped = true;
    } finally {
      if (reaped) discardControlledWorkspace(workspace);
      await cleanupTempDir(path.dirname(runRoot));
    }
  });

  it('C08 records observe API throws and still attempts worker termination', async () => {
    const runRoot = useIsolatedRunRoot();
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    const primary = new Error('controlled primary before observe throws');
    const observeFault = new Error('controlled observe API throw');
    let result: ConfigRepairSessionResult | undefined;
    let reaped = false;
    try {
      const failure = await runConfigRepairSession(workspace, [], [], new AbortController().signal, false, {
        mode: 'finite', lifetimeMs: 30_000,
        onReady: () => { throw primary; },
        observeTarget: () => { throw observeFault; },
      }).catch(error => error);
      expect(failure).toBeInstanceOf(ConfigRepairSessionError);
      expect(failure.cause).toBe(primary);
      result = (failure as ConfigRepairSessionError).result;
      expect(result.errors.filter(entry =>
        entry.operation === 'worker_group.observe' && entry.error === observeFault)).toHaveLength(2);
      expect(result.execution.termination?.status).toBe('gone');
      expect(result.execution.kind).toBe('unconfirmed');
      expect(fs.readFileSync(result.evidencePath, 'utf8')).toContain(observeFault.message);
      await reapControlledSession(workspace, result);
      reaped = true;
    } finally {
      if (reaped) discardControlledWorkspace(workspace);
      await cleanupTempDir(path.dirname(runRoot));
    }
  });


  it('C11 escalates a real ignored SIGTERM to SIGKILL through the PTY receiver', async () => {
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    await finishConfigRepairCase(workspace, async () => {
      const primary = new Error('controlled stop for ignored TERM');
      const failure = await runConfigRepairSession(workspace, [], [], new AbortController().signal, false, {
        mode: 'ignore-term', lifetimeMs: 30_000,
        onReady: () => { throw primary; },
      }).catch(error => error);
      expect(failure).toBeInstanceOf(ConfigRepairSessionError);
      expect(failure.cause).toBe(primary);
      expect(failure.result.execution.termination).toMatchObject({
        status: 'gone', termSent: true, killSent: true,
      });
      expect(failure.result.execution.kind).toBe('gone');
      expect(fs.existsSync(failure.result.exitedPath)).toBe(false);
    });
  });

  it('C12 retains only the wrapper when the worker is gone and streams close', async () => {
    const runRoot = useIsolatedRunRoot();
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    const primary = new Error('controlled worker-gone wrapper-hold stop');
    let result: ConfigRepairSessionResult | undefined;
    let reaped = false;
    try {
      const failure = await runConfigRepairSession(workspace, [], [], new AbortController().signal, false, {
        mode: 'hold-wrapper', lifetimeMs: 30_000,
        onReady: () => { throw primary; },
        terminateWrapper: async target => indeterminateTermination(target, 'controlled_wrapper_hold'),
      }).catch(error => error);
      expect(failure).toBeInstanceOf(ConfigRepairSessionError);
      result = (failure as ConfigRepairSessionError).result;
      expect(result.execution.kind).toBe('gone');
      expect(result.execution.termination?.status).toBe('gone');
      expect(result.wrapper.close).toMatchObject({ kind: 'unconfirmed', reason: 'deadline' });
      expect(result.wrapper.termination?.status).toBe('indeterminate');
      expect(Object.values(result.streams).every(stream => stream.close.kind === 'closed')).toBe(true);
      expect(inspectRetention(runRoot, workspace.root)).toMatchObject({
        kind: 'preserve', reasons: ['unconfirmed_wrapper'],
      });
      await reapControlledSession(workspace, result);
      reaped = true;
    } finally {
      if (reaped) discardControlledWorkspace(workspace);
      await cleanupTempDir(path.dirname(runRoot));
    }
  });

  it('C13 stops on a stdin write callback error without advancing the answer', async () => {
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    await finishConfigRepairCase(workspace, async () => {
      const primary = new Error('controlled stdin write callback error');
      const failure = await runConfigRepairSession(workspace, [], [
        { prompt: /PROMPT>/, value: 'not-written' },
      ], new AbortController().signal, false, {
        mode: 'single-prompt', lifetimeMs: 30_000,
        spawnPty: (command, env, cwd) => {
          const child = spawn(command[0], command.slice(1), { cwd, env, detached: true, stdio: 'pipe' });
          child.stdin.write = ((...args: any[]) => {
            const callback = [...args].reverse().find(arg => typeof arg === 'function') as
              ((error?: Error | null) => void) | undefined;
            queueMicrotask(() => callback?.(primary));
            return true;
          }) as typeof child.stdin.write;
          return child;
        },
      }).catch(error => error);
      expect(failure).toBeInstanceOf(ConfigRepairSessionError);
      expect(failure.cause).toBe(primary);
      expect(failure.result.firstStop).toEqual({ reason: 'PTY stdin write callback failed', cause: primary });
      expect(failure.result.errors).toContainEqual({ operation: 'stdin.write_callback', error: primary });
      expect(failure.message).toContain('answer 0/1');
      expect(failure.result.execution.kind).toBe('gone');
    });
  });

  it('C13 routes a real stdin stream error event through the same cleanup', async () => {
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    await finishConfigRepairCase(workspace, async () => {
      const primary = new Error('controlled stdin stream error');
      const failure = await runConfigRepairSession(workspace, [], [
        { prompt: /PROMPT>/, value: 'must-not-be-written' },
      ], new AbortController().signal, false, {
        mode: 'single-prompt', lifetimeMs: 30_000,
        spawnPty: (command, env, cwd) => {
          const child = spawn(command[0], command.slice(1), { cwd, env, detached: true, stdio: 'pipe' });
          child.stdout.prependOnceListener('data', () => child.stdin.emit('error', primary));
          return child;
        },
      }).catch(error => error);
      expect(failure).toBeInstanceOf(ConfigRepairSessionError);
      expect(failure.cause).toBe(primary);
      expect(failure.result.firstStop).toEqual({ reason: 'PTY stdin emitted error', cause: primary });
      expect(failure.result.errors).toContainEqual({ operation: 'stdin.error', error: primary });
      expect(failure.result.execution.kind).toBe('gone');
      expect(fs.existsSync(path.join(workspace.root, 'input-observed.json'))).toBe(false);
    });
  });

  it('2250 C13 real closed pipe preserves the system write and stream errors', async () => {
    const runRoot = useIsolatedRunRoot();
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    let result: ConfigRepairSessionResult | undefined;
    let caseFinished = false;
    try {
      await finishConfigRepairCase(workspace, async () => {
        let child: ReturnType<typeof spawn> | undefined;
        let writes = 0;
        let writeCallbackError: Error | null | undefined;
        const failure = await runConfigRepairSession(workspace, [], [
          { prompt: /PROMPT>/, value: 'must-not-arrive' },
        ], new AbortController().signal, false, {
          mode: 'closed-stdin', lifetimeMs: 30_000,
          spawnPty: (command, env, cwd) => {
            child = spawn(command[0], command.slice(1), {
              cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
            });
            const originalWrite = child.stdin.write;
            child.stdin.write = ((...args: any[]) => {
              writes += 1;
              const callbackIndex = args.findIndex(arg => typeof arg === 'function');
              if (callbackIndex >= 0) {
                const originalCallback = args[callbackIndex] as (error?: Error | null) => void;
                args[callbackIndex] = (error?: Error | null) => {
                  writeCallbackError = error;
                  originalCallback(error);
                };
              }
              return originalWrite.apply(child!.stdin, args);
            }) as typeof child.stdin.write;
            return child;
          },
          onReady: () => {
            if (!child?.send) throw new Error('closed-stdin wrapper has no IPC channel');
            child.send({ type: 'close-input' });
          },
        }).catch(error => error);
        expect(failure).toBeInstanceOf(ConfigRepairSessionError);
        expect(writes).toBeGreaterThan(0);
        expect(writeCallbackError).toBeInstanceOf(Error);
        result = (failure as ConfigRepairSessionError).result;
        const systemError = writeCallbackError as NodeJS.ErrnoException;
        expect(['EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED']).toContain(systemError.code);
        expect(result.firstStop).toEqual({
          reason: 'PTY stdin write callback failed', cause: writeCallbackError,
        });
        expect(result.errors).toContainEqual({
          operation: 'stdin.write_callback', error: writeCallbackError,
        });
        const streamErrors = result.errors.filter(entry => entry.operation === 'stdin.error');
        expect(streamErrors.length).toBeGreaterThan(0);
        expect(streamErrors.every(entry =>
          (entry.error as NodeJS.ErrnoException).code === systemError.code)).toBe(true);
        expect(failure.message).toContain('answer 0/1');
        expect(result.execution.kind).toBe('gone');
        expect(result.wrapper.observation?.kind).toBe('gone');
        for (const role of ['wrapper', 'worker']) {
          expect(JSON.parse(fs.readFileSync(
            path.join(workspace.root, `${role}-input-closed.json`), 'utf8',
          ))).toEqual({ replacement: 0, characterDevice: true });
        }
        expect(fs.existsSync(path.join(workspace.root, 'input-observed.json'))).toBe(false);
        const evidence = fs.readFileSync(result.evidencePath, 'utf8');
        expect(evidence).toContain('stdin.write_callback');
        expect(evidence).toContain('stdin.error');
        expect(evidence).toContain(systemError.code!);
      });
      caseFinished = true;
    } finally {
      await reapControlledSession(workspace, result);
      if (caseFinished) discardControlledWorkspace(workspace);
      await cleanupTempDir(path.dirname(runRoot));
    }
  });

  it('C13 matches a prompt split across stdout chunks and writes exactly one answer', async () => {
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    await finishConfigRepairCase(workspace, async () => {
      const result = await runConfigRepairSession(workspace, [], [
        { prompt: /PROMPT>/, value: 'split-answer' },
      ], new AbortController().signal, false, {
        mode: 'split-prompt', lifetimeMs: 5_000,
        spawnPty: (command, env, cwd) => {
          const child = spawn(command[0], command.slice(1), { cwd, env, detached: true, stdio: 'pipe' });
          child.stdout.prependOnceListener('data', () => {
            fs.writeFileSync(path.join(cwd, 'release-second-prompt-chunk'), 'release');
          });
          return child;
        },
      });
      expect(result.status).toBe(0);
      expect(result.execution.kind).toBe('gone');
      const input = JSON.parse(
        fs.readFileSync(path.join(workspace.root, 'input-observed.json'), 'utf8'),
      ) as string[];
      expect(input).toHaveLength(1);
      expect(input[0]).toBe('split-answer\n');
    });
  });

  async function verifyOrderedStop(order: 'abort-first' | 'timeout-first'): Promise<void> {
    const runRoot = useIsolatedRunRoot();
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    let result: ConfigRepairSessionResult | undefined;
    let caseFinished = false;
    try {
      await finishConfigRepairCase(workspace, async () => {
        const controller = new AbortController();
        const primary = new Error(`controlled ${order} abort`);
        const timers = createSessionTimerController(path.join(workspace.root, 'session-timer-events.jsonl'));
        let workerTerminations = 0;
        let wrapperTerminations = 0;
        const failure = await runConfigRepairSession(workspace, [], [], controller.signal, false, {
          mode: 'finite', lifetimeMs: 30_000,
          scheduleSessionTimer: timers.schedule,
          onReady: () => {
            if (order === 'abort-first') {
              controller.abort(primary);
              expect(timers.fire('work')).toBe(true);
            } else {
              expect(timers.fire('work')).toBe(true);
              controller.abort(primary);
            }
          },
          terminateTarget: async (...args) => {
            workerTerminations += 1;
            return terminateExecutionTarget(...args);
          },
          terminateWrapper: async (...args) => {
            wrapperTerminations += 1;
            return terminateExecutionTarget(...args);
          },
        }).catch(error => error);
        expect(failure).toBeInstanceOf(ConfigRepairSessionError);
        result = (failure as ConfigRepairSessionError).result;
        const expectedFirst = order === 'abort-first' ? 'session cancelled by caller' : 'interactive session timed out';
        const expectedLater = order === 'abort-first' ? 'interactive session timed out' : 'session cancelled by caller';
        expect(result.firstStop?.reason).toBe(expectedFirst);
        expect(result.laterStops.some(stop => stop.reason === expectedLater)).toBe(true);
        if (order === 'abort-first') expect(failure.cause).toBe(primary);
        else expect(result.firstStop?.cause).toMatchObject({ message: 'session timeout' });
        expect(timers.entry('work')?.fired).toBe(1);
        expect(workerTerminations).toBe(1);
        expect(wrapperTerminations).toBe(1);
        expect(result.execution.kind).toBe('gone');
        expect(result.wrapper.observation?.kind).toBe('gone');
      });
      caseFinished = true;
    } finally {
      await reapControlledSession(workspace, result);
      if (caseFinished) discardControlledWorkspace(workspace);
      await cleanupTempDir(path.dirname(runRoot));
    }
  }

  it('2250 C14 V02 preserves abort before an effective work timeout', async () => {
    await verifyOrderedStop('abort-first');
  });

  it('2250 C14 V03 preserves an effective work timeout before abort', async () => {
    await verifyOrderedStop('timeout-first');
  });

  it('2250 C14 V04 cancels work during abort cleanup', async () => {
    const runRoot = useIsolatedRunRoot();
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    let result: ConfigRepairSessionResult | undefined;
    let caseFinished = false;
    try {
      await finishConfigRepairCase(workspace, async () => {
        const controller = new AbortController();
        const primary = new Error('controlled cancellation-before-work cleanup');
        const timers = createSessionTimerController(path.join(workspace.root, 'session-timer-events.jsonl'));
        const failure = await runConfigRepairSession(workspace, [], [], controller.signal, false, {
          mode: 'finite', lifetimeMs: 30_000,
          scheduleSessionTimer: timers.schedule,
          onReady: () => controller.abort(primary),
        }).catch(error => error);
        expect(failure).toBeInstanceOf(ConfigRepairSessionError);
        result = (failure as ConfigRepairSessionError).result;
        expect(result.firstStop).toEqual({ reason: 'session cancelled by caller', cause: primary });
        expect(timers.entry('work')).toMatchObject({ cancelled: true, fired: 0 });
        expect(timers.fire('work')).toBe(false);
        expect(timers.entry('work')?.fired).toBe(0);
        expect(result.laterStops.some(stop => stop.reason === 'interactive session timed out')).toBe(false);
        expect(result.execution.kind).toBe('gone');
        expect(result.wrapper.observation?.kind).toBe('gone');
      });
      caseFinished = true;
    } finally {
      await reapControlledSession(workspace, result);
      if (caseFinished) discardControlledWorkspace(workspace);
      await cleanupTempDir(path.dirname(runRoot));
    }
  });

  it('2250 C14 V05 cancels a pending answer before any real input write', async () => {
    const runRoot = useIsolatedRunRoot();
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    let result: ConfigRepairSessionResult | undefined;
    let caseFinished = false;
    try {
      await finishConfigRepairCase(workspace, async () => {
        const controller = new AbortController();
        const primary = new Error('controlled pending-answer cancellation');
        const timers = createSessionTimerController(path.join(workspace.root, 'session-timer-events.jsonl'));
        let child: ReturnType<typeof spawn> | undefined;
        let writes = 0;
        const watchdogCause = new Error('controlled prompt did not register an answer before the guard deadline');
        const watchdog = setTimeout(() => controller.abort(watchdogCause), CONTROLLED_INPUT_GUARD_TIMEOUT_MS);
        const failure = await runConfigRepairSession(workspace, [], [
          { prompt: /PROMPT>/, value: 'must-not-be-written' },
        ], controller.signal, false, {
          mode: 'controlled-input', lifetimeMs: 30_000,
          spawnPty: (command, env, cwd) => {
            child = spawn(command[0], command.slice(1), {
              cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
            });
            const originalWrite = child.stdin.write;
            child.stdin.write = ((...args: any[]) => {
              writes += 1;
              return originalWrite.apply(child!.stdin, args);
            }) as typeof child.stdin.write;
            child.on('message', (message: { type?: string; message?: string }) => {
              if (message?.type === 'controlled-input-error') {
                controller.abort(new Error(`controlled IPC forwarding failed: ${message.message}`));
              }
            });
            return child;
          },
          onReady: () => {
            if (!child?.send) throw new Error('controlled-input wrapper has no IPC channel');
            child.send({ type: 'prompt', value: 'PROMPT>' }, error => {
              if (error) controller.abort(error);
            });
          },
          scheduleSessionTimer: (kind, callback, delayMs) => {
            const cancel = timers.schedule(kind, callback, delayMs);
            if (kind === 'answer') {
              clearTimeout(watchdog);
              controller.abort(primary);
            }
            return cancel;
          },
        }).catch(error => error);
        clearTimeout(watchdog);
        expect(failure).toBeInstanceOf(ConfigRepairSessionError);
        result = (failure as ConfigRepairSessionError).result;
        expect(result.firstStop).toEqual({ reason: 'session cancelled by caller', cause: primary });
        expect(result.stdout).toContain('PROMPT>');
        expect(timers.registrations('answer')).toBe(1);
        expect(timers.entry('answer')).toMatchObject({ cancelled: true, fired: 0 });
        expect(timers.fire('answer')).toBe(false);
        expect(writes).toBe(0);
        expect(JSON.parse(fs.readFileSync(
          path.join(workspace.root, 'input-observed.json'), 'utf8',
        ))).toEqual([]);
        expect(result.execution.kind).toBe('gone');
        expect(result.wrapper.observation?.kind).toBe('gone');
      });
      caseFinished = true;
    } finally {
      await reapControlledSession(workspace, result);
      if (caseFinished) discardControlledWorkspace(workspace);
      await cleanupTempDir(path.dirname(runRoot));
    }
  });

  it('2250 C14 V06 freezes late prompt input but preserves actual output', async () => {
    const runRoot = useIsolatedRunRoot();
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    let result: ConfigRepairSessionResult | undefined;
    let caseFinished = false;
    try {
      await finishConfigRepairCase(workspace, async () => {
        const controller = new AbortController();
        const primary = new Error('controlled late-prompt stop');
        const timers = createSessionTimerController(path.join(workspace.root, 'session-timer-events.jsonl'));
        let child: ReturnType<typeof spawn> | undefined;
        let writes = 0;
        let workerTerminations = 0;
        let wrapperTerminations = 0;
        let gateSettled = false;
        let observedGateError: Error | undefined;
        let observedStdout = '';
        let resolveGate!: () => void;
        let rejectGate!: (error: Error) => void;
        const gate = new Promise<void>((resolve, reject) => {
          resolveGate = resolve;
          rejectGate = reject;
        });
        const guard = setTimeout(() => {
          releaseGate(new Error('late prompt was not observed on real parent stdout'));
        }, LATE_PROMPT_GUARD_TIMEOUT_MS);
        function releaseGate(error?: Error): void {
          if (gateSettled) return;
          gateSettled = true;
          if (error) observedGateError = error;
          clearTimeout(guard);
          if (error) rejectGate(error);
          else resolveGate();
        }
        const terminateAfterGate = async (
          target: Parameters<typeof terminateExecutionTarget>[0],
          reason: 'caller_requested',
        ) => {
          let gateError: unknown;
          try {
            await gate;
          } catch (error) {
            gateError = error;
          }
          try {
            const terminal = await terminateExecutionTarget(target, reason);
            if (gateError !== undefined) throw gateError;
            return terminal;
          } catch (error) {
            if (gateError !== undefined && error !== gateError) {
              throw new AggregateError([gateError, error], 'Late prompt gate and real termination failed');
            }
            throw error;
          }
        };
        const failure = await runConfigRepairSession(workspace, [], [
          { prompt: /LATE_PROMPT>/, value: 'late-answer-must-not-be-written' },
        ], controller.signal, false, {
          mode: 'controlled-input', lifetimeMs: 30_000,
          scheduleSessionTimer: timers.schedule,
          spawnPty: (command, env, cwd) => {
            child = spawn(command[0], command.slice(1), {
              cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
            });
            const originalWrite = child.stdin.write;
            child.stdin.write = ((...args: any[]) => {
              writes += 1;
              return originalWrite.apply(child!.stdin, args);
            }) as typeof child.stdin.write;
            child.stdout.on('data', (chunk: Buffer | string) => {
              observedStdout += String(chunk);
              if (observedStdout.includes('LATE_PROMPT>')) releaseGate();
            });
            child.on('message', (message: { type?: string; message?: string }) => {
              if (message?.type === 'controlled-input-error') {
                releaseGate(new Error(`controlled IPC forwarding failed: ${message.message}`));
              }
            });
            return child;
          },
          onReady: () => controller.abort(primary),
          terminateTarget: async target => {
            workerTerminations += 1;
            if (!child?.send) releaseGate(new Error('controlled-input wrapper has no IPC channel'));
            else {
              try {
                child.send({ type: 'prompt', value: 'LATE_PROMPT>' }, error => {
                  if (error) releaseGate(error);
                });
              } catch (error) {
                releaseGate(error instanceof Error ? error : new Error(String(error)));
              }
            }
            return terminateAfterGate(target, 'caller_requested');
          },
          terminateWrapper: async target => {
            wrapperTerminations += 1;
            return terminateAfterGate(target, 'caller_requested');
          },
        }).catch(error => error);
        releaseGate();
        expect(failure).toBeInstanceOf(ConfigRepairSessionError);
        result = (failure as ConfigRepairSessionError).result;
        expect(observedGateError).toBeUndefined();
        expect(result.firstStop).toEqual({ reason: 'session cancelled by caller', cause: primary });
        expect(result.stdout).toContain('LATE_PROMPT>');
        expect(fs.readFileSync(result.evidencePath, 'utf8')).toContain('LATE_PROMPT>');
        expect(timers.registrations('answer')).toBe(0);
        expect(timers.fire('answer')).toBe(false);
        expect(writes).toBe(0);
        expect(JSON.parse(fs.readFileSync(
          path.join(workspace.root, 'input-observed.json'), 'utf8',
        ))).toEqual([]);
        expect(workerTerminations).toBe(1);
        expect(wrapperTerminations).toBe(1);
        expect(result.execution.kind).toBe('gone');
        expect(result.wrapper.observation?.kind).toBe('gone');
      });
      caseFinished = true;
    } finally {
      await reapControlledSession(workspace, result);
      if (caseFinished) discardControlledWorkspace(workspace);
      await cleanupTempDir(path.dirname(runRoot));
    }
  });

  it('C14 preserves deterministic abort then child-error ordering', async () => {
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    await finishConfigRepairCase(workspace, async () => {
      const controller = new AbortController();
      const primary = new Error('controlled first abort event');
      const later = new Error('controlled second child error event');
      let child: ReturnType<typeof spawn> | undefined;
      const failure = await runConfigRepairSession(workspace, [], [], controller.signal, false, {
        mode: 'finite', lifetimeMs: 30_000,
        spawnPty: (command, env, cwd) => {
          child = spawn(command[0], command.slice(1), { cwd, env, detached: true, stdio: 'pipe' });
          return child;
        },
        onReady: () => {
          controller.abort(primary);
          child?.emit('error', later);
        },
      }).catch(error => error);
      expect(failure).toBeInstanceOf(ConfigRepairSessionError);
      expect(failure.cause).toBe(primary);
      expect(failure.result.firstStop).toEqual({ reason: 'session cancelled by caller', cause: primary });
      expect(failure.result.laterStops).toContainEqual({ reason: 'PTY wrapper emitted error', cause: later });
      expect(failure.result.errors).toContainEqual({ operation: 'wrapper.error', error: later });
      expect(failure.result.execution.kind).toBe('gone');
    });
  });

  it('C14 persists error and close facts emitted after an unconfirmed return', async () => {
    const runRoot = useIsolatedRunRoot();
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    const primary = new Error('controlled stop before late wrapper facts');
    const lateFault = new Error('controlled late wrapper error');
    let child: ReturnType<typeof spawn> | undefined;
    let result: ConfigRepairSessionResult | undefined;
    let reaped = false;
    try {
      const failure = await runConfigRepairSession(workspace, [], [], new AbortController().signal, false, {
        mode: 'hold-wrapper', lifetimeMs: 30_000,
        spawnPty: (command, env, cwd) => {
          child = spawn(command[0], command.slice(1), { cwd, env, detached: true, stdio: 'pipe' });
          return child;
        },
        onReady: () => { throw primary; },
        terminateWrapper: async target => indeterminateTermination(target, 'controlled_late_fact_hold'),
      }).catch(error => error);
      expect(failure).toBeInstanceOf(ConfigRepairSessionError);
      result = (failure as ConfigRepairSessionError).result;
      expect(result.wrapper.close.kind).toBe('unconfirmed');
      expect(result.retainedListeners).toEqual(expect.arrayContaining(['wrapper:error', 'wrapper:close']));
      child?.emit('error', lateFault);
      child?.emit('close', null, 'SIGKILL');
      const evidence = fs.readFileSync(result.evidencePath, 'utf8');
      expect(evidence).toContain(lateFault.message);
      expect(evidence).toContain('"event": "close"');
      const retention = fs.readFileSync(path.join(runRoot, 'test-resource-failures.jsonl'), 'utf8');
      expect(retention).toContain(lateFault.message);
      expect(retention).toContain('"lateFact"');
      await reapControlledSession(workspace, result);
      reaped = true;
    } finally {
      if (reaped) discardControlledWorkspace(workspace);
      await cleanupTempDir(path.dirname(runRoot));
    }
  });

  it('C16 retains primary, worker termination, and wrapper termination errors together', async () => {
    const runRoot = useIsolatedRunRoot();
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    const primary = new Error('controlled C16 primary');
    const workerFault = new Error('controlled C16 worker termination error');
    const wrapperFault = new Error('controlled C16 wrapper termination error');
    let result: ConfigRepairSessionResult | undefined;
    let reaped = false;
    try {
      const failure = await runConfigRepairSession(workspace, [], [], new AbortController().signal, false, {
        mode: 'hold-wrapper', lifetimeMs: 30_000,
        onReady: () => { throw primary; },
        terminateTarget: async () => { throw workerFault; },
        terminateWrapper: async () => { throw wrapperFault; },
      }).catch(error => error);
      expect(failure).toBeInstanceOf(ConfigRepairSessionError);
      expect(failure.cause).toBe(primary);
      result = (failure as ConfigRepairSessionError).result;
      expect(result.errors).toEqual(expect.arrayContaining([
        { operation: 'worker_group.terminate', error: workerFault },
        { operation: 'wrapper.terminate', error: wrapperFault },
      ]));
      const evidence = fs.readFileSync(result.evidencePath, 'utf8');
      expect(evidence).toContain(primary.message);
      expect(evidence).toContain(workerFault.message);
      expect(evidence).toContain(wrapperFault.message);
      await reapControlledSession(workspace, result);
      reaped = true;
    } finally {
      if (reaped) discardControlledWorkspace(workspace);
      await cleanupTempDir(path.dirname(runRoot));
    }
  });


  it('C18 preserves remaining bytes and the original deletion failure', async () => {
    const runRoot = useIsolatedRunRoot();
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    const deletionFault = Object.assign(new Error('controlled workspace rm EIO'), { code: 'EIO' });
    const sentinel = path.join(workspace.home, 'remaining-after-rm-failure');
    fs.writeFileSync(sentinel, 'remaining-original-bytes');
    const actualRm = fs.promises.rm.bind(fs.promises);
    const rmSpy = vi.spyOn(fs.promises, 'rm').mockImplementation(async (target: any, ...args: any[]) => {
      if (path.resolve(String(target)) === path.resolve(workspace.root)) {
        fs.rmSync(path.join(workspace.root, '.chestnut', 'claws'), { recursive: true, force: true });
        throw deletionFault;
      }
      return actualRm(target, ...args);
    });
    let discarded = false;
    try {
      const failure = await finishConfigRepairCase(workspace, async () => 42).catch(error => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure.cause).toBe(deletionFault);
      expect(failure.message).toContain('Failed to clean up temp dir');
      expect(fs.readFileSync(sentinel, 'utf8')).toBe('remaining-original-bytes');
      expect(fs.existsSync(path.join(workspace.root, '.chestnut', 'claws'))).toBe(false);
      expect(inspectRetention(runRoot, workspace.root)).toMatchObject({
        kind: 'preserve', reasons: ['test_failed'],
      });
      rmSpy.mockRestore();
      discardControlledWorkspace(workspace);
      discarded = true;
    } finally {
      rmSpy.mockRestore();
      if (!discarded && !fs.existsSync(workspace.root)) untrackTempDir(workspace.root);
      await cleanupTempDir(path.dirname(runRoot));
    }
  });

  it('C19 independently reaps an unknown session without changing its original bytes', async () => {
    const runRoot = useIsolatedRunRoot();
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    const homeSentinel = path.join(workspace.home, 'unknown-session-home-bytes');
    fs.writeFileSync(homeSentinel, Buffer.from([0, 1, 2, 255]));
    let result: ConfigRepairSessionResult | undefined;
    let reaped = false;
    try {
      const failure = await runConfigRepairSession(workspace, [], [], new AbortController().signal, false, {
        mode: 'finite', lifetimeMs: 30_000,
        captureTarget: identity => {
          const captured = captureExecutionTarget(identity);
          if (captured.kind !== 'captured') throw new Error(`unexpected fixture capture: ${captured.kind}`);
          return { ...captured, kind: 'unknown', reason: 'controlled_C19_unknown' };
        },
      }).catch(error => error);
      expect(failure).toBeInstanceOf(ConfigRepairSessionError);
      result = (failure as ConfigRepairSessionError).result;
      expect(result.execution.capture?.kind).toBe('unknown');
      expect(result.execution.kind).toBe('unconfirmed');
      expect(fs.existsSync(result.exitedPath)).toBe(false);
      const readyFile = fs.readdirSync(workspace.root).find(name => name.startsWith('.session-ready-'));
      expect(readyFile).toBeDefined();
      const originalFiles = [
        path.join(workspace.root, readyFile!),
        result.evidencePath,
        path.join(workspace.root, '.chestnut', 'config.yaml'),
        homeSentinel,
      ];
      const originalBytes = originalFiles.map(file => fs.readFileSync(file));
      expect(originalBytes[3]).toEqual(Buffer.from([0, 1, 2, 255]));

      await cleanupTempDir(workspace.root);
      originalFiles.forEach((file, index) => {
        expect(fs.readFileSync(file)).toEqual(originalBytes[index]);
      });
      const owner = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
      expect(owner.status).toBe(0);
      const manifestPath = path.join(runRoot, 'manifest.json');
      fs.writeFileSync(manifestPath, JSON.stringify({
        invocationId: 'controlled-C19-unknown-session',
        pid: owner.pid,
        worktree: path.join(runRoot, 'removed-worktree'),
        startedAt: new Date().toISOString(),
        runRoot,
      }));
      const teardownSource = `
        import fs from 'node:fs';
        import { createRunRootTeardown } from ${JSON.stringify(externalGlobalSetupModuleUrl(runRoot))};
        const manifest = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
        await createRunRootTeardown(manifest)();
      `;
      const teardown = spawnSync(process.execPath, [
        '--experimental-transform-types', '--input-type=module', '-e', teardownSource, manifestPath,
      ], { encoding: 'utf8', timeout: EXTERNAL_CONSUMER_TIMEOUT_MS });
      expect(teardown.status, `${teardown.stdout}\n${teardown.stderr}`).toBe(1);
      expect(teardown.stderr).toContain('unconfirmed_process_group');
      originalFiles.forEach((file, index) => {
        expect(fs.readFileSync(file)).toEqual(originalBytes[index]);
      });

      const stale = new Date(Date.now() - RECLAIM_STALE_AGE_MS);
      fs.utimesSync(runRoot, stale, stale);
      const reclaimSource = `
        import { reclaimStaleRunRoots } from ${JSON.stringify(externalGlobalSetupModuleUrl(runRoot))};
        reclaimStaleRunRoots(process.argv[1], 'next-invocation');
      `;
      const reclaim = spawnSync(process.execPath, [
        '--experimental-transform-types', '--input-type=module', '-e', reclaimSource, path.dirname(runRoot),
      ], { encoding: 'utf8', timeout: EXTERNAL_CONSUMER_TIMEOUT_MS });
      expect(reclaim.status, `${reclaim.stdout}\n${reclaim.stderr}`).toBe(0);
      originalFiles.forEach((file, index) => {
        expect(fs.readFileSync(file)).toEqual(originalBytes[index]);
      });

      await reapControlledSession(workspace, result);
      reaped = true;
      expect(captureExecutionTarget({
        leaderPid: result.ready!.pid,
        processGroupId: result.ready!.processGroupId,
      }).kind).toBe('gone');
      expect(fs.existsSync(result.exitedPath)).toBe(true);
      originalFiles.forEach((file, index) => {
        expect(fs.readFileSync(file)).toEqual(originalBytes[index]);
      });
    } finally {
      if (reaped) discardControlledWorkspace(workspace);
      await cleanupTempDir(path.dirname(runRoot));
    }
  });

  it('C20 preserves the workspace when the independent reaper fails', async () => {
    const runRoot = useIsolatedRunRoot();
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    const reaperFault = Object.assign(new Error('controlled independent reaper EPERM'), { code: 'EPERM' });
    const sentinel = path.join(workspace.home, 'preserve-after-reaper-failure');
    fs.writeFileSync(sentinel, 'do-not-force-delete');
    const actualKill = process.kill.bind(process);
    let killSpy: ReturnType<typeof vi.spyOn> | undefined;
    let result: ConfigRepairSessionResult | undefined;
    let reaped = false;
    try {
      const failure = await runConfigRepairSession(workspace, [], [], new AbortController().signal, false, {
        mode: 'finite', lifetimeMs: 30_000,
        captureTarget: identity => {
          const captured = captureExecutionTarget(identity);
          if (captured.kind !== 'captured') throw new Error(`unexpected fixture capture: ${captured.kind}`);
          return { ...captured, kind: 'unknown', reason: 'controlled_C20_unknown' };
        },
      }).catch(error => error);
      expect(failure).toBeInstanceOf(ConfigRepairSessionError);
      result = (failure as ConfigRepairSessionError).result;
      const workerPid = result.ready!.pid;
      killSpy = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: NodeJS.Signals | 0) => {
        if ((pid === workerPid && signal === 0)
          || (pid === -workerPid && (signal === 'SIGTERM' || signal === 'SIGKILL'))) throw reaperFault;
        return actualKill(pid, signal);
      });
      const failedReap = await reapControlledSession(workspace, result).catch(error => error);
      expect(failedReap).toBeInstanceOf(AggregateError);
      expect(failedReap.errors.some((entry: unknown) => entry === reaperFault
        || (typeof entry === 'object' && entry !== null && 'error' in entry && entry.error === reaperFault))).toBe(true);
      expect(fs.readFileSync(sentinel, 'utf8')).toBe('do-not-force-delete');
      expect(fs.existsSync(result.evidencePath)).toBe(true);
      expect(captureExecutionTarget({ leaderPid: workerPid, processGroupId: workerPid }).kind).not.toBe('gone');

      killSpy.mockRestore();
      killSpy = undefined;
      await reapControlledSession(workspace, result);
      reaped = true;
      expect(captureExecutionTarget({ leaderPid: workerPid, processGroupId: workerPid }).kind).toBe('gone');
    } finally {
      killSpy?.mockRestore();
      if (reaped) discardControlledWorkspace(workspace);
      else console.warn(`[test cleanup] Preserved workspace after unrecovered independent reaper: ${workspace.root}`);
      await cleanupTempDir(path.dirname(runRoot));
    }
  });
});
