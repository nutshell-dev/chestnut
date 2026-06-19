/**
 * SubAgent executor tests — Phase 546 systemPrompt injection
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { executeSubAgentTask } from '../../src/core/async-task-system/subagent-executor.js';
import { DEFAULT_SUBAGENT_SYSTEM_PROMPT } from '../../src/templates/prompts/subagent.js';
import type { SubAgentTask } from '../../src/core/async-task-system/system.js';
import { SUBAGENT_DEFAULT_TIMEOUT_MS } from '../helpers/test-timeouts.js';

const { mockRunSubagent } = vi.hoisted(() => ({
  mockRunSubagent: vi.fn(),
}));



function makeTask(overrides: Partial<SubAgentTask> = {}): SubAgentTask {
  return {
    kind: 'subagent',
    mode: 'standard',
    id: `task-${randomUUID()}`,
    intent: 'test intent',
    timeoutMs: SUBAGENT_DEFAULT_TIMEOUT_MS,
    maxSteps: 10,
    parentClawId: 'parent-claw',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeDeps() {
  return {
    fs: {
      ensureDir: vi.fn().mockResolvedValue(undefined),
      ensureDirSync: vi.fn(),
      write: vi.fn().mockResolvedValue(undefined),
      writeAtomic: vi.fn().mockResolvedValue(undefined),
      append: vi.fn().mockResolvedValue(undefined),
      appendSync: vi.fn(),
      read: vi.fn().mockResolvedValue(''),
      exists: vi.fn().mockResolvedValue(false),
      list: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
      removeDir: vi.fn().mockResolvedValue(undefined),
      move: vi.fn().mockResolvedValue(undefined),
      copy: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockResolvedValue({ size: 0, mtime: new Date() }),
      watch: vi.fn(),
    } as unknown as import('../../src/foundation/fs/types.js').FileSystem,
    auditWriter: { write: vi.fn(), preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s) } as unknown as import('../../src/foundation/audit/index.js').AuditLog,
    llm: {
      call: vi.fn(),
      stream: vi.fn(),
      close: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(true),
      getProviderInfo: vi.fn().mockReturnValue({ name: 'mock', model: 'test', isFallback: false }),
    } as unknown as import('../../src/foundation/llm-orchestrator/index.js').LLMOrchestrator,
    registry: {
      getAll: vi.fn().mockReturnValue([]),
      formatForLLM: vi.fn().mockReturnValue([]),
      getForProfile: vi.fn().mockReturnValue([]),
    } as unknown as import('../../src/foundation/tools/index.js').ToolRegistry,
    clawDir: path.join(tmpdir(), `subagent-exec-test-${randomUUID()}`),
    postProcessors: new Map(),
    moveTaskToDone: vi.fn().mockResolvedValue(undefined),
    moveTaskToFailed: vi.fn().mockResolvedValue(undefined),
    askMotionToolFactory: () => ({ name: 'ask_motion', description: '', readonly: false, idempotent: false, schema: { type: 'object' }, execute: vi.fn(async () => ({ ok: true, content: '' })) } as unknown as import('../../src/foundation/tools/index.js').Tool),
    runSubagent: mockRunSubagent,
  };
}

describe('Phase 546 — subagent-executor systemPrompt 注入', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunSubagent.mockResolvedValue({ text: 'result' });
  });

  it('uses task.systemPrompt when provided', async () => {
    const task = makeTask({ systemPrompt: 'CUSTOM_PROMPT_X' });
    const deps = makeDeps();
    const controller = new AbortController();

    await executeSubAgentTask(task, controller.signal, deps);

    expect(mockRunSubagent).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining('CUSTOM_PROMPT_X'),
      }),
    );
    expect(mockRunSubagent.mock.calls[0][0].systemPrompt).not.toContain(DEFAULT_SUBAGENT_SYSTEM_PROMPT);
  });

  it('falls back to DEFAULT_SUBAGENT_SYSTEM_PROMPT when task.systemPrompt is undefined', async () => {
    const task = makeTask();
    // systemPrompt is undefined by default
    const deps = makeDeps();
    const controller = new AbortController();

    await executeSubAgentTask(task, controller.signal, deps);

    expect(mockRunSubagent).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining(DEFAULT_SUBAGENT_SYSTEM_PROMPT),
      }),
    );
  });

  it('always includes promptPrefix regardless of task.systemPrompt', async () => {
    const task = makeTask({ systemPrompt: 'X' });
    const deps = makeDeps();
    const controller = new AbortController();

    await executeSubAgentTask(task, controller.signal, deps);

    const captured = mockRunSubagent.mock.calls[0][0];
    // promptPrefix 含 taskId / callerClawId 信息
    expect(captured.systemPrompt).toMatch(/Task ID|callerClawId|workspace/);
  });

  it('calls runSubagent per subagent task (phase 944)', async () => {
    const task1 = makeTask();
    const task2 = makeTask();
    const deps = makeDeps();

    await executeSubAgentTask(task1, new AbortController().signal, deps);
    await executeSubAgentTask(task2, new AbortController().signal, deps);

    expect(mockRunSubagent).toHaveBeenCalledTimes(2);
  });
});
