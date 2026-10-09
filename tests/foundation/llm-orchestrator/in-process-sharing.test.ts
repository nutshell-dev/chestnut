/**
 * Phase 1933 Step B：进程内 LLMOrchestrator 共享状态与独立探针。
 *
 * 用例：
 * 1. 同进程共享：同一实例多次 call() 失败使 breaker open，经同一实例另一引用
 *    snapshot() 可见（调用方无需各自重试才发现故障）。
 * 2. 跨实例隔离：第二个独立 createLLMOrchestrator（模拟另一进程）的快照不受
 *    第一个实例故障影响。
 * 3. 局部错误不扩散：context_exceeded 类错误不进入共享故障状态（breaker 不计数）。
 * 4. 探针去重：breaker open 后并发两次 probe()，mock adapter 只收到一次真实调用。
 * 5. 探针独立：breaker open 时普通 call 被 breaker 拒，probe() 仍发起真实调用；
 *    mock 恢复成功后 probe ok:true 且随后 snapshot() 显示可用。
 *
 * 风格：不用 vi.mock，走 createProviderAdapter DI seam（同 orchestrator.test.ts /
 * recovery-zk.test.ts 惯例）。
 */
import { describe, it, expect } from 'vitest';
import { createLLMOrchestrator } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import {
  LLMAllProvidersFailedError,
  LLMCircuitBreakerOpenError,
} from '../../../src/foundation/llm-orchestrator/errors.js';
import {
  LLMContextExceededError,
  LLMNetworkError,
} from '../../../src/foundation/llm-provider/errors.js';
import type {
  LLMEvent,
  LLMEventSink,
  LLMResponse,
} from '../../../src/foundation/llm-orchestrator/index.js';
import type {
  ProviderAdapter,
  ProviderConfig,
} from '../../../src/foundation/llm-provider/index.js';

const OK_RESPONSE: LLMResponse = {
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
};

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

type Behavior = 'fail' | 'ok' | 'hang';

/** 可控行为的 mock adapter：fail=transient 网络错误 / ok=成功 / hang=挂起直至 release()。 */
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
    circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 60_000 },
    createProviderAdapter: () => adapter,
  });
  return { owner, emitted };
}

const OPTIONS = { messages: [{ role: 'user' as const, content: 'test' }] };

async function expectCallFailed(owner: { call(o: typeof OPTIONS): Promise<LLMResponse> }) {
  await expect(owner.call(OPTIONS)).rejects.toThrow();
}

describe('Phase 1933 Step B：进程内共享状态与独立探针', () => {
  it('同进程共享：call() 失败使 breaker open，经同一实例另一引用 snapshot() 可见', async () => {
    const mock = createControllableAdapter('primary', 'fail');
    const { owner } = createOwner(mock.adapter);

    await expectCallFailed(owner); // threshold=1 → 一次失败即 open

    // 另一引用（同一实例，模拟同进程另一调用方）直接可见共享故障状态。
    const anotherRef = owner;
    const snap = anotherRef.snapshot();
    expect(snap.takenAtMs).toBeGreaterThan(0);
    expect(snap.providers).toHaveLength(1);
    const entry = snap.providers[0];
    expect(entry.provider).toBe('primary');
    expect(entry.isFallback).toBe(false);
    expect(entry.breakerOpen).toBe(true);
    expect(entry.openCause).toBe('transient');
    expect(entry.consecutiveFailures).toBe(1);
    expect(typeof entry.probeAllowedAtMs).toBe('number');
  });

  it('跨实例隔离：第二个独立实例的 snapshot() 不受第一个实例故障影响', async () => {
    const failing = createControllableAdapter('primary', 'fail');
    const healthy = createControllableAdapter('primary', 'ok');
    const first = createOwner(failing.adapter);
    const second = createOwner(healthy.adapter);

    await expectCallFailed(first.owner);
    expect(first.owner.snapshot().providers[0].breakerOpen).toBe(true);

    const snap = second.owner.snapshot();
    expect(snap.providers[0].breakerOpen).toBe(false);
    expect(snap.providers[0].openCause).toBeNull();
    expect(snap.providers[0].consecutiveFailures).toBe(0);
    expect(snap.providers[0].probeAllowedAtMs).toBeUndefined();
  });

  it('局部错误不扩散：context_exceeded 失败不进入共享故障状态', async () => {
    const ctxAdapter: ProviderAdapter = {
      name: 'primary',
      model: 'model-primary',
      call: async () => {
        throw new LLMContextExceededError('primary', 400, 'prompt is too long');
      },
    };
    const { owner } = createOwner(ctxAdapter);

    // context_exceeded 走 throw-through（不 failover、不重试），调用失败。
    await expect(owner.call(OPTIONS)).rejects.toThrow();

    const entry = owner.snapshot().providers[0];
    expect(entry.breakerOpen).toBe(false);
    expect(entry.consecutiveFailures).toBe(0);
  });

  it('探针去重：并发两次 probe() 去重为同一次真实探测', async () => {
    const mock = createControllableAdapter('primary', 'fail');
    const { owner } = createOwner(mock.adapter);

    await expectCallFailed(owner); // breaker open
    expect(mock.calls()).toBe(1);

    // 切到 hang：probe 的真实调用挂起，制造并发窗口。
    mock.setBehavior('hang');
    const p1 = owner.probe();
    const p2 = owner.probe();
    // adapter.call 在首次 probe() 同步执行路径内即被调用（详见实现）。
    expect(mock.calls()).toBe(2); // 仅一次真实探测（1 次开 breaker + 1 次 probe）

    mock.release();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r1).toEqual(r2);
    expect(mock.calls()).toBe(2); // 并发期间没有第二次真实调用
  });

  it('探针独立：breaker open 时普通 call 被拒，probe() 仍真实探测并可恢复', async () => {
    const mock = createControllableAdapter('primary', 'fail');
    const { owner } = createOwner(mock.adapter);

    await expectCallFailed(owner); // breaker open
    expect(owner.snapshot().providers[0].breakerOpen).toBe(true);

    // 普通 call 直接被本地 breaker 拒（未发起真实请求）。
    const callsBefore = mock.calls();
    let breakerErr: unknown;
    try {
      await owner.call(OPTIONS);
    } catch (err) {
      breakerErr = err;
    }
    expect(breakerErr).toBeInstanceOf(LLMAllProvidersFailedError);
    const failures = (breakerErr as LLMAllProvidersFailedError).failures;
    expect(failures).toHaveLength(1);
    expect(failures[0].error).toBeInstanceOf(LLMCircuitBreakerOpenError);
    expect(mock.calls()).toBe(callsBefore); // 无真实请求

    // mock 恢复成功：probe() 不因 breaker open 拒绝，发起真实调用。
    mock.setBehavior('ok');
    const result = await owner.probe();
    expect(result.ok).toBe(true);
    expect(result.provider).toBe('primary');
    expect(result.error).toBeUndefined();
    expect(mock.calls()).toBe(callsBefore + 1);

    // 探测成功按既有语义记账 breaker（onSuccess）→ 快照显示可用。
    const entry = owner.snapshot().providers[0];
    expect(entry.breakerOpen).toBe(false);
    expect(entry.consecutiveFailures).toBe(0);
    expect(entry.openCause).toBeNull();
  });
});
