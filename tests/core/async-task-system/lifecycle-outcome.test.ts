/**
 * Phase 1814 Step B（AT-D3）：AsyncTaskSystem shutdown/abort 生命周期 typed outcome 专测。
 *
 * 锁定：`TaskLifecycleOutcome` 三态穷尽（converged / timed_out / already_shutting_down）、
 * 未收敛 identity（pending）与 settle identity（terminal）证据、abort 请求 identity、
 * 重复 shutdown 幂等。pending 仅表达内存句柄未收敛，不断言磁盘终态（SoT 归 fs running 目录）。
 *
 * 竞态覆盖（Step B §7）：never-settle executor（ignores abort）经 deferred promise
 * 保证 drain 后仍 pending；abort-settle executor 保证 grace 内 settle 归 converged。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import type { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import type { TaskLifecycleOutcome } from '../../../src/core/async-task-system/index.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTestTaskSystem, createMockWatcherFactory } from '../../helpers/task-system.js';
import { waitFor } from '../../helpers/wait-for.js';
import { SUBAGENT_DEFAULT_TIMEOUT_MS } from '../../helpers/test-timeouts.js';

/** abort 后立即 settle 的 hanging LLM（signal 传播 reject）。 */
function createAbortSettleMockLLM(): LLMOrchestrator {
  async function* hangingStream(signal?: AbortSignal): AsyncIterableIterator<never> {
    await new Promise<void>((_, reject) => {
      if (signal?.aborted) return reject(new Error('Aborted'));
      signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    });
  }
  return {
    call: vi.fn(() => new Promise(() => {})),
    stream: vi.fn((opts: { signal?: AbortSignal } = {}) => hangingStream(opts?.signal)),
    close: vi.fn(),
    healthCheck: vi.fn().mockResolvedValue(true),
    getProviderInfo: vi.fn().mockReturnValue({ name: 'mock', model: 'test', isFallback: false }),
  } as unknown as LLMOrchestrator;
}

/** 永不 settle 的 LLM（ignores abort）——shutdown 后句柄必残留 pending。 */
function createNeverSettleMockLLM(): LLMOrchestrator {
  async function* neverStream(): AsyncIterableIterator<never> {
    await new Promise(() => {});
  }
  return {
    call: vi.fn(() => new Promise(() => {})),
    stream: vi.fn(() => neverStream()),
    close: vi.fn(),
    healthCheck: vi.fn().mockResolvedValue(true),
    getProviderInfo: vi.fn().mockReturnValue({ name: 'mock', model: 'test', isFallback: false }),
  } as unknown as LLMOrchestrator;
}

/** 穷尽 reducer：新增 kind 时 never 检查编译失败。 */
function reduceOutcome(outcome: TaskLifecycleOutcome): string {
  switch (outcome.kind) {
    case 'converged': return `converged:${outcome.aborted}/${outcome.terminal.length}`;
    case 'timed_out': return `timed_out:${outcome.pending.length}`;
    case 'already_shutting_down': return 'reentrant';
    default: {
      const exhaustive: never = outcome;
      throw new Error(`unhandled kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

describe('phase 1814: AsyncTaskSystem 生命周期 typed outcome（AT-D3）', () => {
  let tempDir: string;
  let system: AsyncTaskSystem | undefined;

  afterEach(async () => {
    // 兜底清理：测试内未 shutdown 的实例在此关闭（never-settle 任务靠短 timeout 推出）
    await system?.shutdown(1);
    await cleanupTempDir(tempDir);
  });

  async function setup(llm?: LLMOrchestrator) {
    tempDir = await createTempDir();
    const mockFs = new NodeFileSystem({ baseDir: tempDir });
    const { factory: createWatcher } = createMockWatcherFactory(mockFs);
    await mockFs.ensureDir('tasks');
    system = createTestTaskSystem(tempDir, mockFs, makeAudit().audit, llm, { createWatcher });
    await system.initialize();
    await system.startDispatch();
    return { mockFs, system };
  }

  async function scheduleRunning(sys: AsyncTaskSystem, mockFs: NodeFileSystem): Promise<string> {
    const taskId = await sys.scheduleSubAgent({
      kind: 'subagent',
      mode: 'standard',
      intent: 'lifecycle outcome test',
      timeoutMs: SUBAGENT_DEFAULT_TIMEOUT_MS,
      maxSteps: 10,
      parentClawId: 'parent-claw',
    });
    const fullTaskId = sys.resolveFullTaskId(taskId);
    await waitFor(() => mockFs.exists(`tasks/queues/running/${fullTaskId}.json`));
    return fullTaskId;
  }

  it('无在途任务 → converged（aborted=0，无 terminal）', async () => {
    const { system: sys } = await setup();
    const outcome = await sys.shutdown();
    expect(outcome).toEqual({ kind: 'converged', aborted: 0, terminal: [] });
    expect(reduceOutcome(outcome)).toBe('converged:0/0');
    system = undefined; // 已关闭，afterEach 不再重复
  });

  it('abort 返回 abort_requested + 触及句柄 identity；abort-settle 任务经 shutdown 归 converged 并载 terminal identity', async () => {
    const { system: sys, mockFs } = await setup(createAbortSettleMockLLM());
    const fullTaskId = await scheduleRunning(sys, mockFs);

    const requested = sys.abort();
    expect(requested.kind).toBe('abort_requested');
    expect(requested.taskIds).toEqual([fullTaskId]);

    const outcome = await sys.shutdown(200);
    expect(outcome.kind).toBe('converged');
    if (outcome.kind === 'converged') {
      expect(outcome.aborted).toBe(1);
      expect(outcome.terminal).toEqual([fullTaskId]);
    }
    system = undefined;
  });

  it('never-settle 任务 → timed_out 并保留 pending identity（不猜测磁盘终态）', async () => {
    const { system: sys, mockFs } = await setup(createNeverSettleMockLLM());
    // 永不 settle 的 executor（ignores abort）——覆盖 subagent 自身的 abort 监听，
    // 保证 drain grace 后句柄仍残留（Step B §7 deferred/竞态覆盖）。
    (sys as any).executors.subagent = async () => { await new Promise(() => {}); };
    const fullTaskId = await scheduleRunning(sys, mockFs);

    // 1ms timeout + 1s drain grace（真实 timer，与 task.test.ts phase 1310 决策一致）
    const outcome = await sys.shutdown(1);
    expect(outcome.kind).toBe('timed_out');
    if (outcome.kind === 'timed_out') {
      expect(outcome.pending).toEqual([fullTaskId]);
      expect(outcome.terminal).toEqual([]);
    }
    expect(reduceOutcome(outcome)).toBe('timed_out:1');
    system = undefined;
  });

  it('重入 shutdown → already_shutting_down（不重复 abort/drain），首个 shutdown 正常返回', async () => {
    const { system: sys, mockFs } = await setup(createNeverSettleMockLLM());
    (sys as any).executors.subagent = async () => { await new Promise(() => {}); };
    await scheduleRunning(sys, mockFs);

    const first = sys.shutdown(1);
    const second = await sys.shutdown(1);
    expect(second).toEqual({ kind: 'already_shutting_down' });
    expect(reduceOutcome(second)).toBe('reentrant');
    const firstOutcome = await first;
    expect(firstOutcome.kind).toBe('timed_out');
    system = undefined;
  });
});
