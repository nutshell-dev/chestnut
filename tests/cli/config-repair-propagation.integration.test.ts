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

async function stopOwnedMotion(workspace: ConfigRepairWorkspace, signal: AbortSignal): Promise<void> {
  const stopped = await runConfigRepairCli(workspace, ['motion', 'stop'], signal);
  expect(stopped.status, `${stopped.stdout}\n${stopped.stderr}`).toBe(0);
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
        if (pid !== undefined) {
          await stopOwnedMotion(workspace, context.signal);
          await waitForPidGone(pid);
        }
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
        if (pid !== undefined) {
          await stopOwnedMotion(workspace, context.signal);
          await waitForPidGone(pid);
        }
      });
    });
  }, PROPAGATION_TEST_TIMEOUT_MS);
});
