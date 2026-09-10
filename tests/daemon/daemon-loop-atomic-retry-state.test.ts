/**
 * Phase 1826: LLM 恢复状态的持久化原子性与迁移交接。
 *
 * 旧 daemon-loop saveLlmRetryState（EventLoop 自持）的 tmp+rename+fsync 语义
 * 已迁至 owner（LLMOrchestrator recovery-state）；本文件断言 owner 落盘仍为
 * 原子写（无 .tmp 残留、崩溃不产生半截状态），且旧 EventLoop 状态文件由新
 * owner 导入后原文保留（只读迁移证据）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsNative from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import {
  LLM_RECOVERY_STATE_FILE,
  createInitialRecoveryState,
  loadRecoveryState,
  saveRecoveryState,
} from '../../src/foundation/llm-orchestrator/index.js';
import type { LLMRecoveryBudget } from '../../src/foundation/llm-orchestrator/index.js';

const STATUS_SUBDIR = 'status';

function budget(): LLMRecoveryBudget {
  return { retryCount: 0, retryDelayMs: 30_000, quotaDelayMs: 120_000 };
}

describe('LLM recovery state atomic persistence (phase 1826)', () => {
  let agentDir: string;
  let fs: NodeFileSystem;

  beforeEach(() => {
    agentDir = fsNative.mkdtempSync(path.join(os.tmpdir(), `recovery-atomic-${randomUUID()}-`));
    fs = new NodeFileSystem({ baseDir: agentDir });
  });

  afterEach(() => {
    fsNative.rmSync(agentDir, { recursive: true, force: true });
  });

  it('writes atomically: no tmp file left behind, content readable', () => {
    const state = createInitialRecoveryState('foreground', budget(), Date.now());
    saveRecoveryState(fs, state);

    const statusDir = path.join(agentDir, STATUS_SUBDIR);
    const files = fsNative.readdirSync(statusDir);
    expect(files).toEqual([LLM_RECOVERY_STATE_FILE]);

    const loaded = loadRecoveryState(fs, 'foreground');
    expect(loaded.kind).toBe('ok');
    if (loaded.kind === 'ok') expect(loaded.state.scopeId).toBe('foreground');
  });

  it('a crash mid-write leaves the previous full state intact', () => {
    const first = createInitialRecoveryState('foreground', budget(), Date.now());
    saveRecoveryState(fs, first);

    // 模拟崩溃残留：一个未 rename 的临时文件（writeAtomicSync 的 tmp 前缀形状）。
    const statusDir = path.join(agentDir, STATUS_SUBDIR);
    fsNative.writeFileSync(path.join(statusDir, '.tmp_partial_write'), '{半截');

    const loaded = loadRecoveryState(fs, 'foreground');
    expect(loaded.kind).toBe('ok');
    if (loaded.kind === 'ok') expect(loaded.state.revision).toBe(first.revision);
  });

  it('replacement write swaps state in whole, never partially', () => {
    const first = createInitialRecoveryState('foreground', budget(), Date.now());
    saveRecoveryState(fs, first);

    const second = {
      ...first,
      revision: 9,
      schedule: { kind: 'at' as const, revision: 9, resumeAt: new Date(Date.now() + 60_000).toISOString() },
    };
    saveRecoveryState(fs, second);

    const loaded = loadRecoveryState(fs, 'foreground');
    expect(loaded.kind).toBe('ok');
    if (loaded.kind === 'ok') {
      expect(loaded.state.revision).toBe(9);
      expect(loaded.state.schedule.kind).toBe('at');
    }
    // 目标文件之外的临时残留不产生第二份状态
    const files = fsNative.readdirSync(path.join(agentDir, STATUS_SUBDIR)).filter(f => !f.startsWith('.tmp_'));
    expect(files).toEqual([LLM_RECOVERY_STATE_FILE]);
  });

  it('legacy llm-retry-state.json stays untouched as migration evidence', () => {
    // 旧 EventLoop 文件名仍在：迁移只读取，不删除、不覆写。
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

    const state = createInitialRecoveryState('foreground', budget(), Date.now());
    saveRecoveryState(fs, state);

    expect(fsNative.readFileSync(legacyPath, 'utf-8')).toBe(legacyRaw);
    expect(
      fsNative.existsSync(path.join(agentDir, STATUS_SUBDIR, LLM_RECOVERY_STATE_FILE)),
    ).toBe(true);
  });
});
