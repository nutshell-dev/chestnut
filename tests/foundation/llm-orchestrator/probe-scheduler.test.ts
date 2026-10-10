/**
 * Phase 1933 Step F：进程内探针唤醒调度（scheduleProbe / subscribeReady / close 取消）。
 *
 * 用例：
 * 1. 时间下界：scheduleProbe(t+1000) 在 999ms 时不触发，到点恰触发一次 probe。
 * 2. 重复安排替换：连续 scheduleProbe(t1)/scheduleProbe(t2>t1) → 只按 t2 触发一次。
 * 3. 并发去重：probe 进行中再次 scheduleProbe（已到点）→ 不产生第二次真实 adapter
 *    调用（inflight 去重语义保持），唤醒投递由首发 continuation 承担（恰一次）。
 * 4. 失败退避：持续失败 → probe 失败后自动安排下一次（不早于 probeAllowedAtMs）；
 *    typed Retry-After 由 breaker probeAllowedAtMs 覆盖时下一次不早于其下界。
 * 5. 成功唤醒：失败一次后恢复 → probe 成功 → subscribeReady listener 恰一次。
 * 6. close 取消：scheduleProbe 后 close() → 任意时长 0 调用 0 投递；close 幂等。
 *
 * 风格：不用 vi.mock，走 createProviderAdapter DI seam（同 in-process-sharing.test.ts）；
 * 定时器用 vi.useFakeTimers + advanceTimersByTimeAsync（async timer 惯例）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLLMOrchestrator } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import type {
  LLMEvent,
  LLMEventSink,
  LLMResponse,
} from '../../../src/foundation/llm-orchestrator/index.js';
import {
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

/** breaker resetTimeoutMs：测试内统一 5s（退避下界的时间基准）。 */
const RESET_MS = 5_000;

function createMockSink() {
  const emitted: LLMEvent[] = [];
  const sink: LLMEventSink = { emit: (event: LLMEvent) => { emitted.push(event); } };
  return { sink, emitted };
}

function providerConfig(name: string): ProviderConfig {
  return {
    name,
    apiKey: `key-${name}`,
    model: `model-${name}`,
    temperature: 0,
    timeoutMs: 1_000,
    apiFormat: 'anthropic',
  };
}

type Behavior = 'fail' | 'ok' | 'hang' | 'rate_limit';

/** 可控行为的 mock adapter（同 in-process-sharing.test.ts 惯例；rate_limit 携带 typed Retry-After）。 */
function createControllableAdapter(name: string, initial: Behavior) {
  let behavior: Behavior = initial;
  let calls = 0;
  let releaseHang: (() => void) | null = null;
  const adapter: ProviderAdapter = {
    name,
    model: `model-${name}`,
    call: async () => {
      calls++;
      if (behavior === 'hang') {
        await new Promise<void>((resolve) => { releaseHang = resolve; });
        return OK_RESPONSE;
      }
      if (behavior === 'fail') throw new LLMNetworkError(name, new Error('offline'));
      if (behavior === 'rate_limit') throw new LLMRateLimitError(name, 2);  // typed Retry-After = 2s
      return OK_RESPONSE;
    },
  };
  return {
    adapter,
    setBehavior: (b: Behavior) => { behavior = b; },
    calls: () => calls,
    /** 释放挂起中的调用（使其成功返回）。 */
    release: () => { releaseHang?.(); },
  };
}

function createOwner(adapter: ProviderAdapter) {
  const { sink, emitted } = createMockSink();
  const owner = createLLMOrchestrator({
    primary: providerConfig(adapter.name),
    maxAttempts: 1,
    retryDelayMs: 0,
    events: sink,
    circuitBreaker: { failureThreshold: 1, resetTimeoutMs: RESET_MS },
    createProviderAdapter: () => adapter,
  });
  return { owner, emitted };
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

describe('Phase 1933 Step F：进程内探针唤醒调度', () => {
  it('时间下界：到点前不触发，到点恰触发一次 probe', async () => {
    const mock = createControllableAdapter('primary', 'ok');
    const { owner } = createOwner(mock.adapter);

    owner.scheduleProbe(Date.now() + 1_000);
    await vi.advanceTimersByTimeAsync(999);
    expect(mock.calls()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(mock.calls()).toBe(1);
    // 成功后无重排：再推进也不追加调用
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mock.calls()).toBe(1);
    await owner.close();
  });

  it('重复安排替换：连续 scheduleProbe(t1)/scheduleProbe(t2>t1) → 只按 t2 触发一次', async () => {
    const mock = createControllableAdapter('primary', 'ok');
    const { owner } = createOwner(mock.adapter);

    owner.scheduleProbe(Date.now() + 1_000);
    owner.scheduleProbe(Date.now() + 2_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mock.calls()).toBe(0);  // t1 已被替换
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mock.calls()).toBe(1);  // 仅 t2 触发一次
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mock.calls()).toBe(1);
    await owner.close();
  });

  it('并发去重：probe 进行中再次 scheduleProbe（已到点）→ 不产生第二次真实 adapter 调用', async () => {
    const mock = createControllableAdapter('primary', 'ok');
    const { owner } = createOwner(mock.adapter);
    const listener = vi.fn();
    owner.subscribeReady(listener);

    owner.scheduleProbe(Date.now());
    mock.setBehavior('hang');  // probe 的真实调用挂起，制造并发窗口
    await flush();
    expect(mock.calls()).toBe(1);  // 首次 probe 已发起

    // probe 进行中再次安排（已到点）：inflight 去重，不产生第二次真实调用
    owner.scheduleProbe(Date.now());
    await flush();
    expect(mock.calls()).toBe(1);

    mock.release();
    await flush();
    // 唤醒投递由首发 continuation 承担：listener 恰一次，adapter 仍 1 次真实调用
    expect(mock.calls()).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);
    await owner.close();
  });

  it('失败退避：持续失败 → probe 失败后按 probeAllowedAtMs 自动安排下一次', async () => {
    const mock = createControllableAdapter('primary', 'fail');
    const { owner } = createOwner(mock.adapter);

    owner.scheduleProbe(Date.now());
    await flush();
    expect(mock.calls()).toBe(1);  // 首次 probe 失败 → breaker open（probeAllowedAtMs = t0+RESET_MS）

    // 自动重排的下界前不触发
    await vi.advanceTimersByTimeAsync(RESET_MS - 1);
    expect(mock.calls()).toBe(1);
    // 到点触发第二次（再次失败 → 下界前移一个 RESET_MS）
    await vi.advanceTimersByTimeAsync(1);
    expect(mock.calls()).toBe(2);
    await vi.advanceTimersByTimeAsync(RESET_MS - 1);
    expect(mock.calls()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(mock.calls()).toBe(3);
    await owner.close();
  });

  it('失败退避（Retry-After）：typed Retry-After 被 breaker probeAllowedAtMs 覆盖时下一次不早于其下界', async () => {
    const mock = createControllableAdapter('primary', 'rate_limit');  // Retry-After = 2s < RESET_MS
    const { owner } = createOwner(mock.adapter);

    owner.scheduleProbe(Date.now());
    await flush();
    expect(mock.calls()).toBe(1);  // 首次 probe 失败（rate_limit → breaker open）

    // Retry-After 下界（2s）已过，但 probeAllowedAtMs（5s）更晚：取 max，不提前触发
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mock.calls()).toBe(1);
    // probeAllowedAtMs 下界前不触发
    await vi.advanceTimersByTimeAsync(RESET_MS - 2_000 - 1);
    expect(mock.calls()).toBe(1);
    // 到点（不早于 probeAllowedAtMs，自然不早于 Retry-After）触发第二次
    await vi.advanceTimersByTimeAsync(1);
    expect(mock.calls()).toBe(2);
    await owner.close();
  });

  it('成功唤醒：失败一次后恢复 → probe 成功 → subscribeReady listener 恰一次', async () => {
    const mock = createControllableAdapter('primary', 'fail');
    const { owner } = createOwner(mock.adapter);
    const listener = vi.fn();
    owner.subscribeReady(listener);

    owner.scheduleProbe(Date.now());
    await flush();
    expect(mock.calls()).toBe(1);  // 首次失败 → 自动重排到 t0+RESET_MS
    expect(listener).not.toHaveBeenCalled();

    mock.setBehavior('ok');
    await vi.advanceTimersByTimeAsync(RESET_MS - 1);
    expect(mock.calls()).toBe(1);
    expect(listener).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mock.calls()).toBe(2);  // 第二次 probe 成功
    expect(listener).toHaveBeenCalledTimes(1);

    // 探针成功按既有语义记账 breaker（不新增记账路径）→ 快照显示恢复
    expect(owner.snapshot().providers[0].breakerOpen).toBe(false);
    // 成功后无重排无重复投递
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mock.calls()).toBe(2);
    expect(listener).toHaveBeenCalledTimes(1);
    await owner.close();
  });

  it('close 取消：scheduleProbe 后 close() → 0 调用 0 投递；close 幂等；close 后 scheduleProbe 为 no-op', async () => {
    const mock = createControllableAdapter('primary', 'ok');
    const { owner } = createOwner(mock.adapter);
    const listener = vi.fn();
    owner.subscribeReady(listener);

    owner.scheduleProbe(Date.now() + 1_000);
    await owner.close();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mock.calls()).toBe(0);
    expect(listener).not.toHaveBeenCalled();

    // close 幂等
    await owner.close();
    // close 后安排为 no-op
    owner.scheduleProbe(Date.now());
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mock.calls()).toBe(0);
    expect(listener).not.toHaveBeenCalled();
  });
});
