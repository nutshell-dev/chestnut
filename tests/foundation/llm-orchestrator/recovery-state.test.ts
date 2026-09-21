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

});
