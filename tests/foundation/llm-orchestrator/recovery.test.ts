/**
 * Phase 2058：恢复策略与持久化统一到 LLMRecoveryControllerImpl / llm-instance-state.json V3。
 * 公共业务入口只有 owner.call/stream；controller 深导入仅用于内部策略与崩溃屏障白盒测试。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fsNative from 'node:fs';
import { vi } from 'vitest';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createLLMOrchestrator } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import {
  LLMRecoveryControllerImpl,
  type LLMOrchestratorOwner,
} from '../../../src/foundation/llm-orchestrator/recovery.js';
import { createInitialRecoveryState } from '../../../src/foundation/llm-orchestrator/recovery-state.js';
import {
  LLM_INSTANCE_STATE_FILE,
  saveLLMInstanceState,
  type LLMInstanceStateV3,
} from '../../../src/foundation/llm-orchestrator/instance-state.js';
import { legacyProviderIdentity } from '../../../src/foundation/llm-orchestrator/provider-identity.js';
import { LLMAllProvidersFailedError, LLMOrchestratorClosedError } from '../../../src/foundation/llm-orchestrator/errors.js';
import type { LLMEvent, LLMEventSink, LLMOrchestratorConfig, LLMRecoveryFacts } from '../../../src/foundation/llm-orchestrator/index.js';
import type { ProviderAdapter, ProviderConfig, LLMResponse } from '../../../src/foundation/llm-provider/index.js';
import type { FileSystem } from '../../../src/foundation/fs/index.js';
import type { AtomicWriteResult } from '../../../src/foundation/fs/types.js';

const T0 = Date.parse('2026-09-10T00:00:00.000Z');
const CALL = { messages: [{ role: 'user' as const, content: 'hi' }] };
const OK_RESPONSE: LLMResponse = { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' };

function providerConfig(name: string): ProviderConfig {
  return {
    name, apiKey: `key-${name}`, model: `model-${name}`, temperature: 0,
    timeoutMs: 1_000, apiFormat: 'anthropic',
  };
}

function makeAdapter(name: string, call: ProviderAdapter['call'], onStream?: () => void): ProviderAdapter {
  return {
    name, model: `model-${name}`, call,
    stream: async function* () {
      onStream?.();
      throw new Error('stream not enabled in this test');
    },
  };
}

const cleanupDirs: string[] = [];
const owners: LLMOrchestratorOwner[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(async () => {
  for (const owner of owners.splice(0)) {
    try { await owner.close(); } catch { /* test cleanup */ }
  }
  vi.useRealTimers();
  for (const dir of cleanupDirs.splice(0)) {
    try { await cleanupTempDir(dir); } catch { /* test cleanup */ }
  }
});

interface FixtureOpts {
  call?: ProviderAdapter['call'];
  onStream?: () => void;
  fallbacks?: Array<{ name: string; call?: () => Promise<LLMResponse> }>;
  maxAttempts?: number;
  circuitBreaker?: { failureThreshold: number; resetTimeoutMs: number };
  wrapFs?: (fs: FileSystem) => FileSystem;
  wrapSink?: (sink: LLMEventSink) => LLMEventSink;
}

function controllerOf(owner: LLMOrchestratorOwner): LLMRecoveryControllerImpl {
  return (owner as unknown as { recoveryController: LLMRecoveryControllerImpl }).recoveryController;
}

async function makeFixture(opts: FixtureOpts = {}) {
  const dir = await createTrackedTempDir('recovery-');
  cleanupDirs.push(dir);
  const baseFs = new NodeFileSystem({ baseDir: dir });
  const fs = opts.wrapFs ? opts.wrapFs(baseFs) : baseFs;
  const emitted: LLMEvent[] = [];
  const baseSink: LLMEventSink = { emit: event => { emitted.push(event); } };
  const sink = opts.wrapSink ? opts.wrapSink(baseSink) : baseSink;
  const primary = makeAdapter('primary', opts.call ?? (async () => OK_RESPONSE), opts.onStream);
  const fallbackAdapters = (opts.fallbacks ?? []).map(fallback =>
    makeAdapter(fallback.name, fallback.call ?? (async () => OK_RESPONSE)));
  const adapters = new Map([primary, ...fallbackAdapters].map(adapter => [adapter.name, adapter]));
  const config: LLMOrchestratorConfig = {
    lifecycle: { mode: 'durable', fs },
    primary: providerConfig('primary'),
    fallbacks: fallbackAdapters.map(fallback => providerConfig(fallback.name)),
    maxAttempts: opts.maxAttempts ?? 1,
    retryDelayMs: 1,
    events: sink,
    createProviderAdapter: provider => adapters.get(provider.name ?? '') ?? primary,
    ...(opts.circuitBreaker ? { circuitBreaker: opts.circuitBreaker } : {}),
  };
  const makeOwner = (primaryConfig = config.primary) => {
    const owner = createLLMOrchestrator({ ...config, primary: primaryConfig });
    owners.push(owner);
    return owner;
  };
  const statePath = path.join(dir, 'status', LLM_INSTANCE_STATE_FILE);
  const readState = () => JSON.parse(fsNative.readFileSync(statePath, 'utf8')) as LLMInstanceStateV3;
  const owner = makeOwner();
  return {
    dir, fs, sink, emitted, config, owner, controller: controllerOf(owner), makeOwner, readState, statePath,
    advance: (ms: number) => { vi.setSystemTime(Date.now() + ms); },
    reload: (nextPrimary: ProviderConfig) => owner.reloadConfig({ ...config, primary: nextPrimary }),
  };
}

type Fixture = Awaited<ReturnType<typeof makeFixture>>;
const facts = (partial: Partial<LLMRecoveryFacts> = {}): LLMRecoveryFacts => ({ interventionIds: [], ...partial });

function recordProviderSuccess(f: Fixture, providerIndex = 0): void {
  const owner = f.owner as unknown as {
    primary: ProviderAdapter;
    fallbacks: ProviderAdapter[];
    configGeneration: number;
    recordProviderSuccess(
      index: number,
      adapter: ProviderAdapter,
      isFallback: boolean,
      generation: number,
      updateSelection?: boolean,
    ): void;
  };
  const adapter = providerIndex === 0 ? owner.primary : owner.fallbacks[providerIndex - 1]!;
  owner.recordProviderSuccess(providerIndex, adapter, providerIndex > 0, owner.configGeneration, true);
}

async function restart(f: Fixture): Promise<void> {
  await f.owner.close();
  f.owner = f.makeOwner();
  f.controller = controllerOf(f.owner);
}

async function failOnce(
  f: Fixture,
  errorClass: 'transient' | 'quota' | 'rate_limit' | 'permanent' | 'unknown',
  extra: { retryAfterSec?: number; resetAtMs?: number; inputFacts?: LLMRecoveryFacts } = {},
) {
  const admission = await f.controller.begin({ requestKey: 'fp', facts: extra.inputFacts ?? facts() });
  if (admission.kind !== 'admitted') throw new Error('expected admitted');
  f.controller.noteFailure([{
    providerId: f.owner.getProviderIdentities()[0]!, errorClass, message: `${errorClass} failure`,
    ...(extra.retryAfterSec !== undefined ? { retryAfterSec: extra.retryAfterSec } : {}),
    ...(extra.resetAtMs !== undefined ? { resetAtMs: extra.resetAtMs } : {}),
    invocationId: admission.invocationId, attemptId: admission.attemptId, occurredAtMs: Date.now(),
  }]);
  await f.controller.finish(admission.invocationId, admission.attemptId, 'failed');
  return f.controller.inspect();
}

describe('recovery invocation admission and restart', () => {
  it('admits when ready and finish removes only that invocation', async () => {
    const f = await makeFixture();
    const admission = await f.controller.begin({ requestKey: 'fp-1', facts: facts() });
    expect(admission.kind).toBe('admitted');
    if (admission.kind !== 'admitted') return;
    expect(f.readState().recovery.invocations).toEqual([
      expect.objectContaining({ invocationId: admission.invocationId, attemptId: admission.attemptId, started: false }),
    ]);
    await f.controller.finish(admission.invocationId, admission.attemptId, 'completed');
    expect(f.readState().recovery.invocations).toEqual([]);
    expect((await f.controller.inspect()).kind).toBe('ready');
  });

  it('persists started before a real request and recovers it as unknown-result evidence', async () => {
    const f = await makeFixture();
    const first = await f.controller.begin({ requestKey: 'fp-1', facts: facts() });
    if (first.kind !== 'admitted') throw new Error('expected admitted');
    f.controller.noteAttemptStarted(first.invocationId);
    expect(f.readState().recovery.invocations[0]).toMatchObject({
      invocationId: first.invocationId, started: true, startedAt: expect.any(String),
    });

    await restart(f);
    const saved = f.readState().recovery;
    expect(saved.invocations).toEqual([]);
    expect(saved.failures.at(-1)).toMatchObject({
      invocationId: first.invocationId, attemptId: first.attemptId, errorClass: 'unknown',
      message: expect.stringContaining('result unknown after restart'),
    });
    const next = await f.controller.begin({ requestKey: 'fp-1', facts: facts() });
    expect(next.kind).toBe('admitted');
    if (next.kind === 'admitted') expect(next.attemptId).not.toBe(first.attemptId);
  });

  it('resumes an unstarted invocation with the same invocation/attempt and merges fresh facts', async () => {
    const f = await makeFixture();
    await failOnce(f, 'quota');
    const granted = await f.controller.begin({
      requestKey: 'fp-current', facts: facts({ interventionIds: ['new-user'] }),
    });
    if (granted.kind !== 'admitted') throw new Error('expected admitted');

    await restart(f);
    const merged = await f.controller.begin({
      requestKey: 'fp-current',
      facts: facts({ interventionIds: ['new-user', 'm2'], configurationRevision: 'r2' }),
    });
    expect(merged.kind).toBe('admitted');
    if (merged.kind !== 'admitted') return;
    expect(merged).toMatchObject({ invocationId: granted.invocationId, attemptId: granted.attemptId });
    const saved = f.readState().recovery;
    expect(saved.invocations[0]).toMatchObject({
      requestKey: 'fp-current', interventionIds: ['new-user', 'm2'], configurationRevision: 'r2',
    });
    expect(saved.acceptedFactBatches?.at(-1)).toMatchObject({
      interventionIds: ['m2'], configurationRevision: 'r2', attemptId: granted.attemptId,
    });
  });

  it('allows concurrent public calls and persists independent started invocations', async () => {
    const pending = new Map<string, (response: LLMResponse) => void>();
    const f = await makeFixture({
      call: async options => new Promise<LLMResponse>(resolve => {
        const content = options?.messages[0]?.content;
        pending.set(typeof content === 'string' ? content : 'unknown', resolve);
      }),
    });
    const first = f.owner.call({ messages: [{ role: 'user', content: 'first' }] });
    const second = f.owner.call({ messages: [{ role: 'user', content: 'second' }] });
    await vi.advanceTimersByTimeAsync(0);
    const active = f.readState().recovery.invocations;
    expect(active).toHaveLength(2);
    expect(new Set(active.map(item => item.invocationId)).size).toBe(2);
    expect(active.every(item => item.started)).toBe(true);

    pending.get('first')!(OK_RESPONSE);
    await first;
    expect(f.readState().recovery.invocations.map(item => item.invocationId)).toEqual([active[1]!.invocationId]);
    pending.get('second')!(OK_RESPONSE);
    await second;
    expect(f.readState().recovery.invocations).toEqual([]);
  });

  it('owner close rejects public call/stream before creating admission or writing state', async () => {
    const f = await makeFixture();
    await f.owner.close();
    const before = fsNative.readFileSync(f.statePath, 'utf8');
    const eventCount = f.emitted.length;
    await expect(f.owner.call(CALL)).rejects.toBeInstanceOf(LLMOrchestratorClosedError);
    await expect(f.owner.stream(CALL).next()).rejects.toBeInstanceOf(LLMOrchestratorClosedError);
    expect(fsNative.readFileSync(f.statePath, 'utf8')).toBe(before);
    expect(f.emitted.slice(eventCount).filter(event => event.type.startsWith('recovery_'))).toEqual([]);
  });
});

describe('recovery failure policy on unified V3 provider states', () => {
  it('quota uses a per-provider 120s curve capped at 480s without a global budget', async () => {
    const f = await makeFixture();
    const schedule = await failOnce(f, 'quota');
    expect(schedule).toMatchObject({ kind: 'at', resumeAt: new Date(T0 + 120_000).toISOString() });
    const saved = f.readState();
    expect(saved.recovery.budget).toEqual({ retryCount: 0, retryDelayMs: 30_000, quotaDelayMs: 120_000 });
    expect(saved.providers[0]).toMatchObject({
      status: 'waiting', retryAt: T0 + 120_000, consecutiveFailures: 1,
      lastError: { class: 'quota', at: T0, message: 'quota failure' },
    });
    expect(saved.recovery.providers).toEqual([]);

    const delays = [120_000];
    for (let round = 0; round < 3; round++) {
      f.advance(1_000_000);
      const next = await failOnce(f, 'quota');
      if (next.kind !== 'at') throw new Error('expected at');
      delays.push(Date.parse(next.resumeAt) - Date.now());
    }
    expect(delays).toEqual([120_000, 240_000, 480_000, 480_000]);
    expect(f.emitted.filter(event => event.type === 'recovery_scheduled')).toHaveLength(4);
  });

  it('quota uses typed reset and Retry-After as lower bounds with the quota curve', async () => {
    const f = await makeFixture();
    const schedule = await failOnce(f, 'quota', {
      resetAtMs: T0 + 300_000,
      retryAfterSec: 400,
    });
    expect(schedule).toMatchObject({ kind: 'at', resumeAt: new Date(T0 + 400_000).toISOString() });

    await restart(f);
    expect(f.readState().providers[0]).toMatchObject({
      status: 'waiting',
      retryAt: T0 + 400_000,
      lastError: { retryAfterSec: 400, quotaResetAtMs: T0 + 300_000 },
    });
    expect((await f.controller.inspect()).kind).toBe('at');
  });

  it('waits until the persisted retryAt and then admits a new invocation', async () => {
    const f = await makeFixture();
    await failOnce(f, 'quota');
    expect((await f.controller.begin({ requestKey: 'fp', facts: facts() })).kind).toBe('waiting');
    f.advance(121_000);
    expect((await f.controller.begin({ requestKey: 'fp', facts: facts() })).kind).toBe('admitted');
  });

  it('transient failures use per-provider exponential backoff capped at 300s', async () => {
    const f = await makeFixture();
    const delays: number[] = [];
    for (let round = 0; round < 5; round++) {
      const schedule = await failOnce(f, 'transient');
      if (schedule.kind !== 'at') throw new Error('expected at');
      delays.push(Date.parse(schedule.resumeAt) - Date.now());
      f.advance(1_000_000);
    }
    expect(delays).toEqual([30_000, 60_000, 120_000, 240_000, 300_000]);
    expect(f.emitted.filter(event => event.type === 'recovery_scheduled')).toHaveLength(5);
  });

  it('permanent failures continuously schedule cooldown attempts', async () => {
    const f = await makeFixture();
    for (let round = 0; round < 2; round++) {
      const schedule = await failOnce(f, 'permanent');
      expect(schedule).toMatchObject({ kind: 'at', resumeAt: new Date(Date.now() + 300_000).toISOString() });
      expect((await f.controller.begin({ requestKey: 'fp', facts: facts() })).kind).toBe('waiting');
      f.advance(300_000);
    }
  });

  it('rate_limit without Retry-After keeps timed probes after the tenth failure', async () => {
    const f = await makeFixture();
    const delays: number[] = [];
    for (let round = 0; round < 10; round++) {
      const schedule = await failOnce(f, 'rate_limit');
      if (schedule.kind !== 'at') throw new Error('expected at');
      delays.push(Date.parse(schedule.resumeAt) - Date.now());
      if (round < 9) f.advance(1_000_000);
    }
    expect(delays).toEqual([
      30_000, 60_000, 120_000, 300_000, 600_000,
      600_000, 600_000, 600_000, 600_000, 600_000,
    ]);

    const retryAt = Date.now() + 600_000;
    expect(f.readState().providers[0]).toMatchObject({
      status: 'waiting', retryAt, consecutiveFailures: 10,
      lastError: { class: 'rate_limit' },
    });
    expect(f.readState().providers[0]).not.toHaveProperty('rateLimitBlocked');
    expect((await f.controller.begin({ requestKey: 'fp', facts: facts() })).kind).toBe('waiting');

    f.advance(600_000);
    const timed = await f.controller.begin({ requestKey: 'fp-timed', facts: facts() });
    expect(timed.kind).toBe('admitted');
    if (timed.kind !== 'admitted') throw new Error('expected admitted');
    expect(f.controller.attemptContext(timed.invocationId).probeOnly).toBe(true);
    expect((await f.controller.inspect()).kind).toBe('at');

    const released = await f.controller.begin({
      requestKey: 'fp-manual', facts: facts({ interventionIds: ['manual-rate-limit-review'] }),
    });
    expect(released.kind).toBe('admitted');
    expect(f.readState().providers[0]).toMatchObject({ status: 'waiting', retryAt, consecutiveFailures: 10 });
    expect(f.readState().recovery.acceptedInterventions).toContain('manual-rate-limit-review');
  });

  it.each([2, 900])('Retry-After %ss is the exact lower bound, without in-call sleep or a 5min floor', async seconds => {
    const f = await makeFixture();
    const schedule = await failOnce(f, 'rate_limit', { retryAfterSec: seconds });
    expect(schedule).toMatchObject({ kind: 'at', resumeAt: new Date(T0 + seconds * 1_000).toISOString() });
    expect(f.emitted.filter(event => event.type === 'retry_scheduled')).toHaveLength(0);
    expect(f.readState().providers[0]).toMatchObject({
      status: 'waiting', retryAt: T0 + seconds * 1_000,
      lastError: { class: 'rate_limit', retryAfterSec: seconds },
    });
    expect(f.readState().providers[0]).not.toHaveProperty('rateLimitFailures');
  });

  it('owner success clears only the real winner and retains the other provider curve', async () => {
    const f = await makeFixture({ fallbacks: [{ name: 'fallback' }] });
    const [primaryId, fallbackId] = f.owner.getProviderIdentities();
    f.controller.noteFailure([{ providerId: primaryId!, errorClass: 'transient', message: 'primary down' }]);
    f.controller.noteFailure([{ providerId: fallbackId!, errorClass: 'transient', message: 'fallback down' }]);
    const admission = await f.controller.begin({
      requestKey: 'fp', facts: facts({ interventionIds: ['manual-retry'] }),
    });
    if (admission.kind !== 'admitted') throw new Error('expected admitted');
    const beforeSuccess = f.readState();
    f.controller.noteSuccess(admission.invocationId, primaryId!);
    expect(f.readState()).toEqual(beforeSuccess); // noteSuccess 不再拥有健康写入口
    expect(f.emitted.filter(event => event.type === 'recovery_ready')).toHaveLength(0);

    recordProviderSuccess(f);
    f.controller.noteSuccess(admission.invocationId, primaryId!);

    const saved = f.readState();
    expect(saved.recovery.budget).toEqual({ retryCount: 0, retryDelayMs: 30_000, quotaDelayMs: 120_000 });
    expect(saved.providers).toEqual([
      expect.objectContaining({ providerId: primaryId, status: 'available', consecutiveFailures: 0 }),
      expect.objectContaining({ providerId: fallbackId, status: 'waiting', consecutiveFailures: 1 }),
    ]);
    expect(saved.providers[0]?.retryAt).toBeUndefined();
    expect(saved.providers[1]?.retryAt).toBe(T0 + 30_000);
    expect(saved.recovery.providers).toEqual([]);
    expect((await f.controller.inspect()).kind).toBe('ready');
    expect(f.emitted.filter(event => event.type === 'recovery_ready').at(-1)).toMatchObject({
      invocationId: admission.invocationId, revision: saved.revision,
    });
  });

  it('local breaker skips persist neither provider health nor failure evidence', async () => {
    const f = await makeFixture();
    const providerId = f.owner.getProviderIdentities()[0]!;
    const before = f.readState();
    f.controller.noteFailure([{
      providerId, errorClass: 'transient', message: 'breaker open', localSkip: true,
      probeAllowedAtMs: T0 + 60_000,
    }]);
    expect(f.readState()).toEqual(before);
    expect(f.readState().providers).toEqual([]);
    expect(f.readState().recovery.failures).toEqual([]);
  });
});

describe('recovery fact combination and dedupe', () => {
  it('a fresh intervention admits early; replay does not; a second fresh id does', async () => {
    const f = await makeFixture();
    await failOnce(f, 'quota');
    const early = await f.controller.begin({ requestKey: 'fp', facts: facts({ interventionIds: ['m1'] }) });
    expect(early.kind).toBe('admitted');
    if (early.kind !== 'admitted') return;
    await f.controller.finish(early.invocationId, early.attemptId, 'interrupted');
    expect((await f.controller.begin({ requestKey: 'fp', facts: facts({ interventionIds: ['m1'] }) })).kind).toBe('waiting');
    expect((await f.controller.begin({
      requestKey: 'fp', facts: facts({ interventionIds: ['m1', 'm2'] }),
    })).kind).toBe('admitted');
  });

  it('combined fresh user/config/startup facts produce one invocation and one accepted batch', async () => {
    const f = await makeFixture();
    await failOnce(f, 'permanent');
    const admittedBefore = f.emitted.filter(event => event.type === 'recovery_attempt_admitted').length;
    const admission = await f.controller.begin({
      requestKey: 'fp',
      facts: facts({ interventionIds: ['m-new'], configurationRevision: 'r2', startupId: 'boot-1' }),
    });
    expect(admission.kind).toBe('admitted');
    if (admission.kind !== 'admitted') return;
    const saved = f.readState().recovery;
    expect(saved.invocations).toHaveLength(1);
    expect(saved.invocations[0]).toMatchObject({
      invocationId: admission.invocationId, interventionIds: ['m-new'],
      configurationRevision: 'r2', startupId: 'boot-1', allowBreakerProbe: true,
    });
    expect(saved.acceptedFactBatches?.at(-1)).toMatchObject({
      interventionIds: ['m-new'], configurationRevision: 'r2', startupId: 'boot-1',
      invocationId: admission.invocationId, attemptId: admission.attemptId,
    });
    expect(f.emitted.filter(event => event.type === 'recovery_attempt_admitted')).toHaveLength(admittedBefore + 1);
  });

  it('new configuration is accepted without shortening an existing at deadline', async () => {
    const f = await makeFixture();
    const before = await failOnce(f, 'quota');
    const waiting = await f.controller.begin({
      requestKey: 'fp', facts: facts({ configurationRevision: 'r-quota-fix' }),
    });
    expect(waiting.kind).toBe('waiting');
    expect(waiting.kind).toBe('waiting');
    if (waiting.kind !== 'waiting' || before.kind !== 'at') throw new Error('expected timed waiting');
    expect(waiting.factsAccepted).toBe(true);
    expect(waiting.schedule).toMatchObject({ kind: 'at', resumeAt: before.resumeAt });
    expect(waiting.schedule.revision).toBeGreaterThan(before.revision);
    expect(f.readState().recovery.acceptedConfigRevisions).toContain('r-quota-fix');
  });

  it('intervention and configuration preserve failure history and quota curve', async () => {
    const f = await makeFixture();
    await failOnce(f, 'quota');
    const admission = await f.controller.begin({
      requestKey: 'fp', facts: facts({ interventionIds: ['m1'], configurationRevision: 'r1' }),
    });
    if (admission.kind !== 'admitted') throw new Error('expected admitted');
    const saved = f.readState();
    expect(saved.recovery.failures).toHaveLength(1);
    expect(saved.providers[0]).toMatchObject({
      status: 'waiting', retryAt: T0 + 120_000, consecutiveFailures: 1,
    });
    expect(saved.recovery.invocations[0]).toMatchObject({ probeOnly: true, allowBreakerProbe: true });
  });

  it('all repeated facts are idempotent waiting without a new batch or admission', async () => {
    const f = await makeFixture();
    await failOnce(f, 'permanent', {
      inputFacts: facts({ interventionIds: ['m1'], configurationRevision: 'r1', startupId: 'boot-1' }),
    });
    const before = f.readState();
    const replay = await f.controller.begin({
      requestKey: 'fp', facts: facts({ interventionIds: ['m1'], configurationRevision: 'r1', startupId: 'boot-1' }),
    });
    expect(replay.kind).toBe('waiting');
    expect(f.readState()).toEqual(before);
  });

  it('startup is audited but does not shorten a permanent at hold', async () => {
    const f = await makeFixture();
    await failOnce(f, 'permanent');
    const startup = await f.controller.begin({ requestKey: 'fp', facts: facts({ startupId: 'boot-1' }) });
    expect(startup.kind).toBe('waiting');
    expect(f.readState().recovery.lastStartupProbeId).toBe('boot-1');
    expect(f.readState().providers[0]).toMatchObject({ status: 'waiting', retryAt: T0 + 300_000 });

    expect((await f.controller.begin({ requestKey: 'fp', facts: facts({ startupId: 'boot-2' }) })).kind).toBe('waiting');
    f.advance(300_000);
    const timed = await f.controller.begin({ requestKey: 'fp', facts: facts({ startupId: 'boot-2' }) });
    expect(timed.kind).toBe('admitted');
    if (timed.kind !== 'admitted') return;
    expect(f.controller.attemptContext(timed.invocationId).probeOnly).toBe(true);
  });

  it('accepted-id windows and complete batches dedupe old, middle and latest replays', async () => {
    const f = await makeFixture();
    await failOnce(f, 'quota');
    for (let i = 0; i < 65; i++) {
      const admission = await f.controller.begin({
        requestKey: `fp-${i}`, facts: facts({ interventionIds: [`m${i}`] }),
      });
      if (admission.kind !== 'admitted') throw new Error('expected admitted');
      await f.controller.finish(admission.invocationId, admission.attemptId, 'interrupted');
    }
    expect(f.readState().recovery.acceptedInterventions).toHaveLength(64);
    expect(f.readState().recovery.acceptedInterventions).not.toContain('m0');
    const batches = f.readState().recovery.acceptedFactBatches?.length;
    for (const id of ['m0', 'm32', 'm64']) {
      expect((await f.controller.begin({
        requestKey: 'fp-replay', facts: facts({ interventionIds: [id] }),
      })).kind).toBe('waiting');
    }
    expect(f.readState().recovery.acceptedFactBatches).toHaveLength(batches!);
  });

  it('bounds failure evidence and records exactly what was dropped', async () => {
    const f = await makeFixture();
    for (let i = 0; i < 12; i++) {
      if (i > 0) f.advance(1_000);
      f.controller.noteFailure([{
        providerId: 'provider-primary', errorClass: 'transient', message: `failure-${i}`,
      }]);
    }
    const saved = f.readState().recovery;
    expect(saved.failures.map(failure => failure.message)).toEqual(
      Array.from({ length: 10 }, (_, i) => `failure-${i + 2}`),
    );
    expect(saved.failureEvidenceLoss).toEqual({
      droppedCount: 2, firstDroppedAt: new Date(T0).toISOString(), lastDroppedAt: new Date(T0 + 1_000).toISOString(),
      reason: 'bounded_retention', policyVersion: 1, recoverability: 'not_preserved_in_recovery_state',
    });
  });
});

describe('legacy read-only migration into instance state V3', () => {
  it('imports known EventLoop retry state without modifying it or writing old recovery files', async () => {
    const f = await makeFixture();
    await f.owner.close();
    fsNative.rmSync(f.statePath);
    const legacyPath = path.join(f.dir, 'status', 'llm-retry-state.json');
    const legacyRaw = JSON.stringify({
      schema_version: 2, llmRetryCount: 3, llmRetryDelayMs: 45_000,
      llmRetryPending: false, waiting: null,
    });
    fsNative.writeFileSync(legacyPath, legacyRaw);

    f.owner = f.makeOwner();
    f.controller = controllerOf(f.owner);
    expect(f.readState()).toMatchObject({
      schema_version: 3,
      recovery: {
        budget: { retryCount: 3, retryDelayMs: 45_000, quotaDelayMs: 120_000 },
        importedSources: ['status/llm-retry-state.json#schema_version=2'],
      },
    });
    expect(fsNative.readFileSync(legacyPath, 'utf8')).toBe(legacyRaw);
    expect(fsNative.existsSync(path.join(f.dir, 'status', 'llm-recovery-state.json'))).toBe(false);
  });

  it('maps legacy scoped at/on_change facts to blocking providers and derived schedules', async () => {
    const f = await makeFixture();
    await f.owner.close();
    fsNative.rmSync(f.statePath);
    const resumeAt = new Date(T0 + 90_000).toISOString();
    const legacy = createInitialRecoveryState('foreground', {
      retryCount: 2, retryDelayMs: 60_000, quotaDelayMs: 240_000,
    }, T0);
    legacy.schedule = { kind: 'at', revision: 1, resumeAt };
    legacy.providers = [{
      providerId: f.config.primary ? f.owner.getProviderIdentities()[0]! : '', errorClass: 'transient',
      at: new Date(T0).toISOString(), consecutiveFailures: 2, detail: 'offline',
    }];
    const legacyPath = path.join(f.dir, 'status', 'llm-recovery-state.json');
    const raw = JSON.stringify(legacy);
    fsNative.writeFileSync(legacyPath, raw);

    f.owner = f.makeOwner();
    f.controller = controllerOf(f.owner);
    const migrated = f.readState();
    expect(migrated.recovery.providers).toEqual([
      expect.objectContaining({ blocking: true, retryAt: resumeAt }),
    ]);
    expect(migrated.providers).toEqual([
      expect.objectContaining({
        status: 'waiting', retryAt: Date.parse(resumeAt), consecutiveFailures: 2,
        lastError: expect.objectContaining({ class: 'transient', at: T0, message: 'offline' }),
      }),
    ]);
    expect(await f.controller.inspect()).toMatchObject({ kind: 'at', resumeAt });
    expect(fsNative.readFileSync(legacyPath, 'utf8')).toBe(raw);
  });

  it('rejects an unmapped legacy turn admission instead of inventing an invocation', async () => {
    const f = await makeFixture();
    await f.owner.close();
    fsNative.rmSync(f.statePath);
    const legacy = createInitialRecoveryState('foreground', {
      retryCount: 0, retryDelayMs: 30_000, quotaDelayMs: 120_000,
    }, T0);
    legacy.activeAdmission = {
      attemptId: 'att-legacy-turn', started: false, requestKey: 'turn-fingerprint', triggerKind: 'intervention',
    };
    const legacyPath = path.join(f.dir, 'status', 'llm-recovery-state.json');
    const raw = JSON.stringify(legacy);
    fsNative.writeFileSync(legacyPath, raw);
    expect(() => f.makeOwner()).toThrow(/legacy turn admission cannot be mapped/);
    expect(fsNative.readFileSync(legacyPath, 'utf8')).toBe(raw);
  });

  it('rekeys a matching legacy provider identity once and keeps unrelated facts untouched', async () => {
    const f = await makeFixture();
    await f.owner.close();
    fsNative.rmSync(f.statePath);
    const currentConfig = { ...providerConfig('primary'), authProfile: 'oauth' as const };
    const legacyId = legacyProviderIdentity(currentConfig);
    const legacy = createInitialRecoveryState('foreground', {
      retryCount: 0, retryDelayMs: 30_000, quotaDelayMs: 120_000,
    }, T0);
    legacy.providers = [
      {
        providerId: legacyId, errorClass: 'rate_limit', at: new Date(T0).toISOString(), consecutiveFailures: 10,
        detail: 'blocked', rateLimitFailures: 10, rateLimitBlocked: true, rateLimitBlockedAt: new Date(T0).toISOString(),
      },
      {
        providerId: 'unrelated-legacy-id', errorClass: 'permanent', at: new Date(T0).toISOString(),
        consecutiveFailures: 1, detail: 'unrelated',
      },
    ];
    fsNative.writeFileSync(path.join(f.dir, 'status', 'llm-recovery-state.json'), JSON.stringify(legacy));

    f.owner = f.makeOwner(currentConfig);
    f.controller = controllerOf(f.owner);
    const migrated = f.readState();
    expect(migrated.providers[0]).toMatchObject({
      providerId: f.owner.getProviderIdentities()[0], status: 'waiting', retryAt: T0 + 300_000,
      consecutiveFailures: 10, lastError: { class: 'rate_limit', at: T0, message: 'blocked' },
    });
    expect(migrated.providers[0]).not.toHaveProperty('identityMigrationPending');
    expect(migrated.recovery.providers[0]).toMatchObject({
      providerId: f.owner.getProviderIdentities()[0], identityMigrationPending: true,
      rateLimitBlocked: true, rateLimitFailures: 10,
    });
    expect(migrated.recovery.providers[1]).toMatchObject({ providerId: 'unrelated-legacy-id' });
    expect(migrated.recovery.providers[1].identityMigrationPending).toBeUndefined();
  });

  it('configuration re-evaluates changed providers without clearing unchanged permanent facts', async () => {
    const f = await makeFixture();
    const currentId = f.owner.getProviderIdentities()[0]!;
    const state = f.readState();
    state.recovery.providers = [
      { providerId: 'old-a', errorClass: 'permanent', at: new Date(T0).toISOString(), consecutiveFailures: 3, detail: 'old', blocking: true },
      { providerId: currentId, errorClass: 'permanent', at: new Date(T0).toISOString(), consecutiveFailures: 3, detail: 'current', blocking: true },
    ];
    state.providers = ['old-a', currentId].map(providerId => ({
      providerId, status: 'waiting' as const, retryAt: T0 + 300_000, consecutiveFailures: 3,
      lastError: { class: 'permanent' as const, at: T0, message: providerId === currentId ? 'current' : 'old' },
    }));
    saveLLMInstanceState(f.fs, state);
    await restart(f);

    expect((await f.controller.begin({
      requestKey: 'fp', facts: facts({ configurationRevision: 'r1' }),
    })).kind).toBe('waiting');
    const saved = f.readState();
    expect(saved.recovery.providers).toEqual([expect.objectContaining({ providerId: currentId, consecutiveFailures: 3 })]);
    expect(saved.providers).toEqual([
      expect.objectContaining({ providerId: currentId, status: 'waiting', consecutiveFailures: 3 }),
    ]);
    expect((await f.controller.inspect()).kind).toBe('at');
  });

  it('releasing all changed permanent facts derives ready without a persisted schedule field', async () => {
    const f = await makeFixture();
    const state = f.readState();
    state.recovery.providers = ['old-a', 'old-b'].map(providerId => ({
      providerId, errorClass: 'permanent', at: new Date(T0).toISOString(),
      consecutiveFailures: 3, detail: 'old', blocking: true,
    }));
    state.providers = ['old-a', 'old-b'].map(providerId => ({
      providerId, status: 'waiting' as const, retryAt: T0 + 300_000, consecutiveFailures: 3,
      lastError: { class: 'permanent' as const, at: T0, message: 'old' },
    }));
    saveLLMInstanceState(f.fs, state);
    await restart(f);
    expect((await f.controller.begin({
      requestKey: 'fp', facts: facts({ configurationRevision: 'r1' }),
    })).kind).toBe('admitted');
    expect(f.readState().recovery.providers).toEqual([]);
    expect(f.readState().providers).toEqual([]);
    expect(f.readState().recovery).not.toHaveProperty('schedule');
    expect((await f.controller.inspect()).kind).toBe('ready');
  });
});

function wrapWriteDurability(fs: FileSystem, state: { result: AtomicWriteResult }): FileSystem {
  return new Proxy(fs, {
    get(target, prop, receiver) {
      if (prop === 'writeAtomicSync') {
        return (...args: Parameters<FileSystem['writeAtomicSync']>) => {
          target.writeAtomicSync(...args);
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
        return (...args: Parameters<FileSystem['writeAtomicSync']>) => {
          if (state.failing) throw new Error('injected write failure');
          return target.writeAtomicSync(...args);
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('unified instance durable commit barrier', () => {
  it('begin write failure leaves memory/disk unchanged and accepts the same facts after recovery', async () => {
    const write = { failing: false };
    const f = await makeFixture({ wrapFs: fs => wrapWriteFailure(fs, write) });
    const before = f.readState();
    write.failing = true;
    await expect(f.controller.begin({
      requestKey: 'fp', facts: facts({ interventionIds: ['m1'] }),
    })).rejects.toThrow(/persistence failed during begin/);
    expect(f.readState()).toEqual(before);
    expect(f.emitted.some(event => event.type === 'recovery_facts_accepted')).toBe(false);
    expect(f.emitted.some(event => event.type === 'instance_state_write_failed' && event.context === 'begin')).toBe(true);

    write.failing = false;
    expect((await f.controller.begin({
      requestKey: 'fp', facts: facts({ interventionIds: ['m1'] }),
    })).kind).toBe('admitted');
    expect(f.readState().recovery.acceptedInterventions).toContain('m1');
  });

  it('save succeeds before accepted-fact publication; restart reconstructs invocation and dedupe', async () => {
    const f = await makeFixture({
      wrapSink: sink => ({
        emit: event => {
          if (event.type === 'recovery_facts_accepted') throw new Error('crash before publish');
          sink.emit(event);
        },
      }),
    });
    await expect(f.controller.begin({
      requestKey: 'fp', facts: facts({ interventionIds: ['m1'], configurationRevision: 'r1', startupId: 'boot-1' }),
    })).rejects.toThrow('crash before publish');
    const saved = f.readState().recovery;
    expect(saved.acceptedFactBatches).toHaveLength(1);
    expect(saved.invocations).toHaveLength(1);
    expect(saved).toMatchObject({
      acceptedInterventions: ['m1'], acceptedConfigRevisions: ['r1'], lastStartupProbeId: 'boot-1',
    });

    await restart(f);
    const replay = await f.controller.begin({
      requestKey: 'fp', facts: facts({ interventionIds: ['m1'], configurationRevision: 'r1', startupId: 'boot-1' }),
    });
    expect(replay.kind).toBe('admitted');
    expect(f.readState().recovery.acceptedFactBatches).toHaveLength(1);
  });

  it('noteAttemptStarted write failure preserves the unstarted record and can be retried', async () => {
    const write = { failing: false };
    const f = await makeFixture({ wrapFs: fs => wrapWriteFailure(fs, write) });
    const admission = await f.controller.begin({ requestKey: 'fp', facts: facts() });
    if (admission.kind !== 'admitted') throw new Error('expected admitted');
    const before = f.readState();
    write.failing = true;
    expect(() => f.controller.noteAttemptStarted(admission.invocationId)).toThrow(/noteAttemptStarted/);
    expect(f.readState()).toEqual(before);
    expect(f.controller.attemptContext(admission.invocationId).attemptId).toBe(admission.attemptId);

    write.failing = false;
    f.controller.noteAttemptStarted(admission.invocationId);
    expect(f.readState().recovery.invocations[0]).toMatchObject({ started: true, startedAt: expect.any(String) });
  });

  it('noteFailure write failure publishes no schedule and permits durable resubmission', async () => {
    const write = { failing: false };
    const f = await makeFixture({ wrapFs: fs => wrapWriteFailure(fs, write) });
    const admission = await f.controller.begin({ requestKey: 'fp', facts: facts() });
    if (admission.kind !== 'admitted') throw new Error('expected admitted');
    const before = f.readState();
    const failure = {
      providerId: f.owner.getProviderIdentities()[0]!, errorClass: 'transient' as const,
      message: 'boom', invocationId: admission.invocationId, attemptId: admission.attemptId,
    };
    write.failing = true;
    expect(() => f.controller.noteFailure([failure])).toThrow(/noteFailure/);
    expect(f.readState()).toEqual(before);
    expect(f.emitted.filter(event => event.type === 'recovery_scheduled')).toHaveLength(0);
    expect(f.emitted.some(event => event.type === 'recovery_state_write_failed' && event.context === 'noteFailure')).toBe(true);

    write.failing = false;
    f.controller.noteFailure([failure]);
    const saved = f.readState();
    expect(saved.recovery.failures).toHaveLength(1);
    expect(saved.providers[0]).toMatchObject({
      status: 'waiting', retryAt: T0 + 30_000, consecutiveFailures: 1,
      lastError: { class: 'transient', message: 'boom' },
    });
    expect(f.emitted.filter(event => event.type === 'recovery_scheduled')[0]).toMatchObject({
      revision: saved.revision, scheduleKind: 'at', invocationId: admission.invocationId,
    });
  });

  it('provider success write failure does not publish ready and can be recommitted', async () => {
    const write = { failing: false };
    const f = await makeFixture({ wrapFs: fs => wrapWriteFailure(fs, write) });
    await failOnce(f, 'transient');
    f.advance(31_000);
    const admission = await f.controller.begin({ requestKey: 'fp', facts: facts() });
    if (admission.kind !== 'admitted') throw new Error('expected admitted');
    const before = f.readState();
    const readyBefore = f.emitted.filter(event => event.type === 'recovery_ready').length;

    write.failing = true;
    expect(() => recordProviderSuccess(f)).toThrow(/provider success/);
    expect(f.readState()).toEqual(before);
    expect(f.emitted.filter(event => event.type === 'recovery_ready')).toHaveLength(readyBefore);

    write.failing = false;
    recordProviderSuccess(f);
    f.controller.noteSuccess(admission.invocationId, f.owner.getProviderIdentities()[0]!);
    expect(f.readState().providers[0]).toMatchObject({ status: 'available', consecutiveFailures: 0 });
    expect(f.readState().providers[0]?.retryAt).toBeUndefined();
    expect(f.readState().recovery.providers).toEqual([]);
    expect(f.emitted.filter(event => event.type === 'recovery_ready').at(-1)).toMatchObject({
      revision: f.readState().revision, invocationId: admission.invocationId,
    });
  });

  it('finish write failure retains only that invocation; concurrent admission is still allowed', async () => {
    const write = { failing: false };
    const f = await makeFixture({ wrapFs: fs => wrapWriteFailure(fs, write) });
    const first = await f.controller.begin({ requestKey: 'fp-1', facts: facts() });
    if (first.kind !== 'admitted') throw new Error('expected admitted');
    const before = f.readState();
    write.failing = true;
    await expect(f.controller.finish(first.invocationId, first.attemptId, 'completed')).rejects.toThrow(/finish/);
    expect(f.readState()).toEqual(before);
    expect(f.emitted.filter(event => event.type === 'recovery_attempt_finished' && event.accepted)).toHaveLength(0);

    write.failing = false;
    const second = await f.controller.begin({ requestKey: 'fp-2', facts: facts() });
    expect(second.kind).toBe('admitted');
    await f.controller.finish(first.invocationId, first.attemptId, 'completed');
    expect(f.readState().recovery.invocations.map(item => item.invocationId)).toEqual([
      second.kind === 'admitted' ? second.invocationId : '',
    ]);
  });

  it.each([
    { context: 'begin', kind: 'committed_platform_limited' },
    { context: 'finish', kind: 'committed_durability_unknown' },
    { context: 'noteAttemptStarted', kind: 'committed_platform_limited' },
    { context: 'noteFailure', kind: 'committed_durability_unknown' },
    { context: 'provider_success', kind: 'committed_platform_limited' },
  ] as const)('committed $kind commits $context and emits unified instance evidence', async ({ context, kind }) => {
    const write = { result: { kind: 'durable' } as AtomicWriteResult };
    const f = await makeFixture({ wrapFs: fs => wrapWriteDurability(fs, write) });
    let admission = await f.controller.begin({ requestKey: 'fp', facts: facts() });
    if (admission.kind !== 'admitted') throw new Error('expected admitted');
    if (context === 'provider_success') {
      f.controller.noteFailure([{
        providerId: f.owner.getProviderIdentities()[0]!, errorClass: 'transient', message: 'boom',
      }]);
    }
    write.result = { kind, error: Object.assign(new Error(`injected ${context}`), { code: 'EIO' }) };
    if (context === 'begin') {
      admission = await f.controller.begin({ requestKey: 'fp-2', facts: facts() });
    } else if (context === 'finish') {
      await f.controller.finish(admission.invocationId, admission.attemptId, 'completed');
    } else if (context === 'noteAttemptStarted') {
      f.controller.noteAttemptStarted(admission.invocationId);
    } else if (context === 'noteFailure') {
      f.controller.noteFailure([{ providerId: f.owner.getProviderIdentities()[0]!, errorClass: 'transient', message: 'boom' }]);
    } else {
      recordProviderSuccess(f);
    }
    expect(f.emitted.some(event => event.type === 'instance_state_write_degraded'
      && event.context === context && event.durability === kind)).toBe(true);
    expect(f.emitted.filter(event => event.type === 'recovery_state_write_failed')).toHaveLength(0);
    expect((await f.controller.inspect()).revision).toBe(f.readState().revision);
  });
});


describe('public invocation finish barrier', () => {
  it('preserves both provider failure and finish write failure as an AggregateError', async () => {
    let failFinish = false;
    const f = await makeFixture({
      call: async () => { throw new Error('provider exploded'); },
      wrapFs: fs => new Proxy(fs, {
        get(target, prop, receiver) {
          if (prop === 'writeAtomicSync') {
            return (...args: Parameters<FileSystem['writeAtomicSync']>) => {
              const candidate = JSON.parse(String(args[1])) as LLMInstanceStateV3;
              if (failFinish && candidate.recovery.invocations.length === 0) {
                throw new Error('finish write failed');
              }
              return target.writeAtomicSync(...args);
            };
          }
          const value = Reflect.get(target, prop, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as FileSystem,
    });
    failFinish = true;
    let failure: unknown;
    try {
      await f.owner.call(CALL);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.errors[0]).toBeInstanceOf(LLMAllProvidersFailedError);
    expect((aggregate.errors[1] as Error).message).toContain('persistence failed during finish');
    expect(aggregate.cause).toBe(aggregate.errors[0]);
    expect(f.emitted.some(event => event.type === 'instance_state_write_failed'
      && event.context === 'finish' && event.reason.includes('finish write failed'))).toBe(true);
    expect(f.readState().recovery.invocations).toHaveLength(1);
  });
});
