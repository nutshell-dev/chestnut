/**
 * Phase 1933 Step E：ATS 持久等待与恢复（llm-wait.json 事实面）。
 *
 * 覆盖：
 * 1. 等待持久化（executor waiting outcome → 事实落盘、任务留 running、不投递不终态）；
 * 2/3. 重启恢复（gate 未就绪/缺席 → 保持 waiting；就绪 → 清事实回 pending）；
 * 4. deadline 过期 → failed（不误转成功）；
 * 5. waiting 任务取消（fallback 通知 + move failed，不返回 not_found、不误转 done）；
 * 6. executor 分类（LLMAllProvidersFailedError → waiting；abort/context_exceeded → 失败路径）；
 * 7. 损坏事实（audit 留证 + 删除 + fall through 既有分支，不猜）；
 * 8. 旧记录兼容（无等待事实的 running 任务恢复行为不变）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { recoverTasks, type RecoverTasksDeps } from '../../../src/core/async-task-system/task-recovery.js';
import { executeSubAgentTask } from '../../../src/core/async-task-system/subagent-executor.js';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { InMemoryShortIdIndex } from '../../../src/core/async-task-system/short-id-index.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import { LLM_WAIT_FILE, type LLMWaitFact } from '../../../src/core/async-task-system/llm-wait-state.js';
import type { SubAgentTask, TaskExecutionOutcome } from '../../../src/core/async-task-system/types.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { createSubagentTaskExecutor } from '../../../src/assembly/subagent-task-executor.js';
import {
  LLMAllProvidersFailedError,
  LLM_RECOVERY_COOLDOWN_MS,
  type LLMInstanceSnapshot,
  type LLMOrchestratorOwner,
} from '../../../src/foundation/llm-orchestrator/index.js';
import { LLMContextExceededError, makeExternalAbortError } from '../../../src/foundation/llm-provider/index.js';
import { makeTaskSystemDeps, makeTestRegistry } from '../../helpers/task-system.js';
import { SUBAGENT_SHORT_TIMEOUT_MS } from '../../helpers/test-timeouts.js';

const FULL_ID = '550e8400-e29b-41d4-a716-446655440000';

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

function makeValidTask(overrides: Partial<SubAgentTask> = {}): SubAgentTask {
  return {
    kind: 'subagent',
    mode: 'standard',
    id: FULL_ID as SubAgentTask['id'],
    shortId: '550e8400' as SubAgentTask['shortId'],
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

/** Map 手实现 FileSystem 子集（惯例 mirror task-recovery-invariants.test.ts）。 */
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

function makeRecoverDeps(fs: FileSystem, auditWriter: AuditLog, gate?: { canResume(scope: string): boolean }): RecoverTasksDeps {
  return {
    fs,
    auditWriter,
    sendResult: vi.fn().mockRejectedValue(new Error('send fail')),
    sendFallbackResult: vi.fn().mockRejectedValue(new Error('fallback fail')),
    sendToolResult: vi.fn().mockResolvedValue(undefined),
    ...(gate ? { waitGate: gate } : {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── 1. 等待持久化（executeSubAgentTask 直测） ───────────────────────────────
describe('Step E-1: executor waiting outcome → 事实落盘、任务留 running', () => {
  it('persistLLMWait 落盘字段完整；不投递、不终态、不写 post-process input', async () => {
    const { fs, fileMap } = makeMapFs();
    const { audit, events } = makeMockAudit();
    const task = makeValidTask();
    const fact = makeFact();
    const moveTaskToDone = vi.fn().mockResolvedValue(undefined);
    const moveTaskToFailed = vi.fn().mockResolvedValue(undefined);
    const deliver = vi.fn();
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
      deliverySink: { deliver },
    });

    const waitPath = `tasks/queues/results/${task.id}/${LLM_WAIT_FILE}`;
    expect(fileMap.has(waitPath)).toBe(true);
    const persisted = JSON.parse(fileMap.get(waitPath)!) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      schema_version: 1,
      scope: fact.scope,
      nextProbeAt: fact.nextProbeAt,
      recordedAt: fact.recordedAt,
      expiresAt: fact.expiresAt,
      reason: fact.reason,
    });
    // 留 running：不终态、不投递、不写 post-process input
    expect(moveTaskToDone).not.toHaveBeenCalled();
    expect(moveTaskToFailed).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(fileMap.has(`tasks/queues/results/${task.id}/post-process-input.json`)).toBe(false);
    expect(events.some(e => e[0] === TASK_AUDIT_EVENTS.TASK_LLM_WAIT_PERSISTED)).toBe(true);
  });
});

// ─── 2. 重启恢复-未就绪 ─────────────────────────────────────────────────────
describe('Step E-2: 恢复 gate 未就绪/缺席 → 保持 waiting', () => {
  it('gate 缺席：任务留 running、事实保留、无 move', async () => {
    const task = makeValidTask();
    const fact = makeFact();
    const { fs, fileMap } = makeMapFs(runningTaskSeed(task, waitFileSeed(task, fact)));
    const { audit, events } = makeMockAudit();

    await recoverTasks(makeRecoverDeps(fs, audit));

    expect(fs.move).not.toHaveBeenCalled();
    expect(fileMap.has(`tasks/queues/running/${task.id}.json`)).toBe(true);
    expect(fileMap.has(`tasks/queues/results/${task.id}/${LLM_WAIT_FILE}`)).toBe(true);
    const continued = events.filter(e => e[0] === TASK_AUDIT_EVENTS.TASK_LLM_WAIT_CONTINUED);
    expect(continued.length).toBe(1);
    expect(continued[0].some(c => c === 'reason=gate_absent')).toBe(true);
  });

  it('gate canResume=false：任务留 running、事实保留、无 move', async () => {
    const task = makeValidTask();
    const fact = makeFact();
    const { fs, fileMap } = makeMapFs(runningTaskSeed(task, waitFileSeed(task, fact)));
    const { audit, events } = makeMockAudit();

    await recoverTasks(makeRecoverDeps(fs, audit, { canResume: () => false }));

    expect(fs.move).not.toHaveBeenCalled();
    expect(fileMap.has(`tasks/queues/running/${task.id}.json`)).toBe(true);
    expect(fileMap.has(`tasks/queues/results/${task.id}/${LLM_WAIT_FILE}`)).toBe(true);
    const continued = events.filter(e => e[0] === TASK_AUDIT_EVENTS.TASK_LLM_WAIT_CONTINUED);
    expect(continued.length).toBe(1);
    expect(continued[0].some(c => c === 'reason=gate_not_ready')).toBe(true);
  });
});

// ─── 3. 重启恢复-就绪 ───────────────────────────────────────────────────────
describe('Step E-3: 恢复 gate 就绪 → 清事实、回 pending 重调度', () => {
  it('gate 就绪 → 清事实、回 pending 重调度', async () => {
    const task = makeValidTask();
    const fact = makeFact();
    const { fs, fileMap } = makeMapFs(runningTaskSeed(task, waitFileSeed(task, fact)));
    const { audit, events } = makeMockAudit();
    const deps = makeRecoverDeps(fs, audit, { canResume: () => true });

    await recoverTasks(deps);

    expect(fileMap.has(`tasks/queues/results/${task.id}/${LLM_WAIT_FILE}`)).toBe(false);
    expect(fileMap.has(`tasks/queues/running/${task.id}.json`)).toBe(false);
    expect(fileMap.has(`tasks/queues/pending/${task.id}.json`)).toBe(true);
    expect(events.some(e => e[0] === TASK_AUDIT_EVENTS.TASK_LLM_WAIT_RESUMED)).toBe(true);
    // 唤醒走重调度，不经投递路径
    expect(deps.sendResult).not.toHaveBeenCalled();
    expect(deps.sendFallbackResult).not.toHaveBeenCalled();
  });
});

// ─── 4. deadline 过期 → failed ──────────────────────────────────────────────
describe('Step E-4: 等待 deadline 过期 → failed（不误转成功）', () => {
  it('expiresAt 已过：任务到 failed、事实清除、未投递', async () => {
    const task = makeValidTask();
    // recordedAt/nextProbeAt 须 ≤ expiresAt（严格校验），全部取过去时刻
    const now = Date.now();
    const fact = makeFact({ recordedAt: now - 10_000, nextProbeAt: now - 5_000, expiresAt: now - 1_000 });
    const { fs, fileMap } = makeMapFs(runningTaskSeed(task, waitFileSeed(task, fact)));
    const { audit, events } = makeMockAudit();
    const deps = makeRecoverDeps(fs, audit, { canResume: () => true });

    await recoverTasks(deps);

    expect(fileMap.has(`tasks/queues/failed/${task.id}.json`)).toBe(true);
    expect(fileMap.has(`tasks/queues/running/${task.id}.json`)).toBe(false);
    expect(fileMap.has(`tasks/queues/results/${task.id}/${LLM_WAIT_FILE}`)).toBe(false);
    expect(fileMap.has(`tasks/queues/done/${task.id}.json`)).toBe(false);
    expect(deps.sendResult).not.toHaveBeenCalled();
    expect(events.some(e => e[0] === TASK_AUDIT_EVENTS.TASK_LLM_WAIT_EXPIRED)).toBe(true);
  });
});

// ─── 5. waiting 任务取消 ────────────────────────────────────────────────────
describe('Step E-5: waiting 任务 cancelDetailed → 通知 + failed，不 not_found', () => {
  it('无内存句柄 + 磁盘等待事实 → cancelled(from=running_waiting)', async () => {
    const task = makeValidTask();
    const fact = makeFact();
    const { fs, fileMap } = makeMapFs(runningTaskSeed(task, waitFileSeed(task, fact)));
    const { audit } = makeMockAudit();
    const sendFallbackResult = vi.fn().mockResolvedValue(undefined);

    const system = new AsyncTaskSystem('/tmp/claw', fs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      ...makeTaskSystemDeps(),
      sendFallbackResult,
    });
    // 不调 initialize：本用例直接构造重启后 running 残留形态（无内存句柄）。
    const outcome = await system.cancelDetailed(task.id);
    expect(outcome.kind).toBe('cancelled');
    if (outcome.kind === 'cancelled') {
      expect(outcome.from).toBe('running_waiting');
    }
    // parent 收到 fallback 通知
    expect(sendFallbackResult).toHaveBeenCalledTimes(1);
    // 任务到 failed、不误转 done
    expect(fileMap.has(`tasks/queues/failed/${task.id}.json`)).toBe(true);
    expect(fileMap.has(`tasks/queues/running/${task.id}.json`)).toBe(false);
    expect(fileMap.has(`tasks/queues/done/${task.id}.json`)).toBe(false);
    // 事实文件保留作证据
    expect(fileMap.has(`tasks/queues/results/${task.id}/${LLM_WAIT_FILE}`)).toBe(true);
    await system.shutdown(1).catch(() => { /* silent: teardown */ });
  });

  it('无内存句柄 + 无等待事实 → 维持 not_found（现状回归）', async () => {
    const task = makeValidTask();
    const { fs } = makeMapFs(runningTaskSeed(task));
    const { audit } = makeMockAudit();

    const system = new AsyncTaskSystem('/tmp/claw', fs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      ...makeTaskSystemDeps(),
      sendFallbackResult: vi.fn().mockResolvedValue(undefined),
    });

    const outcome = await system.cancelDetailed(task.id);
    expect(outcome.kind).toBe('not_found');
    await system.shutdown(1).catch(() => { /* silent: teardown */ });
  });
});

// ─── 6. executor 分类（createSubagentTaskExecutor 直测） ────────────────────
describe('Step E-6: executor 分类——共享故障携带 waiting，abort/context_exceeded 不携带', () => {
  function makeOwnerLlm(snapshot: LLMInstanceSnapshot): LLMOrchestratorOwner {
    return {
      call: vi.fn(),
      stream: vi.fn(),
      close: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(true),
      getProviderInfo: vi.fn().mockReturnValue({ name: 'mock', model: 'test', isFallback: false }),
      resetLastSuccessProvider: vi.fn(),
      reloadConfig: vi.fn(),
      snapshot: vi.fn().mockReturnValue(snapshot),
      probe: vi.fn(),
      callWithinRecovery: vi.fn(),
      streamWithinRecovery: vi.fn(),
    } as unknown as LLMOrchestratorOwner;
  }

  function makeExecutorRun(error: unknown, snapshot: LLMInstanceSnapshot) {
    const executor = createSubagentTaskExecutor({
      llm: makeOwnerLlm(snapshot),
      registry: makeTestRegistry(),
      runSubagent: vi.fn().mockRejectedValue(error) as never,
    });
    const { audit } = makeMockAudit();
    const { fs } = makeMapFs();
    return executor.execute(makeValidTask(), new AbortController().signal, {
      fs,
      fsFactory: () => fs,
      auditWriter: audit,
      clawDir: '/tmp/claw',
    });
  }

  const allFailed = () => new LLMAllProvidersFailedError([
    { provider: 'p1', error: new Error('boom') },
  ]);

  it('LLMAllProvidersFailedError + open breakers → waiting.nextProbeAt = 最大 probeAllowedAtMs', async () => {
    const now = Date.now();
    const outcome = await makeExecutorRun(allFailed(), {
      takenAtMs: now,
      providers: [
        { provider: 'p1', isFallback: false, breakerOpen: true, openCause: 'transient', consecutiveFailures: 3, probeAllowedAtMs: now + 30_000 },
        { provider: 'p2', isFallback: true, breakerOpen: true, openCause: 'transient', consecutiveFailures: 2, probeAllowedAtMs: now + 90_000 },
      ],
    });
    expect(outcome.sourceIsError).toBe(true);
    expect(outcome.waiting).toBeDefined();
    expect(outcome.waiting!.scope).toBe('claw-process');
    expect(outcome.waiting!.nextProbeAt).toBe(now + 90_000);
    expect(outcome.waiting!.expiresAt - outcome.waiting!.recordedAt).toBe(SUBAGENT_SHORT_TIMEOUT_MS);
  });

  it('LLMAllProvidersFailedError + 无 open breaker → nextProbeAt = now + LLM_RECOVERY_COOLDOWN_MS', async () => {
    const before = Date.now();
    const outcome = await makeExecutorRun(allFailed(), {
      takenAtMs: before,
      providers: [
        { provider: 'p1', isFallback: false, breakerOpen: false, openCause: null, consecutiveFailures: 0 },
      ],
    });
    const after = Date.now();
    expect(outcome.waiting).toBeDefined();
    expect(outcome.waiting!.nextProbeAt).toBeGreaterThanOrEqual(before + LLM_RECOVERY_COOLDOWN_MS);
    expect(outcome.waiting!.nextProbeAt).toBeLessThanOrEqual(after + LLM_RECOVERY_COOLDOWN_MS);
  });

  it('abort（ExternalAbortError）→ 不携带 waiting（走失败路径）', async () => {
    const outcome = await makeExecutorRun(makeExternalAbortError({ type: 'user' }), {
      takenAtMs: Date.now(),
      providers: [],
    });
    expect(outcome.sourceIsError).toBe(true);
    expect(outcome.waiting).toBeUndefined();
  });

  it('context_exceeded → 不携带 waiting（非共享故障）', async () => {
    const outcome = await makeExecutorRun(new LLMContextExceededError('p1', 400, 'prompt too long'), {
      takenAtMs: Date.now(),
      providers: [],
    });
    expect(outcome.sourceIsError).toBe(true);
    expect(outcome.waiting).toBeUndefined();
  });
});

// ─── 7. 损坏事实 ────────────────────────────────────────────────────────────
describe('Step E-7: 损坏等待事实 → audit 留证 + 删除 + fall through（不猜）', () => {
  it.each([
    ['坏 JSON', '{not valid json'],
    ['缺字段', JSON.stringify({ schema_version: 1, scope: 'claw-process' })],
    ['时间戳倒挂', JSON.stringify({ schema_version: 1, scope: 's', nextProbeAt: 50, recordedAt: 100, expiresAt: 200, reason: 'r' })],
  ])('%s → RECOVERY_FAILED(llm_wait_corrupt) + 删除 + 走既有恢复分支', async (_label, content) => {
    const task = makeValidTask();
    const { fs, fileMap } = makeMapFs(runningTaskSeed(task, {
      [`tasks/queues/results/${task.id}/${LLM_WAIT_FILE}`]: content,
    }));
    const { audit, events } = makeMockAudit();

    await recoverTasks(makeRecoverDeps(fs, audit, { canResume: () => false }));

    const corruptEvents = events.filter(
      e => e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED && e.some(c => typeof c === 'string' && c.includes('context=llm_wait_corrupt')),
    );
    expect(corruptEvents.length).toBe(1);
    // 删除防死循环
    expect(fileMap.has(`tasks/queues/results/${task.id}/${LLM_WAIT_FILE}`)).toBe(false);
    // fall through 既有分支：无 terminalState/结果 → 回 pending 重执行
    expect(fileMap.has(`tasks/queues/pending/${task.id}.json`)).toBe(true);
  });
});

// ─── 8. 旧记录兼容（回归） ──────────────────────────────────────────────────
describe('Step E-8: running 无等待事实的旧记录 → 恢复行为与现状一致', () => {
  it('无 llm-wait.json → 回 pending，无 LLM 等待 audit', async () => {
    const task = makeValidTask();
    const { fs, fileMap } = makeMapFs(runningTaskSeed(task));
    const { audit, events } = makeMockAudit();

    await recoverTasks(makeRecoverDeps(fs, audit, { canResume: () => false }));

    expect(fileMap.has(`tasks/queues/pending/${task.id}.json`)).toBe(true);
    expect(fileMap.has(`tasks/queues/running/${task.id}.json`)).toBe(false);
    const waitEvents = events.filter(e =>
      e[0] === TASK_AUDIT_EVENTS.TASK_LLM_WAIT_PERSISTED
      || e[0] === TASK_AUDIT_EVENTS.TASK_LLM_WAIT_RESUMED
      || e[0] === TASK_AUDIT_EVENTS.TASK_LLM_WAIT_CONTINUED
      || e[0] === TASK_AUDIT_EVENTS.TASK_LLM_WAIT_EXPIRED);
    expect(waitEvents.length).toBe(0);
  });
});
