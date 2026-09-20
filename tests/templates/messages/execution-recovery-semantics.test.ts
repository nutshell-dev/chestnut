/**
 * phase 1845 (M01 语义治理)：execution_recovery 执行提醒新正文的真实生产链组合验收。
 *
 * 接管 tests/templates/messages/inbox-text-equivalence.test.ts 移交的 M01 唯一 case
 * （stalled-contract；golden 旧记录保留、不逐字节比较）。本文件不使用模块级 vi.mock、
 * 不模拟模板/store/controller/消息 codec/formatter/guidance registry：真实
 * NodeFileSystem → 真实 store/controller（固定时钟）登记义务 → 真实 EventLoop
 * protected 适配器（类型化测试子类公开，不复制控制逻辑）投递 → 真实
 * createInboxReader.drainAndDeliver/ack 读回 → Runtime.formatInboxMessage 最终呈现。
 *
 * 呈现路径实然（phase 1869 Step H 更新）：M01（execution_recovery）已由 EventLoop
 * 显式声明 rendering（EVENTLOOP_INBOX_MESSAGE_TYPES，standard/system）并经
 * business-systems 装配——正式 registry 解析命中、无 runtime_inbox_unknown_type
 * 审计，渲染输出与旧兜底逐字一致；motion 装正式 registerAllMotionGuidance
 * （无匹配不追加），worker 不装 guidance。
 *
 * 覆盖（Step B §6 验收场景）：
 *  1. 真实生成/读回：唯一消息、完整新正文 literal、envelope 与 metadata 关联正确；
 *     调度次数证据留在 record/delivery/EXECUTION_RECOVERY_RESUME 审计且一致，
 *     正文不含次数
 *  2. 最终呈现：motion 与 worker 均为 `[system message] ` + 完整正文，无
 *     unknown_type 审计、无 guidance 追加/异常（timestamp 传 undefined 隔离动态时间）
 *  3. 旧英文历史 body 经当前呈现原样保留（不重写、不追加迁移说明）
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import {
  createInboxReader,
  createInboxMessageTypeRegistry,
  registerInboxMessageTypes,
} from '../../../src/foundation/messaging/index.js';
import type { InboxMessage } from '../../../src/foundation/messaging/index.js';
import {
  EventLoop,
  createExecutionRecoveryController,
  createExecutionRecoveryStore,
} from '../../../src/core/event-loop/index.js';
import {
  EXECUTION_RECOVERY_DELIVERY_META_KEY,
  EXECUTION_RECOVERY_DIR,
} from '../../../src/core/event-loop/constants.js';
import { EVENTLOOP_AUDIT_EVENTS } from '../../../src/core/event-loop/audit-events.js';
import type {
  ExecutionRecoveryDeliveryOutcome,
  ExecutionRecoveryDeliveryRequest,
  ExecutionRecoveryRecord,
  PendingExecutionResume,
} from '../../../src/core/event-loop/index.js';
import { DAEMON_INBOX_MESSAGE_TYPES } from '../../../src/daemon/inbox-formatter.js';
import { EVENTLOOP_INBOX_MESSAGE_TYPES } from '../../../src/core/event-loop/index.js';
import { Runtime } from '../../../src/core/runtime/runtime.js';
import { createMotionGuidanceRegistry, registerAllMotionGuidance } from '../../../src/assembly/guidance/index.js';
import { createTrackedTempDirSync, cleanupTempDirSync } from '../../utils/temp.js';
import { makeAudit } from '../../helpers/audit.js';

/** phase 1845 新语义完整正文（与模板契约同一字面；expected 为 literal，不经模板生成）。 */
const NEW_BODY =
  '系统在检查时发现契约 1700000000000-abcd 仍活跃，且一段时间未观察到新的执行活动。'
  + '本消息用于唤醒你继续该契约尚未完成的工作。';

/** phase 1845 之前落盘的历史提醒正文（旧 literal，呈现原样保留、不重写）。 */
const LEGACY_BODY =
  'Execution stalled with no persisted activity; resume work on active contract '
  + '1700000000000-abcd (recovery attempt 2).';

const CONTRACT_ID = '1700000000000-abcd';
const CLAW_ID = 'claw-1';
const TIMEOUT_MS = 1000;
const FIXED_NOW = 1_700_500_000_000;

/** 类型化测试子类：只公开真实 protected 适配器，不复制控制逻辑。 */
class TestEventLoop extends EventLoop {
  deliverExecutionResume(
    request: ExecutionRecoveryDeliveryRequest,
  ): Promise<ExecutionRecoveryDeliveryOutcome> {
    return this._deliverExecutionResume(request);
  }

  /** 登记前 owner pending 查询适配（真实 peekPending 链）。 */
  findPendingExecutionResume(contractId: string): Promise<PendingExecutionResume> {
    return this._findPendingExecutionResume(contractId);
  }
}

/** Runtime 最终呈现装配：只公开 protected formatInboxMessage。 */
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
 * 现行真实装配：正式 DAEMON_INBOX_MESSAGE_TYPES + EVENTLOOP_INBOX_MESSAGE_TYPES
 * （phase 1869 Step H：execution_recovery standard/system 显式声明）；
 * motion = 装正式 registerAllMotionGuidance；worker = 不装 guidance。
 */
function buildRuntime(
  audit: ReturnType<typeof makeAudit>['audit'],
  opts: { withMotionGuidance: boolean },
): TestRuntime {
  const formatterRegistry = createInboxMessageTypeRegistry();
  registerInboxMessageTypes(formatterRegistry, DAEMON_INBOX_MESSAGE_TYPES);
  registerInboxMessageTypes(formatterRegistry, EVENTLOOP_INBOX_MESSAGE_TYPES);
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
        register: () => {},
        getForProfile: () => [],
        getAll: () => [],
        formatForLLM: () => [],
      } as never,
      toolExecutor: {} as never,
      contractManager: {} as never,
      taskSystem: {
        initialize: async () => {},
        startDispatch: () => {},
        shutdown: async () => ({ kind: 'converged', aborted: 0, terminal: [] }),
      } as never,
      skillRegistry: {} as never,
      permissionChecker: {} as never,
      fsFactory: () => ({}) as never,
      contractNotifyCallback: undefined,
      dialogStoreFactory: () => { throw new Error('not used'); },
      formatterRegistry,
      guidanceCompose: opts.withMotionGuidance ? (input) => guidanceRegistry.compose(input) : undefined,
    },
  });
}

describe('phase 1845: execution_recovery 执行提醒新语义真实生产链', () => {
  const cleanups: string[] = [];

  afterEach(() => {
    for (const dir of cleanups.splice(0)) cleanupTempDirSync(dir);
  });

  it('真实生成→读回→兜底呈现：完整新正文、envelope/metadata 关联、attempt 证据只在 record/audit', async () => {
    const rootDir = createTrackedTempDirSync('p1845-m01-');
    cleanups.push(rootDir);
    const agentDir = `${rootDir}/claws/${CLAW_ID}`;
    const pendingDir = `${agentDir}/inbox/pending`;
    fs.mkdirSync(pendingDir, { recursive: true });
    const { audit, events } = makeAudit();
    const agentFs = new NodeFileSystem({ baseDir: agentDir });
    const rootFs = new NodeFileSystem({ baseDir: rootDir });
    const loop = new TestEventLoop({
      runtime: {} as never,
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      agentDir,
      clawId: CLAW_ID,
      audit,
      inbox: { pendingDir },
    });
    const store = createExecutionRecoveryStore({ agentFs, legacyRootFs: rootFs, audit });
    const controller = createExecutionRecoveryController({
      store,
      audit,
      deliverResume: (request) => loop.deliverExecutionResume(request),
      findPendingResume: (contractId) => loop.findPendingExecutionResume(contractId),
      // 本链不注入 LLM recovery owner——显式 undefined（未注入语义）
      inspectLlmRecoverySchedule: async () => undefined,
      timeoutMs: TIMEOUT_MS,
      now: () => FIXED_NOW,
    });

    // 活动已过期（lastActivityAt 远旧于窗口）、三个 inFlight=false → 登记并投递
    await controller.observe({
      activeContractId: CONTRACT_ID,
      lastActivityAt: FIXED_NOW - 10 * TIMEOUT_MS,
      turnInFlight: false,
      retryInFlight: false,
      asyncTaskInFlight: false,
    });

    // 真实 reader 读回并 ack 结算
    const reader = createInboxReader(agentFs, audit, 'inbox');
    const batch = await reader.drainAndDeliver();
    expect(batch.kind).toBe('complete');
    if (batch.kind !== 'complete') throw new Error('unexpected batch kind');
    expect(batch.entries).toHaveLength(1);
    const msg: InboxMessage = batch.entries[0]!.message;
    await reader.ack(batch.handles[0]!);

    // 完整新正文 literal 与 envelope/metadata 关联
    expect(msg.content).toBe(NEW_BODY);
    expect(msg.type).toBe('execution_recovery');
    expect(msg.from).toBe(CLAW_ID);
    expect(msg.to).toBe('');
    expect(msg.priority).toBe('high');
    // 正文不含调度次数/恢复措辞（证据信息安置在 record/audit，不进正文）
    expect(msg.content).not.toContain('attempt');
    expect(msg.content).not.toContain('已恢复');
    expect(msg.content).not.toMatch(/第?\d+\s*次/);

    // 调度次数证据：record.attempts、delivery.attempt 与审计 attempt 一致
    const recordPath = `${agentDir}/${EXECUTION_RECOVERY_DIR}/${CONTRACT_ID}.json`;
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as ExecutionRecoveryRecord;
    expect(record.attempts).toBe(1);
    expect(record.delivery).toMatchObject({ kind: 'confirmed', attempt: 1, body: NEW_BODY });
    const resumeAudit = events.find(e => e[0] === EVENTLOOP_AUDIT_EVENTS.EXECUTION_RECOVERY_RESUME);
    expect(resumeAudit).toBeDefined();
    expect(resumeAudit!.some(col => String(col) === `attempt=${record.attempts}`)).toBe(true);
    expect(msg.metadata?.contract_id).toBe(CONTRACT_ID);
    expect(msg.metadata?.[EXECUTION_RECOVERY_DELIVERY_META_KEY]).toBe(record.delivery!.id);
    expect(msg.id).toBe(record.delivery!.id);

    // 最终呈现（phase 1869 Step H）：显式声明 standard/system → registry 命中、
    // 渲染逐字同旧兜底、无 unknown_type 审计；
    // motion（正式 guidance 全注册，无匹配）与 worker（无 guidance）结果一致
    const finals: string[] = [];
    for (const withMotionGuidance of [true, false]) {
      finals.push(await buildRuntime(audit, { withMotionGuidance }).testFormatInboxMessage(
        msg.type, msg.from, msg.content, undefined, msg.metadata,
      ));
    }
    expect(finals[0]).toBe(finals[1]);
    expect(finals[0]).toBe(`[system message] ${NEW_BODY}`);
    const unknownTypeEvents = events.filter(e => e[0] === 'runtime_inbox_unknown_type');
    expect(unknownTypeEvents).toHaveLength(0);
    expect(events.some(e => e[0] === 'guidance_composer_failed')).toBe(false);
  });

  it('旧英文历史 body 经当前 motion/worker 呈现原样保留，不追加指导或迁移说明', async () => {
    const { audit, events } = makeAudit();
    for (const withMotionGuidance of [true, false]) {
      const final = await buildRuntime(audit, { withMotionGuidance }).testFormatInboxMessage(
        'execution_recovery', CLAW_ID, LEGACY_BODY, undefined, { contract_id: CONTRACT_ID },
      );
      expect(final).toBe(`[system message] ${LEGACY_BODY}`);
    }
    expect(events.filter(e => e[0] === 'runtime_inbox_unknown_type')).toHaveLength(0);
    expect(events.some(e => e[0] === 'guidance_composer_failed')).toBe(false);
  });
});
