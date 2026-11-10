/**
 * Phase 1826 Z1–Z4 回归，Phase 2055 迁移到 owner 公共 call/stream 与内部 invocation controller。
 * 不再构造 session，也不调用旧 callWithinRecovery/streamWithinRecovery。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createLLMOrchestrator } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import {
  LLMRecoveryControllerImpl,
  requestKeyForCall,
  type LLMOrchestratorOwner,
} from '../../../src/foundation/llm-orchestrator/recovery.js';
import { LLMRecoveryWaitRequiredError } from '../../../src/foundation/llm-orchestrator/errors.js';
import type { LLMEventSink, LLMRecoveryFacts } from '../../../src/foundation/llm-orchestrator/index.js';
import type { ProviderAdapter, ProviderConfig, LLMResponse } from '../../../src/foundation/llm-provider/index.js';
import { LLMNetworkError, LLMQuotaError, LLMRateLimitError } from '../../../src/foundation/llm-provider/errors.js';
import { internalsOf } from './test-internals.js';

const T0 = Date.parse('2026-09-10T00:00:00.000Z');
const OK_RESPONSE: LLMResponse = { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' };
const OPTIONS = { messages: [{ role: 'user' as const, content: 'test' }] };
const QUOTA_ERROR = () => new LLMQuotaError('p', 'weekly usage limit quota reached');

function providerConfig(name: string): ProviderConfig {
  return { name, apiKey: `key-${name}`, model: `model-${name}`, temperature: 0, timeoutMs: 1_000, apiFormat: 'anthropic' };
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
  primaryError?: () => Error;
  fallbackResponse?: () => LLMResponse;
  breaker?: boolean;
  maxAttempts?: number;
}

async function makeFixture(opts: FixtureOpts = {}) {
  const dir = await createTrackedTempDir('recovery-zk-');
  cleanupDirs.push(dir);
  const fs = new NodeFileSystem({ baseDir: dir });
  const events: LLMEventSink = { emit: () => {} };
  let count = 0;
  const errors = opts.primaryError ?? (() => new LLMNetworkError('p', new Error('offline')));
  const failAdapter: ProviderAdapter = {
    name: 'primary', model: 'model-primary',
    call: async () => { count++; throw errors(); },
    stream: async function* () { count++; throw errors(); },
  };
  const fallbackAdapter: ProviderAdapter = {
    name: 'fallback', model: 'model-fallback',
    call: async () => { count++; return (opts.fallbackResponse ?? (() => OK_RESPONSE))(); },
    stream: async function* () {
      count++;
      const response = (opts.fallbackResponse ?? (() => OK_RESPONSE))();
      yield { type: 'text_delta' as const, delta: response.content[0] && 'text' in response.content[0] ? response.content[0].text : '' };
      yield { type: 'done' as const, stopReason: 'end_turn' };
    },
  };
  const makeOwner = () => {
    const owner = createLLMOrchestrator({
      lifecycle: { mode: 'durable', fs },
      primary: providerConfig('primary'),
      ...(opts.fallbackResponse ? { fallbacks: [providerConfig('fallback')] } : {}),
      maxAttempts: opts.maxAttempts ?? 3,
      retryDelayMs: 0,
      events,
      createProviderAdapter: config => config.name === 'fallback' ? fallbackAdapter : failAdapter,
      ...(opts.breaker ? { circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 60_000 } } : {}),
    });
    owners.push(owner);
    return owner;
  };
  const owner = makeOwner();
  return {
    owner, makeOwner,
    controller: () => (owner as unknown as { recoveryController: LLMRecoveryControllerImpl }).recoveryController,
    calls: () => count,
    advance: (ms: number) => { vi.setSystemTime(Date.now() + ms); },
    restart: async () => {
      await owner.close();
      const restarted = makeOwner();
      return restarted;
    },
  };
}

async function failedCall(owner: LLMOrchestratorOwner, stream = false, recoveryFacts?: LLMRecoveryFacts): Promise<void> {
  try {
    if (stream) {
      for await (const _chunk of owner.stream({ ...OPTIONS, ...(recoveryFacts ? { recoveryFacts } : {}) })) { void _chunk; }
    } else {
      await owner.call({ ...OPTIONS, ...(recoveryFacts ? { recoveryFacts } : {}) });
    }
  } catch { /* expected provider failure or typed waiting */ }
}

describe('Z1 deterministic errors and local retry budget', () => {
  it('quota first stream call makes one real request instead of exhausting in-call retries', async () => {
    const f = await makeFixture({ primaryError: QUOTA_ERROR });
    await failedCall(f.owner, true);
    expect(f.calls()).toBe(1);
  });

  it('quota first call is symmetric with stream', async () => {
    const f = await makeFixture({ primaryError: QUOTA_ERROR });
    await failedCall(f.owner);
    expect(f.calls()).toBe(1);
  });

  it('quota recovery probe admits after retryAt and still makes only one request per candidate', async () => {
    const f = await makeFixture({ primaryError: QUOTA_ERROR });
    await failedCall(f.owner, true);
    expect(await f.owner.inspectRecoverySchedule()).toMatchObject({
      kind: 'at', resumeAt: new Date(T0 + 120_000).toISOString(),
    });
    f.advance(120_000);
    const before = f.calls();
    await failedCall(f.owner, true);
    expect(f.calls() - before).toBe(1);
  });

  it('primary quota plus fallback success makes two requests and derives ready', async () => {
    const f = await makeFixture({ primaryError: QUOTA_ERROR, fallbackResponse: () => OK_RESPONSE });
    await expect(f.owner.call(OPTIONS)).resolves.toBe(OK_RESPONSE);
    expect(f.calls()).toBe(2);
    expect((await f.owner.inspectRecoverySchedule()).kind).toBe('ready');
  });
});

describe('Z2 explicit intervention grants a one-call breaker probe', () => {
  it('a fresh user intervention performs a real request while breaker is open', async () => {
    const f = await makeFixture({ breaker: true, maxAttempts: 1 });
    await failedCall(f.owner);
    const before = f.calls();
    await failedCall(f.owner, false, { interventionIds: ['new-user'] });
    expect(f.calls()).toBeGreaterThan(before);
  });

  it('replaying the same intervention does not admit early', async () => {
    const f = await makeFixture({ breaker: true, maxAttempts: 1 });
    await failedCall(f.owner);
    await failedCall(f.owner, false, { interventionIds: ['new-user'] });
    const before = f.calls();
    await expect(f.owner.call({ ...OPTIONS, recoveryFacts: { interventionIds: ['new-user'] } }))
      .rejects.toBeInstanceOf(LLMRecoveryWaitRequiredError);
    expect(f.calls()).toBe(before);
  });

  it('an ordinary call has no implicit scope or breaker bypass qualification', async () => {
    const f = await makeFixture({ breaker: true, maxAttempts: 1 });
    await failedCall(f.owner);
    const before = f.calls();
    await expect(f.owner.call(OPTIONS)).rejects.toBeInstanceOf(LLMRecoveryWaitRequiredError);
    expect(f.calls()).toBe(before);
  });
});

describe('Z3 Retry-After is a cross-call lower bound, not an in-call sleep', () => {
  it.each([2, 3600])('Retry-After %ss persists exactly and makes one real request', async seconds => {
    const f = await makeFixture({ primaryError: () => new LLMRateLimitError('p', seconds) });
    await failedCall(f.owner);
    expect(f.calls()).toBe(1);
    expect(await f.owner.inspectRecoverySchedule()).toMatchObject({
      kind: 'at', resumeAt: new Date(T0 + seconds * 1_000).toISOString(),
    });
  });
});

describe('Z4 invocation persistence across restart', () => {
  it('an unstarted admitted invocation resumes with the same invocation and attempt', async () => {
    const f = await makeFixture({ primaryError: QUOTA_ERROR });
    await failedCall(f.owner);
    const granted = await f.controller().begin({
      requestKey: 'y', facts: { interventionIds: ['new-user'] },
    });
    if (granted.kind !== 'admitted') throw new Error('expected admitted');

    const restored = await f.restart();
    const controller = (restored as unknown as { recoveryController: LLMRecoveryControllerImpl }).recoveryController;
    const resumed = await controller.begin({ requestKey: 'y', facts: { interventionIds: ['new-user'] } });
    expect(resumed).toMatchObject({
      kind: 'admitted', invocationId: granted.invocationId, attemptId: granted.attemptId,
    });
  });

  it('resumed invocation retains intervention qualification and replay does not requalify', async () => {
    const f = await makeFixture({ primaryError: QUOTA_ERROR, breaker: true });
    await failedCall(f.owner);
    const requestKey = requestKeyForCall(OPTIONS);
    const granted = await f.controller().begin({
      requestKey, facts: { interventionIds: ['new-user'] },
    });
    if (granted.kind !== 'admitted') throw new Error('expected admitted');

    const restored = await f.restart();
    const before = f.calls();
    // 公共 call 自带 admission：按相同 requestKey 恢复未开始 invocation，并消费其干预资格。
    await failedCall(restored, false, { interventionIds: ['new-user'] });
    expect(f.calls()).toBe(before + 1);
    await expect(restored.call({ ...OPTIONS, recoveryFacts: { interventionIds: ['new-user'] } }))
      .rejects.toBeInstanceOf(LLMRecoveryWaitRequiredError);
  });

  it('a started invocation is cleared as unknown result and never resumed as success', async () => {
    const f = await makeFixture();
    const started = await f.controller().begin({ requestKey: 'x', facts: { interventionIds: [] } });
    if (started.kind !== 'admitted') throw new Error('expected admitted');
    f.controller().noteAttemptStarted(started.invocationId);

    const restored = await f.restart();
    const controller = (restored as unknown as { recoveryController: LLMRecoveryControllerImpl }).recoveryController;
    const recovered = internalsOf(restored).recoveryController.snapshot().recovery;
    expect(recovered.invocations).toEqual([]);
    expect(recovered.failures.at(-1)).toMatchObject({
      invocationId: started.invocationId, message: expect.stringContaining('result unknown after restart'),
    });
    const next = await controller.begin({ requestKey: 'x', facts: { interventionIds: [] } });
    expect(next.kind).toBe('admitted');
    if (next.kind === 'admitted') expect(next.attemptId).not.toBe(started.attemptId);
  });
});
