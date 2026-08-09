/**
 * Phase 1159 Step D — Random Dream durable completion delivery state machine
 *
 * 覆盖：
 * - output → stage+save → flush 发送 → outbox confirm
 * - pending/inflight/done 三态 dedup（稳定 delivery_id）
 * - failed 状态不重投、允许重投
 * - query error（EACCES）不发送
 * - stage save 失败不发送
 * - notify 成功但 clear save 崩溃后恢复：命中 done 只清 outbox
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fsSync from 'fs';
import { promises as fs } from 'fs';
import { runRandomDream, type RandomDreamOptions } from '../../../src/core/memory/random-dream.js';
import { MEMORY_AUDIT_EVENTS } from '../../../src/core/memory/audit-events.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createClawTopology, MOTION_CLAW_ID } from '../../../src/core/claw-topology/index.js';
import type { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';

const mockWritePendingSubAgentTask = vi.fn();

function makeMockTaskSystem(): AsyncTaskSystem {
  return {
    schedule: mockWritePendingSubAgentTask,
    shutdown: vi.fn().mockResolvedValue(true),
  } as unknown as AsyncTaskSystem;
}

const mockAudit = {
  write: vi.fn(),
  preview: vi.fn((s: string) => s),
  message: vi.fn((s: string) => s),
  summary: vi.fn((s: string) => s),
};

function makeOpts(chestnutRoot: string, motionDir: string, notifyMotion?: RandomDreamOptions['notifyMotion']): RandomDreamOptions {
  const fileSystem = new NodeFileSystem({ baseDir: chestnutRoot });
  return {
    clawTopology: createClawTopology({ fs: fileSystem, chestnutRoot, motionDir }),
    motionDir: motionDir as any,
    taskSystem: makeMockTaskSystem(),
    fs: fileSystem,
    motionFs: new NodeFileSystem({ baseDir: motionDir }),
    audit: mockAudit as any,
    notifyMotion: notifyMotion ?? vi.fn().mockResolvedValue(undefined),
  };
}

function readInboxPending(motionDir: string): string[] {
  const inboxDir = path.join(motionDir, 'inbox', 'pending');
  if (!fsSync.existsSync(inboxDir)) return [];
  return fsSync.readdirSync(inboxDir)
    .filter(f => f.endsWith('.md'))
    .map(f => fsSync.readFileSync(path.join(inboxDir, f), 'utf8'));
}

async function writeTaskCompletion(motionDir: string, taskId: string, logContent: string) {
  const taskResultDir = path.join(motionDir, 'tasks', 'queues', 'results', taskId);
  await fs.mkdir(taskResultDir, { recursive: true });
  await fs.writeFile(path.join(taskResultDir, 'result.txt'), 'done', 'utf-8');
  await fs.writeFile(path.join(taskResultDir, 'daemon.log'), logContent, 'utf-8');
}

async function createArchiveContract(chestnutRoot: string, clawId: string, contractId: string) {
  const dir = path.join(chestnutRoot, 'claws', clawId, 'contract', 'archive', contractId);
  await fs.mkdir(dir, { recursive: true });
}

let lastTaskSystem: AsyncTaskSystem | undefined;

describe('random-dream durable delivery (phase 1159 Step D)', () => {
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
    await lastTaskSystem?.shutdown(200);
    lastTaskSystem = undefined;
    await Promise.all([cleanupTempDir(chestnutRoot), cleanupTempDir(motionDir)]);
    vi.clearAllMocks();
  });

  it('direct completion: output → state/outbox → send → confirm', async () => {
    await createArchiveContract(chestnutRoot, 'claw-1', 'contract-001');
    const taskId = 'direct-1';
    mockWritePendingSubAgentTask.mockResolvedValue(taskId);
    const notifyMotion = vi.fn().mockResolvedValue(undefined);

    await writeTaskCompletion(motionDir, taskId, `[DREAM_OUTPUT contract_id="contract-001"]insight[/DREAM_OUTPUT]`);
    await runRandomDream({ ...makeOpts(chestnutRoot, motionDir, notifyMotion), subagentTimeoutMs: 1000, pulseIntervalMs: 10 });

    // notification sent
    expect(notifyMotion).toHaveBeenCalledTimes(1);
    const msg = notifyMotion.mock.calls[0][0];
    expect(msg.type).toBe('random_dream_completed');
    expect(msg.extraFields.delivery_id).toBe(`random-dream:${taskId}`);

    // state cleared outbox
    const state = JSON.parse(fsSync.readFileSync(path.join(chestnutRoot, '.random-dream-state.json'), 'utf-8'));
    expect(state.pendingNotifications).toEqual([]);
    expect(state.pendingLateSettle).toEqual([]);
    expect(state.completedContractIds).toContain('contract-001');
  });

  it('stage save fails: no send', async () => {
    await createArchiveContract(chestnutRoot, 'claw-1', 'contract-001');
    const taskId = 'save-fail-1';
    mockWritePendingSubAgentTask.mockResolvedValue(taskId);
    const notifyMotion = vi.fn().mockResolvedValue(undefined);
    const fileSystem = new NodeFileSystem({ baseDir: chestnutRoot });
    vi.spyOn(fileSystem, 'writeAtomicSync').mockImplementation(function (this: NodeFileSystem, p: string, content: string) {
      if (p === '.random-dream-state.json') {
        throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
      }
      return NodeFileSystem.prototype.writeAtomicSync.call(this as any, p, content);
    });

    await writeTaskCompletion(motionDir, taskId, `[DREAM_OUTPUT contract_id="contract-001"]insight[/DREAM_OUTPUT]`);
    await expect(runRandomDream({ ...makeOpts(chestnutRoot, motionDir, notifyMotion), fs: fileSystem, subagentTimeoutMs: 1000, pulseIntervalMs: 10 })).rejects.toThrow('EIO');

    expect(notifyMotion).not.toHaveBeenCalled();
  });

  it('message exists but outbox clear previously crashed: recovery finds key, no duplicate', async () => {
    await createArchiveContract(chestnutRoot, 'claw-1', 'contract-001');
    const taskId = 'recovery-1';
    mockWritePendingSubAgentTask.mockResolvedValue(taskId);

    // seed state with pending notification + pre-existing done inbox message
    await fs.writeFile(
      path.join(chestnutRoot, '.random-dream-state.json'),
      JSON.stringify({
        completedContractIds: [],
        pendingNotifications: [{
          deliveryId: `random-dream:${taskId}`,
          taskId,
          outputPath: 'memory/dream-outputs/recovery-1.txt',
          outputCount: 1,
          completedContractIds: ['contract-001'],
          createdAt: Date.now(),
        }],
      }),
      'utf-8'
    );

    // create a done message with matching delivery_id
    await fs.mkdir(path.join(motionDir, 'inbox', 'done'), { recursive: true });
    await fs.writeFile(
      path.join(motionDir, 'inbox', 'done', `random-dream-${Date.now()}_normal_000000_a1b2c3.md`),
      `---\nid: rd-1\ntype: random_dream_completed\nfrom: random-dream\nto: \"\"\npriority: normal\ntimestamp: ${new Date().toISOString()}\ndelivery_id: random-dream:${taskId}\n---\nbody`,
      'utf-8'
    );

    const notifyMotion = vi.fn().mockResolvedValue(undefined);
    await runRandomDream({ ...makeOpts(chestnutRoot, motionDir, notifyMotion), subagentTimeoutMs: 1000, pulseIntervalMs: 10 });

    expect(notifyMotion).toHaveBeenCalledTimes(0);
    const state = JSON.parse(fsSync.readFileSync(path.join(chestnutRoot, '.random-dream-state.json'), 'utf-8'));
    expect(state.pendingNotifications).toEqual([]);
  });

  it('query EACCES: absence unproven', async () => {
    await createArchiveContract(chestnutRoot, 'claw-1', 'contract-001');
    const taskId = 'query-error-1';
    mockWritePendingSubAgentTask.mockResolvedValue(taskId);

    // seed pending notification
    await fs.writeFile(
      path.join(chestnutRoot, '.random-dream-state.json'),
      JSON.stringify({
        completedContractIds: [],
        pendingNotifications: [{
          deliveryId: `random-dream:${taskId}`,
          taskId,
          outputPath: 'memory/dream-outputs/query-error-1.txt',
          outputCount: 1,
          completedContractIds: ['contract-001'],
          createdAt: Date.now(),
        }],
      }),
      'utf-8'
    );

    const motionFileSystem = new NodeFileSystem({ baseDir: motionDir });
    vi.spyOn(motionFileSystem, 'list').mockRejectedValue(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));
    const notifyMotion = vi.fn().mockResolvedValue(undefined);

    await expect(runRandomDream({ ...makeOpts(chestnutRoot, motionDir, notifyMotion), motionFs: motionFileSystem, subagentTimeoutMs: 1000, pulseIntervalMs: 10 })).rejects.toThrow('EACCES');
    expect(notifyMotion).not.toHaveBeenCalled();
  });

  it('failed inbox allows resend', async () => {
    await createArchiveContract(chestnutRoot, 'claw-1', 'contract-001');
    const taskId = 'failed-resend-1';
    mockWritePendingSubAgentTask.mockResolvedValue(taskId);

    // seed pending notification + failed inbox message (failed/ must not dedup)
    await fs.writeFile(
      path.join(chestnutRoot, '.random-dream-state.json'),
      JSON.stringify({
        completedContractIds: [],
        pendingNotifications: [{
          deliveryId: `random-dream:${taskId}`,
          taskId,
          outputPath: 'memory/dream-outputs/failed-resend-1.txt',
          outputCount: 1,
          completedContractIds: ['contract-001'],
          createdAt: Date.now(),
        }],
      }),
      'utf-8'
    );

    await fs.mkdir(path.join(motionDir, 'inbox', 'failed'), { recursive: true });
    await fs.writeFile(
      path.join(motionDir, 'inbox', 'failed', `random-dream-${Date.now()}_normal_000000_a1b2c3.md`),
      `---\nid: rd-1\ntype: random_dream_completed\nfrom: random-dream\nto: \"\"\npriority: normal\ntimestamp: ${new Date().toISOString()}\ndelivery_id: random-dream:${taskId}\n---\nbody`,
      'utf-8'
    );

    const notifyMotion = vi.fn().mockResolvedValue(undefined);
    await runRandomDream({ ...makeOpts(chestnutRoot, motionDir, notifyMotion), subagentTimeoutMs: 1000, pulseIntervalMs: 10 });

    expect(notifyMotion).toHaveBeenCalledTimes(1);
    const state = JSON.parse(fsSync.readFileSync(path.join(chestnutRoot, '.random-dream-state.json'), 'utf-8'));
    expect(state.pendingNotifications).toEqual([]);
  });

  it('same task direct and late-settle use same delivery id', async () => {
    const taskId = 'same-id-1';
    const now = Date.now();
    await fs.writeFile(
      path.join(chestnutRoot, '.random-dream-state.json'),
      JSON.stringify({
        completedContractIds: [],
        pendingLateSettle: [{
          taskId,
          scheduledAt: now - 3600_000,
          expectedTimeoutAt: now - 60_000,
          contractIds: [],
        }],
      }),
      'utf-8'
    );
    await createArchiveContract(chestnutRoot, 'claw-1', 'contract-001');
    mockWritePendingSubAgentTask.mockResolvedValue(taskId);

    const notifyMotion = vi.fn().mockResolvedValue(undefined);
    await writeTaskCompletion(motionDir, taskId, `[DREAM_OUTPUT contract_id="contract-001"]insight[/DREAM_OUTPUT]`);

    // late-settle sweep sends with delivery_id based on taskId
    await runRandomDream({ ...makeOpts(chestnutRoot, motionDir, notifyMotion), subagentTimeoutMs: 1000, pulseIntervalMs: 10 });
    const lateSettleDeliveryId = notifyMotion.mock.calls[0][0].extraFields.delivery_id;

    // reset and run direct completion with same taskId
    notifyMotion.mockClear();
    await fs.writeFile(
      path.join(chestnutRoot, '.random-dream-state.json'),
      JSON.stringify({ completedContractIds: [] }),
      'utf-8'
    );
    await runRandomDream({ ...makeOpts(chestnutRoot, motionDir, notifyMotion), subagentTimeoutMs: 1000, pulseIntervalMs: 10 });
    const directDeliveryId = notifyMotion.mock.calls[0][0].extraFields.delivery_id;

    expect(directDeliveryId).toBe(lateSettleDeliveryId);
    expect(directDeliveryId).toBe(`random-dream:${taskId}`);
  });
});
