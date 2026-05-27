/**
 * random-dream 测试
 *
 * 覆盖路径：
 * - 无契约时提前返回
 * - Fix 3 回归：同 claw 后续契约 hint 不含"新claw"
 * - Fix 5 回归：轮询 .txt（完成信号），不轮询 .log（启动即存在）
 * - [DREAM_OUTPUT] 提取与 inbox 投递
 * - state 更新
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as fsSync from 'fs';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { runRandomDream, type RandomDreamOptions } from '../../../src/core/memory/random-dream.js';
import { RANDOM_DREAM_SYSTEM_PROMPT } from '../../../src/core/memory/prompts/random-dream.js';
import { MEMORY_AUDIT_EVENTS } from '../../../src/core/memory/audit-events.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
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

const mockAudit = { write: vi.fn() };

function makeOpts(clawforumDir: string, motionDir: string): RandomDreamOptions {
  return {
    clawforumDir,
    motionDir,
    taskSystem: makeMockTaskSystem(),
    fs: new NodeFileSystem({ baseDir: clawforumDir }),
    motionFs: new NodeFileSystem({ baseDir: motionDir }),
    audit: mockAudit as any,
  };
}

/** 在 motionDir 创建 tasks/queues/results 目录并写入完成信号 */
async function writeTaskCompletion(motionDir: string, taskId: string, logContent: string) {
  const taskResultDir = path.join(motionDir, 'tasks', 'queues', 'results', taskId);
  await fs.mkdir(taskResultDir, { recursive: true });
  await fs.writeFile(path.join(taskResultDir, 'result.txt'), 'done', 'utf-8');
  await fs.writeFile(path.join(taskResultDir, 'daemon.log'), logContent, 'utf-8');
}

// ─── 测试 ─────────────────────────────────────────────────────

describe('runRandomDream', () => {
  let clawforumDir: string;
  let motionDir: string;
  const taskId = `task-${randomUUID()}`;

  beforeEach(async () => {
    vi.restoreAllMocks();
    clawforumDir = await createTempDir();
    motionDir = path.join(clawforumDir, 'motion');
    await fs.mkdir(path.join(motionDir, 'inbox', 'pending'), { recursive: true });
    mockWritePendingSubAgentTask.mockReset();
    mockWritePendingSubAgentTask.mockResolvedValue(taskId);
  });

  afterEach(async () => {
    await Promise.all([cleanupTempDir(clawforumDir), cleanupTempDir(motionDir)]);
    vi.clearAllMocks();
  });

  // ── 无契约 ──────────────────────────────────────────────────

  it('claws 目录不存在时直接返回', async () => {
    await expect(runRandomDream(makeOpts(clawforumDir, motionDir))).resolves.toBeUndefined();
    expect(mockWritePendingSubAgentTask).not.toHaveBeenCalled();
  }, 30000); // was default 15000ms

  it('claws 目录存在但无 archive 契约时直接返回', async () => {
    await fs.mkdir(path.join(clawforumDir, 'claws', 'claw-1', 'contract', 'archive'), { recursive: true });
    await expect(runRandomDream(makeOpts(clawforumDir, motionDir))).resolves.toBeUndefined();
    expect(mockWritePendingSubAgentTask).not.toHaveBeenCalled();
  });

  // ── 正常完成流程 ─────────────────────────────────────────────

  describe('有契约 + sub-agent 正常完成', () => {
    beforeEach(async () => {
      // 创建一个契约目录
      await fs.mkdir(
        path.join(clawforumDir, 'claws', 'claw-1', 'contract', 'archive', 'contract-001'),
        { recursive: true }
      );
    });

    it('sub-agent 完成后提取 [DREAM_OUTPUT]，写入 inbox，更新 state', async () => {
      const dreamLog = `=== SubAgent ${taskId} started ===
Prompt: ...
[DREAM_OUTPUT contract_id="contract-001"]
跨 claw 共性洞见：所有 claw 都在重复同样的错误模式
[/DREAM_OUTPUT]`;

      await writeTaskCompletion(motionDir, taskId, dreamLog);

      await runRandomDream(makeOpts(clawforumDir, motionDir));

      // state 更新
      const statePath = path.join(clawforumDir, '.random-dream-state.json');
      expect(fsSync.existsSync(statePath)).toBe(true);
      const state = JSON.parse(fsSync.readFileSync(statePath, 'utf-8'));
      expect(state.processedContractIds).toContain('contract-001');

      // inbox 消息写入
      const inboxFiles = fsSync.readdirSync(path.join(motionDir, 'inbox', 'pending'));
      const hasRandomDream = inboxFiles.some(f => fsSync.readFileSync(path.join(motionDir, 'inbox', 'pending', f), 'utf8').includes('type: random_dream'));
      expect(hasRandomDream).toBe(true);

      // DREAM_OUTPUT_PERSISTED audit emit（phase 814 Step C / P1.40）
      const persistedCall = mockAudit.write.mock.calls.find((c: any[]) =>
        c[0] === MEMORY_AUDIT_EVENTS.DREAM_OUTPUT_PERSISTED
      );
      expect(persistedCall).toBeTruthy();
      expect(persistedCall![1]).toMatch(/^dreamId=/);
      expect(persistedCall![2]).toMatch(/^path=memory\/dream-outputs\/.*\.txt$/);
      expect(persistedCall![3]).toMatch(/^bytes=\d+$/);
    });

    it('多个 [DREAM_OUTPUT] 块全部提取', async () => {
      // 创建第二个契约
      await fs.mkdir(
        path.join(clawforumDir, 'claws', 'claw-2', 'contract', 'archive', 'contract-002'),
        { recursive: true }
      );

      const dreamLog = `=== started ===
[DREAM_OUTPUT contract_id="contract-001"]
洞见 A
[/DREAM_OUTPUT]
[DREAM_OUTPUT contract_id="contract-002"]
洞见 B
[/DREAM_OUTPUT]`;

      await writeTaskCompletion(motionDir, taskId, dreamLog);

      await runRandomDream(makeOpts(clawforumDir, motionDir));

      const state = JSON.parse(fsSync.readFileSync(
        path.join(clawforumDir, '.random-dream-state.json'), 'utf-8'
      ));
      expect(state.processedContractIds).toContain('contract-001');
      expect(state.processedContractIds).toContain('contract-002');
    });

    it('log 中无 [DREAM_OUTPUT] 块时不写 inbox', async () => {
      await writeTaskCompletion(motionDir, taskId, '=== started ===\nsome output\n[DREAM_COMPLETE]');

      await runRandomDream(makeOpts(clawforumDir, motionDir));

      const inboxFiles = fsSync.readdirSync(path.join(motionDir, 'inbox', 'pending'));
      const randomDreamFiles = inboxFiles.filter(f => fsSync.readFileSync(path.join(motionDir, 'inbox', 'pending', f), 'utf8').includes('type: random_dream'));
      expect(randomDreamFiles).toHaveLength(0);
    });

    describe('Phase 546 — random-dream systemPrompt 透传', () => {
    it('passes RANDOM_DREAM_SYSTEM_PROMPT to writePendingSubAgentTask', async () => {
      await fs.mkdir(
        path.join(clawforumDir, 'claws', 'claw-1', 'contract', 'archive', 'contract-001'),
        { recursive: true }
      );
      await writeTaskCompletion(motionDir, taskId, '=== started ===');

      await runRandomDream(makeOpts(clawforumDir, motionDir));

      expect(mockWritePendingSubAgentTask).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          systemPrompt: RANDOM_DREAM_SYSTEM_PROMPT,
        })
      );
    });
  });

  // ── Fix 5 回归：轮询 .txt 而非 .log ─────────────────────────

    it('Fix 5 回归：仅 .log 存在时不提前返回', async () => {
      vi.useFakeTimers();
      try {
        // 创建 daemon.log（sub-agent 启动时就存在），但 result.txt 不存在
        const taskResultDir = path.join(motionDir, 'tasks', 'queues', 'results', taskId);
        await fs.mkdir(taskResultDir, { recursive: true });
        fsSync.writeFileSync(
          path.join(taskResultDir, 'daemon.log'),
          '=== SubAgent started ===\nPrompt: ...'
        );
        // result.txt 不存在

        const runPromise = runRandomDream(makeOpts(clawforumDir, motionDir));

        // 推进一个轮询周期（30 秒）
        await vi.advanceTimersByTimeAsync(30_001);

        // 此时 inbox 应仍为空（未完成）
        const inboxFiles = fsSync.readdirSync(path.join(motionDir, 'inbox', 'pending'));
        const randomDreamFiles = inboxFiles.filter(f => fsSync.readFileSync(path.join(motionDir, 'inbox', 'pending', f), 'utf8').includes('type: random_dream'));
      expect(randomDreamFiles).toHaveLength(0);

        // 写入 result.txt + 更新 daemon.log（模拟 sub-agent 完成）
        fsSync.writeFileSync(path.join(taskResultDir, 'result.txt'), 'done');
        fsSync.writeFileSync(
          path.join(taskResultDir, 'daemon.log'),
          `[DREAM_OUTPUT contract_id="contract-001"]跨 claw 洞见[/DREAM_OUTPUT]`
        );

        // 推进下一个轮询周期
        await vi.advanceTimersByTimeAsync(30_001);
        await runPromise;

        // 现在 inbox 应有消息
        const inboxFilesAfter = fsSync.readdirSync(path.join(motionDir, 'inbox', 'pending'));
        const hasRandomDreamAfter = inboxFilesAfter.some(f => fsSync.readFileSync(path.join(motionDir, 'inbox', 'pending', f), 'utf8').includes('type: random_dream'));
        expect(hasRandomDreamAfter).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── Fix 3 回归：同 claw 后续契约 hint 不含"新claw" ───────────

  it('Fix 3 回归：同一 claw 的第二个契约 hint 不含"新claw"', async () => {
    // 同一 claw 两个契约
    await fs.mkdir(
      path.join(clawforumDir, 'claws', 'claw-1', 'contract', 'archive', 'contract-A'),
      { recursive: true }
    );
    await fs.mkdir(
      path.join(clawforumDir, 'claws', 'claw-1', 'contract', 'archive', 'contract-B'),
      { recursive: true }
    );

    // 捕获传给 sub-agent 的 prompt
    let capturedPrompt = '';
    mockWritePendingSubAgentTask.mockImplementation(async (_audit: unknown, opts: { intent: string }) => {
      capturedPrompt = opts.intent;
      return taskId;
    });

    await writeTaskCompletion(motionDir, taskId, '=== started ===');

    await runRandomDream(makeOpts(clawforumDir, motionDir));

    expect(capturedPrompt).not.toBe('');
    const lines = capturedPrompt.split('\n').filter(l => l.includes('claw-1'));

    // 第一个契约可以有"新claw"，第二个不应有
    // 找到所有包含 contract-A 和 contract-B 的行
    const lineA = lines.find(l => l.includes('contract-A'));
    const lineB = lines.find(l => l.includes('contract-B'));

    if (lineA && lineB) {
      // 两行中，至多一行含"新claw"（首次出现保留，后续移除）
      const newClawCount = lines.filter(l => l.includes('新claw')).length;
      expect(newClawCount).toBeLessThanOrEqual(1);
    }
  });

  it('同 claw 多契约：仅首契约获「新claw」bonus（α / phase 585）', async () => {
    // claw-A 多契约 / claw-B 单契约 / 期望 claw-A 首契约 + claw-B 单契约获 hint「新claw」
    // claw-A 后续契约不获「新claw」hint（fixture 控）
    const clawAArchive = path.join(clawforumDir, 'claws', 'claw-A', 'contract', 'archive');
    const clawBArchive = path.join(clawforumDir, 'claws', 'claw-B', 'contract', 'archive');
    await fs.mkdir(path.join(clawAArchive, 'contract-A1'), { recursive: true });
    await fs.mkdir(path.join(clawAArchive, 'contract-A2'), { recursive: true });
    await fs.mkdir(path.join(clawBArchive, 'contract-B1'), { recursive: true });

    let capturedPrompt = '';
    mockWritePendingSubAgentTask.mockImplementation(async (_audit: unknown, opts: { intent: string }) => {
      capturedPrompt = opts.intent;
      return taskId;
    });
    await writeTaskCompletion(motionDir, taskId, '=== started ===');

    await runRandomDream(makeOpts(clawforumDir, motionDir));

    // prompt 各 contract 行的 hint 文案
    const lines = capturedPrompt.split('\n').filter(l => l.match(/^\d+\./));
    const lineA1 = lines.find(l => l.includes('contract-A1')) ?? '';
    const lineA2 = lines.find(l => l.includes('contract-A2')) ?? '';
    const lineB1 = lines.find(l => l.includes('contract-B1')) ?? '';

    // claw-A 首契约（discovery 顺序 = listSync 顺序 / contract-A1 或 -A2 取决于 fs 排序）
    // 关键 invariant：claw-A 两 contract 中**仅 1 个**含「新claw」/ 不是两个都含 / 也不是 0 个
    const aHints = [lineA1, lineA2].filter(l => l.includes('新claw'));
    expect(aHints.length).toBe(1);  // 反 phase 582 前 bug：两个都含 / 反 β 删 clawsSeen 修：0 个

    // claw-B 单契约必含「新claw」
    expect(lineB1).toContain('新claw');
  });

  // ── 已处理契约降权 ──────────────────────────────────────────

  it('已处理契约排序靠后（权重 -80）', async () => {
    // 两个 claw 各一个契约
    await fs.mkdir(
      path.join(clawforumDir, 'claws', 'claw-new', 'contract', 'archive', 'contract-new'),
      { recursive: true }
    );
    await fs.mkdir(
      path.join(clawforumDir, 'claws', 'claw-old', 'contract', 'archive', 'contract-old'),
      { recursive: true }
    );

    // 预置 state：contract-old 已处理
    await fs.writeFile(
      path.join(clawforumDir, '.random-dream-state.json'),
      JSON.stringify({ processedContractIds: ['contract-old'] }),
      'utf-8'
    );

    let capturedPrompt = '';
    mockWritePendingSubAgentTask.mockImplementation(async (_audit: unknown, opts: { intent: string }) => {
      capturedPrompt = opts.intent;
      return taskId;
    });

    await writeTaskCompletion(motionDir, taskId, '=== started ===');

    await runRandomDream(makeOpts(clawforumDir, motionDir));

    expect(capturedPrompt).not.toBe('');
    const lines = capturedPrompt.split('\n').filter(l => l.match(/^\d+\./));

    // contract-new 应排在 contract-old 前面
    const idxNew = lines.findIndex(l => l.includes('contract-new'));
    const idxOld = lines.findIndex(l => l.includes('contract-old'));
    if (idxNew >= 0 && idxOld >= 0) {
      expect(idxNew).toBeLessThan(idxOld);
    }
  });

  // ── computeWeight：progress.json 加权 ─────────────────────

  it('近期完成的契约权重高于普通契约', async () => {
    // contract-recent：有近期完成的 subtask
    const recentDir = path.join(clawforumDir, 'claws', 'claw-1', 'contract', 'archive', 'contract-recent');
    await fs.mkdir(recentDir, { recursive: true });
    await fs.writeFile(path.join(recentDir, 'progress.json'), JSON.stringify({
      subtasks: {
        s1: { status: 'completed', completed_at: new Date(Date.now() - 1000 * 60 * 60).toISOString() }, // 1 小时前
      },
    }), 'utf-8');

    // contract-old：有很久以前完成的 subtask（几乎没有加权）
    const oldDir = path.join(clawforumDir, 'claws', 'claw-2', 'contract', 'archive', 'contract-old-done');
    await fs.mkdir(oldDir, { recursive: true });
    await fs.writeFile(path.join(oldDir, 'progress.json'), JSON.stringify({
      subtasks: {
        s1: { status: 'completed', completed_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 60).toISOString() }, // 60 天前
      },
    }), 'utf-8');

    let capturedPrompt = '';
    mockWritePendingSubAgentTask.mockImplementation(async (_audit: unknown, opts: { intent: string }) => {
      capturedPrompt = opts.intent;
      return taskId;
    });
    await writeTaskCompletion(motionDir, taskId, '=== started ===');

    await runRandomDream(makeOpts(clawforumDir, motionDir));

    const lines = capturedPrompt.split('\n').filter(l => l.match(/^\d+\./));
    const idxRecent = lines.findIndex(l => l.includes('contract-recent'));
    const idxOldDone = lines.findIndex(l => l.includes('contract-old-done'));
    if (idxRecent >= 0 && idxOldDone >= 0) {
      expect(idxRecent).toBeLessThan(idxOldDone);
    }
  });

  it('有失败 subtask 的契约权重更高', async () => {
    // contract-failed：有 failed subtask
    const failedDir = path.join(clawforumDir, 'claws', 'claw-1', 'contract', 'archive', 'contract-failed');
    await fs.mkdir(failedDir, { recursive: true });
    await fs.writeFile(path.join(failedDir, 'progress.json'), JSON.stringify({
      subtasks: {
        s1: { status: 'failed' },
      },
    }), 'utf-8');

    // contract-normal：无 progress.json
    const normalDir = path.join(clawforumDir, 'claws', 'claw-2', 'contract', 'archive', 'contract-normal');
    await fs.mkdir(normalDir, { recursive: true });

    let capturedPrompt = '';
    mockWritePendingSubAgentTask.mockImplementation(async (_audit: unknown, opts: { intent: string }) => {
      capturedPrompt = opts.intent;
      return taskId;
    });
    await writeTaskCompletion(motionDir, taskId, '=== started ===');

    await runRandomDream(makeOpts(clawforumDir, motionDir));

    const lines = capturedPrompt.split('\n').filter(l => l.match(/^\d+\./));
    const idxFailed = lines.findIndex(l => l.includes('contract-failed'));
    const idxNormal = lines.findIndex(l => l.includes('contract-normal'));
    if (idxFailed >= 0 && idxNormal >= 0) {
      expect(idxFailed).toBeLessThan(idxNormal);
    }
  });

  // ── waitForTaskResult 超时路径 ──────────────────────────────

  // ── Phase 597 — random-dream state I/O 错误处理（mirror phase 561）────────

  describe('Phase 597 — random-dream state I/O 错误处理', () => {
    beforeEach(async () => {
      // 创建一个契约目录
      await fs.mkdir(
        path.join(clawforumDir, 'claws', 'claw-1', 'contract', 'archive', 'contract-001'),
        { recursive: true }
      );
    });

    it('loadRandomDreamState parse 错时 audit RANDOM_DREAM_ERROR step=load_state 并返空（A.dream-state-io-silent random-dream 扩散 phase 597）', async () => {
      // setup: 写入损坏 .random-dream-state.json
      await fs.writeFile(path.join(clawforumDir, '.random-dream-state.json'), 'corrupted{', 'utf-8');

      const dreamLog = `=== SubAgent ${taskId} started ===
[DREAM_OUTPUT contract_id="contract-001"]
跨 claw 共性洞见
[/DREAM_OUTPUT]`;
      await writeTaskCompletion(motionDir, taskId, dreamLog);

      await runRandomDream(makeOpts(clawforumDir, motionDir));

      expect(mockAudit.write).toHaveBeenCalledWith(
        'cron_random_dream_error',
        'step=load_state',
        expect.stringMatching(/^reason=/),
      );
    });

    it('loadRandomDreamState FileNotFoundError 时 silent 返空（首启良性）', async () => {
      // setup: 不写 .random-dream-state.json
      const dreamLog = `=== SubAgent ${taskId} started ===
[DREAM_OUTPUT contract_id="contract-001"]
跨 claw 共性洞见
[/DREAM_OUTPUT]`;
      await writeTaskCompletion(motionDir, taskId, dreamLog);

      await runRandomDream(makeOpts(clawforumDir, motionDir));

      const loadStateCalls = mockAudit.write.mock.calls.filter((c: any[]) =>
        c.some((arg: any) => typeof arg === 'string' && arg.includes('step=load_state'))
      );
      expect(loadStateCalls).toHaveLength(0);
    });

    it('saveRandomDreamState writeAtomicSync 失败时 audit step=save_state 并 re-throw', async () => {
      const clawforumNodeFs = new NodeFileSystem({ baseDir: clawforumDir });
      const writeSpy = vi.spyOn(clawforumNodeFs, 'writeAtomicSync').mockImplementation(function (this: NodeFileSystem, p: string, content: string) {
        if (p === '.random-dream-state.json') {
          throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
        }
        return NodeFileSystem.prototype.writeAtomicSync.call(this as any, p, content);
      });

      const dreamLog = `=== SubAgent ${taskId} started ===
[DREAM_OUTPUT contract_id="contract-001"]
跨 claw 共性洞见
[/DREAM_OUTPUT]`;
      await writeTaskCompletion(motionDir, taskId, dreamLog);

      await expect(runRandomDream({ ...makeOpts(clawforumDir, motionDir), fs: clawforumNodeFs, audit: mockAudit })).rejects.toThrow();

      expect(mockAudit.write).toHaveBeenCalledWith(
        'cron_random_dream_error',
        'step=save_state',
        expect.stringMatching(/^reason=.*EIO/),
      );

      writeSpy.mockRestore();
    });
  });

  // ── waitForTaskResult 超时路径 ──────────────────────────────

  it('sub-agent 超时：.txt 始终不出现，不写 inbox', async () => {
    vi.useFakeTimers();
    try {
      await fs.mkdir(
        path.join(clawforumDir, 'claws', 'claw-1', 'contract', 'archive', 'contract-timeout'),
        { recursive: true }
      );
      const taskResultDir = path.join(motionDir, 'tasks', 'queues', 'results', taskId);
      await fs.mkdir(taskResultDir, { recursive: true });
      // 只有 daemon.log，没有 result.txt
      fsSync.writeFileSync(
        path.join(taskResultDir, 'daemon.log'),
        '=== started ==='
      );

      const runPromise = runRandomDream(makeOpts(clawforumDir, motionDir));

      // 推进超过 1 小时（3_600_000 ms）
      await vi.advanceTimersByTimeAsync(3_600_001);
      await runPromise;

      // 不应写 inbox
      const inboxFiles = fsSync.readdirSync(path.join(motionDir, 'inbox', 'pending'));
      const randomDreamFiles = inboxFiles.filter(f => fsSync.readFileSync(path.join(motionDir, 'inbox', 'pending', f), 'utf8').includes('type: random_dream'));
      expect(randomDreamFiles).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
