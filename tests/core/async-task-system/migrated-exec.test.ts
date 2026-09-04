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
import { createExecWithHandle, createExecTool, EXEC_TOOL_NAME, type ExecWithHandleArgs } from '../../../src/foundation/command-tool/exec.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { createPerTaskRegistry } from '../../../src/core/subagent/registry-helper.js';
import { makeExecContext } from '../../helpers/exec-context.js';
import { makeTaskSystemDeps } from '../../helpers/task-system.js';
import { TASKS_QUEUES_RESULTS_DIR, TASKS_QUEUES_RUNNING_DIR, TASKS_QUEUES_DONE_DIR, TASKS_QUEUES_FAILED_DIR } from '../../../src/core/async-task-system/dirs.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import { getProcessStartTime, isAlive, ProcessExecError, PROCESS_EXEC_DEFAULT_TIMEOUT_MS, type ExecHandle, type ExecResult, type ExecutionIdentity } from '../../../src/foundation/process-exec/index.js';
import { isProcessGroupAlive } from '../../../src/foundation/process-exec/execution-group.js';
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
    const doneFiles = await fs.readdir(path.join(tmpDir, TASKS_QUEUES_DONE_DIR));
    expect(doneFiles.some(name => name.endsWith('.json'))).toBe(true);
    expect(auditEvents.some(e => e[0] === TASK_AUDIT_EVENTS.EXEC_IDENTITY_CHECKPOINTED)).toBe(true);
    expect(auditEvents.some(e => e[0] === TASK_AUDIT_EVENTS.EXEC_CHECKPOINT_COMPLETED_SYNC)).toBe(true);
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

  it('writes exit.json marker when migrated process exits cleanly', async () => {
    const execWithHandle = createExecWithHandle();
    const tool = system.createAsyncExecWrapper({
      execWithHandle: (args, ctx) => execWithHandle(args, ctx),
      softTimeoutMs: 100,
    });

    // Release-file 门控进程退出（4f6c334f6 同文件先例）：保证软超时迁移必先于进程结束，
    // 消除高负载下 timer 延迟越过进程退出 → 同步路径无 fullTaskId 的 race。
    const releaseFile = path.join(tmpDir, 'release-clean-exit');
    const ctx = makeExecContext({ fs: nodeFs, workspaceDir: tmpDir });
    const result = await tool.execute({
      command: 'while [ ! -f release-clean-exit ]; do sleep 0.01; done; echo done',
    }, ctx);

    expect(result.success).toBe(true);
    const fullId = result.metadata?.fullTaskId as string;
    expect(fullId).toBeTruthy();
    const runningFile = path.join(tmpDir, TASKS_QUEUES_RUNNING_DIR, `${fullId}.json`);
    const exitMarkerFile = path.join(tmpDir, TASKS_QUEUES_RESULTS_DIR, fullId, 'exit.json');

    await fs.writeFile(releaseFile, 'go', 'utf-8');
    await waitUntilGone(runningFile, 5000);

    const exitMarker = JSON.parse(await fs.readFile(exitMarkerFile, 'utf-8'));
    expect(typeof exitMarker.completedAt).toBe('string');
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
    // phase 1269 Step E: v1 execution-group identity replaces migratedPid.
    const pid = task.migratedExecution.leaderPid as number;
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

    // phase 1269 Step E: caller abort awaits the L1 termination outcome and audits it.
    // The L1 abort listener fires first (registered at exec start), so the
    // shared in-flight outcome carries trigger=abort; the L4 context col
    // records the caller-abort origin.
    const termEvents = auditEvents.filter(e => e[0] === TASK_AUDIT_EVENTS.TASK_MIGRATED_EXEC_TERMINATION);
    expect(termEvents.length).toBe(1);
    expect(termEvents[0]).toContain('context=caller_abort');
    expect(termEvents[0]).toContain('trigger=abort');
    expect(termEvents[0].some(c => c === 'status=gone')).toBe(true);
  });

  it('persists v1 execution-group identity on migration (no legacy migratedPid write)', async () => {
    const execWithHandle = createExecWithHandle();
    const tool = system.createAsyncExecWrapper({
      execWithHandle: (args, ctx) => execWithHandle(args, ctx),
      softTimeoutMs: 100,
    });

    const ctx = makeExecContext({ fs: nodeFs, workspaceDir: tmpDir });
    const result = await tool.execute({ command: 'sleep 0.3 && echo done' }, ctx);
    expect(result.success).toBe(true);
    const fullId = result.metadata?.fullTaskId as string;

    const runningFile = path.join(tmpDir, TASKS_QUEUES_RUNNING_DIR, `${fullId}.json`);
    const task = JSON.parse(await fs.readFile(runningFile, 'utf-8'));

    expect(task.migratedPid).toBeUndefined();
    expect(task.migratedExecution).toBeDefined();
    expect(task.migratedExecution.version).toBe(1);
    expect(typeof task.migratedExecution.leaderPid).toBe('number');
    // detached spawn: the leader is its own process-group leader.
    expect(task.migratedExecution.processGroupId).toBe(task.migratedExecution.leaderPid);
    // OS start-time lookup is an optional forensic fact. It must never be
    // fabricated when `ps` cannot observe a just-spawned leader.
    if (task.migratedExecution.leaderStartTime !== undefined) {
      expect(task.migratedExecution.leaderStartTime).toEqual(expect.any(String));
      expect(task.migratedExecution.leaderStartTime.length).toBeGreaterThan(0);
    }

    await waitUntilGone(runningFile, 5000);
  });

  it('identity checkpoint failure terminates the execution group and audits the outcome', async () => {
    const execWithHandle = createExecWithHandle();
    const tool = system.createAsyncExecWrapper({
      execWithHandle: (args, ctx) => execWithHandle(args, ctx),
      softTimeoutMs: 100,
    });

    vi.spyOn(nodeFs, 'writeAtomicSync').mockImplementation(() => { throw new Error('disk full'); });

    const ctx = makeExecContext({ fs: nodeFs, workspaceDir: tmpDir });
    const result = await tool.execute({ command: 'sleep 30' }, ctx);

    expect(result.success).toBe(false);
    expect(result.content).toContain('Failed to checkpoint exec identity');

    const termEvents = auditEvents.filter(e => e[0] === TASK_AUDIT_EVENTS.TASK_MIGRATED_EXEC_TERMINATION);
    expect(termEvents.length).toBe(1);
    expect(termEvents[0]).toContain('context=identity_checkpoint_failed');
    expect(termEvents[0].some(c => c === 'status=gone')).toBe(true);

    // The terminated leader must actually be gone (outcome was awaited).
    const pidCol = termEvents[0].find(c => typeof c === 'string' && c.startsWith('leader_pid=')) as string;
    const leaderPid = Number(pidCol.split('=')[1]);
    expect(leaderPid).toBeGreaterThan(0);
    expect(isAlive(leaderPid)).toBe(false);
  });

  it('checkpoint file remains recoverable when short-id-index save fails', async () => {
    const execWithHandle = createExecWithHandle();
    const tool = system.createAsyncExecWrapper({
      execWithHandle: (args, ctx) => execWithHandle(args, ctx),
      softTimeoutMs: 100,
    });

    // The authoritative task file is durable before the rebuildable index.
    // If index persistence fails, keep the file for restart recovery.
    const saveSpy = vi.spyOn(InMemoryShortIdIndex.prototype, 'save').mockImplementation(() => {
      throw new Error('index write failed');
    });

    try {
      const ctx = makeExecContext({ fs: nodeFs, workspaceDir: tmpDir });
      const result = await tool.execute({ command: 'sleep 30' }, ctx);

      expect(result.success).toBe(false);
      expect(result.content).toContain('Failed to checkpoint exec identity');
      const runningFiles = await fs.readdir(path.join(tmpDir, TASKS_QUEUES_RUNNING_DIR));
      expect(runningFiles.some(name => name.endsWith('.json'))).toBe(true);
    } finally {
      saveSpy.mockRestore();
    }
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


describe('phase 1750: wrapper sync return path truncation', () => {
  let tmpDir: string;
  let nodeFs: NodeFileSystem;
  let system: AsyncTaskSystem;
  let audit: AuditLog;

  const BIG_SEQ_LINES = 5000;
  const bigCommand = `seq 1 ${BIG_SEQ_LINES}`;
  // seq 1 5000 → "1\n2\n...\n5000\n"（约 24KB > EXEC_MAX_OUTPUT 2000）
  const bigExpected = Array.from({ length: BIG_SEQ_LINES }, (_, i) => String(i + 1)).join('\n') + '\n';

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpDir = path.join(os.tmpdir(), `phase1750-wrapper-truncate-${randomUUID()}`);
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

  // persistOverflow 落盘到 ctx.syncDir/exec/<id>.md；ctx 必须带真实 syncDir（Step B §7 风险核对）
  function makeWrapperCtx() {
    return makeExecContext({
      fs: nodeFs,
      workspaceDir: tmpDir,
      syncDir: path.join(tmpDir, '.sync'),
    });
  }

  async function readOverflowFiles(): Promise<string[]> {
    const names = await fs.readdir(path.join(tmpDir, '.sync', 'exec')).catch(() => [] as string[]);
    return Promise.all(names.map(n => fs.readFile(path.join(tmpDir, '.sync', 'exec', n), 'utf8')));
  }

  it('pure sync (timeoutMs set) large output → truncated content + overflow file with full output', async () => {
    const execWithHandle = createExecWithHandle();
    const tool = system.createAsyncExecWrapper({
      execWithHandle: (args, ctx) => execWithHandle(args, ctx),
      softTimeoutMs: 10_000,
    });

    const result = await tool.execute({ command: bigCommand, timeoutMs: 5000 }, makeWrapperCtx());

    expect(result.success).toBe(true);
    // head 600 + tail 1400 截断协议
    expect(result.content).toMatch(/\[\.\.\.truncated \d+ bytes\.\.\.\]/);
    expect(result.content.startsWith(bigExpected.slice(0, 600))).toBe(true);
    expect(result.content).toContain(bigExpected.slice(-1400));
    expect(result.content).toContain(`Full output (${bigExpected.length} bytes) saved`);
    expect(result.content).toContain('read:');
    expect(result.content).toContain('.sync/exec/');
    // 中间部分（第 2500 行）被截掉、全文不进 tool_result
    expect(result.content).not.toContain('\n2500\n');
    expect(result.content).not.toBe(bigExpected);

    // 溢出文件存在、frontmatter 记录 source/content_length、正文 = 完整 output
    const overflowFiles = await readOverflowFiles();
    expect(overflowFiles).toHaveLength(1);
    const match = overflowFiles[0].match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    expect(match).not.toBeNull();
    expect(match![1]).toContain('source: exec_overflow');
    expect(match![1]).toContain(`content_length: ${bigExpected.length}`);
    expect(match![2]).toBe(bigExpected);
  });

  it('pure sync (timeoutMs set) small output → unchanged content, no overflow file', async () => {
    const execWithHandle = createExecWithHandle();
    const tool = system.createAsyncExecWrapper({
      execWithHandle: (args, ctx) => execWithHandle(args, ctx),
      softTimeoutMs: 10_000,
    });

    const result = await tool.execute({ command: 'echo small-output', timeoutMs: 5000 }, makeWrapperCtx());

    expect(result.success).toBe(true);
    expect(result.content).toBe('small-output\n');
    expect(await readOverflowFiles()).toHaveLength(0);
  });

  it('sync→async fast completion large output → truncated content + result.txt keeps full output + moved to done', async () => {
    const execWithHandle = createExecWithHandle();
    const tool = system.createAsyncExecWrapper({
      execWithHandle: (args, ctx) => execWithHandle(args, ctx),
      softTimeoutMs: 10_000,
    });

    // 不传 timeoutMs → sync→async 模式；命令 10s 内完成 → sync completion 分支
    const result = await tool.execute({ command: bigCommand }, makeWrapperCtx());

    expect(result.success).toBe(true);
    expect(result.metadata).toBeUndefined();
    expect(result.content).toMatch(/\[\.\.\.truncated \d+ bytes\.\.\.\]/);
    expect(result.content).not.toContain('\n2500\n');

    // result.txt 检查点完整保留全文
    const resultDirs = await fs.readdir(path.join(tmpDir, TASKS_QUEUES_RESULTS_DIR));
    expect(resultDirs).toHaveLength(1);
    const resultTxt = await fs.readFile(
      path.join(tmpDir, TASKS_QUEUES_RESULTS_DIR, resultDirs[0], 'result.txt'),
      'utf8',
    );
    expect(resultTxt).toBe(bigExpected);

    // task 经 moveTaskToDone
    const doneFiles = await fs.readdir(path.join(tmpDir, TASKS_QUEUES_DONE_DIR));
    expect(doneFiles.some(name => name.endsWith('.json'))).toBe(true);
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

  it('should kill the whole process group and deliver partial output after hard timeout', async () => {
    const execWithHandle = createExecWithHandle();
    const tool = system.createAsyncExecWrapper({
      execWithHandle: (args, ctx) => execWithHandle(args, ctx),
      softTimeoutMs: 100,
      migratedHardTimeoutMs: 500,
    });

    const ctx = makeExecContext({ fs: nodeFs, workspaceDir: tmpDir });
    // Background descendant in the same process group must not survive.
    const result = await tool.execute({ command: 'sleep 30 & while true; do echo tick; sleep 0.05; done' }, ctx);

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

    // phase 1269 Step E: hard timeout terminates via L1 — outcome audited,
    // and the WHOLE group (leader + background descendant) must be gone.
    const termEvents = auditEvents.filter(e => e[0] === TASK_AUDIT_EVENTS.TASK_MIGRATED_EXEC_TERMINATION);
    expect(termEvents.length).toBe(1);
    expect(termEvents[0]).toContain('context=hard_timeout');
    expect(termEvents[0].some(c => c === 'status=gone')).toBe(true);

    const runningTask = JSON.parse(await fs.readFile(doneFile, 'utf-8'));
    const exec = runningTask.migratedExecution as { leaderPid: number; processGroupId: number };
    expect(isAlive(exec.leaderPid)).toBe(false);
    expect(isProcessGroupAlive(exec.processGroupId)).toBe(false);
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
    const releaseFile = path.join(tmpDir, 'release-quick-exit');
    const result = await tool.execute({
      command: 'while [ ! -f release-quick-exit ]; do sleep 0.01; done; echo quick',
    }, ctx);

    expect(result.success).toBe(true);
    const shortId = result.metadata?.taskId as string;
    const fullId = result.metadata?.fullTaskId as string;
    expect(shortId).toBeTruthy();
    expect(fullId).toBeTruthy();
    const runningFile = path.join(tmpDir, TASKS_QUEUES_RUNNING_DIR, `${fullId}.json`);
    const resultFile = path.join(tmpDir, TASKS_QUEUES_RESULTS_DIR, fullId, 'result.txt');

    await fs.writeFile(releaseFile, 'go', 'utf-8');
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


/**
 * Phase 1272 Step C — migrated exec 单一 absolute deadline
 *
 * One absolute deadline is generated before spawn and flows end to end:
 * L1 `deadlineAtMs` arg === persisted `migratedDeadlineMs` === runtime hard
 * timer source === recovery source. The L1/L4 deadline race is classified by
 * the persisted wall-clock fact, not by a single closure boolean, and a
 * termination before the deadline keeps its structured L1 facts.
 */
describe('phase 1272 Step C: single migrated deadline end to end', () => {
  let tmpDir: string;
  let nodeFs: NodeFileSystem;
  let audit: AuditLog;
  let auditEvents: Array<[string, ...(string | number)[]]>;
  let system: AsyncTaskSystem;

  const SOFT_TIMEOUT_MS = 100;
  const HARD_TIMEOUT_MS = 5_000;

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpDir = path.join(os.tmpdir(), `phase1272-single-deadline-${randomUUID()}`);
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
    vi.useRealTimers();
    await system.shutdown(1000).catch(() => { /* silent */ });
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent cleanup */ });
  });

  /**
   * Fake L1 handle backed by a REAL detached child (identity/unref/stream ops
   * in the wrapper hit the OS), whose promise rejects like an L1 timeout at a
   * caller-chosen moment. terminate() really SIGTERMs the group.
   */
  function makeFakeL1Handle(opts: {
    rejectAfterMs: number;
    makeError: (identity: ExecutionIdentity) => ProcessExecError;
  }): { handle: ExecHandle; identity: ExecutionIdentity } {
    const proc = spawn('sh', ['-c', 'sleep 30'], { cwd: tmpDir, detached: true });
    const identity: ExecutionIdentity = { leaderPid: proc.pid!, processGroupId: proc.pid! };
    const promise = new Promise<ExecResult>((_, reject) => {
      const timer = setTimeout(() => reject(opts.makeError(identity)), opts.rejectAfterMs);
      timer.unref?.();
    });
    const handle: ExecHandle = {
      child: proc,
      identity,
      promise,
      terminate: async (trigger = 'caller_requested') => {
        try {
          process.kill(-identity.processGroupId, 'SIGTERM');
        } catch { /* already gone */ }
        return {
          status: 'gone',
          identity,
          trigger,
          termSent: true,
          killSent: false,
          completedAt: new Date().toISOString(),
        };
      },
    };
    return { handle, identity };
  }

  it('L1 arg and persisted task carry the exact same absolute deadline (single source)', async () => {
    const base = createExecWithHandle();
    let capturedArgs: ExecWithHandleArgs | undefined;
    const tool = system.createAsyncExecWrapper({
      execWithHandle: async (args, ctx) => {
        capturedArgs = args;
        return base(args, ctx);
      },
      softTimeoutMs: SOFT_TIMEOUT_MS,
      migratedHardTimeoutMs: HARD_TIMEOUT_MS,
    });

    const ctx = makeExecContext({ fs: nodeFs, workspaceDir: tmpDir });
    const result = await tool.execute({ command: 'sleep 0.3 && echo done' }, ctx);
    expect(result.success).toBe(true);
    const fullId = result.metadata?.fullTaskId as string;

    const runningFile = path.join(tmpDir, TASKS_QUEUES_RUNNING_DIR, `${fullId}.json`);
    const task = JSON.parse(await fs.readFile(runningFile, 'utf-8'));

    expect(capturedArgs?.timeoutMs).toBeUndefined();
    expect(typeof capturedArgs?.deadlineAtMs).toBe('number');
    // Strict equality — no approximation, no recomputation at migration time.
    expect(task.migratedDeadlineMs).toBe(capturedArgs?.deadlineAtMs);

    await waitUntilGone(runningFile, 5000);
  });

  it('L1 winning the deadline race is still classified as migrated hard timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });

    // The fake L1 handle rejects at the EXACT deadline the wrapper passes —
    // its timer is registered before the monitor's hard timer for the same
    // due instant, so L1 provably wins the race while the L4 closure boolean
    // stays false. Classification must come from the persisted deadline.
    let captured: { handle: ExecHandle; identity: ExecutionIdentity } | undefined;
    const tool = system.createAsyncExecWrapper({
      execWithHandle: async (args) => {
        const deadlineAtMs = args.deadlineAtMs;
        if (deadlineAtMs === undefined) {
          throw new Error('expected an absolute deadline arg from the wrapper');
        }
        captured = makeFakeL1Handle({
          rejectAfterMs: Math.max(0, deadlineAtMs - Date.now()),
          makeError: (identity) => new ProcessExecError({
            message: `Command timed out at absolute deadline ${deadlineAtMs}`,
            exitCode: null,
            killed: true,
            termination: {
              status: 'gone',
              trigger: 'timeout',
              termSent: true,
              killSent: false,
              identity,
            },
          }),
        });
        return captured.handle;
      },
      softTimeoutMs: SOFT_TIMEOUT_MS,
      migratedHardTimeoutMs: HARD_TIMEOUT_MS,
    });

    const ctx = makeExecContext({ fs: nodeFs, workspaceDir: tmpDir });
    const resultP = tool.execute({ command: 'sleep 30' }, ctx);
    await vi.advanceTimersByTimeAsync(SOFT_TIMEOUT_MS + 50); // migrate
    const result = await resultP;
    expect(result.success).toBe(true);
    const fullId = result.metadata?.fullTaskId as string;
    const runningFile = path.join(tmpDir, TASKS_QUEUES_RUNNING_DIR, `${fullId}.json`);

    // Reach the deadline: the fake L1 timer (registered first) fires ahead of
    // the monitor's hard timer for the same instant.
    await vi.advanceTimersByTimeAsync(HARD_TIMEOUT_MS);
    vi.useRealTimers();
    await waitUntilGone(runningFile, 5000);

    const resultFile = path.join(tmpDir, TASKS_QUEUES_RESULTS_DIR, fullId, 'result.txt');
    const output = await fs.readFile(resultFile, 'utf-8');
    // Canonical hard-timeout wording even though the L4 timer did not win —
    // no degradation to `exited with error`.
    expect(output).toContain(`[Process timed out: Migrated process timed out after ${HARD_TIMEOUT_MS}ms]`);
    expect(output).not.toContain('exited with error');

    const termEvents = auditEvents.filter(e => e[0] === TASK_AUDIT_EVENTS.TASK_MIGRATED_EXEC_TERMINATION);
    expect(termEvents.length).toBe(1);
    expect(termEvents[0]).toContain('context=hard_timeout');
    expect(termEvents[0]).toContain('trigger=timeout');
    expect(termEvents[0].some(c => c === 'status=gone')).toBe(true);
    expect(auditEvents.some(e => e[0] === TASK_AUDIT_EVENTS.TASK_MIGRATED_TIMED_OUT)).toBe(true);
  }, 20_000);

  it('termination before the deadline preserves the structured L1 fact (no flat drop)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });

    const REJECT_AFTER_MS = 200; // after migration (100ms), long before the 5.1s deadline
    const captured = makeFakeL1Handle({
      rejectAfterMs: REJECT_AFTER_MS,
      makeError: (identity) => new ProcessExecError({
        message: 'Command output exceeded 1 MB limit',
        exitCode: null,
        killed: true,
        maxBufferExceeded: true,
        termination: {
          status: 'gone',
          trigger: 'max_buffer',
          termSent: true,
          killSent: false,
          identity,
        },
      }),
    });
    const tool = system.createAsyncExecWrapper({
      execWithHandle: async () => captured.handle,
      softTimeoutMs: SOFT_TIMEOUT_MS,
      migratedHardTimeoutMs: HARD_TIMEOUT_MS,
    });

    try {
      const ctx = makeExecContext({ fs: nodeFs, workspaceDir: tmpDir });
      const resultP = tool.execute({ command: 'sleep 30' }, ctx);
      await vi.advanceTimersByTimeAsync(SOFT_TIMEOUT_MS + 50); // migrate
      const result = await resultP;
      expect(result.success).toBe(true);
      const fullId = result.metadata?.fullTaskId as string;
      const runningFile = path.join(tmpDir, TASKS_QUEUES_RUNNING_DIR, `${fullId}.json`);

      await vi.advanceTimersByTimeAsync(REJECT_AFTER_MS); // pre-deadline rejection fires
      vi.useRealTimers();
      await waitUntilGone(runningFile, 5000);

      const resultFile = path.join(tmpDir, TASKS_QUEUES_RESULTS_DIR, fullId, 'result.txt');
      const output = await fs.readFile(resultFile, 'utf-8');
      expect(output).toMatch(/\[Process exited with error:/);
      expect(output).not.toContain('[Process timed out:');

      // The structured termination fact survives under its own context.
      const termEvents = auditEvents.filter(e => e[0] === TASK_AUDIT_EVENTS.TASK_MIGRATED_EXEC_TERMINATION);
      expect(termEvents.length).toBe(1);
      expect(termEvents[0]).toContain('context=pre_deadline_termination');
      expect(termEvents[0]).toContain('trigger=max_buffer');
      expect(termEvents[0].some(c => c === 'status=gone')).toBe(true);
      expect(auditEvents.some(e => e[0] === TASK_AUDIT_EVENTS.TASK_MIGRATED_TIMED_OUT)).toBe(false);
    } finally {
      // The wrapper does not terminate on this branch (L1 already reported
      // gone); the REAL child behind the fake handle is ours to clean up.
      if (isAlive(captured.identity.leaderPid)) {
        await captured.handle.terminate();
      }
    }
  }, 20_000);
});

/**
 * Phase 1272 Step C — production 30s-default survival regression (real OS)
 *
 * The single direct production regression for the reported bug: with NO agent
 * timeoutMs, a migrated command must cross the production L1 default (30s)
 * alive and finish naturally before the single absolute deadline. Uses the
 * real createExecWithHandle() — no L1 timer mocks, no __testMinTimeoutMs.
 */
describe('phase 1272 Step C: production 30s-default survival regression (real OS)', () => {
  let tmpDir: string;
  let nodeFs: NodeFileSystem;
  let audit: AuditLog;
  let auditEvents: Array<[string, ...(string | number)[]]>;
  let system: AsyncTaskSystem;

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpDir = path.join(os.tmpdir(), `phase1272-30s-regression-${randomUUID()}`);
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

  // Phase 1305：全量默认跳过（31s 真实等待、占全量墙钟 1/3）；保真语义不动。
  // 手动回归：VITEST_RUN_SLOW=1 npx vitest run tests/core/async-task-system/migrated-exec.test.ts
  it.skipIf(process.env.VITEST_RUN_SLOW !== '1')('migrated exec crosses the production 30s L1 default and completes naturally before the deadline', async () => {
    // Named budget derivation (no magic numbers):
    const SURVIVE_BEYOND_L1_DEFAULT_MS = 1_000; // command provably outlives the production default
    const COMMAND_SLEEP_MS = PROCESS_EXEC_DEFAULT_TIMEOUT_MS + SURVIVE_BEYOND_L1_DEFAULT_MS; // 31_000
    const HARD_SLACK_AFTER_EXIT_MS = 4_000; // absolute deadline lands after the natural exit
    const SOFT_TIMEOUT_MS = 100;
    const MONITOR_SLACK_MS = 5_000; // waitUntilGone budget beyond the deadline
    const SENTINEL = 'PHASE1272_SURVIVED_30S';

    const base = createExecWithHandle();
    let capturedArgs: ExecWithHandleArgs | undefined;
    const tool = system.createAsyncExecWrapper({
      execWithHandle: async (args, ctx) => {
        capturedArgs = args;
        return base(args, ctx);
      },
      softTimeoutMs: SOFT_TIMEOUT_MS,
      // deadline = spawn + soft + hard = spawn + COMMAND_SLEEP + slack
      migratedHardTimeoutMs: COMMAND_SLEEP_MS + HARD_SLACK_AFTER_EXIT_MS - SOFT_TIMEOUT_MS,
    });

    const ctx = makeExecContext({ fs: nodeFs, workspaceDir: tmpDir });
    const startedAt = Date.now();
    const result = await tool.execute(
      { command: `sleep ${COMMAND_SLEEP_MS / 1000} && echo ${SENTINEL}` },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.content).toMatch(/Execution moved to async\. Task:/);

    const fullId = result.metadata?.fullTaskId as string;
    const runningFile = path.join(tmpDir, TASKS_QUEUES_RUNNING_DIR, `${fullId}.json`);
    const runningTask = JSON.parse(await fs.readFile(runningFile, 'utf-8'));
    // The same absolute deadline fact reached L1 and the disk verbatim.
    expect(runningTask.migratedDeadlineMs).toBe(capturedArgs?.deadlineAtMs);

    await waitUntilGone(runningFile, COMMAND_SLEEP_MS + HARD_SLACK_AFTER_EXIT_MS + MONITOR_SLACK_MS);

    // The command genuinely crossed the production 30s L1 default.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(PROCESS_EXEC_DEFAULT_TIMEOUT_MS);

    const resultFile = path.join(tmpDir, TASKS_QUEUES_RESULTS_DIR, fullId, 'result.txt');
    const output = await fs.readFile(resultFile, 'utf-8');
    expect(output).toContain(SENTINEL);
    // No internal 30s kill, no hard timeout, no error marker at all.
    expect(output).not.toContain(`Command timed out after ${PROCESS_EXEC_DEFAULT_TIMEOUT_MS}ms`);
    expect(output).not.toContain('[Process timed out:');
    expect(output).not.toContain('exited with error');
    expect(auditEvents.some(e => e[0] === TASK_AUDIT_EVENTS.TASK_MIGRATED_TIMED_OUT)).toBe(false);
    expect(auditEvents.filter(e => e[0] === TASK_AUDIT_EVENTS.TASK_MIGRATED_EXEC_TERMINATION).length).toBe(0);

    const doneFile = path.join(tmpDir, TASKS_QUEUES_DONE_DIR, `${fullId}.json`);
    expect(await fs.stat(doneFile).then(() => true).catch(() => false)).toBe(true);
  }, 60_000); // wall ~31s: command sleep + monitor/delivery slack
});
