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
import {
  createInitialRecoveryState,
  LLM_RECOVERY_STATE_FILE,
  saveRecoveryState,
  type LLMRecoveryProviderFact,
} from '../../../src/foundation/llm-orchestrator/recovery-state.js';
import { legacyProviderIdentity } from '../../../src/foundation/llm-orchestrator/provider-identity.js';
import { LLMAllProvidersFailedError, LLMRecoveryWaitRequiredError } from '../../../src/foundation/llm-orchestrator/errors.js';
import { LLMAuthError, LLMNetworkError, LLMQuotaError, LLMRateLimitError } from '../../../src/foundation/llm-provider/errors.js';
import type { LLMEvent, LLMEventSink, LLMOrchestratorConfig } from '../../../src/foundation/llm-orchestrator/index.js';
import type { ProviderAdapter, ProviderConfig, LLMResponse } from '../../../src/foundation/llm-provider/index.js';
import type { FileSystem } from '../../../src/foundation/fs/index.js';
import type { AtomicWriteResult } from '../../../src/foundation/fs/types.js';

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

function makeAdapter(
  name: string,
  call: () => Promise<LLMResponse>,
  onStream?: () => void,
): ProviderAdapter {
  return {
    name,
    model: `model-${name}`,
    call: () => call(),
    stream: async function* () {
      onStream?.();
      throw new Error('stream not enabled in this test');
    },
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
  onStream?: () => void;
  fallbacks?: Array<{ name: string; call?: () => Promise<LLMResponse> }>;
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
  const adapter = makeAdapter('primary', opts.call ?? (async () => OK_RESPONSE), opts.onStream);
  const fallbackAdapters = (opts.fallbacks ?? []).map(fallback =>
    makeAdapter(fallback.name, fallback.call ?? (async () => OK_RESPONSE)));
  const adapters = new Map([
    ['primary', adapter],
    ...fallbackAdapters.map(fallback => [fallback.name, fallback] as const),
  ]);
  const config: LLMOrchestratorConfig = {
    primary: providerConfig('primary'),
    fallbacks: fallbackAdapters.map(fallback => providerConfig(fallback.name)),
    maxAttempts: opts.maxAttempts ?? 1,
    retryDelayMs: 1,
    events: sink,
    createProviderAdapter: (provider) => adapters.get(provider.name) ?? adapter,
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
    reload: (primary: ProviderConfig) => orchestrator.reloadConfig({ ...config, primary }),
    statePath: path.join(dir, 'status', LLM_RECOVERY_STATE_FILE),
  };
}

const CALL = { messages: [{ role: 'user' as const, content: 'hi' }] };

describe('recovery session admission', () => {
  it('persists a known legacy v2 import without modifying the original file', async () => {
    const f = await makeFixture();
    const legacyPath = path.join(f.dir, 'status', 'llm-retry-state.json');
    fsNative.mkdirSync(path.dirname(legacyPath), { recursive: true });
    const legacyRaw = JSON.stringify({
      schema_version: 2,
      llmRetryCount: 3,
      llmRetryDelayMs: 45_000,
      llmRetryPending: false,
      waiting: null,
    });
    fsNative.writeFileSync(legacyPath, legacyRaw);

    f.makeSession();
    expect(f.readState()).toMatchObject({
      revision: 1,
      schedule: { kind: 'ready', revision: 1 },
      budget: { retryCount: 3, retryDelayMs: 45_000, quotaDelayMs: 120_000 },
      importedSources: ['status/llm-retry-state.json#schema_version=2'],
    });
    expect(fsNative.readFileSync(legacyPath, 'utf8')).toBe(legacyRaw);
  });

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

    await f.orchestrator.callWithinRecovery(CALL, session);

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
    await f.orchestrator.callWithinRecovery(CALL, first);   // notes started

    const restarted = f.makeSession();   // 模拟进程重启
    const fsNative = await import('fs');
    const saved = JSON.parse(fsNative.readFileSync(f.statePath, 'utf-8'));
    expect(saved.activeAdmission).toBeNull();
    expect(saved.failures.some((x: { message: string }) => x.message.includes('result unknown'))).toBe(true);
    expect(saved.failures.find((x: { message: string }) => x.message.includes('result unknown')).attemptId)
      .toBe(admission.attemptId);
    expect(await restarted.inspect()).toBeTruthy();
  });
});

describe('recovery failure policy', () => {
  it('quota failure schedules at the quota curve and doubles it', async () => {
    const f = await makeFixture({ call: async () => { throw new LLMQuotaError('p', 'insufficient quota'); } });
    const session = f.makeSession();
    await session.begin({ requestKey: 'fp', facts: { interventionIds: [] } });

    await expect(f.orchestrator.callWithinRecovery(CALL, session)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);

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
    const f = await makeFixture({ call: async () => { throw new LLMQuotaError('p', 'insufficient quota'); } });
    const session = f.makeSession();
    const first = await session.begin({ requestKey: 'fp', facts: { interventionIds: [] } });
    if (first.kind !== 'admitted') throw new Error('expected admitted');
    await expect(f.orchestrator.callWithinRecovery(CALL, session)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
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
      await expect(f.orchestrator.callWithinRecovery(CALL, session)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
      await session.finish(admission.attemptId, 'failed');
      const schedule = await session.inspect();
      if (schedule.kind !== 'at') throw new Error('expected at');
      delays.push(Date.parse(schedule.resumeAt) - f.now());
      f.advance(1_000_000);   // 跨过本次等待
    }
    expect(delays).toEqual([30_000, 60_000, 120_000, 300_000]);
    expect(f.emitted.filter(e => e.type === 'recovery_scheduled').length).toBe(4);
  });

  it('Phase 2034 C: permanent failures continuously schedule cooldown attempts', async () => {
    const f = await makeFixture({ call: async () => { throw new LLMAuthError('bad key'); } });
    const session = f.makeSession();

    for (let round = 0; round < 2; round++) {
      const admission = await session.begin({ requestKey: 'fp', facts: { interventionIds: [] } });
      if (admission.kind !== 'admitted') throw new Error(`expected admitted at round ${round}`);
      await expect(f.orchestrator.callWithinRecovery(CALL, session)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
      await session.finish(admission.attemptId, 'failed');

      const schedule = await session.inspect();
      expect(schedule.kind).toBe('at');
      if (schedule.kind === 'at') {
        expect(Date.parse(schedule.resumeAt) - f.now()).toBe(300_000);
      }
      const early = await session.begin({ requestKey: 'fp', facts: { interventionIds: [] } });
      expect(early.kind).toBe('waiting');
      f.advance(300_000);
    }
  });

  it('Phase 2034 C: 无 Retry-After 的 rate_limit 第 10/11 次仍按末档 at', async () => {
    const f = await makeFixture({
      call: async () => { throw new LLMRateLimitError('primary'); },
    });
    const session = f.makeSession();
    const delays: number[] = [];

    for (let i = 0; i < 11; i++) {
      const admission = await session.begin({ requestKey: 'fp', facts: { interventionIds: [] } });
      if (admission.kind !== 'admitted') throw new Error(`expected admitted at round ${i}`);
      await expect(f.orchestrator.callWithinRecovery(CALL, session)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
      await session.finish(admission.attemptId, 'failed');

      const schedule = await session.inspect();
      if (schedule.kind !== 'at') throw new Error(`expected at at round ${i}`);
      delays.push(Date.parse(schedule.resumeAt) - f.now());
      f.advance(1_000_000);
    }

    expect(delays).toEqual([
      30_000, 60_000, 120_000, 300_000, 600_000, 600_000,
      600_000, 600_000, 600_000, 600_000, 600_000,
    ]);
    const saved = f.readState();
    expect(saved.providers[0].rateLimitFailures).toBe(11);
    expect(saved.providers[0].rateLimitBlocked).toBeUndefined();
    expect(saved.providers[0].rateLimitBlockedAt).toBeUndefined();
  });

  it('Phase 1955 B: 服务端 Retry-After 仍是权威时刻，不被客户端退避截短', async () => {
    const f = await makeFixture({
      call: async () => { throw new LLMRateLimitError('primary', 900); },
    });
    const session = f.makeSession();
    const admission = await session.begin({ requestKey: 'fp', facts: { interventionIds: [] } });
    if (admission.kind !== 'admitted') throw new Error('expected admitted');
    await expect(f.orchestrator.callWithinRecovery(CALL, session)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    await session.finish(admission.attemptId, 'failed');

    const schedule = await session.inspect();
    expect(schedule.kind).toBe('at');
    if (schedule.kind === 'at') {
      expect(Date.parse(schedule.resumeAt) - T0).toBe(900_000);
    }
    const saved = f.readState();
    expect(saved.providers[0].rateLimitFailures).toBeUndefined();
    expect(saved.providers[0].rateLimitBlocked).toBeUndefined();
  });

  it('Phase 1955 B: 成功调用清零 rate-limit 计数与 blocked 事实', async () => {
    let shouldFail = true;
    const f = await makeFixture({
      call: async () => {
        if (shouldFail) throw new LLMRateLimitError('primary');
        return OK_RESPONSE;
      },
    });
    const session = f.makeSession();

    for (let i = 0; i < 10; i++) {
      const admission = await session.begin({ requestKey: 'fp', facts: { interventionIds: [] } });
      if (admission.kind !== 'admitted') throw new Error(`expected admitted at round ${i}`);
      await expect(f.orchestrator.callWithinRecovery(CALL, session)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
      await session.finish(admission.attemptId, 'failed');
      const schedule = await session.inspect();
      if (schedule.kind === 'at') f.advance(1_000_000);
    }

    shouldFail = false;
    const retry = await session.begin({
      requestKey: 'fp',
      facts: { interventionIds: ['user-msg-1'] },
    });
    if (retry.kind !== 'admitted') throw new Error('expected admitted by intervention');
    await f.orchestrator.callWithinRecovery(CALL, session);
    await session.finish(retry.attemptId, 'completed');

    const saved = f.readState();
    expect(saved.providers[0].rateLimitFailures).toBeUndefined();
    expect(saved.providers[0].rateLimitBlocked).toBeUndefined();
    expect(saved.schedule.kind).toBe('ready');
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
    await expect(f.orchestrator.callWithinRecovery(CALL, session)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    await session.finish(admission.attemptId, 'failed');

    f.advance(1_000_000);
    shouldFail = false;
    const second = await session.begin({ requestKey: 'fp', facts: { interventionIds: [] } });
    if (second.kind !== 'admitted') throw new Error('expected admitted');
    await f.orchestrator.callWithinRecovery(CALL, session);
    await session.finish(second.attemptId, 'completed');

    const fsNative = await import('fs');
    const saved = JSON.parse(fsNative.readFileSync(f.statePath, 'utf-8'));
    expect(saved.budget.retryCount).toBe(0);
    expect(saved.schedule.kind).toBe('ready');
  });
});

describe('recovery interventions', () => {
  it('a new user message id admits early; the same id does not; a second new id does', async () => {
    const f = await makeFixture({ call: async () => { throw new LLMQuotaError('p', 'insufficient quota'); } });
    const session = f.makeSession();
    const admission = await session.begin({ requestKey: 'fp', facts: { interventionIds: [] } });
    if (admission.kind !== 'admitted') throw new Error('expected admitted');
    await expect(f.orchestrator.callWithinRecovery(CALL, session)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
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
    const f = await makeFixture({ call: async () => { throw new LLMQuotaError('p', 'insufficient quota'); } });
    const session = f.makeSession();

    const first = await session.begin({ requestKey: 'fp', facts: { interventionIds: [] } });
    if (first.kind !== 'admitted') throw new Error('expected admitted');
    await expect(f.orchestrator.callWithinRecovery(CALL, session)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    await session.finish(first.attemptId, 'failed');

    const second = await session.begin({ requestKey: 'fp', facts: { interventionIds: ['m1'] } });
    if (second.kind !== 'admitted') throw new Error('expected admitted');
    await expect(f.orchestrator.callWithinRecovery(CALL, session)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
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
    let session = f.makeSession();

    const failOnce = async () => {
      const admission = await session.begin({ requestKey: 'fp', facts: { interventionIds: [] } });
      if (admission.kind !== 'admitted') throw new Error('expected admitted');
      await expect(f.orchestrator.callWithinRecovery(CALL, session)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
      await session.finish(admission.attemptId, 'failed');
    };

    await failOnce();
    expect((await session.inspect()).kind).toBe('at');
    const legacy = f.readState();
    legacy.schedule = { kind: 'on_change', revision: legacy.revision };
    saveRecoveryState(f.fs, legacy);
    session = f.makeSession();

    // 旧 on_change：新身份 + 新 revision → 重新评估并放行
    f.reload(providerConfig('primary-fixed'));
    const reloaded = await session.begin({ requestKey: 'fp', facts: { interventionIds: [], configurationRevision: 'r1' } });
    expect(reloaded.kind).toBe('admitted');
    if (reloaded.kind !== 'admitted') return;
    await expect(f.orchestrator.callWithinRecovery(CALL, session)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    await session.finish(reloaded.attemptId, 'failed');

    // 同 revision 重复通知且 at 未到期：不放行
    const replay = await session.begin({ requestKey: 'fp', facts: { interventionIds: [], configurationRevision: 'r1' } });
    expect(replay.kind).toBe('waiting');

    // 另一个身份 + revision 不缩短 at；到期后自动放行。
    f.advance(300_000);
    f.reload(providerConfig('primary-fixed-again'));
    const again = await session.begin({ requestKey: 'fp', facts: { interventionIds: [], configurationRevision: 'r2' } });
    expect(again.kind).toBe('admitted');
  });

  it('startup admits once on a legacy on_change hold and later startups do not shorten at', async () => {
    const f = await makeFixture({ call: async () => { throw new LLMAuthError('bad key'); } });
    let session = f.makeSession();
    const admission = await session.begin({ requestKey: 'fp', facts: { interventionIds: [] } });
    if (admission.kind !== 'admitted') throw new Error('expected admitted');
    await expect(f.orchestrator.callWithinRecovery(CALL, session)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    await session.finish(admission.attemptId, 'failed');
    const legacy = f.readState();
    legacy.schedule = { kind: 'on_change', revision: legacy.revision };
    saveRecoveryState(f.fs, legacy);
    session = f.makeSession();

    const startup = await session.begin({ requestKey: 'fp', facts: { interventionIds: [], startupId: 'boot-1' } });
    expect(startup.kind).toBe('admitted');
    if (startup.kind !== 'admitted') return;
    // 模拟该次尝试未发请求（未 started）即中断：安排仍然有效
    await session.finish(startup.attemptId, 'interrupted');

    const replay = await session.begin({ requestKey: 'fp', facts: { interventionIds: [], startupId: 'boot-1' } });
    expect(replay.kind).toBe('waiting');

    const nextBoot = await session.begin({ requestKey: 'fp', facts: { interventionIds: [], startupId: 'boot-2' } });
    expect(nextBoot.kind).toBe('waiting');
    f.advance(300_000);
    const due = await session.begin({ requestKey: 'fp', facts: { interventionIds: [], startupId: 'boot-2' } });
    expect(due.kind).toBe('admitted');
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
    await expect(f.orchestrator.callWithinRecovery(CALL, session)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    await session.finish(first.attemptId, 'failed');
    const afterFirst = f.readState();
    expect(afterFirst.budget.retryCount).toBe(1);   // 真实失败消耗 1 次

    // 跨过 deadline 后再次调用：breaker 已 open（resetTimeoutMs=60s，未到重置），
    // 本次没有任何真实请求 → localSkip，不消耗预算。
    f.advance(1_000_000);
    const second = await session.begin({ requestKey: 'fp', facts: { interventionIds: [] } });
    if (second.kind !== 'admitted') throw new Error('expected admitted');
    await expect(f.orchestrator.callWithinRecovery(CALL, session)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
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
    await expect(f.orchestrator.callWithinRecovery(CALL, session)).resolves.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Phase 1827: 恢复事实合并与单次准入（组合矩阵 §4.4）
// ---------------------------------------------------------------------------

function wrapWriteDurability(fs: FileSystem, state: { result: AtomicWriteResult }): FileSystem {
  return new Proxy(fs, {
    get(target, prop, receiver) {
      if (prop === 'writeAtomicSync') {
        return (...args: unknown[]) => {
          (target as unknown as { writeAtomicSync(...a: unknown[]): unknown }).writeAtomicSync(...args);
          return state.result;
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

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
    await expect(f.orchestrator.callWithinRecovery(CALL, session)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    await session.finish(admission.attemptId, 'failed');
    return admission.attemptId;
  }

  it('on_change / 旧用户 + 新配置：配置被接受转 ready、旧用户去重、只多一次准入', async () => {
    const f = await makeFixture({ call: async () => { throw new LLMAuthError('bad key'); } });
    let session = f.makeSession();
    const first = await session.begin({ requestKey: 'fp', facts: facts({ interventionIds: ['m-old'] }) });
    if (first.kind !== 'admitted') throw new Error('expected admitted');
    await expect(f.orchestrator.callWithinRecovery(CALL, session)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    await session.finish(first.attemptId, 'failed');
    expect((await session.inspect()).kind).toBe('at');
    const legacy = f.readState();
    legacy.schedule = { kind: 'on_change', revision: legacy.revision };
    saveRecoveryState(f.fs, legacy);
    session = f.makeSession();
    const acceptedBefore = acceptedEvents(f).length;
    const admittedBefore = f.emitted.filter(e => e.type === 'recovery_attempt_admitted').length;

    // Z5：旧用户 id 已接受（回队仍在 pending）+ 新身份配置修订同时到达 → 配置不被遮蔽。
    f.reload(providerConfig('primary-fixed'));
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

  it('at / 新用户 + 新配置 + 新启动：三者全部接受，只产生一个 admission', async () => {
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
    const f = await makeFixture({ call: async () => { throw new LLMQuotaError('p', 'insufficient quota'); } });
    const session = f.makeSession();
    const first = await session.begin({ requestKey: 'fp', facts: facts({ interventionIds: ['m-old'] }) });
    if (first.kind !== 'admitted') throw new Error('expected admitted');
    await expect(f.orchestrator.callWithinRecovery(CALL, session)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
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
    const f = await makeFixture({ call: async () => { throw new LLMQuotaError('p', 'insufficient quota'); } });
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
    const f = await makeFixture({ call: async () => { throw new LLMQuotaError('p', 'insufficient quota'); } });
    const session = f.makeSession();
    const first = await session.begin({ requestKey: 'fp', facts: facts({ interventionIds: ['m1'] }) });
    if (first.kind !== 'admitted') throw new Error('expected admitted');
    await expect(f.orchestrator.callWithinRecovery(CALL, session)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    await session.finish(first.attemptId, 'failed');
    const acceptedBefore = acceptedEvents(f).length;

    f.advance(121_000);
    const due = await session.begin({ requestKey: 'fp', facts: facts({ interventionIds: ['m1'] }) });
    expect(due.kind).toBe('admitted');
    expect(acceptedEvents(f).length).toBe(acceptedBefore);   // 重复事实无新事件
    expect(f.readState().acceptedInterventions).toEqual(['m1']);
  });

  it('at / 全部重复事实：幂等 waiting，不产生准入与接受事件', async () => {
    const f = await makeFixture({ call: async () => { throw new LLMAuthError('bad key'); } });
    const session = f.makeSession();
    const first = await session.begin({
      requestKey: 'fp',
      facts: facts({ interventionIds: ['m1'], configurationRevision: 'r1', startupId: 'boot-1' }),
    });
    if (first.kind !== 'admitted') throw new Error('expected admitted');
    await expect(f.orchestrator.callWithinRecovery(CALL, session)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
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
    expect(replay.schedule.kind).toBe('at');
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
    await expect(f.orchestrator.callWithinRecovery(CALL, session)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    await session.finish(first.attemptId, 'failed');
    expect((await session.inspect()).kind).toBe('at');

    const replay = await session.begin({ requestKey: 'fp', facts: facts({ startupId: 'boot-1' }) });
    expect(replay.kind).toBe('waiting');                        // 同一 token 不再授予启动资格

    const nextBoot = await session.begin({ requestKey: 'fp', facts: facts({ startupId: 'boot-2' }) });
    expect(nextBoot.kind).toBe('waiting');
    f.advance(300_000);
    const due = await session.begin({ requestKey: 'fp', facts: facts({ startupId: 'boot-2' }) });
    expect(due.kind).toBe('admitted');
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
      requestKey: 'fp-current-input',
      facts: facts({ interventionIds: ['new-user', 'm2'], configurationRevision: 'r2' }),
    });
    expect(merged.kind).toBe('admitted');
    if (merged.kind !== 'admitted') return;
    expect(merged.attemptId).toBe(granted.attemptId);           // 不建第二个 attempt

    const saved = f.readState();
    expect(saved.activeAdmission.requestKey).toBe('fp-current-input');
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
      call: async () => { throw new LLMQuotaError('p', 'insufficient quota'); },
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
    let session = f.makeSession();
    await failOnce(f, session);
    const legacy = f.readState();
    legacy.schedule = { kind: 'on_change', revision: legacy.revision };
    saveRecoveryState(f.fs, legacy);
    session = f.makeSession();

    f.reload(providerConfig('primary-fixed'));
    const admission = await session.begin({
      requestKey: 'fp',
      facts: facts({ configurationRevision: 'r-fixed' }),
    });
    expect(admission.kind).toBe('admitted');
    expect(session.attemptContext().probeOnly).toBe(true);            // 入口 on_change → 恢复 probe
    expect(session.attemptContext().allowBreakerProbe).toBe(false);   // 配置不授予 breaker 资格
  });
});


// ---------------------------------------------------------------------------
// Phase 1958 Step C: durable commit 屏障 —— noteSuccess/noteFailure 先 durable
// commit 再替换内存；写失败时内存与磁盘均保持旧状态，事件 revision 只来自已提交状态。
// ---------------------------------------------------------------------------

describe('recovery durable commit barrier (Phase 1958 Step C)', () => {
  it('noteSuccess 写盘失败：内存不越过磁盘、不发布 recovery_ready；写入恢复后可重提交', async () => {
    const writeState = { failing: false };
    let shouldFail = true;
    // 在 adapter 内才打开写失败开关：noteAttemptStarted 的 commit 发生在真实请求之前，
    // 目标失败点仅为 noteSuccess 的 durable commit。
    let armWriteFailure = false;
    const f = await makeFixture({
      call: async () => {
        if (armWriteFailure) writeState.failing = true;
        if (shouldFail) throw new LLMNetworkError('boom');
        return OK_RESPONSE;
      },
      wrapFs: (fs) => wrapWriteFailure(fs, writeState),
    });
    const session = f.makeSession();
    // 制造非 clean 状态：一次真实 transient 失败（schedule=at、含失败证据）
    const a1 = await session.begin({ requestKey: 'fp', facts: facts({}) });
    if (a1.kind !== 'admitted') throw new Error('expected admitted');
    await expect(f.orchestrator.callWithinRecovery(CALL, session)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    await session.finish(a1.attemptId, 'failed');
    const readyEventsBefore = f.emitted.filter(e => e.type === 'recovery_ready').length;

    // 到期后 begin 准入成功（写盘正常），随后注入写盘失败再成功调用
    f.advance(1_000_000);
    shouldFail = false;
    const a2 = await session.begin({ requestKey: 'fp', facts: facts({}) });
    if (a2.kind !== 'admitted') throw new Error('expected admitted');
    const memoryBefore = await session.inspect();
    const diskBefore = f.readState();

    armWriteFailure = true;
    await f.orchestrator.callWithinRecovery(CALL, session);   // 调用成功，但 noteSuccess 的 durable commit 失败
    armWriteFailure = false;

    // 事件证据：write_failed 发出、recovery_ready 未发布
    const writeFailed = f.emitted.filter(e => e.type === 'recovery_state_write_failed');
    expect(writeFailed).toHaveLength(1);
    expect(writeFailed[0]).toMatchObject({ context: 'noteSuccess' });
    expect(f.emitted.filter(e => e.type === 'recovery_ready')).toHaveLength(readyEventsBefore);
    // 内存不越过磁盘：schedule/revision 保持旧状态（未转 ready）
    const memoryAfter = await session.inspect();
    expect(memoryAfter).toEqual(memoryBefore);
    // 磁盘的恢复事实不变（失败证据/at 安排/revision 原样保留；activeAdmission.started
    // 是 noteAttemptStarted 的合法先行提交，不属 noteSuccess 事实）
    const diskAfterSuccess = f.readState();
    expect(diskAfterSuccess.revision).toBe(diskBefore.revision);
    expect(diskAfterSuccess.schedule).toEqual(diskBefore.schedule);
    expect(diskAfterSuccess.budget).toEqual(diskBefore.budget);
    expect(diskAfterSuccess.providers).toEqual(diskBefore.providers);
    expect(diskAfterSuccess.failures).toEqual(diskBefore.failures);

    // 写入恢复：同准入内再次成功调用 → 候选状态 durable commit 后替换内存
    writeState.failing = false;
    await f.orchestrator.callWithinRecovery(CALL, session);
    const readyEvents = f.emitted.filter(e => e.type === 'recovery_ready');
    expect(readyEvents.length).toBe(readyEventsBefore + 1);
    const saved = f.readState();
    // 事件 revision 只能来自已提交状态
    expect(readyEvents[readyEvents.length - 1]).toMatchObject({ revision: saved.revision });
    expect(saved.schedule.kind).toBe('ready');
    expect(saved.budget.retryCount).toBe(0);
    // 非 permanent 的 provider 故障事实按既有语义保留（noteSuccess 只清预算与 rate-limit 事实）
    expect(saved.providers).toHaveLength(1);
    expect((await session.inspect()).kind).toBe('ready');
  });

  it('noteFailure 写盘失败：内存不越过磁盘、不发布 recovery_scheduled；写入恢复后失败事实可重提交', async () => {
    const writeState = { failing: false };
    // 在 adapter 内才打开写失败开关：noteAttemptStarted 的 commit 发生在真实请求之前，
    // 目标失败点仅为 noteFailure 的 durable commit。
    let armWriteFailure = false;
    const f = await makeFixture({
      call: async () => {
        if (armWriteFailure) writeState.failing = true;
        throw new LLMNetworkError('boom');
      },
      wrapFs: (fs) => wrapWriteFailure(fs, writeState),
    });
    const session = f.makeSession();
    const admission = await session.begin({ requestKey: 'fp', facts: facts({}) });
    if (admission.kind !== 'admitted') throw new Error('expected admitted');
    const memoryBefore = await session.inspect();
    const diskBefore = f.readState();

    armWriteFailure = true;
    await expect(f.orchestrator.callWithinRecovery(CALL, session)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    armWriteFailure = false;

    // write_failed 证据（含原始错误原因）、recovery_scheduled 未发布
    const writeFailed = f.emitted.filter(e => e.type === 'recovery_state_write_failed');
    expect(writeFailed).toHaveLength(1);
    expect(writeFailed[0]).toMatchObject({ context: 'noteFailure', reason: expect.stringContaining('injected write failure') });
    expect(f.emitted.filter(e => e.type === 'recovery_scheduled')).toHaveLength(0);
    // 内存保持旧状态：schedule 仍 ready、revision 未前移
    expect(await session.inspect()).toEqual(memoryBefore);
    // 磁盘的恢复事实不变：无失败证据、无新安排（activeAdmission.started 是
    // noteAttemptStarted 的合法先行提交，不属 noteFailure 事实）
    const diskAfterFailure = f.readState();
    expect(diskAfterFailure.revision).toBe(diskBefore.revision);
    expect(diskAfterFailure.schedule).toEqual(diskBefore.schedule);
    expect(diskAfterFailure.budget).toEqual(diskBefore.budget);
    expect(diskAfterFailure.providers).toEqual(diskBefore.providers);
    expect(diskAfterFailure.failures).toEqual(diskBefore.failures);

    // 写入恢复：finish + 新一轮准入（schedule 仍 ready → 直接准入）→ 失败事实 durable commit
    writeState.failing = false;
    await session.finish(admission.attemptId, 'failed');
    const a2 = await session.begin({ requestKey: 'fp', facts: facts({}) });
    if (a2.kind !== 'admitted') throw new Error('expected admitted');
    await expect(f.orchestrator.callWithinRecovery(CALL, session)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);

    const scheduled = f.emitted.filter(e => e.type === 'recovery_scheduled');
    expect(scheduled).toHaveLength(1);
    const saved = f.readState();
    // 事件 revision 与已提交磁盘状态一致；失败证据与安排都已落盘
    expect(scheduled[0]).toMatchObject({ revision: saved.revision, scheduleKind: 'at' });
    expect(saved.failures).toHaveLength(1);
    expect(saved.providers).toHaveLength(1);
    expect(saved.schedule.kind).toBe('at');
    expect((await session.inspect()).kind).toBe('at');
  });
});


describe('Phase 2029 Step C: finish/started candidate commit barrier', () => {
  it('finish 写失败保持内存与磁盘旧 admission/schedule/revision，恢复后才发布 accepted finish', async () => {
    const writeState = { failing: false };
    const f = await makeFixture({ wrapFs: (fs) => wrapWriteFailure(fs, writeState) });
    const session = f.makeSession();
    const admission = await session.begin({ requestKey: 'fp', facts: facts({}) });
    if (admission.kind !== 'admitted') throw new Error('expected admitted');
    const diskBefore = f.readState();
    const memoryBefore = await session.inspect();

    writeState.failing = true;
    await expect(session.finish(admission.attemptId, 'completed')).rejects.toThrow('injected write failure');
    expect(f.readState()).toEqual(diskBefore);
    expect(await session.inspect()).toEqual(memoryBefore);
    expect(f.emitted.filter(e => e.type === 'recovery_attempt_finished' && e.accepted)).toHaveLength(0);

    // 旧 admission 仍在内存：begin 不得借内存空句柄覆盖磁盘旧 attempt。
    const blocked = await session.begin({ requestKey: 'fp-next', facts: facts({}) });
    expect(blocked.kind).toBe('waiting');
    expect(f.readState()).toEqual(diskBefore);

    writeState.failing = false;
    await session.finish(admission.attemptId, 'completed');
    const accepted = f.emitted.find(e => e.type === 'recovery_attempt_finished' && e.accepted);
    expect(accepted).toMatchObject({ revision: f.readState().revision });
    expect(f.readState().activeAdmission).toBeNull();
  });

  it('started 写失败不发生真实请求；同准入重试先持久 started 再调用 provider', async () => {
    const writeState = { failing: false };
    let providerCalls = 0;
    const f = await makeFixture({
      call: async () => { providerCalls++; return OK_RESPONSE; },
      wrapFs: (fs) => wrapWriteFailure(fs, writeState),
    });
    const session = f.makeSession();
    const admission = await session.begin({ requestKey: 'fp', facts: facts({}) });
    if (admission.kind !== 'admitted') throw new Error('expected admitted');
    const diskBefore = f.readState();

    writeState.failing = true;
    await expect(f.orchestrator.callWithinRecovery(CALL, session)).rejects.toThrow('injected write failure');
    expect(providerCalls).toBe(0);
    expect(f.readState()).toEqual(diskBefore);
    expect(f.readState().activeAdmission.started).toBe(false);

    writeState.failing = false;
    await f.orchestrator.callWithinRecovery(CALL, session);
    expect(providerCalls).toBe(1);
    expect(f.readState().activeAdmission.started).toBe(true);
  });
});


describe('Phase 2029 Step D: committed durability degradation evidence', () => {
  it('durable writes do not emit degraded events', async () => {
    const write = { result: { kind: 'durable' } as AtomicWriteResult };
    const f = await makeFixture({ wrapFs: (fs) => wrapWriteDurability(fs, write) });
    const session = f.makeSession();
    await session.begin({ requestKey: 'fp', facts: facts({}) });
    await f.orchestrator.callWithinRecovery(CALL, session);
    expect(f.emitted.filter(e => e.type === 'recovery_state_write_degraded')).toHaveLength(0);
  });

  it.each([
    { context: 'begin', kind: 'committed_platform_limited' },
    { context: 'finish', kind: 'committed_durability_unknown' },
    { context: 'noteAttemptStarted', kind: 'committed_platform_limited' },
    { context: 'noteFailure', kind: 'committed_durability_unknown' },
    { context: 'noteSuccess', kind: 'committed_platform_limited' },
  ] as const)('committed $kind result commits state and reports $context', async ({ context, kind }) => {
    const write = { result: { kind: 'durable' } as AtomicWriteResult };
    const f = await makeFixture({
      call: async () => {
        if (context === 'noteFailure') throw new LLMNetworkError('boom');
        return OK_RESPONSE;
      },
      wrapFs: (fs) => wrapWriteDurability(fs, write),
    });
    if (context === 'noteSuccess') {
      const seeded = createInitialRecoveryState(SCOPE, {
        retryCount: 0,
        retryDelayMs: 30_000,
        quotaDelayMs: 120_000,
      }, T0);
      seeded.providers.push({
        providerId: f.orchestrator.getProviderIdentities()[0],
        errorClass: 'rate_limit',
        at: new Date(T0).toISOString(),
        consecutiveFailures: 1,
        detail: 'limited',
        rateLimitFailures: 1,
      });
      saveRecoveryState(f.fs, seeded);
    }
    const session = f.makeSession();
    let admission: Awaited<ReturnType<typeof session.begin>> | undefined;
    if (context !== 'begin') {
      admission = await session.begin({ requestKey: 'fp', facts: facts({}) });
      if (admission.kind !== 'admitted') throw new Error('expected admitted');
    }

    const error = Object.assign(new Error(`injected ${context}`), { code: 'EIO' });
    write.result = { kind, error };
    if (context === 'begin') {
      await session.begin({ requestKey: 'fp', facts: facts({}) });
    } else if (context === 'finish') {
      if (admission?.kind !== 'admitted') throw new Error('expected admitted');
      await session.finish(admission.attemptId, 'completed');
    } else if (context === 'noteFailure') {
      await expect(f.orchestrator.callWithinRecovery(CALL, session)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    } else {
      await f.orchestrator.callWithinRecovery(CALL, session);
    }

    const degraded = f.emitted.find(
      e => e.type === 'recovery_state_write_degraded' && e.context === context,
    );
    expect(degraded).toMatchObject({
      scope: SCOPE,
      context,
      durability: kind,
      reason: expect.stringContaining(`injected ${context}`),
    });
    expect(f.emitted.filter(e => e.type === 'recovery_state_write_failed')).toHaveLength(0);
    const saved = f.readState();
    expect((await session.inspect()).revision).toBe(saved.revision);
    if (context === 'noteAttemptStarted') expect(saved.activeAdmission.started).toBe(true);
    if (context === 'finish') expect(saved.activeAdmission).toBeNull();
    if (context === 'noteFailure') expect(saved.schedule.kind).toBe('at');
    if (context === 'noteSuccess') expect(saved.providers[0].rateLimitFailures).toBeUndefined();
  });
});


describe('Phase 2034 Step C: legacy on_change migration and blocked candidate recovery', () => {
  type Fixture = Awaited<ReturnType<typeof makeFixture>>;

  function seedBlocked(
    f: Fixture,
    orchestrator: Fixture['orchestrator'],
    blockedCount: number,
  ) {
    const ids = orchestrator.getProviderIdentities();
    const state = createInitialRecoveryState(SCOPE, {
      retryCount: 0,
      retryDelayMs: 30_000,
      quotaDelayMs: 120_000,
    }, T0);
    state.revision = 2;
    state.schedule = { kind: 'at', revision: 2, resumeAt: new Date(T0 - 1).toISOString() };
    state.providers = ids.map((providerId, index) => ({
      providerId,
      errorClass: index < blockedCount ? 'rate_limit' : 'transient',
      at: new Date(T0).toISOString(),
      consecutiveFailures: index < blockedCount ? 10 : 1,
      detail: index < blockedCount ? 'blocked' : 'retryable',
      ...(index < blockedCount
        ? { rateLimitFailures: 10, rateLimitBlocked: true, rateLimitBlockedAt: new Date(T0).toISOString() }
        : {}),
    }));
    saveRecoveryState(f.fs, state);
  }

  it('legacy blocked primary 可真实 call，不再产生 rate_limit_blocked localSkip', async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const f = await makeFixture({
      call: async () => { primaryCalls++; return OK_RESPONSE; },
      fallbacks: [{ name: 'fallback', call: async () => { fallbackCalls++; return OK_RESPONSE; } }],
    });
    seedBlocked(f, f.orchestrator, 1);
    const before = f.readState();
    const session = f.makeSession();
    const admission = await session.begin({ requestKey: 'fp', facts: facts({}) });
    if (admission.kind !== 'admitted') throw new Error('expected admitted');
    expect(f.readState().providers).toEqual(before.providers);

    await f.orchestrator.callWithinRecovery(CALL, session);
    expect(primaryCalls).toBe(1);
    expect(fallbackCalls).toBe(0);
    expect(f.emitted.some(
      e => e.type === 'call_attempt_result' && e.outcome === 'skipped' && e.reason === 'rate_limit_blocked',
    )).toBe(false);
  });

  it('全部 legacy blocked 候选可真实执行 call/stream', async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    let streamCalls = 0;
    const f = await makeFixture({
      call: async () => { primaryCalls++; throw new LLMRateLimitError('primary'); },
      onStream: () => { streamCalls++; },
      fallbacks: [{ name: 'fallback', call: async () => { fallbackCalls++; return OK_RESPONSE; } }],
    });
    seedBlocked(f, f.orchestrator, 2);
    const session = f.makeSession();
    const admission = await session.begin({ requestKey: 'fp', facts: facts({}) });
    if (admission.kind !== 'admitted') throw new Error('expected admitted');

    await f.orchestrator.callWithinRecovery(CALL, session);
    expect(primaryCalls).toBe(1);
    expect(fallbackCalls).toBe(1);
    await session.finish(admission.attemptId, 'completed');

    seedBlocked(f, f.orchestrator, 1);
    const streamAdmission = await session.begin({ requestKey: 'fp-stream', facts: facts({}) });
    if (streamAdmission.kind !== 'admitted') throw new Error('expected stream admitted');
    await expect((async () => {
      for await (const _chunk of f.orchestrator.streamWithinRecovery(CALL, session)) { /* drain */ }
    })()).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    expect(streamCalls).toBe(1);
  });

  it.each([
    { errorClass: 'permanent', delayMs: 300_000, rateLimitFailures: undefined, rateLimitBlocked: undefined },
    { errorClass: 'rate_limit', delayMs: 600_000, rateLimitFailures: 10, rateLimitBlocked: true },
    { errorClass: 'rate_limit', delayMs: 120_000, rateLimitFailures: 3, rateLimitBlocked: undefined },
    { errorClass: 'transient', delayMs: 60_000, rateLimitFailures: undefined, rateLimitBlocked: undefined },
    { errorClass: 'unknown', delayMs: 60_000, rateLimitFailures: undefined, rateLimitBlocked: undefined },
    { errorClass: 'quota', delayMs: 240_000, rateLimitFailures: undefined, rateLimitBlocked: undefined },
  ])('旧 on_change 的 $errorClass facts 自动迁移为 at，revision 只增加一次', async (fact) => {
    const f = await makeFixture();
    const state = createInitialRecoveryState(SCOPE, {
      retryCount: 1,
      retryDelayMs: 60_000,
      quotaDelayMs: 240_000,
    }, T0);
    state.schedule = { kind: 'on_change', revision: state.revision };
    state.providers = [{
      providerId: f.orchestrator.getProviderIdentities()[0],
      errorClass: fact.errorClass,
      at: new Date(T0).toISOString(),
      consecutiveFailures: 3,
      detail: 'legacy hold',
      rateLimitFailures: fact.rateLimitFailures,
      rateLimitBlocked: fact.rateLimitBlocked,
      rateLimitBlockedAt: fact.rateLimitBlocked === true ? new Date(T0).toISOString() : undefined,
    }];
    state.failures = [{
      at: new Date(T0).toISOString(),
      providerId: state.providers[0].providerId,
      errorClass: fact.errorClass,
      message: 'original evidence',
    }];
    saveRecoveryState(f.fs, state);
    const session = f.makeSession();

    const result = await session.begin({ requestKey: 'fp', facts: facts({}) });
    expect(result.kind).toBe('waiting');
    if (result.kind !== 'waiting') return;
    expect(result.schedule).toMatchObject({
      kind: 'at',
      revision: state.revision + 1,
      resumeAt: new Date(T0 + fact.delayMs).toISOString(),
    });
    const saved = f.readState();
    expect(saved.revision).toBe(state.revision + 1);
    expect(saved.providers).toEqual(state.providers);
    expect(saved.failures).toEqual(state.failures);
  });

  it('无 provider facts 的非 provider on_change 保持原样且不增加 revision', async () => {
    const f = await makeFixture();
    const state = createInitialRecoveryState(SCOPE, {
      retryCount: 0,
      retryDelayMs: 30_000,
      quotaDelayMs: 120_000,
    }, T0);
    state.schedule = { kind: 'on_change', revision: state.revision };
    saveRecoveryState(f.fs, state);
    const session = f.makeSession();

    const result = await session.begin({ requestKey: 'fp', facts: facts({}) });
    expect(result.kind).toBe('waiting');
    expect(f.readState()).toEqual(state);
  });
});


describe('Phase 2027 legacy provider identity migration', () => {
  type Fixture = Awaited<ReturnType<typeof makeFixture>>;

  function seedLegacyFact(
    f: Fixture,
    currentConfig: ProviderConfig,
    fact: LLMRecoveryProviderFact,
    acceptedConfigRevisions: string[] = [],
  ) {
    f.reload(currentConfig);
    const state = createInitialRecoveryState(SCOPE, {
      retryCount: 0,
      retryDelayMs: 30_000,
      quotaDelayMs: 120_000,
    }, T0);
    state.providers = [fact];
    state.schedule = { kind: 'on_change', revision: state.revision };
    state.acceptedConfigRevisions = acceptedConfigRevisions;
    saveRecoveryState(f.fs, state);
    return state;
  }

  it('同修订重键保留 blocked/failures，清除 pending 时不伪造事实接受事件', async () => {
    const f = await makeFixture();
    const currentConfig = { ...providerConfig('primary'), authProfile: 'oauth' as const };
    const legacyId = legacyProviderIdentity(currentConfig);
    seedLegacyFact(f, currentConfig, {
      providerId: legacyId,
      errorClass: 'rate_limit',
      at: new Date(T0).toISOString(),
      consecutiveFailures: 10,
      detail: 'blocked',
      rateLimitFailures: 10,
      rateLimitBlocked: true,
      rateLimitBlockedAt: new Date(T0).toISOString(),
    }, ['r1']);
    const before = f.readState();
    before.failures = [{
      at: new Date(T0).toISOString(),
      providerId: legacyId,
      errorClass: 'rate_limit',
      message: 'original evidence',
    }];
    fsNative.writeFileSync(f.statePath, JSON.stringify(before));

    const migrated = f.makeSession();
    const pending = f.readState();
    expect(pending.providers[0]).toMatchObject({
      providerId: f.orchestrator.getProviderIdentities()[0],
      rateLimitBlocked: true,
      rateLimitFailures: 10,
      identityMigrationPending: true,
    });
    expect(pending.failures).toEqual(before.failures);
    expect(pending.revision).toBe(before.revision + 1);

    const acceptedBefore = acceptedEvents(f).length;
    const replay = await migrated.begin({ requestKey: 'fp', facts: facts({ configurationRevision: 'r1' }) });
    expect(replay.kind).toBe('waiting');
    const cleared = f.readState();
    expect(cleared.providers[0].identityMigrationPending).toBeUndefined();
    expect(cleared.providers[0].rateLimitBlocked).toBe(true);
    expect(cleared.providers[0].consecutiveFailures).toBe(10);
    expect(cleared.failures).toEqual(before.failures);
    expect(acceptedEvents(f)).toHaveLength(acceptedBefore);
  });

  it('重键后崩溃仍保留 pending；未命中当前旧身份的事实不被猜测重键', async () => {
    const f = await makeFixture();
    const currentConfig = { ...providerConfig('primary'), catalogProvider: 'metadata-a' };
    const legacyId = legacyProviderIdentity(currentConfig);
    seedLegacyFact(f, currentConfig, {
      providerId: legacyId,
      errorClass: 'permanent',
      at: new Date(T0).toISOString(),
      consecutiveFailures: 2,
      detail: 'old config',
    });
    const seeded = f.readState();
    seeded.providers.push({
      providerId: 'unrelated-legacy-id',
      errorClass: 'permanent',
      at: new Date(T0).toISOString(),
      consecutiveFailures: 1,
      detail: 'unrelated',
    });
    fsNative.writeFileSync(f.statePath, JSON.stringify(seeded));

    f.makeSession();
    const afterMigration = f.readState();
    expect(afterMigration.providers[0].identityMigrationPending).toBe(true);
    expect(afterMigration.providers[1].providerId).toBe('unrelated-legacy-id');
    expect(afterMigration.providers[1].identityMigrationPending).toBeUndefined();

    f.makeSession(); // 首次 begin 前再次重启
    const afterRestart = f.readState();
    expect(afterRestart.providers[0].identityMigrationPending).toBe(true);
    expect(afterRestart.providers[0].providerId).toBe(f.orchestrator.getProviderIdentities()[0]);
  });
});


describe('Phase 2027 selective persistent recovery re-evaluation', () => {
  type Fixture = Awaited<ReturnType<typeof makeFixture>>;

  function fact(providerId: string, patch: Partial<LLMRecoveryProviderFact> = {}): LLMRecoveryProviderFact {
    return {
      providerId,
      errorClass: 'permanent',
      at: new Date(T0).toISOString(),
      consecutiveFailures: 3,
      detail: 'failure fact',
      ...patch,
    };
  }

  function seedProviders(
    f: Fixture,
    providers: LLMRecoveryProviderFact[],
    schedule: 'ready' | 'on_change' = 'on_change',
  ) {
    const state = createInitialRecoveryState(SCOPE, {
      retryCount: 0,
      retryDelayMs: 30_000,
      quotaDelayMs: 120_000,
    }, T0);
    state.providers = providers;
    state.schedule = { kind: schedule, revision: state.revision };
    saveRecoveryState(f.fs, state);
  }

  it('A 变化、B 未变化 permanent：只重估 A，B 与 on_change 保持', async () => {
    const f = await makeFixture();
    const currentId = f.orchestrator.getProviderIdentities()[0]!;
    seedProviders(f, [fact('old-a'), fact(currentId)]);
    const session = f.makeSession();

    const result = await session.begin({ requestKey: 'fp', facts: facts({ configurationRevision: 'r1' }) });
    expect(result.kind).toBe('waiting');
    const saved = f.readState();
    expect(saved.providers).toHaveLength(1);
    expect(saved.providers[0].providerId).toBe(currentId);
    expect(saved.providers[0].consecutiveFailures).toBe(3);
    expect(saved.schedule.kind).toBe('at');
  });

  it('A 变化、B 未变化 rateLimitBlocked：只解除 A，B blocked 保持', async () => {
    const f = await makeFixture();
    const currentId = f.orchestrator.getProviderIdentities()[0]!;
    seedProviders(f, [
      fact('old-a', { errorClass: 'rate_limit', rateLimitFailures: 10, rateLimitBlocked: true }),
      fact(currentId, { errorClass: 'rate_limit', rateLimitFailures: 10, rateLimitBlocked: true }),
    ]);
    const session = f.makeSession();

    const result = await session.begin({ requestKey: 'fp', facts: facts({ configurationRevision: 'r1' }) });
    expect(result.kind).toBe('waiting');
    const saved = f.readState();
    const changed = saved.providers.find((p: LLMRecoveryProviderFact) => p.providerId === 'old-a');
    const unchanged = saved.providers.find((p: LLMRecoveryProviderFact) => p.providerId === currentId);
    expect(changed.rateLimitBlocked).toBeUndefined();
    expect(changed.rateLimitFailures).toBe(0);
    expect(unchanged.rateLimitBlocked).toBe(true);
    expect(unchanged.rateLimitFailures).toBe(10);
    expect(saved.schedule.kind).toBe('at');
  });

  it('全部相关阻断均变化并释放后 on_change 才转 ready', async () => {
    const f = await makeFixture();
    seedProviders(f, [fact('old-a'), fact('old-b')]);
    const session = f.makeSession();

    const result = await session.begin({ requestKey: 'fp', facts: facts({ configurationRevision: 'r1' }) });
    expect(result.kind).toBe('admitted');
    expect(f.readState().providers).toEqual([]);
    expect(f.readState().schedule.kind).toBe('ready');
  });

  it('只有 temperature 变化时 providerId 不变，永久故障事实保持', async () => {
    const f = await makeFixture();
    const beforeId = f.orchestrator.getProviderIdentities()[0]!;
    f.reload({ ...providerConfig('primary'), temperature: 1 });
    expect(f.orchestrator.getProviderIdentities()[0]).toBe(beforeId);
    seedProviders(f, [fact(beforeId)]);
    const session = f.makeSession();

    const result = await session.begin({ requestKey: 'fp', facts: facts({ configurationRevision: 'r1' }) });
    expect(result.kind).toBe('waiting');
    expect(f.readState().providers[0].errorClass).toBe('permanent');
    expect(f.readState().schedule.kind).toBe('at');
  });

  it('migration pending 即使命中当前 ID 也保守重估一次，后续事实不再带 pending', async () => {
    const f = await makeFixture();
    const currentId = f.orchestrator.getProviderIdentities()[0]!;
    seedProviders(f, [fact(currentId, {
      errorClass: 'rate_limit',
      rateLimitFailures: 10,
      rateLimitBlocked: true,
      identityMigrationPending: true,
    })]);
    const session = f.makeSession();

    const first = await session.begin({ requestKey: 'fp', facts: facts({ configurationRevision: 'r1' }) });
    expect(first.kind).toBe('admitted');
    if (first.kind !== 'admitted') return;
    const migrated = f.readState().providers[0];
    expect(migrated.rateLimitBlocked).toBeUndefined();
    expect(migrated.identityMigrationPending).toBeUndefined();
    await session.finish(first.attemptId, 'completed');

    const second = await session.begin({ requestKey: 'fp', facts: facts({ configurationRevision: 'r2' }) });
    expect(second.kind).toBe('admitted');
    expect(f.readState().providers[0]).toEqual(migrated);
  });

  it('at 未到期时身份变化也不缩短 deadline', async () => {
    const f = await makeFixture();
    const state = createInitialRecoveryState(SCOPE, {
      retryCount: 0,
      retryDelayMs: 30_000,
      quotaDelayMs: 120_000,
    }, T0);
    state.providers = [fact('old-a', { errorClass: 'rate_limit', rateLimitBlocked: true })];
    state.schedule = { kind: 'at', revision: state.revision, resumeAt: new Date(T0 + 900_000).toISOString() };
    saveRecoveryState(f.fs, state);
    const session = f.makeSession();

    const result = await session.begin({ requestKey: 'fp', facts: facts({ configurationRevision: 'r1' }) });
    expect(result.kind).toBe('waiting');
    if (result.kind === 'waiting') {
      expect(result.schedule).toMatchObject({ kind: 'at', resumeAt: new Date(T0 + 900_000).toISOString() });
    }
  });
});


describe('Phase 2032: legacy retirement and scoped invocation admission', () => {
  it('retires legacy_turn started=false without resuming it and preserves other state', async () => {
    const f = await makeFixture();
    const state = createInitialRecoveryState(SCOPE, {
      retryCount: 2,
      retryDelayMs: 60_000,
      quotaDelayMs: 240_000,
    }, T0);
    state.schedule = { kind: 'at', revision: 1, resumeAt: new Date(T0 + 120_000).toISOString() };
    state.activeAdmission = {
      attemptId: 'att-legacy-turn',
      started: false,
      requestKey: 'turn-fingerprint',
      triggerKind: 'intervention',
      interventionIds: ['old-user'],
    };
    state.acceptedInterventions.push('old-user');
    state.providers.push({
      providerId: 'provider-old',
      errorClass: 'transient',
      at: new Date(T0).toISOString(),
      consecutiveFailures: 1,
      detail: 'old failure',
    });
    state.failures.push({
      at: new Date(T0).toISOString(),
      providerId: 'provider-old',
      errorClass: 'transient',
      message: 'original evidence',
    });
    saveRecoveryState(f.fs, state);

    f.makeSession();
    const migrated = f.readState();
    expect(migrated.activeAdmission).toBeNull();
    expect(migrated.schedule).toMatchObject({ kind: 'at', resumeAt: state.schedule.resumeAt });
    expect(migrated.budget).toEqual(state.budget);
    expect(migrated.providers).toEqual(state.providers);
    expect(migrated.acceptedInterventions).toEqual(['old-user']);
    expect(migrated.failures[0].message).toBe('original evidence');
    expect(migrated.failures.at(-1).message).toContain('legacy_turn_admission_retired');
    expect(migrated.failures.at(-1).message).toContain('att-legacy-turn');
    expect(migrated.failures.at(-1).message).toContain('turn-fingerprint');

    // 再次启动不重复退役；旧 turn 不产生 resumedFromRestart 或新 attempt。
    f.makeSession();
    expect(f.readState().failures.filter(
      (failure: { message: string }) => failure.message.includes('legacy_turn_admission_retired'),
    )).toHaveLength(1);
    expect(f.emitted.filter(event => event.type === 'recovery_attempt_admitted')).toHaveLength(0);
  });

  it('keeps legacy_turn started=true as unknown result rather than inventing success', async () => {
    const f = await makeFixture();
    const state = createInitialRecoveryState(SCOPE, {
      retryCount: 0,
      retryDelayMs: 30_000,
      quotaDelayMs: 120_000,
    }, T0);
    state.activeAdmission = {
      attemptId: 'att-legacy-started',
      started: true,
      requestKey: 'turn-fingerprint',
      triggerKind: 'automatic',
    };
    saveRecoveryState(f.fs, state);

    f.makeSession();
    const migrated = f.readState();
    expect(migrated.activeAdmission).toBeNull();
    expect(migrated.failures.at(-1).message).toContain('att-legacy-started result unknown after restart');
    expect(migrated.failures.at(-1).message).not.toContain('legacy_turn_admission_retired');
    expect(f.emitted.filter(event => event.type === 'recovery_attempt_admitted')).toHaveLength(0);
  });

  it('gives each scoped call its own invocation and derives requestKey only from LLM input', async () => {
    let f!: Awaited<ReturnType<typeof makeFixture>>;
    const active: Array<{
      attemptId: string;
      requestKey: string;
      admissionKind?: string;
    }> = [];
    f = await makeFixture({
      call: async () => {
        active.push(f.readState().activeAdmission);
        return OK_RESPONSE;
      },
    });
    const session = f.makeSession();

    await session.llm.call({
      messages: [{ role: 'user', content: 'same' }],
      system: 'sys',
      recoveryFacts: { interventionIds: ['fact-a'] },
    });
    // 两次调用之间等价于工具执行窗口：没有 turn 级 activeAdmission 残留。
    expect(f.readState().activeAdmission).toBeNull();
    await session.llm.call({
      system: 'sys',
      messages: [{ content: 'same', role: 'user' }],
      recoveryFacts: { interventionIds: ['fact-b'] },
    });
    expect(f.readState().activeAdmission).toBeNull();
    await session.llm.call({ messages: [{ role: 'user', content: 'different' }], system: 'sys' });

    expect(active).toHaveLength(3);
    expect(new Set(active.map(record => record.attemptId)).size).toBe(3);
    expect(active.every(record => record.admissionKind === 'invocation')).toBe(true);
    // 对象键顺序与 recoveryFacts 不影响请求身份；消息正文变化会影响。
    expect(active[0].requestKey).toBe(active[1].requestKey);
    expect(active[2].requestKey).not.toBe(active[0].requestKey);
    expect(f.emitted.filter(event => event.type === 'recovery_attempt_finished')).toHaveLength(3);
  });

  it('throws typed waiting for call/stream with zero provider requests and no started admission', async () => {
    let providerCalls = 0;
    const f = await makeFixture({
      call: async () => {
        providerCalls += 1;
        throw new LLMQuotaError('p', 'insufficient quota');
      },
    });
    const session = f.makeSession();
    await expect(session.llm.call(CALL)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    expect(providerCalls).toBe(1);
    const before = f.readState();
    expect(before.activeAdmission).toBeNull();

    let waitError: unknown;
    try {
      await session.llm.call(CALL);
    } catch (error) {
      waitError = error;
    }
    expect(waitError).toBeInstanceOf(LLMRecoveryWaitRequiredError);
    expect(waitError).toMatchObject({ factsAccepted: true, schedule: { kind: 'at' } });
    await expect(session.llm.stream(CALL).next()).rejects.toBeInstanceOf(LLMRecoveryWaitRequiredError);

    expect(providerCalls).toBe(1);
    expect(f.readState().activeAdmission).toBeNull();
    expect(f.readState().budget).toEqual(before.budget);
    expect(f.readState().failures).toEqual(before.failures);
  });

  it('preserves both the invocation error and a finish write error', async () => {
    let writes = 0;
    const f = await makeFixture({
      call: async () => { throw new Error('provider exploded'); },
      wrapFs: (fs) => new Proxy(fs, {
        get(target, prop) {
          if (prop === 'writeAtomicSync') {
            return (...args: unknown[]) => {
              writes += 1;
              if (writes === 4) throw new Error('finish write failed');
              return (target.writeAtomicSync as (...inner: unknown[]) => unknown)(...args);
            };
          }
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as FileSystem,
    });
    const session = f.makeSession();

    let failure: unknown;
    try {
      await session.llm.call(CALL);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.errors[0]).toBeInstanceOf(LLMAllProvidersFailedError);
    expect(aggregate.errors[1]).toBeInstanceOf(Error);
    expect((aggregate.errors[1] as Error).message).toContain('finish write failed');
    expect(aggregate.cause).toBe(aggregate.errors[0]);
  });
});


describe('Phase 2035 Step C: complete accepted-fact dedupe', () => {
  it('65 个干预后窗口外/中间/最新重放均幂等，新干预仍获提前资格', async () => {
    let providerCalls = 0;
    const f = await makeFixture({
      call: async () => {
        providerCalls += 1;
        throw new LLMQuotaError('p', 'insufficient quota');
      },
    });
    const session = f.makeSession();
    const first = await session.begin({ requestKey: 'fp', facts: facts({}) });
    if (first.kind !== 'admitted') throw new Error('expected admitted');
    await expect(f.orchestrator.callWithinRecovery(CALL, session)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    await session.finish(first.attemptId, 'failed');

    for (let i = 0; i < 65; i++) {
      const admission = await session.begin({
        requestKey: `fp-${i}`,
        facts: facts({ interventionIds: [`m${i}`] }),
      });
      expect(admission.kind).toBe('admitted');
      if (admission.kind !== 'admitted') return;
      await session.finish(admission.attemptId, 'interrupted');
    }
    expect(f.readState().acceptedInterventions).toHaveLength(64);
    expect(f.readState().acceptedInterventions).not.toContain('m0');
    expect(f.readState().acceptedFactBatches).toHaveLength(65);

    const acceptedBefore = acceptedEvents(f).length;
    for (const id of ['m0', 'm32', 'm64']) {
      const replay = await session.begin({ requestKey: 'fp-replay', facts: facts({ interventionIds: [id] }) });
      expect(replay.kind).toBe('waiting');
    }
    expect(f.readState().acceptedFactBatches).toHaveLength(65);
    expect(acceptedEvents(f)).toHaveLength(acceptedBefore);
    expect(providerCalls).toBe(1);

    const fresh = await session.begin({
      requestKey: 'fp-fresh',
      facts: facts({ interventionIds: ['m65'] }),
    });
    expect(fresh.kind).toBe('admitted');
    expect(f.readState().acceptedFactBatches).toHaveLength(66);
  });

  it('65 个配置修订后重放最旧修订不重估未变化 provider 或缩短 at', async () => {
    let providerCalls = 0;
    const f = await makeFixture({
      call: async () => {
        providerCalls += 1;
        throw new LLMAuthError('bad key');
      },
    });
    const session = f.makeSession();
    const first = await session.begin({ requestKey: 'fp', facts: facts({}) });
    if (first.kind !== 'admitted') throw new Error('expected admitted');
    await expect(f.orchestrator.callWithinRecovery(CALL, session)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    await session.finish(first.attemptId, 'failed');

    for (let i = 0; i < 65; i++) {
      const result = await session.begin({
        requestKey: `fp-r${i}`,
        facts: facts({ configurationRevision: `r${i}` }),
      });
      expect(result.kind).toBe('waiting');
    }
    const before = f.readState();
    expect(before.acceptedConfigRevisions).toHaveLength(64);
    expect(before.acceptedConfigRevisions).not.toContain('r0');
    expect(before.acceptedFactBatches).toHaveLength(65);

    const replay = await session.begin({
      requestKey: 'fp-replay',
      facts: facts({ configurationRevision: 'r0' }),
    });
    expect(replay.kind).toBe('waiting');
    const after = f.readState();
    expect(after.providers).toEqual(before.providers);
    expect(after.schedule).toEqual(before.schedule);
    expect(after.acceptedFactBatches).toEqual(before.acceptedFactBatches);
    expect(after.revision).toBe(before.revision);
    expect(providerCalls).toBe(1);

    const fresh = await session.begin({
      requestKey: 'fp-r65',
      facts: facts({ configurationRevision: 'r65' }),
    });
    expect(fresh.kind).toBe('waiting');
    expect(f.readState().acceptedFactBatches).toHaveLength(66);
  });

  it('缺 acceptedFactBatches 的旧文件只沿用窗口行为，不伪造窗口外历史', async () => {
    const f = await makeFixture();
    const legacy = createInitialRecoveryState(SCOPE, {
      retryCount: 0,
      retryDelayMs: 30_000,
      quotaDelayMs: 120_000,
    }, T0);
    legacy.schedule = { kind: 'at', revision: 1, resumeAt: new Date(T0 + 300_000).toISOString() };
    legacy.acceptedInterventions = Array.from({ length: 64 }, (_, i) => `m${i + 1}`);
    saveRecoveryState(f.fs, legacy);
    expect(f.readState().acceptedFactBatches).toBeUndefined();

    const session = f.makeSession();
    const result = await session.begin({
      requestKey: 'fp-legacy',
      facts: facts({ interventionIds: ['m0'] }),
    });
    expect(result.kind).toBe('admitted');
    expect(f.readState().acceptedFactBatches).toHaveLength(1);
    expect(f.readState().acceptedFactBatches[0].interventionIds).toEqual(['m0']);
  });
});

describe('Phase 2035 Step D: explicit failure evidence loss', () => {
  it('第 11 条起累计 droppedCount 与被丢时间范围，并保留最近 10 条', async () => {
    const f = await makeFixture();
    const session = f.makeSession();
    for (let i = 0; i < 12; i++) {
      if (i > 0) f.advance(1_000);
      session.noteFailure([{
        providerId: 'provider-primary',
        errorClass: 'transient',
        message: `failure-${i}`,
      }]);
    }

    const saved = f.readState();
    expect(saved.failures).toHaveLength(10);
    expect(saved.failures.map((failure: { message: string }) => failure.message)).toEqual(
      Array.from({ length: 10 }, (_, i) => `failure-${i + 2}`),
    );
    expect(saved.failureEvidenceLoss).toEqual({
      droppedCount: 2,
      firstDroppedAt: new Date(T0).toISOString(),
      lastDroppedAt: new Date(T0 + 1_000).toISOString(),
      reason: 'bounded_retention',
      policyVersion: 1,
      recoverability: 'not_preserved_in_recovery_state',
    });
    expect(saved.revision).toBe(13);
    expect(saved.schedule.revision).toBe(saved.revision);
  });
});
