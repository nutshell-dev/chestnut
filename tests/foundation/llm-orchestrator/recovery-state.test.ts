/**
 * Phase 1826: 恢复状态持久化 — schema 校验、原子读写。
 * phase 1890 Step D：迁移 intake / 降级导出随存量废弃删除（对应专测同删）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fsNative from 'fs';
import * as path from 'path';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import {
  LLM_RECOVERY_STATE_FILE,
  createInitialRecoveryState,
  loadRecoveryState,
  saveRecoveryState,
  validateRecoveryState,
} from '../../../src/foundation/llm-orchestrator/recovery-state.js';
import type {
  LLMRecoveryBudget,
  LLMRecoveryStateV1,
} from '../../../src/foundation/llm-orchestrator/recovery-state.js';
import type { AtomicWriteResult, FileSystem } from '../../../src/foundation/fs/types.js';

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

  it.each([
    { kind: 'durable' },
    { kind: 'committed_platform_limited', error: Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }) },
    { kind: 'committed_durability_unknown', error: Object.assign(new Error('fsync failed'), { code: 'EIO' }) },
  ] satisfies AtomicWriteResult[])('save returns the atomic durability result: $kind', async (result) => {
    const { fs } = await makeTrackedDir();
    const wrapped = new Proxy(fs, {
      get(target, prop) {
        if (prop === 'writeAtomicSync') return () => result;
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as FileSystem;
    const state = createInitialRecoveryState(SCOPE, budget(), T0);
    expect(saveRecoveryState(wrapped, state)).toBe(result);
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

describe('Phase 1827 事实字段：旧文件兼容与降级证据', () => {
  it('1827 之前写入的 v1 文件（无事实字段）仍可加载：保留兼容标量、不伪造用户 ids', async () => {
    const { dir, fs } = await makeTrackedDir();
    fsNative.mkdirSync(path.join(dir, 'status'), { recursive: true });
    const base = createInitialRecoveryState(SCOPE, budget(), T0);
    fsNative.writeFileSync(
      path.join(dir, 'status', LLM_RECOVERY_STATE_FILE),
      JSON.stringify({
        ...base,
        activeAdmission: {
          attemptId: 'att-old',
          started: false,
          requestKey: 'fp',
          triggerKind: 'configuration',
          triggerId: 'r-old',
        },
      }),
    );

    const loaded = loadRecoveryState(fs, SCOPE);
    expect(loaded.kind).toBe('ok');
    if (loaded.kind !== 'ok') return;
    expect(loaded.state.activeAdmission?.triggerKind).toBe('configuration');
    expect(loaded.state.activeAdmission?.triggerId).toBe('r-old');   // 历史证据保留
    expect(loaded.state.activeAdmission?.interventionIds).toBeUndefined();  // 不伪造
    expect(loaded.state.acceptedFactBatches).toBeUndefined();
  });

  it('acceptedFactBatches 形状非法时拒绝加载（field_type_mismatch）', async () => {
    const { dir, fs } = await makeTrackedDir();
    fsNative.mkdirSync(path.join(dir, 'status'), { recursive: true });
    const base = createInitialRecoveryState(SCOPE, budget(), T0);
    fsNative.writeFileSync(
      path.join(dir, 'status', LLM_RECOVERY_STATE_FILE),
      JSON.stringify({ ...base, acceptedFactBatches: [{ scope: SCOPE, revision: 'x' }] }),
    );
    const loaded = loadRecoveryState(fs, SCOPE);
    expect(loaded.kind).toBe('unusable');
    if (loaded.kind === 'unusable') {
      expect(loaded.reason).toBe('field_type_mismatch');
      expect(loaded.detail).toBe('acceptedFactBatches');
    }
  });

  // -------------------------------------------------------------------------
  // Phase 1968 Step C：调用路径关联字段（providerLabel/invocationId/attemptIndex/
  // configRevision）——可选、旧文件缺省兼容、出现时严格校验、落盘往返不丢失。
  // -------------------------------------------------------------------------

  it('1968 关联字段随 providers/failures 落盘往返（label↔identity 可见）', async () => {
    const { dir, fs } = await makeTrackedDir();
    const state = createInitialRecoveryState(SCOPE, budget(), T0);
    state.providers.push({
      providerId: 'fp-abc',
      errorClass: 'transient',
      at: new Date(T0).toISOString(),
      consecutiveFailures: 1,
      detail: 'boom',
      providerLabel: 'kimi-year',
    });
    state.failures.push({
      at: new Date(T0).toISOString(),
      providerId: 'fp-abc',
      errorClass: 'transient',
      message: 'boom',
      providerLabel: 'kimi-year',
      invocationId: 'inv-1',
      attemptIndex: 0,
      configRevision: 0,
    });
    expect(validateRecoveryState(state, SCOPE).ok).toBe(true);
    saveRecoveryState(fs, state);
    const loaded = loadRecoveryState(fs, SCOPE);
    expect(loaded.kind).toBe('ok');
    if (loaded.kind !== 'ok') return;
    expect(loaded.state.providers[0].providerLabel).toBe('kimi-year');
    expect(loaded.state.failures[0]).toMatchObject({
      providerLabel: 'kimi-year',
      invocationId: 'inv-1',
      attemptIndex: 0,
      configRevision: 0,
    });
  });

  it('1968 前旧格式（无关联字段）仍然兼容加载', async () => {
    const { dir, fs } = await makeTrackedDir();
    const state = createInitialRecoveryState(SCOPE, budget(), T0);
    state.providers.push({
      providerId: 'fp-old',
      errorClass: 'permanent',
      at: new Date(T0).toISOString(),
      consecutiveFailures: 2,
      detail: 'auth',
    });
    state.failures.push({
      at: new Date(T0).toISOString(),
      providerId: 'fp-old',
      errorClass: 'permanent',
      message: 'auth',
    });
    saveRecoveryState(fs, state);
    const loaded = loadRecoveryState(fs, SCOPE);
    expect(loaded.kind).toBe('ok');
    if (loaded.kind !== 'ok') return;
    expect(loaded.state.providers[0].providerLabel).toBeUndefined();  // 不伪造
    expect(loaded.state.failures[0].invocationId).toBeUndefined();
  });

  it('1968 关联字段类型非法时拒绝加载（field_type_mismatch）', async () => {
    const { dir, fs } = await makeTrackedDir();
    const base = createInitialRecoveryState(SCOPE, budget(), T0);
    const bad = {
      ...base,
      failures: [{
        at: new Date(T0).toISOString(),
        providerId: 'fp-x',
        errorClass: 'transient',
        message: 'm',
        attemptIndex: 'zero',  // 应为 number
      }],
    };
    fsNative.mkdirSync(path.join(dir, 'status'), { recursive: true });
    fsNative.writeFileSync(
      path.join(dir, 'status', LLM_RECOVERY_STATE_FILE),
      JSON.stringify(bad),
    );
    const loaded = loadRecoveryState(fs, SCOPE);
    expect(loaded.kind).toBe('unusable');
    if (loaded.kind === 'unusable') {
      expect(loaded.reason).toBe('field_type_mismatch');
      expect(loaded.detail).toBe('failures');
    }
  });

});


describe('Phase 2032 admissionKind compatibility', () => {
  it('accepts invocation records and rejects unknown admission kinds fail-closed', () => {
    const state = createInitialRecoveryState(SCOPE, budget(), T0);
    state.activeAdmission = {
      admissionKind: 'invocation',
      attemptId: 'att-invocation',
      started: false,
      requestKey: 'request-key',
      triggerKind: 'automatic',
    };
    expect(validateRecoveryState(state, SCOPE).ok).toBe(true);

    const invalid = validateRecoveryState({
      ...state,
      activeAdmission: { ...state.activeAdmission, admissionKind: 'legacy_turn' },
    }, SCOPE);
    expect(invalid).toMatchObject({ ok: false, reason: 'field_type_mismatch', detail: 'activeAdmission' });
  });
});


function semanticState(): LLMRecoveryStateV1 {
  const state = createInitialRecoveryState(SCOPE, budget(), T0);
  state.revision = 3;
  state.schedule = { kind: 'at', revision: 3, resumeAt: new Date(T0 + 30_000).toISOString() };
  state.providers = [{
    providerId: 'provider-1',
    errorClass: 'rate_limit',
    at: new Date(T0).toISOString(),
    consecutiveFailures: 2,
    detail: 'limited',
    rateLimitFailures: 2,
    rateLimitBlockedAt: new Date(T0).toISOString(),
  }];
  state.activeAdmission = {
    admissionKind: 'invocation',
    attemptId: 'att-1',
    started: true,
    startedAt: new Date(T0).toISOString(),
    requestKey: 'request-1',
    triggerKind: 'automatic',
  };
  state.failures = [{
    at: new Date(T0).toISOString(),
    providerId: 'provider-1',
    errorClass: 'rate_limit',
    message: 'limited',
    attemptIndex: 0,
    configRevision: 0,
  }];
  state.acceptedFactBatches = [{
    scope: SCOPE,
    revision: 2,
    interventionIds: ['m1'],
  }];
  state.failureEvidenceLoss = {
    droppedCount: 1,
    firstDroppedAt: new Date(T0).toISOString(),
    lastDroppedAt: new Date(T0).toISOString(),
    reason: 'bounded_retention',
    policyVersion: 1,
    recoverability: 'not_preserved_in_recovery_state',
  };
  return state;
}

describe('Phase 2035 Step D/E: loss record and semantic validation', () => {
  it('failureEvidenceLoss 随合法状态 round-trip，旧文件缺省仍兼容', async () => {
    const { fs } = await makeTrackedDir();
    const state = semanticState();
    saveRecoveryState(fs, state);
    const loaded = loadRecoveryState(fs, SCOPE);
    expect(loaded.kind).toBe('ok');
    if (loaded.kind !== 'ok') return;
    expect(loaded.state.failureEvidenceLoss).toEqual(state.failureEvidenceLoss);

    const legacy = createInitialRecoveryState(SCOPE, budget(), T0);
    expect(legacy.failureEvidenceLoss).toBeUndefined();
    expect(validateRecoveryState(legacy, SCOPE).ok).toBe(true);
  });

  it('合法正值、整数、日期与历史 revision 均通过', () => {
    expect(validateRecoveryState(semanticState(), SCOPE)).toMatchObject({ ok: true });
  });

  it.each([
    {
      name: 'top revision NaN',
      detail: 'revision',
      change: (state: LLMRecoveryStateV1) => ({ ...state, revision: NaN }),
    },
    {
      name: 'schedule/top revision 不一致',
      detail: 'schedule.revision',
      change: (state: LLMRecoveryStateV1) => ({
        ...state,
        schedule: { ...state.schedule, revision: state.revision + 1 },
      }),
    },
    {
      name: '非法 resumeAt',
      detail: 'schedule.resumeAt',
      change: (state: LLMRecoveryStateV1) => ({
        ...state,
        schedule: { ...state.schedule, kind: 'at' as const, resumeAt: 'not-a-date' },
      }),
    },
    {
      name: 'retryCount 负数',
      detail: 'budget.retryCount',
      change: (state: LLMRecoveryStateV1) => ({
        ...state,
        budget: { ...state.budget, retryCount: -1 },
      }),
    },
    {
      name: 'retryDelayMs 为零',
      detail: 'budget.retryDelayMs',
      change: (state: LLMRecoveryStateV1) => ({
        ...state,
        budget: { ...state.budget, retryDelayMs: 0 },
      }),
    },
    {
      name: 'quotaDelayMs Infinity',
      detail: 'budget.quotaDelayMs',
      change: (state: LLMRecoveryStateV1) => ({
        ...state,
        budget: { ...state.budget, quotaDelayMs: Infinity },
      }),
    },
    {
      name: 'provider at 非法日期',
      detail: 'providers[0].at',
      change: (state: LLMRecoveryStateV1) => ({
        ...state,
        providers: [{ ...state.providers[0]!, at: 'invalid' }],
      }),
    },
    {
      name: 'consecutiveFailures 小数',
      detail: 'providers[0].consecutiveFailures',
      change: (state: LLMRecoveryStateV1) => ({
        ...state,
        providers: [{ ...state.providers[0]!, consecutiveFailures: 1.5 }],
      }),
    },
    {
      name: 'rateLimitFailures 负数',
      detail: 'providers[0].rateLimitFailures',
      change: (state: LLMRecoveryStateV1) => ({
        ...state,
        providers: [{ ...state.providers[0]!, rateLimitFailures: -1 }],
      }),
    },
    {
      name: 'rateLimitBlockedAt 非法日期',
      detail: 'providers[0].rateLimitBlockedAt',
      change: (state: LLMRecoveryStateV1) => ({
        ...state,
        providers: [{ ...state.providers[0]!, rateLimitBlockedAt: 'invalid' }],
      }),
    },
    {
      name: 'startedAt 非法日期',
      detail: 'activeAdmission.startedAt',
      change: (state: LLMRecoveryStateV1) => ({
        ...state,
        activeAdmission: { ...state.activeAdmission!, startedAt: 'invalid' },
      }),
    },
    {
      name: 'failure at 非法日期',
      detail: 'failures[0].at',
      change: (state: LLMRecoveryStateV1) => ({
        ...state,
        failures: [{ ...state.failures[0]!, at: 'invalid' }],
      }),
    },
    {
      name: 'attemptIndex 负数',
      detail: 'failures[0].attemptIndex',
      change: (state: LLMRecoveryStateV1) => ({
        ...state,
        failures: [{ ...state.failures[0]!, attemptIndex: -1 }],
      }),
    },
    {
      name: 'configRevision 小数',
      detail: 'failures[0].configRevision',
      change: (state: LLMRecoveryStateV1) => ({
        ...state,
        failures: [{ ...state.failures[0]!, configRevision: 0.5 }],
      }),
    },
    {
      name: 'batch revision 超过顶层 revision',
      detail: 'acceptedFactBatches[0].revision',
      change: (state: LLMRecoveryStateV1) => ({
        ...state,
        acceptedFactBatches: [{ ...state.acceptedFactBatches![0]!, revision: state.revision + 1 }],
      }),
    },
    {
      name: 'batch revision 为零',
      detail: 'acceptedFactBatches[0].revision',
      change: (state: LLMRecoveryStateV1) => ({
        ...state,
        acceptedFactBatches: [{ ...state.acceptedFactBatches![0]!, revision: 0 }],
      }),
    },
    {
      name: 'droppedCount 非有限数',
      detail: 'failureEvidenceLoss.droppedCount',
      change: (state: LLMRecoveryStateV1) => ({
        ...state,
        failureEvidenceLoss: { ...state.failureEvidenceLoss!, droppedCount: Infinity },
      }),
    },
    {
      name: 'droppedCount 大于零但缺少时间范围',
      detail: 'failureEvidenceLoss.firstDroppedAt/lastDroppedAt',
      change: (state: LLMRecoveryStateV1) => ({
        ...state,
        failureEvidenceLoss: {
          ...state.failureEvidenceLoss!,
          firstDroppedAt: undefined,
          lastDroppedAt: undefined,
        },
      }),
    },
    {
      name: 'firstDroppedAt 非法日期',
      detail: 'failureEvidenceLoss.firstDroppedAt',
      change: (state: LLMRecoveryStateV1) => ({
        ...state,
        failureEvidenceLoss: { ...state.failureEvidenceLoss!, firstDroppedAt: 'invalid' },
      }),
    },
    {
      name: 'lastDroppedAt 非法日期',
      detail: 'failureEvidenceLoss.lastDroppedAt',
      change: (state: LLMRecoveryStateV1) => ({
        ...state,
        failureEvidenceLoss: { ...state.failureEvidenceLoss!, lastDroppedAt: 'invalid' },
      }),
    },
    {
      name: 'loss record 协议值非法',
      detail: 'failureEvidenceLoss',
      change: (state: LLMRecoveryStateV1) => ({
        ...state,
        failureEvidenceLoss: { ...state.failureEvidenceLoss!, policyVersion: 2 },
      }),
    },
    {
      name: 'updatedAt 非法日期',
      detail: 'updatedAt',
      change: (state: LLMRecoveryStateV1) => ({ ...state, updatedAt: 'invalid' }),
    },
  ])('拒绝 $name 并返回具体字段', ({ change, detail }) => {
    const invalid = validateRecoveryState(change(semanticState()), SCOPE);
    expect(invalid).toMatchObject({ ok: false, reason: 'field_type_mismatch', detail });
  });

  it('非法日期经 load 拒绝且原文件保持不变', async () => {
    const { dir, fs } = await makeTrackedDir();
    const filePath = path.join(dir, 'status', LLM_RECOVERY_STATE_FILE);
    fsNative.mkdirSync(path.dirname(filePath), { recursive: true });
    const raw = JSON.stringify({ ...createInitialRecoveryState(SCOPE, budget(), T0), updatedAt: 'invalid' });
    fsNative.writeFileSync(filePath, raw);

    const loaded = loadRecoveryState(fs, SCOPE);
    expect(loaded).toMatchObject({ kind: 'unusable', reason: 'field_type_mismatch', detail: 'updatedAt' });
    expect(fsNative.readFileSync(filePath, 'utf8')).toBe(raw);
  });
});
