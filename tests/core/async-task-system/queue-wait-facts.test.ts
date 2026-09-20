/**
 * Phase 1869 Step E：queued 任务生命周期核证（EventLoop 合法等待事实面）。
 *
 * 核证结论（登记见 dev log + runtime-assembly 行注记）：
 * - queued（磁盘 pending）是 dispatcher 领取前的**预派发态**：唯一推进路径 =
 *   startDispatch() 的调度循环；dispatcher 启动失败 → Runtime.init 抛错 →
 *   EventLoop 不运行（不存在「循环存活而调度器未启动」的稳态）。
 * - 但循环侧无法区分「瞬时排队」与「停滞」（watcher 漏事件 /
 *   movePendingToRunning 失败重试均表现为 queued 长期驻留；owner 无
 *   dispatcher 存活查询）。
 * - 故 EventLoop 的 isAsyncTaskInFlight **显式排除 queued**（只消费 in-process
 *   执行句柄视图）：queued>0 不抑制提醒；停滞场景提醒照常触发（符合判据
 *   「dispatcher 不推进 = 不算合法等待」）；饱和排队必伴随 in-process>0，
 *   已被现有事实覆盖。
 * - 提醒判定用 in-process 视图而非磁盘视图：磁盘 running 含崩溃残留孤儿
 *   （SoT 归 running 目录 + task-recovery 处置），不代表本进程在途。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import type { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { readTaskQueueCounts } from '../../../src/core/async-task-system/index.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTestTaskSystem, createMockWatcherFactory } from '../../helpers/task-system.js';
import { waitFor } from '../../helpers/wait-for.js';
import { SUBAGENT_DEFAULT_TIMEOUT_MS } from '../../helpers/test-timeouts.js';

/** 挂起 LLM（abort 时 reject settle）——任务保持 running 供观察。 */
function createHangingMockLLM(): LLMOrchestrator {
  async function* hangingStream(signal?: AbortSignal): AsyncIterableIterator<never> {
    await new Promise<void>((_, reject) => {
      if (signal?.aborted) {
        reject(new Error('Aborted'));
        return;
      }
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

describe('phase 1869 Step E: queued 生命周期核证（合法等待事实）', () => {
  let tempDir: string;
  let system: AsyncTaskSystem | undefined;

  afterEach(async () => {
    await system?.shutdown(1).catch(() => { /* silent: best-effort teardown */ });
    system = undefined;
    await cleanupTempDir(tempDir);
  });

  async function setup() {
    tempDir = await createTempDir();
    const mockFs = new NodeFileSystem({ baseDir: tempDir });
    const { factory: createWatcher } = createMockWatcherFactory(mockFs);
    await mockFs.ensureDir('tasks');
    system = createTestTaskSystem(tempDir, mockFs, makeAudit().audit, createHangingMockLLM(), { createWatcher });
    await system.initialize();
    return { mockFs, sys: system };
  }

  async function scheduleTask(sys: AsyncTaskSystem, intent: string): Promise<string> {
    const taskId = await sys.scheduleSubAgent({
      kind: 'subagent',
      mode: 'standard',
      intent,
      timeoutMs: SUBAGENT_DEFAULT_TIMEOUT_MS,
      maxSteps: 5,
      parentClawId: 'parent-claw',
    });
    return sys.resolveFullTaskId(taskId);
  }

  it('dispatcher 未启动：queued 驻留（不推进）+ in-process 视图 0；磁盘视图 pending=1', async () => {
    const { mockFs, sys } = await setup();
    // 注意：本用例不调用 startDispatch
    const fullTaskId = await scheduleTask(sys, 'queued probe');
    await waitFor(() => mockFs.exists(`tasks/queues/pending/${fullTaskId}.json`));

    // queued 驻留：无 running 文件、无 in-process 句柄（排除语义的物理依据）
    expect(await mockFs.exists(`tasks/queues/running/${fullTaskId}.json`)).toBe(false);
    expect(sys.getInProcessRunningCount()).toBe(0);
    // 磁盘派生视图（SoT）与 in-process 视图的分工证据
    const counts = await readTaskQueueCounts(mockFs);
    expect(counts.pending).toBe(1);
    expect(counts.running).toBe(0);
  });

  it('startDispatch 后 queued 被调度循环领取：pending → running，in-process 视图 1', async () => {
    const { mockFs, sys } = await setup();
    const fullTaskId = await scheduleTask(sys, 'dispatch pickup probe');
    await waitFor(() => mockFs.exists(`tasks/queues/pending/${fullTaskId}.json`));

    await sys.startDispatch();
    await waitFor(() => mockFs.exists(`tasks/queues/running/${fullTaskId}.json`));

    expect(sys.getInProcessRunningCount()).toBe(1);
    expect(await mockFs.exists(`tasks/queues/pending/${fullTaskId}.json`)).toBe(false);
    const counts = await readTaskQueueCounts(mockFs);
    expect(counts.pending).toBe(0);
    expect(counts.running).toBe(1);
  });

  it('磁盘 running 残留（崩溃形态）不计入 in-process 视图——提醒判定不用磁盘视图', async () => {
    const { mockFs, sys } = await setup();
    await mockFs.ensureDir('tasks/queues/running');
    await mockFs.writeAtomic('tasks/queues/running/00000000-0000-4000-8000-000000000000.json',
      JSON.stringify({ id: 'crash-leftover', kind: 'subagent' }));

    const counts = await readTaskQueueCounts(mockFs);
    expect(counts.running).toBe(1);
    // 本进程无执行句柄：崩溃残留不代表在途（task-recovery 归 owner 处置）
    expect(sys.getInProcessRunningCount()).toBe(0);
  });
});
