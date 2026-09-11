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
import type { FileSystem } from '../../../src/foundation/fs/index.js';

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

interface FixtureOpts {
  call?: () => Promise<LLMResponse>;
  maxAttempts?: number;
  circuitBreaker?: { failureThreshold: number; resetTimeoutMs: number };
  /** 包装注入文件系统（可在保存路径注入失败）。 */
  wrapFs?: (fs: FileSystem) => FileSystem;
  /** 包装事件出口（可模拟保存成功、发布前崩溃）。 */
  wrapSink?: (sink: LLMEventSink) => LLMEventSink;
}

async function makeFixture(opts: FixtureOpts = {}) {
  const dir = await createTrackedTempDir('recovery-');
  cleanupDirs.push(dir);
  const baseFs = new NodeFileSystem({ baseDir: dir });
  const fs = opts.wrapFs ? opts.wrapFs(baseFs) : baseFs;
  const { sink: baseSink, emitted } = makeSink();
  const sink = opts.wrapSink ? opts.wrapSink(baseSink) : baseSink;
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

    const admission = await session.begin({ requestKey: 'fp-1', facts: { interventionIds: [] } });
    expect(admission.kind).toBe('admitted');
    if (admission.kind !== 'admitted') return;

    await session.finish(admission.attemptId, 'completed');
    const schedule = await session.inspect();
    expect(schedule.kind).toBe('ready');
  });

  it('records attempt start before the first real request and persists it', async () => {
    const f = await makeFixture();
    const session = f.makeSession();
    const admission = await session.begin({ requestKey: 'fp-1', facts: { interventionIds: [] } });
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
    const admission = await first.begin({ requestKey: 'fp-1', facts: { interventionIds: [] } });
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
    await session.begin({ requestKey: 'fp', facts: { interventionIds: [] } });

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
    const first = await session.begin({ requestKey: 'fp', facts: { interventionIds: [] } });
    if (first.kind !== 'admitted') throw new Error('expected admitted');
    await expect(session.llm.call(CALL)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    await session.finish(first.attemptId, 'failed');

    const early = await session.begin({ requestKey: 'fp', facts: { interventionIds: [] } });
    expect(early.kind).toBe('waiting');

    f.advance(121_000);
    const late = await session.begin({ requestKey: 'fp', facts: { interventionIds: [] } });
    expect(late.kind).toBe('admitted');
  });

  it('transient failures consume the retry budget and end in cooldown', async () => {
    const f = await makeFixture({ call: async () => { throw new LLMNetworkError('boom'); } });
    const session = f.makeSession();

    // 4 轮失败：前 3 轮消耗预算（30/60/120s），第 4 轮进入 5min cooldown。
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      const admission = await session.begin({ requestKey: 'fp', facts: { interventionIds: [] } });
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
    const admission = await session.begin({ requestKey: 'fp', facts: { interventionIds: [] } });
    if (admission.kind !== 'admitted') throw new Error('expected admitted');
    await expect(session.llm.call(CALL)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    await session.finish(admission.attemptId, 'failed');

    const schedule = await session.inspect();
    expect(schedule.kind).toBe('on_change');

    // 自动 tick 不能放行
    const auto = await session.begin({ requestKey: 'fp', facts: { interventionIds: [] } });
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
    const admission = await session.begin({ requestKey: 'fp', facts: { interventionIds: [] } });
    if (admission.kind !== 'admitted') throw new Error('expected admitted');
    await expect(session.llm.call(CALL)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    await session.finish(admission.attemptId, 'failed');

    f.advance(1_000_000);
    shouldFail = false;
    const second = await session.begin({ requestKey: 'fp', facts: { interventionIds: [] } });
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
    const admission = await session.begin({ requestKey: 'fp', facts: { interventionIds: [] } });
    if (admission.kind !== 'admitted') throw new Error('expected admitted');
    await expect(session.llm.call(CALL)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    await session.finish(admission.attemptId, 'failed');

    // 干预 m1：提前放行
    const early = await session.begin({ requestKey: 'fp', facts: { interventionIds: ['m1'] } });
    expect(early.kind).toBe('admitted');
    if (early.kind !== 'admitted') return;
    await session.finish(early.attemptId, 'failed');

    // 同一消息（nack 回队）不重复放行
    const replay = await session.begin({ requestKey: 'fp', facts: { interventionIds: ['m1'] } });
    expect(replay.kind).toBe('waiting');

    // 第二条真新消息仍有新机会
    const fresh = await session.begin({ requestKey: 'fp', facts: { interventionIds: ['m1', 'm2'] } });
    expect(fresh.kind).toBe('admitted');
  });

  it('intervention keeps the failure history (curve not reset)', async () => {
    const f = await makeFixture({ call: async () => { throw new Error('insufficient quota'); } });
    const session = f.makeSession();

    const first = await session.begin({ requestKey: 'fp', facts: { interventionIds: [] } });
    if (first.kind !== 'admitted') throw new Error('expected admitted');
    await expect(session.llm.call(CALL)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    await session.finish(first.attemptId, 'failed');

    const second = await session.begin({ requestKey: 'fp', facts: { interventionIds: ['m1'] } });
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
      const admission = await session.begin({ requestKey: 'fp', facts: { interventionIds: [] } });
      if (admission.kind !== 'admitted') throw new Error('expected admitted');
      await expect(session.llm.call(CALL)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
      await session.finish(admission.attemptId, 'failed');
    };

    await failOnce();
    expect((await session.inspect()).kind).toBe('on_change');

    // 新 revision → 重新评估并放行
    const reloaded = await session.begin({ requestKey: 'fp', facts: { interventionIds: [], configurationRevision: 'r1' } });
    expect(reloaded.kind).toBe('admitted');
    if (reloaded.kind !== 'admitted') return;
    await expect(session.llm.call(CALL)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    await session.finish(reloaded.attemptId, 'failed');

    // 同 revision 重复通知：不放行
    const replay = await session.begin({ requestKey: 'fp', facts: { interventionIds: [], configurationRevision: 'r1' } });
    expect(replay.kind).toBe('waiting');

    // 另一个 revision（配置再次变化）：放行
    const again = await session.begin({ requestKey: 'fp', facts: { interventionIds: [], configurationRevision: 'r2' } });
    expect(again.kind).toBe('admitted');
  });

  it('startup admits once on an on_change hold and is idempotent per startup id', async () => {
    const f = await makeFixture({ call: async () => { throw new LLMAuthError('bad key'); } });
    const session = f.makeSession();
    const admission = await session.begin({ requestKey: 'fp', facts: { interventionIds: [] } });
    if (admission.kind !== 'admitted') throw new Error('expected admitted');
    await expect(session.llm.call(CALL)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    await session.finish(admission.attemptId, 'failed');

    const startup = await session.begin({ requestKey: 'fp', facts: { interventionIds: [], startupId: 'boot-1' } });
    expect(startup.kind).toBe('admitted');
    if (startup.kind !== 'admitted') return;
    // 模拟该次尝试未发请求（未 started）即中断：安排仍然有效
    await session.finish(startup.attemptId, 'interrupted');

    const replay = await session.begin({ requestKey: 'fp', facts: { interventionIds: [], startupId: 'boot-1' } });
    expect(replay.kind).toBe('waiting');

    const nextBoot = await session.begin({ requestKey: 'fp', facts: { interventionIds: [], startupId: 'boot-2' } });
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

    const first = await session.begin({ requestKey: 'fp', facts: { interventionIds: [] } });
    if (first.kind !== 'admitted') throw new Error('expected admitted');
    await expect(session.llm.call(CALL)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    await session.finish(first.attemptId, 'failed');
    const afterFirst = f.readState();
    expect(afterFirst.budget.retryCount).toBe(1);   // 真实失败消耗 1 次

    // 跨过 deadline 后再次调用：breaker 已 open（resetTimeoutMs=60s，未到重置），
    // 本次没有任何真实请求 → localSkip，不消耗预算。
    f.advance(1_000_000);
    const second = await session.begin({ requestKey: 'fp', facts: { interventionIds: [] } });
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
    const admission = await session.begin({ requestKey: 'fp', facts: { interventionIds: [] } });
    expect(admission.kind).toBe('admitted');
    if (admission.kind !== 'admitted') return;
    await expect(session.llm.call(CALL)).resolves.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Phase 1827: 恢复事实合并与单次准入（组合矩阵 §4.4）
// ---------------------------------------------------------------------------

function wrapWriteFailure(fs: FileSystem, state: { failing: boolean }): FileSystem {
  return new Proxy(fs, {
    get(target, prop, receiver) {
      if (prop === 'writeAtomicSync') {
        return (...args: unknown[]) => {
          if (state.failing) throw new Error('injected write failure');
          return (target as unknown as { writeAtomicSync(...a: unknown[]): unknown })
            .writeAtomicSync(...args);
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const facts = (partial: {
  interventionIds?: string[];
  configurationRevision?: string;
  startupId?: string;
}) => ({ interventionIds: [], ...partial });

const acceptedEvents = (f: { emitted: LLMEvent[] }) =>
  f.emitted.filter(e => e.type === 'recovery_facts_accepted');

describe('recovery facts combination (phase 1827 §4.4)', () => {
  /** 先消耗一次真实失败，把安排推进到 at/on_change；返回该次准入的 attemptId。 */
  async function failOnce(
    f: Awaited<ReturnType<typeof makeFixture>>,
    session: ReturnType<Awaited<ReturnType<typeof makeFixture>>['makeSession']>,
  ): Promise<string> {
    const admission = await session.begin({ requestKey: 'fp', facts: facts({}) });
    if (admission.kind !== 'admitted') throw new Error('expected admitted');
    await expect(session.llm.call(CALL)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    await session.finish(admission.attemptId, 'failed');
    return admission.attemptId;
  }

  it('on_change / 旧用户 + 新配置：配置被接受转 ready、旧用户去重、只多一次准入', async () => {
    const f = await makeFixture({ call: async () => { throw new LLMAuthError('bad key'); } });
    const session = f.makeSession();
    const first = await session.begin({ requestKey: 'fp', facts: facts({ interventionIds: ['m-old'] }) });
    if (first.kind !== 'admitted') throw new Error('expected admitted');
    await expect(session.llm.call(CALL)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    await session.finish(first.attemptId, 'failed');
    expect((await session.inspect()).kind).toBe('on_change');
    const acceptedBefore = acceptedEvents(f).length;
    const admittedBefore = f.emitted.filter(e => e.type === 'recovery_attempt_admitted').length;

    // Z5：旧用户 id 已接受（回队仍在 pending）+ 配置修订同时到达 → 配置不被遮蔽。
    const second = await session.begin({
      requestKey: 'fp',
      facts: facts({ interventionIds: ['m-old'], configurationRevision: 'r-fixed' }),
    });
    expect(second.kind).toBe('admitted');
    const saved = f.readState();
    expect(saved.acceptedConfigRevisions).toContain('r-fixed');
    expect(saved.acceptedInterventions).toEqual(['m-old']);        // 旧 id 不重复记账
    const batch = saved.acceptedFactBatches.at(-1);
    expect(batch).toMatchObject({ configurationRevision: 'r-fixed', interventionIds: [] });
    expect(batch.attemptId).toBe(second.kind === 'admitted' ? second.attemptId : '');
    expect(saved.activeAdmission.configurationRevision).toBe('r-fixed');
    expect(acceptedEvents(f).length).toBe(acceptedBefore + 1);      // 只多一个接受事件
    expect(f.emitted.filter(e => e.type === 'recovery_attempt_admitted').length)
      .toBe(admittedBefore + 1);
  });

  it('on_change / 新用户 + 新配置 + 新启动：三者全部接受，只产生一个 admission', async () => {
    const f = await makeFixture({ call: async () => { throw new LLMAuthError('bad key'); } });
    const session = f.makeSession();
    await failOnce(f, session);
    const admittedBefore = f.emitted.filter(e => e.type === 'recovery_attempt_admitted').length;

    const admission = await session.begin({
      requestKey: 'fp',
      facts: facts({ interventionIds: ['m-new'], configurationRevision: 'r2', startupId: 'boot-1' }),
    });
    expect(admission.kind).toBe('admitted');
    const saved = f.readState();
    expect(saved.acceptedInterventions).toContain('m-new');
    expect(saved.acceptedConfigRevisions).toContain('r2');
    expect(saved.lastStartupProbeId).toBe('boot-1');
    const batch = saved.acceptedFactBatches.at(-1);
    expect(batch).toMatchObject({
      interventionIds: ['m-new'],
      configurationRevision: 'r2',
      startupId: 'boot-1',
    });
    expect(saved.activeAdmission.interventionIds).toEqual(['m-new']);
    expect(saved.activeAdmission.configurationRevision).toBe('r2');
    expect(saved.activeAdmission.startupId).toBe('boot-1');
    expect(f.emitted.filter(e => e.type === 'recovery_attempt_admitted').length)
      .toBe(admittedBefore + 1);
  });

  it('at 未到期 / 旧用户 + 新配置：配置被接受但 deadline 不变，不产生准入', async () => {
    const f = await makeFixture({ call: async () => { throw new Error('insufficient quota'); } });
    const session = f.makeSession();
    const first = await session.begin({ requestKey: 'fp', facts: facts({ interventionIds: ['m-old'] }) });
    if (first.kind !== 'admitted') throw new Error('expected admitted');
    await expect(session.llm.call(CALL)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    await session.finish(first.attemptId, 'failed');
    const before = await session.inspect();
    expect(before.kind).toBe('at');
    const admittedBefore = f.emitted.filter(e => e.type === 'recovery_attempt_admitted').length;

    const waiting = await session.begin({
      requestKey: 'fp',
      facts: facts({ interventionIds: ['m-old'], configurationRevision: 'r-quota-fix' }),
    });
    expect(waiting.kind).toBe('waiting');
    if (waiting.kind !== 'waiting') return;
    expect(waiting.factsAccepted).toBe(true);
    const after = await session.inspect();
    expect(after.kind).toBe('at');
    if (after.kind === 'at' && before.kind === 'at') {
      expect(after.resumeAt).toBe(before.resumeAt);      // 配置单独到达不缩短 at
    }
    expect(f.readState().acceptedConfigRevisions).toContain('r-quota-fix');
    expect(f.emitted.filter(e => e.type === 'recovery_attempt_admitted').length).toBe(admittedBefore);
  });

  it('at 未到期 / 新用户 + 新配置：一次提前准入，失败历史保留', async () => {
    const f = await makeFixture({ call: async () => { throw new Error('insufficient quota'); } });
    const session = f.makeSession();
    await failOnce(f, session);
    const quotaBefore = f.readState().budget.quotaDelayMs;

    const admission = await session.begin({
      requestKey: 'fp',
      facts: facts({ interventionIds: ['m-new'], configurationRevision: 'r1' }),
    });
    expect(admission.kind).toBe('admitted');
    const saved = f.readState();
    expect(saved.failures.length).toBe(1);               // 失败历史未被干预/配置清零
    expect(saved.budget.quotaDelayMs).toBe(quotaBefore); // 预算曲线不因接受事实重置
    expect(saved.activeAdmission.allowBreakerProbe).toBe(true);   // 新用户资格
  });

  it('at 到期 / 重复事实：一次自动准入，不伪造新的接受事件', async () => {
    const f = await makeFixture({ call: async () => { throw new Error('insufficient quota'); } });
    const session = f.makeSession();
    const first = await session.begin({ requestKey: 'fp', facts: facts({ interventionIds: ['m1'] }) });
    if (first.kind !== 'admitted') throw new Error('expected admitted');
    await expect(session.llm.call(CALL)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    await session.finish(first.attemptId, 'failed');
    const acceptedBefore = acceptedEvents(f).length;

    f.advance(121_000);
    const due = await session.begin({ requestKey: 'fp', facts: facts({ interventionIds: ['m1'] }) });
    expect(due.kind).toBe('admitted');
    expect(acceptedEvents(f).length).toBe(acceptedBefore);   // 重复事实无新事件
    expect(f.readState().acceptedInterventions).toEqual(['m1']);
  });

  it('on_change / 全部重复事实：幂等 waiting，不产生准入与接受事件', async () => {
    const f = await makeFixture({ call: async () => { throw new LLMAuthError('bad key'); } });
    const session = f.makeSession();
    const first = await session.begin({
      requestKey: 'fp',
      facts: facts({ interventionIds: ['m1'], configurationRevision: 'r1', startupId: 'boot-1' }),
    });
    if (first.kind !== 'admitted') throw new Error('expected admitted');
    await expect(session.llm.call(CALL)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    await session.finish(first.attemptId, 'failed');
    const acceptedBefore = acceptedEvents(f).length;
    const admittedBefore = f.emitted.filter(e => e.type === 'recovery_attempt_admitted').length;

    const replay = await session.begin({
      requestKey: 'fp',
      facts: facts({ interventionIds: ['m1'], configurationRevision: 'r1', startupId: 'boot-1' }),
    });
    expect(replay.kind).toBe('waiting');
    if (replay.kind !== 'waiting') return;
    expect(replay.factsAccepted).toBe(true);
    expect(replay.schedule.kind).toBe('on_change');
    expect(acceptedEvents(f).length).toBe(acceptedBefore);
    expect(f.emitted.filter(e => e.type === 'recovery_attempt_admitted').length).toBe(admittedBefore);
  });

  it('ready / 新启动：正常准入且 token 已记账——稍后失败不能重用它获得启动资格', async () => {
    const f = await makeFixture({ call: async () => { throw new LLMAuthError('bad key'); } });
    const session = f.makeSession();
    const first = await session.begin({ requestKey: 'fp', facts: facts({ startupId: 'boot-1' }) });
    expect(first.kind).toBe('admitted');
    expect(f.readState().lastStartupProbeId).toBe('boot-1');   // ready 入口也记为本 boot 已处理
    if (first.kind !== 'admitted') return;
    await expect(session.llm.call(CALL)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    await session.finish(first.attemptId, 'failed');
    expect((await session.inspect()).kind).toBe('on_change');

    const replay = await session.begin({ requestKey: 'fp', facts: facts({ startupId: 'boot-1' }) });
    expect(replay.kind).toBe('waiting');                        // 同一 token 不再授予启动资格

    const nextBoot = await session.begin({ requestKey: 'fp', facts: facts({ startupId: 'boot-2' }) });
    expect(nextBoot.kind).toBe('admitted');
  });

  it('活跃准入 / 任意事实：全部不接受（waiting/false），finish 后重送可接受', async () => {
    const f = await makeFixture();
    const session = f.makeSession();
    const active = await session.begin({ requestKey: 'fp', facts: facts({}) });
    expect(active.kind).toBe('admitted');
    if (active.kind !== 'admitted') return;
    const acceptedBefore = acceptedEvents(f).length;

    const blocked = await session.begin({
      requestKey: 'fp',
      facts: facts({ interventionIds: ['m1'], configurationRevision: 'r1', startupId: 'boot-1' }),
    });
    expect(blocked.kind).toBe('waiting');
    if (blocked.kind !== 'waiting') return;
    expect(blocked.factsAccepted).toBe(false);
    const saved = f.readState();                                // 忙碌时不修改任何去重记录
    expect(saved.acceptedInterventions).not.toContain('m1');
    expect(saved.acceptedConfigRevisions).not.toContain('r1');
    expect(saved.lastStartupProbeId).toBeUndefined();
    expect(acceptedEvents(f).length).toBe(acceptedBefore);

    await session.finish(active.attemptId, 'interrupted');
    const retry = await session.begin({
      requestKey: 'fp',
      facts: facts({ interventionIds: ['m1'], configurationRevision: 'r1', startupId: 'boot-1' }),
    });
    expect(retry.kind).toBe('admitted');
    const after = f.readState();
    expect(after.acceptedInterventions).toContain('m1');
    expect(after.acceptedConfigRevisions).toContain('r1');
    expect(after.lastStartupProbeId).toBe('boot-1');
  });

  it('恢复未开始准入 / 新事实：合入原准入，原 attemptId 一次执行', async () => {
    const f = await makeFixture({ call: async () => { throw new LLMAuthError('bad key'); } });
    const session = f.makeSession();
    await failOnce(f, session);
    const granted = await session.begin({
      requestKey: 'fp',
      facts: facts({ interventionIds: ['new-user'] }),
    });
    expect(granted.kind).toBe('admitted');
    if (granted.kind !== 'admitted') return;

    const restored = f.makeSession();   // 重启：未开始的准入被恢复
    const merged = await restored.begin({
      requestKey: 'fp',
      facts: facts({ interventionIds: ['new-user', 'm2'], configurationRevision: 'r2' }),
    });
    expect(merged.kind).toBe('admitted');
    if (merged.kind !== 'admitted') return;
    expect(merged.attemptId).toBe(granted.attemptId);           // 不建第二个 attempt

    const saved = f.readState();
    expect(saved.activeAdmission.resumedFromRestart).toBeUndefined();
    expect(saved.activeAdmission.interventionIds).toEqual(['new-user', 'm2']);
    expect(saved.activeAdmission.configurationRevision).toBe('r2');
    expect(saved.acceptedFactBatches.at(-1)).toMatchObject({
      interventionIds: ['m2'],
      configurationRevision: 'r2',
    });
    expect(saved.acceptedFactBatches.at(-1).attemptId).toBe(granted.attemptId);
  });

  it('原子保存失败：抛错、内存与来源不前移；写入恢复后重送仍能接受', async () => {
    const writeState = { failing: false };
    const f = await makeFixture({
      call: async () => { throw new Error('insufficient quota'); },
      wrapFs: (fs) => wrapWriteFailure(fs, writeState),
    });
    const session = f.makeSession();
    await failOnce(f, session);
    const acceptedBefore = acceptedEvents(f).length;

    writeState.failing = true;
    await expect(
      session.begin({ requestKey: 'fp', facts: facts({ interventionIds: ['m1'] }) }),
    ).rejects.toThrow();
    expect(f.readState().acceptedInterventions).not.toContain('m1');   // 磁盘未前移
    expect(acceptedEvents(f).length).toBe(acceptedBefore);             // 无接受/准入事件

    writeState.failing = false;
    const retry = await session.begin({ requestKey: 'fp', facts: facts({ interventionIds: ['m1'] }) });
    expect(retry.kind).toBe('admitted');                               // 重送仍接受
    expect(f.readState().acceptedInterventions).toContain('m1');
  });

  it('保存成功后、事件发布前崩溃：磁盘仍可重建全部接受事实与准入', async () => {
    const f = await makeFixture({
      wrapSink: (sink) => ({
        emit: (event) => {
          if (event.type === 'recovery_facts_accepted') throw new Error('crash before publish');
          sink.emit(event);
        },
      }),
    });
    const session = f.makeSession();
    await expect(session.begin({
      requestKey: 'fp',
      facts: facts({ interventionIds: ['m1'], configurationRevision: 'r1', startupId: 'boot-1' }),
    })).rejects.toThrow();

    const saved = f.readState();                                       // 保存已成功
    expect(saved.acceptedInterventions).toContain('m1');
    expect(saved.acceptedConfigRevisions).toContain('r1');
    expect(saved.lastStartupProbeId).toBe('boot-1');
    expect(saved.acceptedFactBatches).toHaveLength(1);
    expect(saved.acceptedFactBatches[0]).toMatchObject({
      interventionIds: ['m1'],
      configurationRevision: 'r1',
      startupId: 'boot-1',
    });
    expect(typeof saved.activeAdmission.attemptId).toBe('string');     // 准入也已落盘

    // 重启后重送同一批：完整接受事实可读、幂等不重复接受。
    const restored = f.makeSession();
    const replay = await restored.begin({
      requestKey: 'fp',
      facts: facts({ interventionIds: ['m1'], configurationRevision: 'r1', startupId: 'boot-1' }),
    });
    expect(replay.kind).toBe('admitted');
    expect(f.readState().acceptedFactBatches).toHaveLength(1);
  });

  it('配置先置 ready 不恢复正常预算：probeOnly 取入口安排', async () => {
    const f = await makeFixture({ call: async () => { throw new LLMAuthError('bad key'); } });
    const session = f.makeSession();
    await failOnce(f, session);

    const admission = await session.begin({
      requestKey: 'fp',
      facts: facts({ configurationRevision: 'r-fixed' }),
    });
    expect(admission.kind).toBe('admitted');
    expect(session.attemptContext().probeOnly).toBe(true);            // 入口 on_change → 恢复 probe
    expect(session.attemptContext().allowBreakerProbe).toBe(false);   // 配置不授予 breaker 资格
  });
});
