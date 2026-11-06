import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsNative from 'node:fs';
import * as path from 'node:path';
import { EventLoop } from '../../../src/core/event-loop/index.js';
import { LLM_REQUEST_BLOCKED_STATE_FILE } from '../../../src/core/event-loop/constants.js';
import type { EventLoopRuntime, LLMRequestBlockedState, LLMRequestGateDecision, LlmGateReleaseBaseline } from '../../../src/core/event-loop/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import { cleanupTempDir, createTrackedTempDir } from '../../utils/temp.js';

interface GateInternals {
  enter(state: LLMRequestBlockedState): Promise<void>;
  check(): Promise<LLMRequestGateDecision>;
}

const BASELINE: LlmGateReleaseBaseline = {
  configurationRevision: 'config-1',
  userMessageIds: ['message-old'],
  providerHealth: [{ providerId: 'provider-1', epoch: 1, healthKey: 'blocked:quota' }],
};

let agentDir: string;
beforeEach(async () => {
  agentDir = await createTrackedTempDir('phase2056-gate-');
});
afterEach(async () => {
  await cleanupTempDir(agentDir);
});

function blockedState(): LLMRequestBlockedState {
  return {
    version: 2,
    reason: 'recovery_required',
    requestFingerprint: 'fingerprint-1',
    detail: 'test failure',
    blockedAt: new Date(0).toISOString(),
    releaseBaseline: structuredClone(BASELINE),
  };
}

function makeHarness(overrides: Partial<FileSystem> = {}) {
  const facts = structuredClone(BASELINE);
  let fingerprint = 'fingerprint-1';
  const consumePendingControls = vi.fn(async () => ({ consumed: 0 }));
  const runtime = {
    abort: vi.fn(),
    consumePendingControls,
    peekLlmGateFacts: vi.fn(async () => facts),
    computeTurnRequestFingerprint: vi.fn(async () => fingerprint),
  } as unknown as EventLoopRuntime;
  const baseFs = new NodeFileSystem({ baseDir: agentDir });
  const agentFs = new Proxy(baseFs, {
    get(target, property) {
      if (property in overrides) return (overrides as Record<string | symbol, unknown>)[property];
      const value = (target as unknown as Record<string | symbol, unknown>)[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as FileSystem;
  const loop = new EventLoop({
    runtime,
    fsFactory: dir => path.resolve(dir) === path.resolve(agentDir) ? agentFs : new NodeFileSystem({ baseDir: dir }),
    agentDir,
    clawId: 'claw',
    audit: { write: vi.fn() } as unknown as AuditLog,
    inbox: { pendingDir: path.join(agentDir, 'inbox', 'pending'), fallbackTimeoutMs: 1 },
  });
  const internals = loop as unknown as {
    _enterLlmRequestBlocked: GateInternals['enter'];
    _checkLlmRequestGate: GateInternals['check'];
  };
  const harness = {
    loop,
    facts,
    consumePendingControls,
    enter: (state = blockedState()) => internals._enterLlmRequestBlocked(state),
    check: () => internals._checkLlmRequestGate(),
    setFingerprint: (value: string) => { fingerprint = value; },
    statePath: path.join(agentDir, 'status', LLM_REQUEST_BLOCKED_STATE_FILE),
  };
  return harness;
}

describe('Phase 2056 LLM request gate release facts', () => {
  it('keeps an unchanged config/fingerprint blocked and does not release a replayed revision', async () => {
    const harness = makeHarness();
    await harness.enter();
    expect(await harness.check()).toMatchObject({ kind: 'blocked' });
    expect(fsNative.existsSync(harness.statePath)).toBe(true);
    expect(harness.consumePendingControls).toHaveBeenCalledTimes(1);
  });

  it('persists config_applied before one release and ignores the same fact afterwards', async () => {
    const harness = makeHarness();
    await harness.enter();
    harness.facts.configurationRevision = 'config-2';
    harness.consumePendingControls.mockResolvedValue({ consumed: 1, configRevision: 'config-2' });
    harness.setFingerprint('fingerprint-2');

    expect(await harness.check()).toMatchObject({
      kind: 'released',
      releaseFact: { kind: 'config_applied', revision: 'config-2' },
    });
    expect(fsNative.existsSync(harness.statePath)).toBe(false);
    expect(await harness.check()).toMatchObject({ kind: 'open', fingerprint: 'fingerprint-2' });
  });

  it('requires both a newer committed epoch and a changed provider health key', async () => {
    const harness = makeHarness();
    await harness.enter();
    harness.facts.providerHealth[0] = { providerId: 'provider-1', epoch: 2, healthKey: 'blocked:quota' };
    expect(await harness.check()).toMatchObject({ kind: 'blocked' });

    harness.facts.providerHealth[0] = { providerId: 'provider-1', epoch: 3, healthKey: 'healthy' };
    expect(await harness.check()).toMatchObject({
      kind: 'released',
      releaseFact: { kind: 'provider_health_changed', providerId: 'provider-1', epoch: 3 },
    });
  });

  it('does not lose a health change committed after blocked but before the first gate check', async () => {
    const harness = makeHarness();
    await harness.enter();
    harness.facts.providerHealth[0] = { providerId: 'provider-1', epoch: 2, healthKey: 'healthy' };
    expect(await harness.check()).toMatchObject({
      kind: 'released',
      releaseFact: { kind: 'provider_health_changed', providerId: 'provider-1', epoch: 2 },
    });
  });

  it('releases only for a fresh pending user message id', async () => {
    const harness = makeHarness();
    await harness.enter();
    expect(await harness.check()).toMatchObject({ kind: 'blocked' });

    harness.facts.userMessageIds.push('message-new');
    harness.setFingerprint('fingerprint-new-message');
    expect(await harness.check()).toMatchObject({
      kind: 'released',
      releaseFact: { kind: 'new_user_message', messageId: 'message-new' },
    });
  });

  it('captures a missing baseline when entering blocked', async () => {
    const harness = makeHarness();
    const state = blockedState();
    delete state.releaseBaseline;
    await harness.enter(state);
    expect(await harness.check()).toMatchObject({ kind: 'blocked' });
    const persisted = JSON.parse(fsNative.readFileSync(harness.statePath, 'utf8')) as LLMRequestBlockedState;
    expect(persisted.releaseBaseline).toEqual(BASELINE);
  });

  it('keeps pendingRelease on deletion failure and replays the same fact once', async () => {
    let failDelete = true;
    const harness = makeHarness({
      deleteSync: (target: string) => {
        if (failDelete && target.endsWith(LLM_REQUEST_BLOCKED_STATE_FILE)) throw new Error('EACCES');
        return new NodeFileSystem({ baseDir: agentDir }).deleteSync(target);
      },
    });
    await harness.enter();
    harness.facts.configurationRevision = 'config-2';
    await expect(harness.check()).rejects.toThrow('EACCES');
    const pending = JSON.parse(fsNative.readFileSync(harness.statePath, 'utf8')) as LLMRequestBlockedState;
    expect(pending.pendingRelease).toEqual({
      fact: { kind: 'config_applied', revision: 'config-2' },
      fingerprint: 'fingerprint-1',
    });

    failDelete = false;
    expect(await harness.check()).toMatchObject({
      kind: 'released',
      releaseFact: { kind: 'config_applied', revision: 'config-2' },
    });
    expect(fsNative.existsSync(harness.statePath)).toBe(false);
  });
});
