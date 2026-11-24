import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createConfigRepairWorkspace,
  finishConfigRepairCase,
  readConfigRepairRaw,
  runConfigRepairCli,
  runConfigRepairSession,
  startConfigRepairServer,
  type ConfigRepairServer,
  type ConfigRepairWorkspace,
} from '../helpers/config-repair-session.js';
import { withCleanupPreservingError } from '../utils/child-process.js';
import {
  getActiveDir,
  makeDaemonDir,
  PID_FILE,
} from '../../src/foundation/process-manager/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import {
  createLLMApplicationStore,
  createLLMConfiguration,
  createLLMNotificationStore,
  snapshotLLMConfig,
  type LLMApplicationFact,
} from '../../src/core/llm-configuration/index.js';

const PROPAGATION_TEST_TIMEOUT_MS = 90_000;
const APPLICATION_WAIT_TIMEOUT_MS = 20_000;
const PROCESS_WAIT_TIMEOUT_MS = 5_000;
const CLEANUP_STOP_TIMEOUT_MS = 30_000;
const POLL_MS = 25;
const fsFactory = (baseDir: string) => new NodeFileSystem({ baseDir });
const deps = { fsFactory };
let server: ConfigRepairServer;

beforeAll(async () => {
  server = await startConfigRepairServer();
});

afterAll(async () => {
  await server.close();
});

function writeWorkspaceCredential(workspace: ConfigRepairWorkspace): void {
  const directory = path.join(workspace.root, '.chestnut', 'llm');
  fs.chmodSync(directory, 0o700);
  const file = path.join(directory, 'credentials.yaml');
  fs.writeFileSync(file, 'version: 1\nrefs:\n  PHASE2221_INTEGRATION_KEY: local-fixture-only\n');
  fs.chmodSync(file, 0o600);
}

async function runCommand(workspace: ConfigRepairWorkspace, args: string[], signal: AbortSignal) {
  const result = await runConfigRepairCli(workspace, args, signal);
  expect(result.status, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`).toBe(0);
  return result;
}

function daemonPid(stdout: string): number {
  const match = stdout.match(/PID:\s*(\d+)/);
  if (!match) throw new Error(`daemon PID missing from output: ${stdout}`);
  return Number(match[1]);
}

async function waitForPidGone(pid: number): Promise<void> {
  const deadline = Date.now() + PROCESS_WAIT_TIMEOUT_MS;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    if (Date.now() >= deadline) throw new Error(`daemon PID did not exit: ${pid}`);
    await new Promise<void>(resolve => setTimeout(resolve, POLL_MS));
  }
}

async function withRoot<T>(root: string, read: () => T): Promise<T> {
  const original = process.env.CHESTNUT_ROOT;
  process.env.CHESTNUT_ROOT = root;
  try {
    return await read();
  } finally {
    if (original === undefined) delete process.env.CHESTNUT_ROOT;
    else process.env.CHESTNUT_ROOT = original;
  }
}

async function waitForApplication(root: string): Promise<{
  fact: LLMApplicationFact;
  publishStates: boolean[];
}> {
  return withRoot(root, async () => {
    const store = createLLMApplicationStore(deps);
    const publishStates: boolean[] = [];
    const deadline = Date.now() + APPLICATION_WAIT_TIMEOUT_MS;
    for (;;) {
      const fact = store.read('motion');
      if (fact?.revision === '2' && fact.outcome === 'applied') {
        if (publishStates.at(-1) !== fact.publish_pending) publishStates.push(fact.publish_pending);
        if (!fact.publish_pending) return { fact, publishStates };
      }
      if (Date.now() >= deadline) throw new Error(`rev2 application not settled: ${JSON.stringify(fact)}`);
      await new Promise<void>(resolve => setTimeout(resolve, POLL_MS));
    }
  });
}

async function readOperationalIdentity(root: string): Promise<string> {
  return withRoot(root, () => snapshotLLMConfig(createLLMConfiguration(deps).loadSnapshot()).operationalIdentity);
}

async function repair(workspace: ConfigRepairWorkspace, signal: AbortSignal): Promise<void> {
  const outcome = await runConfigRepairSession(workspace, ['config', 'provider', 'repair', 'main'], [
    { prompt: /> : $/, value: '3' },
    { prompt: /New model \(b = back\): $/, value: 'after-repair' },
  ], signal);
  expect(outcome.status).toBe(0);
  expect(outcome.execution.kind).toBe('gone');
  expect(readConfigRepairRaw(workspace.root).document.revision).toBe(2);
}

async function stopOwnedMotion(workspace: ConfigRepairWorkspace): Promise<void> {
  // Work cancellation and cleanup cancellation are independent: a cancelled
  // caller must not prevent the owned daemon from being stopped.
  const cleanupSignal = AbortSignal.timeout(CLEANUP_STOP_TIMEOUT_MS);
  const stopped = await runConfigRepairCli(workspace, ['motion', 'stop'], cleanupSignal);
  expect(stopped.status, `${stopped.stdout}\n${stopped.stderr}`).toBe(0);
}

function activeDaemonPidFile(workspace: ConfigRepairWorkspace): string {
  const daemonDir = makeDaemonDir(path.join(workspace.root, '.chestnut', 'motion'));
  return path.join(getActiveDir(daemonDir), PID_FILE);
}

function readActiveDaemonPid(workspace: ConfigRepairWorkspace): number | undefined {
  const file = activeDaemonPidFile(workspace);
  if (!fs.existsSync(file)) return undefined;
  const record = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: unknown };
  return typeof record.pid === 'number' && Number.isSafeInteger(record.pid) && record.pid > 1
    ? record.pid
    : undefined;
}

async function stopMotionAndConfirm(
  workspace: ConfigRepairWorkspace,
  returnedPid?: number,
): Promise<void> {
  // A start result can be lost after the daemon has already published its
  // generation. Read that owned record instead of depending on a returned PID.
  const recordedPid = returnedPid ?? readActiveDaemonPid(workspace);
  await stopOwnedMotion(workspace);
  if (recordedPid !== undefined) await waitForPidGone(recordedPid);
  else expect(fs.existsSync(activeDaemonPidFile(workspace))).toBe(false);
}

describe('real CLI repair save notify and Motion application', () => {
  it('online daemon applies the saved revision and settles publication', async context => {
    const workspace = createConfigRepairWorkspace(server.baseUrl);
    writeWorkspaceCredential(workspace);
    await finishConfigRepairCase(workspace, async () => {
      let pid: number | undefined;
      await withCleanupPreservingError(async () => {
        await runCommand(workspace, ['init'], context.signal);
        await runCommand(workspace, ['motion', 'init'], context.signal);
        const started = await runCommand(workspace, ['motion', 'daemon'], context.signal);
        pid = daemonPid(started.stdout);
        await repair(workspace, context.signal);

        const notification = await withRoot(workspace.root, () =>
          createLLMNotificationStore(deps).read('2', 'motion'));
        expect(notification).toMatchObject({ revision: '2', target: 'motion', status: 'sent' });
        const { fact, publishStates } = await waitForApplication(workspace.root);
        const identity = await readOperationalIdentity(workspace.root);
        expect(fact).toMatchObject({
          claw_id: 'motion',
          process_id: pid,
          revision: '2',
          identity,
          outcome: 'applied',
          publish_pending: false,
          last_applied_revision: '2',
          last_applied_identity: identity,
        });
        expect(publishStates.at(-1)).toBe(false);
        expect(server.requests.some(request => request.model === 'after-repair')).toBe(true);
      }, async () => {
        await stopMotionAndConfirm(workspace, pid);
      });
    });
  }, PROPAGATION_TEST_TIMEOUT_MS);

  it('offline repair does not start a daemon; explicit start applies the saved revision', async context => {
    const workspace = createConfigRepairWorkspace(server.baseUrl);
    writeWorkspaceCredential(workspace);
    await finishConfigRepairCase(workspace, async () => {
      let pid: number | undefined;
      await withCleanupPreservingError(async () => {
        await runCommand(workspace, ['init'], context.signal);
        await runCommand(workspace, ['motion', 'init'], context.signal);
        await repair(workspace, context.signal);

        const notification = await withRoot(workspace.root, () =>
          createLLMNotificationStore(deps).read('2', 'motion'));
        expect(notification).toMatchObject({ revision: '2', target: 'motion', status: 'offline' });
        expect(await withRoot(workspace.root, () => createLLMApplicationStore(deps).read('motion')))
          .toBeUndefined();

        const started = await runCommand(workspace, ['motion', 'daemon'], context.signal);
        pid = daemonPid(started.stdout);
        const { fact } = await waitForApplication(workspace.root);
        const identity = await readOperationalIdentity(workspace.root);
        expect(fact).toMatchObject({
          process_id: pid,
          revision: '2',
          identity,
          outcome: 'applied',
          publish_pending: false,
        });
      }, async () => {
        await stopMotionAndConfirm(workspace, pid);
      });
    });
  }, PROPAGATION_TEST_TIMEOUT_MS);

  it('cleanup after work cancellation stops the known daemon PID', async () => {
    const workspace = createConfigRepairWorkspace(server.baseUrl);
    writeWorkspaceCredential(workspace);
    await finishConfigRepairCase(workspace, async () => {
      const controller = new AbortController();
      const primary = new Error('controlled work cancellation');
      let pid: number | undefined;
      const failure = await withCleanupPreservingError(async () => {
        await runCommand(workspace, ['init'], controller.signal);
        await runCommand(workspace, ['motion', 'init'], controller.signal);
        const started = await runCommand(workspace, ['motion', 'daemon'], controller.signal);
        pid = daemonPid(started.stdout);
        controller.abort(primary);
        throw primary;
      }, async () => {
        await stopMotionAndConfirm(workspace, pid);
      }).catch(error => error);

      expect(failure).toBe(primary);
      expect(pid).toBeGreaterThan(1);
      if (pid === undefined) throw new Error('daemon was not started');
      await waitForPidGone(pid);
    });
  }, PROPAGATION_TEST_TIMEOUT_MS);

  it('cleanup after start result delivery failure stops the daemon without a returned PID', async () => {
    const workspace = createConfigRepairWorkspace(server.baseUrl);
    writeWorkspaceCredential(workspace);
    await finishConfigRepairCase(workspace, async () => {
      const controller = new AbortController();
      const primary = new Error('controlled start result delivery failure');
      let returnedPid: number | undefined;
      let recordedPid: number | undefined;
      const failure = await withCleanupPreservingError(async () => {
        await runCommand(workspace, ['init'], controller.signal);
        await runCommand(workspace, ['motion', 'init'], controller.signal);
        const started = await runConfigRepairCli(workspace, ['motion', 'daemon'], controller.signal);
        expect(started.status).toBe(0);
        recordedPid = readActiveDaemonPid(workspace);
        expect(recordedPid).toBeGreaterThan(1);
        controller.abort(primary);
        // The real start succeeded, but its result never reaches the caller.
        throw primary;
      }, async () => {
        await stopMotionAndConfirm(workspace, returnedPid);
      }).catch(error => error);

      expect(failure).toBe(primary);
      expect(returnedPid).toBeUndefined();
      expect(recordedPid).toBeGreaterThan(1);
      if (recordedPid === undefined) throw new Error('daemon record was not published');
      await waitForPidGone(recordedPid);
    });
  }, PROPAGATION_TEST_TIMEOUT_MS);

  it('cleanup after a pre-start failure does not invent or skip workspace stop', async () => {
    const workspace = createConfigRepairWorkspace(server.baseUrl);
    writeWorkspaceCredential(workspace);
    await finishConfigRepairCase(workspace, async () => {
      const controller = new AbortController();
      const primary = new Error('controlled pre-start failure');
      const failure = await withCleanupPreservingError(async () => {
        await runCommand(workspace, ['init'], controller.signal);
        await runCommand(workspace, ['motion', 'init'], controller.signal);
        controller.abort(primary);
        throw primary;
      }, async () => {
        await stopMotionAndConfirm(workspace);
      }).catch(error => error);

      expect(failure).toBe(primary);
      expect(readActiveDaemonPid(workspace)).toBeUndefined();
    });
  }, PROPAGATION_TEST_TIMEOUT_MS);
});
