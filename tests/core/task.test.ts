/**
 * Task system + SubAgent tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { TaskSystem } from '../../src/core/task/system.js';
import { SubAgent } from '../../src/core/subagent/agent.js';
import { NodeFileSystem } from '../../src/foundation/fs/index.js';
import { ToolRegistryImpl } from '../../src/core/tools/registry.js';
import { registerBuiltinTools } from '../../src/core/tools/builtins/index.js';
import type { LLMResponse } from '../../src/types/message.js';
import type { ILLMService } from '../../src/foundation/llm/index.js';
import type { StreamChunk } from '../../src/foundation/llm/types.js';

/**
 * Convert LLMResponse to stream chunks for mock
 */
async function* responseToStreamChunks(response: LLMResponse): AsyncIterableIterator<StreamChunk> {
  for (const block of response.content) {
    if (block.type === 'text') {
      yield { type: 'text_delta', delta: (block as { text: string }).text };
    } else if (block.type === 'tool_use') {
      const toolBlock = block as { id: string; name: string; input: unknown };
      yield {
        type: 'tool_use_start',
        toolUse: { id: toolBlock.id, name: toolBlock.name, partialInput: '' },
      };
      yield {
        type: 'tool_use_delta',
        toolUse: { id: '', name: '', partialInput: JSON.stringify(toolBlock.input) },
      };
    }
  }
  yield { type: 'done' };
}

async function createTempDir(): Promise<string> {
  const tempDir = path.join(tmpdir(), `clawforum-task-test-${randomUUID()}`);
  await fs.mkdir(tempDir, { recursive: true });
  return tempDir;
}

async function cleanupTempDir(tempDir: string): Promise<void> {
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

function createMockLLM(responses: LLMResponse[]): ILLMService {
  let index = 0;
  const callMock = vi.fn(async () => {
    const response = responses[index++] || responses[responses.length - 1];
    return response;
  });
  return {
    call: callMock,
    stream: vi.fn((...args: unknown[]) => {
      // 复用 call mock 的返回值，转换为 stream chunks
      const result = callMock(...args);
      if (result instanceof Promise) {
        return (async function* () {
          const response = await result;
          yield* responseToStreamChunks(response as LLMResponse);
        })();
      }
      return responseToStreamChunks(result as LLMResponse);
    }),
    close: vi.fn(),
    healthCheck: vi.fn().mockResolvedValue(true),
    getProviderInfo: vi.fn().mockReturnValue({ name: 'mock', model: 'test', isFallback: false }),
  } as unknown as ILLMService;
}

/**
 * Create a mock LLM that never resolves - useful for keeping tasks in running state
 */
function createHangingMockLLM(): ILLMService {
  async function* hangingStream(signal?: AbortSignal): AsyncIterableIterator<StreamChunk> {
    await new Promise<void>((_, reject) => {
      if (signal?.aborted) return reject(new Error('Aborted'));
      signal?.addEventListener('abort', () => reject(new Error('Aborted')));
    });
    yield { type: 'done' };
  }

  return {
    call: vi.fn(({ signal } = {}) => new Promise((_, reject) => {
      if (signal?.aborted) return reject(new Error('Aborted'));
      signal?.addEventListener('abort', () => reject(new Error('Aborted')));
    })),
    stream: vi.fn((opts: { signal?: AbortSignal } = {}) => hangingStream(opts?.signal)),
    close: vi.fn(),
    healthCheck: vi.fn().mockResolvedValue(true),
    getProviderInfo: vi.fn().mockReturnValue({ name: 'mock', model: 'test', isFallback: false }),
  } as unknown as ILLMService;
}

/**
 * Create a mock LLM that aborts when signal is triggered - for timeout testing
 */
function createAbortableHangingMockLLM(): ILLMService {
  async function* hangingStream(signal?: AbortSignal): AsyncIterableIterator<StreamChunk> {
    // Wait indefinitely but check for abort
    await new Promise<void>((resolve, reject) => {
      const checkInterval = setInterval(() => {
        if (signal?.aborted) {
          clearInterval(checkInterval);
          reject(new Error('Aborted'));
        }
      }, 10);
    });
    yield { type: 'done' };
  }
  
  return {
    call: vi.fn(() => new Promise(() => {})),
    stream: vi.fn((opts: { signal?: AbortSignal }) => hangingStream(opts?.signal)),
    close: vi.fn(),
    healthCheck: vi.fn().mockResolvedValue(true),
    getProviderInfo: vi.fn().mockReturnValue({ name: 'mock', model: 'test', isFallback: false }),
  } as unknown as ILLMService;
}

describe('Task System + SubAgent', () => {
  let tempDir: string;
  let mockFs: NodeFileSystem;
  let taskSystem: TaskSystem;
  let registry: ToolRegistryImpl;

  beforeEach(async () => {
    tempDir = await createTempDir();
    mockFs = new NodeFileSystem({ baseDir: tempDir, enforcePermissions: false });
    await mockFs.ensureDir('tasks');
    
    taskSystem = new TaskSystem(tempDir, mockFs);
    await taskSystem.initialize();

    registry = new ToolRegistryImpl();
    registerBuiltinTools(registry);
  });

  afterEach(async () => {
    await taskSystem.shutdown(1000);
    await cleanupTempDir(tempDir);
  });

  describe('TaskSystem', () => {
    it('should schedule subagent and return taskId', async () => {
      // Use hanging LLM so task stays in running state for verification
      taskSystem.setLLMService(createHangingMockLLM());
      
      const taskId = await taskSystem.scheduleSubAgent({
        kind: 'subagent',
        prompt: 'Test task',
        
        tools: ['read'],
        timeout: 60,
        maxSteps: 10,
        parentClawId: 'parent-claw',
      });

      expect(taskId).toBeDefined();
      expect(typeof taskId).toBe('string');

      // Wait for dispatch to move from pending to running
      await new Promise(r => setTimeout(r, 100));

      // Check task file exists in running directory
      const runningExists = await mockFs.exists(`tasks/running/${taskId}.json`);
      expect(runningExists).toBe(true);
    });

    it('should move task to done when completed', async () => {
      // Set mock LLM that returns quickly
      taskSystem.setLLMService(createMockLLM([{
        content: [{ type: 'text', text: 'Task result' }],
        stop_reason: 'end_turn',
      }]));

      const taskId = await taskSystem.scheduleSubAgent({
        kind: 'subagent',
        prompt: 'Simple task',
        
        tools: [],
        timeout: 60,
        maxSteps: 5,
        parentClawId: 'parent-claw',
      });

      // Wait for task to complete
      await new Promise(r => setTimeout(r, 500));

      // Task should be moved to done
      const doneExists = await mockFs.exists(`tasks/done/${taskId}.json`);
      expect(doneExists).toBe(true);

      // Running file should not exist
      const runningExists = await mockFs.exists(`tasks/running/${taskId}.json`);
      expect(runningExists).toBe(false);
    });

    it('should deliver subagent result to inbox/pending/*.md (bypass transport)', async () => {
      taskSystem.setLLMService(createMockLLM([{
        content: [{ type: 'text', text: 'Subagent output' }],
        stop_reason: 'end_turn',
      }]));

      const taskId = await taskSystem.scheduleSubAgent({
        kind: 'subagent',
        prompt: 'Deliver result',
        
        tools: [],
        timeout: 60,
        maxSteps: 5,
        parentClawId: 'motion',
      });

      await new Promise(r => setTimeout(r, 500));

      // Result must be in inbox/pending/ (relative to clawDir=tempDir), NOT in claws/motion/inbox
      const inboxDir = path.join(tempDir, 'inbox', 'pending');
      const inboxFiles = await fs.readdir(inboxDir).catch(() => [] as string[]);
      expect(inboxFiles.length).toBeGreaterThan(0);
      expect(inboxFiles.every((f: string) => f.endsWith('.md'))).toBe(true);

      // Parse the message and verify frontmatter
      const { promises: nodeFs } = await import('fs');
      const content = await nodeFs.readFile(path.join(inboxDir, inboxFiles[0]), 'utf-8');
      expect(content).toContain('from: subagent');
      expect(content).toContain('to: motion');
      expect(content).toContain(`"resultRef":"tasks/results/${taskId}/result.txt"`);
    });

    it('should cancel task', async () => {
      // Use a slow but cancellable mock LLM
      // It yields text slowly so we can cancel mid-execution
      async function* slowStream(): AsyncIterableIterator<StreamChunk> {
        yield { type: 'text_delta', delta: 'Starting' };
        // Wait a bit, then check for abort
        await new Promise(r => setTimeout(r, 50));
        yield { type: 'text_delta', delta: '...' };
        await new Promise(r => setTimeout(r, 50));
        yield { type: 'text_delta', delta: '...' };
        await new Promise(r => setTimeout(r, 50));
        yield { type: 'done' };
      }
      
      taskSystem.setLLMService({
        call: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'Completed' }],
          stop_reason: 'end_turn',
        }),
        stream: vi.fn().mockReturnValue(slowStream()),
        close: vi.fn(),
        healthCheck: vi.fn().mockResolvedValue(true),
        getProviderInfo: vi.fn().mockReturnValue({ name: 'mock', model: 'test', isFallback: false }),
      } as unknown as ILLMService);
      
      const taskId = await taskSystem.scheduleSubAgent({
        kind: 'subagent',
        prompt: 'Long running task',
        
        tools: [],
        timeout: 300,
        maxSteps: 10,
        parentClawId: 'parent-claw',
      });

      // Wait for task to be dispatched to running
      await new Promise(r => setTimeout(r, 50));

      // Verify task is in running state
      expect(taskSystem.listRunning()).toContain(taskId);

      await taskSystem.cancel(taskId);

      // Task should be removed from running
      expect(taskSystem.listRunning()).not.toContain(taskId);
      const runningExists = await mockFs.exists(`tasks/running/${taskId}.json`);
      expect(runningExists).toBe(false);
    });

    it('should write subagent_completed event to monitor log', async () => {
      taskSystem.setLLMService(createMockLLM([{
        content: [{ type: 'text', text: 'task done' }],
        stop_reason: 'end_turn',
      }]));

      const taskId = await taskSystem.scheduleSubAgent({
        kind: 'subagent',
        prompt: 'Simple task',
        
        tools: [],
        timeout: 30,
        maxSteps: 5,
        parentClawId: 'test-claw',
      });

      // 等待任务完成 + monitor 异步写入
      await new Promise(r => setTimeout(r, 500));

      // subagent_completed → logs/monitor.jsonl
      const logPath = path.join(tempDir, 'logs', 'monitor.jsonl');
      const logContent = await fs.readFile(logPath, 'utf-8').catch(() => '');
      expect(logContent).toContain('subagent_completed');
      expect(logContent).toContain(taskId);
    });

    it('should write error event to monitor log when subagent times out', async () => {
      taskSystem.setLLMService(createAbortableHangingMockLLM());

      const taskId = await taskSystem.scheduleSubAgent({
        kind: 'subagent',
        prompt: 'This will time out',
        
        tools: [],
        timeout: 0.3,   // 0.3 秒，触发 SubAgent timeout
        maxSteps: 5,
        parentClawId: 'test-claw',
      });

      // 等待超时触发 + 任务完成 + monitor 异步写入
      await new Promise(r => setTimeout(r, 1500));

      // inbox 中有 is_error: true 的消息（验证 executeTask catch 被执行）
      const inboxDir = path.join(tempDir, 'inbox', 'pending');
      const inboxFiles = await fs.readdir(inboxDir).catch(() => [] as string[]);
      const mdFiles = inboxFiles.filter((f: string) => f.endsWith('.md'));
      expect(mdFiles.length).toBeGreaterThan(0);
      const inboxContent = await fs.readFile(path.join(inboxDir, mdFiles[0]), 'utf-8');
      expect(inboxContent).toContain('"is_error":true');

      // error 事件 → logs/monitor.jsonl（验证 monitor.log 被调用）
      const logPath = path.join(tempDir, 'logs', 'monitor.jsonl');
      const logContent = await fs.readFile(logPath, 'utf-8').catch(() => '');
      expect(logContent).toContain(taskId);
    });

    it('should write fallback inbox message when main sendResult fails', async () => {
      // 第一次对 inbox/pending 的写入失败，第二次（fallback）成功
      let inboxWriteAttempts = 0;
      const patchedFs = new NodeFileSystem({ baseDir: tempDir, enforcePermissions: false });
      const originalWriteAtomic = patchedFs.writeAtomic.bind(patchedFs);
      patchedFs.writeAtomic = async (filePath: string, content: string) => {
        if (filePath.startsWith('inbox/pending/') && inboxWriteAttempts++ === 0) {
          throw new Error('Simulated inbox write failure');
        }
        return originalWriteAtomic(filePath, content);
      };

      const failSystem = new TaskSystem(tempDir, patchedFs);
      await failSystem.initialize();
      failSystem.setLLMService(createMockLLM([{
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
      }]));

      const taskId = await failSystem.scheduleSubAgent({
        kind: 'subagent',
        prompt: 'test fallback',
        tools: [],
        timeout: 10,
        maxSteps: 5,
        parentClawId: 'test-claw',
      });

      await new Promise(r => setTimeout(r, 800));
      await failSystem.shutdown(1000);

      // fallback 消息应该存在于 inbox
      const inboxDir = path.join(tempDir, 'inbox', 'pending');
      const files = await fs.readdir(inboxDir).catch(() => [] as string[]);
      const mdFiles = (files as string[]).filter(f => f.endsWith('.md'));
      expect(mdFiles.length).toBeGreaterThan(0);

      // fallback 消息包含 taskId 和 is_error
      const content = await fs.readFile(path.join(inboxDir, mdFiles[0]), 'utf-8');
      expect(content).toContain(taskId);
      expect(content).toContain('is_error');
    });

    it('should write fallback inbox message when movePendingToRunning fails', async () => {
      const patchedFs = new NodeFileSystem({ baseDir: tempDir, enforcePermissions: false });
      const originalMove = patchedFs.move.bind(patchedFs);
      patchedFs.move = async (from: string, to: string) => {
        if (from.startsWith('tasks/pending/') && to.startsWith('tasks/running/')) {
          throw new Error('Simulated move failure');
        }
        return originalMove(from, to);
      };

      const failSystem = new TaskSystem(tempDir, patchedFs);
      await failSystem.initialize();
      failSystem.setLLMService(createMockLLM([{
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
      }]));

      const taskId = await failSystem.scheduleSubAgent({
        kind: 'subagent',
        prompt: 'test move failure',
        tools: [],
        timeout: 10,
        maxSteps: 5,
        parentClawId: 'test-claw',
      });

      await new Promise(r => setTimeout(r, 500));
      await failSystem.shutdown(1000);

      // _startTask catch 应该发了 fallback 通知
      const inboxDir = path.join(tempDir, 'inbox', 'pending');
      const files = await fs.readdir(inboxDir).catch(() => [] as string[]);
      const mdFiles = (files as string[]).filter(f => f.endsWith('.md'));
      expect(mdFiles.length).toBeGreaterThan(0);

      const content = await fs.readFile(path.join(inboxDir, mdFiles[0]), 'utf-8');
      expect(content).toContain(taskId);
      expect(content).toContain('is_error');
    });
  });

  describe('SubAgent', () => {
    it('should run and return text result', async () => {
      const mockLLM = createMockLLM([{
        content: [{ type: 'text', text: 'Task completed successfully' }],
        stop_reason: 'end_turn',
      }]);

      const agent = new SubAgent({
        agentId: 'test-agent-1',
        prompt: 'Do something',
        clawDir: tempDir,
        llm: mockLLM,
        registry,
        fs: mockFs,
        maxSteps: 10,
        timeoutMs: 5000,
      });

      const result = await agent.run();

      expect(result).toContain('Task completed');
    });

    it('should execute tools in subagent profile', async () => {
      // Create a test file
      await mockFs.writeAtomic('test.txt', 'Hello from test file');

      const mockLLM = createMockLLM([
        {
          content: [
            { type: 'text', text: 'I will read the file' },
            { type: 'tool_use', id: 'call-1', name: 'read', input: { path: 'test.txt' } },
          ],
          stop_reason: 'tool_use',
        },
        {
          content: [{ type: 'text', text: 'File content is: Hello from test file' }],
          stop_reason: 'end_turn',
        },
      ]);

      const agent = new SubAgent({
        agentId: 'test-agent-2',
        prompt: 'Read test.txt',
        clawDir: tempDir,
        llm: mockLLM,
        registry,
        fs: mockFs,
        maxSteps: 10,
        timeoutMs: 5000,
      });

      const result = await agent.run();

      expect(mockLLM.call).toHaveBeenCalledTimes(2);
      expect(result).toContain('File content');
    });

    it('should execute exec tool in subagent profile (previously blocked by execute: false)', async () => {
      const mockLLM = createMockLLM([
        {
          content: [
            { type: 'text', text: 'I will run a command' },
            { type: 'tool_use', id: 'c1', name: 'exec', input: { command: 'echo subagent-exec-ok' } },
          ],
          stop_reason: 'tool_use',
        },
        {
          content: [{ type: 'text', text: 'Command output: subagent-exec-ok' }],
          stop_reason: 'end_turn',
        },
      ]);

      const agent = new SubAgent({
        agentId: 'test-agent-exec',
        prompt: 'Run echo command',
        clawDir: tempDir,
        llm: mockLLM,
        registry,
        fs: mockFs,
        maxSteps: 10,
        timeoutMs: 5000,
      });

      const result = await agent.run();

      // 两次 LLM call：第一次返回 tool_use，第二次收到工具结果后返回 end_turn
      expect(mockLLM.call).toHaveBeenCalledTimes(2);
      // 结果来自第二次 LLM 返回（不是 PermissionError）
      expect(result).toContain('Command output');
    });

    it('should timeout on long running task', async () => {
      const mockLLM = createMockLLM([
        {
          content: [{ type: 'text', text: 'Thinking...' }],
          stop_reason: 'end_turn',
        },
      ]);

      // Mock LLM to delay but check for abort
      (mockLLM.call as ReturnType<typeof vi.fn>).mockImplementation(async (options: { signal?: AbortSignal }) => {
        // Wait 1000ms but check for abort every 50ms
        for (let i = 0; i < 20; i++) {
          if (options.signal?.aborted) {
            throw new Error('Aborted');
          }
          await new Promise(r => setTimeout(r, 50));
        }
        return {
          content: [{ type: 'text', text: 'Done' }],
          stop_reason: 'end_turn',
        };
      });

      const agent = new SubAgent({
        agentId: 'test-agent-3',
        prompt: 'Slow task',
        clawDir: tempDir,
        llm: mockLLM,
        registry,
        fs: mockFs,
        maxSteps: 10,
        timeoutMs: 100, // Very short timeout
      });

      await expect(agent.run()).rejects.toThrow();
    });

    it('should call onIdleTimeout callback when idle timeout triggers', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const onIdleTimeout = vi.fn();
      
      // Mock LLM that never yields any delta → idle timer never reset
      const hangingLLM = {
        call: vi.fn().mockImplementation(() => {
          return new Promise(() => {}); // never resolves
        }),
        stream: vi.fn(),
      } as unknown as ILLMService;

      const agent = new SubAgent({
        agentId: 'test-idle',
        prompt: 'Test idle',
        clawDir: tempDir,
        llm: hangingLLM,
        registry,
        fs: mockFs,
        timeoutMs: 10000, // main timeout is long
        idleTimeoutMs: 100, // idle timeout is short
        onIdleTimeout,
      });

      const runPromise = agent.run().catch(() => {}); // 预期抛 ToolTimeoutError

      await vi.advanceTimersByTimeAsync(150); // 超过 idleTimeoutMs
      await runPromise;

      expect(onIdleTimeout).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('should log error to monitor when appendToLog fs.append throws', async () => {
      const mockMonitor = { log: vi.fn() };

      // FS mock：append 始终失败，其余方法正常
      const throwingFs = Object.create(mockFs);
      throwingFs.append = vi.fn().mockRejectedValue(new Error('Disk full'));

      const agent = new SubAgent({
        agentId: 'test-append-fail',
        prompt: 'Test',
        clawDir: tempDir,
        llm: createMockLLM([{
          content: [{ type: 'text', text: 'Task done' }],
          stop_reason: 'end_turn',
        }]),
        registry,
        fs: throwingFs,
        monitor: mockMonitor as any,
      });

      // run 应该正常完成，appendToLog 失败不影响主流程
      await agent.run();

      expect(mockMonitor.log).toHaveBeenCalledWith('error', expect.objectContaining({
        context: 'SubAgent.appendToLog',
      }));
    });
  });
});
