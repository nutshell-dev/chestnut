import { afterEach, describe, expect, it } from 'vitest';
import * as fsNative from 'node:fs';
import * as path from 'node:path';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import type { AtomicWriteResult, FileSystem } from '../../../src/foundation/fs/index.js';
import {
  LLMInstanceStateStore,
  type InstanceStateStoreOptions,
} from '../../../src/foundation/llm-orchestrator/instance-state-store.js';
import {
  LLM_INSTANCE_STATE_FILE,
  createEmptyLLMInstanceRecoveryState,
  type LLMInstanceStateV1,
  type LLMInstanceStateV3,
} from '../../../src/foundation/llm-orchestrator/instance-state.js';
import type { LLMEvent } from '../../../src/foundation/llm-orchestrator/types.js';
import { createInitialRecoveryState } from '../../../src/foundation/llm-orchestrator/recovery-state.js';
import { cleanupTempDir, createTrackedTempDir } from '../../utils/temp.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await cleanupTempDir(dir);
});

async function fixture() {
  const dir = await createTrackedTempDir('instance-state-store-');
  dirs.push(dir);
  const fs = new NodeFileSystem({ baseDir: dir });
  const emitted: LLMEvent[] = [];
  const events = { emit: (event: LLMEvent) => { emitted.push(event); } };
  const statePath = path.join(dir, 'status', LLM_INSTANCE_STATE_FILE);
  const makeStore = (options: Partial<InstanceStateStoreOptions> = {}) => new LLMInstanceStateStore({
    mode: 'durable', fs, providerIds: ['entry:a'], operationalIdentities: ['op-a'],
    connectionProviderIds: ['provider-a'], legacyProviderIds: ['provider-a'], events,
    now: () => 100_000,
    ...options,
  });
  return { dir, fs, emitted, events, statePath, makeStore };
}

function wrapAtomic(fs: FileSystem, write: (original: () => AtomicWriteResult) => AtomicWriteResult): FileSystem {
  return new Proxy(fs, {
    get(target, prop, receiver) {
      if (prop === 'writeAtomicSync') {
        return (...args: Parameters<FileSystem['writeAtomicSync']>) => write(() => target.writeAtomicSync(...args));
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('InstanceStateStore commits', () => {
  it('owns revision, persists candidates atomically and reloads the same V4', async () => {
    const f = await fixture();
    const store = f.makeStore();
    const loaded = store.load();
    expect(loaded).toMatchObject({ schema_version: 4, revision: 0, providers: [] });
    expect(JSON.parse(fsNative.readFileSync(f.statePath, 'utf8'))).toMatchObject({ schema_version: 4, revision: 0 });

    const committed = store.commit('success', {
      providers: [{ providerId: 'entry:a', status: 'available', lastSuccessAt: 10, cacheValidUntil: 20 }],
      recovery: loaded.recovery,
    });
    expect(committed).toEqual({ kind: 'durable', revision: 1 });
    expect(store.revision).toBe(1);
    expect(store.state.providers[0]).toMatchObject({ providerId: 'entry:a', lastSuccessAt: 10 });
    const snapshot = store.snapshot();
    expect(snapshot).toMatchObject({
      instanceId: store.state.instanceId, revision: 1,
      recovery: store.state.recovery,
      providers: [{ providerId: 'entry:a', lastSuccessAt: 10 }],
    });
    snapshot.providers[0]!.lastSuccessAt = 999;
    snapshot.recovery.invocations.push({
      invocationId: 'mutated', attemptId: 'mutated', started: false,
      requestKey: 'mutated', triggerKind: 'automatic',
    });
    expect(store.state.providers[0]?.lastSuccessAt).toBe(10);
    expect(store.state.recovery.invocations).toEqual([]);
    expect(store.commit('unchanged', {
      providers: store.state.providers,
      recovery: store.state.recovery,
    })).toEqual({ kind: 'unchanged', revision: 1 });

    expect(f.makeStore().load()).toEqual(store.state);
  });

  it('does not publish memory when the atomic write fails', async () => {
    const f = await fixture();
    let fail = false;
    const fs = wrapAtomic(f.fs, original => {
      if (fail) throw new Error('injected rename failure');
      return original();
    });
    const store = f.makeStore({ fs });
    const before = store.load();
    fail = true;
    const result = store.commit('failure', {
      providers: [{ providerId: 'entry:a', status: 'waiting', retryAt: 1_000 }],
      recovery: before.recovery,
    });
    expect(result).toMatchObject({ kind: 'failed', error: { message: 'injected rename failure' } });
    expect(store.state).toEqual(before);
    expect(store.revision).toBe(0);
    expect(f.emitted.at(-1)).toMatchObject({ type: 'instance_state_write_failed', context: 'failure' });
    expect(JSON.parse(fsNative.readFileSync(f.statePath, 'utf8')).providers).toEqual([]);
  });

  it('publishes rename-committed degraded writes before emitting durability evidence', async () => {
    const f = await fixture();
    const fs = wrapAtomic(f.fs, original => {
      original();
      return { kind: 'committed_durability_unknown', error: new Error('fsync unknown') };
    });
    const observedRevisions: number[] = [];
    let store: LLMInstanceStateStore;
    store = f.makeStore({
      fs,
      events: { emit: event => {
        f.emitted.push(event);
        if (event.type === 'instance_state_write_degraded' && event.context === 'degraded') {
          observedRevisions.push(store.revision);
        }
      } },
    });
    store.load();
    const result = store.commit('degraded', {
      providers: [{ providerId: 'entry:a', status: 'available' }],
      recovery: store.state.recovery,
    });
    expect(result).toMatchObject({ kind: 'committed_durability_unknown', revision: 1 });
    expect(store.state.providers).toHaveLength(1);
    expect(observedRevisions).toEqual([1]);
    expect(JSON.parse(fsNative.readFileSync(f.statePath, 'utf8')).providers).toHaveLength(1);
  });

  it('never performs durable IO for ephemeral state', async () => {
    const f = await fixture();
    fsNative.mkdirSync(path.dirname(f.statePath), { recursive: true });
    fsNative.writeFileSync(f.statePath, '{not valid durable json');
    const store = f.makeStore({ mode: 'ephemeral' });
    const state = store.load();
    expect(state).toMatchObject({ schema_version: 4, revision: 0 });
    expect(store.commit('ephemeral', {
      providers: [{ providerId: 'entry:a', status: 'available' }], recovery: state.recovery,
    })).toEqual({ kind: 'ephemeral', revision: 1 });
    expect(fsNative.readFileSync(f.statePath, 'utf8')).toBe('{not valid durable json');
  });
});

describe('InstanceStateStore legacy intake', () => {
  it('migrates V1 once into authoritative V4 without guessing execution identity', async () => {
    const f = await fixture();
    const legacy: LLMInstanceStateV1 = {
      schema_version: 1,
      revision: 4,
      updatedAt: '1970-01-01T00:00:01.000Z',
      providers: [{
        providerId: 'provider-a',
        breaker: { state: 'closed', consecutiveFailures: 0, lastFailureClass: null },
      }],
      lastSuccess: null,
    };
    fsNative.mkdirSync(path.dirname(f.statePath), { recursive: true });
    fsNative.writeFileSync(f.statePath, JSON.stringify(legacy));
    const migrated = f.makeStore().load();
    expect(migrated).toMatchObject({ schema_version: 4, revision: 5, updatedAt: '1970-01-01T00:01:40.000Z' });
    expect(migrated.providers).toEqual([]);
    expect(migrated.migration?.transitions).toEqual([{
      sourceProviderId: 'provider-a', classification: 'missing_execution_identity',
    }]);
    expect(JSON.parse(fsNative.readFileSync(f.statePath, 'utf8'))).toEqual(migrated);
  });

  it('preserves legacy facts, provenance, zero/absence and does not migrate V4 twice', async () => {
    const f = await fixture();
    const legacy = createInitialRecoveryState('foreground', {
      retryCount: 0, retryDelayMs: 30_000, quotaDelayMs: 120_000, // time-fixture: configuration/payload round-trip input, not an independent wait budget
    }, 1_000);
    legacy.providers = [
      {
        providerId: 'provider-a', errorClass: 'rate_limit', at: '1970-01-01T00:00:01.000Z',
        consecutiveFailures: 0, detail: 'zero is evidence', rateLimitFailures: 0,
      },
      {
        providerId: 'retired', errorClass: 'permanent', at: '1970-01-01T00:00:02.000Z',
        consecutiveFailures: 2, detail: 'retired history',
      },
    ];
    legacy.importedSources = ['status/upstream-recovery.json#schema_version=1'];
    const legacyPath = path.join(f.dir, 'status', 'llm-recovery-state.json');
    const raw = JSON.stringify(legacy);
    fsNative.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fsNative.writeFileSync(legacyPath, raw);

    const migrated = f.makeStore().load();
    expect(migrated.recovery.providers).toEqual([
      expect.objectContaining({
        providerId: 'provider-a', consecutiveFailures: 0, rateLimitFailures: 0, blocking: false,
      }),
      expect.objectContaining({ providerId: 'retired', detail: 'retired history', blocking: false }),
    ]);
    expect(migrated.recovery.providers[0]).not.toHaveProperty('rateLimitBlocked');
    expect(migrated.recovery.providers[0]).not.toHaveProperty('retryAt');
    expect(migrated.recovery.importedSources).toEqual(['status/upstream-recovery.json#schema_version=1']);
    expect(migrated.providers).toEqual([]);
    expect(migrated.migration?.transitions).toEqual(expect.arrayContaining([
      { sourceProviderId: 'provider-a', classification: 'missing_execution_identity' },
      { sourceProviderId: 'retired', classification: 'unmatched' },
    ]));
    expect(fsNative.readFileSync(legacyPath, 'utf8')).toBe(raw);

    expect(f.makeStore().load()).toEqual(migrated);
    expect(fsNative.readFileSync(legacyPath, 'utf8')).toBe(raw);
  });

  it('retains the original V1 record after migration write failure and retries the same import', async () => {
    const f = await fixture();
    const legacy: LLMInstanceStateV1 = {
      schema_version: 1,
      revision: 4,
      updatedAt: '1970-01-01T00:00:01.000Z',
      providers: [{
        providerId: 'provider-a',
        breaker: { state: 'closed', consecutiveFailures: 0, lastFailureClass: null },
      }],
      lastSuccess: null,
    };
    const raw = JSON.stringify(legacy);
    fsNative.mkdirSync(path.dirname(f.statePath), { recursive: true });
    fsNative.writeFileSync(f.statePath, raw);
    let fail = true;
    const fs = wrapAtomic(f.fs, original => {
      if (fail) throw new Error('injected migration failure');
      return original();
    });
    const store = f.makeStore({ fs });

    expect(() => store.load()).toThrow('injected migration failure');
    expect(fsNative.readFileSync(f.statePath, 'utf8')).toBe(raw);

    fail = false;
    const migrated = store.load();
    expect(migrated).toMatchObject({ schema_version: 4, revision: 5 });
    expect(migrated.providers).toEqual([]);
    expect(migrated.migration?.evidencePath).toMatch(/llm-instance-state-migration-[0-9a-f]{64}\.json$/);
    expect(f.makeStore({ fs }).load()).toEqual(migrated);
  });

  it('inherits a one-to-one V3 record only with matching execution evidence', async () => {
    const f = await fixture();
    const legacy: LLMInstanceStateV3 = {
      schema_version: 3, instanceId: 'instance-old', revision: 2, updatedAt: new Date(1_000).toISOString(),
      providers: [{
        providerId: 'old-connection', operationalIdentity: 'op-a', status: 'waiting', retryAt: 50_000,
        lastSuccessAt: 10, cacheValidUntil: 20, consecutiveFailures: 3,
      }],
      recovery: {
        ...createEmptyLLMInstanceRecoveryState(),
        providers: [{
          providerId: 'old-connection', errorClass: 'quota', at: new Date(1_000).toISOString(),
          consecutiveFailures: 3, detail: 'old detail', blocking: true,
        }],
        failures: [{
          at: new Date(1_000).toISOString(), providerId: 'old-connection', errorClass: 'quota', message: 'old detail',
        }],
      },
    };
    const raw = JSON.stringify(legacy);
    fsNative.mkdirSync(path.dirname(f.statePath), { recursive: true });
    fsNative.writeFileSync(f.statePath, raw);
    const migrated = f.makeStore({ connectionProviderIds: ['old-connection'] }).load();
    expect(migrated).toMatchObject({ schema_version: 4, instanceId: 'instance-old', revision: 3 });
    expect(migrated.providers).toEqual([{
      providerId: 'entry:a', operationalIdentity: 'op-a', status: 'waiting', retryAt: 50_000,
      lastSuccessAt: 10, cacheValidUntil: 20, consecutiveFailures: 3,
    }]);
    expect(migrated.recovery.providers[0]?.providerId).toBe('old-connection');
    expect(migrated.recovery.failures[0]?.providerId).toBe('old-connection');
    expect(migrated.migration?.transitions).toEqual([{
      sourceProviderId: 'old-connection', classification: 'inherited', targetProviderId: 'entry:a',
    }]);
    const evidence = JSON.parse(fsNative.readFileSync(path.join(f.dir, migrated.migration!.evidencePath), 'utf8'));
    expect(evidence.sources[0].content).toEqual(legacy);
    expect(evidence.candidates).toEqual([{
      providerId: 'entry:a', connectionProviderId: 'old-connection',
      legacyProviderId: 'provider-a', operationalIdentity: 'op-a',
    }]);
    expect(f.makeStore({ connectionProviderIds: ['old-connection'] }).load()).toEqual(migrated);
  });

  it('does not copy an ambiguous old connection to multiple current entries', async () => {
    const f = await fixture();
    const legacy: LLMInstanceStateV3 = {
      schema_version: 3, instanceId: 'instance-old', revision: 0, updatedAt: new Date(1_000).toISOString(),
      providers: [{ providerId: 'shared', operationalIdentity: 'op-a', status: 'waiting', retryAt: 50_000 }],
      recovery: createEmptyLLMInstanceRecoveryState(),
    };
    fsNative.mkdirSync(path.dirname(f.statePath), { recursive: true });
    fsNative.writeFileSync(f.statePath, JSON.stringify(legacy));
    const migrated = f.makeStore({
      providerIds: ['entry:a', 'entry:b'], operationalIdentities: ['op-a', 'op-b'],
      connectionProviderIds: ['shared', 'shared'], legacyProviderIds: ['shared', 'shared'],
    }).load();
    expect(migrated.providers).toEqual([]);
    expect(migrated.migration?.transitions).toEqual([{ sourceProviderId: 'shared', classification: 'ambiguous' }]);
  });

  it('writes evidence before replacing legacy state and leaves the old disk unchanged on evidence failure', async () => {
    const f = await fixture();
    const legacy: LLMInstanceStateV3 = {
      schema_version: 3, instanceId: 'instance-old', revision: 0, updatedAt: new Date(1_000).toISOString(),
      providers: [{ providerId: 'provider-a', status: 'waiting', retryAt: 50_000 }],
      recovery: createEmptyLLMInstanceRecoveryState(),
    };
    const raw = JSON.stringify(legacy);
    fsNative.mkdirSync(path.dirname(f.statePath), { recursive: true });
    fsNative.writeFileSync(f.statePath, raw);
    const fs = wrapAtomic(f.fs, original => { throw new Error('evidence write failed'); });
    expect(() => f.makeStore({ fs }).load()).toThrow('evidence write failed');
    expect(fsNative.readFileSync(f.statePath, 'utf8')).toBe(raw);
    expect(fsNative.readdirSync(path.dirname(f.statePath))).toEqual([LLM_INSTANCE_STATE_FILE]);
  });

  it('reuses identical evidence but refuses to overwrite conflicting content', async () => {
    const f = await fixture();
    const legacy: LLMInstanceStateV3 = {
      schema_version: 3, instanceId: 'instance-old', revision: 0, updatedAt: new Date(1_000).toISOString(),
      providers: [{ providerId: 'provider-a', status: 'available' }],
      recovery: createEmptyLLMInstanceRecoveryState(),
    };
    const raw = JSON.stringify(legacy);
    fsNative.mkdirSync(path.dirname(f.statePath), { recursive: true });
    fsNative.writeFileSync(f.statePath, raw);
    const migrated = f.makeStore().load();
    const evidencePath = path.join(f.dir, migrated.migration!.evidencePath);
    const evidenceRaw = fsNative.readFileSync(evidencePath, 'utf8');

    // A crash after evidence but before the state rename retries the exact content-addressed write.
    fsNative.writeFileSync(f.statePath, raw);
    expect(f.makeStore().load().migration?.evidencePath).toBe(migrated.migration!.evidencePath);
    expect(fsNative.readFileSync(evidencePath, 'utf8')).toBe(evidenceRaw);

    fsNative.writeFileSync(f.statePath, raw);
    fsNative.writeFileSync(evidencePath, '{different');
    expect(() => f.makeStore().load()).toThrow('Conflicting LLM instance migration evidence');
    expect(fsNative.readFileSync(evidencePath, 'utf8')).toBe('{different');
    expect(fsNative.readFileSync(f.statePath, 'utf8')).toBe(raw);
  });

  it('reconciles only changed execution versions on V4 construction', async () => {
    const f = await fixture();
    const options = {
      providerIds: ['entry:a', 'entry:b'], operationalIdentities: ['op-a', 'op-b'],
      connectionProviderIds: ['old-a', 'old-b'], legacyProviderIds: ['old-a', 'old-b'],
    };
    const store = f.makeStore(options);
    const empty = store.load();
    store.commit('failures', {
      providers: [
        { providerId: 'entry:a', status: 'waiting', retryAt: 100, lastSuccessAt: 1, cacheValidUntil: 2, consecutiveFailures: 2 },
        { providerId: 'entry:b', status: 'waiting', retryAt: 200, consecutiveFailures: 3 },
      ],
      recovery: empty.recovery,
    });
    const before = store.state;
    const restarted = f.makeStore({ ...options, operationalIdentities: ['op-new', 'op-b'] }).load();
    expect(restarted.revision).toBe(before.revision + 1);
    expect(restarted.providers).toEqual([
      {
        providerId: 'entry:a', operationalIdentity: 'op-new', status: 'available',
        previousOperationalIdentity: 'op-a', operationalChangeReason: 'operational_identity_changed',
      },
      { providerId: 'entry:b', operationalIdentity: 'op-b', status: 'waiting', retryAt: 200, consecutiveFailures: 3 },
    ]);
  });

  it('does not read legacy recovery when V4 exists', async () => {
    const f = await fixture();
    const initial = f.makeStore().load();
    fsNative.writeFileSync(path.join(f.dir, 'status', 'llm-recovery-state.json'), '{broken legacy');
    expect(f.makeStore().load()).toEqual(initial);
    expect(f.emitted).toEqual([]);
  });
});
