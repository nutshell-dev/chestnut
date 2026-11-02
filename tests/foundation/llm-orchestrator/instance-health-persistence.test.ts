import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fsNative from 'node:fs';
import * as path from 'node:path';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import type { AtomicWriteResult, FileSystem } from '../../../src/foundation/fs/index.js';
import { LLMOrchestratorImpl } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import { LLMAllProvidersFailedError } from '../../../src/foundation/llm-orchestrator/errors.js';
import { LLMNetworkError } from '../../../src/foundation/llm-provider/errors.js';
import type { ProviderAdapter, ProviderConfig, LLMResponse } from '../../../src/foundation/llm-provider/index.js';
import type { LLMEvent, LLMInstanceLifecycle } from '../../../src/foundation/llm-orchestrator/types.js';
import { LLM_INSTANCE_STATE_FILE } from '../../../src/foundation/llm-orchestrator/instance-state.js';
import { cleanupTempDir, createTrackedTempDir } from '../../utils/temp.js';

const CALL = { messages: [{ role: 'user' as const, content: 'hi' }] };
const OK: LLMResponse = { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' };
const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) await cleanupTempDir(dir);
});

function config(name: string): ProviderConfig {
  return { name, apiKey: `key-${name}`, model: `model-${name}`, apiFormat: 'anthropic' };
}

function adapter(name: string, call: () => Promise<LLMResponse> = async () => OK): ProviderAdapter {
  return {
    name,
    model: `model-${name}`,
    call: vi.fn(call),
    stream: async function* () { throw new Error('stream not enabled'); },
  };
}

async function fixture() {
  const dir = await createTrackedTempDir('instance-health-');
  dirs.push(dir);
  const fs = new NodeFileSystem({ baseDir: dir });
  const emitted: LLMEvent[] = [];
  const events = { emit: (event: LLMEvent) => { emitted.push(event); } };
  const statePath = path.join(dir, 'status', LLM_INSTANCE_STATE_FILE);
  const makeOwner = (
    adapters: ProviderAdapter[],
    lifecycle: LLMInstanceLifecycle = { mode: 'durable', fs },
  ) => new LLMOrchestratorImpl({
    primary: config(adapters[0].name),
    fallbacks: adapters.slice(1).map(item => config(item.name)),
    maxAttempts: 1,
    retryDelayMs: 0,
    circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 60_000 },
    events,
    lifecycle,
    createProviderAdapter: provider => adapters.find(item => item.name === provider.name)!,
  });
  return { dir, fs, emitted, statePath, makeOwner };
}

function wrapAtomic(fs: FileSystem, write: (original: FileSystem['writeAtomicSync']) => AtomicWriteResult): FileSystem {
  return new Proxy(fs, {
    get(target, prop, receiver) {
      if (prop === 'writeAtomicSync') {
        return (...args: Parameters<FileSystem['writeAtomicSync']>) => write(target.writeAtomicSync.bind(target, ...args));
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('LLM instance health persistence', () => {
  it('restores breaker and shared failure state from the independent file', async () => {
    const f = await fixture();
    const failing = adapter('primary', async () => { throw new LLMNetworkError('primary', new Error('offline')); });
    await expect(f.makeOwner([failing]).call(CALL)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    const disk = JSON.parse(fsNative.readFileSync(f.statePath, 'utf8'));
    expect(disk.providers[0]).toMatchObject({
      breaker: { state: 'open', consecutiveFailures: 1, lastFailureClass: 'transient' },
      sharedFailure: { errorClass: 'transient', epoch: 1 },
    });

    const healthy = adapter('primary');
    const restarted = f.makeOwner([healthy]);
    expect(restarted.snapshot().providers[0]).toMatchObject({ breakerOpen: true, consecutiveFailures: 1 });
    expect(restarted.getSharedRecoveryDecision().kind).toBe('at');
    await expect(restarted.call(CALL)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    expect(healthy.call).not.toHaveBeenCalled();
  });

  it('restores lastSuccess by providerId and keeps fallback sticky after restart', async () => {
    const f = await fixture();
    const primaryFailure = adapter('primary', async () => { throw new LLMNetworkError('primary', new Error('offline')); });
    const fallback = adapter('fallback');
    await expect(f.makeOwner([primaryFailure, fallback]).call(CALL)).resolves.toBe(OK);
    expect(JSON.parse(fsNative.readFileSync(f.statePath, 'utf8')).lastSuccess).toEqual({
      providerId: expect.any(String),
    });

    const primary = adapter('primary');
    const restartedFallback = adapter('fallback');
    await expect(f.makeOwner([primary, restartedFallback]).call(CALL)).resolves.toBe(OK);
    expect(primary.call).not.toHaveBeenCalled();
    expect(restartedFallback.call).toHaveBeenCalledTimes(1);
  });

  it('keeps the original provider outcome and old memory when rename-before write fails', async () => {
    const dir = await createTrackedTempDir('instance-health-write-failure-');
    dirs.push(dir);
    const baseFs = new NodeFileSystem({ baseDir: dir });
    const fs = wrapAtomic(baseFs, () => { throw new Error('injected rename failure'); });
    const emitted: LLMEvent[] = [];
    const primary = adapter('primary');
    const owner = new LLMOrchestratorImpl({
      primary: config('primary'), maxAttempts: 1, retryDelayMs: 0,
      circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 60_000 },
      events: { emit: event => emitted.push(event) },
      lifecycle: { mode: 'durable', fs },
      createProviderAdapter: () => primary,
    });

    await expect(owner.call(CALL)).resolves.toBe(OK);
    expect(owner.getProviderInfo().name).toBe('primary');
    expect((owner as unknown as { lastSuccessProvider: unknown }).lastSuccessProvider).toBeNull();
    expect(emitted.some(event => event.type === 'instance_state_write_failed')).toBe(true);
    expect(fsNative.existsSync(path.join(dir, 'status', LLM_INSTANCE_STATE_FILE))).toBe(false);

    const failure = adapter('failure', async () => { throw new LLMNetworkError('failure', new Error('original')); });
    const failingOwner = new LLMOrchestratorImpl({
      primary: config('failure'), maxAttempts: 1, retryDelayMs: 0,
      circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 60_000 },
      events: { emit: event => emitted.push(event) },
      lifecycle: { mode: 'durable', fs },
      createProviderAdapter: () => failure,
    });
    await expect(failingOwner.call(CALL)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    expect(failingOwner.snapshot().providers[0].consecutiveFailures).toBe(0);
  });

  it('commits memory after rename and reports durability degradation', async () => {
    const dir = await createTrackedTempDir('instance-health-degraded-');
    dirs.push(dir);
    const baseFs = new NodeFileSystem({ baseDir: dir });
    const fs = wrapAtomic(baseFs, original => {
      original();
      return { kind: 'committed_durability_unknown', error: new Error('dir fsync unknown') };
    });
    const emitted: LLMEvent[] = [];
    const primary = adapter('primary');
    const owner = new LLMOrchestratorImpl({
      primary: config('primary'), maxAttempts: 1, retryDelayMs: 0,
      events: { emit: event => emitted.push(event) },
      lifecycle: { mode: 'durable', fs },
      createProviderAdapter: () => primary,
    });
    await expect(owner.call(CALL)).resolves.toBe(OK);
    expect((owner as unknown as { lastSuccessProvider: unknown }).lastSuccessProvider).not.toBeNull();
    expect(emitted.some(event => event.type === 'instance_state_write_degraded'
      && event.durability === 'committed_durability_unknown')).toBe(true);
    expect(fsNative.existsSync(path.join(dir, 'status', LLM_INSTANCE_STATE_FILE))).toBe(true);
  });

  it('persists the reload identity view before replacing runtime config', async () => {
    const f = await fixture();
    let failing = false;
    const fs = wrapAtomic(f.fs, original => {
      if (failing) throw new Error('reload write failed');
      return original();
    });
    const primary = adapter('primary');
    const next = adapter('next');
    const owner = f.makeOwner([primary, next], { mode: 'durable', fs });
    await owner.call(CALL);
    const generation = (owner as unknown as { configGeneration: number }).configGeneration;
    failing = true;

    expect(() => owner.reloadConfig({
      primary: config('next'), maxAttempts: 1, retryDelayMs: 0,
      events: { emit: () => {} },
      createProviderAdapter: () => next,
    })).toThrow('reloadConfig');
    expect(owner.getProviderInfo().name).toBe('primary');
    expect((owner as unknown as { configGeneration: number }).configGeneration).toBe(generation);
  });

  it('does not persist half-open as a successful probe across a crash', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-11-01T00:00:00.000Z');
    const f = await fixture();
    const failing = adapter('primary', async () => { throw new LLMNetworkError('primary', new Error('offline')); });
    await expect(f.makeOwner([failing]).call(CALL)).rejects.toBeInstanceOf(LLMAllProvidersFailedError);
    const restarted = f.makeOwner([adapter('primary')]);
    vi.advanceTimersByTime(61_000);

    expect((restarted as unknown as { breakerIsOpen(index: number): boolean }).breakerIsOpen(0)).toBe(false);
    expect(JSON.parse(fsNative.readFileSync(f.statePath, 'utf8')).providers[0].breaker.state).toBe('open');
    const afterCrash = f.makeOwner([adapter('primary')]);
    expect(afterCrash.snapshot().providers[0].breakerOpen).toBe(true);
  });

  it('persists reload identity filtering and clears lastSuccess', async () => {
    const f = await fixture();
    const primary = adapter('primary', async () => { throw new LLMNetworkError('primary', new Error('offline')); });
    const fallback = adapter('fallback');
    const owner = f.makeOwner([primary, fallback]);
    await owner.call(CALL);
    (owner as unknown as {
      providerIds: string[];
      noteSharedFailures(failures: Array<{ provider: string; providerId: string; error: Error }>): void;
    }).noteSharedFailures([{
      provider: 'primary',
      providerId: (owner as unknown as { providerIds: string[] }).providerIds[0],
      error: new LLMNetworkError('primary', new Error('shared offline')),
    }]);

    owner.reloadConfig({
      primary: config('primary'), maxAttempts: 1, retryDelayMs: 0,
      circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 60_000 },
      events: { emit: () => {} },
      createProviderAdapter: () => primary,
    });
    const disk = JSON.parse(fsNative.readFileSync(f.statePath, 'utf8'));
    expect(disk.providers).toHaveLength(1);
    expect(disk.providers[0].sharedFailure.errorClass).toBe('transient');
    expect(disk.lastSuccess).toBeNull();
    expect((owner as unknown as { lastSuccessProvider: unknown }).lastSuccessProvider).toBeNull();
  });

  it('ephemeral instances never read or write the long-lived state file', async () => {
    const f = await fixture();
    fsNative.mkdirSync(path.dirname(f.statePath), { recursive: true });
    fsNative.writeFileSync(f.statePath, '{not valid durable json');
    const primary = adapter('primary');
    await expect(f.makeOwner([primary], { mode: 'ephemeral' }).call(CALL)).resolves.toBe(OK);
    expect(fsNative.readFileSync(f.statePath, 'utf8')).toBe('{not valid durable json');
  });

  it('locks durable Assembly wiring and both ephemeral CLI probe wiring sites', () => {
    const assembly = fsNative.readFileSync(
      new URL('../../../src/assembly/core-infrastructure.ts', import.meta.url), 'utf8');
    const cli = fsNative.readFileSync(
      new URL('../../../src/cli/llm-connection-check.ts', import.meta.url), 'utf8');
    expect(assembly).toContain("lifecycle: { mode: 'durable', fs: systemFs, stateDir: STATUS_SUBDIR }");
    expect(cli.match(/lifecycle: \{ mode: 'ephemeral' \}/g)).toHaveLength(2);
  });
});
