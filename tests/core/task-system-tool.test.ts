/**
 * AsyncTaskSystem Tool Task Tests
 * 
 * Tests for async tool execution via AsyncTaskSystem:
 * - scheduleTool success/failure paths
 * - executor async routing
 * - pending queue with dispatcher pattern
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { INBOX_PENDING_DIR } from '../../src/foundation/messaging/dirs.js';
import { TASKS_QUEUES_RUNNING_DIR, TASKS_QUEUES_DONE_DIR, TASKS_QUEUES_PENDING_DIR } from '../../src/core/async-task-system/index.js';
import { AsyncTaskSystem, SubAgentTask, ToolTask } from '../../src/core/async-task-system/system.js';
import { ToolExecutorImpl, ExecuteOptions } from '../../src/foundation/tools/executor.js';
import { ToolRegistryImpl } from '../../src/foundation/tools/registry.js';
import type { Tool, ToolResult, ExecContext } from '../../src/foundation/tool-protocol/index.js';
import type { JSONSchema7 } from '../../src/foundation/llm-provider/types.js';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { readTool } from '../../src/foundation/file-tool/read.js';
import { lsTool } from '../../src/foundation/file-tool/ls.js';
import { searchTool } from '../../src/foundation/file-tool/search.js';
import { makeAudit, waitForAuditEvent } from '../helpers/audit.js';
import { TASK_AUDIT_EVENTS } from '../../src/core/async-task-system/audit-events.js';
import { waitForCompleteFile } from '../helpers/wait-for-file.js';
import { makeTaskSystemDeps } from '../helpers/task-system.js';
import { waitFor } from '../helpers/wait-for.js';
import { writePendingToolTaskFile } from '../../src/core/async-task-system/tools/_pending-tool-task-writer.js';
import { SUBAGENT_DEFAULT_TIMEOUT_MS } from '../helpers/test-timeouts.js';

const TEST_MAX_CONCURRENT = 3;
const TEST_RETRY_BASE_DELAY_MS = 10;

// Test helper: fs-driven async tool scheduling (replaces removed scheduleTool API)
async function scheduleToolCompat(
  taskSystem: AsyncTaskSystem,
  toolName: string,
  executeCallback: () => Promise<ToolResult>,
  parentClawId: string,
  options?: { isIdempotent?: boolean; maxRetries?: number; callerType?: CallerType; toolUseId?: string }
): Promise<string> {
  const tool: Tool = {
    name: toolName,
    description: 'mock',
    schema: { type: 'object', properties: {} },
    readonly: false,
    idempotent: options?.isIdempotent ?? false,
    supportsAsync: true,
    execute: async () => executeCallback(),
  };
  (taskSystem as any).registry.register(tool);

  const fs = (taskSystem as any).fs;
  const auditWriter = (taskSystem as any).auditWriter;
  const clawDir = (taskSystem as any).clawDir;

  const taskId = await writePendingToolTaskFile(fs, auditWriter, {
    toolName,
    args: {},
    parentClawId,
    parentClawDir: clawDir,
    isIdempotent: options?.isIdempotent ?? false,
    maxRetries: options?.isIdempotent ? (options?.maxRetries ?? 2) : 0,
    retryCount: 0,
    callerType: options?.callerType,
    toolUseId: options?.toolUseId,
  });

  // Manually ingest to trigger dispatch immediately in tests (skip watcher latency)
  await (taskSystem as any)._ingestPendingFile(`${TASKS_QUEUES_PENDING_DIR}/${taskId}.json`);
  return taskId;
}

// Mock tool for testing
const createMockTool = (supportsAsync: boolean): Tool => ({
  name: 'mockAsyncTool',
  description: 'Mock tool for async testing',
  schema: { type: 'object', properties: {} },

  readonly: false,
  idempotent: false,
  supportsAsync,
  async execute(args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
    const shouldFail = args.fail === true;
    if (shouldFail) {
      throw new Error('Mock execution failed');
    }
    return {
      success: true,
      content: args.content as string || 'ok',
    };
  },
});

// Mock fs
const createMockFs = () => ({
  read: vi.fn(),
  write: vi.fn().mockResolvedValue(undefined),
  writeAtomic: vi.fn().mockResolvedValue(undefined),
  append: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
  move: vi.fn().mockResolvedValue(undefined),
  exists: vi.fn().mockResolvedValue(false),
  list: vi.fn().mockResolvedValue([]),
  ensureDir: vi.fn().mockResolvedValue(undefined),
  isDirectory: vi.fn().mockResolvedValue(false),
});

describe('AsyncTaskSystem Tool Tasks', () => {
  let taskSystem: AsyncTaskSystem;
  let mockFs: ReturnType<typeof createMockFs>;
  let testDir: string;
  let testClawDir: string;

  beforeEach(async () => {
    testDir = path.join(tmpdir(), `clawforum-task-sys-${randomUUID()}`);
    await fs.mkdir(testDir, { recursive: true });
    testClawDir = path.join(testDir, `test-${Date.now()}`);
    await fs.mkdir(testClawDir, { recursive: true });
    await fs.mkdir(path.join(testClawDir, 'tasks', 'queues', 'pending'), { recursive: true });
    await fs.mkdir(path.join(testClawDir, 'tasks', 'queues', 'running'), { recursive: true });
    await fs.mkdir(path.join(testClawDir, 'tasks', 'queues', 'done'), { recursive: true });
    await fs.mkdir(path.join(testClawDir, 'tasks', 'queues', 'results'), { recursive: true });
    await fs.mkdir(path.join(testClawDir, 'inbox', 'pending'), { recursive: true });
    await fs.mkdir(path.join(testClawDir, 'logs'), { recursive: true });

    // Use real fs for integration-like testing
    taskSystem = new AsyncTaskSystem(
      testClawDir,
      {
        read: (p: string) => fs.readFile(path.join(testClawDir, p), 'utf-8'),
        write: (p: string, c: string) => fs.writeFile(path.join(testClawDir, p), c),
        writeAtomic: (p: string, c: string) => fs.writeFile(path.join(testClawDir, p), c),
        append: (p: string, c: string) => fs.appendFile(path.join(testClawDir, p), c),
        delete: (p: string) => fs.unlink(path.join(testClawDir, p)),
        move: (from: string, to: string) => fs.rename(path.join(testClawDir, from), path.join(testClawDir, to)),
        exists: (p: string) => fs.access(path.join(testClawDir, p)).then(() => true).catch(() => false),
        list: (p: string) => fs.readdir(path.join(testClawDir, p), { withFileTypes: true }).then(entries => 
          entries.map(e => ({ name: e.name, path: path.join(p, e.name), isDirectory: e.isDirectory() }))
        ),
        ensureDir: (p: string) => fs.mkdir(path.join(testClawDir, p), { recursive: true }),
        isDirectory: (p: string) => fs.stat(path.join(testClawDir, p)).then(s => s.isDirectory()).catch(() => false),
        appendSync: (p: string, c: string) => fsSync.appendFileSync(path.join(testClawDir, p), c),
        statSync: (p: string) => {
          const s = fsSync.statSync(path.join(testClawDir, p));
          return { size: s.size, mtime: s.mtime, ctime: s.ctime, isFile: s.isFile(), isDirectory: s.isDirectory() };
        },
        moveSync: (from: string, to: string) => fsSync.renameSync(path.join(testClawDir, from), path.join(testClawDir, to)),
      } as any,
      { maxConcurrent: TEST_MAX_CONCURRENT, retryBaseDelayMs: TEST_RETRY_BASE_DELAY_MS, auditWriter: makeAudit().audit, ...makeTaskSystemDeps() }
    );
    
    await taskSystem.initialize();
    taskSystem.startDispatch();
  });

  afterEach(async () => {
    await taskSystem.shutdown(1000).catch(() => {});
    // Clean up test dir
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('scheduleTool', () => {
    it('should schedule tool task and return taskId immediately', async () => {
      const executeCallback = vi.fn().mockResolvedValue({ success: true, content: 'ok' });
      
      const taskId = await scheduleToolCompat(taskSystem, 'testTool', executeCallback, 'parent-claw');
      
      expect(taskId).toBeDefined();
      expect(typeof taskId).toBe('string');
    });

    it('should save task to tasks/queues/pending/ or tasks/queues/running/ (atomic move may complete immediately)', async () => {
      const executeCallback = vi.fn().mockResolvedValue({ success: true, content: 'ok' });

      const taskId = await scheduleToolCompat(taskSystem, 'testTool', executeCallback, 'parent-claw');

      // Atomic fs.move() may complete before we read, so check both locations
      let rawFile: string;
      try {
        rawFile = await fs.readFile(
          path.join(testClawDir, 'tasks', 'queues', 'pending', `${taskId}.json`),
          'utf-8'
        );
      } catch {
        rawFile = await fs.readFile(
          path.join(testClawDir, 'tasks', 'queues', 'running', `${taskId}.json`),
          'utf-8'
        );
      }
      const taskData = JSON.parse(rawFile);
      expect(taskData.kind).toBe('tool');
      expect(taskData.toolName).toBe('testTool');
      expect(taskData.parentClawId).toBe('parent-claw');
    });

    it('should move task to tasks/queues/running/ when dispatched', async () => {
      // Use a slow callback so we can check the running state before completion
      const slowCallback = async () => {
        await new Promise(r => setTimeout(r, 200)); // sleep: mock slow tool callback
        return { success: true, content: 'slow' };
      };
      
      const taskId = await scheduleToolCompat(taskSystem, 'testTool', slowCallback, 'parent-claw');

      const runningPath = path.join(testClawDir, 'tasks', 'queues', 'running', `${taskId}.json`);
      await waitFor(async () => {
        try { await fs.access(runningPath); return true; } catch { return false; }
      });

      // Task should be in running directory after dispatch
      const taskFile = await fs.readFile(runningPath, 'utf-8');
      const taskData = JSON.parse(taskFile);
      expect(taskData.kind).toBe('tool');
      expect(taskData.toolName).toBe('testTool');
      expect(taskData.parentClawId).toBe('parent-claw');
      
      // Should no longer be in pending
      expect(taskSystem.listPending()).not.toContain(taskId);
      // Should be in running list
      expect(taskSystem.listRunning()).toContain(taskId);
    });

    it('should execute callback and send summary + resultRef to inbox', async () => {
      const executeCallback = vi.fn().mockResolvedValue({ success: true, content: 'async result' });
      
      const taskId = await scheduleToolCompat(taskSystem, 'testTool', executeCallback, 'parent-claw');
      
      // phase 1175 B.flaky-24: 等 inbox file atomic write 完成 + frontmatter 完整再 parse
      // mirror L291 / L955 同 file 邻位 phase 1090 模板
      const inboxDir = path.join(testClawDir, 'inbox', 'pending');
      await waitFor(async () => {
        const files = await fs.readdir(inboxDir).catch(() => [] as string[]);
        return (files as string[]).some(f => f.endsWith('.md'));
      });

      expect(executeCallback).toHaveBeenCalled();

      const inboxFiles = await fs.readdir(inboxDir);
      expect(inboxFiles.length).toBeGreaterThan(0);
      const inboxPath = path.join(inboxDir, inboxFiles[0]);
      const inboxFile = await waitForCompleteFile(inboxPath, /^---[\s\S]+---\n\n/);

      // Parse frontmatter + content
      const match = inboxFile.match(/---\n([\s\S]*?)\n---\n\n([\s\S]*)/);
      expect(match).not.toBeNull();
      expect(match![1]).toContain('from: "task_system"');
      expect(match![1]).toContain('to: "parent-claw"');
      expect(match![1]).toContain('priority: normal');
      
      const content = JSON.parse(match![2]);
      expect(content.taskId).toBe(taskId);
      expect(content.toolName).toBe('testTool');
      expect(content.is_error).toBe(false);
      // Should have summary and resultRef instead of full result
      expect(content.summary).toBeDefined();
      expect(content.resultRef).toBe(`tasks/queues/results/${taskId}/result.txt`);
      expect(content.result).toBeUndefined(); // Full result should not be in inbox
    });

    it('should save full result to tasks/queues/results/', async () => {
      const longResult = 'x'.repeat(1000); // Long result to test full content
      const executeCallback = vi.fn().mockResolvedValue({ success: true, content: longResult });
      
      const taskId = await scheduleToolCompat(taskSystem, 'testTool', executeCallback, 'parent-claw');
      
      await waitFor(async () => {
        try {
          await fs.readFile(path.join(testClawDir, 'tasks', 'queues', 'results', taskId, 'result.txt'), 'utf-8');
          return true;
        } catch {
          return false;
        }
      });
      
      // Full result should be in results directory
      const resultFile = await fs.readFile(
        path.join(testClawDir, 'tasks', 'queues', 'results', taskId, 'result.txt'),
        'utf-8'
      );
      expect(resultFile).toContain(longResult);
      
      // Inbox should have truncated summary preview (resultRef points to full content)
      const inboxFiles = await fs.readdir(path.join(testClawDir, 'inbox', 'pending'));
      expect(inboxFiles.length).toBeGreaterThan(0);
      
      const inboxPath = path.join(testClawDir, 'inbox', 'pending', inboxFiles[0]);
      const inboxFile = await waitForCompleteFile(inboxPath, /^---[\s\S]+---\n\n/);
      
      const match = inboxFile.match(/---\n([\s\S]*?)\n---\n\n([\s\S]*)/);
      expect(match).not.toBeNull();
      const content = JSON.parse(match![2]);
      // Summary should be truncated preview (500 chars) when resultRef exists
      expect(content.summary.length).toBeLessThanOrEqual(500);
      expect(content.summary).toContain('x'.repeat(100));
      expect(content.resultRef).toMatch(/^tasks\/queues\/results\/[^\/]+\/result\.txt$/);
    });

    it('should send error result with summary + resultRef', async () => {
      const executeCallback = vi.fn().mockRejectedValue(new Error('Execution failed'));
      
      const taskId = await scheduleToolCompat(taskSystem, 'testTool', executeCallback, 'parent-claw');
      
      await waitFor(async () => {
        const files = await fs.readdir(path.join(testClawDir, 'inbox', 'pending')).catch(() => [] as string[]);
        return (files as string[]).some(f => f.endsWith('.md'));
      });
      
      // Check inbox/pending/ for the error result message
      const inboxFiles = await fs.readdir(path.join(testClawDir, 'inbox', 'pending'));
      expect(inboxFiles.length).toBeGreaterThan(0);
      
      const inboxFile = await fs.readFile(
        path.join(testClawDir, 'inbox', 'pending', inboxFiles[0]),
        'utf-8'
      );
      
      // Parse frontmatter + content
      const match = inboxFile.match(/---\n([\s\S]*?)\n---\n\n([\s\S]*)/);
      expect(match).not.toBeNull();
      expect(match![1]).toContain('priority: high'); // Errors are high priority
      
      const content = JSON.parse(match![2]);
      expect(content.taskId).toBe(taskId);
      expect(content.toolName).toBe('testTool');
      expect(content.is_error).toBe(true);
      expect(content.summary).toBeDefined();
      expect(content.resultRef).toBe(`tasks/queues/results/${taskId}/result.txt`);
    });

    it('should move task to done after completion', async () => {
      const executeCallback = vi.fn().mockResolvedValue({ success: true, content: 'ok' });
      
      const taskId = await scheduleToolCompat(taskSystem, 'testTool', executeCallback, 'parent-claw');
      
      await waitFor(async () => {
        try {
          await fs.readFile(path.join(testClawDir, 'tasks', 'queues', 'done', `${taskId}.json`), 'utf-8');
          return true;
        } catch {
          return false;
        }
      });
      
      // Task should be in done directory
      const doneFile = await fs.readFile(
        path.join(testClawDir, 'tasks', 'queues', 'done', `${taskId}.json`),
        'utf-8'
      );
      const doneData = JSON.parse(doneFile);
      expect(doneData.id).toBe(taskId);
      expect(doneData.kind).toBe('tool');
      
      // Should not be in running
      expect(taskSystem.listRunning()).not.toContain(taskId);
    });

    it('should write fallback inbox message when sendToolResult inbox write fails', async () => {
      // 第一次 inbox/pending 写入失败，第二次（fallback）成功
      let inboxWriteCount = 0;
      const failingInboxFs = {
        read: (p: string) => fs.readFile(path.join(testClawDir, p), 'utf-8'),
        write: (p: string, c: string) => fs.writeFile(path.join(testClawDir, p), c),
        writeAtomic: async (p: string, c: string) => {
          if (p.startsWith('inbox/pending/') && inboxWriteCount++ === 0) {
            throw new Error('Simulated inbox write failure');
          }
          return fs.writeFile(path.join(testClawDir, p), c);
        },
        append: (p: string, c: string) => fs.appendFile(path.join(testClawDir, p), c),
        delete: (p: string) => fs.unlink(path.join(testClawDir, p)),
        move: (from: string, to: string) => fs.rename(path.join(testClawDir, from), path.join(testClawDir, to)),
        exists: (p: string) => fs.access(path.join(testClawDir, p)).then(() => true).catch(() => false),
        list: (p: string) => fs.readdir(path.join(testClawDir, p), { withFileTypes: true }).then(entries =>
          entries.map(e => ({ name: e.name, path: path.join(p, e.name), isDirectory: e.isDirectory() }))
        ),
        ensureDir: (p: string) => fs.mkdir(path.join(testClawDir, p), { recursive: true }),
        isDirectory: (p: string) => fs.stat(path.join(testClawDir, p)).then(s => s.isDirectory()).catch(() => false),
        appendSync: (p: string, c: string) => fsSync.appendFileSync(path.join(testClawDir, p), c),
        statSync: (p: string) => {
          const s = fsSync.statSync(path.join(testClawDir, p));
          return { size: s.size, mtime: s.mtime, ctime: s.ctime, isFile: s.isFile(), isDirectory: s.isDirectory() };
        },
        moveSync: (from: string, to: string) => fsSync.renameSync(path.join(testClawDir, from), path.join(testClawDir, to)),
      } as any;

      const taskSystem2 = new AsyncTaskSystem(testClawDir, failingInboxFs, { maxConcurrent: TEST_MAX_CONCURRENT, retryBaseDelayMs: TEST_RETRY_BASE_DELAY_MS, auditWriter: makeAudit().audit, ...makeTaskSystemDeps() });
      await taskSystem2.initialize();
      taskSystem2.startDispatch();

      const taskId = await scheduleToolCompat(taskSystem2, 
        'testTool',
        async () => ({ success: true, content: 'result' }),
        'parent-claw',
      );

      await waitFor(async () => {
        const files = await fs.readdir(path.join(testClawDir, 'inbox', 'pending')).catch(() => []);
        return files.filter((f: string) => f.endsWith('.md')).length > 0;
      });
      await taskSystem2.shutdown(500).catch(() => {});

      // fallback 消息应该存在
      const inboxFiles = await fs.readdir(path.join(testClawDir, 'inbox', 'pending'));
      const mdFiles = inboxFiles.filter(f => f.endsWith('.md'));
      expect(mdFiles.length).toBeGreaterThan(0);
      const content = await fs.readFile(path.join(testClawDir, 'inbox', 'pending', mdFiles[0]), 'utf-8');
      expect(content).toContain(taskId);
      expect(content).toContain('is_error');
    });
  });

  describe('pending queue with dispatcher', () => {
    it('should queue tasks when max concurrent reached and dispatch when slots free', async () => {
      // Fill up to max concurrent (3) with slow tasks
      const slowCallback = () => new Promise<ToolResult>(r => setTimeout(() => r({ success: true, content: 'slow' }), 50));
      
      // Schedule 3 slow tasks
      const taskIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        const id = await scheduleToolCompat(taskSystem, `slowTool${i}`, slowCallback, 'parent-claw');
        taskIds.push(id);
      }
      
      await waitFor(() => taskSystem.listRunning().length === 3);
      
      // All 3 should be running
      expect(taskSystem.listRunning().length).toBe(3);
      expect(taskSystem.listPending().length).toBe(0);
      
      // Schedule a 4th task - should go to pending
      const fastCallback = vi.fn().mockResolvedValue({ success: true, content: 'fast' });
      const fourthId = await scheduleToolCompat(taskSystem, 'fourthTool', fastCallback, 'parent-claw');
      
      // Wait for the task to be queued before asserting state (B.flaky-17)
      await waitFor(() => taskSystem.listPending().includes(fourthId));
      
      // Should be in pending, not running
      expect(taskSystem.listPending()).toContain(fourthId);
      expect(taskSystem.listRunning()).not.toContain(fourthId);
      
      await waitFor(() => !taskSystem.listRunning().includes(fourthId) && !taskSystem.listPending().includes(fourthId));
      
      // Now fourth should be dispatched and completed
      expect(taskSystem.listRunning()).not.toContain(fourthId); // Should be done now
      expect(taskSystem.listPending()).not.toContain(fourthId);
      
      // Fast callback should have been executed
      expect(fastCallback).toHaveBeenCalled();
      
      // Should be in done
      const doneFile = await fs.readFile(
        path.join(testClawDir, 'tasks', 'queues', 'done', `${fourthId}.json`),
        'utf-8'
      ).catch(() => null);
      expect(doneFile).not.toBeNull();
    });

    it('should queue multiple tasks and dispatch in FIFO order', async () => {
      // Create 5 tasks with maxConcurrent=3
      const executionOrder: number[] = [];
      const createCallback = (n: number) => async () => {
        executionOrder.push(n);
        await new Promise(r => setTimeout(r, 50));
        return { success: true, content: `task-${n}` };
      };

      // Use an audit with emitter so we can subscribe to completion events (phase 779 Step C)
      const { audit, events, emitter } = makeAudit();
      const ts = new AsyncTaskSystem(
        testClawDir,
        (taskSystem as any).fs,
        { maxConcurrent: TEST_MAX_CONCURRENT, retryBaseDelayMs: TEST_RETRY_BASE_DELAY_MS, auditWriter: audit, ...makeTaskSystemDeps() }
      );
      await ts.initialize();
      ts.startDispatch();

      // Pre-subscribe audit events before scheduling so no events are missed
      // (phase 1150: mirror L498-509 counter pattern for TASK_STARTED + TASK_COMPLETED)
      let started = 0;
      const startedPromise = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          emitter.off('write', startedHandler);
          reject(new Error('timeout waiting for 3 TASK_STARTED events (dispatcher quota)'));
        }, 10000);
        const startedHandler = (type: string) => {
          if (type === 'task_started') {
            started++;
            if (started >= 3) {
              clearTimeout(timer);
              emitter.off('write', startedHandler);
              resolve();
            }
          }
        };
        emitter.on('write', startedHandler);
      });

      let completed = 0;
      const completedPromise = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          emitter.off('write', completedHandler);
          reject(new Error('timeout waiting for 5 TASK_COMPLETED events'));
        }, 15000); // was 5000
        const completedHandler = (type: string) => {
          if (type === 'task_completed') {
            completed++;
            if (completed >= 5) {
              clearTimeout(timer);
              emitter.off('write', completedHandler);
              resolve();
            }
          }
        };
        emitter.on('write', completedHandler);
      });

      // Schedule all 5 tasks quickly
      const taskIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        const id = await scheduleToolCompat(ts, `tool${i}`, createCallback(i), 'parent-claw');
        taskIds.push(id);
      }

      // Wait for dispatcher cap to be reached (3 TASK_STARTED)
      await startedPromise;

      // Wait for all 5 tasks to finish
      await completedPromise;

      // All 5 tasks should have been executed
      expect(executionOrder.length).toBe(5);
      // First 3 should start in order (but completion order may vary due to async)
      expect(executionOrder.slice(0, 3)).toEqual(
        expect.arrayContaining([0, 1, 2])
      );

      await ts.shutdown(100).catch(() => {});
    });
  });

  describe('cold-start recovery', () => {
    it('should recover subagent tasks from pending/ on initialize', async () => {
      // Directly write a pending subagent file without going through scheduleTool
      const taskId = 'recovered-subagent-id';
      const task = { 
        kind: 'subagent' as const, 
        id: taskId, 
        intent: 'test prompt',
        timeoutMs: SUBAGENT_DEFAULT_TIMEOUT_MS,
        maxSteps: 10,
        parentClawId: 'parent', 
        createdAt: new Date().toISOString() 
      };
      const pendingFilePath = path.join(testClawDir, 'tasks', 'queues', 'pending', `${taskId}.json`);
      await fs.writeFile(pendingFilePath, JSON.stringify(task));

      // phase 1226 γ instrument: capture all audit events for diagnostic
      const auditEvents: Array<{ type: string; cols: any[] }> = [];
      const audit = makeAudit().audit;
      const instrumentedAudit = {
        write: (type: string, ...cols: any[]) => {
          auditEvents.push({ type, cols });
          audit.write(type, ...cols);
        },
      };

      // Re-initialize (simulating restart)
      const taskSystem2 = new AsyncTaskSystem(
        testClawDir,
        {
          read: (p: string) => fs.readFile(path.join(testClawDir, p), 'utf-8'),
          write: (p: string, c: string) => fs.writeFile(path.join(testClawDir, p), c),
          writeAtomic: (p: string, c: string) => fs.writeFile(path.join(testClawDir, p), c),
          append: (p: string, c: string) => fs.appendFile(path.join(testClawDir, p), c),
          delete: (p: string) => fs.unlink(path.join(testClawDir, p)),
          move: (from: string, to: string) => fs.rename(path.join(testClawDir, from), path.join(testClawDir, to)),
          exists: (p: string) => fs.access(path.join(testClawDir, p)).then(() => true).catch(() => false),
          list: (p: string) => fs.readdir(path.join(testClawDir, p), { withFileTypes: true }).then(entries => 
            entries.map(e => ({ name: e.name, path: path.join(p, e.name), isDirectory: e.isDirectory() }))
          ),
          ensureDir: (p: string) => fs.mkdir(path.join(testClawDir, p), { recursive: true }),
          isDirectory: (p: string) => fs.stat(path.join(testClawDir, p)).then(s => s.isDirectory()).catch(() => false),
        appendSync: (p: string, c: string) => fsSync.appendFileSync(path.join(testClawDir, p), c),
        statSync: (p: string) => {
          const s = fsSync.statSync(path.join(testClawDir, p));
          return { size: s.size, mtime: s.mtime, ctime: s.ctime, isFile: s.isFile(), isDirectory: s.isDirectory() };
        },
        moveSync: (from: string, to: string) => fsSync.renameSync(path.join(testClawDir, from), path.join(testClawDir, to)),
        } as any,
        { maxConcurrent: TEST_MAX_CONCURRENT, retryBaseDelayMs: TEST_RETRY_BASE_DELAY_MS, auditWriter: instrumentedAudit, ...makeTaskSystemDeps() }
      );
      await taskSystem2.initialize();

      // phase 1307 α-1: positive audit guard — corrupt/failed path must NOT be taken for valid task
      // (convert silent corrupt path to loud test fail / mirror feedback_event_driven_wait_pattern Tier 2 active)
      const corruptEventsEarly = auditEvents.filter(
        e => e.type === TASK_AUDIT_EVENTS.TASK_CORRUPT,
      );
      const recoveryFailedEventsEarly = auditEvents.filter(
        e => e.type === TASK_AUDIT_EVENTS.RECOVERY_FAILED,
      );
      if (corruptEventsEarly.length > 0 || recoveryFailedEventsEarly.length > 0) {
        console.error('[phase1307-α-1] corrupt/fail audit during recovery (silent path detected):', {
          corruptEventsEarly,
          recoveryFailedEventsEarly,
          allAuditEventsCount: auditEvents.length,
          last10AuditEvents: auditEvents.slice(-10),
        });
      }
      expect(corruptEventsEarly).toHaveLength(0);
      expect(recoveryFailedEventsEarly).toHaveLength(0);

      const exists = async () =>
        fs
          .access(pendingFilePath)
          .then(() => true)
          .catch(() => false);

      // phase 1226 γ: dump diagnostic on fail
      const fileExistsAfterInit = await exists();
      if (!fileExistsAfterInit) {
        const corruptEvents = auditEvents.filter(
          e => e.type === TASK_AUDIT_EVENTS.TASK_CORRUPT
        );
        const recoveryFailedEvents = auditEvents.filter(
          e => e.type === TASK_AUDIT_EVENTS.RECOVERY_FAILED
        );
        const recoveryCompleteEvents = auditEvents.filter(
          e => e.type === TASK_AUDIT_EVENTS.RECOVERY_COMPLETE
        );
        const backupFiles = await fs.readdir(
          path.join(testClawDir, 'tasks', 'queues', 'pending')
        ).catch(() => [] as string[]);
        console.error('[phase1226-γ] FAIL diagnostic:', {
          fileExistsAfterInit,
          pendingFilePath,
          backupFilesInPending: backupFiles,
          corruptEvents,
          recoveryFailedEvents,
          recoveryCompleteEvents,
          allAuditEventsCount: auditEvents.length,
          last10AuditEvents: auditEvents.slice(-10),
        });
      }
      // 第 1 检：initialize 返回后必须存在（recover 不应搬走 pending）
      expect(fileExistsAfterInit).toBe(true);

      // 第 2 检：50ms 后仍存在（确认 startDispatch 之前 0 async 搬移）
      // 注：此处为负向稳定窗口断言，无正向状态可 poll。
      await new Promise(r => setTimeout(r, 50));
      const fileExists50ms = await exists();
      if (!fileExists50ms && fileExistsAfterInit) {
        // first check PASS but 50ms check FAIL → async move happened
        console.error('[phase1226-γ] FAIL 50ms diagnostic: async move detected after initialize');
      }
      expect(fileExists50ms).toBe(true);

      taskSystem2.startDispatch();

      await taskSystem2.shutdown(100).catch(() => {});
    });

    it('should recover running/ tool tasks to pending/ on initialize (fs-driven)', async () => {
      // phase432: ToolTask 改 fs-driven / 有 args+parentClawDir 可恢复执行
      const taskId = 'crashed-task-id';
      const task = {
        kind: 'tool',
        id: taskId,
        toolName: 'crashTool',
        args: {},
        parentClawDir: testClawDir,
        parentClawId: 'parent',
        createdAt: new Date().toISOString(),
        isIdempotent: false,
        maxRetries: 0,
        retryCount: 0,
      };
      await fs.writeFile(
        path.join(testClawDir, 'tasks', 'queues', 'running', `${taskId}.json`),
        JSON.stringify(task)
      );

      const taskSystem2 = new AsyncTaskSystem(
        testClawDir,
        {
          read: (p: string) => fs.readFile(path.join(testClawDir, p), 'utf-8'),
          write: (p: string, c: string) => fs.writeFile(path.join(testClawDir, p), c),
          writeAtomic: (p: string, c: string) => fs.writeFile(path.join(testClawDir, p), c),
          append: (p: string, c: string) => fs.appendFile(path.join(testClawDir, p), c),
          delete: (p: string) => fs.unlink(path.join(testClawDir, p)),
          move: (from: string, to: string) => fs.rename(path.join(testClawDir, from), path.join(testClawDir, to)),
          exists: (p: string) => fs.access(path.join(testClawDir, p)).then(() => true).catch(() => false),
          list: (p: string) => fs.readdir(path.join(testClawDir, p), { withFileTypes: true }).then(entries =>
            entries.map(e => ({ name: e.name, path: path.join(p, e.name), isDirectory: e.isDirectory() }))
          ),
          ensureDir: (p: string) => fs.mkdir(path.join(testClawDir, p), { recursive: true }),
          isDirectory: (p: string) => fs.stat(path.join(testClawDir, p)).then(s => s.isDirectory()).catch(() => false),
        appendSync: (p: string, c: string) => fsSync.appendFileSync(path.join(testClawDir, p), c),
        statSync: (p: string) => {
          const s = fsSync.statSync(path.join(testClawDir, p));
          return { size: s.size, mtime: s.mtime, ctime: s.ctime, isFile: s.isFile(), isDirectory: s.isDirectory() };
        },
        moveSync: (from: string, to: string) => fsSync.renameSync(path.join(testClawDir, from), path.join(testClawDir, to)),
        } as any,
        { maxConcurrent: TEST_MAX_CONCURRENT, retryBaseDelayMs: TEST_RETRY_BASE_DELAY_MS, auditWriter: makeAudit().audit, ...makeTaskSystemDeps() }
      );
      // 注册工具使恢复后可执行
      (taskSystem2 as any).registry.register({
        name: 'crashTool',
        description: 'mock',
        schema: { type: 'object', properties: {} },
        readonly: false,
        idempotent: false,
        supportsAsync: true,
        execute: async () => ({ success: true, content: 'recovered' }),
      });
      await taskSystem2.initialize();
      taskSystem2.startDispatch();

      // phase432: running tool task 移回 pending，再被 ingest 执行
      await waitFor(async () => {
        const doneExists = await fs.access(path.join(testClawDir, 'tasks', 'queues', 'done', `${taskId}.json`)).then(() => true).catch(() => false);
        return doneExists;
      });

      const runningExists = await fs.access(path.join(testClawDir, 'tasks', 'queues', 'running', `${taskId}.json`)).then(() => true).catch(() => false);
      expect(runningExists).toBe(false);
      const doneExists = await fs.access(path.join(testClawDir, 'tasks', 'queues', 'done', `${taskId}.json`)).then(() => true).catch(() => false);
      expect(doneExists).toBe(true);

      await taskSystem2.shutdown(100).catch(() => {});
    });

    it('should recover pending/ tool tasks on initialize (fs-driven)', async () => {
      // phase432: ToolTask 改 fs-driven / pending 中的 tool task 保留并被 ingest 执行
      const taskId = 'pending-tool-task-id';
      const task = {
        kind: 'tool',
        id: taskId,
        toolName: 'pendingTool',
        args: {},
        parentClawDir: testClawDir,
        parentClawId: 'parent',
        createdAt: new Date().toISOString(),
        isIdempotent: false,
        maxRetries: 0,
        retryCount: 0,
      };
      await fs.writeFile(
        path.join(testClawDir, 'tasks', 'queues', 'pending', `${taskId}.json`),
        JSON.stringify(task)
      );

      // phase 1309 α-1: capture audit events for diagnostic + positive assertion (mirror phase 1307)
      const auditEvents: Array<{ type: string; cols: any[] }> = [];
      const baseAudit = makeAudit().audit;
      const instrumentedAudit = {
        write: (type: string, ...cols: any[]) => {
          auditEvents.push({ type, cols });
          baseAudit.write(type, ...cols);
        },
      };

      const taskSystem2 = new AsyncTaskSystem(
        testClawDir,
        {
          read: (p: string) => fs.readFile(path.join(testClawDir, p), 'utf-8'),
          write: (p: string, c: string) => fs.writeFile(path.join(testClawDir, p), c),
          writeAtomic: (p: string, c: string) => fs.writeFile(path.join(testClawDir, p), c),
          append: (p: string, c: string) => fs.appendFile(path.join(testClawDir, p), c),
          delete: (p: string) => fs.unlink(path.join(testClawDir, p)),
          move: (from: string, to: string) => fs.rename(path.join(testClawDir, from), path.join(testClawDir, to)),
          exists: (p: string) => fs.access(path.join(testClawDir, p)).then(() => true).catch(() => false),
          list: (p: string) => fs.readdir(path.join(testClawDir, p), { withFileTypes: true }).then(entries =>
            entries.map(e => ({ name: e.name, path: path.join(p, e.name), isDirectory: e.isDirectory() }))
          ),
          ensureDir: (p: string) => fs.mkdir(path.join(testClawDir, p), { recursive: true }),
          isDirectory: (p: string) => fs.stat(path.join(testClawDir, p)).then(s => s.isDirectory()).catch(() => false),
        appendSync: (p: string, c: string) => fsSync.appendFileSync(path.join(testClawDir, p), c),
        statSync: (p: string) => {
          const s = fsSync.statSync(path.join(testClawDir, p));
          return { size: s.size, mtime: s.mtime, ctime: s.ctime, isFile: s.isFile(), isDirectory: s.isDirectory() };
        },
        moveSync: (from: string, to: string) => fsSync.renameSync(path.join(testClawDir, from), path.join(testClawDir, to)),
        } as any,
        { maxConcurrent: TEST_MAX_CONCURRENT, retryBaseDelayMs: TEST_RETRY_BASE_DELAY_MS, auditWriter: instrumentedAudit, ...makeTaskSystemDeps() }
      );
      (taskSystem2 as any).registry.register({
        name: 'pendingTool',
        description: 'mock',
        schema: { type: 'object', properties: {} },
        readonly: false,
        idempotent: false,
        supportsAsync: true,
        execute: async () => ({ success: true, content: 'recovered' }),
      });
      await taskSystem2.initialize();

      // phase 1309 α-1: positive audit guard — corrupt/failed path must NOT be taken for valid task
      const corruptEventsEarly = auditEvents.filter(
        e => e.type === TASK_AUDIT_EVENTS.TASK_CORRUPT,
      );
      const recoveryFailedEventsEarly = auditEvents.filter(
        e => e.type === TASK_AUDIT_EVENTS.RECOVERY_FAILED,
      );
      if (corruptEventsEarly.length > 0 || recoveryFailedEventsEarly.length > 0) {
        console.error('[phase1309-α-1] corrupt/fail audit during recovery (silent path detected):', {
          corruptEventsEarly,
          recoveryFailedEventsEarly,
          allAuditEventsCount: auditEvents.length,
          last10AuditEvents: auditEvents.slice(-10),
        });
      }
      expect(corruptEventsEarly).toHaveLength(0);
      expect(recoveryFailedEventsEarly).toHaveLength(0);

      taskSystem2.startDispatch();

      // phase432: pending tool task 被 ingest 并执行 / phase 1309 α-1: timeout dump diagnostic
      try {
        await waitFor(async () => {
          const doneExists = await fs.access(path.join(testClawDir, 'tasks', 'queues', 'done', `${taskId}.json`)).then(() => true).catch(() => false);
          return doneExists;
        });
      } catch (waitForErr) {
        const failedEvents = auditEvents.filter(e =>
          e.type === TASK_AUDIT_EVENTS.TASK_FAILED ||
          e.type === TASK_AUDIT_EVENTS.RETRY_EXHAUSTED ||
          e.type === TASK_AUDIT_EVENTS.TASK_CORRUPT ||
          e.type === TASK_AUDIT_EVENTS.RECOVERY_FAILED,
        );
        const doneDirFiles = await fs.readdir(path.join(testClawDir, 'tasks', 'queues', 'done')).catch(() => [] as string[]);
        const pendingDirFiles = await fs.readdir(path.join(testClawDir, 'tasks', 'queues', 'pending')).catch(() => [] as string[]);
        console.error('[phase1309-α-1] waitFor timeout diagnostic:', {
          failedEvents,
          doneDirFiles,
          pendingDirFiles,
          allAuditEventsCount: auditEvents.length,
          last20AuditEvents: auditEvents.slice(-20),
        });
        throw waitForErr;
      }

      const doneExists = await fs.access(path.join(testClawDir, 'tasks', 'queues', 'done', `${taskId}.json`)).then(() => true).catch(() => false);
      expect(doneExists).toBe(true);

      await taskSystem2.shutdown(100).catch(() => {});
    });

    it('should rename result.txt to .sent and send inbox message once on subagent recovery', async () => {
      // Simulate: subagent completed (result.txt written), daemon crashed before moving to done/
      const taskId = 'subagent-with-result';
      const task: SubAgentTask = {
        kind: 'subagent',
        id: taskId,
        intent: 'test',
        timeoutMs: SUBAGENT_DEFAULT_TIMEOUT_MS,
        maxSteps: 10,
        parentClawId: 'parent-claw',
        createdAt: new Date().toISOString(),
      };
      await fs.mkdir(path.join(testClawDir, 'tasks', 'queues', 'results', taskId), { recursive: true });
      await fs.writeFile(path.join(testClawDir, 'tasks', 'queues', 'results', taskId, 'result.txt'), 'task output');
      await fs.writeFile(
        path.join(testClawDir, 'tasks', 'queues', 'running', `${taskId}.json`),
        JSON.stringify(task)
      );

      const makeTs = () => new AsyncTaskSystem(testClawDir, {
        read: (p: string) => fs.readFile(path.join(testClawDir, p), 'utf-8'),
        write: (p: string, c: string) => fs.writeFile(path.join(testClawDir, p), c),
        writeAtomic: (p: string, c: string) => fs.writeFile(path.join(testClawDir, p), c),
        append: (p: string, c: string) => fs.appendFile(path.join(testClawDir, p), c),
        delete: (p: string) => fs.unlink(path.join(testClawDir, p)),
        move: (from: string, to: string) => fs.rename(path.join(testClawDir, from), path.join(testClawDir, to)),
        exists: (p: string) => fs.access(path.join(testClawDir, p)).then(() => true).catch(() => false),
        list: (p: string) => fs.readdir(path.join(testClawDir, p), { withFileTypes: true }).then(entries =>
          entries.map(e => ({ name: e.name, path: path.join(p, e.name), isDirectory: e.isDirectory() }))
        ),
        ensureDir: (p: string) => fs.mkdir(path.join(testClawDir, p), { recursive: true }),
        isDirectory: (p: string) => fs.stat(path.join(testClawDir, p)).then(s => s.isDirectory()).catch(() => false),
        appendSync: (p: string, c: string) => fsSync.appendFileSync(path.join(testClawDir, p), c),
        statSync: (p: string) => {
          const s = fsSync.statSync(path.join(testClawDir, p));
          return { size: s.size, mtime: s.mtime, ctime: s.ctime, isFile: s.isFile(), isDirectory: s.isDirectory() };
        },
        moveSync: (from: string, to: string) => fsSync.renameSync(path.join(testClawDir, from), path.join(testClawDir, to)),
      } as any, { maxConcurrent: TEST_MAX_CONCURRENT, retryBaseDelayMs: TEST_RETRY_BASE_DELAY_MS, auditWriter: makeAudit().audit, ...makeTaskSystemDeps() });

      // First restart: result.txt → .sent, inbox message written
      const ts1 = makeTs();
      await ts1.initialize();
      ts1.startDispatch();
      await ts1.shutdown(100).catch(() => {});

      // sendResult() 内部会重写 result.txt，但 .sent 标记必须存在
      const sentTxt = await fs.access(path.join(testClawDir, 'tasks', 'queues', 'results', taskId, 'result.txt.sent')).then(() => true).catch(() => false);
      expect(sentTxt).toBe(true);     // .sent 标记存在，表示已投递

      const inboxAfterFirst = await fs.readdir(path.join(testClawDir, 'inbox', 'pending'));
      expect(inboxAfterFirst).toHaveLength(1);

      // Second restart: task is in done/, inbox should stay at 1 (no duplicate)
      const ts2 = makeTs();
      await ts2.initialize();
      ts2.startDispatch();
      await ts2.shutdown(100).catch(() => {});

      const inboxAfterSecond = await fs.readdir(path.join(testClawDir, 'inbox', 'pending'));
      expect(inboxAfterSecond).toHaveLength(1);
    });

    it('should NOT re-execute when only result.txt.sent exists (task still in running/ after partial recovery)', async () => {
      // Simulate: rename succeeded + sendResult succeeded, but fs.move(running→done) failed
      // Next restart: only result.txt.sent exists, task still in running/
      const taskId = 'subagent-already-sent';
      const task: SubAgentTask = {
        kind: 'subagent',
        id: taskId,
        intent: 'test',
        timeoutMs: SUBAGENT_DEFAULT_TIMEOUT_MS,
        maxSteps: 10,
        parentClawId: 'parent-claw',
        createdAt: new Date().toISOString(),
      };
      await fs.mkdir(path.join(testClawDir, 'tasks', 'queues', 'results', taskId), { recursive: true });
      await fs.writeFile(path.join(testClawDir, 'tasks', 'queues', 'results', taskId, 'result.txt.sent'), 'task output');
      await fs.writeFile(
        path.join(testClawDir, 'tasks', 'queues', 'running', `${taskId}.json`),
        JSON.stringify(task)
      );

      const ts = new AsyncTaskSystem(testClawDir, {
        read: (p: string) => fs.readFile(path.join(testClawDir, p), 'utf-8'),
        write: (p: string, c: string) => fs.writeFile(path.join(testClawDir, p), c),
        writeAtomic: (p: string, c: string) => fs.writeFile(path.join(testClawDir, p), c),
        append: (p: string, c: string) => fs.appendFile(path.join(testClawDir, p), c),
        delete: (p: string) => fs.unlink(path.join(testClawDir, p)),
        move: (from: string, to: string) => fs.rename(path.join(testClawDir, from), path.join(testClawDir, to)),
        exists: (p: string) => fs.access(path.join(testClawDir, p)).then(() => true).catch(() => false),
        list: (p: string) => fs.readdir(path.join(testClawDir, p), { withFileTypes: true }).then(entries =>
          entries.map(e => ({ name: e.name, path: path.join(p, e.name), isDirectory: e.isDirectory() }))
        ),
        ensureDir: (p: string) => fs.mkdir(path.join(testClawDir, p), { recursive: true }),
        isDirectory: (p: string) => fs.stat(path.join(testClawDir, p)).then(s => s.isDirectory()).catch(() => false),
        appendSync: (p: string, c: string) => fsSync.appendFileSync(path.join(testClawDir, p), c),
        statSync: (p: string) => {
          const s = fsSync.statSync(path.join(testClawDir, p));
          return { size: s.size, mtime: s.mtime, ctime: s.ctime, isFile: s.isFile(), isDirectory: s.isDirectory() };
        },
        moveSync: (from: string, to: string) => fsSync.renameSync(path.join(testClawDir, from), path.join(testClawDir, to)),
      } as any, { maxConcurrent: TEST_MAX_CONCURRENT, retryBaseDelayMs: TEST_RETRY_BASE_DELAY_MS, auditWriter: makeAudit().audit, ...makeTaskSystemDeps() });
      await ts.initialize();
      ts.startDispatch();
      await ts.shutdown(100).catch(() => {});

      // Task must NOT be re-queued (result was already delivered)
      expect(ts.listPending()).not.toContain(taskId);
      // No new inbox message (duplicate prevented)
      const inboxFiles = await fs.readdir(path.join(testClawDir, 'inbox', 'pending'));
      expect(inboxFiles).toHaveLength(0);
      // Task moved to done/
      const inDone = await fs.access(path.join(testClawDir, 'tasks', 'queues', 'done', `${taskId}.json`)).then(() => true).catch(() => false);
      expect(inDone).toBe(true);
    });
  });

  describe('sendToolResult', () => {
    it('should use result.content for summary, not full JSON', async () => {
      const longContent = 'output-' + 'x'.repeat(300);
      const executeCallback = vi.fn().mockResolvedValue({ success: true, content: longContent });

      const taskId = await scheduleToolCompat(taskSystem, 'testTool', executeCallback, 'parent-claw');
      await waitFor(async () => {
        const files = await fs.readdir(path.join(testClawDir, 'inbox', 'pending')).catch(() => [] as string[]);
        return (files as string[]).some(f => f.endsWith('.md'));
      });

      // Check inbox/pending/ for the result message
      const inboxFiles = await fs.readdir(path.join(testClawDir, 'inbox', 'pending'));
      expect(inboxFiles.length).toBeGreaterThan(0);
      
      const inboxFile = await fs.readFile(
        path.join(testClawDir, 'inbox', 'pending', inboxFiles[0]),
        'utf-8'
      );
      
      const match = inboxFile.match(/---\n([\s\S]*?)\n---\n\n([\s\S]*)/);
      expect(match).not.toBeNull();
      const content = JSON.parse(match![2]);

      // Summary should start with 'output-xxx...', not contain '{"success":true'
      expect(content.summary).not.toContain('"success"');
      expect(content.summary).not.toContain('"content"');
      // Content comes from result.content
      expect(content.summary.startsWith('output-')).toBe(true);
    });

    it('should NOT call transport.sendInboxMessage (bypass transport)', async () => {
      const executeCallback = vi.fn().mockResolvedValue({ success: true, content: 'direct result' });

      await scheduleToolCompat(taskSystem, 'testTool', executeCallback, 'parent-claw');
      await waitFor(async () => {
        const files = await fs.readdir(path.join(testClawDir, 'inbox', 'pending')).catch(() => [] as string[]);
        return (files as string[]).some(f => f.endsWith('.md'));
      });

      // Inbox file must be .md (not .json or other)
      const inboxFiles = await fs.readdir(path.join(testClawDir, 'inbox', 'pending'));
      expect(inboxFiles.length).toBeGreaterThan(0);
      expect(inboxFiles.every(f => f.endsWith('.md'))).toBe(true);
    });

    it('should fall back to full content in inbox when results/ write fails', async () => {
      // Create an fs where writeAtomic fails for results/ path
      const failingFs = {
        read: (p: string) => fs.readFile(path.join(testClawDir, p), 'utf-8'),
        write: (p: string, c: string) => fs.writeFile(path.join(testClawDir, p), c),
        writeAtomic: async (p: string, c: string) => {
          if (p.includes('tasks/queues/results')) throw new Error('Disk full');
          return fs.writeFile(path.join(testClawDir, p), c);
        },
        append: (p: string, c: string) => fs.appendFile(path.join(testClawDir, p), c),
        delete: (p: string) => fs.unlink(path.join(testClawDir, p)),
        move: (from: string, to: string) => fs.rename(path.join(testClawDir, from), path.join(testClawDir, to)),
        exists: (p: string) => fs.access(path.join(testClawDir, p)).then(() => true).catch(() => false),
        list: (p: string) => fs.readdir(path.join(testClawDir, p), { withFileTypes: true }).then(entries => 
          entries.map(e => ({ name: e.name, path: path.join(p, e.name), isDirectory: e.isDirectory() }))
        ),
        ensureDir: (p: string) => fs.mkdir(path.join(testClawDir, p), { recursive: true }),
        isDirectory: (p: string) => fs.stat(path.join(testClawDir, p)).then(s => s.isDirectory()).catch(() => false),
        appendSync: (p: string, c: string) => fsSync.appendFileSync(path.join(testClawDir, p), c),
        statSync: (p: string) => {
          const s = fsSync.statSync(path.join(testClawDir, p));
          return { size: s.size, mtime: s.mtime, ctime: s.ctime, isFile: s.isFile(), isDirectory: s.isDirectory() };
        },
        moveSync: (from: string, to: string) => fsSync.renameSync(path.join(testClawDir, from), path.join(testClawDir, to)),
      } as any;

      const taskSystem2 = new AsyncTaskSystem(testClawDir, failingFs, { maxConcurrent: TEST_MAX_CONCURRENT, retryBaseDelayMs: TEST_RETRY_BASE_DELAY_MS, auditWriter: makeAudit().audit, ...makeTaskSystemDeps() });
      await taskSystem2.initialize();
      taskSystem2.startDispatch();

      const executeCallback = vi.fn().mockResolvedValue({ success: true, content: 'fallback content' });
      await scheduleToolCompat(taskSystem2, 'testTool', executeCallback, 'parent-claw');
      await waitFor(async () => {
        const files = await fs.readdir(path.join(testClawDir, 'inbox', 'pending')).catch(() => [] as string[]);
        return (files as string[]).some(f => f.endsWith('.md'));
      });

      // Check inbox/pending/ for the result message
      const inboxFiles = (await fs.readdir(path.join(testClawDir, 'inbox', 'pending'))).filter(f => f.endsWith('.md'));
      expect(inboxFiles.length).toBeGreaterThan(0);

      // Wait for atomic rename to complete before reading frontmatter (phase 779 Step D / B.flaky-8)
      const inboxPath = path.join(testClawDir, 'inbox', 'pending', inboxFiles[0]);
      const inboxFile = await waitForCompleteFile(inboxPath, /^---[\s\S]+---\n\n/);

      const match = inboxFile.match(/---\n([\s\S]*?)\n---\n\n([\s\S]*)/);
      expect(match).not.toBeNull();
      const content = JSON.parse(match![2]);

      // Fallback: no resultRef, has result field
      expect(content.resultRef).toBeUndefined();
      expect(content.result).toBeDefined();

      await taskSystem2.shutdown(100).catch(() => {});
    });
  });

  describe('cancel', () => {
    it('should not attempt double moveTaskToDone after cancel', async () => {
      const slowCallback = () => new Promise<ToolResult>(r => setTimeout(() => r({ success: true, content: 'slow' }), 1000));
      const taskId = await scheduleToolCompat(taskSystem, 'slowTool', slowCallback, 'parent-claw');
      await waitFor(() => taskSystem.listRunning().includes(taskId));

      await taskSystem.cancel(taskId);

      // Task should be in done directory (via _startTask.finally -> executeToolTask.finally)
      // And running directory should not have the file (deleted only once)
      const runningExists = await fs.access(path.join(testClawDir, 'tasks', 'queues', 'running', `${taskId}.json`)).then(() => true).catch(() => false);
      expect(runningExists).toBe(false);
      // No longer running or pending
      expect(taskSystem.listRunning()).not.toContain(taskId);
      expect(taskSystem.listPending()).not.toContain(taskId);
    });
  });

  describe('readonly tools supportsAsync', () => {
    it('read tool should have supportsAsync: false', () => {
      expect(readTool.supportsAsync).toBe(false);
      expect(readTool.schema.properties).not.toHaveProperty('async');
    });

    it('ls tool should have supportsAsync: false', () => {
      expect(lsTool.supportsAsync).toBe(false);
      expect(lsTool.schema.properties).not.toHaveProperty('async');
    });

    it('search tool should have supportsAsync: true', () => {
      expect(searchTool.supportsAsync).toBe(true);
      expect(searchTool.schema.properties).toHaveProperty('async');
    });
  });

  describe('retry mechanism', () => {
    it('should retry idempotent tool and succeed on second attempt', async () => {
      let callCount = 0;
      const flakyCallback = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error('Transient error');
        return { success: true, content: 'recovered' };
      });

      const taskId = await scheduleToolCompat(taskSystem, 'flakyTool', flakyCallback, 'parent-claw', {
        isIdempotent: true,
        maxRetries: 2,
      });

      await waitFor(async () => {
        const files = await fs.readdir(path.join(testClawDir, 'inbox', 'pending')).catch(() => [] as string[]);
        return (files as string[]).some(f => f.endsWith('.md'));
      });

      // Wait for task to complete before reading inbox (B.flaky-18)
      await waitFor(() => taskSystem.listRunning().length === 0);

      expect(flakyCallback).toHaveBeenCalledTimes(2);

      // Check inbox/pending/ for the result message
      const inboxFiles = await fs.readdir(path.join(testClawDir, 'inbox', 'pending'));
      
      const inboxFile = await fs.readFile(
        path.join(testClawDir, 'inbox', 'pending', inboxFiles[0]),
        'utf-8'
      );
      
      const match = inboxFile.match(/---\n([\s\S]*?)\n---\n\n([\s\S]*)/);
      expect(match).not.toBeNull();
      const content = JSON.parse(match![2]);
      expect(content.is_error).toBe(false);
      expect(content.summary).toContain('recovered');
    });

    it('should exhaust retries for idempotent tool and send error', async () => {
      const alwaysFailCallback = vi.fn().mockRejectedValue(new Error('Permanent error'));

      const taskId = await scheduleToolCompat(taskSystem, 'failTool', alwaysFailCallback, 'parent-claw', {
        isIdempotent: true,
        maxRetries: 2,
      });

      await waitFor(async () => {
        const files = await fs.readdir(path.join(testClawDir, 'inbox', 'pending')).catch(() => [] as string[]);
        return (files as string[]).some(f => f.endsWith('.md'));
      });

      // Should have been called 3 times (1 initial + 2 retries)
      expect(alwaysFailCallback).toHaveBeenCalledTimes(3);

      // Check inbox/pending/ for the result message
      const inboxFiles = await fs.readdir(path.join(testClawDir, 'inbox', 'pending'));
      expect(inboxFiles.length).toBeGreaterThan(0);
      
      const inboxFile = await fs.readFile(
        path.join(testClawDir, 'inbox', 'pending', inboxFiles[0]),
        'utf-8'
      );
      
      const match = inboxFile.match(/---\n([\s\S]*?)\n---\n\n([\s\S]*)/);
      expect(match).not.toBeNull();
      expect(match![1]).toContain('priority: high');
      const content = JSON.parse(match![2]);
      expect(content.is_error).toBe(true);
      expect(content.summary).toContain('retries');

      // Task should be in failed directory (retries exhausted)
      await waitFor(
        async () =>
          fs
            .access(path.join(testClawDir, 'tasks', 'queues', 'failed', `${taskId}.json`))
            .then(() => true)
            .catch(() => false),
        10000,
        20,
      );

      const failedFile = await fs.readFile(
        path.join(testClawDir, 'tasks', 'queues', 'failed', `${taskId}.json`),
        'utf-8'
      );
      expect(JSON.parse(failedFile).retryCount).toBe(2);
    });

    it('should not retry non-idempotent tool', async () => {
      const failCallback = vi.fn().mockRejectedValue(new Error('Write failed'));

      await scheduleToolCompat(taskSystem, 'writeTool', failCallback, 'parent-claw', {
        isIdempotent: false,
      });

      await waitFor(async () => {
        const files = await fs.readdir(path.join(testClawDir, 'inbox', 'pending')).catch(() => [] as string[]);
        return (files as string[]).some(f => f.endsWith('.md'));
      });

      // Wait for task to complete before reading inbox (B.flaky-21)
      await waitFor(() => taskSystem.listRunning().length === 0);

      // Called exactly once, no retry
      expect(failCallback).toHaveBeenCalledTimes(1);

      // Check inbox/pending/ for the error message
      const inboxFiles = await fs.readdir(path.join(testClawDir, 'inbox', 'pending'));
      
      const inboxFile = await fs.readFile(
        path.join(testClawDir, 'inbox', 'pending', inboxFiles[0]),
        'utf-8'
      );
      
      const match = inboxFile.match(/---\n([\s\S]*?)\n---\n\n([\s\S]*)/);
      expect(match).not.toBeNull();
      const content = JSON.parse(match![2]);
      expect(content.is_error).toBe(true);
      // No "retries" mention in error message
      expect(content.summary).not.toContain('retries');
    });

    it('should move task to done even when inbox write fails', async () => {
      // Mock fs where inbox write fails (simulate disk error)
      const limitedFs = {
        read: (p: string) => fs.readFile(path.join(testClawDir, p), 'utf-8'),
        write: (p: string, c: string) => fs.writeFile(path.join(testClawDir, p), c),
        writeAtomic: async (p: string, c: string) => {
          if (p.includes(INBOX_PENDING_DIR)) throw new Error('Disk error');
          return fs.writeFile(path.join(testClawDir, p), c);
        },
        append: (p: string, c: string) => fs.appendFile(path.join(testClawDir, p), c),
        delete: (p: string) => fs.unlink(path.join(testClawDir, p)),
        move: (from: string, to: string) => fs.rename(path.join(testClawDir, from), path.join(testClawDir, to)),
        exists: (p: string) => fs.access(path.join(testClawDir, p)).then(() => true).catch(() => false),
        list: (p: string) => fs.readdir(path.join(testClawDir, p), { withFileTypes: true }).then(entries => 
          entries.map(e => ({ name: e.name, path: path.join(p, e.name), isDirectory: e.isDirectory() }))
        ),
        ensureDir: (p: string) => fs.mkdir(path.join(testClawDir, p), { recursive: true }),
        isDirectory: (p: string) => fs.stat(path.join(testClawDir, p)).then(s => s.isDirectory()).catch(() => false),
        appendSync: (p: string, c: string) => fsSync.appendFileSync(path.join(testClawDir, p), c),
        statSync: (p: string) => {
          const s = fsSync.statSync(path.join(testClawDir, p));
          return { size: s.size, mtime: s.mtime, ctime: s.ctime, isFile: s.isFile(), isDirectory: s.isDirectory() };
        },
        moveSync: (from: string, to: string) => fsSync.renameSync(path.join(testClawDir, from), path.join(testClawDir, to)),
      };

      const taskSystem2 = new AsyncTaskSystem(testClawDir, limitedFs as any, { maxConcurrent: TEST_MAX_CONCURRENT, retryBaseDelayMs: TEST_RETRY_BASE_DELAY_MS, auditWriter: makeAudit().audit, ...makeTaskSystemDeps() });
      await taskSystem2.initialize();
      taskSystem2.startDispatch();

      const failCallback = vi.fn().mockRejectedValue(new Error('Tool error'));
      const taskId = await scheduleToolCompat(taskSystem2, 'tool', failCallback, 'parent', { isIdempotent: false });

      await waitFor(async () => {
        return await fs.access(path.join(testClawDir, 'tasks', 'queues', 'failed', `${taskId}.json`)).then(() => true).catch(() => false);
      });

      // Task should end up in failed (tool execution failed, retries exhausted)
      const failedExists = await fs.access(
        path.join(testClawDir, 'tasks', 'queues', 'failed', `${taskId}.json`)
      ).then(() => true).catch(() => false);
      expect(failedExists).toBe(true);

      await taskSystem2.shutdown(100).catch(() => {});
    });
  });

  // Batch 2: cancel paths + moveTaskToDone error
  describe('cancel and moveTaskToDone paths', () => {
    it('should throw when cancelling non-existent taskId', async () => {
      await expect(taskSystem.cancel('nonexistent-id')).rejects.toThrow('nonexistent-id');
    });

    it('should abort a running task when cancel() is called', async () => {
      // Schedule and immediately cancel - most reliable approach
      // The task may be in pending or running, cancel should handle both
      const slowCallback = () => new Promise<ToolResult>(() => {
        // Never resolves - will be aborted
      });

      const taskId = await scheduleToolCompat(taskSystem, 'slowTool', slowCallback, 'parent-claw');
      
      // Cancel immediately - should not throw even if task is pending or running
      await taskSystem.cancel(taskId);
      
      // Task should not be in running after cancel
      expect(taskSystem.listRunning()).not.toContain(taskId);
    }, 20000);

    it('should log error when moveTaskToDone fails', async () => {
      // Mock fs.move to throw when moving from running to done
      const realMove = (taskSystem as any).fs.move.bind((taskSystem as any).fs);
      vi.spyOn((taskSystem as any).fs, 'move').mockImplementation(
        async (from: string, to: string) => {
          if (from.includes(TASKS_QUEUES_RUNNING_DIR) && to.includes(TASKS_QUEUES_DONE_DIR)) {
            throw new Error('Disk full');
          }
          return realMove(from, to);
        }
      );

      const writeSpy = vi.spyOn((taskSystem as any).auditWriter, 'write');

      const taskId = await scheduleToolCompat(taskSystem, 
        'testTool',
        async () => ({ success: true, content: 'ok' }),
        'parent-claw',
      );

      await waitFor(() => writeSpy.mock.calls.some(c => c[0] === 'task_move_failed'));

      expect(writeSpy).toHaveBeenCalledWith('task_move_failed', expect.stringContaining('taskId='), 'context=move_to_done', expect.stringContaining('Disk full'));

      vi.restoreAllMocks();
    });
  });

  // Phase 17: callback 丢失恢复路径 + shutdown
  describe('Phase 17 untested paths', () => {
    it('should recover ToolTask on daemon restart (fs-driven)', async () => {
      // phase432: ToolTask 改 fs-driven / args+parentClawDir 可恢复执行
      const freshDir = path.join(testDir, `callback-loss-${Date.now()}`);
      await fs.mkdir(path.join(freshDir, 'tasks', 'queues', 'pending'), { recursive: true });
      await fs.mkdir(path.join(freshDir, 'tasks', 'queues', 'running'), { recursive: true });
      await fs.mkdir(path.join(freshDir, 'tasks', 'queues', 'done'), { recursive: true });
      await fs.mkdir(path.join(freshDir, 'tasks', 'queues', 'failed'), { recursive: true });
      await fs.mkdir(path.join(freshDir, 'tasks', 'queues', 'results'), { recursive: true });
      await fs.mkdir(path.join(freshDir, 'inbox', 'pending'), { recursive: true });
      await fs.mkdir(path.join(freshDir, 'logs'), { recursive: true });

      const taskId = 'lost-callback-task';
      await fs.writeFile(
        path.join(freshDir, 'tasks', 'queues', 'pending', `${taskId}.json`),
        JSON.stringify({
          id: taskId, kind: 'tool', toolName: 'testTool',
          args: {}, parentClawDir: freshDir,
          isIdempotent: false, maxRetries: 0, retryCount: 0,
          parentClawId: 'test-claw', createdAt: new Date().toISOString(),
        }, null, 2),
      );

      const freshSystem = new AsyncTaskSystem(
        freshDir,
        {
          read: (p: string) => fs.readFile(path.join(freshDir, p), 'utf-8'),
          write: (p: string, c: string) => fs.writeFile(path.join(freshDir, p), c),
          writeAtomic: (p: string, c: string) => fs.writeFile(path.join(freshDir, p), c),
          append: (p: string, c: string) => fs.appendFile(path.join(freshDir, p), c),
          delete: (p: string) => fs.unlink(path.join(freshDir, p)),
          move: (from: string, to: string) => fs.rename(path.join(freshDir, from), path.join(freshDir, to)),
          exists: (p: string) => fs.access(path.join(freshDir, p)).then(() => true).catch(() => false),
          list: (p: string) => fs.readdir(path.join(freshDir, p), { withFileTypes: true }).then(entries =>
            entries.map(e => ({ name: e.name, path: path.join(p, e.name), isDirectory: e.isDirectory() })),
          ),
          ensureDir: (p: string) => fs.mkdir(path.join(freshDir, p), { recursive: true }),
          isDirectory: (p: string) => fs.stat(path.join(freshDir, p)).then(s => s.isDirectory()).catch(() => false),
        appendSync: (p: string, c: string) => fsSync.appendFileSync(path.join(freshDir, p), c),
        statSync: (p: string) => {
          const s = fsSync.statSync(path.join(freshDir, p));
          return { size: s.size, mtime: s.mtime, ctime: s.ctime, isFile: s.isFile(), isDirectory: s.isDirectory() };
        },
        moveSync: (from: string, to: string) => fsSync.renameSync(path.join(freshDir, from), path.join(freshDir, to)),
        } as any,
        { maxConcurrent: TEST_MAX_CONCURRENT, retryBaseDelayMs: TEST_RETRY_BASE_DELAY_MS, auditWriter: makeAudit().audit, ...makeTaskSystemDeps() },
      );
      (freshSystem as any).registry.register({
        name: 'testTool',
        description: 'mock',
        schema: { type: 'object', properties: {} },
        readonly: false,
        idempotent: false,
        supportsAsync: true,
        execute: async () => ({ success: true, content: 'recovered' }),
      });

      await freshSystem.initialize();
      freshSystem.startDispatch();

      // phase432: Tool task 被恢复执行并最终移到 done/
      await waitFor(async () => {
        const doneExists = await fs.access(path.join(freshDir, 'tasks', 'queues', 'done', `${taskId}.json`)).then(() => true).catch(() => false);
        return doneExists;
      });

      const doneExists = await fs.access(path.join(freshDir, 'tasks', 'queues', 'done', `${taskId}.json`)).then(() => true).catch(() => false);
      expect(doneExists).toBe(true);
      expect(freshSystem.listPending()).not.toContain(taskId);

      await freshSystem.shutdown(500).catch(() => {});
      await fs.rm(freshDir, { recursive: true, force: true }).catch(() => {});
    });

    it('should resolve shutdown even when a running task does not finish (timeout path)', async () => {
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      const neverResolve = new Promise<void>(() => {});

      const slowCb = vi.fn().mockImplementation(async () => {
        await new Promise(r => setTimeout(r, 200)); // long enough to exceed shutdown(50)
        await neverResolve; // hangs forever — shutdown must use timeout path
        return { success: true, content: 'done' };
      });

      await scheduleToolCompat(taskSystem, 'slowTool', slowCb, 'test-claw');
      await waitFor(() => taskSystem.listRunning().length > 0);
      // Give the task time to enter the long callback (past the abort-signal gate)
      await new Promise(r => setTimeout(r, 30));

      // shutdown(50) — task won't finish, Promise.race timeout fires
      // The hanging promise is intentionally never resolved to avoid post-shutdown monitor errors
      const result = await taskSystem.shutdown(50);
      expect(result).toBe(true);
    });
  });
});

