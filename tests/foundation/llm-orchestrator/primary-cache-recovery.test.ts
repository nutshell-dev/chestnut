import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsNative from 'node:fs';
import * as path from 'node:path';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createLLMOrchestrator, LLMOrchestratorImpl } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import { LLM_INSTANCE_STATE_FILE } from '../../../src/foundation/llm-orchestrator/instance-state.js';
import { LLM_PROVIDER_SELECTION_TTL_MS } from '../../../src/foundation/llm-orchestrator/defaults.js';
import { providerIdentity } from '../../../src/foundation/llm-orchestrator/provider-identity.js';
import { LLMNetworkError, LLMRateLimitError } from '../../../src/foundation/llm-provider/errors.js';
import type { LLMResponse, ProviderAdapter, ProviderConfig } from '../../../src/foundation/llm-provider/index.js';
import { cleanupTempDir, createTrackedTempDir } from '../../utils/temp.js';

const OK: LLMResponse = { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' };
const CALL = { messages: [{ role: 'user' as const, content: 'hi' }] };
const dirs: string[] = [];

function config(name: string): ProviderConfig {
  return { name, apiKey: `key-${name}`, model: `model-${name}`, apiFormat: 'anthropic' };
}

function adapter(name: string, behavior: () => Promise<LLMResponse> = async () => OK): ProviderAdapter {
  return { name, model: `model-${name}`, call: vi.fn(behavior) };
}

function ephemeral(adapters: ProviderAdapter[]) {
  return new LLMOrchestratorImpl({
    lifecycle: { mode: 'ephemeral' },
    primary: config(adapters[0].name),
    fallbacks: adapters.slice(1).map(item => config(item.name)),
    maxAttempts: 1,
    retryDelayMs: 0,
    events: { emit: () => {} },
    createProviderAdapter: provider => adapters.find(item => item.name === provider.name)!,
  });
}

async function durable(adapters: ProviderAdapter[]) {
  const dir = await createTrackedTempDir('primary-cache-recovery-');
  dirs.push(dir);
  const fs = new NodeFileSystem({ baseDir: dir });
  const makeOwner = (nextAdapters = adapters) => createLLMOrchestrator({
    lifecycle: { mode: 'durable', fs },
    primary: config(nextAdapters[0].name),
    fallbacks: nextAdapters.slice(1).map(item => config(item.name)),
    maxAttempts: 1,
    retryDelayMs: 0,
    events: { emit: () => {} },
    createProviderAdapter: provider => nextAdapters.find(item => item.name === provider.name)!,
  });
  return { dir, fs, makeOwner, owner: makeOwner() };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime('2026-11-04T00:00:00.000Z');
});

afterEach(async () => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) await cleanupTempDir(dir);
});

describe('Phase2055 Step E: TTL selection cache and primary recovery', () => {
  it('keeps a valid fallback cache after a successful primary probe without refreshing selection', async () => {
    let primaryFails = true;
    const primary = adapter('primary', async () => {
      if (primaryFails) throw new LLMNetworkError('primary', new Error('offline'));
      return OK;
    });
    const fallback = adapter('fallback');
    const owner = ephemeral([primary, fallback]);
    await owner.call(CALL);
    const selection = (owner as unknown as { lastSuccessProvider: { providerId: string; lastUsedAt: number } }).lastSuccessProvider;
    const before = { providerId: selection.providerId, lastUsedAt: selection.lastUsedAt };

    primaryFails = false;
    await expect(owner.probe()).resolves.toMatchObject({ ok: true, provider: 'primary' });
    expect((owner as unknown as { lastSuccessProvider: unknown }).lastSuccessProvider).toMatchObject(before);
    expect((owner as unknown as { currentStreamingProvider: unknown }).currentStreamingProvider).toBeNull();

    await owner.call(CALL);
    expect(primary.call).toHaveBeenCalledTimes(2); // initial business failure + probe only
    expect(fallback.call).toHaveBeenCalledTimes(2);
    await owner.close();
  });

  it('re-evaluates primary on the first call after TTL and switches back when usable', async () => {
    let primaryFails = true;
    const primary = adapter('primary', async () => {
      if (primaryFails) throw new LLMNetworkError('primary', new Error('offline'));
      return OK;
    });
    const fallback = adapter('fallback');
    const owner = ephemeral([primary, fallback]);
    await owner.call(CALL);
    primaryFails = false;

    vi.setSystemTime(Date.now() + LLM_PROVIDER_SELECTION_TTL_MS);
    await owner.call(CALL);
    expect(primary.call).toHaveBeenCalledTimes(2);
    expect(fallback.call).toHaveBeenCalledTimes(1);
    expect(owner.getProviderInfo()).toMatchObject({ name: 'primary', isFallback: false });
    await owner.close();
  });

  it('continues with a usable fallback after expiry when primary is still unavailable', async () => {
    const primary = adapter('primary', async () => { throw new LLMNetworkError('primary', new Error('offline')); });
    const fallback = adapter('fallback');
    const owner = ephemeral([primary, fallback]);
    await owner.call(CALL);

    vi.setSystemTime(Date.now() + LLM_PROVIDER_SELECTION_TTL_MS);
    await owner.call(CALL);
    expect(primary.call).toHaveBeenCalledTimes(2);
    expect(fallback.call).toHaveBeenCalledTimes(2);
    await owner.close();
  });

  it('a cached fallback failure immediately re-evaluates primary, then other fallbacks in config order', async () => {
    let primaryFails = true;
    let firstFails = false;
    const primary = adapter('primary', async () => {
      if (primaryFails) throw new LLMNetworkError('primary', new Error('offline'));
      return OK;
    });
    const first = adapter('first', async () => {
      if (firstFails) throw new LLMNetworkError('first', new Error('offline'));
      return OK;
    });
    const second = adapter('second');
    const owner = ephemeral([primary, first, second]);
    await owner.call(CALL);

    firstFails = true;
    primaryFails = false;
    await owner.probe(); // primary 健康事实已恢复，但有效 fallback 缓存仍保留
    await owner.call(CALL);
    expect(primary.call).toHaveBeenCalledTimes(3); // initial failure + probe + re-evaluation
    expect(second.call).not.toHaveBeenCalled();

    firstFails = true;
    primaryFails = true;
    await owner.call(CALL);
    expect(second.call).toHaveBeenCalledTimes(1);
    await owner.close();
  });

  it('restart honors persisted cache time instead of renewing it', async () => {
    const failingPrimary = adapter('primary', async () => { throw new LLMNetworkError('primary', new Error('offline')); });
    const f = await durable([failingPrimary, adapter('fallback')]);
    await f.owner.call(CALL);
    await f.owner.close();

    const primary = adapter('primary');
    const fallback = adapter('fallback');
    const restarted = f.makeOwner([primary, fallback]);
    await restarted.call(CALL);
    expect(primary.call).not.toHaveBeenCalled();
    expect(fallback.call).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + LLM_PROVIDER_SELECTION_TTL_MS);
    await restarted.call(CALL);
    expect(primary.call).toHaveBeenCalledTimes(1);
    await restarted.close();
  });

  it('cache expiry cannot bypass a persisted Retry-After floor', async () => {
    const primary = adapter('primary', async () => { throw new LLMRateLimitError('primary', 900); });
    const fallback = adapter('fallback');
    const f = await durable([primary, fallback]);
    await f.owner.call(CALL);
    await f.owner.close();

    const healthyPrimary = adapter('primary');
    const restartedFallback = adapter('fallback');
    const restarted = f.makeOwner([healthyPrimary, restartedFallback]);
    vi.setSystemTime(Date.now() + LLM_PROVIDER_SELECTION_TTL_MS);
    await restarted.call(CALL);
    expect(healthyPrimary.call).not.toHaveBeenCalled();
    expect(restartedFallback.call).toHaveBeenCalledTimes(1);
    await restarted.close();
  });

  it('V1 lastSuccess without timestamps is not guessed into a fresh fallback cache', async () => {
    const primary = adapter('primary');
    const fallback = adapter('fallback');
    const f = await durable([primary, fallback]);
    await f.owner.close();
    const statePath = path.join(f.dir, 'status', LLM_INSTANCE_STATE_FILE);
    const now = new Date().toISOString();
    fsNative.writeFileSync(statePath, JSON.stringify({
      schema_version: 1,
      revision: 1,
      updatedAt: now,
      providers: [primary, fallback].map(item => ({
        providerId: providerIdentity(config(item.name)),
        breaker: { state: 'closed', consecutiveFailures: 0, lastFailureClass: null },
      })),
      lastSuccess: { providerId: providerIdentity(config('fallback')) },
    }));

    const restarted = f.makeOwner([primary, fallback]);
    expect((restarted as unknown as { lastSuccessProvider: unknown }).lastSuccessProvider).toBeNull();
    await restarted.call(CALL);
    expect(primary.call).toHaveBeenCalledTimes(1);
    expect(fallback.call).not.toHaveBeenCalled();
    await restarted.close();
  });
});
