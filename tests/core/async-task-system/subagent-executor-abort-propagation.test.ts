/**
 * task abort signal propagation to runSubagent (phase 1373 sub-5)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeSubAgentTask } from '../../../src/core/async-task-system/subagent-executor.js';
import type { SubAgentTask } from '../../../src/core/async-task-system/types.js';
import { makeMockAudit } from '../../helpers/audit.js';

const { mockRunSubagent } = vi.hoisted(() => ({
  mockRunSubagent: vi.fn().mockResolvedValue({ text: 'done', capturedResult: undefined }),
}));



describe('subagent-executor abort propagation (phase 1373 sub-5)', () => {
  beforeEach(() => {
    mockRunSubagent.mockClear();
  });

  it('task abort signal 应 cascade 到 runSubagent 的 signal 参数', async () => {
    const abortController = new AbortController();
    const task: SubAgentTask = {
      kind: 'subagent',
      id: 'task-1',
      mode: 'standard',
      intent: 'test intent',
      timeoutMs: 300_000,
      maxSteps: 100,
      parentClawId: 'claw-a',
      createdAt: new Date().toISOString(),
    };

    await executeSubAgentTask(task, abortController.signal, {
      fs: {
        ensureDirSync: vi.fn(),
        readSync: vi.fn().mockReturnValue(''),
        writeAtomic: vi.fn().mockResolvedValue(undefined),
        existsSync: vi.fn().mockReturnValue(true),
        listSync: vi.fn().mockReturnValue([]),
        deleteSync: vi.fn(),
        move: vi.fn().mockResolvedValue(undefined),
      } as any,
      fsFactory: vi.fn().mockReturnValue({} as any),
      auditWriter: makeMockAudit(),
      llm: {} as any,
      registry: {
        formatForLLM: vi.fn().mockReturnValue([]),
        getAll: vi.fn().mockReturnValue([]),
        get: vi.fn().mockReturnValue(undefined),
        getForProfile: vi.fn().mockReturnValue([]),
      } as any,
      clawDir: '/tmp/test',
      postProcessors: new Map(),
      moveTaskToDone: vi.fn().mockResolvedValue(undefined),
      moveTaskToFailed: vi.fn().mockResolvedValue(undefined),
      askMotionToolFactory: vi.fn().mockReturnValue({} as any),
      runSubagent: mockRunSubagent,
    });

    expect(mockRunSubagent).toHaveBeenCalled();
    const callArg = mockRunSubagent.mock.calls[0][0];
    expect(callArg.signal).toBeDefined();
    expect(callArg.signal).toBeInstanceOf(AbortSignal);
  });

  it('pre-aborted signal 应仍传给 runSubagent', async () => {
    const abortController = new AbortController();
    abortController.abort('test abort');

    const task: SubAgentTask = {
      kind: 'subagent',
      id: 'task-2',
      mode: 'standard',
      intent: 'test intent',
      timeoutMs: 300_000,
      maxSteps: 100,
      parentClawId: 'claw-a',
      createdAt: new Date().toISOString(),
    };

    await executeSubAgentTask(task, abortController.signal, {
      fs: {
        ensureDirSync: vi.fn(),
        readSync: vi.fn().mockReturnValue(''),
        writeAtomic: vi.fn().mockResolvedValue(undefined),
        existsSync: vi.fn().mockReturnValue(true),
        listSync: vi.fn().mockReturnValue([]),
        deleteSync: vi.fn(),
        move: vi.fn().mockResolvedValue(undefined),
      } as any,
      fsFactory: vi.fn().mockReturnValue({} as any),
      auditWriter: makeMockAudit(),
      llm: {} as any,
      registry: {
        formatForLLM: vi.fn().mockReturnValue([]),
        getAll: vi.fn().mockReturnValue([]),
        get: vi.fn().mockReturnValue(undefined),
        getForProfile: vi.fn().mockReturnValue([]),
      } as any,
      clawDir: '/tmp/test',
      postProcessors: new Map(),
      moveTaskToDone: vi.fn().mockResolvedValue(undefined),
      moveTaskToFailed: vi.fn().mockResolvedValue(undefined),
      askMotionToolFactory: vi.fn().mockReturnValue({} as any),
      runSubagent: mockRunSubagent,
    });

    expect(mockRunSubagent).toHaveBeenCalled();
    const callArg = mockRunSubagent.mock.calls[0][0];
    expect(callArg.signal).toBeDefined();
    expect(callArg.signal.aborted).toBe(true);
  });
});
