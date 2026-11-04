import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsNative from 'node:fs';
import * as path from 'node:path';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createLLMOrchestrator } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import { LLM_INSTANCE_STATE_FILE } from '../../../src/foundation/llm-orchestrator/instance-state.js';
import { LLMRecoveryWaitRequiredError } from '../../../src/foundation/llm-orchestrator/errors.js';
import { LLMNetworkError, LLMRateLimitError } from '../../../src/foundation/llm-provider/errors.js';
import type { LLMResponse, ProviderAdapter, ProviderConfig } from '../../../src/foundation/llm-provider/index.js';
import type { LLMEvent } from '../../../src/foundation/llm-orchestrator/types.js';
import { cleanupTempDir, createTrackedTempDir } from '../../utils/temp.js';

const OK: LLMResponse = { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' };
const CALL = { messages: [{ role: 'user' as const, content: 'hi' }] };
const dirs: string[] = [];

function config(name: string): ProviderConfig {
  return { name, apiKey: `key-${name}`, model: `model-${name}`, apiFormat: 'anthropic' };
}

function adapter(name: string, behavior: () => Promise<LLMResponse>): ProviderAdapter {
  return {
    name,
    model: `model-${name}`,
    call: vi.fn(behavior),
    stream: vi.fn(async function* () {
      const response = await behavior();
      yield { type: 'text_delta' as const, delta: response.content[0]?.type === 'text' ? response.content[0].text : 'ok' };
      yield { type: 'done' as const, stopReason: 'end_turn' };
    }),
  };
}

async function fixture(adapters: ProviderAdapter[], maxAttempts = 3) {
  const dir = await createTrackedTempDir('retry-after-deferred-');
  dirs.push(dir);
  const fs = new NodeFileSystem({ baseDir: dir });
  const events: LLMEvent[] = [];
  const makeOwner = (nextAdapters = adapters) => createLLMOrchestrator({
    lifecycle: { mode: 'durable', fs },
    primary: config(nextAdapters[0].name),
    fallbacks: nextAdapters.slice(1).map(item => config(item.name)),
    maxAttempts,
    retryDelayMs: 0,
    events: { emit: event => { events.push(event); } },
    createProviderAdapter: provider => nextAdapters.find(item => item.name === provider.name)!,
  });
  const owner = makeOwner();
  const readState = () => JSON.parse(fsNative.readFileSync(path.join(dir, 'status', LLM_INSTANCE_STATE_FILE), 'utf8'));
  return { owner, makeOwner, events, readState };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime('2026-11-04T00:00:00.000Z');
});

afterEach(async () => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) await cleanupTempDir(dir);
});

describe('Phase2055 Step D: Retry-After defers provider instead of sleeping in-call', () => {
  it('call switches serially to the third provider and persists exact short/long floors once', async () => {
    const startedAt = Date.now();
    const primary = adapter('primary', async () => { throw new LLMRateLimitError('primary', 2); });
    const second = adapter('second', async () => { throw new LLMRateLimitError('second', 900); });
    const third = adapter('third', async () => OK);
    const f = await fixture([primary, second, third]);

    await expect(f.owner.call(CALL)).resolves.toBe(OK);
    expect(primary.call).toHaveBeenCalledTimes(1);
    expect(second.call).toHaveBeenCalledTimes(1);
    expect(third.call).toHaveBeenCalledTimes(1);
    expect(f.events.filter(event => event.type === 'retry_scheduled')).toHaveLength(0);

    const state = f.readState();
    expect(state.providers[0].sharedFailure.floorMs).toBe(startedAt + 2_000);
    expect(state.providers[1].sharedFailure.floorMs).toBe(startedAt + 900_000);
    expect(state.recovery.providers).toEqual([
      expect.objectContaining({ providerId: state.providers[0].providerId, retryAt: new Date(startedAt + 2_000).toISOString() }),
      expect.objectContaining({ providerId: state.providers[1].providerId, retryAt: new Date(startedAt + 900_000).toISOString() }),
    ]);
    expect(state.recovery.failures).toHaveLength(2);
    expect(state.lastSuccess.providerId).toBe(state.providers[2].providerId);
    await f.owner.close();
  });

  it('stream also skips in-provider Retry-After delay and records the failed candidate before fallback success', async () => {
    const startedAt = Date.now();
    const primary = adapter('primary', async () => { throw new LLMRateLimitError('primary', 7); });
    const fallback = adapter('fallback', async () => OK);
    const f = await fixture([primary, fallback]);
    const chunks = [];
    for await (const chunk of f.owner.stream(CALL)) chunks.push(chunk);

    expect(chunks.some(chunk => chunk.type === 'done')).toBe(true);
    expect(primary.stream).toHaveBeenCalledTimes(1);
    expect(fallback.stream).toHaveBeenCalledTimes(1);
    expect(f.events.filter(event => event.type === 'retry_scheduled')).toHaveLength(0);
    const state = f.readState();
    expect(state.providers[0].sharedFailure.floorMs).toBe(startedAt + 7_000);
    expect(state.recovery.failures).toHaveLength(1);
    await f.owner.close();
  });

  it('all-failed aggregation does not duplicate shared epoch, evidence or recovery budget', async () => {
    const primary = adapter('primary', async () => { throw new LLMRateLimitError('primary', 3); });
    const fallback = adapter('fallback', async () => { throw new LLMRateLimitError('fallback', 4); });
    const f = await fixture([primary, fallback]);
    await expect(f.owner.call(CALL)).rejects.toThrow();

    const state = f.readState();
    expect(state.recovery.failures).toHaveLength(2);
    expect(state.recovery.providers.map((fact: { consecutiveFailures: number }) => fact.consecutiveFailures)).toEqual([1, 1]);
    expect(state.recovery.budget).toMatchObject({ retryCount: 0, retryDelayMs: 30_000, quotaDelayMs: 120_000 });
    const internal = f.owner as unknown as { sharedFailures: Map<string, { epoch: number }> };
    expect([...internal.sharedFailures.values()].map(record => record.epoch)).toEqual([1, 1]);
    await f.owner.close();
  });

  it('two providers reusing one Error still record one candidate failure each', async () => {
    const sharedError = new LLMRateLimitError('shared', 2);
    const primary = adapter('primary', async () => { throw sharedError; });
    const fallback = adapter('fallback', async () => { throw sharedError; });
    const f = await fixture([primary, fallback]);

    await expect(f.owner.call(CALL)).rejects.toThrow();

    expect(primary.call).toHaveBeenCalledTimes(1);
    expect(fallback.call).toHaveBeenCalledTimes(1);
    expect(f.readState().recovery.failures).toHaveLength(2);
    expect(f.events.filter(event =>
      event.type === 'call_attempt_result' && event.outcome === 'failure'
    )).toHaveLength(2);
    const internal = f.owner as unknown as { sharedFailures: Map<string, { epoch: number }> };
    expect(internal.sharedFailures).toHaveProperty('size', 2);
    expect([...internal.sharedFailures.values()].map(record => record.epoch)).toEqual([1, 1]);
    await f.owner.close();
  });

  it('restart retains the exact lower bound and admits only after it', async () => {
    const startedAt = Date.now();
    const failing = adapter('primary', async () => { throw new LLMRateLimitError('primary', 2); });
    const f = await fixture([failing], 3);
    await expect(f.owner.call(CALL)).rejects.toThrow();
    await f.owner.close();

    const healthy = adapter('primary', async () => OK);
    const restarted = f.makeOwner([healthy]);
    await vi.advanceTimersByTimeAsync(1_999);
    await expect(restarted.call(CALL)).rejects.toBeInstanceOf(LLMRecoveryWaitRequiredError);
    expect(healthy.call).not.toHaveBeenCalled();
    expect(f.readState().providers[0].sharedFailure.floorMs).toBe(startedAt + 2_000);

    await vi.advanceTimersByTimeAsync(1);
    await expect(restarted.call(CALL)).resolves.toBe(OK);
    expect(healthy.call).toHaveBeenCalledTimes(2); // autonomous probe, then real business call
    await restarted.close();
  });

  it('ordinary failures retain the existing same-provider retry path', async () => {
    let attempts = 0;
    const primary = adapter('primary', async () => {
      attempts++;
      if (attempts === 1) throw new LLMNetworkError('primary', new Error('offline'));
      return OK;
    });
    const f = await fixture([primary], 2);
    const pending = f.owner.call(CALL);
    await vi.advanceTimersByTimeAsync(0);
    await expect(pending).resolves.toBe(OK);
    expect(primary.call).toHaveBeenCalledTimes(2);
    expect(f.events.filter(event => event.type === 'retry_scheduled')).toHaveLength(1);
    expect(f.readState().recovery.failures).toHaveLength(0);
    await f.owner.close();
  });
});
