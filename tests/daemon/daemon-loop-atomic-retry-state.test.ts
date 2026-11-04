/**
 * Phase 2055：旧 EventLoop retry 状态只读迁移到 llm-instance-state.json V2。
 * 原子 tmp+rename+fsync、崩溃不覆盖完整旧状态等屏障统一归 instance-state writer。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsNative from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';

import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import {
  loadRecoveryState,
  type LLMRecoveryBudget,
} from '../../src/foundation/llm-orchestrator/recovery-state.js';
import {
  LLM_INSTANCE_STATE_FILE,
  createEmptyLLMInstanceState,
  loadLLMInstanceState,
  saveLLMInstanceState,
  upgradeLLMInstanceState,
} from '../../src/foundation/llm-orchestrator/instance-state.js';

const STATUS_SUBDIR = 'status';

function budget(): LLMRecoveryBudget {
  return { retryCount: 0, retryDelayMs: 30_000, quotaDelayMs: 120_000 };
}

describe('LLM instance recovery state atomic persistence (phase 2055)', () => {
  let agentDir: string;
  let fs: NodeFileSystem;

  beforeEach(() => {
    agentDir = fsNative.mkdtempSync(path.join(os.tmpdir(), `recovery-atomic-${randomUUID()}-`));
    fs = new NodeFileSystem({ baseDir: agentDir });
  });

  afterEach(() => {
    fsNative.rmSync(agentDir, { recursive: true, force: true });
  });

  it('writes V2 atomically: no tmp file left behind, content readable', () => {
    const state = { ...createEmptyLLMInstanceState('instance-a'), revision: 1, updatedAt: new Date().toISOString() };
    saveLLMInstanceState(fs, state);

    const files = fsNative.readdirSync(path.join(agentDir, STATUS_SUBDIR));
    expect(files).toEqual([LLM_INSTANCE_STATE_FILE]);
    expect(loadLLMInstanceState(fs)).toEqual({ kind: 'ok', state });
  });

  it('a crash mid-write leaves the previous full V2 state intact', () => {
    const first = { ...createEmptyLLMInstanceState('instance-a'), revision: 1, updatedAt: new Date().toISOString() };
    saveLLMInstanceState(fs, first);
    const statusDir = path.join(agentDir, STATUS_SUBDIR);
    fsNative.writeFileSync(path.join(statusDir, '.tmp_partial_write'), '{半截');

    const loaded = loadLLMInstanceState(fs);
    expect(loaded.kind).toBe('ok');
    if (loaded.kind === 'ok') expect(loaded.state).toEqual(first);
  });

  it('replacement write swaps recovery facts in whole, never partially', () => {
    const first = { ...createEmptyLLMInstanceState('instance-a'), revision: 1, updatedAt: new Date().toISOString() };
    saveLLMInstanceState(fs, first);
    const retryAt = new Date(Date.now() + 60_000).toISOString();
    const second = {
      ...first,
      revision: 9,
      recovery: {
        ...first.recovery,
        providers: [{
          providerId: 'provider-a', errorClass: 'transient', at: new Date().toISOString(),
          consecutiveFailures: 1, detail: 'offline', blocking: true, retryAt,
        }],
      },
    };
    saveLLMInstanceState(fs, second);

    const loaded = loadLLMInstanceState(fs);
    expect(loaded.kind).toBe('ok');
    if (loaded.kind === 'ok') {
      expect(loaded.state.revision).toBe(9);
      expect(loaded.state.recovery.providers[0]).toMatchObject({ blocking: true, retryAt });
    }
    const files = fsNative.readdirSync(path.join(agentDir, STATUS_SUBDIR)).filter(file => !file.startsWith('.tmp_'));
    expect(files).toEqual([LLM_INSTANCE_STATE_FILE]);
  });

  it('imports known legacy llm-retry-state.json and keeps it untouched as evidence', () => {
    const legacyPath = path.join(agentDir, STATUS_SUBDIR, 'llm-retry-state.json');
    fsNative.mkdirSync(path.dirname(legacyPath), { recursive: true });
    const legacyRaw = JSON.stringify({
      schema_version: 2,
      llmRetryCount: 1,
      llmRetryDelayMs: 30_000,
      llmRetryPending: false,
      waiting: null,
    });
    fsNative.writeFileSync(legacyPath, legacyRaw);

    const loaded = loadRecoveryState(fs, 'foreground', STATUS_SUBDIR, budget(), Date.now());
    expect(loaded).toMatchObject({ kind: 'ok', imported: true });
    if (loaded.kind !== 'ok') return;
    expect(loaded.state.importedSources).toEqual(['status/llm-retry-state.json#schema_version=2']);
    const migrated = upgradeLLMInstanceState(undefined, loaded.state, Date.now());
    saveLLMInstanceState(fs, migrated);

    expect(fsNative.readFileSync(legacyPath, 'utf-8')).toBe(legacyRaw);
    expect(fsNative.existsSync(path.join(agentDir, STATUS_SUBDIR, LLM_INSTANCE_STATE_FILE))).toBe(true);
    expect(loadLLMInstanceState(fs)).toEqual({ kind: 'ok', state: migrated });
  });
});
