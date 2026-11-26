import { legacyTestProviderFactory } from '../helpers/llm-provider.js';
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
 *    业务等待事实只触发一次 scheduleProbe；ephemeral 显式一次性 probe 后不自主 continuation。
 * 2. 全候选 permanent：按 cooldown 执行显式一次性 probe；候选恢复后 gate 就绪 → 恢复路径可移动。
 * 3. 同名异配置候选全故障：等待事实落盘（不塌缩为任务失败），探针验证后恢复移动
 *    （Z-C1 回归：显示名不是身份，同名不同 model/key 是两个独立候选）。
 *
 * 构造惯例 mirror llm-wait-recovery.test.ts（Map 手实现 FileSystem 子集）；
 * 定时器用 vi.useFakeTimers + advanceTimersByTimeAsync。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLLMOrchestrator } from '../../src/foundation/llm-orchestrator/orchestrator.js';
import {
  LLM_RECOVERY_RETRY_INITIAL_DELAY_MS,
  LLM_RECOVERY_COOLDOWN_MS,
} from '../../src/foundation/llm-orchestrator/defaults.js';
import type {
  LLMEvent,
  LLMEventSink,
  LLMResponse,
} from '../../src/foundation/llm-orchestrator/index.js';
import { LLMAllProvidersFailedError } from '../../src/foundation/llm-orchestrator/index.js';
import { LLMAuthError, LLMNetworkError } from '../../src/foundation/llm-provider/errors.js';
import type { llmProviderCall } from '../../src/foundation/llm-provider/index.js';
type ProviderAdapter = llmProviderCall.ProviderAdapter;
import type { ProviderConnection } from '../helpers/llm-provider.js';
import { executeSubAgentTask } from '../../src/core/async-task-system/subagent-executor.js';
import { AsyncTaskSystem } from '../../src/core/async-task-system/system.js';
import { InMemoryShortIdIndex } from '../../src/core/async-task-system/short-id-index.js';
import { createStandardDeliverySink } from '../../src/core/async-task-system/index.js';
import { TASK_AUDIT_EVENTS } from '../../src/core/async-task-system/audit-events.js';
import { LLM_WAIT_FILE } from '../../src/core/async-task-system/llm-wait-state.js';
import type { LLMWaitFact } from '../../src/core/async-task-system/llm-wait-state.js';
import type { SubAgentTask } from '../../src/core/async-task-system/types.js';
import type { FileSystem } from '../../src/foundation/fs/types.js';
import type { AuditLog } from '../../src/foundation/audit/index.js';
import type { ContractSystem } from '../../src/core/contract/manager.js';
import { createSubagentExecutionRunner } from '../../src/core/subagent/index.js';
import { createExecutionInputStore } from '../../src/core/async-task-system/execution-input-store.js';
import { makeTestRegistry } from '../helpers/task-system.js';
import { testProviderConnection } from '../helpers/llm-provider.js';

const FULL_ID = '550e8400-e29b-41d4-a716-446655440000';
const ASSEMBLY_PROVIDER_TIMEOUT_MS = 1000; // 1s provider 预算，集成测试不执行真实网络调用。
const LLM_WAIT_TASK_TIMEOUT_MS = 600_000; // 10 分钟任务窗口，覆盖 owner 探针下界。
const PERMANENT_WAIT_TASK_TIMEOUT_MS = 3_600_000; // 1 小时任务窗口，覆盖 permanent cooldown。
const TEST_CIRCUIT_RESET_TIMEOUT_MS = 30_000; // 30s 测试 breaker 复位预算，对齐 transient 初值。
const POST_RECOVERY_OBSERVATION_MS = 120_000; // 恢复后观察 2 分钟，低于 5 分钟健康复检 TTL。
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

function providerConfig(
  name: string,
  extra: { model?: string; apiKey?: string } = {},
): ProviderConnection {
  return testProviderConnection({
    name,
    apiKey: `key-${name}`,
    model: `model-${name}`,
    temperature: 0,
    timeoutMs: ASSEMBLY_PROVIDER_TIMEOUT_MS,
    apiFormat: 'anthropic',
    ...extra,
  });
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
      return Promise.resolve({ kind: 'durable' as const });
    }),
    exists: vi.fn().mockImplementation((p: string) => Promise.resolve(fileMap.has(p))),
    ensureDir: vi.fn().mockResolvedValue(undefined),
    ensureDirSync: vi.fn(),
    appendSync: vi.fn(),
    writeAtomicSync: vi.fn((p: string, content: string) => {
      fileMap.set(p, content);
      return { kind: 'durable' as const };
    }),
    writeExclusive: vi.fn(async (p: string, content: string) => {
      if (fileMap.has(p)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      fileMap.set(p, content);
    }),
    linkExclusiveSync: vi.fn((from: string, to: string) => {
      const content = fileMap.get(from);
      if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      if (fileMap.has(to)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      fileMap.set(to, content);
    }),
    syncSync: vi.fn(),
    resolve: vi.fn((p: string) => p),
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
    timeoutMs: LLM_WAIT_TASK_TIMEOUT_MS,  // 等待窗口须覆盖 owner 探针下界（expiresAt 语义归 ATS）
    maxSteps: 1,
    parentClawId: 'parent',
    createdAt: new Date().toISOString(),
    executionInput: { schema_version: 1, input: { kind: 'owner-integration-input' } },
    ...overrides,
  };
}

/**
 * 生产形态装配（镜像 business-systems.ts L169-193 的接线，窄 gate 只映射 owner 结论）。
 * runSubagent stub 真实调用 owner.call()——故障分类/共享记录/探针全走真实 orchestrator。
 * sameName 为 true 时两候选同名不同 model/key（Z-C1 场景）：adapter 查找键从 name
 * 换成 model（按 name 的 Map 会塌缩——这正是被测场景）。
 */
function makeAssembledStack(primaryBehavior: Behavior, fallbackBehavior: Behavior, sameName = false) {
  const primaryName = sameName ? 'same-provider' : 'primary';
  const fallbackName = sameName ? 'same-provider' : 'fallback';
  const p = createControllableAdapter(primaryName, primaryBehavior);
  const f = createControllableAdapter(fallbackName, fallbackBehavior);
  const emitted: LLMEvent[] = [];
  const sink: LLMEventSink = { emit: (event: LLMEvent) => { emitted.push(event); } };
  const primaryConfig = sameName
    ? providerConfig(primaryName, { model: 'model-a', apiKey: 'key-a' })
    : providerConfig(primaryName);
  const fallbackConfig = sameName
    ? providerConfig(fallbackName, { model: 'model-b', apiKey: 'key-b' })
    : providerConfig(fallbackName);
  const adapters = new Map<string, ProviderAdapter>(
    sameName
      ? [[primaryConfig.model ?? '', p.adapter], [fallbackConfig.model ?? '', f.adapter]]
      : [[primaryName, p.adapter], [fallbackName, f.adapter]],
  );
  const orchestratorConfig = {
    lifecycle: { mode: 'ephemeral' as const },
    primary: primaryConfig,
    fallbacks: [fallbackConfig],
    maxAttempts: 1,
    retryDelayMs: 0,
    events: sink,
    circuitBreaker: { failureThreshold: 1, resetTimeoutMs: TEST_CIRCUIT_RESET_TIMEOUT_MS },
    providerFactory: legacyTestProviderFactory((connection: ProviderConnection) =>
        adapters.get((sameName ? connection.model : connection.providerId) ?? '')!,),
  };
  const owner = createLLMOrchestrator(orchestratorConfig);

  const { audit, events } = makeMockAudit();
  const registry = makeTestRegistry();
  const { fs, fileMap } = makeMapFs();
  const execution = createSubagentExecutionRunner({
    fs,
    driver: {
      createAttempt: () => ({
        completion: (async () => {
          await owner.call({ messages: [{ role: 'user', content: 'work' }] });
          return { content: 'ok', rawResult: { text: 'ok' } };
        })(),
        close: () => {},
      }),
      recoveryFor: error => error instanceof LLMAllProvidersFailedError ? 'shared_dependency' : 'none',
    },
  });
  const onWaitScheduled = vi.fn((fact: LLMWaitFact) => { owner.scheduleProbe(fact.nextProbeAt); });
  const system = new AsyncTaskSystem('/tmp/claw', fs, {
    shortIdIndex: new InMemoryShortIdIndex(),
    auditWriter: audit,
    execution,
    sharedRecovery: owner,
    deliverySink: createStandardDeliverySink(),
    contractManager: {
      loadPaused: vi.fn(),
      resume: vi.fn(),
      setOnNotify: vi.fn(),
    } as unknown as ContractSystem,
    registry,
    // 窄 gate：只映射 owner 结论，不解释 breaker/snapshot
    waitGate: { canResume: () => owner.getSharedRecoveryDecision().kind === 'ready' },
    onWaitScheduled,
  });
  owner.subscribeReady(() => {
    void system.resumeWaitingTasks().catch(() => { /* silent: 测试接线同生产 fail-soft */ });
  });

  return { owner, orchestratorConfig, p, f, audit, events, fs, fileMap, system, execution, emitted, onWaitScheduled };
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
  it('transient 全故障：事实 nextProbeAt 来自 owner；gate 未就绪不唤醒；探针验证后移动恰一次、业务等待只调度一次', async () => {
    const t0 = Date.now();
    const stack = makeAssembledStack('fail', 'fail');
    const { owner, p, f, events, fs, fileMap, system, execution, onWaitScheduled } = stack;
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
      execution,
      inputStore: createExecutionInputStore(fs),
      sharedRecovery: owner,
      deliverySink: { deliver: vi.fn() },
      onWaitScheduled,
    });

    // 真实 orchestrator 全程参与：两候选各一次真实业务调用
    expect(p.calls()).toBe(1);
    expect(f.calls()).toBe(1);
    // waiting 事实落盘：nextProbeAt 来自 owner 决定（transient 首次统一 30s retryAt）
    const waitPath = `tasks/queues/results/${task.id}/${LLM_WAIT_FILE}`;
    expect(fileMap.has(waitPath)).toBe(true);
    const persisted = JSON.parse(fileMap.get(waitPath)!) as Record<string, unknown>;
    expect(persisted.nextProbeAt).toBe(t0 + LLM_RECOVERY_RETRY_INITIAL_DELAY_MS);
    expect(persisted.recordedAt).toBe(t0);
    // 业务等待事实只调度一次；ephemeral failure commit 不创建自主排程。
    expect(onWaitScheduled).toHaveBeenCalledTimes(1);
    expect(onWaitScheduled).toHaveBeenCalledWith(expect.objectContaining({ nextProbeAt: t0 + LLM_RECOVERY_RETRY_INITIAL_DELAY_MS }));
    expect(owner.getSharedRecoveryDecision().kind).toBe('at');

    // gate 非恒真：owner 未就绪时 resume 不移动任务
    const resumedEarly = await system.resumeWaitingTasks();
    expect(resumedEarly).toBe(0);
    expect(fileMap.has(`tasks/queues/running/${task.id}.json`)).toBe(true);
    expect(fileMap.has(waitPath)).toBe(true);

    // 候选恢复 → 下界到点 → 探针验证 → ready 发布 → ATS 移动
    p.setBehavior('ok');
    await vi.advanceTimersByTimeAsync(LLM_RECOVERY_RETRY_INITIAL_DELAY_MS - 1);
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
    // 成功唤醒不产生新的业务等待事实；后台自主复检不属于业务等待调度。
    expect(onWaitScheduled).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POST_RECOVERY_OBSERVATION_MS);
    // ephemeral 显式一次性 probe 完成后不在 ready/at continuation 自主重排。
    expect(p.calls()).toBe(2);
    expect(f.calls()).toBe(1);
    await system.shutdown(1).catch(() => { /* silent: teardown */ });
    await owner.close();
  });

  it('Phase 2034 C：permanent 全故障按 cooldown 持续 probe，gate 就绪后恢复移动', async () => {
    const stack = makeAssembledStack('auth', 'auth');
    const { owner, p, f, fs, fileMap, system, execution, onWaitScheduled } = stack;
    const task = makeValidTask({ timeoutMs: PERMANENT_WAIT_TASK_TIMEOUT_MS });
    fileMap.set(`tasks/queues/running/${task.id}.json`, JSON.stringify(task));

    await executeSubAgentTask(task, new AbortController().signal, {
      fs,
      fsFactory: () => fs,
      auditWriter: stack.audit,
      clawDir: '/tmp/claw',
      postProcessors: new Map(),
      moveTaskToDone: vi.fn().mockResolvedValue(undefined),
      moveTaskToFailed: vi.fn().mockResolvedValue(undefined),
      execution,
      inputStore: createExecutionInputStore(fs),
      sharedRecovery: owner,
      deliverySink: { deliver: vi.fn() },
      onWaitScheduled,
    });

    const waitPath = `tasks/queues/results/${task.id}/${LLM_WAIT_FILE}`;
    expect(fileMap.has(waitPath)).toBe(true);
    expect(owner.getSharedRecoveryDecision().kind).toBe('at');

    // cooldown 下界前无探针、gate 不就绪。
    await vi.advanceTimersByTimeAsync(LLM_RECOVERY_COOLDOWN_MS - 1);
    expect(p.calls()).toBe(1);
    expect(f.calls()).toBe(1);
    expect(await system.resumeWaitingTasks()).toBe(0);
    expect(fileMap.has(`tasks/queues/running/${task.id}.json`)).toBe(true);

    // 到点真实 probe 成功 → ready 发布 → ATS 恢复移动。
    p.setBehavior('ok');
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    await flush();
    expect(p.calls()).toBe(2);
    expect(owner.getSharedRecoveryDecision().kind).toBe('ready');
    expect(fileMap.has(`tasks/queues/pending/${task.id}.json`)).toBe(true);
    expect(fileMap.has(waitPath)).toBe(false);
    await system.shutdown(1).catch(() => { /* silent: teardown */ });
    await owner.close();
  });

  it('同名异配置候选全故障：等待事实落盘（不塌缩为任务失败），探针验证后恢复移动（Z-C1 回归）', async () => {
    const stack = makeAssembledStack('fail', 'fail', true);  // 同名不同 model/key
    const { owner, p, f, fs, fileMap, system, execution, onWaitScheduled } = stack;
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
      execution,
      inputStore: createExecutionInputStore(fs),
      sharedRecovery: owner,
      deliverySink: { deliver: vi.fn() },
      onWaitScheduled,
    });

    // 真实 orchestrator 全程参与：同名两候选各一次真实业务调用
    expect(p.calls()).toBe(1);
    expect(f.calls()).toBe(1);
    // Z-C1 核心：第二候选不得因同名无故障记录而被误判 ready——owner 判 at，
    // executor 据此携带等待事实（ready 会被当成普通任务失败，waiting 事实缺失）。
    expect(owner.getSharedRecoveryDecision().kind).toBe('at');
    const waitPath = `tasks/queues/results/${task.id}/${LLM_WAIT_FILE}`;
    expect(fileMap.has(waitPath)).toBe(true);
    expect(fileMap.has(`tasks/queues/running/${task.id}.json`)).toBe(true);

    // 候选恢复 → 下界到点 → 探针验证 primary 成功 → ready 发布 → ATS 移动恰一次
    p.setBehavior('ok');
    f.setBehavior('ok');
    await vi.advanceTimersByTimeAsync(LLM_RECOVERY_RETRY_INITIAL_DELAY_MS);
    await flush();
    await flush();  // ready listener → resumeWaitingTasks 异步落点

    expect(p.calls()).toBe(2);  // 业务 1 + 探针 1
    expect(owner.getSharedRecoveryDecision().kind).toBe('ready');
    expect(fileMap.has(`tasks/queues/pending/${task.id}.json`)).toBe(true);
    expect(fileMap.has(`tasks/queues/running/${task.id}.json`)).toBe(false);
    expect(fileMap.has(waitPath)).toBe(false);
    await system.shutdown(1).catch(() => { /* silent: teardown */ });
    await owner.close();
  });
});
