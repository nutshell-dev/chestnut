/**
 * Phase 170 — random-dream late-settle pending + sweep 反向 case
 *
 * 覆盖路径：
 * - timeout → pending 写入 + audit _PENDING
 * - sweep + result.txt 已存在 → consume + notify + entry drop + audit _CONSUMED
 * - sweep + result.txt 未存在 + 未过 grace → 保 entry + 0 notify
 * - sweep + result.txt 未存在 + 超 grace → abandon + audit _ABANDONED
 * - 既有 state 缺 pendingLateSettle → backward compat load default []
 * - sweep 同 entry 重入 idempotent
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fsSync from 'fs';
import { promises as fs } from 'fs';
import { runRandomDream, type RandomDreamOptions } from '../../../src/core/memory/random-dream.js';
import { MEMORY_AUDIT_EVENTS } from '../../../src/core/memory/audit-events.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { routeNotifyClaw } from '../../../src/core/claw-topology/index.js';
import { MOTION_CLAW_ID } from '../../../src/core/claw-topology/index.js';
import type { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';

// ─── AsyncTaskSystem mock ──────────────────────────────────────────

const mockWritePendingSubAgentTask = vi.fn();

function makeMockTaskSystem(): AsyncTaskSystem {
  return {
    schedule: mockWritePendingSubAgentTask,
  } as unknown as AsyncTaskSystem;
}

// ─── 工具函数 ─────────────────────────────────────────────────

const mockAudit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};

function makeOpts(chestnutRoot: string, motionDir: string): RandomDreamOptions {
  const fs = new NodeFileSystem({ baseDir: chestnutRoot });
  return {
    motionDir: motionDir as any,
    taskSystem: makeMockTaskSystem(),
    fs,
    motionFs: new NodeFileSystem({ baseDir: motionDir }),
    audit: mockAudit as any,
    notifyMotion: (msg) => routeNotifyClaw(fs, chestnutRoot, MOTION_CLAW_ID, MOTION_CLAW_ID, msg, mockAudit as any),
  };
}

async function writeTaskCompletion(motionDir: string, taskId: string, logContent: string) {
  const taskResultDir = path.join(motionDir, 'tasks', 'queues', 'results', taskId);
  await fs.mkdir(taskResultDir, { recursive: true });
  await fs.writeFile(path.join(taskResultDir, 'result.txt'), 'done', 'utf-8');
  await fs.writeFile(path.join(taskResultDir, 'daemon.log'), logContent, 'utf-8');
}

// ─── 测试 ─────────────────────────────────────────────────────

describe('random-dream late-settle (phase 170)', () => {
  let chestnutRoot: string;
  let motionDir: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    chestnutRoot = await createTempDir();
    motionDir = path.join(chestnutRoot, 'motion');
    await fs.mkdir(path.join(motionDir, 'inbox', 'pending'), { recursive: true });
    mockWritePendingSubAgentTask.mockReset();
    mockAudit.write.mockReset();
  });

  afterEach(async () => {
    await Promise.all([cleanupTempDir(chestnutRoot), cleanupTempDir(motionDir)]);
    vi.clearAllMocks();
  });

  // ── case 1: timeout → pending 写入 ────────────────────────────

  it('timeout 写 pending state + emit _PENDING', async () => {
    vi.useFakeTimers();
    try {
      await fs.mkdir(
        path.join(chestnutRoot, 'claws', 'claw-1', 'contract', 'archive', 'contract-001'),
        { recursive: true }
      );
      const taskId = 'task-timeout-1';
      mockWritePendingSubAgentTask.mockResolvedValue(taskId);

      const taskResultDir = path.join(motionDir, 'tasks', 'queues', 'results', taskId);
      await fs.mkdir(taskResultDir, { recursive: true });
      // 只有 daemon.log，没有 result.txt → timeout
      fsSync.writeFileSync(path.join(taskResultDir, 'daemon.log'), '=== started ===');

      const runPromise = runRandomDream({ ...makeOpts(chestnutRoot, motionDir), subagentTimeoutMs: 1000, pulseIntervalMs: 10 });
      await vi.advanceTimersByTimeAsync(1_001);
      await runPromise;

      // state 文件应含 pendingLateSettle entry
      const statePath = path.join(chestnutRoot, '.random-dream-state.json');
      expect(fsSync.existsSync(statePath)).toBe(true);
      const state = JSON.parse(fsSync.readFileSync(statePath, 'utf-8'));
      expect(state.pendingLateSettle).toHaveLength(1);
      expect(state.pendingLateSettle[0].taskId).toBe(taskId);

      // audit 含 _PENDING + 既有 SUBAGENT_TIMEOUT
      const pendingCalls = mockAudit.write.mock.calls.filter((c: any[]) =>
        c[0] === MEMORY_AUDIT_EVENTS.RANDOM_DREAM_LATE_SETTLE_PENDING
      );
      expect(pendingCalls).toHaveLength(1);
      expect(pendingCalls[0][1]).toMatch(/^taskId=/);

      const timeoutCalls = mockAudit.write.mock.calls.filter((c: any[]) =>
        c[0] === MEMORY_AUDIT_EVENTS.RANDOM_DREAM_SUBAGENT_TIMEOUT
      );
      expect(timeoutCalls).toHaveLength(1);

      // 0 motion notify
      const inboxFiles = fsSync.readdirSync(path.join(motionDir, 'inbox', 'pending'));
      const randomDreamFiles = inboxFiles.filter(f =>
        fsSync.readFileSync(path.join(motionDir, 'inbox', 'pending', f), 'utf8').includes('type: random_dream')
      );
      expect(randomDreamFiles).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── case 2: sweep + result.txt 存在 → consume ─────────────────

  it('sweep + result.txt 存在 → consume + notify + entry drop', async () => {
    const taskId = 'late-1';
    const now = Date.now();
    // state 文件预置 pending entry
    await fs.writeFile(
      path.join(chestnutRoot, '.random-dream-state.json'),
      JSON.stringify({
        lastProcessedRandomDreamAt: 0,
        pendingLateSettle: [{
          taskId,
          scheduledAt: now - 3600_000,
          expectedTimeoutAt: now - 60_000,
        }],
      }),
      'utf-8'
    );

    const dreamLog = `[DREAM_OUTPUT contract_id="c1"]跨 claw 洞见[/DREAM_OUTPUT]`;
    await writeTaskCompletion(motionDir, taskId, dreamLog);

    // mock discoverWeightedContracts 返 [] (skip pulse、仅触 sweep)
    // 但 discoverWeightedContracts 依赖 listArchiveContracts，需要无 archive 目录
    // 这里直接不创建 claws 目录即可让 discover 返 []

    await runRandomDream(makeOpts(chestnutRoot, motionDir));

    // dream-outputs snapshot 写入
    const dreamOutputPath = path.join(motionDir, 'memory', 'dream-outputs', `${taskId}.txt`);
    expect(fsSync.existsSync(dreamOutputPath)).toBe(true);
    const content = fsSync.readFileSync(dreamOutputPath, 'utf-8');
    expect(content).toContain('跨 claw 洞见');

    // motion notify (idPrefix 含 late_settle)
    const inboxFiles = fsSync.readdirSync(path.join(motionDir, 'inbox', 'pending'));
    const randomDreamFiles = inboxFiles.filter(f =>
      fsSync.readFileSync(path.join(motionDir, 'inbox', 'pending', f), 'utf8').includes('type: random_dream')
    );
    expect(randomDreamFiles).toHaveLength(1);

    // state 文件 entry drop
    const state = JSON.parse(fsSync.readFileSync(path.join(chestnutRoot, '.random-dream-state.json'), 'utf-8'));
    expect(state.pendingLateSettle).toHaveLength(0);

    // audit 含 _CONSUMED + DREAM_OUTPUT_PERSISTED
    const consumedCalls = mockAudit.write.mock.calls.filter((c: any[]) =>
      c[0] === MEMORY_AUDIT_EVENTS.RANDOM_DREAM_LATE_SETTLE_CONSUMED
    );
    expect(consumedCalls).toHaveLength(1);

    const persistedCalls = mockAudit.write.mock.calls.filter((c: any[]) =>
      c[0] === MEMORY_AUDIT_EVENTS.DREAM_OUTPUT_PERSISTED
    );
    expect(persistedCalls).toHaveLength(1);
  });

  // ── case 3: result.txt 未存在 + 未过 grace → 保 ──────────────

  it('result.txt 未存在 + 未过 grace → 保 entry + 0 notify', async () => {
    const now = Date.now();
    await fs.writeFile(
      path.join(chestnutRoot, '.random-dream-state.json'),
      JSON.stringify({
        lastProcessedRandomDreamAt: 0,
        pendingLateSettle: [{
          taskId: 'p-1',
          scheduledAt: now - 3 * 24 * 60 * 60_000, // 3 天前
          expectedTimeoutAt: now - 3 * 24 * 60 * 60_000 + 3600_000,
        }],
      }),
      'utf-8'
    );

    await runRandomDream(makeOpts(chestnutRoot, motionDir));

    const state = JSON.parse(fsSync.readFileSync(path.join(chestnutRoot, '.random-dream-state.json'), 'utf-8'));
    expect(state.pendingLateSettle).toHaveLength(1);
    expect(state.pendingLateSettle[0].taskId).toBe('p-1');

    // 0 audit _CONSUMED / _ABANDONED
    const consumedCalls = mockAudit.write.mock.calls.filter((c: any[]) =>
      c[0] === MEMORY_AUDIT_EVENTS.RANDOM_DREAM_LATE_SETTLE_CONSUMED
    );
    expect(consumedCalls).toHaveLength(0);

    const abandonedCalls = mockAudit.write.mock.calls.filter((c: any[]) =>
      c[0] === MEMORY_AUDIT_EVENTS.RANDOM_DREAM_LATE_SETTLE_ABANDONED
    );
    expect(abandonedCalls).toHaveLength(0);

    // 0 motion notify
    const inboxFiles = fsSync.readdirSync(path.join(motionDir, 'inbox', 'pending'));
    const randomDreamFiles = inboxFiles.filter(f =>
      fsSync.readFileSync(path.join(motionDir, 'inbox', 'pending', f), 'utf8').includes('type: random_dream')
    );
    expect(randomDreamFiles).toHaveLength(0);
  });

  // ── case 4: result.txt 未存在 + 超 grace → abandon ───────────

  it('result.txt 未存在 + 超 grace → abandon + 0 notify', async () => {
    const now = Date.now();
    await fs.writeFile(
      path.join(chestnutRoot, '.random-dream-state.json'),
      JSON.stringify({
        lastProcessedRandomDreamAt: 0,
        pendingLateSettle: [{
          taskId: 'a-1',
          scheduledAt: now - 8 * 24 * 60 * 60_000, // 8 天前
          expectedTimeoutAt: now - 8 * 24 * 60 * 60_000 + 3600_000,
        }],
      }),
      'utf-8'
    );

    await runRandomDream(makeOpts(chestnutRoot, motionDir));

    const state = JSON.parse(fsSync.readFileSync(path.join(chestnutRoot, '.random-dream-state.json'), 'utf-8'));
    expect(state.pendingLateSettle).toHaveLength(0);

    // audit 含 _ABANDONED + age_ms + grace_ms
    const abandonedCalls = mockAudit.write.mock.calls.filter((c: any[]) =>
      c[0] === MEMORY_AUDIT_EVENTS.RANDOM_DREAM_LATE_SETTLE_ABANDONED
    );
    expect(abandonedCalls).toHaveLength(1);
    expect(abandonedCalls[0][1]).toMatch(/^taskId=/);
    expect(abandonedCalls[0][2]).toMatch(/^age_ms=/);
    expect(abandonedCalls[0][3]).toMatch(/^grace_ms=/);

    // 0 motion notify
    const inboxFiles = fsSync.readdirSync(path.join(motionDir, 'inbox', 'pending'));
    const randomDreamFiles = inboxFiles.filter(f =>
      fsSync.readFileSync(path.join(motionDir, 'inbox', 'pending', f), 'utf8').includes('type: random_dream')
    );
    expect(randomDreamFiles).toHaveLength(0);
  });

  // ── case 5: backward compat ───────────────────────────────────

  it('legacy state 含 processedContractIds → load migration + skip_empty 不覆写文件', async () => {
    await fs.writeFile(
      path.join(chestnutRoot, '.random-dream-state.json'),
      JSON.stringify({ processedContractIds: ['c-old'] }),
      'utf-8'
    );

    await runRandomDream(makeOpts(chestnutRoot, motionDir));

    // 0 shape_invalid audit
    const shapeInvalidCalls = mockAudit.write.mock.calls.filter((c: any[]) =>
      c.some((arg: any) => typeof arg === 'string' && arg.includes('shape_invalid'))
    );
    expect(shapeInvalidCalls).toHaveLength(0);

    // migration audit emit（load 时触发）
    const migrationCalls = mockAudit.write.mock.calls.filter((c: any[]) =>
      c[0] === MEMORY_AUDIT_EVENTS.LEGACY_SCHEMA_MIGRATED_RESET
    );
    expect(migrationCalls).toHaveLength(1);

    // skip_empty 不触发 save，文件保持原样（legacy schema）
    const diskState = JSON.parse(fsSync.readFileSync(path.join(chestnutRoot, '.random-dream-state.json'), 'utf-8'));
    expect(diskState.processedContractIds).toContain('c-old');
    expect(diskState.lastProcessedRandomDreamAt).toBeUndefined();
  });

  // ── case 6: sweep 同 entry 重入 idempotent ────────────────────

  it('sweep 同 entry 重入 idempotent + motion dedup', async () => {
    const taskId = 't-1';
    const now = Date.now();
    // 预置 state + result.txt
    await fs.writeFile(
      path.join(chestnutRoot, '.random-dream-state.json'),
      JSON.stringify({
        lastProcessedRandomDreamAt: 0,
        pendingLateSettle: [{
          taskId,
          scheduledAt: now - 3600_000,
          expectedTimeoutAt: now - 60_000,
        }],
      }),
      'utf-8'
    );

    const dreamLog = `[DREAM_OUTPUT contract_id="c1"]洞见[/DREAM_OUTPUT]`;
    await writeTaskCompletion(motionDir, taskId, dreamLog);

    const opts = makeOpts(chestnutRoot, motionDir);

    // 1st sweep
    await runRandomDream(opts);

    // state 已清 pending
    const stateAfter1 = JSON.parse(fsSync.readFileSync(path.join(chestnutRoot, '.random-dream-state.json'), 'utf-8'));
    expect(stateAfter1.pendingLateSettle).toHaveLength(0);

    // 手动把 state 改回 pending（模拟 race：sweep 已消费但 state 未落盘前的旧视图）
    await fs.writeFile(
      path.join(chestnutRoot, '.random-dream-state.json'),
      JSON.stringify({
        lastProcessedRandomDreamAt: 0,
        pendingLateSettle: [{
          taskId,
          scheduledAt: now - 3600_000,
          expectedTimeoutAt: now - 60_000,
        }],
      }),
      'utf-8'
    );

    // 2nd sweep（重入）
    await runRandomDream(opts);

    // snapshot path 仍写（覆写 same path、不视作 break）
    const dreamOutputPath = path.join(motionDir, 'memory', 'dream-outputs', `${taskId}.txt`);
    expect(fsSync.existsSync(dreamOutputPath)).toBe(true);

    // notifyMotion 调 2 次但 idPrefix 同（含 taskId）
    const inboxFiles = fsSync.readdirSync(path.join(motionDir, 'inbox', 'pending'));
    const randomDreamFiles = inboxFiles.filter(f =>
      fsSync.readFileSync(path.join(motionDir, 'inbox', 'pending', f), 'utf8').includes('type: random_dream')
    );
    // 2 次 notify 写 2 个 inbox file（timestamp+uuid 不同），但内容 idPrefix 一致
    expect(randomDreamFiles.length).toBeGreaterThanOrEqual(1);

    // state 最终 pending = []
    const stateFinal = JSON.parse(fsSync.readFileSync(path.join(chestnutRoot, '.random-dream-state.json'), 'utf-8'));
    expect(stateFinal.pendingLateSettle).toHaveLength(0);
  });
});
