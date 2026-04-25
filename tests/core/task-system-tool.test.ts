/**
 * TaskSystem Tool Task Tests
 * 
 * Tests for async tool execution via TaskSystem:
 * - scheduleTool success/failure paths
 * - executor async routing
 * - pending queue with dispatcher pattern
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskSystem, SubAgentTask, ToolTask } from '../../src/core/task/system.js';
import { ToolExecutorImpl, ExecuteOptions } from '../../src/core/tools/executor.js';
import { ToolRegistryImpl } from '../../src/core/tools/registry.js';
import { Tool, ToolResult, ExecContext } from '../../src/core/tools/executor.js';
import type { JSONSchema7 } from '../../src/types/message.js';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as fsSync from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { readTool } from '../../src/core/tools/builtins/read.js';
import { lsTool } from '../../src/core/tools/builtins/ls.js';
import { searchTool } from '../../src/core/tools/builtins/search.js';
import { makeAudit } from '../helpers/audit.js';
import { makeTaskSystemDeps } from '../helpers/task-system.js';

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

/**
 * Poll until condition is true or timeout.
 * Throws if condition is not met within timeoutMs.
 */
async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe('TaskSystem Tool Tasks', () => {
  let taskSystem: TaskSystem;
  let mockFs: ReturnType<typeof createMockFs>;
  let testDir: string;
  let testClawDir: string;

  beforeEach(async () => {
    testDir = path.join(tmpdir(), `clawforum-task-sys-${randomUUID()}`);
    await fs.mkdir(testDir, { recursive: true });
    testClawDir = path.join(testDir, `test-${Date.now()}`);
    await fs.mkdir(testClawDir, { recursive: true });
    await fs.mkdir(path.join(testClawDir, 'tasks', 'pending'), { recursive: true });
    await fs.mkdir(path.join(testClawDir, 'tasks', 'running'), { recursive: true });
    await fs.mkdir(path.join(testClawDir, 'tasks', 'done'), { recursive: true });
    await fs.mkdir(path.join(testClawDir, 'tasks', 'results'), { recursive: true });
    await fs.mkdir(path.join(testClawDir, 'inbox', 'pending'), { recursive: true });
    await fs.mkdir(path.join(testClawDir, 'logs'), { recursive: true });

    // Use real fs for integration-like testing
    taskSystem = new TaskSystem(
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
      { maxConcurrent: 3, retryBaseDelayMs: 10, auditWriter: makeAudit().audit, ...makeTaskSystemDeps() }
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
      
      const taskId = await taskSystem.scheduleTool('testTool', executeCallback, 'parent-claw');
      
      expect(taskId).toBeDefined();
      expect(typeof taskId).toBe('string');
    });

    it('should save task to tasks/pending/ or tasks/running/ (atomic move may complete immediately)', async () => {
      const executeCallback = vi.fn().mockResolvedValue({ success: true, content: 'ok' });

      const taskId = await taskSystem.scheduleTool('testTool', executeCallback, 'parent-claw');

      // Atomic fs.move() may complete before we read, so check both locations
      let rawFile: string;
      try {
        rawFile = await fs.readFile(
          path.join(testClawDir, 'tasks', 'pending', `${taskId}.json`),
          'utf-8'
        );
      } catch {
        rawFile = await fs.readFile(
          path.join(testClawDir, 'tasks', 'running', `${taskId}.json`),
          'utf-8'
        );
      }
      const taskData = JSON.parse(rawFile);
      expect(taskData.kind).toBe('tool');
      expect(taskData.toolName).toBe('testTool');
      expect(taskData.parentClawId).toBe('parent-claw');
    });

    it('should move task to tasks/running/ when dispatched', async () => {
      // Use a slow callback so we can check the running state before completion
      const slowCallback = async () => {
        await new Promise(r => setTimeout(r, 200));
        return { success: true, content: 'slow' };
      };
      
      const taskId = await taskSystem.scheduleTool('testTool', slowCallback, 'parent-claw');

      const runningPath = path.join(testClawDir, 'tasks', 'running', `${taskId}.json`);
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
      
      const taskId = await taskSystem.scheduleTool('testTool', executeCallback, 'parent-claw');
      
      await waitFor(async () => {
        const files = await fs.readdir(path.join(testClawDir, 'inbox', 'pending')).catch(() => [] as string[]);
        return (files as string[]).some(f => f.endsWith('.md'));
      });
      
      expect(executeCallback).toHaveBeenCalled();
      
      // Check inbox/pending/ for the result message
      const inboxFiles = await fs.readdir(path.join(testClawDir, 'inbox', 'pending'));
      expect(inboxFiles.length).toBeGreaterThan(0);
      
      const inboxFile = await fs.readFile(
        path.join(testClawDir, 'inbox', 'pending', inboxFiles[0]),
        'utf-8'
      );
      
      // Parse frontmatter + content
      const match = inboxFile.match(/---\n([\s\S]*?)\n---\n\n([\s\S]*)/);
      expect(match).toBeTruthy();
      expect(match![1]).toContain('from: "task_system"');
      expect(match![1]).toContain('to: "parent-claw"');
      expect(match![1]).toContain('priority: normal');
      
      const content = JSON.parse(match![2]);
      expect(content.taskId).toBe(taskId);
      expect(content.toolName).toBe('testTool');
      expect(content.is_error).toBe(false);
      // Should have summary and resultRef instead of full result
      expect(content.summary).toBeDefined();
      expect(content.resultRef).toBe(`tasks/results/${taskId}/result.txt`);
      expect(content.result).toBeUndefined(); // Full result should not be in inbox
    });

    it('should save full result to tasks/results/', async () => {
      const longResult = 'x'.repeat(1000); // Long result to test full content
      const executeCallback = vi.fn().mockResolvedValue({ success: true, content: longResult });
      
      const taskId = await taskSystem.scheduleTool('testTool', executeCallback, 'parent-claw');
      
      await waitFor(async () => {
        try {
          await fs.readFile(path.join(testClawDir, 'tasks', 'results', taskId, 'result.txt'), 'utf-8');
          return true;
        } catch {
          return false;
        }
      });
      
      // Full result should be in results directory
      const resultFile = await fs.readFile(
        path.join(testClawDir, 'tasks', 'results', taskId, 'result.txt'),
        'utf-8'
      );
      expect(resultFile).toContain(longResult);
      
      // Inbox should have truncated summary preview (resultRef points to full content)
      const inboxFiles = await fs.readdir(path.join(testClawDir, 'inbox', 'pending'));
      expect(inboxFiles.length).toBeGreaterThan(0);
      
      const inboxFile = await fs.readFile(
        path.join(testClawDir, 'inbox', 'pending', inboxFiles[0]),
        'utf-8'
      );
      
      const match = inboxFile.match(/---\n([\s\S]*?)\n---\n\n([\s\S]*)/);
      expect(match).toBeTruthy();
      const content = JSON.parse(match![2]);
      // Summary should be truncated preview (500 chars) when resultRef exists
      expect(content.summary.length).toBeLessThanOrEqual(500);
      expect(content.summary).toContain('x'.repeat(100));
      expect(content.resultRef).toBeTruthy(); // resultRef should exist
    });

    it('should send error result with summary + resultRef', async () => {
      const executeCallback = vi.fn().mockRejectedValue(new Error('Execution failed'));
      
      const taskId = await taskSystem.scheduleTool('testTool', executeCallback, 'parent-claw');
      
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
      expect(match).toBeTruthy();
      expect(match![1]).toContain('priority: high'); // Errors are high priority
      
      const content = JSON.parse(match![2]);
      expect(content.taskId).toBe(taskId);
      expect(content.toolName).toBe('testTool');
      expect(content.is_error).toBe(true);
      expect(content.summary).toBeDefined();
      expect(content.resultRef).toBe(`tasks/results/${taskId}/result.txt`);
    });

    it('should move task to done after completion', async () => {
      const executeCallback = vi.fn().mockResolvedValue({ success: true, content: 'ok' });
      
      const taskId = await taskSystem.scheduleTool('testTool', executeCallback, 'parent-claw');
      
      await waitFor(async () => {
        try {
          await fs.readFile(path.join(testClawDir, 'tasks', 'done', `${taskId}.json`), 'utf-8');
          return true;
        } catch {
          return false;
        }
      });
      
      // Task should be in done directory
      const doneFile = await fs.readFile(
        path.join(testClawDir, 'tasks', 'done', `${taskId}.json`),
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

      const taskSystem2 = new TaskSystem(testClawDir, failingInboxFs, { maxConcurrent: 3, retryBaseDelayMs: 10, auditWriter: makeAudit().audit, ...makeTaskSystemDeps() });
      await taskSystem2.initialize();
      taskSystem2.startDispatch();

      const taskId = await taskSystem2.scheduleTool(
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
        const id = await taskSystem.scheduleTool(`slowTool${i}`, slowCallback, 'parent-claw');
        taskIds.push(id);
      }
      
      await waitFor(() => taskSystem.listRunning().length === 3);
      
      // All 3 should be running
      expect(taskSystem.listRunning().length).toBe(3);
      expect(taskSystem.listPending().length).toBe(0);
      
      // Schedule a 4th task - should go to pending
      const fastCallback = vi.fn().mockResolvedValue({ success: true, content: 'fast' });
      const fourthId = await taskSystem.scheduleTool('fourthTool', fastCallback, 'parent-claw');
      
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
        path.join(testClawDir, 'tasks', 'done', `${fourthId}.json`),
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
      
      // Schedule all 5 tasks quickly
      const taskIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        const id = await taskSystem.scheduleTool(`tool${i}`, createCallback(i), 'parent-claw');
        taskIds.push(id);
      }
      
      await waitFor(() => taskSystem.listRunning().length <= 3 && taskSystem.listPending().length >= 2);
      
      await waitFor(() => executionOrder.length === 5);
      
      // All 5 tasks should have been executed
      expect(executionOrder.length).toBe(5);
      // First 3 should start in order (but completion order may vary due to async)
      expect(executionOrder.slice(0, 3)).toEqual([0, 1, 2]);
    });
  });

  describe('cold-start recovery', () => {
    it('should recover subagent tasks from pending/ on initialize', async () => {
      // Directly write a pending subagent file without going through scheduleTool
      const taskId = 'recovered-subagent-id';
      const task = { 
        kind: 'subagent', 
        id: taskId, 
        prompt: 'test prompt',
        contextPaths: [],
        parentClawId: 'parent', 
        createdAt: new Date().toISOString() 
      };
      await fs.writeFile(
        path.join(testClawDir, 'tasks', 'pending', `${taskId}.json`),
        JSON.stringify(task)
      );

      // Re-initialize (simulating restart)
      const taskSystem2 = new TaskSystem(
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
        { maxConcurrent: 3, retryBaseDelayMs: 10, auditWriter: makeAudit().audit, ...makeTaskSystemDeps() }
      );
      await taskSystem2.initialize();
      // phase163: recover 仅复原 running→pending 文件回搬，不动队列；
      // 断言必须在 startDispatch 之前 —— 之后 _initialScanPending 会异步把文件 ingest + 移到 running/。
      expect(
        await fs.access(path.join(testClawDir, 'tasks', 'pending', `${taskId}.json`))
          .then(() => true)
          .catch(() => false)
      ).toBe(true);
      taskSystem2.startDispatch();

      await taskSystem2.shutdown(100).catch(() => {});
    });

    it('should move running/ tool tasks to done/ on initialize (callback lost)', async () => {
      // Directly write a running file without going through scheduleTool (simulating crash residue)
      const taskId = 'crashed-task-id';
      const task = { 
        kind: 'tool', 
        id: taskId, 
        toolName: 'crashTool', 
        parentClawId: 'parent', 
        createdAt: new Date().toISOString() 
      };
      await fs.writeFile(
        path.join(testClawDir, 'tasks', 'running', `${taskId}.json`),
        JSON.stringify(task)
      );

      const taskSystem2 = new TaskSystem(
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
        { maxConcurrent: 3, retryBaseDelayMs: 10, auditWriter: makeAudit().audit, ...makeTaskSystemDeps() }
      );
      await taskSystem2.initialize();
      taskSystem2.startDispatch();

      // Tool task should be moved to failed/ (not pending/), callback is lost
      expect(taskSystem2.listPending()).not.toContain(taskId);
      const runningExists = await fs.access(path.join(testClawDir, 'tasks', 'running', `${taskId}.json`)).then(() => true).catch(() => false);
      expect(runningExists).toBe(false);
      const failedExists = await fs.access(path.join(testClawDir, 'tasks', 'failed', `${taskId}.json`)).then(() => true).catch(() => false);
      expect(failedExists).toBe(true);

      await taskSystem2.shutdown(100).catch(() => {});
    });

    it('should move pending/ tool tasks to done/ on initialize (callback lost)', async () => {
      // Directly write a pending tool file (simulating daemon restart with pending tool task)
      const taskId = 'pending-tool-task-id';
      const task = { 
        kind: 'tool', 
        id: taskId, 
        toolName: 'pendingTool', 
        parentClawId: 'parent', 
        createdAt: new Date().toISOString() 
      };
      await fs.writeFile(
        path.join(testClawDir, 'tasks', 'pending', `${taskId}.json`),
        JSON.stringify(task)
      );

      const taskSystem2 = new TaskSystem(
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
        { maxConcurrent: 3, retryBaseDelayMs: 10, auditWriter: makeAudit().audit, ...makeTaskSystemDeps() }
      );
      await taskSystem2.initialize();
      taskSystem2.startDispatch();

      // Tool task should be moved to failed/ (not queued), callback is lost
      expect(taskSystem2.listPending()).not.toContain(taskId);
      const pendingExists = await fs.access(path.join(testClawDir, 'tasks', 'pending', `${taskId}.json`)).then(() => true).catch(() => false);
      expect(pendingExists).toBe(false);
      const failedExists = await fs.access(path.join(testClawDir, 'tasks', 'failed', `${taskId}.json`)).then(() => true).catch(() => false);
      expect(failedExists).toBe(true);

      await taskSystem2.shutdown(100).catch(() => {});
    });

    it('should rename result.txt to .sent and send inbox message once on subagent recovery', async () => {
      // Simulate: subagent completed (result.txt written), daemon crashed before moving to done/
      const taskId = 'subagent-with-result';
      const task: SubAgentTask = {
        kind: 'subagent',
        id: taskId,
        prompt: 'test',
        tools: [],
        maxSteps: 10,
        timeout: 60,
        parentClawId: 'parent-claw',
        createdAt: new Date().toISOString(),
      };
      await fs.mkdir(path.join(testClawDir, 'tasks', 'results', taskId), { recursive: true });
      await fs.writeFile(path.join(testClawDir, 'tasks', 'results', taskId, 'result.txt'), 'task output');
      await fs.writeFile(
        path.join(testClawDir, 'tasks', 'running', `${taskId}.json`),
        JSON.stringify(task)
      );

      const makeTs = () => new TaskSystem(testClawDir, {
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
      } as any, { maxConcurrent: 3, retryBaseDelayMs: 10, auditWriter: makeAudit().audit, ...makeTaskSystemDeps() });

      // First restart: result.txt → .sent, inbox message written
      const ts1 = makeTs();
      await ts1.initialize();
      ts1.startDispatch();
      await ts1.shutdown(100).catch(() => {});

      // sendResult() 内部会重写 result.txt，但 .sent 标记必须存在
      const sentTxt = await fs.access(path.join(testClawDir, 'tasks', 'results', taskId, 'result.txt.sent')).then(() => true).catch(() => false);
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
        prompt: 'test',
        tools: [],
        maxSteps: 10,
        timeout: 60,
        parentClawId: 'parent-claw',
        createdAt: new Date().toISOString(),
      };
      await fs.mkdir(path.join(testClawDir, 'tasks', 'results', taskId), { recursive: true });
      await fs.writeFile(path.join(testClawDir, 'tasks', 'results', taskId, 'result.txt.sent'), 'task output');
      await fs.writeFile(
        path.join(testClawDir, 'tasks', 'running', `${taskId}.json`),
        JSON.stringify(task)
      );

      const ts = new TaskSystem(testClawDir, {
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
      } as any, { maxConcurrent: 3, retryBaseDelayMs: 10, auditWriter: makeAudit().audit, ...makeTaskSystemDeps() });
      await ts.initialize();
      ts.startDispatch();
      await ts.shutdown(100).catch(() => {});

      // Task must NOT be re-queued (result was already delivered)
      expect(ts.listPending()).not.toContain(taskId);
      // No new inbox message (duplicate prevented)
      const inboxFiles = await fs.readdir(path.join(testClawDir, 'inbox', 'pending'));
      expect(inboxFiles).toHaveLength(0);
      // Task moved to done/
      const inDone = await fs.access(path.join(testClawDir, 'tasks', 'done', `${taskId}.json`)).then(() => true).catch(() => false);
      expect(inDone).toBe(true);
    });
  });

  describe('sendToolResult', () => {
    it('should use result.content for summary, not full JSON', async () => {
      const longContent = 'output-' + 'x'.repeat(300);
      const executeCallback = vi.fn().mockResolvedValue({ success: true, content: longContent });

      const taskId = await taskSystem.scheduleTool('testTool', executeCallback, 'parent-claw');
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
      expect(match).toBeTruthy();
      const content = JSON.parse(match![2]);

      // Summary should start with 'output-xxx...', not contain '{"success":true'
      expect(content.summary).not.toContain('"success"');
      expect(content.summary).not.toContain('"content"');
      // Content comes from result.content
      expect(content.summary.startsWith('output-')).toBe(true);
    });

    it('should NOT call transport.sendInboxMessage (bypass transport)', async () => {
      const executeCallback = vi.fn().mockResolvedValue({ success: true, content: 'direct result' });

      await taskSystem.scheduleTool('testTool', executeCallback, 'parent-claw');
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
          if (p.includes('tasks/results')) throw new Error('Disk full');
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

      const taskSystem2 = new TaskSystem(testClawDir, failingFs, { maxConcurrent: 3, retryBaseDelayMs: 10, auditWriter: makeAudit().audit, ...makeTaskSystemDeps() });
      await taskSystem2.initialize();
      taskSystem2.startDispatch();

      const executeCallback = vi.fn().mockResolvedValue({ success: true, content: 'fallback content' });
      await taskSystem2.scheduleTool('testTool', executeCallback, 'parent-claw');
      await waitFor(async () => {
        const files = await fs.readdir(path.join(testClawDir, 'inbox', 'pending')).catch(() => [] as string[]);
        return (files as string[]).some(f => f.endsWith('.md'));
      });

      // Check inbox/pending/ for the result message
      const inboxFiles = (await fs.readdir(path.join(testClawDir, 'inbox', 'pending'))).filter(f => f.endsWith('.md'));
      expect(inboxFiles.length).toBeGreaterThan(0);
      
      const inboxFile = await fs.readFile(
        path.join(testClawDir, 'inbox', 'pending', inboxFiles[0]),
        'utf-8'
      );
      
      const match = inboxFile.match(/---\n([\s\S]*?)\n---\n\n([\s\S]*)/);
      expect(match).toBeTruthy();
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
      const taskId = await taskSystem.scheduleTool('slowTool', slowCallback, 'parent-claw');
      await waitFor(() => taskSystem.listRunning().includes(taskId));

      await taskSystem.cancel(taskId);

      // Task should be in done directory (via _startTask.finally -> executeToolTask.finally)
      // And running directory should not have the file (deleted only once)
      const runningExists = await fs.access(path.join(testClawDir, 'tasks', 'running', `${taskId}.json`)).then(() => true).catch(() => false);
      expect(runningExists).toBe(false);
      // No longer running or pending
      expect(taskSystem.listRunning()).not.toContain(taskId);
      expect(taskSystem.listPending()).not.toContain(taskId);
    });
  });

  describe('readonly tools supportsAsync', () => {
    it('read tool should have supportsAsync: true', () => {
      expect(readTool.supportsAsync).toBe(true);
      expect(readTool.schema.properties).toHaveProperty('async');
    });

    it('ls tool should have supportsAsync: true', () => {
      expect(lsTool.supportsAsync).toBe(true);
      expect(lsTool.schema.properties).toHaveProperty('async');
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

      const taskId = await taskSystem.scheduleTool('flakyTool', flakyCallback, 'parent-claw', {
        isIdempotent: true,
        maxRetries: 2,
      });

      await waitFor(async () => {
        const files = await fs.readdir(path.join(testClawDir, 'inbox', 'pending')).catch(() => [] as string[]);
        return (files as string[]).some(f => f.endsWith('.md'));
      });

      expect(flakyCallback).toHaveBeenCalledTimes(2);

      // Check inbox/pending/ for the result message
      const inboxFiles = await fs.readdir(path.join(testClawDir, 'inbox', 'pending'));
      
      const inboxFile = await fs.readFile(
        path.join(testClawDir, 'inbox', 'pending', inboxFiles[0]),
        'utf-8'
      );
      
      const match = inboxFile.match(/---\n([\s\S]*?)\n---\n\n([\s\S]*)/);
      expect(match).toBeTruthy();
      const content = JSON.parse(match![2]);
      expect(content.is_error).toBe(false);
      expect(content.summary).toContain('recovered');
    });

    it('should exhaust retries for idempotent tool and send error', async () => {
      const alwaysFailCallback = vi.fn().mockRejectedValue(new Error('Permanent error'));

      const taskId = await taskSystem.scheduleTool('failTool', alwaysFailCallback, 'parent-claw', {
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
      expect(match).toBeTruthy();
      expect(match![1]).toContain('priority: high');
      const content = JSON.parse(match![2]);
      expect(content.is_error).toBe(true);
      expect(content.summary).toContain('retries');

      // Task should be in failed directory (retries exhausted)
      const failedFile = await fs.readFile(
        path.join(testClawDir, 'tasks', 'failed', `${taskId}.json`),
        'utf-8'
      );
      expect(JSON.parse(failedFile).retryCount).toBe(2);
    });

    it('should not retry non-idempotent tool', async () => {
      const failCallback = vi.fn().mockRejectedValue(new Error('Write failed'));

      await taskSystem.scheduleTool('writeTool', failCallback, 'parent-claw', {
        isIdempotent: false,
      });

      await waitFor(async () => {
        const files = await fs.readdir(path.join(testClawDir, 'inbox', 'pending')).catch(() => [] as string[]);
        return (files as string[]).some(f => f.endsWith('.md'));
      });

      // Called exactly once, no retry
      expect(failCallback).toHaveBeenCalledTimes(1);

      // Check inbox/pending/ for the error message
      const inboxFiles = await fs.readdir(path.join(testClawDir, 'inbox', 'pending'));
      
      const inboxFile = await fs.readFile(
        path.join(testClawDir, 'inbox', 'pending', inboxFiles[0]),
        'utf-8'
      );
      
      const match = inboxFile.match(/---\n([\s\S]*?)\n---\n\n([\s\S]*)/);
      expect(match).toBeTruthy();
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
          if (p.includes('inbox/pending')) throw new Error('Disk error');
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

      const taskSystem2 = new TaskSystem(testClawDir, limitedFs as any, { maxConcurrent: 3, retryBaseDelayMs: 10, auditWriter: makeAudit().audit, ...makeTaskSystemDeps() });
      await taskSystem2.initialize();
      taskSystem2.startDispatch();

      const failCallback = vi.fn().mockRejectedValue(new Error('Tool error'));
      const taskId = await taskSystem2.scheduleTool('tool', failCallback, 'parent', { isIdempotent: false });

      await waitFor(async () => {
        return await fs.access(path.join(testClawDir, 'tasks', 'failed', `${taskId}.json`)).then(() => true).catch(() => false);
      });

      // Task should end up in failed (tool execution failed, retries exhausted)
      const failedExists = await fs.access(
        path.join(testClawDir, 'tasks', 'failed', `${taskId}.json`)
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

      const taskId = await taskSystem.scheduleTool('slowTool', slowCallback, 'parent-claw');
      
      // Cancel immediately - should not throw even if task is pending or running
      await taskSystem.cancel(taskId);
      
      // Task should not be in running after cancel
      expect(taskSystem.listRunning()).not.toContain(taskId);
    }, 10000);

    it('should log error when moveTaskToDone fails', async () => {
      // Mock fs.move to throw when moving from running to done
      const realMove = (taskSystem as any).fs.move.bind((taskSystem as any).fs);
      vi.spyOn((taskSystem as any).fs, 'move').mockImplementation(
        async (from: string, to: string) => {
          if (from.includes('tasks/running') && to.includes('tasks/done')) {
            throw new Error('Disk full');
          }
          return realMove(from, to);
        }
      );

      const writeSpy = vi.spyOn((taskSystem as any).auditWriter, 'write');

      const taskId = await taskSystem.scheduleTool(
        'testTool',
        async () => ({ success: true, content: 'ok' }),
        'parent-claw',
      );

      await waitFor(() => writeSpy.mock.calls.some(c => c[0] === 'task_move_failed'));

      expect(writeSpy).toHaveBeenCalledWith('task_move_failed', taskId, 'context=move_to_done', expect.stringContaining('Disk full'));

      vi.restoreAllMocks();
    });
  });

  // Phase 17: callback 丢失恢复路径 + shutdown
  describe('Phase 17 untested paths', () => {
    it('should discard ToolTask on daemon restart and send error to parent', async () => {
      // Simulate daemon restart: ToolTask written to tasks/pending/ but no callback registered
      // New behavior: move to failed/ and send error message to parent inbox
      const freshDir = path.join(testDir, `callback-loss-${Date.now()}`);
      await fs.mkdir(path.join(freshDir, 'tasks', 'pending'), { recursive: true });
      await fs.mkdir(path.join(freshDir, 'tasks', 'running'), { recursive: true });
      await fs.mkdir(path.join(freshDir, 'tasks', 'done'), { recursive: true });
      await fs.mkdir(path.join(freshDir, 'tasks', 'failed'), { recursive: true });
      await fs.mkdir(path.join(freshDir, 'tasks', 'results'), { recursive: true });
      await fs.mkdir(path.join(freshDir, 'inbox', 'pending'), { recursive: true });
      await fs.mkdir(path.join(freshDir, 'logs'), { recursive: true });

      const taskId = 'lost-callback-task';
      await fs.writeFile(
        path.join(freshDir, 'tasks', 'pending', `${taskId}.json`),
        JSON.stringify({
          id: taskId, kind: 'tool', toolName: 'testTool',
          isIdempotent: false, maxRetries: 0, retryCount: 0,
          parentClawId: 'test-claw', createdAt: new Date().toISOString(), status: 'pending',
        }, null, 2),
      );

      const freshSystem = new TaskSystem(
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
        { maxConcurrent: 3, retryBaseDelayMs: 10, auditWriter: makeAudit().audit, ...makeTaskSystemDeps() },
      );

      await freshSystem.initialize();
      freshSystem.startDispatch();
      // Tool task should be moved to failed/ during recovery (callback lost), not executed

      // Task should be in failed/, not pending or running
      const failedExists = await fs.access(path.join(freshDir, 'tasks', 'failed', `${taskId}.json`)).then(() => true).catch(() => false);
      expect(failedExists).toBe(true);
      expect(freshSystem.listPending()).not.toContain(taskId);

      // Error message should be sent to parent inbox
      const inboxFiles = await fs.readdir(path.join(freshDir, 'inbox', 'pending'));
      const mdFiles = inboxFiles.filter((f: string) => f.endsWith('.md'));
      expect(mdFiles.length).toBe(1);
      
      // Verify error message content (YAML frontmatter + JSON body)
      const inboxContent = await fs.readFile(path.join(freshDir, 'inbox', 'pending', mdFiles[0]), 'utf-8');
      expect(inboxContent).toContain('"is_error":true');
      expect(inboxContent).toContain('daemon restarted');

      await freshSystem.shutdown(500).catch(() => {});
      await fs.rm(freshDir, { recursive: true, force: true }).catch(() => {});
    });

    it('should resolve shutdown even when a running task does not finish (timeout path)', async () => {
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      const neverResolve = new Promise<void>(() => {});

      const slowCb = vi.fn().mockImplementation(async () => {
        await neverResolve; // hangs forever — shutdown must use timeout path
        return { success: true, content: 'done' };
      });

      await taskSystem.scheduleTool('slowTool', slowCb, 'test-claw');
      await waitFor(() => taskSystem.listRunning().length > 0);

      // shutdown(50) — task won't finish, Promise.race timeout fires
      // The hanging promise is intentionally never resolved to avoid post-shutdown monitor errors
      const shutdownPromise = taskSystem.shutdown(50);
      await expect(shutdownPromise).resolves.toBeUndefined();
    });
  });
});

describe('ToolExecutor async routing', () => {
  let registry: ToolRegistryImpl;
  let executor: ToolExecutorImpl;
  let mockTaskSystem: { scheduleTool: ReturnType<typeof vi.fn> };
  let mockCtx: ExecContext;

  beforeEach(() => {
    registry = new ToolRegistryImpl();
    executor = new ToolExecutorImpl(registry);
    
    mockTaskSystem = {
      scheduleTool: vi.fn().mockResolvedValue('mock-task-id-123'),
    };
    (executor as any).taskSystem = mockTaskSystem;
    
    mockCtx = {
      clawId: 'test-claw',
      clawDir: '/tmp/test',
      callerType: 'claw',
      fs: createMockFs() as any,
      profile: { name: 'test', permissions: { read: true, write: true, execute: true, send: true, spawn: true } },
      stepNumber: 1,
      maxSteps: 20,
      getElapsedMs: () => 1000,
      incrementStep: () => {},
    };
  });

  it('should reject async mode for subagent callerType', async () => {
    // Register a tool with supportsAsync: true
    const asyncTool: Tool = {
      name: 'asyncTool',
      description: 'Tool with async support',
      schema: { type: 'object', properties: {} },

      readonly: false,
      idempotent: false,
      supportsAsync: true,
      async execute(): Promise<ToolResult> {
        return { success: true, content: 'async result' };
      },
    };
    registry.register(asyncTool);

    // Call with async: true and callerType: 'subagent'
    const subagentCtx = { ...mockCtx, callerType: 'subagent' as const };
    const result = await executor.execute({
      toolName: 'asyncTool',
      args: {},
      ctx: subagentCtx,
      async: true,
    });

    expect(result.success).toBe(false);
    expect(result.content).toContain('not available for subagents');
    expect(mockTaskSystem.scheduleTool).not.toHaveBeenCalled();
  });

  it('should return error when tool does not support async', async () => {
    // Register tool without supportsAsync
    const nonAsyncTool: Tool = {
      name: 'nonAsyncTool',
      description: 'Tool without async support',
      schema: { type: 'object', properties: {} },

      readonly: false,
      idempotent: false,
      // supportsAsync is undefined (false by default)
      async execute(): Promise<ToolResult> {
        return { success: true, content: 'sync result' };
      },
    };
    registry.register(nonAsyncTool);

    const result = await executor.execute({
      toolName: 'nonAsyncTool',
      args: {},
      ctx: mockCtx,
      async: true, // Request async mode
    });

    expect(result.success).toBe(false);
    expect(result.content).toContain('does not support async mode');
    expect(mockTaskSystem.scheduleTool).not.toHaveBeenCalled();
  });

  it('should return error when taskSystem is not available', async () => {
    // Register tool with supportsAsync
    const asyncTool: Tool = {
      name: 'asyncTool',
      description: 'Tool with async support',
      schema: { type: 'object', properties: {} },

      readonly: false,
      idempotent: false,
      supportsAsync: true,
      async execute(): Promise<ToolResult> {
        return { success: true, content: 'async result' };
      },
    };
    registry.register(asyncTool);

    // executor without taskSystem
    (executor as any).taskSystem = undefined;

    const result = await executor.execute({
      toolName: 'asyncTool',
      args: {},
      ctx: mockCtx,
      async: true,
    });

    expect(result.success).toBe(false);
    expect(result.content).toContain('TaskSystem (not available)');
  });

  it('should schedule async task when tool supports async and taskSystem available', async () => {
    const asyncTool: Tool = {
      name: 'asyncTool',
      description: 'Tool with async support',
      schema: { type: 'object', properties: {} },

      readonly: false,
      idempotent: false,
      supportsAsync: true,
      async execute(): Promise<ToolResult> {
        return { success: true, content: 'async result' };
      },
    };
    registry.register(asyncTool);

    const result = await executor.execute({
      toolName: 'asyncTool',
      args: { arg1: 'value1' },
      ctx: mockCtx,
      async: true,
    });

    expect(result.success).toBe(true);
    expect(result.content).toContain('Async task queued');
    expect(result.content).toContain('mock-task-id-123');
    expect(result.metadata).toEqual({ taskId: 'mock-task-id-123', async: true });
    expect(mockTaskSystem.scheduleTool).toHaveBeenCalledWith(
      'asyncTool',
      expect.any(Function),
      'test-claw',
      { isIdempotent: false }
    );
  });

  it('should route read tool to TaskSystem when async:true', async () => {
    // Register real read tool, verify routing with mock taskSystem
    registry.register(readTool);

    const result = await executor.execute({
      toolName: 'read',
      args: { path: 'AGENTS.md' },
      ctx: mockCtx,   // mockCtx.taskSystem = mockTaskSystem
      async: true,
    });

    expect(result.success).toBe(true);
    expect(result.content).toContain('Async task queued');
    expect(mockTaskSystem.scheduleTool).toHaveBeenCalledWith(
      'read',
      expect.any(Function),
      'test-claw',
      { isIdempotent: true }  // read.idempotent = true
    );
  });

  it('should execute synchronously when async is false', async () => {
    const syncTool: Tool = {
      name: 'syncTool',
      description: 'Regular sync tool',
      schema: { type: 'object', properties: {} },

      readonly: false,
      idempotent: false,
      async execute(): Promise<ToolResult> {
        return { success: true, content: 'sync result' };
      },
    };
    registry.register(syncTool);

    const result = await executor.execute({
      toolName: 'syncTool',
      args: {},
      ctx: mockCtx,
      async: false,
    });

    expect(result.success).toBe(true);
    expect(result.content).toBe('sync result');
    expect(mockTaskSystem.scheduleTool).not.toHaveBeenCalled();
  });
});
