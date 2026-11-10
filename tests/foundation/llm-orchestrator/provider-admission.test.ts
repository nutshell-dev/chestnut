import { describe, expect, it } from 'vitest';
import {
  LLMProviderAdmission,
  type ProviderAdmissionInput,
} from '../../../src/foundation/llm-orchestrator/provider-admission.js';
import {
  LLM_PROVIDER_SELECTION_TTL_MS,
  LLM_RECOVERY_RETRY_INITIAL_DELAY_MS,
} from '../../../src/foundation/llm-orchestrator/defaults.js';
import type { LLMProviderRecoveryState } from '../../../src/foundation/llm-orchestrator/instance-state.js';

const admission = new LLMProviderAdmission();

function input(providers: LLMProviderRecoveryState[], nowMs: number): ProviderAdmissionInput {
  return { providerIds: ['primary', 'fallback-a', 'fallback-b'], providers, nowMs };
}

describe('ProviderAdmission selection', () => {
  it('keeps a valid sticky fallback ahead of an available primary and uses a strict cache boundary', () => {
    const fallback: LLMProviderRecoveryState = {
      providerId: 'fallback-a', status: 'available', lastSuccessAt: 100, cacheValidUntil: 1_000,
    };
    expect(admission.choose(input([
      { providerId: 'primary', status: 'available' }, fallback,
    ], 999))).toEqual({
      primaryAvailable: true,
      stickyProviderId: 'fallback-a',
      orderedProviderIds: ['fallback-a', 'primary', 'fallback-b'],
    });

    const waitingPrimary: LLMProviderRecoveryState = { providerId: 'primary', status: 'waiting', retryAt: 500 };
    expect(admission.choose(input([waitingPrimary, fallback], 999))).toEqual({
      primaryAvailable: false,
      stickyProviderId: 'fallback-a',
      orderedProviderIds: ['fallback-a', 'primary', 'fallback-b'],
    });
    expect(admission.choose(input([waitingPrimary, fallback], 1_000))).toEqual({
      primaryAvailable: false,
      orderedProviderIds: ['primary', 'fallback-a', 'fallback-b'],
    });
  });

  it('does not revive an older fallback cache when the latest sticky candidate has failed', () => {
    expect(admission.choose(input([
      { providerId: 'primary', status: 'available' },
      { providerId: 'fallback-a', status: 'available', lastSuccessAt: 100, cacheValidUntil: 5_000 },
      {
        providerId: 'fallback-b', status: 'waiting', retryAt: 5_000,
        lastSuccessAt: 200, cacheValidUntil: 5_000,
      },
    ], 1_000))).toEqual({
      primaryAvailable: true,
      orderedProviderIds: ['primary', 'fallback-a', 'fallback-b'],
    });
  });

  it('uses only the latest success fact as the sticky source without mutating input', () => {
    const providers = [
      { providerId: 'primary', status: 'waiting', retryAt: 2_000 },
      { providerId: 'fallback-a', status: 'available', lastSuccessAt: 100, cacheValidUntil: 5_000 },
      { providerId: 'fallback-b', status: 'available', lastSuccessAt: 200, cacheValidUntil: 5_000 },
    ] satisfies LLMProviderRecoveryState[];
    const frozen = Object.freeze(providers.map(provider => Object.freeze({ ...provider })));
    const before = structuredClone(providers);
    expect(admission.choose({ providerIds: Object.freeze(['primary', 'fallback-a', 'fallback-b']), providers: frozen, nowMs: 1_000 }))
      .toMatchObject({ stickyProviderId: 'fallback-b', orderedProviderIds: ['fallback-b', 'primary', 'fallback-a'] });
    expect(providers).toEqual(before);
  });
});

describe('ProviderAdmission health transitions', () => {
  it('shares the same retryAt eligibility with probes and real calls', () => {
    expect(admission.canProbe({ providerId: 'p', status: 'available' }, 100)).toBe(true);
    expect(admission.canProbe({ providerId: 'p', status: 'waiting' }, 100)).toBe(false);
    expect(admission.canProbe({ providerId: 'p', status: 'waiting', retryAt: 101 }, 100)).toBe(false);
    expect(admission.canProbe({ providerId: 'p', status: 'waiting', retryAt: 100 }, 100)).toBe(true);
  });

  it('preserves backoff, Retry-After and quota reset rules with immutable input', () => {
    const initial: LLMProviderRecoveryState = { providerId: 'p', status: 'available', lastSuccessAt: 1, cacheValidUntil: 2 };
    Object.freeze(initial);
    const transient = admission.recordFailure(initial, {
      errorClass: 'transient', message: 'offline', occurredAtMs: 10_000,
    });
    expect(transient).toMatchObject({
      status: 'waiting', consecutiveFailures: 1,
      retryAt: 10_000 + LLM_RECOVERY_RETRY_INITIAL_DELAY_MS,
      lastSuccessAt: 1, cacheValidUntil: 2,
      lastError: { class: 'transient', at: 10_000, message: 'offline' },
    });
    expect(initial).toEqual({ providerId: 'p', status: 'available', lastSuccessAt: 1, cacheValidUntil: 2 });

    const rateLimited = admission.recordFailure(transient, {
      errorClass: 'rate_limit', message: 'limited', occurredAtMs: 20_000, retryAfterSec: 90,
    });
    expect(rateLimited.retryAt).toBe(110_000);
    expect(rateLimited.consecutiveFailures).toBe(2);

    const quota = admission.recordFailure(initial, {
      errorClass: 'quota', message: 'quota', occurredAtMs: 30_000, resetAtMs: 900_000,
    });
    expect(quota.retryAt).toBe(900_000);
  });

  it('clears health on success and refreshes selection cache only for business success', () => {
    const waiting: LLMProviderRecoveryState = {
      providerId: 'p', status: 'waiting', retryAt: 10_000, consecutiveFailures: 3,
      lastSuccessAt: 100, cacheValidUntil: 200,
      lastError: { class: 'transient', at: 50, message: 'offline' },
    };
    const probe = admission.recordSuccess(waiting, { nowMs: 1_000, updateSelection: false });
    expect(probe).toMatchObject({
      status: 'available', consecutiveFailures: 0, lastSuccessAt: 100, cacheValidUntil: 200,
    });
    expect(probe.retryAt).toBeUndefined();

    const business = admission.recordSuccess(waiting, { nowMs: 1_000 });
    expect(business).toMatchObject({
      status: 'available', consecutiveFailures: 0,
      lastSuccessAt: 1_000, cacheValidUntil: 1_000 + LLM_PROVIDER_SELECTION_TTL_MS,
    });
    expect(waiting.status).toBe('waiting');
  });
});
