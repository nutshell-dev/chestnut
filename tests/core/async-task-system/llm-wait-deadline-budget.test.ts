/**
 * Phase 1934 Z-D1：等待预算帽——任务首次持久 deadline 跨唤醒周期保留、不重置。
 *
 * 修复前：executor（Assembly）每次生成等待事实都用 nowMs + task.timeoutMs
 * （完整新预算）；resume 后旧 deadline 随等待事实清除丢失 → 每次唤醒重获
 * 完整预算（多轮共享故障下等待可无限延续，deadline 名存实亡）。
 * 修复后：ATS 侧（llm-wait-state own 的 llm-wait-deadline.json）保留首次
 * deadline，第二次起的等待事实 expiresAt 被钳制到首次 deadline；Assembly
 * 不读 ATS 私有事实（只提案预算，钳制归 ATS）。
 *
 * 覆盖：
 * 1. 首次等待建立预算帽：deadline 记录落盘 = 提案 expiresAt；事实按提案持久化。
 * 2. 两轮等待 + 中间重启（真实 resume 路径；executeSubAgentTask 无内存状态、
 *    全部状态经磁盘 = 重启语义）：第二轮提案完整新预算 → 持久化事实被钳制到
 *    首次 deadline，onWaitScheduled 钩子收到钳制值，deadline 记录不改写。
 * 3. 预算耗尽后再次等待：钳制到过去的 deadline → deadline 优先于 ready →
 *    expired（投递 + terminal intent + move failed + 事实清除），不得再入等待。
 * 4. deadline 记录损坏：不猜——原文改名备份留证 + audit + 按提案重建，
 *    任务正常进入等待（损坏场景不死锁）。
 *
 * 时钟：vi.useFakeTimers + setSystemTime（确定性推进，无 sleep）。
 * 构造惯例 mirror llm-wait-wakeup.test.ts（Map 手实现 FileSystem 子集）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeSubAgentTask } from '../../../src/core/async-task-system/subagent-executor.js';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { InMemoryShortIdIndex } from '../../../src/core/async-task-system/short-id-index.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import {
  LLM_WAIT_FILE,
  LLM_WAIT_DEADLINE_FILE,
  type LLMWaitFact,
} from '../../../src/core/async-task-system/llm-wait-state.js';
import type { SubAgentTask, TaskExecutionOutcome } from '../../../src/core/async-task-system/types.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { makeTaskSystemDeps } from '../../helpers/task-system.js';

const FULL_ID_A = '550e8400-e29b-41d4-a716-446655440000';

/** 确定性时钟基点（固定 epoch，避免依赖真实时间）。 */
const T0 = 1_700_000_000_000;
/** 任务等待预算（task.timeoutMs）：10 分钟——便于构造预算过半/耗尽两个相位。 */
const TASK_TIMEOUT_MS = 600_000;
/** 预算过半相位：首轮等待持续 5 分钟后再次失败（预算剩一半，可区分钳制/重置）。 */
const HALF_BUDGET_MS = 300_000;
/** 探针下界偏移（事实字段，非本测试关注点）：1 分钟。 */
const PROBE_OFFSET_MS = 60_000;

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
    timeoutMs: TASK_TIMEOUT_MS,
    maxSteps: 1,
    parentClawId: 'parent',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** executor（Assembly 侧）提案的等待事实：每次按 nowMs + timeoutMs 生成（完整新预算）。 */
function makeProposal(nowMs: number): LLMWaitFact {
  return {
    scope: 'claw-process',
    nextProbeAt: nowMs + PROBE_OFFSET_MS,
    recordedAt: nowMs,
    expiresAt: nowMs + TASK_TIMEOUT_MS,
    reason: 'All LLM providers failed',
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

/** executeSubAgentTask 的最小依赖集（executor 返回携带 waiting 提案的失败 outcome）。 */
function makeExecDeps(
  fs: FileSystem,
  audit: AuditLog,
  waiting: LLMWaitFact,
  onWaitScheduled?: (fact: LLMWaitFact) => void,
) {
  const outcome: TaskExecutionOutcome = {
    content: waiting.reason,
    sourceIsError: true,
    errorCategory: 'LLMAllProvidersFailedError',
    waiting,
  };
  return {
    fs,
    fsFactory: () => fs,
    auditWriter: audit,
    clawDir: '/tmp/claw',
    postProcessors: new Map(),
    moveTaskToDone: vi.fn().mockResolvedValue(undefined),
    moveTaskToFailed: vi.fn().mockResolvedValue(undefined),
    taskExecutor: { execute: vi.fn().mockResolvedValue(outcome) },
    deliverySink: { deliver: vi.fn() },
    ...(onWaitScheduled ? { onWaitScheduled } : {}),
  };
}

const waitPathOf = (task: SubAgentTask) => `tasks/queues/results/${task.id}/${LLM_WAIT_FILE}`;
const deadlinePathOf = (task: SubAgentTask) => `tasks/queues/results/${task.id}/${LLM_WAIT_DEADLINE_FILE}`;
const runningPathOf = (task: SubAgentTask) => `tasks/queues/running/${task.id}.json`;

function readPersistedFact(fileMap: Map<string, string>, task: SubAgentTask): Record<string, unknown> {
  return JSON.parse(fileMap.get(waitPathOf(task))!) as Record<string, unknown>;
}

function readDeadlineRecord(fileMap: Map<string, string>, task: SubAgentTask): Record<string, unknown> {
  return JSON.parse(fileMap.get(deadlinePathOf(task))!) as Record<string, unknown>;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Phase 1934 Z-D1：等待预算帽（首次持久 deadline 不重置）', () => {
  it('首次等待建立预算帽：deadline 记录落盘 = 提案 expiresAt；事实按提案持久化', async () => {
    const task = makeValidTask(FULL_ID_A);
    const { fs, fileMap } = makeMapFs({ [runningPathOf(task)]: JSON.stringify(task) });
    const { audit } = makeMockAudit();
    const proposal = makeProposal(T0);
    const onWaitScheduled = vi.fn();

    await executeSubAgentTask(task, new AbortController().signal,
      makeExecDeps(fs, audit, proposal, onWaitScheduled));

    // 等待事实按提案持久化
    const fact = readPersistedFact(fileMap, task);
    expect(fact.expiresAt).toBe(T0 + TASK_TIMEOUT_MS);
    expect(fact.recordedAt).toBe(T0);
    // 首次 deadline 记录落盘（预算帽的唯一持久来源）
    const deadline = readDeadlineRecord(fileMap, task);
    expect(deadline.expiresAt).toBe(T0 + TASK_TIMEOUT_MS);
    expect(onWaitScheduled).toHaveBeenCalledTimes(1);
    expect(onWaitScheduled).toHaveBeenCalledWith(proposal);
  });

  it('两轮等待 + 中间重启：第二轮提案完整新预算 → 钳制到首次 deadline，deadline 记录不改写', async () => {
    const task = makeValidTask(FULL_ID_A);
    const { fs, fileMap } = makeMapFs({ [runningPathOf(task)]: JSON.stringify(task) });
    const { audit } = makeMockAudit();

    // 第一轮等待（t0）
    await executeSubAgentTask(task, new AbortController().signal,
      makeExecDeps(fs, audit, makeProposal(T0)));
    expect(readDeadlineRecord(fileMap, task).expiresAt).toBe(T0 + TASK_TIMEOUT_MS);

    // 真实 resume 路径（gate ready、未到 deadline）→ pending + 事实清除
    // （预算帽记录不随等待事实清除——这是 Z-D1 的关键载体）
    const system = new AsyncTaskSystem('/tmp/claw', fs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      ...makeTaskSystemDeps(),
      waitGate: { canResume: () => true },
    });
    expect(await system.resumeWaitingTasks()).toBe(1);
    expect(fileMap.has(waitPathOf(task))).toBe(false);           // 事实已清
    expect(fileMap.has(deadlinePathOf(task))).toBe(true);        // 预算帽保留
    await system.shutdown(1).catch(() => { /* silent: teardown */ });

    // ── 中间重启语义：executeSubAgentTask / AsyncTaskSystem 均无内存状态，
    //    第二轮仅经磁盘事实（等价于进程重启后的 dispatch）──
    await fs.move(`tasks/queues/pending/${task.id}.json`, runningPathOf(task));
    const t1 = T0 + HALF_BUDGET_MS;  // 预算过半
    vi.setSystemTime(t1);

    // 第二轮等待：executor 按惯例提案完整新预算（t1 + timeoutMs）
    const onWaitScheduled2 = vi.fn();
    await executeSubAgentTask(task, new AbortController().signal,
      makeExecDeps(fs, audit, makeProposal(t1), onWaitScheduled2));

    // 持久化事实被钳制到首次 deadline（不重置为 t1 + timeoutMs）
    const fact2 = readPersistedFact(fileMap, task);
    expect(fact2.expiresAt).toBe(T0 + TASK_TIMEOUT_MS);
    expect(fact2.recordedAt).toBe(t1);  // 证据字段如实记录本轮等待时刻
    // deadline 检查安排消费钳制值（钩子载荷 = 持久化事实）
    expect(onWaitScheduled2).toHaveBeenCalledTimes(1);
    expect((onWaitScheduled2.mock.calls[0][0] as LLMWaitFact).expiresAt).toBe(T0 + TASK_TIMEOUT_MS);
    // 预算帽记录不被第二轮改写
    expect(readDeadlineRecord(fileMap, task).expiresAt).toBe(T0 + TASK_TIMEOUT_MS);
  });

  it('预算耗尽后再次等待：钳制到过去的 deadline → deadline 优先于 ready → expired，不得再入等待', async () => {
    const task = makeValidTask(FULL_ID_A);
    const { fs, fileMap } = makeMapFs({ [runningPathOf(task)]: JSON.stringify(task) });
    const { audit, events } = makeMockAudit();

    // 第一轮等待（t0）建立预算帽
    await executeSubAgentTask(task, new AbortController().signal,
      makeExecDeps(fs, audit, makeProposal(T0)));
    // 模拟 resume + 重新 dispatch（budget 帽保留、事实清除）
    const resumeSystem = new AsyncTaskSystem('/tmp/claw', fs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      ...makeTaskSystemDeps(),
      waitGate: { canResume: () => true },
    });
    expect(await resumeSystem.resumeWaitingTasks()).toBe(1);
    await resumeSystem.shutdown(1).catch(() => { /* silent: teardown */ });
    await fs.move(`tasks/queues/pending/${task.id}.json`, runningPathOf(task));

    // 第二轮：唤醒后再次失败时预算已耗尽（t2 > 首次 deadline）
    const t2 = T0 + TASK_TIMEOUT_MS + 1_000;
    vi.setSystemTime(t2);
    await executeSubAgentTask(task, new AbortController().signal,
      makeExecDeps(fs, audit, makeProposal(t2)));

    // 事实按钳制后的过去 deadline 落盘（过期语义由处置协议消费，不虚报未来预算）
    const fact2 = readPersistedFact(fileMap, task);
    expect(fact2.expiresAt).toBe(T0 + TASK_TIMEOUT_MS);

    // 处置入口（deadline 优先于 ready）：gate 就绪也不得唤醒，按 expired 终态
    const sendFallbackResult = vi.fn().mockResolvedValue({ kind: 'delivered' });
    const expirySystem = new AsyncTaskSystem('/tmp/claw', fs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      ...makeTaskSystemDeps(),
      waitGate: { canResume: () => true },
      sendFallbackResult,
    });
    expect(await expirySystem.resumeWaitingTasks()).toBe(0);  // 无唤醒
    expect(sendFallbackResult).toHaveBeenCalledTimes(1);
    expect((sendFallbackResult.mock.calls[0][3] as { isError: boolean }).isError).toBe(true);
    expect(fileMap.has(`tasks/queues/failed/${task.id}.json`)).toBe(true);
    expect(fileMap.has(runningPathOf(task))).toBe(false);
    expect(fileMap.has(waitPathOf(task))).toBe(false);
    expect(events.filter(e => e[0] === TASK_AUDIT_EVENTS.TASK_LLM_WAIT_EXPIRED).length).toBe(1);
    await expirySystem.shutdown(1).catch(() => { /* silent: teardown */ });
  });

  it('deadline 记录损坏：不猜——原文改名备份留证 + audit + 按提案重建，任务正常进入等待', async () => {
    const task = makeValidTask(FULL_ID_A);
    const { fs, fileMap } = makeMapFs({
      [runningPathOf(task)]: JSON.stringify(task),
      [deadlinePathOf(task)]: '{not valid json',
    });
    const { audit, events } = makeMockAudit();

    await executeSubAgentTask(task, new AbortController().signal,
      makeExecDeps(fs, audit, makeProposal(T0)));

    // 原文改名备份（不删除、留证），按提案重建
    const backupKeys = [...fileMap.keys()].filter(k => k.startsWith(`${deadlinePathOf(task)}.corrupt-`));
    expect(backupKeys.length).toBe(1);
    expect(fileMap.get(backupKeys[0])).toBe('{not valid json');
    expect(readDeadlineRecord(fileMap, task).expiresAt).toBe(T0 + TASK_TIMEOUT_MS);
    // audit 留证
    const corruptEvents = events.filter(
      e => e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED
        && e.some(c => typeof c === 'string' && c.includes('context=llm_wait_deadline_corrupt')),
    );
    expect(corruptEvents.length).toBe(1);
    // 任务正常进入等待（不死锁）
    expect(readPersistedFact(fileMap, task).expiresAt).toBe(T0 + TASK_TIMEOUT_MS);
  });
});
