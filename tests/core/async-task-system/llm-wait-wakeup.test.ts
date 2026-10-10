/**
 * Phase 1933 Step F：ATS 进程内唤醒（resumeWaitingTasks + onWaitScheduled 钩子）。
 *
 * 覆盖：
 * 1. probe 成功路径（直接调 resumeWaitingTasks，gate ready）：waiting 任务 → pending、
 *    事实清除、恰一次；再次调用无重复 move（幂等）。
 * 2. gate 未就绪：任务留 running、事实保留。
 * 3. 多任务同时唤醒：两个 waiting 任务独立 move，互不阻塞（一个 move 失败另一个仍唤醒）。
 * 4. waiting 事实 corrupt：audit 留证、不 move、不删事实。
 * 5. 无 waiting 事实的 running 任务：不受影响。
 * 6. onWaitScheduled 钩子：executor 返回 waiting → 钩子被调一次且载荷为持久化事实
 *    （executeSubAgentTask 层直测）。
 *
 * 构造惯例 mirror llm-wait-recovery.test.ts（Map 手实现 FileSystem 子集）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeSubAgentTask } from '../../../src/core/async-task-system/subagent-executor.js';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { InMemoryShortIdIndex } from '../../../src/core/async-task-system/short-id-index.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import { LLM_WAIT_FILE, type LLMWaitFact } from '../../../src/core/async-task-system/llm-wait-state.js';
import type { SubAgentTask, TaskExecutionOutcome } from '../../../src/core/async-task-system/types.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { makeTaskSystemDeps } from '../../helpers/task-system.js';
import { SUBAGENT_SHORT_TIMEOUT_MS } from '../../helpers/test-timeouts.js';

const FULL_ID_A = '550e8400-e29b-41d4-a716-446655440000';
const FULL_ID_B = '660e8400-e29b-41d4-a716-446655440001';

function makeMockAudit(): { audit: AuditLog; events: Array<[string, ...(string | number)[]]> } {
  const events: Array<[string, ...(string | number)[]]> = [];
  const audit: AuditLog = {
    write: (type: string, ...cols: (string | number)[]) => {
      events.push([type, ...cols]);
    },
    preview: (s: string) => s,
    message: (s: string) => s,
    summary: (s: string) => s,
  };
  return { audit, events };
}

function makeValidTask(id: string, overrides: Partial<SubAgentTask> = {}): SubAgentTask {
  return {
    kind: 'subagent',
    mode: 'standard',
    id: id as SubAgentTask['id'],
    shortId: id.slice(0, 8) as SubAgentTask['shortId'],
    intent: 'test',
    timeoutMs: SUBAGENT_SHORT_TIMEOUT_MS,
    maxSteps: 1,
    parentClawId: 'parent',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeFact(overrides: Partial<LLMWaitFact> = {}): LLMWaitFact {
  const now = Date.now();
  return {
    scope: 'claw-process',
    nextProbeAt: now + 60_000,
    recordedAt: now,
    expiresAt: now + 3_600_000,
    reason: 'All LLM providers failed',
    ...overrides,
  };
}

/** Map 手实现 FileSystem 子集（惯例 mirror llm-wait-recovery.test.ts）。 */
function makeMapFs(seed: Record<string, string> = {}): { fs: FileSystem; fileMap: Map<string, string> } {
  const fileMap = new Map<string, string>(Object.entries(seed));
  const fs = {
    list: vi.fn().mockImplementation((dir: string) => {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`;
      const entries: Array<{ name: string; path: string }> = [];
      for (const p of fileMap.keys()) {
        if (p.startsWith(prefix)) {
          const rest = p.slice(prefix.length);
          if (!rest.includes('/')) entries.push({ name: rest, path: p });
        }
      }
      return Promise.resolve(entries);
    }),
    read: vi.fn().mockImplementation((p: string) => {
      const content = fileMap.get(p);
      if (content === undefined) return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      return Promise.resolve(content);
    }),
    move: vi.fn().mockImplementation((from: string, to: string) => {
      const content = fileMap.get(from);
      if (content === undefined) return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      fileMap.delete(from);
      fileMap.set(to, content);
      return Promise.resolve(undefined);
    }),
    delete: vi.fn().mockImplementation((p: string) => {
      if (!fileMap.has(p)) return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      fileMap.delete(p);
      return Promise.resolve(undefined);
    }),
    writeAtomic: vi.fn().mockImplementation((p: string, content: string) => {
      fileMap.set(p, content);
      return Promise.resolve(undefined);
    }),
    exists: vi.fn().mockImplementation((p: string) => Promise.resolve(fileMap.has(p))),
    ensureDir: vi.fn().mockResolvedValue(undefined),
    ensureDirSync: vi.fn(),
    appendSync: vi.fn(),
  } as unknown as FileSystem;
  return { fs, fileMap };
}

function runningTaskSeed(task: SubAgentTask, extraFiles: Record<string, string> = {}): Record<string, string> {
  return {
    [`tasks/queues/running/${task.id}.json`]: JSON.stringify(task),
    ...extraFiles,
  };
}

function waitFileSeed(task: SubAgentTask, fact: LLMWaitFact): Record<string, string> {
  return {
    [`tasks/queues/results/${task.id}/${LLM_WAIT_FILE}`]: JSON.stringify({ schema_version: 1, ...fact }),
  };
}

function makeSystem(
  fs: FileSystem,
  audit: AuditLog,
  gate?: { canResume(scope: string): boolean },
): AsyncTaskSystem {
  return new AsyncTaskSystem('/tmp/claw', fs, {
    shortIdIndex: new InMemoryShortIdIndex(),
    auditWriter: audit,
    ...makeTaskSystemDeps(),
    ...(gate ? { waitGate: gate } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── 1. probe 成功路径：gate ready → pending、事实清除、幂等 ─────────────────
describe('Step F-1: resumeWaitingTasks（gate ready）→ 唤醒恰一次、幂等', () => {
  it('waiting 任务回 pending、事实清除、TASK_LLM_WAIT_RESUMED 一次；再次调用无重复 move', async () => {
    const task = makeValidTask(FULL_ID_A);
    const fact = makeFact();
    const { fs, fileMap } = makeMapFs(runningTaskSeed(task, waitFileSeed(task, fact)));
    const { audit, events } = makeMockAudit();
    const system = makeSystem(fs, audit, { canResume: () => true });

    const resumed = await system.resumeWaitingTasks();
    expect(resumed).toBe(1);
    expect(fileMap.has(`tasks/queues/pending/${task.id}.json`)).toBe(true);
    expect(fileMap.has(`tasks/queues/running/${task.id}.json`)).toBe(false);
    expect(fileMap.has(`tasks/queues/results/${task.id}/${LLM_WAIT_FILE}`)).toBe(false);
    const resumedEvents = events.filter(e => e[0] === TASK_AUDIT_EVENTS.TASK_LLM_WAIT_RESUMED);
    expect(resumedEvents.length).toBe(1);

    // 幂等：再次调用无重复 move、无重复事件
    const moveCallsBefore = (fs.move as ReturnType<typeof vi.fn>).mock.calls.length;
    const again = await system.resumeWaitingTasks();
    expect(again).toBe(0);
    expect((fs.move as ReturnType<typeof vi.fn>).mock.calls.length).toBe(moveCallsBefore);
    expect(events.filter(e => e[0] === TASK_AUDIT_EVENTS.TASK_LLM_WAIT_RESUMED).length).toBe(1);
    await system.shutdown(1).catch(() => { /* silent: teardown */ });
  });
});

// ─── 2. gate 未就绪：保持 waiting ────────────────────────────────────────────
describe('Step F-2: gate 未就绪 → 任务留 running、事实保留', () => {
  it('canResume=false → 0 唤醒、无 move、事实在', async () => {
    const task = makeValidTask(FULL_ID_A);
    const fact = makeFact();
    const { fs, fileMap } = makeMapFs(runningTaskSeed(task, waitFileSeed(task, fact)));
    const { audit } = makeMockAudit();
    const system = makeSystem(fs, audit, { canResume: () => false });

    const resumed = await system.resumeWaitingTasks();
    expect(resumed).toBe(0);
    expect(fs.move).not.toHaveBeenCalled();
    expect(fileMap.has(`tasks/queues/running/${task.id}.json`)).toBe(true);
    expect(fileMap.has(`tasks/queues/results/${task.id}/${LLM_WAIT_FILE}`)).toBe(true);
    await system.shutdown(1).catch(() => { /* silent: teardown */ });
  });
});

// ─── 3. 多任务同时唤醒：独立 move、互不阻塞 ──────────────────────────────────
// Phase 1934 Step D：resume 顺序改为 意图→move→清事实——move 失败不丢等待身份
// （意图保留、expiresAt 不重置），重试按意图重放收敛。
describe('Step F-3: 两个 waiting 任务独立唤醒（一个 move 失败另一个仍唤醒）', () => {
  it('taskA move 失败（audit 留证、留 running、意图保留）+ taskB 正常唤醒；修复后重试收敛', async () => {
    const taskA = makeValidTask(FULL_ID_A);
    const taskB = makeValidTask(FULL_ID_B);
    const factA = makeFact();
    const factB = makeFact();
    const { fs, fileMap } = makeMapFs({
      ...runningTaskSeed(taskA, waitFileSeed(taskA, factA)),
      ...runningTaskSeed(taskB, waitFileSeed(taskB, factB)),
    });
    const { audit, events } = makeMockAudit();
    // taskA 的 move 注入一次非 ENOENT 失败（模拟 IO 故障）
    const realMove = fs.move.bind(fs);
    let moveFailed = false;
    fs.move = vi.fn().mockImplementation((from: string, to: string) => {
      if (!moveFailed && from.includes(FULL_ID_A)) {
        moveFailed = true;
        return Promise.reject(new Error('EIO move boom'));
      }
      return realMove(from, to);
    });
    const system = makeSystem(fs, audit, { canResume: () => true });

    const resumed = await system.resumeWaitingTasks();
    expect(resumed).toBe(1);
    // taskA：move 失败 → audit 留证、任务留 running、事实保留且带可重放迁移意图
    // （等待身份不丢）；expiresAt 不重置
    expect(fileMap.has(`tasks/queues/running/${taskA.id}.json`)).toBe(true);
    expect(fileMap.has(`tasks/queues/pending/${taskA.id}.json`)).toBe(false);
    const retainedA = JSON.parse(fileMap.get(`tasks/queues/results/${taskA.id}/${LLM_WAIT_FILE}`)!) as Record<string, unknown>;
    expect(retainedA.expiresAt).toBe(factA.expiresAt);
    expect((retainedA.resumeIntent as { target: string }).target).toBe('pending');
    const failedEvents = events.filter(
      e => e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED
        && e.some(c => typeof c === 'string' && c.includes('context=llm_wait_resume_move_failed')),
    );
    expect(failedEvents.length).toBe(1);
    // taskB：不受影响，正常唤醒
    expect(fileMap.has(`tasks/queues/pending/${taskB.id}.json`)).toBe(true);
    expect(fileMap.has(`tasks/queues/results/${taskB.id}/${LLM_WAIT_FILE}`)).toBe(false);
    expect(events.filter(e => e[0] === TASK_AUDIT_EVENTS.TASK_LLM_WAIT_RESUMED).length).toBe(1);

    // 重试（再次 ready 信号）：按意图重放 move → 收敛回 pending、事实清除
    const again = await system.resumeWaitingTasks();
    expect(again).toBe(1);
    expect(fileMap.has(`tasks/queues/pending/${taskA.id}.json`)).toBe(true);
    expect(fileMap.has(`tasks/queues/running/${taskA.id}.json`)).toBe(false);
    expect(fileMap.has(`tasks/queues/results/${taskA.id}/${LLM_WAIT_FILE}`)).toBe(false);
    expect(events.filter(e => e[0] === TASK_AUDIT_EVENTS.TASK_LLM_WAIT_RESUMED).length).toBe(2);
    await system.shutdown(1).catch(() => { /* silent: teardown */ });
  });
});

// ─── 4. waiting 事实 corrupt：audit 留证、不 move、不删事实 ──────────────────
describe('Step F-4: 损坏等待事实 → audit 留证、不动不删', () => {
  it('坏 JSON → llm_wait_wakeup_fact_corrupt 留证，任务与事实均保留', async () => {
    const task = makeValidTask(FULL_ID_A);
    const { fs, fileMap } = makeMapFs(runningTaskSeed(task, {
      [`tasks/queues/results/${task.id}/${LLM_WAIT_FILE}`]: '{not valid json',
    }));
    const { audit, events } = makeMockAudit();
    const system = makeSystem(fs, audit, { canResume: () => true });

    const resumed = await system.resumeWaitingTasks();
    expect(resumed).toBe(0);
    expect(fs.move).not.toHaveBeenCalled();
    expect(fileMap.has(`tasks/queues/running/${task.id}.json`)).toBe(true);
    // 不删事实（Phase 1934 Step D 统一：损坏原文保留；启动恢复同样不删、
    // fall through 既有分支处置）
    expect(fileMap.has(`tasks/queues/results/${task.id}/${LLM_WAIT_FILE}`)).toBe(true);
    const corruptEvents = events.filter(
      e => e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED
        && e.some(c => typeof c === 'string' && c.includes('context=llm_wait_wakeup_fact_corrupt')),
    );
    expect(corruptEvents.length).toBe(1);
    await system.shutdown(1).catch(() => { /* silent: teardown */ });
  });
});

// ─── 5. 无 waiting 事实的 running 任务：不受影响 ─────────────────────────────
describe('Step F-5: 无等待事实的 running 任务 → 不受影响', () => {
  it('0 唤醒、无 move、无 LLM 等待 audit', async () => {
    const task = makeValidTask(FULL_ID_A);
    const { fs, fileMap } = makeMapFs(runningTaskSeed(task));
    const { audit, events } = makeMockAudit();
    const system = makeSystem(fs, audit, { canResume: () => true });

    const resumed = await system.resumeWaitingTasks();
    expect(resumed).toBe(0);
    expect(fs.move).not.toHaveBeenCalled();
    expect(fileMap.has(`tasks/queues/running/${task.id}.json`)).toBe(true);
    const waitEvents = events.filter(e =>
      e[0] === TASK_AUDIT_EVENTS.TASK_LLM_WAIT_RESUMED
      || e[0] === TASK_AUDIT_EVENTS.TASK_LLM_WAIT_CONTINUED
      || e[0] === TASK_AUDIT_EVENTS.TASK_LLM_WAIT_EXPIRED);
    expect(waitEvents.length).toBe(0);
    await system.shutdown(1).catch(() => { /* silent: teardown */ });
  });
});

// ─── 6. onWaitScheduled 钩子：executor 返回 waiting → 钩子恰一次 ─────────────
describe('Step F-6: onWaitScheduled 钩子——事实落盘后通知一次、载荷为持久化事实', () => {
  it('executeSubAgentTask waiting 分支：persistLLMWait 成功后钩子被调一次', async () => {
    const { fs, fileMap } = makeMapFs();
    const { audit } = makeMockAudit();
    const task = makeValidTask(FULL_ID_A);
    const fact = makeFact();
    const onWaitScheduled = vi.fn();
    const outcome: TaskExecutionOutcome = {
      content: fact.reason,
      sourceIsError: true,
      errorCategory: 'LLMAllProvidersFailedError',
      waiting: fact,
    };

    await executeSubAgentTask(task, new AbortController().signal, {
      fs,
      fsFactory: () => fs,
      auditWriter: audit,
      clawDir: '/tmp/claw',
      postProcessors: new Map(),
      moveTaskToDone: vi.fn().mockResolvedValue(undefined),
      moveTaskToFailed: vi.fn().mockResolvedValue(undefined),
      taskExecutor: { execute: vi.fn().mockResolvedValue(outcome) },
      deliverySink: { deliver: vi.fn() },
      onWaitScheduled,
    });

    expect(onWaitScheduled).toHaveBeenCalledTimes(1);
    expect(onWaitScheduled).toHaveBeenCalledWith(fact);
    // 事实已落盘（通知发生在持久化成功之后）
    expect(fileMap.has(`tasks/queues/results/${task.id}/${LLM_WAIT_FILE}`)).toBe(true);
  });

  it('hook 抛异常 → audit 留证，任务状态不受影响（仍留 running 等待语义）', async () => {
    const { fs, fileMap } = makeMapFs();
    const { audit, events } = makeMockAudit();
    const task = makeValidTask(FULL_ID_A);
    const fact = makeFact();
    const moveTaskToDone = vi.fn().mockResolvedValue(undefined);
    const moveTaskToFailed = vi.fn().mockResolvedValue(undefined);
    const outcome: TaskExecutionOutcome = {
      content: fact.reason,
      sourceIsError: true,
      errorCategory: 'LLMAllProvidersFailedError',
      waiting: fact,
    };

    await executeSubAgentTask(task, new AbortController().signal, {
      fs,
      fsFactory: () => fs,
      auditWriter: audit,
      clawDir: '/tmp/claw',
      postProcessors: new Map(),
      moveTaskToDone,
      moveTaskToFailed,
      taskExecutor: { execute: vi.fn().mockResolvedValue(outcome) },
      deliverySink: { deliver: vi.fn() },
      onWaitScheduled: () => { throw new Error('hook boom'); },
    });

    // 通知异常不扩散：事实仍在、任务不终态、audit 留证
    expect(fileMap.has(`tasks/queues/results/${task.id}/${LLM_WAIT_FILE}`)).toBe(true);
    expect(moveTaskToDone).not.toHaveBeenCalled();
    expect(moveTaskToFailed).not.toHaveBeenCalled();
    const hookEvents = events.filter(
      e => e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED
        && e.some(c => typeof c === 'string' && c.includes('context=llm_wait_schedule_hook_failed')),
    );
    expect(hookEvents.length).toBe(1);
  });
});
