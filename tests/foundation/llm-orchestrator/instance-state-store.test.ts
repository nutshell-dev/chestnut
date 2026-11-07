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
  type LLMInstanceStateV1,
} from '../../../src/foundation/llm-orchestrator/instance-state.js';
import type { LLMEvent } from '../../../src/foundation/llm-orchestrator/types.js';
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
    mode: 'durable', fs, providerIds: ['provider-a'], legacyProviderIds: ['provider-a'], events,
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
  it('owns revision, persists candidates atomically and reloads the same V3', async () => {
    const f = await fixture();
    const store = f.makeStore();
    const loaded = store.load();
    expect(loaded).toMatchObject({ schema_version: 3, revision: 0, providers: [] });
    expect(JSON.parse(fsNative.readFileSync(f.statePath, 'utf8'))).toMatchObject({ schema_version: 3, revision: 0 });

    const committed = store.commit('success', {
      providers: [{ providerId: 'provider-a', status: 'available', lastSuccessAt: 10, cacheValidUntil: 20 }],
      recovery: loaded.recovery,
    });
    expect(committed).toEqual({ kind: 'durable', revision: 1 });
    expect(store.revision).toBe(1);
    expect(store.state.providers[0]).toMatchObject({ providerId: 'provider-a', lastSuccessAt: 10 });
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
      providers: [{ providerId: 'provider-a', status: 'waiting', retryAt: 1_000 }],
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
      providers: [{ providerId: 'provider-a', status: 'available' }],
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
    expect(state).toMatchObject({ schema_version: 3, revision: 0 });
    expect(store.commit('ephemeral', {
      providers: [{ providerId: 'provider-a', status: 'available' }], recovery: state.recovery,
    })).toEqual({ kind: 'ephemeral', revision: 1 });
    expect(fsNative.readFileSync(f.statePath, 'utf8')).toBe('{not valid durable json');
  });
});

describe('InstanceStateStore legacy intake', () => {
  it('migrates V1 once into authoritative V3', async () => {
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
    expect(migrated).toMatchObject({ schema_version: 3, revision: 5, updatedAt: '1970-01-01T00:01:40.000Z' });
    expect(migrated.providers).toEqual([{ providerId: 'provider-a', status: 'available', consecutiveFailures: 0 }]);
    expect(JSON.parse(fsNative.readFileSync(f.statePath, 'utf8'))).toEqual(migrated);
  });

  it('does not read legacy recovery when V3 exists', async () => {
    const f = await fixture();
    const initial = f.makeStore().load();
    fsNative.writeFileSync(path.join(f.dir, 'status', 'llm-recovery-state.json'), '{broken legacy');
    expect(f.makeStore().load()).toEqual(initial);
    expect(f.emitted).toEqual([]);
  });
});
