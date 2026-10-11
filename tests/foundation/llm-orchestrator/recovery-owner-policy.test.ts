/**
 * Phase 1934 Step C：LLM owner 收回共享恢复判据（F-11/F-02）。
 *
 * 覆盖（候选/代次/Retry-After）：
 * 1.  两个候选 open、仅 primary 恢复 → 探针验证 primary 后 ready（fallback 仍故障不阻塞）。
 * 2.  仅 fallback 恢复 → 调度器依次验证候选（primary 探针失败 → fallback 探针成功 → ready）。
 * 3.  全失败仍有下一安排（探针持续按 owner 下界重排，decision 保持 at）。
 * 4.  永久认证失败不循环（on_change：不定时轮询；配置变化是唯一出口）。
 * 5.  context_exceeded 局部：不进共享故障状态，decision 保持 ready。
 * 6.  调用发生于 probe 前禁止业务抢探：普通成功不解除已发布 shared blocked。
 * 7.  scheduleProbe 受 owner 下界钳制：caller 传过去时间不能绕过 typed Retry-After。
 * 8.  配置变更后迟到探针不唤醒（旧配置代次结果不清新状态、不投递）。
 * 9.  close 后迟到探针不唤醒（close 取消在途探针）。
 * 10. 旧故障代次 probe 不清新状态（probe 在途期间到达的新故障使其结果失效）。
 * 11. probe 请求无工具/用户上下文；预算取目标配置合法 maxTokens 或省略。
 * 12. probe 结果保留分类和 typed Retry-After（替代只有 error 字符串）。
 * 13. 反向：两个 owner 实例隔离（进程隔离边界）。
 * 14. probe 带有界 timeout（挂起候选在配置 timeoutMs 内了结，不永久悬挂）。
 * 15. 同名异配置候选：聚合失败按身份指纹记账，不被显示名合并（Z-C1 回归）。
 * 16. 同名异配置候选：探针失败记账落到被探候选身份，不覆盖同名首候选（Z-C1 回归）。
 *
 * 风格：不用 vi.mock，走 createProviderAdapter DI seam（同 probe-scheduler.test.ts）；
 * 定时器用 vi.useFakeTimers + advanceTimersByTimeAsync。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLLMOrchestrator } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import type {
  LLMCallOptions,
  LLMEvent,
  LLMEventSink,
  LLMResponse,
} from '../../../src/foundation/llm-orchestrator/index.js';
import {
  LLMAuthError,
  LLMContextExceededError,
  LLMNetworkError,
  LLMRateLimitError,
} from '../../../src/foundation/llm-provider/errors.js';
import type {
  ProviderAdapter,
  ProviderConfig,
} from '../../../src/foundation/llm-provider/index.js';

const OK_RESPONSE: LLMResponse = {
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
};

/** breaker resetTimeoutMs：测试内统一 5s（owner 时间下界基准之一）。 */
const RESET_MS = 5_000;
/** rate_limit 用例的 typed Retry-After（秒）。 */
const RETRY_AFTER_SEC = 60;

const OPTIONS = { messages: [{ role: 'user' as const, content: 'test' }] };

function createMockSink() {
  const emitted: LLMEvent[] = [];
  const sink: LLMEventSink = { emit: (event: LLMEvent) => { emitted.push(event); } };
  return { sink, emitted };
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

type Behavior = 'ok' | 'fail' | 'hang' | 'rate_limit' | 'auth' | 'context';

/**
 * 可控行为的 mock adapter。behavior 为缺省行为；queue 非空时按次消费
 * （用于「probe 在途期间业务调用再次失败」一类的代次场景）。hang 响应 signal
 * abort（有界 timeout / close 取消），release() 使其成功返回。
 */
function createControllableAdapter(name: string, initial: Behavior) {
  let behavior: Behavior = initial;
  const queue: Behavior[] = [];
  let calls = 0;
  let releaseHang: (() => void) | null = null;
  const callOptions: LLMCallOptions[] = [];
  const adapter: ProviderAdapter = {
    name,
    model: `model-${name}`,
    call: async (options) => {
      calls++;
      callOptions.push(options as LLMCallOptions);
      const current = queue.length > 0 ? queue.shift()! : behavior;
      if (current === 'hang') {
        await new Promise<void>((resolve, reject) => {
          releaseHang = resolve;
          const signal = (options as LLMCallOptions | undefined)?.signal;
          signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
        return OK_RESPONSE;
      }
      if (current === 'fail') throw new LLMNetworkError(name, new Error('offline'));
      if (current === 'rate_limit') throw new LLMRateLimitError(name, RETRY_AFTER_SEC);
      if (current === 'auth') throw new LLMAuthError(name, 401);
      if (current === 'context') throw new LLMContextExceededError(name, 400, 'prompt too long');
      return OK_RESPONSE;
    },
  };
  return {
    adapter,
    setBehavior: (b: Behavior) => { behavior = b; },
    /** 追加按次消费的行为（优先于 behavior）。 */
    pushBehavior: (b: Behavior) => { queue.push(b); },
    calls: () => calls,
    callOptions,
    release: () => { releaseHang?.(); },
  };
}

function createOwner(
  primary: ProviderAdapter,
  fallbacks: ProviderAdapter[] = [],
  configExtra?: Partial<ProviderConfig>,
) {
  const { sink, emitted } = createMockSink();
  const adapters = new Map<string, ProviderAdapter>(
    [primary, ...fallbacks].map(a => [a.name, a]),
  );
  const config = {
    primary: providerConfig(primary.name, configExtra),
    fallbacks: fallbacks.map(f => providerConfig(f.name)),
    maxAttempts: 1,
    retryDelayMs: 0,
    events: sink,
    circuitBreaker: { failureThreshold: 1, resetTimeoutMs: RESET_MS },
    createProviderAdapter: (c: ProviderConfig) => adapters.get(c.name ?? '')!,
  };
  const owner = createLLMOrchestrator(config);
  return { owner, emitted, config };
}

/** 触发 0ms 定时器并冲刷 microtask 队列（probe 异步 continuation 落点）。 */
function flush(): Promise<void> {
  return vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Phase 1934 Step C：共享恢复判据归 LLM owner', () => {
  it('仅 primary 恢复：探针验证 primary 后 ready（fallback 仍故障不阻塞、不被探针触及）', async () => {
    const p = createControllableAdapter('primary', 'fail');
    const f = createControllableAdapter('fallback', 'fail');
    const { owner } = createOwner(p.adapter, [f.adapter]);

    await expect(owner.call(OPTIONS)).rejects.toThrow();  // 两候选 open
    const d0 = owner.getSharedRecoveryDecision();
    expect(d0.kind).toBe('at');

    const listener = vi.fn();
    owner.subscribeReady(listener);
    owner.scheduleProbe((d0 as { kind: 'at'; nextProbeAt: number }).nextProbeAt);

    p.setBehavior('ok');  // 仅 primary 恢复
    await vi.advanceTimersByTimeAsync(RESET_MS - 1);
    expect(listener).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flush();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(owner.getSharedRecoveryDecision().kind).toBe('ready');
    // 探针只触及 primary（每次指定一个候选，禁止 fallback 掩盖目标失败）
    expect(p.calls()).toBe(2);  // 业务 1 + 探针 1
    expect(f.calls()).toBe(1);  // 仅业务轮
    await owner.close();
  });

  it('仅 fallback 恢复：调度器依次验证候选（primary 探针失败 → fallback 探针成功 → ready）', async () => {
    const p = createControllableAdapter('primary', 'fail');
    const f = createControllableAdapter('fallback', 'fail');
    const { owner } = createOwner(p.adapter, [f.adapter]);

    await expect(owner.call(OPTIONS)).rejects.toThrow();
    const d0 = owner.getSharedRecoveryDecision();
    expect(d0.kind).toBe('at');

    const listener = vi.fn();
    owner.subscribeReady(listener);
    owner.scheduleProbe((d0 as { kind: 'at'; nextProbeAt: number }).nextProbeAt);

    f.setBehavior('ok');  // 仅 fallback 恢复
    await vi.advanceTimersByTimeAsync(RESET_MS);
    // fake-timer 怪癖：tick 内微任务新建的 0ms 重排定时器需再推进 ≥1ms 才触发
    // （真实环境 setTimeout(0) 正常；此处 primary 探针失败 → 立即重排验证已到点的 fallback）
    await vi.advanceTimersByTimeAsync(1);
    await flush();

    // primary 探针失败 → 重排验证已到点的 fallback → 成功 → ready
    expect(p.calls()).toBe(2);          // 业务 1 + 探针 1（失败）
    expect(f.calls()).toBe(2);          // 业务 1 + 探针 1（成功）
    expect(listener).toHaveBeenCalledTimes(1);
    expect(owner.getSharedRecoveryDecision().kind).toBe('ready');
    await owner.close();
  });

  it('全失败仍有下一安排：探针按 owner 下界持续重排，decision 保持 at', async () => {
    const p = createControllableAdapter('primary', 'fail');
    const f = createControllableAdapter('fallback', 'fail');
    const { owner } = createOwner(p.adapter, [f.adapter]);

    await expect(owner.call(OPTIONS)).rejects.toThrow();
    const d0 = owner.getSharedRecoveryDecision();
    expect(d0.kind).toBe('at');

    const listener = vi.fn();
    owner.subscribeReady(listener);
    owner.scheduleProbe((d0 as { kind: 'at'; nextProbeAt: number }).nextProbeAt);

    await vi.advanceTimersByTimeAsync(RESET_MS);   // 第一轮：primary 探针失败
    await vi.advanceTimersByTimeAsync(1);            // 0ms 重排定时器（fake-timer 怪癖需 ≥1ms）→ fallback 探针失败
    await flush();
    expect(p.calls()).toBe(2);
    expect(f.calls()).toBe(2);
    const d1 = owner.getSharedRecoveryDecision();
    expect(d1.kind).toBe('at');                    // 全失败仍有下一安排

    await vi.advanceTimersByTimeAsync(RESET_MS);   // 第二轮继续
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(p.calls()).toBe(3);
    expect(f.calls()).toBe(3);
    expect(owner.getSharedRecoveryDecision().kind).toBe('at');
    expect(listener).not.toHaveBeenCalled();
    await owner.close();
  });

  it('永久认证失败不循环：on_change 不定时轮询，配置变化是唯一出口', async () => {
    const p = createControllableAdapter('primary', 'auth');
    const f = createControllableAdapter('fallback', 'auth');
    const { owner, config } = createOwner(p.adapter, [f.adapter]);

    await expect(owner.call(OPTIONS)).rejects.toThrow();
    expect(owner.getSharedRecoveryDecision().kind).toBe('on_change');

    // permanent 等待配置变化：scheduleProbe 为 no-op，任意时长不产生探针
    owner.scheduleProbe(Date.now());
    await vi.advanceTimersByTimeAsync(600_000);
    expect(p.calls()).toBe(1);
    expect(f.calls()).toBe(1);
    expect(owner.getSharedRecoveryDecision().kind).toBe('on_change');

    // 配置变化（换 key = 新候选身份）→ 重新评估为 ready
    owner.reloadConfig({
      ...config,
      primary: providerConfig('primary', { apiKey: 'key-primary-rotated' }),
    });
    expect(owner.getSharedRecoveryDecision().kind).toBe('ready');
    await owner.close();
  });

  it('context 局部：context_exceeded 不进共享故障状态，decision 保持 ready', async () => {
    const p = createControllableAdapter('primary', 'context');
    const { owner } = createOwner(p.adapter);

    await expect(owner.call(OPTIONS)).rejects.toThrow();
    expect(owner.getSharedRecoveryDecision().kind).toBe('ready');
    const snap = owner.snapshot();
    expect(snap.providers[0].breakerOpen).toBe(false);
    expect(snap.providers[0].consecutiveFailures).toBe(0);
    await owner.close();
  });

  it('业务抢探禁止：普通成功不解除已发布 shared blocked，探针验证后才 ready', async () => {
    const t0 = Date.now();
    const p = createControllableAdapter('primary', 'rate_limit');  // typed Retry-After = 60s
    const { owner } = createOwner(p.adapter);

    await expect(owner.call(OPTIONS)).rejects.toThrow();
    const d0 = owner.getSharedRecoveryDecision();
    expect(d0.kind).toBe('at');
    // typed Retry-After 下界（60s）晚于 breaker 下界（5s）：owner 取 max
    expect((d0 as { kind: 'at'; nextProbeAt: number }).nextProbeAt).toBe(t0 + RETRY_AFTER_SEC * 1000);

    const listener = vi.fn();
    owner.subscribeReady(listener);
    owner.scheduleProbe((d0 as { kind: 'at'; nextProbeAt: number }).nextProbeAt);

    // breaker 弹回后业务调用成功——普通成功不能解除已发布 shared blocked
    p.setBehavior('ok');
    await vi.advanceTimersByTimeAsync(RESET_MS + 1_000);
    await expect(owner.call(OPTIONS)).resolves.toBe(OK_RESPONSE);
    expect(owner.getSharedRecoveryDecision().kind).toBe('at');
    expect(listener).not.toHaveBeenCalled();

    // owner 下界到点 → 探针验证成功 → 发布 ready
    await vi.advanceTimersByTimeAsync(RETRY_AFTER_SEC * 1000 - RESET_MS - 1_000);
    await flush();
    expect(p.calls()).toBe(3);  // 业务 2 + 探针 1
    expect(listener).toHaveBeenCalledTimes(1);
    expect(owner.getSharedRecoveryDecision().kind).toBe('ready');
    await owner.close();
  });

  it('scheduleProbe 受 owner 下界钳制：caller 传过去时间不能绕过 typed Retry-After', async () => {
    const p = createControllableAdapter('primary', 'rate_limit');
    const { owner } = createOwner(p.adapter);

    await expect(owner.call(OPTIONS)).rejects.toThrow();
    expect(owner.getSharedRecoveryDecision().kind).toBe('at');

    // caller 传过去时间试图立即探测 → 被钳制到 Retry-After 下界
    owner.scheduleProbe(Date.now() - 1_000);
    await vi.advanceTimersByTimeAsync(RETRY_AFTER_SEC * 1000 - 1);
    expect(p.calls()).toBe(1);  // 下界前不触发

    p.setBehavior('ok');
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(p.calls()).toBe(2);  // 到点恰触发一次
    expect(owner.getSharedRecoveryDecision().kind).toBe('ready');
    await owner.close();
  });

  it('配置变更后迟到探针不唤醒：旧配置代次结果不清新状态、不投递', async () => {
    const p = createControllableAdapter('primary', 'fail');
    const { owner, config } = createOwner(p.adapter);

    await expect(owner.call(OPTIONS)).rejects.toThrow();
    const listener = vi.fn();
    owner.subscribeReady(listener);

    p.setBehavior('hang');
    owner.scheduleProbe(Date.now());   // 被 owner 下界钳制到 breaker 弹回时刻
    await vi.advanceTimersByTimeAsync(RESET_MS);
    expect(p.calls()).toBe(2);  // 探针在途（挂起）

    // 配置代次推进（换 key）→ 旧代次探针结果失效
    owner.reloadConfig({
      ...config,
      primary: providerConfig('primary', { apiKey: 'key-primary-rotated' }),
    });
    p.setBehavior('ok');
    p.release();
    await flush();

    expect(listener).not.toHaveBeenCalled();   // 迟到探针不唤醒
    expect(p.calls()).toBe(2);                 // 无追加探测
    // 新配置代次无共享故障记录（配置变化重新评估）
    expect(owner.getSharedRecoveryDecision().kind).toBe('ready');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(p.calls()).toBe(2);
    await owner.close();
  });

  it('close 后迟到探针不唤醒：close 取消在途探针', async () => {
    const p = createControllableAdapter('primary', 'fail');
    const { owner } = createOwner(p.adapter);

    await expect(owner.call(OPTIONS)).rejects.toThrow();
    const listener = vi.fn();
    owner.subscribeReady(listener);

    p.setBehavior('hang');
    owner.scheduleProbe(Date.now());   // 被 owner 下界钳制到 breaker 弹回时刻
    await vi.advanceTimersByTimeAsync(RESET_MS);
    expect(p.calls()).toBe(2);  // 探针在途

    await owner.close();       // close 取消在途（abort signal 到达挂起的 adapter）
    await flush();
    expect(listener).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(p.calls()).toBe(2); // 无重排、无追加探测
    expect(listener).not.toHaveBeenCalled();
  });

  it('旧故障代次 probe 不清新状态：probe 在途期间到达的新故障使其结果失效', async () => {
    // 无 breaker 配置：业务调用在 probe 在途期间可产生新的真实失败
    const p = createControllableAdapter('primary', 'fail');
    const f = createControllableAdapter('fallback', 'fail');
    const { sink } = createMockSink();
    const adapters = new Map<string, ProviderAdapter>([['primary', p.adapter], ['fallback', f.adapter]]);
    const owner = createLLMOrchestrator({
      primary: providerConfig('primary'),
      fallbacks: [providerConfig('fallback')],
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
      createProviderAdapter: (c: ProviderConfig) => adapters.get(c.name ?? '')!,
    });

    await expect(owner.call(OPTIONS)).rejects.toThrow();  // 两候选记录故障（代次 N）
    expect(owner.getSharedRecoveryDecision().kind).toBe('at');

    // probe 在途（挂起于 primary）；期间业务调用再次真实失败（代次 N+1）
    p.pushBehavior('hang');
    const probePromise = owner.probe();
    await flush();
    expect(p.calls()).toBe(2);
    p.pushBehavior('fail');
    await expect(owner.call(OPTIONS)).rejects.toThrow();

    // probe 迟到成功：旧代次结果不得清新状态
    p.release();
    const result = await probePromise;
    expect(result.ok).toBe(true);
    expect(owner.getSharedRecoveryDecision().kind).toBe('at');
    await owner.close();
  });

  it('probe 请求无工具/用户上下文；预算取目标配置合法 maxTokens，缺省省略', async () => {
    const p = createControllableAdapter('primary', 'ok');
    const { owner } = createOwner(p.adapter);

    const r1 = await owner.probe();
    expect(r1.ok).toBe(true);
    const probeOptions = p.callOptions[0];
    expect(probeOptions.messages).toEqual([{ role: 'user', content: 'ping' }]);
    expect(probeOptions.tools).toBeUndefined();
    expect(probeOptions.system).toBeUndefined();
    expect(probeOptions.maxTokens).toBeUndefined();  // 配置无 maxTokens → 省略（取消硬编码 1）
    await owner.close();

    const p2 = createControllableAdapter('primary', 'ok');
    const { owner: owner2 } = createOwner(p2.adapter, [], { maxTokens: 64 });
    const r2 = await owner2.probe();
    expect(r2.ok).toBe(true);
    expect(p2.callOptions[0].maxTokens).toBe(64);    // 目标配置的合法 maxTokens
    await owner2.close();
  });

  it('probe 结果保留分类和 typed Retry-After（替代只有 error 字符串）', async () => {
    const p = createControllableAdapter('primary', 'rate_limit');
    const { owner } = createOwner(p.adapter);

    const result = await owner.probe();
    expect(result.ok).toBe(false);
    expect(result.provider).toBe('primary');
    expect(result.errorClass).toBe('rate_limit');
    expect(result.retryAfterSec).toBe(RETRY_AFTER_SEC);
    expect(typeof result.error).toBe('string');
    await owner.close();
  });

  it('反向：两个 owner 实例隔离（进程隔离边界）', async () => {
    const p1 = createControllableAdapter('primary', 'fail');
    const { owner: owner1 } = createOwner(p1.adapter);
    const p2 = createControllableAdapter('primary', 'ok');
    const { owner: owner2 } = createOwner(p2.adapter);

    await expect(owner1.call(OPTIONS)).rejects.toThrow();
    expect(owner1.getSharedRecoveryDecision().kind).toBe('at');
    expect(owner2.getSharedRecoveryDecision().kind).toBe('ready');
    await owner1.close();
    await owner2.close();
  });

  it('probe 带有界 timeout：挂起候选在配置 timeoutMs 内了结，不永久悬挂', async () => {
    const p = createControllableAdapter('primary', 'hang');
    const { owner } = createOwner(p.adapter, [], { timeoutMs: 50 });

    const probePromise = owner.probe();
    await flush();
    expect(p.calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(50);  // 有界 timeout 触发 abort
    const result = await probePromise;
    expect(result.ok).toBe(false);
    expect(result.provider).toBe('primary');
    await owner.close();
  });

  it('同名异配置候选：聚合失败按身份指纹记账，不被显示名合并（Z-C1 回归）', async () => {
    // 同名不同 model/key = 两个不同候选（身份指纹不同）；createProviderAdapter
    // 按 model 区分（按 name 的 Map 会塌缩——这正是被测场景）。
    const p = createControllableAdapter('same-provider', 'fail');
    const f = createControllableAdapter('same-provider', 'fail');
    const { sink } = createMockSink();
    const byModel = new Map<string, ProviderAdapter>([['model-a', p.adapter], ['model-b', f.adapter]]);
    const owner = createLLMOrchestrator({
      primary: providerConfig('same-provider', { model: 'model-a', apiKey: 'key-a' }),
      fallbacks: [providerConfig('same-provider', { model: 'model-b', apiKey: 'key-b' })],
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
      circuitBreaker: { failureThreshold: 1, resetTimeoutMs: RESET_MS },
      createProviderAdapter: (c: ProviderConfig) => byModel.get(c.model ?? '')!,
    });

    await expect(owner.call(OPTIONS)).rejects.toThrow();
    expect(p.calls()).toBe(1);
    expect(f.calls()).toBe(1);
    // 两候选各有独立故障记录：第二候选不得因同名被并到第一候选身份下而误判 ready
    expect(owner.getSharedRecoveryDecision().kind).toBe('at');
    await owner.close();
  });

  it('同名异配置候选：探针失败记账落到被探候选身份，不覆盖同名首候选（Z-C1 回归）', async () => {
    const p = createControllableAdapter('same-provider', 'auth');  // permanent：探针永不该触及
    const f = createControllableAdapter('same-provider', 'fail');  // transient：唯一被探候选
    const { sink } = createMockSink();
    const byModel = new Map<string, ProviderAdapter>([['model-a', p.adapter], ['model-b', f.adapter]]);
    const owner = createLLMOrchestrator({
      primary: providerConfig('same-provider', { model: 'model-a', apiKey: 'key-a' }),
      fallbacks: [providerConfig('same-provider', { model: 'model-b', apiKey: 'key-b' })],
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
      circuitBreaker: { failureThreshold: 1, resetTimeoutMs: RESET_MS },
      createProviderAdapter: (c: ProviderConfig) => byModel.get(c.model ?? '')!,
    });

    await expect(owner.call(OPTIONS)).rejects.toThrow();
    const d0 = owner.getSharedRecoveryDecision();
    // primary permanent + fallback transient → 仅 fallback 时间阻断
    expect(d0.kind).toBe('at');

    owner.scheduleProbe((d0 as { kind: 'at'; nextProbeAt: number }).nextProbeAt);
    await vi.advanceTimersByTimeAsync(RESET_MS);   // 第一轮：fallback 探针失败
    await vi.advanceTimersByTimeAsync(1);           // 0ms 重排定时器（fake-timer 怪癖需 ≥1ms）
    await flush();
    expect(f.calls()).toBe(2);  // 业务 1 + 探针 1
    expect(p.calls()).toBe(1);  // 探针从未触及 permanent primary

    // 第二轮到点：fallback 仍故障 → 再次探 fallback。
    // 若探针失败按显示名记账，会覆盖 primary 的 permanent 记录为 transient，
    // 下一轮探针目标将错选 primary（p.calls 增长）——本断言即对此设防。
    await vi.advanceTimersByTimeAsync(RESET_MS);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(f.calls()).toBe(3);  // 业务 1 + 探针 2
    expect(p.calls()).toBe(1);  // primary 记录保持 permanent，探针目标不错位
    await owner.close();
  });
});
