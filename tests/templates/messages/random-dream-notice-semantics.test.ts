/**
 * phase 1835 (M09 语义治理)：random_dream_completed 保存通知新语义的真实生产链组合验收。
 *
 * 接管 tests/templates/messages/inbox-text-equivalence.test.ts 移交的 M09/completion
 * case（golden 历史数据保留、不逐字节比较）。本文件只模拟任务执行产出
 * （taskSystem.schedule + 预置 result/daemon.log），不模拟 extract/模板/消息
 * codec/formatter：真实 runRandomDream → 真实 routeNotifyClawAsync 落 motion inbox →
 * 真实 InboxReader 读回 → 正式 MEMORY_INBOX_MESSAGE_TYPES 注册的标准 system 呈现 →
 * 正式 registerAllMotionGuidance（random_dream_completed = NO_GUIDANCE）→
 * Runtime.formatInboxMessage 最终文本。
 *
 * 覆盖（Step B §6 覆盖矩阵）：
 *  1. 正常完成：同一 contract_id 两块输出 → 通知 2 个输出块（不称 2 contracts）；
 *     notify 回调中核产物文件已存在且内容准确（保存先于通知）；最终 Runtime 文本
 *     自含任务/块数/相对 motion 根路径/按需读取用途
 *  2. 两契约、多块含空白块：原计数保持，不称有效洞见；零匹配块不发完成通知
 *  3. 迟到结果：taskId ≠ fullTaskId 时正文显示原 taskId，位置用真实持久路径，
 *     不拼短 ID 文件名；真实 sweep 产生与正常完成同一语义
 *  4. 通知失败 → 重建运行状态 → 重投：taskId/count/path 不丢、delivery_id 稳定、
 *     最终正文相同；旧 pending 记录（无 lateSettleFullTaskId）仍可恢复并走真实链呈现
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as fsSync from 'fs';
import { promises as fs } from 'fs';
import { runRandomDream, type RandomDreamOptions } from '../../../src/core/memory/random-dream.js';
import { MEMORY_AUDIT_EVENTS } from '../../../src/core/memory/audit-events.js';
import { MEMORY_INBOX_MESSAGE_TYPES } from '../../../src/core/memory/inbox-formatter.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createClawTopology, makeClawNotifyTargetResolver, MOTION_CLAW_ID } from '../../../src/core/claw-topology/index.js';
import {
  InboxReader,
  INBOX_INFLIGHT_DIR,
  createClawNotifier,
  createInboxMessageTypeRegistry,
  registerInboxMessageTypes,
} from '../../../src/foundation/messaging/index.js';
import type { InboxMessage } from '../../../src/foundation/messaging/index.js';
import type { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { Runtime } from '../../../src/core/runtime/runtime.js';
import { createMotionGuidanceRegistry, registerAllMotionGuidance } from '../../../src/assembly/guidance/index.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';

// ─── 工具 ────────────────────────────────────────────────────

const mockSchedule = vi.fn();

function makeMockTaskSystem(): AsyncTaskSystem {
  return {
    schedule: mockSchedule,
    shutdown: vi.fn().mockResolvedValue(true),
  } as unknown as AsyncTaskSystem;
}

function makeAudit() {
  const events: Array<[string, ...unknown[]]> = [];
  const audit = {
    write: (type: string, ...cols: unknown[]) => { events.push([type, ...cols]); },
    preview: (s: string) => s,
    message: (s: string) => s,
    summary: (s: string) => s,
  };
  return { audit, events };
}

/** phase 1835 新语义完整正文（与模板契约同一字面；expected 为 literal 拼接，不经模板生成）。 */
function expectedNoticeBody(taskId: string, outputCount: number, outputPath: string): string {
  return '跨 claw 经验探索输出已保存。\n'
    + `任务：${taskId}\n`
    + `产物：${outputCount} 个输出块\n`
    + `位置：motion 目录下的 ${outputPath}\n`
    + '\n'
    + '这些内容来自对已归档契约的探索，尚未自动整理为可检索的长期记忆。\n'
    + '需要参考这些经验时，可读取该文件，再判断哪些内容值得整理或采用。';
}

/** Runtime 最终呈现装配：正式 MEMORY_INBOX_MESSAGE_TYPES + 正式 registerAllMotionGuidance（NO_GUIDANCE）。 */
class TestRuntime extends Runtime {
  async testFormatInboxMessage(
    type: string,
    from: string,
    body: string,
    timestamp?: string,
    extraMeta?: Record<string, string>,
  ): Promise<string> {
    return this.formatInboxMessage(type, from, body, timestamp, extraMeta);
  }
}

function buildRuntime(audit: ReturnType<typeof makeAudit>['audit']): TestRuntime {
  const formatterRegistry = createInboxMessageTypeRegistry();
  registerInboxMessageTypes(formatterRegistry, MEMORY_INBOX_MESSAGE_TYPES);
  const guidanceRegistry = createMotionGuidanceRegistry();
  registerAllMotionGuidance(guidanceRegistry);
  return new TestRuntime({
    clawId: 'motion',
    clawDir: '/tmp/test-motion',
    clawsDir: '/tmp/claws',
    idleTimeoutMs: 0,
    llmConfig: {
      primary: { name: 'mock', apiKey: 'k', model: 'm', maxTokens: 1, temperature: 0, timeoutMs: 1, apiFormat: 'anthropic' as const },
      maxAttempts: 1,
      retryDelayMs: 0,
    },
    dependencies: {
      systemFs: {} as never,
      auditWriter: audit,
      snapshot: {} as never,
      sessionManager: {} as never,
      inboxReader: {} as never,
      llm: {} as never,
      toolRegistry: {
        register: vi.fn(),
        getForProfile: vi.fn().mockReturnValue([]),
        getAll: vi.fn().mockReturnValue([]),
        formatForLLM: vi.fn().mockReturnValue([]),
      } as never,
      toolExecutor: {} as never,
      contractManager: {} as never,
      taskSystem: {
        initialize: vi.fn().mockResolvedValue(undefined),
        startDispatch: vi.fn(),
        shutdown: vi.fn().mockResolvedValue({ kind: 'converged', aborted: 0, terminal: [] }),
      } as never,
      skillRegistry: {} as never,
      permissionChecker: {} as never,
      fsFactory: () => ({}) as never,
      contractNotifyCallback: undefined,
      dialogStoreFactory: vi.fn(),
      formatterRegistry,
      guidanceCompose: (input) => guidanceRegistry.compose(input),
    },
  });
}

// ─── 测试 ────────────────────────────────────────────────────

describe('phase 1835: random_dream_completed 保存通知新语义真实生产链', () => {
  let chestnutRoot: string;
  let motionDir: string;
  let fileSystem: NodeFileSystem;
  let audit: ReturnType<typeof makeAudit>['audit'];
  let events: ReturnType<typeof makeAudit>['events'];

  beforeEach(async () => {
    vi.restoreAllMocks();
    chestnutRoot = await createTempDir();
    motionDir = path.join(chestnutRoot, 'motion');
    await fs.mkdir(path.join(motionDir, 'inbox', 'pending'), { recursive: true });
    await fs.mkdir(path.join(motionDir, 'inbox', 'done'), { recursive: true });
    await fs.mkdir(path.join(motionDir, 'inbox', 'failed'), { recursive: true });
    await fs.mkdir(path.join(motionDir, INBOX_INFLIGHT_DIR), { recursive: true });
    fileSystem = new NodeFileSystem({ baseDir: chestnutRoot });
    ({ audit, events } = makeAudit());
    mockSchedule.mockReset();
  });

  afterEach(async () => {
    await Promise.all([cleanupTempDir(chestnutRoot), cleanupTempDir(motionDir)]);
    vi.clearAllMocks();
  });

  function makeOpts(notifyMotion: RandomDreamOptions['notifyMotion']): RandomDreamOptions {
    return {
      clawTopology: createClawTopology({ fs: fileSystem, chestnutRoot, motionDir }),
      motionDir: motionDir as never,
      taskSystem: makeMockTaskSystem(),
      fs: fileSystem,
      motionFs: new NodeFileSystem({ baseDir: motionDir }),
      audit: audit as never,
      notifyMotion,
      subagentTimeoutMs: 1000,
      pulseIntervalMs: 10,
    } as RandomDreamOptions;
  }

  /** 真实 routeNotifyClawAsync 落 motion inbox。 */
  const realNotify = (): RandomDreamOptions['notifyMotion'] =>
    (msg) =>
      createClawNotifier({
        fs: fileSystem,
        audit: audit as never,
        resolveTarget: makeClawNotifyTargetResolver(chestnutRoot),
      }).notifyAsync(MOTION_CLAW_ID, msg);

  async function writeTaskCompletion(taskId: string, logContent: string): Promise<void> {
    const resultDir = path.join(motionDir, 'tasks', 'queues', 'results', taskId);
    await fs.mkdir(resultDir, { recursive: true });
    await fs.writeFile(path.join(resultDir, 'result.txt'), 'done', 'utf-8');
    await fs.writeFile(path.join(resultDir, 'daemon.log'), logContent, 'utf-8');
  }

  async function createArchiveContract(clawId: string, contractId: string): Promise<void> {
    await fs.mkdir(path.join(chestnutRoot, 'claws', clawId, 'contract', 'archive', contractId), { recursive: true });
  }

  /** 真实 InboxReader 读回唯一 pending 通知（claim 到 inflight）。 */
  async function drainOnlyMessage(): Promise<InboxMessage> {
    const reader = new InboxReader(
      path.join(motionDir, 'inbox', 'pending'),
      path.join(motionDir, 'inbox', 'done'),
      path.join(motionDir, 'inbox', 'failed'),
      fileSystem,
      audit as never,
    );
    const result = await reader.drainAndDeliver();
    expect(result.kind).toBe('complete');
    if (result.kind !== 'complete') throw new Error('unreachable');
    expect(result.entries).toHaveLength(1);
    return result.entries[0].message;
  }

  /** 正式 formatter registry + NO_GUIDANCE 注册的最终 agent 可见文本。 */
  async function renderFinal(msg: InboxMessage): Promise<string> {
    return buildRuntime(audit).testFormatInboxMessage(
      msg.type, msg.from, msg.content, undefined, msg.metadata,
    );
  }

  it('正常完成：同契约两块输出 → 通知 2 个输出块，产物文件先于通知存在且内容准确', async () => {
    await createArchiveContract('claw-1', 'contract-001');
    mockSchedule.mockResolvedValue('direct-1');
    await writeTaskCompletion('direct-1',
      '[DREAM_OUTPUT contract_id="contract-001"]insight-a[/DREAM_OUTPUT]\n'
      + '[DREAM_OUTPUT contract_id="contract-001"]insight-b[/DREAM_OUTPUT]');

    const outputPath = 'memory/dream-outputs/direct-1.txt';
    const notifyBodies: string[] = [];
    await runRandomDream(makeOpts(async (msg) => {
      // 保存先于通知：notify 回调内产物文件已存在且为两块原文按现有分隔拼接
      const saved = fsSync.readFileSync(path.join(motionDir, outputPath), 'utf-8');
      expect(saved).toBe('insight-a\n\n---\n\ninsight-b');
      notifyBodies.push(String(msg.body));
      await realNotify()(msg);
    }));

    expect(notifyBodies).toHaveLength(1);
    expect(mockSchedule).toHaveBeenCalledTimes(1);

    const msg = await drainOnlyMessage();
    expect(msg.type).toBe('random_dream_completed');
    expect(msg.from).toBe('random-dream');
    expect(msg.priority).toBe('normal');
    // 持久事实（metadata + 稳定 delivery_id）
    expect(msg.metadata).toMatchObject({
      dreamId: 'direct-1',
      outputCount: '2',
      path: outputPath,
      delivery_id: 'random-dream:direct-1',
    });

    const final = await renderFinal(msg);
    expect(final).toBe(`[system message] ${expectedNoticeBody('direct-1', 2, outputPath)}`);
    // 同契约两块如实计 2 个输出块，不冒称 2 contracts / 有效经验
    expect(final).not.toContain('contracts');
    expect(final).not.toContain('2 个契约');
    expect(final).not.toContain('有效');
    // 正文相对路径解析到 motion 真实文件，与保存实证一致
    const resolved = fsSync.readFileSync(path.join(motionDir, outputPath), 'utf-8');
    expect(resolved).toBe('insight-a\n\n---\n\ninsight-b');
  });

  it('两契约、多块含空白块：原计数保持（含空白块），不称有效洞见', async () => {
    await createArchiveContract('claw-1', 'c-a');
    await createArchiveContract('claw-1', 'c-b');
    mockSchedule.mockResolvedValue('multi-1');
    await writeTaskCompletion('multi-1',
      '[DREAM_OUTPUT contract_id="c-a"]first[/DREAM_OUTPUT]\n'
      + '[DREAM_OUTPUT contract_id="c-b"][/DREAM_OUTPUT]\n'
      + '[DREAM_OUTPUT contract_id="c-a"]third[/DREAM_OUTPUT]');

    await runRandomDream(makeOpts(realNotify()));

    const msg = await drainOnlyMessage();
    expect(msg.metadata).toMatchObject({ dreamId: 'multi-1', outputCount: '3' });
    const final = await renderFinal(msg);
    // 3 个输出块 = 2 个契约的 3 块（含 1 空白块）：计数不变成契约数、不称有效经验
    expect(final).toBe(`[system message] ${expectedNoticeBody('multi-1', 3, 'memory/dream-outputs/multi-1.txt')}`);
    expect(final).not.toContain('contracts');
    expect(final).not.toContain('有效');
    const saved = fsSync.readFileSync(path.join(motionDir, 'memory/dream-outputs/multi-1.txt'), 'utf-8');
    expect(saved).toBe('first\n\n---\n\n\n\n---\n\nthird');
  });

  it('零匹配输出块：不发完成通知', async () => {
    await createArchiveContract('claw-1', 'c-z');
    mockSchedule.mockResolvedValue('empty-1');
    await writeTaskCompletion('empty-1', 'no dream output block here');

    const notifySpy = vi.fn().mockResolvedValue(undefined);
    await runRandomDream(makeOpts(notifySpy));

    expect(notifySpy).not.toHaveBeenCalled();
    const pendingFiles = fsSync.readdirSync(path.join(motionDir, 'inbox', 'pending'))
      .filter(f => f.endsWith('.md'));
    expect(pendingFiles).toHaveLength(0);
    expect(events.some(e => e[0] === MEMORY_AUDIT_EVENTS.RANDOM_DREAM_OUTPUT_MISSING)).toBe(true);
    const state = JSON.parse(fsSync.readFileSync(path.join(chestnutRoot, '.random-dream-state.json'), 'utf-8'));
    expect(state.pendingNotifications ?? []).toEqual([]);
  });

  it('迟到结果：taskId ≠ fullTaskId 时正文显示原 taskId、位置用真实持久路径（不拼短 ID 文件名）', async () => {
    const now = Date.now();
    const shortId = 'lateshort';
    const fullId = 'latefull0000000001';
    await fs.writeFile(
      path.join(chestnutRoot, '.random-dream-state.json'),
      JSON.stringify({
        completedContractIds: [],
        pendingLateSettle: [{
          taskId: shortId,
          fullTaskId: fullId,
          scheduledAt: now - 3600_000,
          expectedTimeoutAt: now - 60_000,
          contractIds: [],
        }],
      }),
      'utf-8',
    );
    // 迟到结果落在 fullTaskId 路径下；无 claws 目录 → discover 空、不误启动新任务
    await writeTaskCompletion(fullId, '[DREAM_OUTPUT contract_id="c1"]迟到的洞见[/DREAM_OUTPUT]');

    await runRandomDream(makeOpts(realNotify()));
    expect(mockSchedule).not.toHaveBeenCalled();

    const outputPath = `memory/dream-outputs/${fullId}.txt`;
    const msg = await drainOnlyMessage();
    expect(msg.metadata).toMatchObject({
      dreamId: shortId,
      outputCount: '1',
      path: outputPath,
      delivery_id: `random-dream:${fullId}`,
      lateSettleFullTaskId: fullId,
    });

    const final = await renderFinal(msg);
    expect(final).toBe(`[system message] ${expectedNoticeBody(shortId, 1, outputPath)}`);
    // 身份显示原 taskId（不替换为全 ID），路径是真实持久产物路径
    expect(final).toContain(`任务：${shortId}`);
    expect(final).not.toContain(`任务：${fullId}`);
    expect(fsSync.readFileSync(path.join(motionDir, outputPath), 'utf-8')).toBe('迟到的洞见');
    // sweep 消费完成：entry drop
    const state = JSON.parse(fsSync.readFileSync(path.join(chestnutRoot, '.random-dream-state.json'), 'utf-8'));
    expect(state.pendingLateSettle).toEqual([]);
  });

  it('通知失败 → 重建运行状态 → 重投：事实不丢、delivery_id 稳定、最终正文相同', async () => {
    await createArchiveContract('claw-1', 'contract-001');
    mockSchedule.mockResolvedValue('retry-1');
    await writeTaskCompletion('retry-1', '[DREAM_OUTPUT contract_id="contract-001"]insight[/DREAM_OUTPUT]');

    // 第一次：notify 失败（保存 + stage 已提交，pending 落盘）
    const firstAttempt: Array<Record<string, unknown>> = [];
    const failingNotify: RandomDreamOptions['notifyMotion'] = async (msg) => {
      firstAttempt.push(msg as Record<string, unknown>);
      throw new Error('boom: inbox unavailable');
    };
    await expect(runRandomDream(makeOpts(failingNotify))).rejects.toThrow('boom');
    expect(firstAttempt).toHaveLength(1);

    // 崩溃后磁盘 state 保留完整持久事实
    const crashed = JSON.parse(fsSync.readFileSync(path.join(chestnutRoot, '.random-dream-state.json'), 'utf-8'));
    expect(crashed.pendingNotifications).toHaveLength(1);
    expect(crashed.pendingNotifications[0]).toMatchObject({
      deliveryId: 'random-dream:retry-1',
      taskId: 'retry-1',
      outputPath: 'memory/dream-outputs/retry-1.txt',
      outputCount: 1,
    });

    // 第二次：重建运行状态，flush 恢复重投（contract-001 已完成 → 不误启动新任务）
    await runRandomDream(makeOpts(realNotify()));
    expect(mockSchedule).toHaveBeenCalledTimes(1);

    const msg = await drainOnlyMessage();
    expect(msg.metadata).toMatchObject({
      dreamId: 'retry-1',
      outputCount: '1',
      path: 'memory/dream-outputs/retry-1.txt',
      delivery_id: 'random-dream:retry-1',
    });
    // 重投正文与首次尝试完全相同（按持久事实重建，不重新抽取/保存）
    expect(msg.content).toBe(String(firstAttempt[0].body));
    const final = await renderFinal(msg);
    expect(final).toBe(`[system message] ${expectedNoticeBody('retry-1', 1, 'memory/dream-outputs/retry-1.txt')}`);

    const state = JSON.parse(fsSync.readFileSync(path.join(chestnutRoot, '.random-dream-state.json'), 'utf-8'));
    expect(state.pendingNotifications).toEqual([]);
  });

  it('旧 pending 记录（无 lateSettleFullTaskId）恢复：按持久事实产新语义正文并真实链呈现', async () => {
    // 模拟本 phase 之前落盘的 pending 记录：字段集不含 lateSettleFullTaskId
    await fs.writeFile(
      path.join(chestnutRoot, '.random-dream-state.json'),
      JSON.stringify({
        completedContractIds: [],
        pendingNotifications: [{
          deliveryId: 'random-dream:legacy-1',
          taskId: 'legacy-1',
          outputPath: 'memory/dream-outputs/legacy-1.txt',
          outputCount: 2,
          completedContractIds: ['c-old'],
          createdAt: Date.now(),
        }],
      }),
      'utf-8',
    );

    await runRandomDream(makeOpts(realNotify()));
    expect(mockSchedule).not.toHaveBeenCalled();

    const msg = await drainOnlyMessage();
    expect(msg.metadata).toMatchObject({
      dreamId: 'legacy-1',
      outputCount: '2',
      path: 'memory/dream-outputs/legacy-1.txt',
      delivery_id: 'random-dream:legacy-1',
    });
    const final = await renderFinal(msg);
    expect(final).toBe(`[system message] ${expectedNoticeBody('legacy-1', 2, 'memory/dream-outputs/legacy-1.txt')}`);
    // 重投只使用持久事实构造新正文，不重新运行模型/重复保存
    expect(events.some(e => e[0] === MEMORY_AUDIT_EVENTS.DREAM_OUTPUT_PERSISTED)).toBe(false);
  });
});
