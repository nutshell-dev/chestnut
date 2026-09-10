/**
 * Phase 1826: 恢复状态持久化 — schema 校验、原子读写、迁移 intake、降级导出。
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fsNative from 'fs';
import * as path from 'path';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import {
  LLM_RECOVERY_STATE_FILE,
  createInitialRecoveryState,
  exportLegacyRecoveryState,
  importLegacyRecoveryExport,
  loadRecoveryState,
  saveRecoveryState,
  validateRecoveryState,
} from '../../../src/foundation/llm-orchestrator/recovery-state.js';
import type { LLMRecoveryBudget } from '../../../src/foundation/llm-orchestrator/recovery-state.js';

const SCOPE = 'foreground';

function budget(): LLMRecoveryBudget {
  return { retryCount: 0, retryDelayMs: 30_000, quotaDelayMs: 120_000 };
}

async function makeDir(): Promise<{ dir: string; fs: NodeFileSystem }> {
  const dir = await createTrackedTempDir('recovery-state-');
  return { dir, fs: new NodeFileSystem({ baseDir: dir }) };
}

const cleanupDirs: string[] = [];
afterEach(async () => {
  for (const dir of cleanupDirs.splice(0)) {
    try { await cleanupTempDir(dir); } catch { /* ignore */ }
  }
});

async function makeTrackedDir() {
  const r = await makeDir();
  cleanupDirs.push(r.dir);
  return r;
}

const T0 = Date.parse('2026-09-10T00:00:00.000Z');

describe('recovery state schema', () => {
  it('initial state validates and round-trips through disk', async () => {
    const { dir, fs } = await makeTrackedDir();
    const state = createInitialRecoveryState(SCOPE, budget(), T0);
    expect(validateRecoveryState(state, SCOPE).ok).toBe(true);

    saveRecoveryState(fs, state);
    const filePath = path.join(dir, 'status', LLM_RECOVERY_STATE_FILE);
    expect(fsNative.existsSync(filePath)).toBe(true);

    const loaded = loadRecoveryState(fs, SCOPE);
    expect(loaded.kind).toBe('ok');
    if (loaded.kind === 'ok') {
      expect(loaded.state.scopeId).toBe(SCOPE);
      expect(loaded.state.schedule).toEqual({ kind: 'ready', revision: 1 });
    }
  });

  it('missing file reports missing (first start)', async () => {
    const { fs } = await makeTrackedDir();
    expect(loadRecoveryState(fs, SCOPE).kind).toBe('missing');
  });

  it('corrupt JSON is unusable with parse_failed and file preserved', async () => {
    const { dir, fs } = await makeTrackedDir();
    fsNative.mkdirSync(path.join(dir, 'status'), { recursive: true });
    fsNative.writeFileSync(path.join(dir, 'status', LLM_RECOVERY_STATE_FILE), 'not-json{');

    const loaded = loadRecoveryState(fs, SCOPE);
    expect(loaded.kind).toBe('unusable');
    if (loaded.kind === 'unusable') expect(loaded.reason).toBe('parse_failed');
    expect(fsNative.existsSync(path.join(dir, 'status', LLM_RECOVERY_STATE_FILE))).toBe(true);
  });

  it('future schema version is unusable (no guessed defaults)', async () => {
    const { dir, fs } = await makeTrackedDir();
    fsNative.mkdirSync(path.join(dir, 'status'), { recursive: true });
    fsNative.writeFileSync(
      path.join(dir, 'status', LLM_RECOVERY_STATE_FILE),
      JSON.stringify({ ...createInitialRecoveryState(SCOPE, budget(), T0), schema_version: 99 }),
    );
    const loaded = loadRecoveryState(fs, SCOPE);
    expect(loaded.kind).toBe('unusable');
    if (loaded.kind === 'unusable') expect(loaded.reason).toBe('schema_invalid');
  });

  it('scope mismatch is rejected (state belongs to another scope)', async () => {
    const { dir, fs } = await makeTrackedDir();
    const state = createInitialRecoveryState('other-scope', budget(), T0);
    saveRecoveryState(fs, state);
    const loaded = loadRecoveryState(fs, SCOPE);
    expect(loaded.kind).toBe('unusable');
    if (loaded.kind === 'unusable') expect(loaded.reason).toBe('scope_mismatch');
  });

  it('save failure surfaces as error without leaving partial file', async () => {
    const { dir, fs } = await makeTrackedDir();
    const original = createInitialRecoveryState(SCOPE, budget(), T0);
    saveRecoveryState(fs, original);

    const spy = new NodeFileSystem({ baseDir: dir });
    const broken = new Proxy(spy, {
      get(target, prop) {
        if (prop === 'writeAtomicSync') {
          return () => { throw new Error('disk full'); };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as NodeFileSystem;
    expect(() => saveRecoveryState(broken, { ...original, revision: 5 })).toThrow(/persist/);

    const loaded = loadRecoveryState(fs, SCOPE);
    expect(loaded.kind).toBe('ok');
    if (loaded.kind === 'ok') expect(loaded.state.revision).toBe(1);
  });
});

describe('legacy import intake', () => {
  it('imports waiting keeping original resumeAt and budget', () => {
    const state = createInitialRecoveryState(SCOPE, budget(), T0);
    const resumeAt = new Date(T0 + 60_000).toISOString();
    const result = importLegacyRecoveryExport(state, {
      source: 'llm-retry-state.json@v2',
      retryCount: 2,
      retryDelayMs: 60_000,
      quotaDelayMs: 240_000,
      waiting: { kind: 'cooldown', errorClass: 'quota', resumeAt, error: 'quota hit' },
    }, T0);

    expect(result.kind).toBe('imported');
    if (result.kind !== 'imported') return;
    expect(result.state.schedule.kind).toBe('at');
    if (result.state.schedule.kind === 'at') {
      expect(result.state.schedule.resumeAt).toBe(resumeAt);  // 不重新计时
    }
    expect(result.state.budget.retryCount).toBe(2);
    expect(result.state.budget.quotaDelayMs).toBe(240_000);
    expect(result.state.importedSources).toContain('llm-retry-state.json@v2');
  });

  it('expired legacy waiting becomes ready (deadline already passed)', () => {
    const state = createInitialRecoveryState(SCOPE, budget(), T0);
    const result = importLegacyRecoveryExport(state, {
      source: 'llm-retry-state.json@v2',
      waiting: { kind: 'retry', errorClass: 'transient', resumeAt: new Date(T0 - 1_000).toISOString() },
    }, T0);
    expect(result.kind).toBe('imported');
    if (result.kind === 'imported') expect(result.state.schedule.kind).toBe('ready');
  });

  it('imports provider-class blocked as on_change', () => {
    const state = createInitialRecoveryState(SCOPE, budget(), T0);
    const result = importLegacyRecoveryExport(state, {
      source: 'llm-request-blocked-state.json@v2',
      blocked: {
        reason: 'permanent_provider_error',
        requestFingerprint: 'fp',
        blockedAt: new Date(T0).toISOString(),
        message: 'auth failed',
      },
    }, T0);
    expect(result.kind).toBe('imported');
    if (result.kind === 'imported') expect(result.state.schedule.kind).toBe('on_change');
  });

  it('re-importing the same source is idempotent', () => {
    const state = createInitialRecoveryState(SCOPE, budget(), T0);
    const legacy = {
      source: 'llm-retry-state.json@v2',
      waiting: { kind: 'retry' as const, errorClass: 'transient', resumeAt: new Date(T0 + 5_000).toISOString() },
    };
    const first = importLegacyRecoveryExport(state, legacy, T0);
    expect(first.kind).toBe('imported');
    if (first.kind !== 'imported') return;

    const second = importLegacyRecoveryExport(
      { ...first.state, budget: { ...first.state.budget, retryCount: 7 } },
      legacy,
      T0,
    );
    expect(second.kind).toBe('already_imported');
    expect(second.state.budget.retryCount).toBe(7);  // 不覆盖较新状态
  });
});

describe('downgrade export', () => {
  it('exports at-schedule as legacy waiting and on_change as blocked', () => {
    const base = createInitialRecoveryState(SCOPE, budget(), T0);
    const atState = {
      ...base,
      revision: 3,
      schedule: { kind: 'at' as const, revision: 3, resumeAt: new Date(T0 + 30_000).toISOString() },
      failures: [{ at: new Date(T0).toISOString(), providerId: 'p1', errorClass: 'quota', message: 'quota hit' }],
    };
    const exported = exportLegacyRecoveryState(atState, T0);
    expect(exported.kind).toBe('exported');
    if (exported.kind !== 'exported') return;
    expect(exported.retry.waiting?.resumeAt).toBe(atState.schedule.resumeAt);
    expect(exported.retry.llmQuotaDelayMs).toBe(120_000);
    expect(exported.blocked).toBeNull();
    expect(exported.unrepresentable.length).toBeGreaterThan(0);  // failures 无法表达

    const onChange = { ...base, schedule: { kind: 'on_change' as const, revision: 4 } };
    const exported2 = exportLegacyRecoveryState(onChange, T0);
    expect(exported2.kind).toBe('exported');
    if (exported2.kind !== 'exported') return;
    expect(exported2.blocked?.reason).toBe('permanent_provider_error');
    expect(exported2.retry.waiting).toBeNull();
  });

  it('refuses downgrade while an attempt has already started', () => {
    const base = createInitialRecoveryState(SCOPE, budget(), T0);
    const inFlight = {
      ...base,
      activeAdmission: {
        attemptId: 'att-1',
        started: true,
        startedAt: new Date(T0).toISOString(),
        requestKey: 'fp',
        triggerKind: 'automatic',
      },
    };
    const exported = exportLegacyRecoveryState(inFlight, T0);
    expect(exported.kind).toBe('unrepresentable');
    if (exported.kind === 'unrepresentable') expect(exported.reason).toBe('in_flight_admission');
  });
});

describe('Z 补修兼容性', () => {
  it('补修前写入的 admission（无 probeOnly/allowBreakerProbe 字段）仍可加载', async () => {
    const { dir, fs } = await makeTrackedDir();
    fsNative.mkdirSync(path.join(dir, 'status'), { recursive: true });
    const base = createInitialRecoveryState(SCOPE, budget(), T0);
    fsNative.writeFileSync(
      path.join(dir, 'status', LLM_RECOVERY_STATE_FILE),
      JSON.stringify({
        ...base,
        activeAdmission: {
          attemptId: 'att-legacy',
          started: false,
          requestKey: 'fp',
          triggerKind: 'intervention',
        },
      }),
    );

    const loaded = loadRecoveryState(fs, SCOPE);
    expect(loaded.kind).toBe('ok');
    if (loaded.kind === 'ok') {
      expect(loaded.state.activeAdmission?.attemptId).toBe('att-legacy');
      expect(loaded.state.activeAdmission?.probeOnly).toBeUndefined();
    }
  });
});
