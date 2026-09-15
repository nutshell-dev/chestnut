/**
 * phase 1836 (M11 语义治理)：task_queue_overflow 超限通知新语义的真实生产链组合验收。
 *
 * 接管 tests/templates/messages/inbox-text-equivalence.test.ts 移交的 M11 两 case
 * （guidance、overflow-body；golden 历史数据保留、不逐字节比较）。本文件只模拟故障
 * 注入与任务执行器不运行，不模拟模板/消息 codec/formatter/guidance registry：
 * 真实 AsyncTaskSystem._enqueueAndDispatch 拒绝链 → 真实 sendFallbackResult 写
 * task_result → 真实 InboxWriter 落 self inbox → 真实 InboxReader 读回 → 正式
 * ASYNC_TASK_SYSTEM_INBOX_MESSAGE_TYPES 注册的标准 system 呈现 → 正式
 * registerAllMotionGuidance（task_queue_overflow = NO_GUIDANCE，motion）/
 * 无 guidanceCompose（worker）→ Runtime.formatInboxMessage 最终文本。
 *
 * 覆盖（Step B §6 覆盖矩阵）：
 *  1. cap=3、实际 4：真实结果+系统通知落盘；通知发送边界上失败目录/terminalState/
 *     notified marker/task_result 均已提交；最终文字显示 4/3 而非 cap 数
 *  2. 读回两个消息（按 type 选，不依赖跨 priority 消费顺序）；motion（正式 guidance
 *     registry）与 worker（无 guidance）最终正文相同，无升级/停派指令
 *  3. 等于 cap 不产生溢出通知，超过才拒绝
 *  4. 失败前置（terminal 写/结果投递/notified marker/failed move 失败）→ 本轮系统
 *     通知零投递；结果已写但标记失败时不发送任何宣称处置状态的通知
 *  5. 通知入队后队列变化，正文保持历史观测并提示可能已变；无恢复/永久禁止派发指令
 *  6. 旧历史 body 经当前 motion 呈现不变，但不再追加旧 guidance
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as fsSync from 'fs';
import { promises as fs } from 'fs';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { InMemoryShortIdIndex } from '../../../src/core/async-task-system/short-id-index.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import { ASYNC_TASK_SYSTEM_INBOX_MESSAGE_TYPES } from '../../../src/core/async-task-system/inbox-formatter.js';
import type { AsyncTaskSystemOptions } from '../../../src/core/async-task-system/system.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import {
  InboxReader,
  InboxWriter,
  makeInboxPath,
  MESSAGING_WRITER_LIMITS_DEFAULT,
  INBOX_INFLIGHT_DIR,
  createInboxMessageTypeRegistry,
  registerInboxMessageTypes,
} from '../../../src/foundation/messaging/index.js';
import { decodeInbox } from '../../../src/foundation/messaging/codec-inbox.js';
import type { InboxMessage } from '../../../src/foundation/messaging/index.js';
import { Runtime } from '../../../src/core/runtime/runtime.js';
import { createMotionGuidanceRegistry, registerAllMotionGuidance } from '../../../src/assembly/guidance/index.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';

// ─── 工具 ────────────────────────────────────────────────────

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

/** phase 1836 新语义完整正文（与模板契约同一字面；expected 为 literal 拼接，不经模板生成）。 */
function expectedOverflowBody(taskId: string, queueLength: number, cap: number): string {
  return '一次异步任务提交因待处理队列超限被拒绝。\n'
    + `任务：${taskId}\n`
    + `检查时队列数量：${queueLength}；上限：${cap}\n`
    + '\n'
    + '系统已将该任务记为失败，并另行投递失败结果。\n'
    + '上述数量是拒绝发生前的观测值，收到通知时队列状态可能已经变化。';
}

/** Runtime 最终呈现装配：正式 ASYNC_TASK_SYSTEM_INBOX_MESSAGE_TYPES 注册。 */
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

/**
 * motion = 装正式 registerAllMotionGuidance（task_queue_overflow = NO_GUIDANCE）；
 * worker = 不装 motion guidance（guidanceCompose undefined → Runtime 跳过追加）。
 */
function buildRuntime(
  audit: ReturnType<typeof makeAudit>['audit'],
  opts: { withMotionGuidance: boolean },
): TestRuntime {
  const formatterRegistry = createInboxMessageTypeRegistry();
  registerInboxMessageTypes(formatterRegistry, ASYNC_TASK_SYSTEM_INBOX_MESSAGE_TYPES);
  const guidanceRegistry = createMotionGuidanceRegistry();
  registerAllMotionGuidance(guidanceRegistry);
  return new TestRuntime({
    clawId: opts.withMotionGuidance ? 'motion' : 'worker',
    clawDir: '/tmp/test-claw',
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
      guidanceCompose: opts.withMotionGuidance ? (input) => guidanceRegistry.compose(input) : undefined,
    },
  });
}

// ─── 测试 ────────────────────────────────────────────────────

describe('phase 1836: task_queue_overflow 超限通知新语义真实生产链', () => {
  let baseDir: string;
  let inboxPendingDir: string;
  let realFs: NodeFileSystem;
  let audit: ReturnType<typeof makeAudit>['audit'];
  let events: ReturnType<typeof makeAudit>['events'];

  beforeEach(async () => {
    baseDir = await createTempDir();
    for (const sub of ['pending', 'done', 'failed', 'running', 'results']) {
      await fs.mkdir(path.join(baseDir, 'tasks', 'queues', sub), { recursive: true });
    }
    await fs.mkdir(path.join(baseDir, 'sync'), { recursive: true });
    await fs.mkdir(path.join(baseDir, 'subagents'), { recursive: true });
    inboxPendingDir = path.join(baseDir, 'inbox', 'pending');
    await fs.mkdir(inboxPendingDir, { recursive: true });
    await fs.mkdir(path.join(baseDir, 'inbox', 'done'), { recursive: true });
    await fs.mkdir(path.join(baseDir, 'inbox', 'failed'), { recursive: true });
    await fs.mkdir(path.join(baseDir, INBOX_INFLIGHT_DIR), { recursive: true });
    realFs = new NodeFileSystem({ baseDir });
    ({ audit, events } = makeAudit());
  });

  afterEach(async () => {
    await cleanupTempDir(baseDir);
    vi.clearAllMocks();
  });

  function writePending(id: string): void {
    fsSync.writeFileSync(path.join(baseDir, 'tasks', 'queues', 'pending', `${id}.json`), JSON.stringify({
      id, kind: 'subagent', mode: 'standard', shortId: id.slice(0, 8), parentClawId: 'parent-claw',
      parentClawDir: baseDir, createdAt: new Date().toISOString(), timeoutMs: 60000, intent: 'test',
    }));
  }

  /** 真实 InboxWriter 作 selfInbox（与 task_result 同一 inbox，模拟 daemon 自家 inbox）。 */
  function makeRealSelfInbox(): InboxWriter {
    return InboxWriter.__internal_create(
      realFs, makeInboxPath(inboxPendingDir), audit as never, MESSAGING_WRITER_LIMITS_DEFAULT,
    );
  }

  function makeSystem(overrides: Partial<AsyncTaskSystemOptions> = {}): AsyncTaskSystem {
    return new AsyncTaskSystem(baseDir, realFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      llm: {} as never,
      contractManager: {} as never,
      registry: {} as never,
      selfInbox: makeRealSelfInbox(),
      pendingQueueMax: 3,
      ...overrides,
    } as AsyncTaskSystemOptions);
  }

  async function triggerOverflow(system: AsyncTaskSystem, id: string): Promise<void> {
    await (system as unknown as { _enqueueAndDispatch(t: unknown): Promise<void> })
      ._enqueueAndDispatch({ id, kind: 'subagent', parentClawId: 'parent-claw', parentClawDir: baseDir });
  }

  /** 真实 InboxReader 读回全部 pending 消息（claim 到 inflight）。 */
  async function drainAll(): Promise<InboxMessage[]> {
    const reader = new InboxReader(
      inboxPendingDir,
      path.join(baseDir, 'inbox', 'done'),
      path.join(baseDir, 'inbox', 'failed'),
      realFs,
      audit as never,
    );
    const result = await reader.drainAndDeliver();
    expect(result.kind).toBe('complete');
    if (result.kind !== 'complete') throw new Error('unreachable');
    return result.entries.map(e => e.message);
  }

  /** 当前 inbox pending 中已解码的消息（不消费）。 */
  function peekPendingMessages(): InboxMessage[] {
    return fsSync.readdirSync(inboxPendingDir)
      .filter(f => f.endsWith('.md'))
      .map(f => decodeInbox(fsSync.readFileSync(path.join(inboxPendingDir, f), 'utf8')));
  }

  async function renderFinal(msg: InboxMessage, opts: { withMotionGuidance: boolean }): Promise<string> {
    return buildRuntime(audit, opts).testFormatInboxMessage(
      msg.type, msg.from, msg.content, undefined, msg.metadata,
    );
  }

  it('真实拒绝：任务 ID + 观测 4/3 落盘；通知发送边界上失败处置与 task_result 均已提交', async () => {
    // selfInbox 写入边界 wrapper：先核失败目录文件、failed terminalState、
    // result.txt.notified 与 task_result 均已存在，再调用真实 writer
    const realWriter = makeRealSelfInbox();
    const boundaryInbox = {
      writeSync: (msg: Parameters<InboxWriter['writeSync']>[0]) => {
        const failedFile = path.join(baseDir, 'tasks', 'queues', 'failed', 'overflow-task.json');
        expect(fsSync.existsSync(failedFile)).toBe(true);
        expect(JSON.parse(fsSync.readFileSync(failedFile, 'utf8')).terminalState).toBe('failed');
        expect(fsSync.existsSync(
          path.join(baseDir, 'tasks', 'queues', 'results', 'overflow-task', 'result.txt.notified'),
        )).toBe(true);
        const delivered = peekPendingMessages();
        const taskResult = delivered.find(m => m.type === 'task_result');
        expect(taskResult).toBeDefined();
        // 结果身份与本次被拒任务 fullId 一致（不断言结果正文格式）
        expect(taskResult!.content).toContain('overflow-task');
        return realWriter.writeSync(msg);
      },
    } as unknown as InboxWriter;

    const system = makeSystem({ selfInbox: boundaryInbox });
    writePending('overflow-task');
    for (let i = 0; i < 3; i++) writePending(`task-${i}`);
    await triggerOverflow(system, 'overflow-task');

    const messages = await drainAll();
    expect(messages).toHaveLength(2);
    const overflow = messages.find(m => m.type === 'task_queue_overflow');
    expect(overflow).toBeDefined();
    expect(overflow!.from).toBe('async-task-system');
    expect(overflow!.priority).toBe('critical');
    expect(overflow!.metadata).toMatchObject({ cap: '3', queue_length: '4' });
    // 最终文字显示 4/3（观测值）而非 3 pending（cap 充当数量）
    expect(overflow!.content).toBe(expectedOverflowBody('overflow-task', 4, 3));
    expect(overflow!.content).toContain('检查时队列数量：4；上限：3');
    expect(overflow!.content).not.toContain('at capacity');
    expect(overflow!.content).not.toContain('chronic');
    // 结果已投递 ≠ 已读：正文不冒称接收方已消费
    expect(overflow!.content).not.toContain('已读');
  });

  it('读回两个消息：motion 与 worker 最终正文相同，无升级/停派指令、无自由 text fallback', async () => {
    const system = makeSystem();
    writePending('overflow-task');
    for (let i = 0; i < 3; i++) writePending(`task-${i}`);
    await triggerOverflow(system, 'overflow-task');

    const messages = await drainAll();
    expect(messages).toHaveLength(2);
    // 按 type 选，不假定跨 priority（overflow critical / task_result high）消费顺序等于投递顺序
    const overflow = messages.find(m => m.type === 'task_queue_overflow')!;
    const taskResult = messages.find(m => m.type === 'task_result')!;
    expect(taskResult.content).toContain('overflow-task');

    const motionFinal = await renderFinal(overflow, { withMotionGuidance: true });
    const workerFinal = await renderFinal(overflow, { withMotionGuidance: false });
    expect(motionFinal).toBe(workerFinal);
    expect(motionFinal).toBe(`[system message] ${expectedOverflowBody('overflow-task', 4, 3)}`);
    // 无升级用户/停派/长期故障指令，无自由 text fallback 追加
    for (const banned of ['Surface to the user', 'Do not retry', 'developer', 'system-level', 'chronic']) {
      expect(motionFinal).not.toContain(banned);
    }
  });

  it('等于 cap 不产生溢出通知；超过 cap 才拒绝', async () => {
    const system = makeSystem();
    for (let i = 0; i < 3; i++) writePending(`task-${i}`);
    // pendingCount = 3 == cap → 接受，不拒绝、不通知
    await triggerOverflow(system, 'task-0');
    expect(peekPendingMessages().filter(m => m.type === 'task_queue_overflow')).toHaveLength(0);
    expect(fsSync.existsSync(path.join(baseDir, 'tasks', 'queues', 'pending', 'task-0.json'))).toBe(true);
    expect(fsSync.existsSync(path.join(baseDir, 'tasks', 'queues', 'failed', 'task-0.json'))).toBe(false);
    expect(events.some(e => e[0] === TASK_AUDIT_EVENTS.PENDING_QUEUE_OVERFLOW)).toBe(false);

    // cap+1 → 拒绝并通知
    writePending('overflow-task');
    await triggerOverflow(system, 'overflow-task');
    const overflow = peekPendingMessages().find(m => m.type === 'task_queue_overflow');
    expect(overflow).toBeDefined();
    expect(overflow!.content).toBe(expectedOverflowBody('overflow-task', 4, 3));
  });

  it('失败前置：terminal 写失败 → 拒绝链抛出，本轮系统通知零投递', async () => {
    const origWriteAtomic = realFs.writeAtomic.bind(realFs);
    (realFs as unknown as { writeAtomic(p: string, c: string): Promise<void> }).writeAtomic =
      async (p: string, c: string) => {
        if (p.endsWith(path.join('pending', 'overflow-task.json'))) {
          throw new Error('injected terminal write failure');
        }
        return origWriteAtomic(p, c);
      };
    const system = makeSystem();
    writePending('overflow-task');
    for (let i = 0; i < 3; i++) writePending(`task-${i}`);

    await expect(triggerOverflow(system, 'overflow-task')).rejects.toThrow('injected terminal write failure');
    // 系统通知与 task_result 均零投递（terminalState 未提交，不得宣称任何处置）
    expect(peekPendingMessages()).toHaveLength(0);
    expect(fsSync.existsSync(path.join(baseDir, 'tasks', 'queues', 'failed', 'overflow-task.json'))).toBe(false);
    const persisted = JSON.parse(fsSync.readFileSync(
      path.join(baseDir, 'tasks', 'queues', 'pending', 'overflow-task.json'), 'utf8'));
    expect(persisted.terminalState).toBeUndefined();
  });

  it('失败前置：失败结果投递失败 → 本轮系统通知零投递，任务留 pending 可恢复', async () => {
    const system = makeSystem({
      sendFallbackResult: async () => { throw new Error('injected fallback failure'); },
    });
    writePending('overflow-task');
    for (let i = 0; i < 3; i++) writePending(`task-${i}`);
    await triggerOverflow(system, 'overflow-task');

    expect(peekPendingMessages().filter(m => m.type === 'task_queue_overflow')).toHaveLength(0);
    expect(fsSync.existsSync(path.join(baseDir, 'tasks', 'queues', 'pending', 'overflow-task.json'))).toBe(true);
    expect(fsSync.existsSync(path.join(baseDir, 'tasks', 'queues', 'failed', 'overflow-task.json'))).toBe(false);
    // 可恢复审计保留
    expect(events.some(e => e[0] === TASK_AUDIT_EVENTS.MOVE_FAILED
      && e.slice(1).join(' ').includes('cap_overflow_notify_failed'))).toBe(true);
  });

  it('失败前置：notified marker 写失败 → 结果已投递但不发送任何宣称处置状态的通知', async () => {
    const origWriteAtomic = realFs.writeAtomic.bind(realFs);
    (realFs as unknown as { writeAtomic(p: string, c: string): Promise<void> }).writeAtomic =
      async (p: string, c: string) => {
        if (p.endsWith('result.txt.notified')) {
          throw new Error('injected marker write failure');
        }
        return origWriteAtomic(p, c);
      };
    const system = makeSystem();
    writePending('overflow-task');
    for (let i = 0; i < 3; i++) writePending(`task-${i}`);
    await triggerOverflow(system, 'overflow-task');

    // 结果已投递（fallback 直接写 inline task_result + result.txt.sent 标记）——
    // 此时也不得宣称“已投递失败结果”的系统通知
    expect(fsSync.existsSync(
      path.join(baseDir, 'tasks', 'queues', 'results', 'overflow-task', 'result.txt.sent'))).toBe(true);
    const delivered = peekPendingMessages();
    expect(delivered.some(m => m.type === 'task_result')).toBe(true);
    expect(delivered.filter(m => m.type === 'task_queue_overflow')).toHaveLength(0);
    // 任务留 pending（terminalState failed）供下轮 _retryOverflowMove
    const persisted = JSON.parse(fsSync.readFileSync(
      path.join(baseDir, 'tasks', 'queues', 'pending', 'overflow-task.json'), 'utf8'));
    expect(persisted.terminalState).toBe('failed');
    expect(events.some(e => e[0] === TASK_AUDIT_EVENTS.MOVE_FAILED
      && e.slice(1).join(' ').includes('overflow_marker_write_failed'))).toBe(true);
  });

  it('失败前置：failed move 失败 → 本轮系统通知零投递，结果/marker 保留可恢复', async () => {
    (realFs as unknown as { move(s: string, d: string): Promise<void> }).move =
      async () => { throw new Error('injected move failure'); };
    const system = makeSystem();
    writePending('overflow-task');
    for (let i = 0; i < 3; i++) writePending(`task-${i}`);
    await triggerOverflow(system, 'overflow-task');

    expect(peekPendingMessages().filter(m => m.type === 'task_queue_overflow')).toHaveLength(0);
    // 结果与 notified marker 保留，任务留 pending 供恢复路由
    expect(fsSync.existsSync(
      path.join(baseDir, 'tasks', 'queues', 'results', 'overflow-task', 'result.txt.notified'))).toBe(true);
    expect(fsSync.existsSync(path.join(baseDir, 'tasks', 'queues', 'pending', 'overflow-task.json'))).toBe(true);
    expect(fsSync.existsSync(path.join(baseDir, 'tasks', 'queues', 'failed', 'overflow-task.json'))).toBe(false);
    expect(events.some(e => e[0] === TASK_AUDIT_EVENTS.MOVE_FAILED
      && e.slice(1).join(' ').includes('cap_overflow_move'))).toBe(true);
  });

  it('通知入队后队列变化：正文保持历史观测并提示可能已变，无恢复/永久禁止派发指令', async () => {
    const system = makeSystem();
    writePending('overflow-task');
    for (let i = 0; i < 3; i++) writePending(`task-${i}`);
    await triggerOverflow(system, 'overflow-task');

    const messages = await drainAll();
    const overflow = messages.find(m => m.type === 'task_queue_overflow')!;

    // 通知入队后、接收方读取前改变队列：清空 2 个、新增 1 个
    fsSync.unlinkSync(path.join(baseDir, 'tasks', 'queues', 'pending', 'task-0.json'));
    fsSync.unlinkSync(path.join(baseDir, 'tasks', 'queues', 'pending', 'task-1.json'));
    writePending('task-late');

    const final = await renderFinal(overflow, { withMotionGuidance: true });
    // 正文保持拒绝发生前的历史观测 4/3，并提示收到时可能已变
    expect(final).toBe(`[system message] ${expectedOverflowBody('overflow-task', 4, 3)}`);
    expect(final).toContain('收到通知时队列状态可能已经变化');
    // 无自动恢复通知、无永久禁止派发指令
    expect(final).not.toContain('已恢复');
    expect(final).not.toContain('Do not retry');
    expect(final).not.toContain('停派');
  });

  it('旧历史 body 经当前 motion 呈现不变，但不再追加旧 guidance', async () => {
    // 模拟本 phase 之前落盘的历史通知：旧英文 body + cap/queue_length extraFields
    const legacyBody = 'Task queue is at capacity (3 pending). The system is unable to dispatch'
      + ' tasks fast enough — likely a chronic processing failure.';
    makeRealSelfInbox().writeSync({
      type: 'task_queue_overflow',
      source: 'async-task-system',
      priority: 'critical',
      body: legacyBody,
      extraFields: { cap: '3', queue_length: '4' },
    });

    const messages = await drainAll();
    expect(messages).toHaveLength(1);
    const legacy = messages[0];
    expect(legacy.content).toBe(legacyBody);

    const final = await renderFinal(legacy, { withMotionGuidance: true });
    // 历史 body 原样呈现（不重写 chronic 文字），NO_GUIDANCE 不再附升级/停派尾段
    expect(final).toBe(`[system message] ${legacyBody}`);
    expect(final).not.toContain('Surface to the user');
    expect(final).not.toContain('Do not retry');
  });
});
