/**
 * Phase 770 — AsyncTaskSystem migrated exec + createAsyncExecWrapper tests
 *
 * Covers:
 * - executeToolTask migrated path: monitor running process, deliver result.
 * - PID reuse detection via startTime mismatch.
 * - createAsyncExecWrapper: sync completion, soft timeout migration,
 *   partial output persistence, running task registration.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';

import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { executeToolTask } from '../../../src/core/async-task-system/tool-executor.js';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { InMemoryShortIdIndex } from '../../../src/core/async-task-system/short-id-index.js';
import { createExecWithHandle, createExecTool, EXEC_TOOL_NAME } from '../../../src/foundation/command-tool/exec.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { createPerTaskRegistry } from '../../../src/core/subagent/registry-helper.js';
import { makeExecContext } from '../../helpers/exec-context.js';
import { makeTaskSystemDeps } from '../../helpers/task-system.js';
import { TASKS_QUEUES_RESULTS_DIR, TASKS_QUEUES_RUNNING_DIR, TASKS_QUEUES_DONE_DIR, TASKS_QUEUES_FAILED_DIR } from '../../../src/core/async-task-system/dirs.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import { getProcessStartTime, isAlive } from '../../../src/foundation/process-exec/index.js';
import * as startTimeModule from '../../../src/foundation/process-exec/process-starttime.js';
import type { ToolTask, TaskId } from '../../../src/core/async-task-system/types.js';
import { makeTaskId } from '../../../src/core/async-task-system/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

function sleepMs(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function makeMockAudit(): { audit: AuditLog; events: Array<[string, ...(string | number)[]]> } {
  const events: Array<[string, ...(string | number)[]]> = [];
  const audit: AuditLog = {
    write: (type: string, ...cols: (string | number)[]) => { events.push([type, ...cols]); },
    preview: (s: string) => s,
    message: (s: string) => s,
    summary: (s: string) => s,
  };
  return { audit, events };
}

function makeBaseToolTask(id: TaskId): ToolTask {
  return {
    kind: 'tool',
    id,
    toolName: 'exec',
    args: { command: 'sleep 0.5' },
    parentClawDir: '/tmp/test-claw',
    parentClawId: 'test-claw',
    createdAt: new Date().toISOString(),
    isIdempotent: false,
    maxRetries: 0,
    retryCount: 0,
  };
}

async function waitUntilGone(file: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fs.access(file);
    } catch {
      return;
    }
    await sleepMs(50);
  }
  throw new Error(`Timed out waiting for ${file} to disappear`);
}

describe('executeToolTask migrated path', () => {
  let tmpDir: string;
  let nodeFs: NodeFileSystem;
  let audit: AuditLog;
  let auditEvents: Array<[string, ...(string | number)[]]>;

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpDir = path.join(os.tmpdir(), `migrated-exec-${randomUUID()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: tmpDir });
    const mockAudit = makeMockAudit();
    audit = mockAudit.audit;
    auditEvents = mockAudit.events;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent cleanup */ });
  });

  it('should wait for migrated process to exit and deliver persisted result', async () => {
    const proc = spawn('sleep', ['0.4'], { stdio: 'ignore' });
    const pid = proc.pid!;
    const startTime = getProcessStartTime(pid);

    const taskId = makeTaskId(randomUUID());
    const partialOutput = 'partial output before migration\n';
    await fs.mkdir(path.join(tmpDir, TASKS_QUEUES_RESULTS_DIR, taskId), { recursive: true });
    await fs.writeFile(path.join(tmpDir, TASKS_QUEUES_RESULTS_DIR, taskId, 'result.txt'), partialOutput);

    const task: ToolTask = {
      ...makeBaseToolTask(taskId),
      mode: 'migrated',
      migratedPid: pid,
      migratedStartTime: startTime,
    };

    // executeToolTask assumes the running file already exists (moved from pending).
    await fs.mkdir(path.join(tmpDir, TASKS_QUEUES_RUNNING_DIR), { recursive: true });
    await fs.writeFile(path.join(tmpDir, TASKS_QUEUES_RUNNING_DIR, `${taskId}.json`), JSON.stringify(task));

    const controller = new AbortController();
    await executeToolTask(
      task,
      () => Promise.resolve({ success: true, content: 'unused' }),
      controller.signal,
      {
        fs: nodeFs,
        auditWriter: audit,
        retryBaseDelayMs: 50,
        moveTaskToDone: async (id) => {
          await fs.mkdir(path.join(tmpDir, TASKS_QUEUES_DONE_DIR), { recursive: true });
          await fs.rename(
            path.join(tmpDir, TASKS_QUEUES_RUNNING_DIR, `${id}.json`),
            path.join(tmpDir, TASKS_QUEUES_DONE_DIR, `${id}.json`),
          );
        },
        moveTaskToFailed: async (id) => {
          await fs.mkdir(path.join(tmpDir, TASKS_QUEUES_FAILED_DIR), { recursive: true });
          await fs.rename(
            path.join(tmpDir, TASKS_QUEUES_RUNNING_DIR, `${id}.json`),
            path.join(tmpDir, TASKS_QUEUES_FAILED_DIR, `${id}.json`),
          );
        },
      },
    );

    const doneFile = path.join(tmpDir, TASKS_QUEUES_DONE_DIR, `${taskId}.json`);
    expect(await fs.stat(doneFile).then(() => true).catch(() => false)).toBe(true);
    expect(auditEvents.some(e => e[0] === TASK_AUDIT_EVENTS.TASK_MIGRATED_COMPLETED)).toBe(true);
  });

  it('should detect PID reuse via startTime mismatch and fail task', async () => {
    // Use a live process so getProcessStartTime returns a real value, then mock
    // it to simulate a different process occupying the same PID.
    const proc = spawn('sleep', ['5'], { stdio: 'ignore' });
    const pid = proc.pid!;

    try {
      vi.spyOn(startTimeModule, 'getProcessStartTime').mockReturnValue('Mon Jan 01 00:00:00 2020');

      const taskId = makeTaskId(randomUUID());
      const task: ToolTask = {
        ...makeBaseToolTask(taskId),
        mode: 'migrated',
        migratedPid: pid,
        migratedStartTime: 'Sat May 18 10:30:00 2026',
      };

      await fs.mkdir(path.join(tmpDir, TASKS_QUEUES_RUNNING_DIR), { recursive: true });
      await fs.writeFile(path.join(tmpDir, TASKS_QUEUES_RUNNING_DIR, `${taskId}.json`), JSON.stringify(task));

      const controller = new AbortController();
      await executeToolTask(
        task,
        () => Promise.resolve({ success: true, content: 'unused' }),
        controller.signal,
        {
          fs: nodeFs,
          auditWriter: audit,
          retryBaseDelayMs: 50,
          moveTaskToDone: async () => { throw new Error('should not move to done'); },
          moveTaskToFailed: async (id) => {
            await fs.mkdir(path.join(tmpDir, TASKS_QUEUES_FAILED_DIR), { recursive: true });
            await fs.writeFile(path.join(tmpDir, TASKS_QUEUES_FAILED_DIR, `${id}.json`), JSON.stringify(task));
          },
        },
      );

      const failedFile = path.join(tmpDir, TASKS_QUEUES_FAILED_DIR, `${taskId}.json`);
      expect(await fs.stat(failedFile).then(() => true).catch(() => false)).toBe(true);
      expect(auditEvents.some(e => e[0] === TASK_AUDIT_EVENTS.TASK_MIGRATED_PID_REUSED)).toBe(true);
    } finally {
      proc.kill('SIGKILL');
      vi.restoreAllMocks();
    }
  });
});

describe('createAsyncExecWrapper', () => {
  let tmpDir: string;
  let nodeFs: NodeFileSystem;
  let audit: AuditLog;
  let auditEvents: Array<[string, ...(string | number)[]]>;
  let system: AsyncTaskSystem;

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpDir = path.join(os.tmpdir(), `async-exec-wrapper-${randomUUID()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: tmpDir });
    const mockAudit = makeMockAudit();
    audit = mockAudit.audit;
    auditEvents = mockAudit.events;

    system = new AsyncTaskSystem(tmpDir, nodeFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      ...makeTaskSystemDeps(),
    });
    await system.initialize();
  });

  afterEach(async () => {
    await system.shutdown(1000).catch(() => { /* silent */ });
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent cleanup */ });
  });

  it('should return sync result for short command', async () => {
    const execWithHandle = createExecWithHandle();
    const tool = system.createAsyncExecWrapper({
      execWithHandle: (args, ctx) => execWithHandle(args, ctx),
      softTimeoutMs: 10_000,
    });

    const ctx = makeExecContext({ fs: nodeFs, workspaceDir: tmpDir });
    const result = await tool.execute({ command: 'echo hi' }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('hi');
  });

  it('should return taskId for long command (soft timeout) and not kill process', async () => {
    const execWithHandle = createExecWithHandle();
    const tool = system.createAsyncExecWrapper({
      execWithHandle: (args, ctx) => execWithHandle(args, ctx),
      softTimeoutMs: 100,
    });

    const ctx = makeExecContext({ fs: nodeFs, workspaceDir: tmpDir });
    const result = await tool.execute({ command: 'sleep 0.5 && echo done' }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toMatch(/Execution moved to async\. Task:/);
    expect(result.metadata).toMatchObject({ async: true, migrated: true });
    expect(typeof result.metadata?.taskId).toBe('string');
    expect(typeof result.metadata?.fullTaskId).toBe('string');

    const shortId = result.metadata?.taskId as string;
    const fullId = result.metadata?.fullTaskId as string;

    // Agent-visible content uses the shortId.
    expect(result.content).toContain(shortId);

    // Running task file should exist immediately after migration (persistence uses fullId).
    const runningFile = path.join(tmpDir, TASKS_QUEUES_RUNNING_DIR, `${fullId}.json`);
    expect(await fs.stat(runningFile).then(() => true).catch(() => false)).toBe(true);

    // Migrated audit should have been emitted.
    expect(auditEvents.some(e => e[0] === TASK_AUDIT_EVENTS.TASK_MIGRATED_REGISTERED)).toBe(true);

    // Wait for the background chain to finish and move the running file to done.
    await waitUntilGone(runningFile, 5000);

    // Result file is written by the background chain once the process exits (persistence uses fullId).
    const resultFile = path.join(tmpDir, TASKS_QUEUES_RESULTS_DIR, fullId, 'result.txt');
    expect(await fs.stat(resultFile).then(() => true).catch(() => false)).toBe(true);

    const doneFile = path.join(tmpDir, TASKS_QUEUES_DONE_DIR, `${fullId}.json`);
    expect(await fs.stat(doneFile).then(() => true).catch(() => false)).toBe(true);
  });

  it('should deliver full output after migration', async () => {
    const execWithHandle = createExecWithHandle();
    const tool = system.createAsyncExecWrapper({
      execWithHandle: (args, ctx) => execWithHandle(args, ctx),
      softTimeoutMs: 500,
    });

    // Produce 20 lines over ~2s; migration should fire around line 5.
    const command = 'for i in $(seq 1 20); do echo "line $i"; sleep 0.1; done';
    const ctx = makeExecContext({ fs: nodeFs, workspaceDir: tmpDir });
    const result = await tool.execute({ command }, ctx);

    expect(result.success).toBe(true);
    const shortId = result.metadata?.taskId as string;
    const fullId = result.metadata?.fullTaskId as string;
    const runningFile = path.join(tmpDir, TASKS_QUEUES_RUNNING_DIR, `${fullId}.json`);
    const resultFile = path.join(tmpDir, TASKS_QUEUES_RESULTS_DIR, fullId, 'result.txt');

    // Wait for the background chain to finish and move the task to done.
    await waitUntilGone(runningFile, 5000);

    const output = await fs.readFile(resultFile, 'utf-8');
    for (let i = 1; i <= 20; i += 1) {
      expect(output).toContain(`line ${i}`);
    }
  });

  it('should include post-migration output', async () => {
    const execWithHandle = createExecWithHandle();
    const tool = system.createAsyncExecWrapper({
      execWithHandle: (args, ctx) => execWithHandle(args, ctx),
      softTimeoutMs: 100,
    });

    const ctx = makeExecContext({ fs: nodeFs, workspaceDir: tmpDir });
    const result = await tool.execute({ command: 'echo before && sleep 0.5 && echo after' }, ctx);

    expect(result.success).toBe(true);
    const shortId = result.metadata?.taskId as string;
    const fullId = result.metadata?.fullTaskId as string;
    const runningFile = path.join(tmpDir, TASKS_QUEUES_RUNNING_DIR, `${fullId}.json`);
    const resultFile = path.join(tmpDir, TASKS_QUEUES_RESULTS_DIR, fullId, 'result.txt');

    await waitUntilGone(runningFile, 5000);

    const output = await fs.readFile(resultFile, 'utf-8');
    expect(output).toContain('before');
    expect(output).toContain('after');
  });

  it('should deliver output when process exits with error', async () => {
    const execWithHandle = createExecWithHandle();
    const tool = system.createAsyncExecWrapper({
      execWithHandle: (args, ctx) => execWithHandle(args, ctx),
      softTimeoutMs: 100,
    });

    const ctx = makeExecContext({ fs: nodeFs, workspaceDir: tmpDir });
    const result = await tool.execute({ command: 'echo partial && sleep 0.3 && exit 1' }, ctx);

    expect(result.success).toBe(true);
    const shortId = result.metadata?.taskId as string;
    const fullId = result.metadata?.fullTaskId as string;
    const runningFile = path.join(tmpDir, TASKS_QUEUES_RUNNING_DIR, `${fullId}.json`);
    const resultFile = path.join(tmpDir, TASKS_QUEUES_RESULTS_DIR, fullId, 'result.txt');

    await waitUntilGone(runningFile, 5000);

    const output = await fs.readFile(resultFile, 'utf-8');
    expect(output).toContain('partial');
    expect(output).toMatch(/Process exited with error/i);
  });

  it('should only expose async wrapper in full profile', () => {
    const execWithHandle = createExecWithHandle();
    const tool = system.createAsyncExecWrapper({
      execWithHandle: (args, ctx) => execWithHandle(args, ctx),
      softTimeoutMs: 100,
    });

    expect(tool.profiles).toEqual(['full']);
  });

  it('should handle execWithHandle throwing', async () => {
    const tool = system.createAsyncExecWrapper({
      execWithHandle: async () => { throw new Error('spawn denied'); },
      softTimeoutMs: 100,
    });

    const ctx = makeExecContext({ fs: nodeFs, workspaceDir: tmpDir });
    await expect(tool.execute({ command: 'true' }, ctx)).rejects.toThrow('spawn denied');
  });

  it('should respect AbortSignal', async () => {
    const execWithHandle = createExecWithHandle();
    const tool = system.createAsyncExecWrapper({
      execWithHandle: (args, ctx) => execWithHandle(args, ctx),
      softTimeoutMs: 10_000,
    });

    const controller = new AbortController();
    const ctx = makeExecContext({ fs: nodeFs, workspaceDir: tmpDir, signal: controller.signal });

    // Start a long command and abort immediately.
    const execPromise = tool.execute({ command: 'sleep 5' }, ctx);
    controller.abort();

    const result = await execPromise;
    expect(result.success).toBe(false);
    expect(result.content).toMatch(/aborted/i);
  });

  it('should not kill process when original signal aborts after migration', async () => {
    const execWithHandle = createExecWithHandle();
    const tool = system.createAsyncExecWrapper({
      execWithHandle: (args, ctx) => execWithHandle(args, ctx),
      softTimeoutMs: 100,
    });

    const controller = new AbortController();
    const ctx = makeExecContext({ fs: nodeFs, workspaceDir: tmpDir, signal: controller.signal });

    const result = await tool.execute({ command: 'sleep 0.8 && echo survived' }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toMatch(/Execution moved to async\. Task:/);

    const shortId = result.metadata?.taskId as string;
    const fullId = result.metadata?.fullTaskId as string;
    const runningFile = path.join(tmpDir, TASKS_QUEUES_RUNNING_DIR, `${fullId}.json`);
    const task = JSON.parse(await fs.readFile(runningFile, 'utf-8'));
    const pid = task.migratedPid as number;
    expect(pid).toBeGreaterThan(0);

    // Abort the original turn signal after migration.
    controller.abort();
    await sleepMs(150);

    // The process must still be alive because we detached the proxy signal.
    expect(isAlive(pid)).toBe(true);

    // Wait for the process to finish naturally and the background chain to deliver output.
    await waitUntilGone(runningFile, 5000);

    const resultFile = path.join(tmpDir, TASKS_QUEUES_RESULTS_DIR, fullId, 'result.txt');
    const output = await fs.readFile(resultFile, 'utf-8');
    expect(output).toContain('survived');
  });

  it('should still kill process when signal aborts before migration', async () => {
    const execWithHandle = createExecWithHandle();
    const tool = system.createAsyncExecWrapper({
      execWithHandle: (args, ctx) => execWithHandle(args, ctx),
      softTimeoutMs: 10_000,
    });

    const controller = new AbortController();
    const ctx = makeExecContext({ fs: nodeFs, workspaceDir: tmpDir, signal: controller.signal });

    const execPromise = tool.execute({ command: 'sleep 5' }, ctx);
    // Give spawn a moment to start before aborting.
    await sleepMs(100);
    controller.abort();

    const result = await execPromise;
    expect(result.success).toBe(false);
    expect(result.content).toMatch(/aborted/i);
  });
});

describe('timeoutMs dual-mode (Phase 776)', () => {
  let tmpDir: string;
  let nodeFs: NodeFileSystem;
  let system: AsyncTaskSystem;
  let audit: AuditLog;

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpDir = path.join(os.tmpdir(), `timeout-dual-mode-${randomUUID()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: tmpDir });
    const mockAudit = makeMockAudit();
    audit = mockAudit.audit;

    system = new AsyncTaskSystem(tmpDir, nodeFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      ...makeTaskSystemDeps(),
    });
    await system.initialize();
  });

  afterEach(async () => {
    await system.shutdown(1000).catch(() => { /* silent */ });
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent cleanup */ });
  });

  it('should return sync result when timeoutMs is set and command completes in time', async () => {
    const execWithHandle = createExecWithHandle();
    const tool = system.createAsyncExecWrapper({
      execWithHandle: (args, ctx) => execWithHandle(args, ctx),
      softTimeoutMs: 10_000,
    });

    const ctx = makeExecContext({ fs: nodeFs, workspaceDir: tmpDir });
    const result = await tool.execute({ command: 'echo hello', timeoutMs: 5000 }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('hello');
    expect(result.metadata).toBeUndefined();
  });

  it('should kill process and return error when timeoutMs is set and exceeded', async () => {
    const execWithHandle = createExecWithHandle();
    const tool = system.createAsyncExecWrapper({
      execWithHandle: (args, ctx) => execWithHandle(args, ctx),
      softTimeoutMs: 10_000,
    });

    const ctx = makeExecContext({ fs: nodeFs, workspaceDir: tmpDir });
    // processExec clamps short timeouts to 1000ms, so expect a 1s hard timeout.
    const HARD_TIMEOUT_MS = 1000;
    const result = await tool.execute({ command: 'sleep 5', timeoutMs: HARD_TIMEOUT_MS }, ctx);

    expect(result.success).toBe(false);
    expect(result.content).toMatch(/Error: Command timed out after 1000ms/);
    expect(result.content).toContain('[command]: sleep 5');
  });

  it('should auto-migrate when timeoutMs is not set and command runs long', async () => {
    const execWithHandle = createExecWithHandle();
    const tool = system.createAsyncExecWrapper({
      execWithHandle: (args, ctx) => execWithHandle(args, ctx),
      softTimeoutMs: 100,
    });

    const ctx = makeExecContext({ fs: nodeFs, workspaceDir: tmpDir });
    const result = await tool.execute({ command: 'sleep 0.5 && echo done' }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toMatch(/Execution moved to async\. Task:/);
    expect(result.metadata).toMatchObject({ async: true, migrated: true });
    expect(typeof result.metadata?.taskId).toBe('string');
  });

  it('should return sync result when timeoutMs is not set and command is fast', async () => {
    const execWithHandle = createExecWithHandle();
    const tool = system.createAsyncExecWrapper({
      execWithHandle: (args, ctx) => execWithHandle(args, ctx),
      softTimeoutMs: 10_000,
    });

    const ctx = makeExecContext({ fs: nodeFs, workspaceDir: tmpDir });
    const result = await tool.execute({ command: 'echo fast' }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('fast');
    expect(result.metadata).toBeUndefined();
  });
});


describe('subagent exec registry (Phase 773)', () => {
  let tmpDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpDir = path.join(os.tmpdir(), `subagent-exec-${randomUUID()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: tmpDir });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent cleanup */ });
  });

  it('should use plain sync exec in subagent profile and not migrate', async () => {
    const plainExec = createExecTool();
    const baseRegistry = createToolRegistry();
    baseRegistry.register(plainExec);

    // Subagent registry mirrors what spawn-system creates from the base registry.
    const subagentRegistry = createPerTaskRegistry(baseRegistry, 'subagent');
    const execTool = subagentRegistry.get(EXEC_TOOL_NAME);

    expect(execTool).toBeDefined();
    expect(execTool!.profiles).toContain('subagent');

    const ctx = makeExecContext({ fs: nodeFs, workspaceDir: tmpDir, profile: 'subagent' });
    const result = await execTool!.execute({ command: 'sleep 0.15 && echo subagent-sync' }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('subagent-sync');
    expect(result.metadata).toBeUndefined();
  });

  it('should exclude async wrapper from subagent profile', async () => {
    const plainExec = createExecTool();
    const baseRegistry = createToolRegistry();
    baseRegistry.register(plainExec);

    const subagentTools = baseRegistry.getForProfile('subagent');
    const execTool = subagentTools.find(t => t.name === EXEC_TOOL_NAME);

    expect(execTool).toBeDefined();
    // The async wrapper only declares 'full', so the subagent profile must keep the plain tool.
    expect(execTool!.profiles).toContain('subagent');
  });
});


describe('migrated process hard timeout (Phase 777)', () => {
  let tmpDir: string;
  let nodeFs: NodeFileSystem;
  let audit: AuditLog;
  let auditEvents: Array<[string, ...(string | number)[]]>;
  let system: AsyncTaskSystem;

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpDir = path.join(os.tmpdir(), `migrated-hard-timeout-${randomUUID()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: tmpDir });
    const mockAudit = makeMockAudit();
    audit = mockAudit.audit;
    auditEvents = mockAudit.events;

    system = new AsyncTaskSystem(tmpDir, nodeFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      ...makeTaskSystemDeps(),
    });
    await system.initialize();
  });

  afterEach(async () => {
    await system.shutdown(1000).catch(() => { /* silent */ });
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent cleanup */ });
  });

  it('should kill process and deliver partial output after hard timeout', async () => {
    const execWithHandle = createExecWithHandle();
    const tool = system.createAsyncExecWrapper({
      execWithHandle: (args, ctx) => execWithHandle(args, ctx),
      softTimeoutMs: 100,
      migratedHardTimeoutMs: 500,
    });

    const ctx = makeExecContext({ fs: nodeFs, workspaceDir: tmpDir });
    const result = await tool.execute({ command: 'while true; do echo tick; sleep 0.05; done' }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toMatch(/Execution moved to async\. Task:/);
    const shortId = result.metadata?.taskId as string;
    const fullId = result.metadata?.fullTaskId as string;

    const runningFile = path.join(tmpDir, TASKS_QUEUES_RUNNING_DIR, `${fullId}.json`);
    await waitUntilGone(runningFile, 5000);

    const resultFile = path.join(tmpDir, TASKS_QUEUES_RESULTS_DIR, fullId, 'result.txt');
    const output = await fs.readFile(resultFile, 'utf-8');
    expect(output).toContain('tick');
    expect(output).toMatch(/\[Process timed out: Migrated process timed out after 500ms\]/);

    const doneFile = path.join(tmpDir, TASKS_QUEUES_DONE_DIR, `${fullId}.json`);
    expect(await fs.stat(doneFile).then(() => true).catch(() => false)).toBe(true);

    expect(auditEvents.some(e => e[0] === TASK_AUDIT_EVENTS.TASK_MIGRATED_TIMED_OUT)).toBe(true);

    // Process should have been killed.
    const runningTask = JSON.parse(await fs.readFile(doneFile, 'utf-8'));
    expect(isAlive(runningTask.migratedPid as number)).toBe(false);
  });

  it('should deliver full output when process exits before hard timeout', async () => {
    const execWithHandle = createExecWithHandle();
    const tool = system.createAsyncExecWrapper({
      execWithHandle: (args, ctx) => execWithHandle(args, ctx),
      softTimeoutMs: 100,
      migratedHardTimeoutMs: 5000,
    });

    const ctx = makeExecContext({ fs: nodeFs, workspaceDir: tmpDir });
    const result = await tool.execute({ command: 'sleep 0.2 && echo done' }, ctx);

    expect(result.success).toBe(true);
    const shortId = result.metadata?.taskId as string;
    const fullId = result.metadata?.fullTaskId as string;
    const runningFile = path.join(tmpDir, TASKS_QUEUES_RUNNING_DIR, `${fullId}.json`);
    const resultFile = path.join(tmpDir, TASKS_QUEUES_RESULTS_DIR, fullId, 'result.txt');

    await waitUntilGone(runningFile, 5000);

    const output = await fs.readFile(resultFile, 'utf-8');
    expect(output).toContain('done');
    expect(output).not.toMatch(/\[Process timed out:/);
    expect(auditEvents.some(e => e[0] === TASK_AUDIT_EVENTS.TASK_MIGRATED_TIMED_OUT)).toBe(false);
  });

  it('should not trigger hard timeout when process exits quickly after migration', async () => {
    const execWithHandle = createExecWithHandle();
    const tool = system.createAsyncExecWrapper({
      execWithHandle: (args, ctx) => execWithHandle(args, ctx),
      softTimeoutMs: 100,
      migratedHardTimeoutMs: 5000,
    });

    const ctx = makeExecContext({ fs: nodeFs, workspaceDir: tmpDir });
    const result = await tool.execute({ command: 'sleep 0.12 && echo quick' }, ctx);

    expect(result.success).toBe(true);
    const shortId = result.metadata?.taskId as string;
    const fullId = result.metadata?.fullTaskId as string;
    const runningFile = path.join(tmpDir, TASKS_QUEUES_RUNNING_DIR, `${fullId}.json`);
    const resultFile = path.join(tmpDir, TASKS_QUEUES_RESULTS_DIR, fullId, 'result.txt');

    await waitUntilGone(runningFile, 5000);

    const output = await fs.readFile(resultFile, 'utf-8');
    expect(output).toContain('quick');
    expect(output).not.toMatch(/\[Process timed out:/);
  });
});


describe('Phase 833: migrated exec stream events', () => {
  let tmpDir: string;
  let nodeFs: NodeFileSystem;
  let audit: AuditLog;
  let system: AsyncTaskSystem;
  let streamEvents: Array<Record<string, unknown>>;

  beforeEach(async () => {
    streamEvents = [];
    const events = streamEvents;
    const streamLog = { write: (entry: Record<string, unknown>) => { events.push(entry); } };
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpDir = path.join(os.tmpdir(), `migrated-exec-stream-${randomUUID()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: tmpDir });
    const mockAudit = makeMockAudit();
    audit = mockAudit.audit;

    system = new AsyncTaskSystem(tmpDir, nodeFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      ...makeTaskSystemDeps(),
    });
    system.setParentStreamLog(streamLog);
    await system.initialize();
  });

  afterEach(async () => {
    await system.shutdown(1000).catch(() => { /* silent */ });
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent cleanup */ });
  });

  it('emits task_started when command migrates to background', async () => {
    const execWithHandle = createExecWithHandle();
    const tool = system.createAsyncExecWrapper({
      execWithHandle: (args, ctx) => execWithHandle(args, ctx),
      softTimeoutMs: 100,
    });

    const ctx = makeExecContext({ fs: nodeFs, workspaceDir: tmpDir });
    const result = await tool.execute({ command: 'sleep 0.3 && echo done' }, ctx);

    expect(result.success).toBe(true);
    const shortId = result.metadata?.taskId as string;
    const fullId = result.metadata?.fullTaskId as string;

    const started = streamEvents.find(e => e.type === 'task_started');
    expect(started).toBeDefined();
    expect(started?.taskId).toBe(shortId);
    expect(started?.fullTaskId).toBe(fullId);
    expect(started?.taskKind).toBe('exec_migrated');
    expect(started?.command).toBe('sleep 0.3 && echo done');
    expect(typeof started?.startedAt).toBe('number');
  });

  it('emits task_completed after migrated process finishes', async () => {
    const execWithHandle = createExecWithHandle();
    const tool = system.createAsyncExecWrapper({
      execWithHandle: (args, ctx) => execWithHandle(args, ctx),
      softTimeoutMs: 100,
    });

    const ctx = makeExecContext({ fs: nodeFs, workspaceDir: tmpDir });
    const result = await tool.execute({ command: 'sleep 0.2 && echo done' }, ctx);

    expect(result.success).toBe(true);
    const shortId = result.metadata?.taskId as string;
    const fullId = result.metadata?.fullTaskId as string;

    const runningFile = path.join(tmpDir, TASKS_QUEUES_RUNNING_DIR, `${fullId}.json`);
    await waitUntilGone(runningFile, 5000);

    const completed = streamEvents.find(e => e.type === 'task_completed');
    expect(completed).toBeDefined();
    expect(completed?.taskId).toBe(shortId);
    expect(completed?.fullTaskId).toBe(fullId);
    expect(completed?.taskKind).toBe('exec_migrated');
  });

  it('truncates long commands in task_started event', async () => {
    const execWithHandle = createExecWithHandle();
    const tool = system.createAsyncExecWrapper({
      execWithHandle: (args, ctx) => execWithHandle(args, ctx),
      softTimeoutMs: 100,
    });

    const longCommand = 'sleep 0.3 && echo ' + 'x'.repeat(200);
    const ctx = makeExecContext({ fs: nodeFs, workspaceDir: tmpDir });
    const result = await tool.execute({ command: longCommand }, ctx);

    expect(result.success).toBe(true);

    const started = streamEvents.find(e => e.type === 'task_started') as Record<string, unknown> | undefined;
    expect(started).toBeDefined();
    const command = started!.command as string;
    expect(command.length).toBeLessThanOrEqual(83); // 80 + '...'
    expect(command.endsWith('...')).toBe(true);
  });

  it('does not emit task_started for sync completion', async () => {
    const execWithHandle = createExecWithHandle();
    const tool = system.createAsyncExecWrapper({
      execWithHandle: (args, ctx) => execWithHandle(args, ctx),
      softTimeoutMs: 10_000,
    });

    const ctx = makeExecContext({ fs: nodeFs, workspaceDir: tmpDir });
    const result = await tool.execute({ command: 'echo hi' }, ctx);

    expect(result.success).toBe(true);
    expect(streamEvents.some(e => e.type === 'task_started')).toBe(false);
    expect(streamEvents.some(e => e.type === 'task_completed')).toBe(false);
  });
});
