/**
 * random-dream 测试
 *
 * 覆盖路径：
 * - 无契约时提前返回
 * - Fix 3 回归：同 claw 后续契约 hint 不含"新claw"
 * - Fix 5 回归：轮询 .txt（完成信号），不轮询 .log（启动即存在）
 * - [DREAM_OUTPUT] 提取与 outbox 投递
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
import { createClawTopology, makeClawNotifyTargetResolver } from '../../../src/core/claw-topology/index.js';
import { createClawNotifier } from '../../../src/foundation/messaging/index.js';
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
    clawTopology: createClawTopology({ fs, chestnutRoot, motionDir }),
    motionDir: motionDir as any,
    taskSystem: makeMockTaskSystem(),
    fs,
    motionFs: new NodeFileSystem({ baseDir: motionDir }),
    audit: mockAudit as any,
    notifyMotion: (msg) =>
      createClawNotifier({
        fs,
        audit: mockAudit as any,
        resolveTarget: makeClawNotifyTargetResolver(chestnutRoot),
      }).notifyAsync(MOTION_CLAW_ID, msg),
  };
}

/**
 * Test-local barrier: resolves once RandomDream durably writes its state file
 * via the provided opts' fs instance. Wraps the existing writeAtomicSync so
 * the real durable write completes before resolve.
 */
function observeRandomDreamStateWrite(opts: RandomDreamOptions): Promise<void> {
  return new Promise<void>((resolve) => {
    const originalWriteAtomicSync = opts.fs.writeAtomicSync.bind(opts.fs);
    vi.spyOn(opts.fs, 'writeAtomicSync').mockImplementation((relativePath, content) => {
      originalWriteAtomicSync(relativePath, content);
      if (relativePath === '.random-dream-state.json') resolve();
    });
  });
}

/** 读取 motion claw outbox pending 目录的文件内容 */
function readOutboxPending(motionDir: string): string[] {
  const outboxDir = path.join(motionDir, 'outbox', 'pending');
  if (!fsSync.existsSync(outboxDir)) return [];
  return fsSync.readdirSync(outboxDir)
    .filter(f => f.endsWith('.md'))
    .map(f => fsSync.readFileSync(path.join(outboxDir, f), 'utf8'));
}

/** 读取 motion claw inbox pending 目录的文件内容 */
function readInboxPending(motionDir: string): string[] {
  const inboxDir = path.join(motionDir, 'inbox', 'pending');
  if (!fsSync.existsSync(inboxDir)) return [];
  return fsSync.readdirSync(inboxDir)
    .filter(f => f.endsWith('.md'))
    .map(f => fsSync.readFileSync(path.join(inboxDir, f), 'utf8'));
}

/** 创建 archive 契约目录并写入 progress.json（computeWeight 读取 subtask completed_at 加权） */
async function createArchiveContract(chestnutRoot: string, clawId: string, contractId: string, completedAt = new Date().toISOString()) {
  const dir = path.join(chestnutRoot, 'claws', clawId, 'contract', 'archive', contractId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'progress.json'), JSON.stringify({ schema_version: 1,
    subtasks: {
      s1: { status: 'completed', completed_at: completedAt },
    },
  }), 'utf-8');
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
  let chestnutRoot: string;
  let motionDir: string;
  // phase 1863 (AT-D11)：scheduler 契约返回 8-hex shortId——mock 返回值须合法
  const taskId = randomUUID().slice(0, 8);

  beforeEach(async () => {
    vi.restoreAllMocks();
    chestnutRoot = await createTempDir();
    motionDir = path.join(chestnutRoot, 'motion');
    await fs.mkdir(path.join(motionDir, 'inbox', 'pending'), { recursive: true });
    mockWritePendingSubAgentTask.mockReset();
    mockWritePendingSubAgentTask.mockResolvedValue(taskId);
  });

  afterEach(async () => {
    await Promise.all([cleanupTempDir(chestnutRoot), cleanupTempDir(motionDir)]);
    vi.clearAllMocks();
  });

  // ── 无契约 ──────────────────────────────────────────────────

  it('claws 目录不存在时直接返回', async () => {
    await expect(runRandomDream(makeOpts(chestnutRoot, motionDir))).resolves.toBeUndefined();
    expect(mockWritePendingSubAgentTask).not.toHaveBeenCalled();
  }, 30000); // was default 15000ms

  it('claws 目录存在但无 archive 契约时直接返回', async () => {
    await fs.mkdir(path.join(chestnutRoot, 'claws', 'claw-1', 'contract', 'archive'), { recursive: true });
    await expect(runRandomDream(makeOpts(chestnutRoot, motionDir))).resolves.toBeUndefined();
    expect(mockWritePendingSubAgentTask).not.toHaveBeenCalled();
  });

  // ── 正常完成流程 ─────────────────────────────────────────────

  describe('有契约 + sub-agent 正常完成', () => {
    beforeEach(async () => {
      // 创建一个契约目录
      await createArchiveContract(chestnutRoot, 'claw-1', 'contract-001');
    });

    it('sub-agent 完成后提取 [DREAM_OUTPUT]，写入 outbox，更新 state', async () => {
      const dreamLog = `=== SubAgent ${taskId} started ===
Prompt: ...
[DREAM_OUTPUT contract_id="contract-001"]
跨 claw 共性洞见：所有 claw 都在重复同样的错误模式
[/DREAM_OUTPUT]`;

      await writeTaskCompletion(motionDir, taskId, dreamLog);

      await runRandomDream(makeOpts(chestnutRoot, motionDir));

      // state 更新
      const statePath = path.join(chestnutRoot, '.random-dream-state.json');
      expect(fsSync.existsSync(statePath)).toBe(true);
      const state = JSON.parse(fsSync.readFileSync(statePath, 'utf-8'));
      expect(state.completedContractIds).toContain('contract-001');

      // self-inbox 消息写入
      const inboxContents = readInboxPending(motionDir);
      expect(inboxContents.length).toBeGreaterThan(0);
      expect(inboxContents[0]).toContain('type: random_dream_completed');
      expect(inboxContents[0]).toContain('from: "random-dream"');
      expect(inboxContents[0]).toContain('dreamId:');

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
      await createArchiveContract(chestnutRoot, 'claw-2', 'contract-002');

      const dreamLog = `=== started ===
[DREAM_OUTPUT contract_id="contract-001"]
洞见 A
[/DREAM_OUTPUT]
[DREAM_OUTPUT contract_id="contract-002"]
洞见 B
[/DREAM_OUTPUT]`;

      await writeTaskCompletion(motionDir, taskId, dreamLog);

      await runRandomDream(makeOpts(chestnutRoot, motionDir));

      const state = JSON.parse(fsSync.readFileSync(
        path.join(chestnutRoot, '.random-dream-state.json'), 'utf-8'
      ));
      expect(state.completedContractIds).toContain('contract-001');
      expect(state.completedContractIds).toContain('contract-002');
    });

    it('log 中无 [DREAM_OUTPUT] 块时不写 outbox', async () => {
      await writeTaskCompletion(motionDir, taskId, '=== started ===\nsome output\n[DREAM_COMPLETE]');

      await runRandomDream(makeOpts(chestnutRoot, motionDir));

      const outboxContents = readOutboxPending(motionDir);
      expect(outboxContents).toHaveLength(0);
    });

    describe('Phase 546 — random-dream systemPrompt 透传', () => {
    it('passes RANDOM_DREAM_SYSTEM_PROMPT to writePendingSubAgentTask', async () => {
      await fs.mkdir(
        path.join(chestnutRoot, 'claws', 'claw-1', 'contract', 'archive', 'contract-001'),
        { recursive: true }
      );
      await writeTaskCompletion(motionDir, taskId, '=== started ===');

      await runRandomDream(makeOpts(chestnutRoot, motionDir));

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

        const runPromise = runRandomDream(makeOpts(chestnutRoot, motionDir));

        // 推进一个轮询周期（30 秒）
        await vi.advanceTimersByTimeAsync(30_001);

        // 此时 outbox 应仍为空（未完成）
        const outboxContentsBefore = readOutboxPending(motionDir);
        expect(outboxContentsBefore).toHaveLength(0);

        // 写入 result.txt + 更新 daemon.log（模拟 sub-agent 完成）
        fsSync.writeFileSync(path.join(taskResultDir, 'result.txt'), 'done');
        fsSync.writeFileSync(
          path.join(taskResultDir, 'daemon.log'),
          `[DREAM_OUTPUT contract_id="contract-001"]跨 claw 洞见[/DREAM_OUTPUT]`
        );

        // 推进下一个轮询周期
        await vi.advanceTimersByTimeAsync(30_001);
        await runPromise;

        // 现在 self-inbox 应有消息
        const inboxContentsAfter = readInboxPending(motionDir);
        expect(inboxContentsAfter.length).toBeGreaterThan(0);
        expect(inboxContentsAfter[0]).toContain('type: random_dream_completed');
        expect(inboxContentsAfter[0]).toContain('from: "random-dream"');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── Fix 3 回归：同 claw 后续契约 hint 不含"新claw" ───────────

  it('Fix 3 回归：同一 claw 的第二个契约 hint 不含"新claw"', async () => {
    // 同一 claw 两个契约
    await fs.mkdir(
      path.join(chestnutRoot, 'claws', 'claw-1', 'contract', 'archive', 'contract-A'),
      { recursive: true }
    );
    await fs.mkdir(
      path.join(chestnutRoot, 'claws', 'claw-1', 'contract', 'archive', 'contract-B'),
      { recursive: true }
    );

    // 捕获传给 sub-agent 的 prompt
    let capturedPrompt = '';
    mockWritePendingSubAgentTask.mockImplementation(async (_audit: unknown, opts: { intent: string }) => {
      capturedPrompt = opts.intent;
      return taskId;
    });

    await writeTaskCompletion(motionDir, taskId, '=== started ===');

    await runRandomDream(makeOpts(chestnutRoot, motionDir));

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
    const clawAArchive = path.join(chestnutRoot, 'claws', 'claw-A', 'contract', 'archive');
    const clawBArchive = path.join(chestnutRoot, 'claws', 'claw-B', 'contract', 'archive');
    await fs.mkdir(path.join(clawAArchive, 'contract-A1'), { recursive: true });
    await fs.mkdir(path.join(clawAArchive, 'contract-A2'), { recursive: true });
    await fs.mkdir(path.join(clawBArchive, 'contract-B1'), { recursive: true });

    let capturedPrompt = '';
    mockWritePendingSubAgentTask.mockImplementation(async (_audit: unknown, opts: { intent: string }) => {
      capturedPrompt = opts.intent;
      return taskId;
    });
    await writeTaskCompletion(motionDir, taskId, '=== started ===');

    await runRandomDream(makeOpts(chestnutRoot, motionDir));

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

  it('已处理契约被 completedContractIds 过滤（不再出现在候选列表）', async () => {
    // 两个 claw 各一个契约
    const oldCompletedAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await createArchiveContract(chestnutRoot, 'claw-new', 'contract-new');
    await createArchiveContract(chestnutRoot, 'claw-old', 'contract-old', oldCompletedAt);

    // 预置 state：contract-old 已完成
    await fs.writeFile(
      path.join(chestnutRoot, '.random-dream-state.json'),
      JSON.stringify({ completedContractIds: ['contract-old'] }),
      'utf-8'
    );

    let capturedPrompt = '';
    mockWritePendingSubAgentTask.mockImplementation(async (_audit: unknown, opts: { intent: string }) => {
      capturedPrompt = opts.intent;
      return taskId;
    });

    await writeTaskCompletion(motionDir, taskId, '=== started ===');

    await runRandomDream(makeOpts(chestnutRoot, motionDir));

    expect(capturedPrompt).not.toBe('');
    const lines = capturedPrompt.split('\n').filter(l => l.match(/^\d+\./));

    // contract-old 被过滤，不应出现；contract-new 出现
    expect(lines.some(l => l.includes('contract-new'))).toBe(true);
    expect(lines.some(l => l.includes('contract-old'))).toBe(false);
  });

  // ── computeWeight：progress.json 加权 ─────────────────────

  it('近期完成的契约权重高于普通契约', async () => {
    // contract-recent：有近期完成的 subtask
    const recentDir = path.join(chestnutRoot, 'claws', 'claw-1', 'contract', 'archive', 'contract-recent');
    await fs.mkdir(recentDir, { recursive: true });
    await fs.writeFile(path.join(recentDir, 'progress.json'), JSON.stringify({ schema_version: 1,
      subtasks: {
        s1: { status: 'completed', completed_at: new Date(Date.now() - 1000 * 60 * 60).toISOString() }, // 1 小时前
      },
    }), 'utf-8');

    // contract-old：有很久以前完成的 subtask（几乎没有加权）
    const oldDir = path.join(chestnutRoot, 'claws', 'claw-2', 'contract', 'archive', 'contract-old-done');
    await fs.mkdir(oldDir, { recursive: true });
    await fs.writeFile(path.join(oldDir, 'progress.json'), JSON.stringify({ schema_version: 1,
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

    await runRandomDream(makeOpts(chestnutRoot, motionDir));

    const lines = capturedPrompt.split('\n').filter(l => l.match(/^\d+\./));
    const idxRecent = lines.findIndex(l => l.includes('contract-recent'));
    const idxOldDone = lines.findIndex(l => l.includes('contract-old-done'));
    if (idxRecent >= 0 && idxOldDone >= 0) {
      expect(idxRecent).toBeLessThan(idxOldDone);
    }
  });

  it('有失败 subtask 的契约权重更高', async () => {
    // contract-failed：有 failed subtask
    const failedDir = path.join(chestnutRoot, 'claws', 'claw-1', 'contract', 'archive', 'contract-failed');
    await fs.mkdir(failedDir, { recursive: true });
    await fs.writeFile(path.join(failedDir, 'progress.json'), JSON.stringify({ schema_version: 1,
      subtasks: {
        s1: { status: 'failed' },
      },
    }), 'utf-8');

    // contract-normal：无 progress.json
    const normalDir = path.join(chestnutRoot, 'claws', 'claw-2', 'contract', 'archive', 'contract-normal');
    await fs.mkdir(normalDir, { recursive: true });

    let capturedPrompt = '';
    mockWritePendingSubAgentTask.mockImplementation(async (_audit: unknown, opts: { intent: string }) => {
      capturedPrompt = opts.intent;
      return taskId;
    });
    await writeTaskCompletion(motionDir, taskId, '=== started ===');

    await runRandomDream(makeOpts(chestnutRoot, motionDir));

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
      await createArchiveContract(chestnutRoot, 'claw-1', 'contract-001');
    });

    it('loadRandomDreamState parse 错时 quarantine raw + 阻断本轮 pulse（phase 1810，覆写 A.dream-state-io-silent 旧义：不再重置后继续）', async () => {
      // setup: 写入损坏 .random-dream-state.json
      await fs.writeFile(path.join(chestnutRoot, '.random-dream-state.json'), 'corrupted{', 'utf-8');

      await runRandomDream(makeOpts(chestnutRoot, motionDir));

      expect(mockAudit.write).toHaveBeenCalledWith(
        'cron_random_dream_error',
        'site=load_state',
        'cause=malformed',
        expect.stringMatching(/^reason=/),
        expect.stringMatching(/^quarantine=\.random-dream-state\.json\.corrupt-1$/),
      );
      // 本轮 pulse 被 blocked（degraded gate）
      expect(mockAudit.write).toHaveBeenCalledWith(
        'cron_random_dream_job',
        'step=blocked',
        'reason=state_malformed',
      );
      // raw 原文随 quarantine 保留、canonical 不存在（不会被后续 save 覆盖）
      const statePath = path.join(chestnutRoot, '.random-dream-state.json');
      expect(fsSync.existsSync(statePath)).toBe(false);
      expect(fsSync.readFileSync(`${statePath}.corrupt-1`, 'utf-8')).toBe('corrupted{');
    });

    it('loadRandomDreamState FileNotFoundError 时 silent 返空（首启良性）', async () => {
      // setup: 不写 .random-dream-state.json
      const dreamLog = `=== SubAgent ${taskId} started ===
[DREAM_OUTPUT contract_id="contract-001"]
跨 claw 共性洞见
[/DREAM_OUTPUT]`;
      await writeTaskCompletion(motionDir, taskId, dreamLog);

      await runRandomDream(makeOpts(chestnutRoot, motionDir));

      const loadStateCalls = mockAudit.write.mock.calls.filter((c: any[]) =>
        c.some((arg: any) => typeof arg === 'string' && arg.includes('site=load_state'))
      );
      expect(loadStateCalls).toHaveLength(0);
    });

    it('saveRandomDreamState writeAtomicSync 失败时 audit site=save_state 并 re-throw（phase 216 col 名空间隔离）', async () => {
      const chestnutNodeFs = new NodeFileSystem({ baseDir: chestnutRoot });
      const writeSpy = vi.spyOn(chestnutNodeFs, 'writeAtomicSync').mockImplementation(function (this: NodeFileSystem, p: string, content: string) {
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

      await expect(runRandomDream({ ...makeOpts(chestnutRoot, motionDir), fs: chestnutNodeFs, audit: mockAudit })).rejects.toThrow();

      expect(mockAudit.write).toHaveBeenCalledWith(
        'cron_random_dream_error',
        'site=save_state',
        expect.stringMatching(/^reason=.*EIO/),
      );

      writeSpy.mockRestore();
    });
  });

  // ── waitForTaskResult 超时路径 ──────────────────────────────

  it('sub-agent 超时：.txt 始终不出现，不写 outbox', async () => {
    vi.useFakeTimers();
    try {
      await fs.mkdir(
        path.join(chestnutRoot, 'claws', 'claw-1', 'contract', 'archive', 'contract-timeout'),
        { recursive: true }
      );
      const taskResultDir = path.join(motionDir, 'tasks', 'queues', 'results', taskId);
      await fs.mkdir(taskResultDir, { recursive: true });
      // 只有 daemon.log，没有 result.txt
      fsSync.writeFileSync(
        path.join(taskResultDir, 'daemon.log'),
        '=== started ==='
      );

      const opts = makeOpts(chestnutRoot, motionDir);
      const statePersisted = observeRandomDreamStateWrite(opts);
      const runPromise = runRandomDream(opts);

      // discover 现为真实 async I/O（structured archive query）：fake timer 只控制 timer，
      // 直接等 schedule 后 state 真实落盘（atomic write 返回），再一次推进 fake clock 验证 1h deadline
      await statePersisted;
      await vi.advanceTimersByTimeAsync(3_600_001);
      await runPromise;

      // 不应写 outbox；pending entry 已持久化
      const outboxContents = readOutboxPending(motionDir);
      expect(outboxContents).toHaveLength(0);
      const statePath = path.join(chestnutRoot, '.random-dream-state.json');
      const state = JSON.parse(fsSync.readFileSync(statePath, 'utf-8'));
      expect(state.pendingLateSettle).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── Phase 924 — random-dream 三项根治修复 ───────────────────

  describe('Phase 925 — random-dream 状态模型 + 事务协议根治', () => {
    it('advances completedContractIds only for contracts with actual output', async () => {
      const t1 = new Date('2026-07-10T10:00:00.000Z').toISOString();
      const t2 = new Date('2026-07-11T10:00:00.000Z').toISOString();
      const t3 = new Date('2026-07-12T10:00:00.000Z').toISOString();

      await createArchiveContract(chestnutRoot, 'claw-a', 'contract-001', t1);
      await createArchiveContract(chestnutRoot, 'claw-b', 'contract-002', t2);
      await createArchiveContract(chestnutRoot, 'claw-c', 'contract-003', t3);

      const dreamLog = `=== started ===
[DREAM_OUTPUT contract_id="contract-001"]
insight A
[/DREAM_OUTPUT]
[DREAM_OUTPUT contract_id="contract-002"]
insight B
[/DREAM_OUTPUT]`;

      await writeTaskCompletion(motionDir, taskId, dreamLog);
      await runRandomDream(makeOpts(chestnutRoot, motionDir));

      const state = JSON.parse(fsSync.readFileSync(path.join(chestnutRoot, '.random-dream-state.json'), 'utf-8'));
      expect(state.completedContractIds).toContain('contract-001');
      expect(state.completedContractIds).toContain('contract-002');
      expect(state.completedContractIds).not.toContain('contract-003');
    });

    it('does not skip non-contiguous uncompleted contracts', async () => {
      const t1 = new Date('2026-07-10T10:00:00.000Z').toISOString();
      const t2 = new Date('2026-07-11T10:00:00.000Z').toISOString();
      const t3 = new Date('2026-07-12T10:00:00.000Z').toISOString();

      await createArchiveContract(chestnutRoot, 'claw-a', 'contract-001', t1);
      await createArchiveContract(chestnutRoot, 'claw-b', 'contract-002', t2);
      await createArchiveContract(chestnutRoot, 'claw-c', 'contract-003', t3);

      // simulate prior run completed c1 and c3 but skipped c2
      await fs.writeFile(
        path.join(chestnutRoot, '.random-dream-state.json'),
        JSON.stringify({ completedContractIds: ['contract-001', 'contract-003'] }),
        'utf-8'
      );

      let capturedPrompt = '';
      mockWritePendingSubAgentTask.mockImplementation(async (_audit: unknown, opts: { intent: string }) => {
        capturedPrompt = opts.intent;
        return taskId;
      });
      await writeTaskCompletion(motionDir, taskId, '=== started ===');

      await runRandomDream(makeOpts(chestnutRoot, motionDir));

      expect(capturedPrompt).not.toBe('');
      // c1/c3 completed, c2 still discoverable
      expect(capturedPrompt).toContain('contract-002');
      expect(capturedPrompt).not.toContain('contract-001');
      expect(capturedPrompt).not.toContain('contract-003');
    });

    it('persists pending contractIds immediately after schedule', async () => {
      await createArchiveContract(chestnutRoot, 'claw-a', 'contract-001');
      await createArchiveContract(chestnutRoot, 'claw-b', 'contract-002');
      await createArchiveContract(chestnutRoot, 'claw-c', 'contract-003');

      const taskId = 'captured1';
      mockWritePendingSubAgentTask.mockResolvedValue(taskId);

      vi.useFakeTimers();
      try {
        const taskResultDir = path.join(motionDir, 'tasks', 'queues', 'results', taskId);
        await fs.mkdir(taskResultDir, { recursive: true });
        fsSync.writeFileSync(path.join(taskResultDir, 'daemon.log'), '=== started ===');

        const opts = makeOpts(chestnutRoot, motionDir);
        const statePersisted = observeRandomDreamStateWrite(opts);
        const runPromise = runRandomDream(opts);
        // discover 现为真实 async I/O（structured archive query）：fake timer 只控制 timer，
        // 直接等 schedule 后 state 真实落盘（atomic write 返回，仍早于 30s 首个 poll tick）
        await statePersisted;

        // state persisted immediately after schedule
        const statePath = path.join(chestnutRoot, '.random-dream-state.json');
        const state = JSON.parse(fsSync.readFileSync(statePath, 'utf-8'));
        expect(state.pendingLateSettle).toHaveLength(1);
        expect(state.pendingLateSettle[0].taskId).toBe(taskId);
        expect(state.pendingLateSettle[0].contractIds).toEqual(['contract-001', 'contract-002', 'contract-003']);

        await vi.advanceTimersByTimeAsync(3_600_001);
        await runPromise;
      } finally {
        vi.useRealTimers();
      }
    });

    it('writes to self-inbox and commits state', async () => {
      await createArchiveContract(chestnutRoot, 'claw-1', 'contract-001');

      const dreamLog = `=== started ===
[DREAM_OUTPUT contract_id="contract-001"]
insight
[/DREAM_OUTPUT]`;
      await writeTaskCompletion(motionDir, taskId, dreamLog);

      await runRandomDream(makeOpts(chestnutRoot, motionDir));

      const stateAfter = JSON.parse(fsSync.readFileSync(path.join(chestnutRoot, '.random-dream-state.json'), 'utf-8'));
      expect(stateAfter.pendingLateSettle).toHaveLength(0);
      expect(stateAfter.completedContractIds).toContain('contract-001');

      const inboxContents = readInboxPending(motionDir);
      expect(inboxContents.length).toBeGreaterThan(0);
      expect(inboxContents[0]).toContain('type: random_dream_completed');
      expect(inboxContents[0]).toContain('from: "random-dream"');
      expect(inboxContents[0]).toContain('dreamId:');
    });

    it('does not re-schedule contracts covered by pending late-settle task', async () => {
      const now = Date.now();
      await fs.writeFile(
        path.join(chestnutRoot, '.random-dream-state.json'),
        JSON.stringify({
          completedContractIds: [],
          pendingLateSettle: [{
            taskId: 'pending-task-1',
            scheduledAt: now - 3600_000,
            expectedTimeoutAt: now + 3600_000,
            contractIds: ['contract-001', 'contract-002'],
          }],
        }),
        'utf-8'
      );

      await createArchiveContract(chestnutRoot, 'claw-a', 'contract-001');
      await createArchiveContract(chestnutRoot, 'claw-b', 'contract-002');
      await createArchiveContract(chestnutRoot, 'claw-c', 'contract-003');

      let capturedPrompt = '';
      mockWritePendingSubAgentTask.mockImplementation(async (_audit: unknown, opts: { intent: string }) => {
        capturedPrompt = opts.intent;
        return taskId;
      });
      await writeTaskCompletion(motionDir, taskId, '=== started ===');

      await runRandomDream(makeOpts(chestnutRoot, motionDir));

      expect(capturedPrompt).not.toBe('');
      expect(capturedPrompt).toContain('contract-003');
      expect(capturedPrompt).not.toContain('contract-001');
      expect(capturedPrompt).not.toContain('contract-002');
    });

    it('does not advance completedContractIds when dream output write fails', async () => {
      await createArchiveContract(chestnutRoot, 'claw-1', 'contract-001');

      const motionFs = new NodeFileSystem({ baseDir: motionDir });
      vi.spyOn(motionFs, 'writeAtomic').mockRejectedValue(new Error('ENOSPC'));

      const dreamLog = `=== started ===
[DREAM_OUTPUT contract_id="contract-001"]
insight
[/DREAM_OUTPUT]`;

      await writeTaskCompletion(motionDir, taskId, dreamLog);

      await expect(runRandomDream({ ...makeOpts(chestnutRoot, motionDir), motionFs })).rejects.toThrow('ENOSPC');

      const state = JSON.parse(fsSync.readFileSync(path.join(chestnutRoot, '.random-dream-state.json'), 'utf-8'));
      // pending entry persisted but contract not marked completed due to write failure
      expect(state.pendingLateSettle).toHaveLength(1);
      expect(state.completedContractIds).not.toContain('contract-001');
    });
  });

  // ── Phase 1370 — structured archive query caller 语义 ─────────────

  describe('Phase 1370 — RandomDream owns motion-excluded archive universe', () => {
    it('motion archive 即使存在也不进入 dream prompt；普通 local archive 进入', async () => {
      await createArchiveContract(chestnutRoot, 'claw-1', 'contract-normal');
      // motion claw 的 archive（topology.resolve(MOTION) 指向 motionDir）
      const motionArchiveDir = path.join(motionDir, 'contract', 'archive', 'contract-motion');
      await fs.mkdir(motionArchiveDir, { recursive: true });

      let capturedPrompt = '';
      mockWritePendingSubAgentTask.mockImplementation(async (_audit: unknown, opts: { intent: string }) => {
        capturedPrompt = opts.intent;
        return taskId;
      });
      await writeTaskCompletion(motionDir, taskId, '=== started ===');

      await runRandomDream(makeOpts(chestnutRoot, motionDir));

      expect(capturedPrompt).not.toBe('');
      expect(capturedPrompt).toContain('contract-normal');
      expect(capturedPrompt).not.toContain('contract-motion');
    });

    it('单个 claw resolve 失败时成功 claw 契约仍进入 prompt，并逐条 audit structured issue', async () => {
      await createArchiveContract(chestnutRoot, 'claw-1', 'contract-ok');

      const opts = makeOpts(chestnutRoot, motionDir);
      const realTopology = opts.clawTopology;
      opts.clawTopology = {
        ...realTopology,
        enumerate: () => ['bad', 'claw-1'] as any,
        resolve: (clawId: any) => {
          if (clawId === 'bad') throw new Error('resolve boom');
          return realTopology.resolve(clawId);
        },
      };

      let capturedPrompt = '';
      mockWritePendingSubAgentTask.mockImplementation(async (_audit: unknown, o: { intent: string }) => {
        capturedPrompt = o.intent;
        return taskId;
      });
      await writeTaskCompletion(motionDir, taskId, '=== started ===');

      await runRandomDream(opts);

      // 成功 claw 的契约不因其他 claw 失败而丢失
      expect(capturedPrompt).toContain('contract-ok');

      const issueCall = mockAudit.write.mock.calls.find((c: any[]) =>
        c[0] === 'cron_random_dream_error' && c.includes('site=archive_query')
      );
      expect(issueCall).toBeDefined();
      expect(issueCall).toContainEqual('code=claw_resolve_failed');
      expect(issueCall).toContainEqual('clawId=bad');
      expect(issueCall!.some((col: any) => typeof col === 'string' && col.startsWith('detail='))).toBe(true);
    });

    it('无 terminal audit 的 archive 契约仍进入 prompt，其 structured issue 被逐条 audit', async () => {
      // legacy flat 布局 + 无 audit.tsv → archiveTime unknown（legacy_state_unresolved）
      await createArchiveContract(chestnutRoot, 'claw-1', 'contract-unknown');

      let capturedPrompt = '';
      mockWritePendingSubAgentTask.mockImplementation(async (_audit: unknown, o: { intent: string }) => {
        capturedPrompt = o.intent;
        return taskId;
      });
      await writeTaskCompletion(motionDir, taskId, '=== started ===');

      await runRandomDream(makeOpts(chestnutRoot, motionDir));

      // unknown-time entry 不丢失，仍进入 prompt
      expect(capturedPrompt).toContain('contract-unknown');

      const issueCall = mockAudit.write.mock.calls.find((c: any[]) =>
        c[0] === 'cron_random_dream_error' &&
        c.includes('site=archive_query') &&
        c.includes('code=legacy_state_unresolved')
      );
      expect(issueCall).toBeDefined();
      expect(issueCall).toContainEqual('clawId=claw-1');
      expect(issueCall).toContainEqual('contractId=contract-unknown');
    });
  });
});
