import { afterEach, describe, expect, it } from 'vitest';
import * as fsNative from 'node:fs';
import * as path from 'node:path';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import type { AtomicWriteResult, FileSystem } from '../../../src/foundation/fs/index.js';
import {
  createEmptyLLMInstanceRecoveryState,
  createEmptyLLMInstanceState,
  LLM_INSTANCE_STATE_FILE,
  loadLLMInstanceState,
  saveLLMInstanceState,
  upgradeLLMInstanceState,
  type LLMInstanceStateV1,
  type LLMInstanceStateV2,
  type LLMInstanceStateV3,
} from '../../../src/foundation/llm-orchestrator/instance-state.js';
import { cleanupTempDir, createTrackedTempDir } from '../../utils/temp.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await cleanupTempDir(dir);
});

async function fixture() {
  const dir = await createTrackedTempDir('instance-state-');
  dirs.push(dir);
  return { dir, fs: new NodeFileSystem({ baseDir: dir }) };
}

function validState(): LLMInstanceStateV3 {
  return {
    ...createEmptyLLMInstanceState('instance-a'),
    revision: 2,
    updatedAt: '2026-11-01T00:00:00.000Z',
    providers: [
      {
        providerId: 'provider-a',
        status: 'waiting',
        retryAt: 30_000,
        lastError: {
          class: 'rate_limit',
          at: 10_000,
          message: 'limited',
          providerLabel: 'Provider A',
          retryAfterSec: 20,
          quotaResetAtMs: 30_000,
          migrationSources: ['test-migration'],
        },
        lastSuccessAt: 5_000,
        cacheValidUntil: 6_000,
        consecutiveFailures: 2,
      },
      { providerId: 'provider-b', status: 'available' },
    ],
  };
}

function validV2State(): LLMInstanceStateV2 {
  return {
    schema_version: 2,
    instanceId: 'instance-v2',
    revision: 7,
    updatedAt: '1970-01-01T00:00:04.000Z',
    providers: [
      {
        providerId: 'provider-a',
        breaker: { state: 'open', consecutiveFailures: 2, openedAtMs: 10, lastFailureClass: 'transient' },
        sharedFailure: { errorClass: 'transient', floorMs: 20_000 },
      },
      {
        providerId: 'provider-b',
        breaker: { state: 'closed', consecutiveFailures: 0, lastFailureClass: null },
      },
    ],
    lastSuccess: null,
    recovery: {
      ...createEmptyLLMInstanceRecoveryState(),
      providers: [
        {
          providerId: 'provider-a',
          errorClass: 'rate_limit',
          at: '1970-01-01T00:00:01.000Z',
          consecutiveFailures: 5,
          detail: 'recovery rate limit',
          providerLabel: 'Provider A',
          blocking: true,
          retryAt: '1970-01-01T00:00:30.000Z',
        },
        {
          providerId: 'provider-b',
          errorClass: 'quota',
          at: '1970-01-01T00:00:02.000Z',
          consecutiveFailures: 1,
          detail: 'quota exhausted',
          blocking: true,
          rateLimitBlocked: true,
          rateLimitBlockedAt: '1970-01-01T00:00:02.000Z',
        },
        {
          providerId: 'provider-c',
          errorClass: 'permanent',
          at: '1970-01-01T00:00:03.000Z',
          consecutiveFailures: 0,
          detail: 'historical configuration error',
          blocking: false,
        },
      ],
      failures: [{
        at: '1970-01-01T00:00:01.000Z',
        providerId: 'provider-a',
        errorClass: 'rate_limit',
        message: 'recovery rate limit',
      }],
      invocations: [{
        invocationId: 'invocation-a',
        attemptId: 'attempt-a',
        started: false,
        requestKey: 'request-a',
        triggerKind: 'retry',
      }],
      importedSources: ['legacy-import'],
      acceptedFactBatches: [{ revision: 7, interventionIds: ['intervention-a'] }],
    },
  };
}

describe('LLM instance state V3', () => {
  it('treats a missing file as empty and round-trips valid state', async () => {
    const { dir, fs } = await fixture();
    expect(loadLLMInstanceState(fs)).toEqual({ kind: 'missing' });
    expect(createEmptyLLMInstanceState()).toMatchObject({ schema_version: 3, revision: 0, providers: [], recovery: { invocations: [] } });
    expect(createEmptyLLMInstanceState()).not.toHaveProperty('lastSuccess');
    expect(saveLLMInstanceState(fs, validState()).kind).toBe('durable');
    expect(loadLLMInstanceState(fs)).toEqual({ kind: 'ok', state: validState() });
    expect(fsNative.existsSync(path.join(dir, 'status', LLM_INSTANCE_STATE_FILE))).toBe(true);
  });

  it('uses an explicitly injected state directory', async () => {
    const { dir, fs } = await fixture();
    saveLLMInstanceState(fs, validState(), 'custom-status');
    expect(fsNative.existsSync(path.join(dir, 'custom-status', LLM_INSTANCE_STATE_FILE))).toBe(true);
    expect(loadLLMInstanceState(fs, 'custom-status').kind).toBe('ok');
  });

  it('preserves the atomic write three-state result', async () => {
    const { fs } = await fixture();
    const outcomes: AtomicWriteResult[] = [
      { kind: 'durable' },
      { kind: 'committed_platform_limited', error: new Error('limited') },
      { kind: 'committed_durability_unknown', error: new Error('unknown') },
    ];
    for (const outcome of outcomes) {
      const wrapped = new Proxy(fs, {
        get(target, prop, receiver) {
          if (prop === 'writeAtomicSync') return () => outcome;
          const value = Reflect.get(target, prop, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as FileSystem;
      expect(saveLLMInstanceState(wrapped, validState())).toBe(outcome);
    }
  });

  it('rejects corrupt or unknown-schema input without rewriting it', async () => {
    const { dir, fs } = await fixture();
    const file = path.join(dir, 'status', LLM_INSTANCE_STATE_FILE);
    fsNative.mkdirSync(path.dirname(file), { recursive: true });
    for (const [raw, reason] of [
      ['{bad json', 'parse_failed'],
      [JSON.stringify({ ...validState(), schema_version: 4 }), 'schema_invalid'],
    ] as const) {
      fsNative.writeFileSync(file, raw);
      expect(loadLLMInstanceState(fs)).toMatchObject({ kind: 'unusable', reason });
      expect(fsNative.readFileSync(file, 'utf8')).toBe(raw);
    }
  });

  it('strictly rejects invalid V3 numbers, identities and cross-field constraints', async () => {
    const { dir, fs } = await fixture();
    const file = path.join(dir, 'status', LLM_INSTANCE_STATE_FILE);
    fsNative.mkdirSync(path.dirname(file), { recursive: true });
    const invalid = [
      { ...validState(), revision: -1 },
      { ...validState(), updatedAt: 'not-a-time' },
      { ...validState(), lastSuccess: null },
      { ...validState(), providers: [validState().providers[0], validState().providers[0]] },
      { ...validState(), providers: [{ ...validState().providers[0], retryAt: undefined }] },
      { ...validState(), providers: [{ ...validState().providers[1], retryAt: 1 }] },
      { ...validState(), providers: [{ ...validState().providers[1], lastSuccessAt: 10 }] },
      { ...validState(), providers: [{ ...validState().providers[1], cacheValidUntil: 10 }] },
      { ...validState(), providers: [{ ...validState().providers[1], lastSuccessAt: 10, cacheValidUntil: 9 }] },
      {
        ...validState(),
        providers: [{
          ...validState().providers[0],
          lastError: { ...validState().providers[0].lastError!, retryAfterSec: Number.NaN },
        }],
      },
      {
        ...validState(),
        providers: [{
          ...validState().providers[0],
          lastError: { ...validState().providers[0].lastError!, class: 'not-an-error-class' },
        }],
      },
    ];
    for (const state of invalid) {
      const raw = JSON.stringify(state);
      fsNative.writeFileSync(file, raw);
      expect(loadLLMInstanceState(fs)).toMatchObject({ kind: 'unusable', reason: 'schema_invalid' });
      expect(fsNative.readFileSync(file, 'utf8')).toBe(raw);
    }
  });

  it('loads V2 as legacy and merges breaker, shared failure and recovery facts once per provider', async () => {
    const { dir, fs } = await fixture();
    const legacy = validV2State();
    const original = structuredClone(legacy);
    const file = path.join(dir, 'status', LLM_INSTANCE_STATE_FILE);
    fsNative.mkdirSync(path.dirname(file), { recursive: true });
    const raw = JSON.stringify(legacy);
    fsNative.writeFileSync(file, raw);

    expect(loadLLMInstanceState(fs)).toEqual({ kind: 'legacy', state: legacy });
    const upgraded = upgradeLLMInstanceState(legacy, undefined, 100_000);
    expect(upgraded).toMatchObject({
      schema_version: 3,
      instanceId: 'instance-v2',
      revision: 8,
      updatedAt: '1970-01-01T00:01:40.000Z',
    });
    expect(upgraded.providers).toHaveLength(3);
    expect(new Set(upgraded.providers.map(provider => provider.providerId)).size).toBe(3);

    const providerA = upgraded.providers.find(provider => provider.providerId === 'provider-a');
    expect(providerA).toMatchObject({
      status: 'waiting',
      retryAt: 30_000,
      consecutiveFailures: 5,
      lastError: {
        class: 'rate_limit',
        at: 1_000,
        message: 'recovery rate limit',
        providerLabel: 'Provider A',
      },
    });
    expect(providerA?.lastError?.migrationSources).toEqual(expect.arrayContaining([
      expect.stringContaining('breaker'),
      expect.stringContaining('sharedFailure'),
      expect.stringContaining('recovery.providers'),
    ]));

    expect(upgraded.providers.find(provider => provider.providerId === 'provider-b')).toMatchObject({
      status: 'waiting',
      retryAt: 400_000,
      consecutiveFailures: 1,
      lastError: { class: 'quota', at: 2_000, message: 'quota exhausted' },
    });
    expect(upgraded.providers.find(provider => provider.providerId === 'provider-c')).toMatchObject({
      status: 'available',
      consecutiveFailures: 0,
      lastError: { class: 'permanent', at: 3_000, message: 'historical configuration error' },
    });
    expect(upgraded.providers.find(provider => provider.providerId === 'provider-c')).not.toHaveProperty('retryAt');
    expect(upgraded.recovery).toEqual(legacy.recovery);
    expect(legacy).toEqual(original);
    expect(fsNative.readFileSync(file, 'utf8')).toBe(raw);
  });

  it('does not renew legacy cache and only maps complete existing timestamps', () => {
    const withoutTimes = validV2State();
    withoutTimes.lastSuccess = { providerId: 'provider-a' };
    const noCache = upgradeLLMInstanceState(withoutTimes, undefined, 1_000_000);
    expect(noCache.providers.find(provider => provider.providerId === 'provider-a')).not.toHaveProperty('lastSuccessAt');
    expect(noCache.providers.find(provider => provider.providerId === 'provider-a')).not.toHaveProperty('cacheValidUntil');

    const withTimes = validV2State();
    withTimes.lastSuccess = { providerId: 'provider-a', lastUsedAt: 1_000, cacheValidUntil: 2_000 };
    const cached = upgradeLLMInstanceState(withTimes, undefined, 1_000_000);
    expect(cached.providers.find(provider => provider.providerId === 'provider-a')).toMatchObject({
      lastSuccessAt: 1_000,
      cacheValidUntil: 2_000,
    });
  });

  it('keeps V1 health migration behavior without inventing cache or current providers', () => {
    const health: LLMInstanceStateV1 = {
      schema_version: 1,
      revision: 3,
      updatedAt: '1970-01-01T00:00:04.000Z',
      providers: [{
        providerId: 'provider-a',
        breaker: { state: 'closed', consecutiveFailures: 0, lastFailureClass: null },
      }],
      lastSuccess: { providerId: 'provider-a' },
    };
    const upgraded = upgradeLLMInstanceState(health, undefined, 100_000, ['provider-a', 'provider-new']);
    expect(upgraded.schema_version).toBe(3);
    expect(upgraded.providers).toEqual([{ providerId: 'provider-a', status: 'available', consecutiveFailures: 0 }]);
    expect(upgraded.providers.some(provider => provider.providerId === 'provider-new')).toBe(false);
  });

  it('fails closed on duplicate or lossy migration inputs', () => {
    const duplicate = validV2State();
    duplicate.recovery.providers.push(duplicate.recovery.providers[0]);
    expect(() => upgradeLLMInstanceState(duplicate, undefined, 100_000)).toThrow(/duplicate instance recovery provider/);

    const invalidCache = validV2State();
    invalidCache.lastSuccess = { providerId: 'provider-a', lastUsedAt: 2_000, cacheValidUntil: 1_000 };
    expect(() => upgradeLLMInstanceState(invalidCache, undefined, 100_000)).toThrow(/invalid cache times/);
  });
});
