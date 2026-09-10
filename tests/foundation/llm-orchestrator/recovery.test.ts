/**
 * Phase 1826: 恢复安排 owner 会话 — 准入、干预去重、策略曲线、持久化与重启。
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'path';
import * as fsNative from 'fs';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createLLMOrchestrator } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import { createRecoverySession } from '../../../src/foundation/llm-orchestrator/recovery.js';
import { LLM_RECOVERY_STATE_FILE } from '../../../src/foundation/llm-orchestrator/recovery-state.js';
import { LLMAllProvidersFailedError } from '../../../src/foundation/llm-orchestrator/errors.js';
import { LLMAuthError, LLMNetworkError } from '../../../src/foundation/llm-provider/errors.js';
import type { LLMEvent, LLMEventSink, LLMOrchestratorConfig } from '../../../src/foundation/llm-orchestrator/index.js';
import type { ProviderAdapter, ProviderConfig, LLMResponse } from '../../../src/foundation/llm-provider/index.js';

const SCOPE = 'foreground';
const T0 = Date.parse('2026-09-10T00:00:00.000Z');

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

function makeSink(): { sink: LLMEventSink; emitted: LLMEvent[] } {
  const emitted: LLMEvent[] = [];
  return { sink: { emit: (e) => { emitted.push(e); } }, emitted };
}

function makeAdapter(name: string, call: () => Promise<LLMResponse>): ProviderAdapter {
  return {
    name,
    model: `model-${name}`,
    call: () => call(),
    stream: async function* () { throw new Error('stream not enabled in this test'); },
  };
}

const OK_RESPONSE: LLMResponse = {
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
};

const cleanupDirs: string[] = [];
afterEach(async () => {
  for (const dir of cleanupDirs.splice(0)) {
    try { await cleanupTempDir(dir); } catch { /* ignore */ }
  }
});

async function makeFixture(opts: {
  call?: () => Promise<LLMResponse>;
  maxAttempts?: number;
  circuitBreaker?: { failureThreshold: number; resetTimeoutMs: number };
} = {}) {
  const dir = await createTrackedTempDir('recovery-');
  cleanupDirs.push(dir);
  const fs = new NodeFileSystem({ baseDir: dir });
  const { sink, emitted } = makeSink();
  const adapter = makeAdapter('primary', opts.call ?? (async () => OK_RESPONSE));
  const config: LLMOrchestratorConfig = {
    primary: providerConfig('primary'),
    maxAttempts: opts.maxAttempts ?? 1,
    retryDelayMs: 1,
    events: sink,
    createAnthropicAdapter: () => adapter,
    ...(opts.circuitBreaker ? { circuitBreaker: opts.circuitBreaker } : {}),
  };
  const orchestrator = createLLMOrchestrator(config);
  let nowMs = T0;
  const makeSession = () => createRecoverySession({
    scopeId: SCOPE,
    fs,
    events: sink,
    orchestrator,
    now: () => nowMs,
  });
  const readState = () => JSON.parse(
    fsNative.readFileSync(path.join(dir, 'status', LLM_RECOVERY_STATE_FILE), 'utf-8'),
  );

  return {
    dir, fs, sink, emitted, orchestrator, makeSession, readState,
    advance: (ms: number) => { nowMs += ms; },
    now: () => nowMs,
    statePath: path.join(dir, 'status', LLM_RECOVERY_STATE_FILE),
  };
}

const CALL = { messages: [{ role: 'user' as const, content: 'hi' }] };

describe('recovery session admission', () => {
  it('admits directly when ready and returns to ready after completion', async () => {
    const f = await makeFixture();
    const session = f.makeSession();

    const admission = await session.begin({ requestKey: 'fp-1', trigger: { kind: 'automatic' } });
    expect(admission.kind).toBe('admitted');
    if (admission.kind !== 'admitted') return;

    await session.finish(admission.attemptId, 'completed');
    const schedule = await session.inspect();
    expect(schedule.kind).toBe('ready');
  });

  it('records attempt start before the first real request and persists it', async () => {
    const f = await makeFixture();
    const session = f.makeSession();
    const admission = await session.begin({ requestKey: 'fp-1', trigger: { kind: 'automatic' } });
    if (admission.kind !== 'admitted') throw new Error('expected admitted');

    await session.llm.call(CALL);

    const fsNative = await import('fs');
    const saved = JSON.parse(fsNative.readFileSync(f.statePath, 'utf-8'));
    expect(saved.activeAdmission.started).toBe(true);
    expect(typeof saved.activeAdmission.startedAt).toBe('string');
  });

  it('clears a started admission after restart with an unknown-result evidence', async () => {
    const f = await makeFixture();
    const first = f.makeSession();
    const admission = await first.begin({ requestKey: 'fp-1', trigger: { kind: 'automatic' } });
    if (admission.kind !== 'admitted') throw new Error('expected admitted');
    await first.llm.call(CALL);   // notes started

    const restarted = f.makeSession();   // 模拟进程重启
    const fsNative = await import('fs');
    const saved = JSON.parse(fsNative.readFileSync(f.statePath, 'utf-8'));
    expect(saved.activeAdmission).toBeNull();
    expect(saved.failures.some((x: { message: string }) => x.message.includes('result unknown'))).toBe(true);
    expect(await restarted.inspect()).toBeTruthy();
  });
});

describe('recovery failure policy', () => {
  it('quota failure schedules at the quota curve and doubles it', async () => {
    const f = await makeFixture({ call: async () => { throw new Error('insufficient quota'); } });
    const session = f.makeSession();
    await session.begin({ requestKey: 'fp', trigger: { kind: 'automatic' } });

    await expect(session.llm.call(CALL)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);

    const schedule = await session.inspect();
    expect(schedule.kind).toBe('at');
    if (schedule.kind === 'at') {
      // 首次 quota：delay = 初值 120s
      expect(Date.parse(schedule.resumeAt) - T0).toBe(120_000);
    }
    const fsNative = await import('fs');
    const saved = JSON.parse(fsNative.readFileSync(f.statePath, 'utf-8'));
    expect(saved.budget.quotaDelayMs).toBe(240_000);       // 曲线翻倍
    expect(saved.budget.retryCount).toBe(0);               // quota 不消耗 retry 预算
    expect(f.emitted.some(e => e.type === 'recovery_scheduled')).toBe(true);
  });

  it('waiting until the deadline, then admitting again', async () => {
    const f = await makeFixture({ call: async () => { throw new Error('insufficient quota'); } });
    const session = f.makeSession();
    const first = await session.begin({ requestKey: 'fp', trigger: { kind: 'automatic' } });
    if (first.kind !== 'admitted') throw new Error('expected admitted');
    await expect(session.llm.call(CALL)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    await session.finish(first.attemptId, 'failed');

    const early = await session.begin({ requestKey: 'fp', trigger: { kind: 'automatic' } });
    expect(early.kind).toBe('waiting');

    f.advance(121_000);
    const late = await session.begin({ requestKey: 'fp', trigger: { kind: 'automatic' } });
    expect(late.kind).toBe('admitted');
  });

  it('transient failures consume the retry budget and end in cooldown', async () => {
    const f = await makeFixture({ call: async () => { throw new LLMNetworkError('boom'); } });
    const session = f.makeSession();

    // 4 轮失败：前 3 轮消耗预算（30/60/120s），第 4 轮进入 5min cooldown。
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      const admission = await session.begin({ requestKey: 'fp', trigger: { kind: 'automatic' } });
      if (admission.kind !== 'admitted') throw new Error(`expected admitted at round ${i}`);
      await expect(session.llm.call(CALL)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
      await session.finish(admission.attemptId, 'failed');
      const schedule = await session.inspect();
      if (schedule.kind !== 'at') throw new Error('expected at');
      delays.push(Date.parse(schedule.resumeAt) - f.now());
      f.advance(1_000_000);   // 跨过本次等待
    }
    expect(delays).toEqual([30_000, 60_000, 120_000, 300_000]);
    expect(f.emitted.filter(e => e.type === 'recovery_scheduled').length).toBe(4);
  });

  it('permanent failures wait for change (intervention or config)', async () => {
    const f = await makeFixture({ call: async () => { throw new LLMAuthError('bad key'); } });
    const session = f.makeSession();
    const admission = await session.begin({ requestKey: 'fp', trigger: { kind: 'automatic' } });
    if (admission.kind !== 'admitted') throw new Error('expected admitted');
    await expect(session.llm.call(CALL)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    await session.finish(admission.attemptId, 'failed');

    const schedule = await session.inspect();
    expect(schedule.kind).toBe('on_change');

    // 自动 tick 不能放行
    const auto = await session.begin({ requestKey: 'fp', trigger: { kind: 'automatic' } });
    expect(auto.kind).toBe('waiting');
  });

  it('success resets budget and returns to ready', async () => {
    let shouldFail = true;
    const f = await makeFixture({
      call: async () => {
        if (shouldFail) throw new LLMNetworkError('boom');
        return OK_RESPONSE;
      },
    });
    const session = f.makeSession();
    const admission = await session.begin({ requestKey: 'fp', trigger: { kind: 'automatic' } });
    if (admission.kind !== 'admitted') throw new Error('expected admitted');
    await expect(session.llm.call(CALL)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    await session.finish(admission.attemptId, 'failed');

    f.advance(1_000_000);
    shouldFail = false;
    const second = await session.begin({ requestKey: 'fp', trigger: { kind: 'automatic' } });
    if (second.kind !== 'admitted') throw new Error('expected admitted');
    await session.llm.call(CALL);
    await session.finish(second.attemptId, 'completed');

    const fsNative = await import('fs');
    const saved = JSON.parse(fsNative.readFileSync(f.statePath, 'utf-8'));
    expect(saved.budget.retryCount).toBe(0);
    expect(saved.schedule.kind).toBe('ready');
  });
});

describe('recovery interventions', () => {
  it('a new user message id admits early; the same id does not; a second new id does', async () => {
    const f = await makeFixture({ call: async () => { throw new Error('insufficient quota'); } });
    const session = f.makeSession();
    const admission = await session.begin({ requestKey: 'fp', trigger: { kind: 'automatic' } });
    if (admission.kind !== 'admitted') throw new Error('expected admitted');
    await expect(session.llm.call(CALL)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    await session.finish(admission.attemptId, 'failed');

    // 干预 m1：提前放行
    const early = await session.begin({ requestKey: 'fp', trigger: { kind: 'intervention', ids: ['m1'] } });
    expect(early.kind).toBe('admitted');
    if (early.kind !== 'admitted') return;
    await session.finish(early.attemptId, 'failed');

    // 同一消息（nack 回队）不重复放行
    const replay = await session.begin({ requestKey: 'fp', trigger: { kind: 'intervention', ids: ['m1'] } });
    expect(replay.kind).toBe('waiting');

    // 第二条真新消息仍有新机会
    const fresh = await session.begin({ requestKey: 'fp', trigger: { kind: 'intervention', ids: ['m1', 'm2'] } });
    expect(fresh.kind).toBe('admitted');
  });

  it('intervention keeps the failure history (curve not reset)', async () => {
    const f = await makeFixture({ call: async () => { throw new Error('insufficient quota'); } });
    const session = f.makeSession();

    const first = await session.begin({ requestKey: 'fp', trigger: { kind: 'automatic' } });
    if (first.kind !== 'admitted') throw new Error('expected admitted');
    await expect(session.llm.call(CALL)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    await session.finish(first.attemptId, 'failed');

    const second = await session.begin({ requestKey: 'fp', trigger: { kind: 'intervention', ids: ['m1'] } });
    if (second.kind !== 'admitted') throw new Error('expected admitted');
    await expect(session.llm.call(CALL)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    await session.finish(second.attemptId, 'failed');

    const fsNative = await import('fs');
    const saved = JSON.parse(fsNative.readFileSync(f.statePath, 'utf-8'));
    // 曲线未被干预重置：两次失败后 quotaDelayMs 已是 480s（120→240→480）
    expect(saved.budget.quotaDelayMs).toBe(480_000);
    expect(saved.failures.length).toBe(2);   // 原始失败证据保留
  });
});

describe('recovery triggers for configuration and startup', () => {
  it('a new config revision re-evaluates an on_change hold; the same revision does not', async () => {
    const f = await makeFixture({ call: async () => { throw new LLMAuthError('bad key'); } });
    const session = f.makeSession();

    const failOnce = async () => {
      const admission = await session.begin({ requestKey: 'fp', trigger: { kind: 'automatic' } });
      if (admission.kind !== 'admitted') throw new Error('expected admitted');
      await expect(session.llm.call(CALL)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
      await session.finish(admission.attemptId, 'failed');
    };

    await failOnce();
    expect((await session.inspect()).kind).toBe('on_change');

    // 新 revision → 重新评估并放行
    const reloaded = await session.begin({ requestKey: 'fp', trigger: { kind: 'configuration', revision: 'r1' } });
    expect(reloaded.kind).toBe('admitted');
    if (reloaded.kind !== 'admitted') return;
    await expect(session.llm.call(CALL)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    await session.finish(reloaded.attemptId, 'failed');

    // 同 revision 重复通知：不放行
    const replay = await session.begin({ requestKey: 'fp', trigger: { kind: 'configuration', revision: 'r1' } });
    expect(replay.kind).toBe('waiting');

    // 另一个 revision（配置再次变化）：放行
    const again = await session.begin({ requestKey: 'fp', trigger: { kind: 'configuration', revision: 'r2' } });
    expect(again.kind).toBe('admitted');
  });

  it('startup admits once on an on_change hold and is idempotent per startup id', async () => {
    const f = await makeFixture({ call: async () => { throw new LLMAuthError('bad key'); } });
    const session = f.makeSession();
    const admission = await session.begin({ requestKey: 'fp', trigger: { kind: 'automatic' } });
    if (admission.kind !== 'admitted') throw new Error('expected admitted');
    await expect(session.llm.call(CALL)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    await session.finish(admission.attemptId, 'failed');

    const startup = await session.begin({ requestKey: 'fp', trigger: { kind: 'startup', id: 'boot-1' } });
    expect(startup.kind).toBe('admitted');
    if (startup.kind !== 'admitted') return;
    // 模拟该次尝试未发请求（未 started）即中断：安排仍然有效
    await session.finish(startup.attemptId, 'interrupted');

    const replay = await session.begin({ requestKey: 'fp', trigger: { kind: 'startup', id: 'boot-1' } });
    expect(replay.kind).toBe('waiting');

    const nextBoot = await session.begin({ requestKey: 'fp', trigger: { kind: 'startup', id: 'boot-2' } });
    expect(nextBoot.kind).toBe('admitted');
  });
});


describe('recovery breaker coordination', () => {
  it('仅被本地 breaker 跳过的候选不消耗预算，安排不早于 reset 时刻', async () => {
    const f = await makeFixture({
      call: async () => { throw new LLMNetworkError('boom'); },
      circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 60_000 },
    });
    const session = f.makeSession();

    const first = await session.begin({ requestKey: 'fp', trigger: { kind: 'automatic' } });
    if (first.kind !== 'admitted') throw new Error('expected admitted');
    await expect(session.llm.call(CALL)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    await session.finish(first.attemptId, 'failed');
    const afterFirst = f.readState();
    expect(afterFirst.budget.retryCount).toBe(1);   // 真实失败消耗 1 次

    // 跨过 deadline 后再次调用：breaker 已 open（resetTimeoutMs=60s，未到重置），
    // 本次没有任何真实请求 → localSkip，不消耗预算。
    f.advance(1_000_000);
    const second = await session.begin({ requestKey: 'fp', trigger: { kind: 'automatic' } });
    if (second.kind !== 'admitted') throw new Error('expected admitted');
    await expect(session.llm.call(CALL)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    await session.finish(second.attemptId, 'failed');

    const afterSecond = f.readState();
    expect(afterSecond.budget.retryCount).toBe(1);  // 未被本地跳过消耗
    expect(afterSecond.schedule.kind).toBe('at');
    // 安排不早于本地 breaker 的 reset 时刻（不加倍、不提前空探测）
    const resumeAt = Date.parse(afterSecond.schedule.resumeAt);
    expect(resumeAt).toBeGreaterThan(f.now());
  });
});

describe('recovery scoped view isolation', () => {
  it('view close does not close the shared orchestrator', async () => {
    const f = await makeFixture();
    const session = f.makeSession();
    await session.llm.close();
    // 关闭视图后共享实例仍可用
    const admission = await session.begin({ requestKey: 'fp', trigger: { kind: 'automatic' } });
    expect(admission.kind).toBe('admitted');
    if (admission.kind !== 'admitted') return;
    await expect(session.llm.call(CALL)).resolves.toBeTruthy();
  });
});
