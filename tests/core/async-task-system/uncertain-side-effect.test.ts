/**
 * Phase 1951 Step B：SubAgent 不确定副作用（uncertain side effect）的 ATS 结算边界。
 *
 * 覆盖：
 * 1. executor 携带 uncertain outcome → 任务留 running：不投递、不 done/failed
 *    终态迁移、不写 post-process input，audit TASK_UNCERTAIN_SIDE_EFFECT 留证；
 * 2. Assembly executor 分类：RecoveryUncertainSideEffectError → uncertain typed
 *    outcome（不折叠为普通失败）；普通业务错误 → 无 uncertain（既有失败路径不变）；
 * 3. 重启恢复：uncertain 留 running（无任何结果产物）→ 既有「无结果」分支回
 *    pending 重调度，由 subagent resume 重新消费游标（恢复流程取得新事实的入口）。
 *
 * 风格 mirror llm-wait-recovery.test.ts（Map 手实现 FileSystem / mock audit）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { recoverTasks, type RecoverTasksDeps } from '../../../src/core/async-task-system/task-recovery.js';
import { executeSubAgentTask } from '../../../src/core/async-task-system/subagent-executor.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import type { SubAgentTask, TaskExecutionOutcome } from '../../../src/core/async-task-system/types.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { createSubagentTaskExecutor } from '../../../src/assembly/subagent-task-executor.js';
import { RecoveryUncertainSideEffectError } from '../../../src/core/subagent/index.js';
import type { LLMOrchestratorOwner, SharedRecoveryDecision } from '../../../src/foundation/llm-orchestrator/index.js';
import { makeTestRegistry } from '../../helpers/task-system.js';
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

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── 1. uncertain outcome → 任务留 running ──────────────────────────────────
describe('1951B-1: executor uncertain outcome → 留 running（不投递不终态）', () => {
  it('不投递、不 move done/failed、不写 post-process input，audit 留证', async () => {
    const { fs, fileMap } = makeMapFs();
    const { audit, events } = makeMockAudit();
    const task = makeValidTask();
    const moveTaskToDone = vi.fn().mockResolvedValue(undefined);
    const moveTaskToFailed = vi.fn().mockResolvedValue(undefined);
    const deliver = vi.fn();
    const outcome: TaskExecutionOutcome = {
      content: 'uncertain side effect: tool tu-1 started without committed result',
      sourceIsError: true,
      errorCategory: 'RecoveryUncertainSideEffectError',
      uncertain: { reason: 'uncertain side effect: tool tu-1 started without committed result' },
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

    // 留 running：不终态、不投递、不写 post-process input（执行未完成结算）
    expect(moveTaskToDone).not.toHaveBeenCalled();
    expect(moveTaskToFailed).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(fileMap.has(`tasks/queues/results/${task.id}/post-process-input.json`)).toBe(false);
    const uncertainEvents = events.filter(e => e[0] === TASK_AUDIT_EVENTS.TASK_UNCERTAIN_SIDE_EFFECT);
    expect(uncertainEvents.length).toBe(1);
    expect(uncertainEvents[0].some(c => typeof c === 'string' && c.startsWith('reason=uncertain side effect'))).toBe(true);
    // 不走 LLM 等待事实面（uncertain 与 waiting 是独立的 typed 路径）
    expect(events.some(e => e[0] === TASK_AUDIT_EVENTS.TASK_LLM_WAIT_PERSISTED)).toBe(false);
  });
});

// ─── 2. Assembly executor 分类 ──────────────────────────────────────────────
describe('1951B-2: createSubagentTaskExecutor 分类——uncertain typed outcome', () => {
  function makeOwnerLlm(decision: SharedRecoveryDecision): LLMOrchestratorOwner {
    return {
      call: vi.fn(),
      stream: vi.fn(),
      close: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(true),
      getProviderInfo: vi.fn().mockReturnValue({ name: 'mock', model: 'test', isFallback: false }),
      resetLastSuccessProvider: vi.fn(),
      getFailureDisposition: vi.fn().mockReturnValue('unknown'),
      reloadConfig: vi.fn(),
      snapshot: vi.fn(),
      probe: vi.fn(),
      callWithinRecovery: vi.fn(),
      streamWithinRecovery: vi.fn(),
      getSharedRecoveryDecision: vi.fn().mockReturnValue(decision),
    } as unknown as LLMOrchestratorOwner;
  }

  function makeExecutorRun(error: unknown) {
    const executor = createSubagentTaskExecutor({
      llm: makeOwnerLlm({ kind: 'ready' }),
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

  it('RecoveryUncertainSideEffectError → uncertain outcome（不折叠为普通失败）', async () => {
    const outcome = await makeExecutorRun(new RecoveryUncertainSideEffectError('tu-1'));
    expect(outcome.sourceIsError).toBe(true);
    expect(outcome.errorCategory).toBe('RecoveryUncertainSideEffectError');
    expect(outcome.uncertain).toBeDefined();
    expect(outcome.uncertain!.reason).toContain('uncertain side effect');
    // 与 LLM 等待路径不相交
    expect(outcome.waiting).toBeUndefined();
  });

  it('普通业务错误 → 无 uncertain（既有失败路径不变）', async () => {
    const outcome = await makeExecutorRun(new Error('boom'));
    expect(outcome.sourceIsError).toBe(true);
    expect(outcome.uncertain).toBeUndefined();
    expect(outcome.waiting).toBeUndefined();
  });
});

// ─── 3. 重启恢复：uncertain 留 running → 无结果分支回 pending ───────────────
describe('1951B-3: 恢复流程取得新事实的入口——running 无结果任务回 pending 重调度', () => {
  it('uncertain 后任务留 running 且无结果产物 → recoverTasks 回 pending（resume 重新消费游标）', async () => {
    const task = makeValidTask();
    const { fs, fileMap } = makeMapFs({
      [`tasks/queues/running/${task.id}.json`]: JSON.stringify(task),
    });
    const { audit } = makeMockAudit();
    const deps: RecoverTasksDeps = {
      fs,
      auditWriter: audit,
      sendResult: vi.fn().mockRejectedValue(new Error('send fail')),
      sendFallbackResult: vi.fn().mockRejectedValue(new Error('fallback fail')),
      sendToolResult: vi.fn().mockResolvedValue(undefined),
    };

    await recoverTasks(deps);

    // 回 pending 重调度：subagent resume 重新消费 recovery store 游标——
    // 取得新事实前 resume 仍 typed 拒绝（agent.ts 抛 RecoveryUncertainSideEffectError），
    // 取得新事实（人工补齐/移除证据）后按游标续跑。
    expect(fileMap.has(`tasks/queues/pending/${task.id}.json`)).toBe(true);
    expect(fileMap.has(`tasks/queues/running/${task.id}.json`)).toBe(false);
    // 不终态：不进 done/failed
    expect(fileMap.has(`tasks/queues/done/${task.id}.json`)).toBe(false);
    expect(fileMap.has(`tasks/queues/failed/${task.id}.json`)).toBe(false);
  });
});
