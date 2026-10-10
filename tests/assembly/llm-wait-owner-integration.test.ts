/**
 * Phase 1934 Step C：LLM owner → Assembly → ATS 集成路径（真实 orchestrator）。
 *
 * 与 llm-wait-recovery/llm-wait-wakeup 的差别：本文件不用 snapshot/gate mock——
 * owner 是真实 LLMOrchestratorImpl（DI seam 注入可控 adapter），Assembly 接线
 * 镜像 business-systems.ts 生产形态：
 * - waitGate.canResume 只映射 owner.getSharedRecoveryDecision().kind === 'ready'
 *   （禁止永远返回 true 的 gate mock）；
 * - onWaitScheduled → owner.scheduleProbe(fact.nextProbeAt)（owner 下界钳制）；
 * - subscribeReady → system.resumeWaitingTasks()。
 *
 * 覆盖：
 * 1. 全候选 transient 故障：waiting 事实的 nextProbeAt 来自 owner 决定；gate 未就绪
 *    时不唤醒（证明 gate 非恒真）；探针到点验证成功 → ready 发布 → ATS 移动任务恰一次；
 *    全程 scheduleProbe 只调度一次（事实落盘时那次，成功后无重排）。
 * 2. 全候选 permanent：on_change 不定时轮询（任意时长 0 探针）；配置变化（换 key）
 *    后 gate 就绪 → 恢复路径可移动。
 *
 * 构造惯例 mirror llm-wait-recovery.test.ts（Map 手实现 FileSystem 子集）；
 * 定时器用 vi.useFakeTimers + advanceTimersByTimeAsync。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLLMOrchestrator } from '../../src/foundation/llm-orchestrator/orchestrator.js';
import type {
  LLMEvent,
  LLMEventSink,
  LLMResponse,
} from '../../src/foundation/llm-orchestrator/index.js';
import { LLMAuthError, LLMNetworkError } from '../../src/foundation/llm-provider/errors.js';
import type {
  ProviderAdapter,
  ProviderConfig,
} from '../../src/foundation/llm-provider/index.js';
import { executeSubAgentTask } from '../../src/core/async-task-system/subagent-executor.js';
import { AsyncTaskSystem } from '../../src/core/async-task-system/system.js';
import { InMemoryShortIdIndex } from '../../src/core/async-task-system/short-id-index.js';
import { createStandardDeliverySink } from '../../src/core/async-task-system/index.js';
import { TASK_AUDIT_EVENTS } from '../../src/core/async-task-system/audit-events.js';
import { LLM_WAIT_FILE } from '../../src/core/async-task-system/llm-wait-state.js';
import type { SubAgentTask } from '../../src/core/async-task-system/types.js';
import type { FileSystem } from '../../src/foundation/fs/types.js';
import type { AuditLog } from '../../src/foundation/audit/index.js';
import type { ContractSystem } from '../../src/core/contract/manager.js';
import { createSubagentTaskExecutor } from '../../src/assembly/subagent-task-executor.js';
import { makeTestRegistry } from '../helpers/task-system.js';

const FULL_ID = '550e8400-e29b-41d4-a716-446655440000';
/** breaker resetTimeoutMs：owner 时间下界基准（transient 候选的下一探针时刻）。 */
const RESET_MS = 5_000;

const OK_RESPONSE: LLMResponse = {
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
};

type Behavior = 'ok' | 'fail' | 'auth';

function createControllableAdapter(name: string, initial: Behavior) {
  let behavior: Behavior = initial;
  let calls = 0;
  const adapter: ProviderAdapter = {
    name,
    model: `model-${name}`,
    call: async () => {
      calls++;
      if (behavior === 'fail') throw new LLMNetworkError(name, new Error('offline'));
      if (behavior === 'auth') throw new LLMAuthError(name, 401);
      return OK_RESPONSE;
    },
  };
  return {
    adapter,
    setBehavior: (b: Behavior) => { behavior = b; },
    calls: () => calls,
  };
}

function providerConfig(name: string, extra?: Partial<ProviderConfig>): ProviderConfig {
  return {
    name,
    apiKey: `key-${name}`,
    model: `model-${name}`,
    temperature: 0,
    timeoutMs: 1_000,
    apiFormat: 'anthropic',
    ...extra,
  };
}

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

function makeValidTask(overrides: Partial<SubAgentTask> = {}): SubAgentTask {
  return {
    kind: 'subagent',
    mode: 'standard',
    id: FULL_ID as SubAgentTask['id'],
    shortId: '550e8400' as SubAgentTask['shortId'],
    intent: 'test',
    timeoutMs: 600_000,  // 等待窗口须覆盖 owner 探针下界（expiresAt 语义归 ATS）
    maxSteps: 1,
    parentClawId: 'parent',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * 生产形态装配（镜像 business-systems.ts L169-193 的接线，窄 gate 只映射 owner 结论）。
 * runSubagent stub 真实调用 owner.call()——故障分类/共享记录/探针全走真实 orchestrator。
 */
function makeAssembledStack(primaryBehavior: Behavior, fallbackBehavior: Behavior) {
  const p = createControllableAdapter('primary', primaryBehavior);
  const f = createControllableAdapter('fallback', fallbackBehavior);
  const emitted: LLMEvent[] = [];
  const sink: LLMEventSink = { emit: (event: LLMEvent) => { emitted.push(event); } };
  const adapters = new Map<string, ProviderAdapter>([['primary', p.adapter], ['fallback', f.adapter]]);
  const orchestratorConfig = {
    primary: providerConfig('primary'),
    fallbacks: [providerConfig('fallback')],
    maxAttempts: 1,
    retryDelayMs: 0,
    events: sink,
    circuitBreaker: { failureThreshold: 1, resetTimeoutMs: RESET_MS },
    createProviderAdapter: (c: ProviderConfig) => adapters.get(c.name ?? '')!,
  };
  const owner = createLLMOrchestrator(orchestratorConfig);

  const { audit, events } = makeMockAudit();
  const registry = makeTestRegistry();
  const executor = createSubagentTaskExecutor({
    llm: owner,
    registry,
    runSubagent: (async ({ llm }: { llm: typeof owner }) => {
      await llm.call({ messages: [{ role: 'user', content: 'work' }] });
      return { text: 'ok' };
    }) as never,
  });

  const { fs, fileMap } = makeMapFs();
  const system = new AsyncTaskSystem('/tmp/claw', fs, {
    shortIdIndex: new InMemoryShortIdIndex(),
    auditWriter: audit,
    taskExecutor: executor,
    deliverySink: createStandardDeliverySink(),
    contractManager: {
      loadPaused: vi.fn(),
      resume: vi.fn(),
      setOnNotify: vi.fn(),
    } as unknown as ContractSystem,
    registry,
    // 窄 gate：只映射 owner 结论，不解释 breaker/snapshot
    waitGate: { canResume: () => owner.getSharedRecoveryDecision().kind === 'ready' },
    onWaitScheduled: (fact) => { owner.scheduleProbe(fact.nextProbeAt); },
  });
  owner.subscribeReady(() => {
    void system.resumeWaitingTasks().catch(() => { /* silent: 测试接线同生产 fail-soft */ });
  });

  return { owner, orchestratorConfig, p, f, audit, events, fs, fileMap, system, executor, emitted };
}

/** 触发 0ms 定时器并冲刷 microtask 队列（probe/唤醒异步 continuation 落点）。 */
function flush(): Promise<void> {
  return vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Phase 1934 Step C：owner→Assembly→ATS 集成', () => {
  it('transient 全故障：事实 nextProbeAt 来自 owner；gate 未就绪不唤醒；探针验证后移动恰一次、只调度一次', async () => {
    const t0 = Date.now();
    const stack = makeAssembledStack('fail', 'fail');
    const { owner, p, f, events, fs, fileMap, system, executor } = stack;
    const scheduleSpy = vi.spyOn(owner, 'scheduleProbe');
    const task = makeValidTask();
    // 任务在执行中（running 残留形态由 executeSubAgentTask 的 waiting 分支保持）
    fileMap.set(`tasks/queues/running/${task.id}.json`, JSON.stringify(task));

    await executeSubAgentTask(task, new AbortController().signal, {
      fs,
      fsFactory: () => fs,
      auditWriter: stack.audit,
      clawDir: '/tmp/claw',
      postProcessors: new Map(),
      moveTaskToDone: vi.fn().mockResolvedValue(undefined),
      moveTaskToFailed: vi.fn().mockResolvedValue(undefined),
      taskExecutor: executor,
      deliverySink: { deliver: vi.fn() },
      onWaitScheduled: (fact) => { owner.scheduleProbe(fact.nextProbeAt); },
    });

    // 真实 orchestrator 全程参与：两候选各一次真实业务调用
    expect(p.calls()).toBe(1);
    expect(f.calls()).toBe(1);
    // waiting 事实落盘：nextProbeAt 来自 owner 决定（transient 下界 = breaker 弹回时刻）
    const waitPath = `tasks/queues/results/${task.id}/${LLM_WAIT_FILE}`;
    expect(fileMap.has(waitPath)).toBe(true);
    const persisted = JSON.parse(fileMap.get(waitPath)!) as Record<string, unknown>;
    expect(persisted.nextProbeAt).toBe(t0 + RESET_MS);
    expect(persisted.recordedAt).toBe(t0);
    // 只调度一次（事实落盘通知那次）
    expect(scheduleSpy).toHaveBeenCalledTimes(1);
    expect(scheduleSpy).toHaveBeenCalledWith(t0 + RESET_MS);
    expect(owner.getSharedRecoveryDecision().kind).toBe('at');

    // gate 非恒真：owner 未就绪时 resume 不移动任务
    const resumedEarly = await system.resumeWaitingTasks();
    expect(resumedEarly).toBe(0);
    expect(fileMap.has(`tasks/queues/running/${task.id}.json`)).toBe(true);
    expect(fileMap.has(waitPath)).toBe(true);

    // 候选恢复 → 下界到点 → 探针验证 → ready 发布 → ATS 移动
    p.setBehavior('ok');
    await vi.advanceTimersByTimeAsync(RESET_MS - 1);
    expect(p.calls()).toBe(1);  // 下界前无探针
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    await flush();  // ready listener → resumeWaitingTasks 异步落点

    expect(p.calls()).toBe(2);  // 业务 1 + 探针 1
    expect(f.calls()).toBe(1);  // 探针只验证 primary（每探针指定一个候选）
    expect(owner.getSharedRecoveryDecision().kind).toBe('ready');
    expect(fileMap.has(`tasks/queues/pending/${task.id}.json`)).toBe(true);
    expect(fileMap.has(`tasks/queues/running/${task.id}.json`)).toBe(false);
    expect(fileMap.has(waitPath)).toBe(false);
    const resumedEvents = events.filter(e => e[0] === TASK_AUDIT_EVENTS.TASK_LLM_WAIT_RESUMED);
    expect(resumedEvents.length).toBe(1);
    // 成功后无重排：全程仍只调度一次
    expect(scheduleSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(p.calls()).toBe(2);
    await system.shutdown(1).catch(() => { /* silent: teardown */ });
    await owner.close();
  });

  it('permanent 全故障：on_change 不定时轮询；配置变化后 gate 就绪、恢复可移动', async () => {
    const stack = makeAssembledStack('auth', 'auth');
    const { owner, orchestratorConfig, p, f, fs, fileMap, system, executor } = stack;
    const task = makeValidTask();
    fileMap.set(`tasks/queues/running/${task.id}.json`, JSON.stringify(task));

    await executeSubAgentTask(task, new AbortController().signal, {
      fs,
      fsFactory: () => fs,
      auditWriter: stack.audit,
      clawDir: '/tmp/claw',
      postProcessors: new Map(),
      moveTaskToDone: vi.fn().mockResolvedValue(undefined),
      moveTaskToFailed: vi.fn().mockResolvedValue(undefined),
      taskExecutor: executor,
      deliverySink: { deliver: vi.fn() },
      onWaitScheduled: (fact) => { owner.scheduleProbe(fact.nextProbeAt); },
    });

    const waitPath = `tasks/queues/results/${task.id}/${LLM_WAIT_FILE}`;
    expect(fileMap.has(waitPath)).toBe(true);
    expect(owner.getSharedRecoveryDecision().kind).toBe('on_change');

    // 不定时轮询：任意时长无探针、gate 不就绪
    await vi.advanceTimersByTimeAsync(600_000);
    expect(p.calls()).toBe(1);
    expect(f.calls()).toBe(1);
    expect(await system.resumeWaitingTasks()).toBe(0);
    expect(fileMap.has(`tasks/queues/running/${task.id}.json`)).toBe(true);

    // 配置变化（换 key = 新候选身份）→ 重新评估 ready → 恢复路径移动
    owner.reloadConfig({
      ...orchestratorConfig,
      primary: providerConfig('primary', { apiKey: 'key-primary-rotated' }),
      fallbacks: [providerConfig('fallback', { apiKey: 'key-fallback-rotated' })],
    });
    expect(owner.getSharedRecoveryDecision().kind).toBe('ready');
    expect(await system.resumeWaitingTasks()).toBe(1);
    expect(fileMap.has(`tasks/queues/pending/${task.id}.json`)).toBe(true);
    expect(fileMap.has(waitPath)).toBe(false);
    await system.shutdown(1).catch(() => { /* silent: teardown */ });
    await owner.close();
  });
});
