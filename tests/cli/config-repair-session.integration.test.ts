import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import * as path from 'node:path';
import {
  ConfigRepairSessionError,
  createConfigRepairWorkspace,
  finishConfigRepairCase,
  runConfigRepairSession,
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
const isolatedHosts: string[] = [];
const originalRunRoot = process.env.CHESTNUT_RUN_ROOT;

function useIsolatedRunRoot(): string {
  const host = createTrackedTempDirSync('config-repair-session-isolated-');
  isolatedHosts.push(host);
  const runRoot = path.join(host, 'run-root');
  fs.mkdirSync(runRoot);
  process.env.CHESTNUT_RUN_ROOT = runRoot;
  return runRoot;
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
    const host = isolatedHosts.pop()!;
    untrackTempDir(host);
    fs.rmSync(host, { recursive: true, force: true });
  }
  await Promise.resolve();
});

describe('config repair session process lifecycle', () => {
  it('successful finite session cleans its scoped cwd', async context => {
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
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
    isolatedHosts.push(host);
    const runRoot = path.join(host, "run root's nested");
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
    let target: Parameters<typeof terminateExecutionTarget>[0] | undefined;
    try {
      const failure = await runConfigRepairSession(workspace, [], [], new AbortController().signal, false, {
        mode: 'finite', lifetimeMs: 5_000,
        readReady: () => { throw fault; },
      }).catch(error => error);
      expect(failure).toBeInstanceOf(ConfigRepairSessionError);
      const sessionFailure = failure as ConfigRepairSessionError;
      expect(sessionFailure.cause).toBe(fault);
      expect(sessionFailure.result.execution.kind).toBe('unconfirmed');
      expect(sessionFailure.result.execution.capture).toBeUndefined();
      expect(inspectRetention(runRoot, workspace.root)).toMatchObject({
        kind: 'preserve', reasons: ['unconfirmed_process_group'],
      });

      const readyFile = fs.readdirSync(workspace.root).find(name => name.startsWith('.session-ready-'));
      expect(readyFile).toBeDefined();
      const ready = JSON.parse(fs.readFileSync(path.join(workspace.root, readyFile!), 'utf8')) as {
        pid: number;
        processGroupId: number;
      };
      const capture = captureExecutionTarget({
        leaderPid: ready.pid,
        processGroupId: ready.processGroupId,
      });
      expect(capture.kind).toBe('captured');
      if (!('target' in capture)) throw new Error('worker target missing');
      target = capture.target;
      const terminal = await terminateExecutionTarget(target, 'caller_requested');
      expect(terminal.status).toBe('gone');
      target = undefined;
    } finally {
      if (target) await terminateExecutionTarget(target, 'caller_requested');
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

      expect(failure).toBe(primary);
      expect(identity).toBeDefined();
      if (!identity) throw new Error('ready identity was not captured');
      expect(captureExecutionTarget(identity).kind).toBe('gone');
    });
  });

  it('wrapper exit with a live group preserves its cwd until the owned child exits', async () => {
    const runRoot = useIsolatedRunRoot();
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    try {
      const failure = await runConfigRepairSession(workspace, [], [], new AbortController().signal, false, {
        mode: 'orphan', lifetimeMs: 5_000,
      }).catch(error => error);
      expect(failure).toBeInstanceOf(ConfigRepairSessionError);
      const result = (failure as ConfigRepairSessionError).result;
      expect(result.execution.kind).toBe('unconfirmed');
      expect(result.ready?.groupChildPid).toBeGreaterThan(1);
      expect(fs.existsSync(workspace.root)).toBe(true);
      expect(inspectRetention(runRoot, workspace.root)).toMatchObject({
        kind: 'preserve', reasons: ['unconfirmed_process_group'],
      });
      const capture = result.execution.capture;
      expect(capture && 'target' in capture).toBe(true);
      if (!capture || !('target' in capture)) throw new Error('missing owned group target');
      const terminal = await terminateExecutionTarget(capture.target, 'caller_requested');
      expect(terminal.status).toBe('gone');
      await waitForExitFile(result.exitedPath);
    } finally {
      discardControlledWorkspace(workspace);
      await cleanupTempDir(path.dirname(runRoot));
    }
  });

  it('ordinary assertion failure preserves repair evidence in the same scope', async () => {
    const runRoot = useIsolatedRunRoot();
    const workspace = createConfigRepairWorkspace('http://127.0.0.1:1/v1');
    const primary = new Error('controlled repair assertion failure');
    try {
      const failure = await finishConfigRepairCase(workspace, async () => {
        await Promise.resolve();
        throw primary;
      }).catch(error => error);
      expect(failure).toBe(primary);
      expect(fs.existsSync(path.join(workspace.root, '.chestnut/llm/config.yaml'))).toBe(true);
      expect(inspectRetention(runRoot, workspace.root)).toMatchObject({
        kind: 'preserve', reasons: ['test_failed'],
      });
    } finally {
      discardControlledWorkspace(workspace);
      await cleanupTempDir(path.dirname(runRoot));
    }
  });
});
