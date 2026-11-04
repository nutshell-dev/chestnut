import { afterEach, describe, expect, it } from 'vitest';
import * as fsNative from 'node:fs';
import * as path from 'node:path';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createLLMOrchestrator } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import { LLM_INSTANCE_STATE_FILE } from '../../../src/foundation/llm-orchestrator/instance-state.js';
import { providerIdentity } from '../../../src/foundation/llm-orchestrator/provider-identity.js';
import { LLMNetworkError } from '../../../src/foundation/llm-provider/errors.js';
import type { ProviderAdapter, ProviderConfig, LLMResponse } from '../../../src/foundation/llm-provider/index.js';
import type { LLMEvent, LLMEventSink } from '../../../src/foundation/llm-orchestrator/types.js';
import { cleanupTempDir, createTrackedTempDir } from '../../utils/temp.js';

const OK: LLMResponse = { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' };
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await cleanupTempDir(dir);
});

function config(name: string): ProviderConfig {
  return { name, apiKey: `key-${name}`, model: `model-${name}`, apiFormat: 'anthropic' };
}

function adapter(name: string, call: ProviderAdapter['call']): ProviderAdapter {
  return { name, model: `model-${name}`, call };
}

async function fixture(primary: ProviderAdapter, fallbacks: ProviderAdapter[] = []) {
  const dir = await createTrackedTempDir('phase2055-recovery-');
  dirs.push(dir);
  const fs = new NodeFileSystem({ baseDir: dir });
  const events: LLMEvent[] = [];
  const sink: LLMEventSink = { emit: event => { events.push(event); } };
  const adapters = new Map([primary, ...fallbacks].map(item => [item.name, item]));
  const owner = createLLMOrchestrator({
    lifecycle: { mode: 'durable', fs },
    primary: config(primary.name),
    fallbacks: fallbacks.map(item => config(item.name)),
    maxAttempts: 1,
    retryDelayMs: 1,
    events: sink,
    createProviderAdapter: provider => adapters.get(provider.name ?? '')!,
  });
  const statePath = path.join(dir, 'status', LLM_INSTANCE_STATE_FILE);
  const readState = () => JSON.parse(fsNative.readFileSync(statePath, 'utf8'));
  return { dir, fs, owner, events, statePath, readState };
}

describe('Phase2055 Step C: single instance recovery authority', () => {
  it('imports known legacy EventLoop state once, preserves raw input and stable instanceId', async () => {
    const f = await fixture(adapter('primary', async () => OK));
    await f.owner.close();
    fsNative.rmSync(f.statePath);
    const legacyPath = path.join(f.dir, 'status', 'llm-retry-state.json');
    const raw = JSON.stringify({
      schema_version: 2,
      llmRetryCount: 3,
      llmRetryDelayMs: 45_000,
      llmRetryPending: false,
      waiting: null,
    });
    fsNative.writeFileSync(legacyPath, raw);

    const events: LLMEvent[] = [];
    const makeOwner = () => createLLMOrchestrator({
      lifecycle: { mode: 'durable', fs: f.fs },
      primary: config('primary'), maxAttempts: 1, retryDelayMs: 1,
      events: { emit: event => { events.push(event); } },
      createProviderAdapter: () => adapter('primary', async () => OK),
    });
    const migrated = makeOwner();
    const saved = f.readState();
    expect(saved).toMatchObject({
      schema_version: 2,
      recovery: {
        budget: { retryCount: 3, retryDelayMs: 45_000 },
        importedSources: ['status/llm-retry-state.json#schema_version=2'],
      },
    });
    expect(fsNative.readFileSync(legacyPath, 'utf8')).toBe(raw);
    await migrated.close();
    const conflictingRaw = '{legacy is no longer authoritative';
    fsNative.writeFileSync(legacyPath, conflictingRaw);
    const restarted = makeOwner();
    expect(f.readState().instanceId).toBe(saved.instanceId);
    expect(fsNative.readFileSync(legacyPath, 'utf8')).toBe(conflictingRaw);
    await restarted.close();
  });

  it('imports legacy scope before EventLoop retry and losslessly maps schedule/budget', async () => {
    const f = await fixture(adapter('primary', async () => OK));
    await f.owner.close();
    fsNative.rmSync(f.statePath);
    const scopePath = path.join(f.dir, 'status', 'llm-recovery-state.json');
    const retryPath = path.join(f.dir, 'status', 'llm-retry-state.json');
    const resumeAt = '2026-11-04T12:00:00.000Z';
    const scopeRaw = JSON.stringify({
      schema_version: 1, scopeId: 'foreground', revision: 4,
      schedule: { kind: 'at', revision: 4, resumeAt },
      budget: { retryCount: 2, retryDelayMs: 60_000, quotaDelayMs: 240_000 },
      providers: [{
        providerId: providerIdentity(config('primary')), errorClass: 'transient',
        at: '2026-11-04T11:00:00.000Z', consecutiveFailures: 2, detail: 'offline',
      }],
      acceptedInterventions: [], acceptedConfigRevisions: [], activeAdmission: null,
      failures: [], importedSources: [], updatedAt: '2026-11-04T11:00:00.000Z',
    });
    const retryRaw = JSON.stringify({
      schema_version: 2, llmRetryCount: 9, llmRetryDelayMs: 1_000,
      llmRetryPending: false, waiting: null,
    });
    fsNative.writeFileSync(scopePath, scopeRaw);
    fsNative.writeFileSync(retryPath, retryRaw);
    const owner = createLLMOrchestrator({
      lifecycle: { mode: 'durable', fs: f.fs },
      primary: config('primary'), maxAttempts: 1, retryDelayMs: 1,
      events: { emit: () => {} }, createProviderAdapter: () => adapter('primary', async () => OK),
    });
    expect(f.readState().recovery).toMatchObject({
      budget: { retryCount: 2, retryDelayMs: 60_000, quotaDelayMs: 240_000 },
      providers: [{ blocking: true, retryAt: resumeAt }],
    });
    expect(await owner.inspectRecoverySchedule()).toMatchObject({ kind: 'at', resumeAt });
    expect(fsNative.readFileSync(scopePath, 'utf8')).toBe(scopeRaw);
    expect(fsNative.readFileSync(retryPath, 'utf8')).toBe(retryRaw);
    await owner.close();
  });

  it('rejects an unmapped legacy schedule/conflicting scope without changing old raw text', async () => {
    const f = await fixture(adapter('primary', async () => OK));
    await f.owner.close();
    fsNative.rmSync(f.statePath);
    const legacyPath = path.join(f.dir, 'status', 'llm-recovery-state.json');
    const legacy = {
      schema_version: 1, scopeId: 'other', revision: 1,
      schedule: { kind: 'ready', revision: 1 },
      budget: { retryCount: 0, retryDelayMs: 30_000, quotaDelayMs: 120_000 },
      providers: [], acceptedInterventions: [], acceptedConfigRevisions: [],
      activeAdmission: null, failures: [], importedSources: [],
      updatedAt: new Date().toISOString(),
    };
    const raw = JSON.stringify(legacy);
    fsNative.writeFileSync(legacyPath, raw);
    expect(() => createLLMOrchestrator({
      lifecycle: { mode: 'durable', fs: f.fs },
      primary: config('primary'), maxAttempts: 1, retryDelayMs: 1,
      events: { emit: () => {} }, createProviderAdapter: () => adapter('primary', async () => OK),
    })).toThrow(/scope_mismatch/);
    expect(fsNative.readFileSync(legacyPath, 'utf8')).toBe(raw);
  });

  it('allows concurrent invocations and finish removes only its own record', async () => {
    const pending = new Map<string, { resolve: (value: LLMResponse) => void }>();
    const primary = adapter('primary', async options => {
      const content = options?.messages[0]?.content;
      const key = typeof content === 'string' ? content : 'unknown';
      return new Promise<LLMResponse>(resolve => { pending.set(key, { resolve }); });
    });
    const f = await fixture(primary);
    const first = f.owner.call({ messages: [{ role: 'user', content: 'first' }] });
    const second = f.owner.call({ messages: [{ role: 'user', content: 'second' }] });
    await new Promise(resolve => setImmediate(resolve));
    const inFlight = f.readState().recovery.invocations;
    expect(inFlight).toHaveLength(2);
    expect(new Set(inFlight.map((item: { invocationId: string }) => item.invocationId)).size).toBe(2);
    expect(inFlight.every((item: { started: boolean; requestKey: string }) => item.started && item.requestKey)).toBe(true);

    pending.get('first')!.resolve(OK);
    await first;
    expect(f.readState().recovery.invocations).toHaveLength(1);
    expect(f.readState().recovery.invocations[0].requestKey).toBe(inFlight[1].requestKey);
    pending.get('second')!.resolve(OK);
    await second;
    expect(f.readState().recovery.invocations).toEqual([]);
    await f.owner.close();
  });

  it('clears only the real winner and emits instance/invocation events without scope or turn', async () => {
    let primaryFails = true;
    const primary = adapter('primary', async () => {
      if (primaryFails) throw new LLMNetworkError('primary', new Error('offline'));
      return OK;
    });
    const fallback = adapter('fallback', async () => OK);
    const f = await fixture(primary, [fallback]);
    await f.owner.call({ messages: [{ role: 'user', content: 'fallback-wins' }] });
    const saved = f.readState();
    const primaryId = saved.providers.find((item: { providerId: string; breaker: unknown }, index: number) => index === 0).providerId;
    const fallbackId = saved.providers[1].providerId;
    expect(saved.recovery.providers.map((item: { providerId: string }) => item.providerId)).toEqual([primaryId]);
    expect(saved.recovery.budget.retryCount).toBe(1); // fallback 成功不得重置非 winner 的恢复曲线
    expect(saved.providers[0].sharedFailure).toBeDefined();
    expect(saved.providers[1].sharedFailure).toBeUndefined();
    const selection = f.events.find(event => event.type === 'call_selection' && event.outcome === 'selected');
    expect(selection).toMatchObject({ providerId: fallbackId });

    primaryFails = false;
    (f.owner as unknown as { lastSuccessProvider: { cacheValidUntil: number } }).lastSuccessProvider.cacheValidUntil = 0;
    await f.owner.call({
      messages: [{ role: 'user', content: 'primary-wins' }],
      recoveryFacts: { interventionIds: ['manual-retry'] },
    });
    const after = f.readState();
    expect(after.recovery.providers).toEqual([]);
    expect(after.providers[0].sharedFailure).toBeUndefined();
    const recoveryEvents = f.events.filter(event => event.type.startsWith('recovery_'));
    expect(recoveryEvents.length).toBeGreaterThan(0);
    for (const event of recoveryEvents) {
      expect(event).not.toHaveProperty('scope');
      expect(event).not.toHaveProperty('turn');
      expect(event).toMatchObject({ orchestratorInstance: saved.instanceId });
    }
    await f.owner.close();
  });
});
