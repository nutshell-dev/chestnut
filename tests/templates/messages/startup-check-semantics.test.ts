/**
 * phase 1839 (M02 语义治理)：startup_check 启动通知新正文的真实生产链组合验收。
 *
 * 接管 tests/templates/messages/inbox-text-equivalence.test.ts 移交的 M02 唯一 case
 * （startup-check；golden 历史数据保留、不逐字节比较）。本文件不使用模块级 vi.mock、
 * 不模拟模板/消息 codec/formatter/guidance registry：真实 NodeFileSystem → 生产
 * createStartupCheckDelivery 投递 → 真实 createInboxReader.drainAndDeliver/ack 读回
 * → 正式 DAEMON_INBOX_MESSAGE_TYPES 注册的标准 system 呈现 → 正式
 * registerAllMotionGuidance（startup_check = NO_GUIDANCE，motion）/ 无
 * guidanceCompose（worker）→ Runtime.formatInboxMessage 最终文本。
 *
 * 覆盖（Step B §6 验收场景）：
 *  1. 真实 fired、唯一消息，type/from/to/priority 及 metadata 正确；新完整正文与
 *     motion/worker 完整最终呈现精确相等
 *  2. 消息真实投递后移走 active，再从 inbox 读回并呈现：正文保持历史时态、包含
 *     已完成无需新增任务（迟到呈现不制造任务）；只验证表达，不宣称测试了 LLM 遵循
 *  3. 旧历史正文经当前 motion/worker formatter 呈现原样保留，不追加新指导或迁移提示
 *
 * 不复制 phase 1838 的机制恢复/重试/移动测试（tests/daemon/startup-check-*.test.ts）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import {
  createInboxReader,
  createInboxMessageTypeRegistry,
  registerInboxMessageTypes,
} from '../../../src/foundation/messaging/index.js';
import type { InboxMessage } from '../../../src/foundation/messaging/index.js';
import { createStartupCheckDelivery } from '../../../src/daemon/daemon-loop.js';
import { DAEMON_INBOX_MESSAGE_TYPES } from '../../../src/daemon/inbox-formatter.js';
import { Runtime } from '../../../src/core/runtime/runtime.js';
import { createMotionGuidanceRegistry, registerAllMotionGuidance } from '../../../src/assembly/guidance/index.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeAudit } from '../../helpers/audit.js';

/** phase 1839 新语义完整正文（与模板契约同一字面；expected 为 literal，不经模板生成）。 */
const NEW_BODY = [
  '执行进程已启动。启动检查时发现仍有活跃契约，本消息用于唤醒后续处理。',
  '',
  '请结合当前契约状态和已有工作记录，继续尚未完成的工作。',
  '不要因进程重启重复执行已完成的步骤；若相关工作已经完成，无需因本通知新增任务。',
].join('\n');

/** phase 1839 之前落盘的历史通知正文（旧 literal，呈现原样保留、不重写）。 */
const LEGACY_BODY = 'System startup. Please review active contracts and resume execution.';

/** Runtime 最终呈现装配：正式 DAEMON_INBOX_MESSAGE_TYPES 注册。 */
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
 * motion = 装正式 registerAllMotionGuidance（startup_check = NO_GUIDANCE）；
 * worker = 不装 guidance（guidanceCompose undefined → Runtime 跳过追加）。
 */
function buildRuntime(
  audit: ReturnType<typeof makeAudit>['audit'],
  opts: { withMotionGuidance: boolean },
): TestRuntime {
  const formatterRegistry = createInboxMessageTypeRegistry();
  registerInboxMessageTypes(formatterRegistry, DAEMON_INBOX_MESSAGE_TYPES);
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

describe('phase 1839: startup_check 启动通知新语义真实生产链', () => {
  let agentDir: string;
  let realAgentFs: NodeFileSystem;
  let audit: ReturnType<typeof makeAudit>['audit'];
  let events: ReturnType<typeof makeAudit>['events'];

  beforeEach(async () => {
    agentDir = await createTempDir();
    // 满足 eligibility：已发布 active 契约（无 .creating）+ 空 inbox + 无 cooldown
    await fs.mkdir(path.join(agentDir, 'contract', 'active', 'c-live'), { recursive: true });
    await fs.mkdir(path.join(agentDir, 'inbox', 'pending'), { recursive: true });
    realAgentFs = new NodeFileSystem({ baseDir: agentDir });
    ({ audit, events } = makeAudit());
  });

  afterEach(async () => {
    await cleanupTempDir(agentDir);
    vi.clearAllMocks();
  });

  /** 生产 delivery 投递（必须 fired）→ 真实 reader 读回一条 entry → 真实 ack 结算。 */
  async function deliverAndReadBack(): Promise<{
    timestampMs: number;
    msg: InboxMessage;
  }> {
    const delivery = createStartupCheckDelivery({
      agentFs: realAgentFs, clawFs: realAgentFs, agentDir, audit,
    });
    const outcome = await delivery.deliver();
    expect(outcome.kind).toBe('fired');
    if (outcome.kind !== 'fired') throw new Error('unreachable');

    const reader = createInboxReader(realAgentFs, audit, 'inbox');
    const batch = await reader.drainAndDeliver();
    expect(batch.entries.length).toBe(1);
    expect(batch.handles.length).toBe(1);
    const msg = batch.entries[0]!.message;
    await reader.ack(batch.handles[0]!);
    return { timestampMs: outcome.timestampMs, msg };
  }

  async function renderFinal(msg: InboxMessage, opts: { withMotionGuidance: boolean }): Promise<string> {
    return buildRuntime(audit, opts).testFormatInboxMessage(
      msg.type, msg.from, msg.content, undefined, msg.metadata,
    );
  }

  function expectNoFormatterFallback(): void {
    // 正式注册命中、guidance composer 无失败（防未注册 type 的 fallback 假通过）
    expect(events.some(e => e[0] === 'runtime_inbox_unknown_type')).toBe(false);
    expect(events.some(e => e[0] === 'guidance_composer_failed')).toBe(false);
  }

  it('1. 真实 fired：唯一消息、envelope/metadata 正确；motion 与 worker 最终呈现均为新完整正文', async () => {
    const { timestampMs, msg } = await deliverAndReadBack();

    expect(msg.type).toBe('startup_check');
    expect(msg.from).toBe('daemon');
    expect(msg.to).toBe('');
    expect(msg.priority).toBe('high');
    expect(msg.content).toBe(NEW_BODY);
    expect(Date.parse(msg.timestamp)).not.toBeNaN();
    // 关联字段在 decode 后的 metadata（非 extraMeta），与 status 文件及 outcome 一致
    const statusTs = (await fs.readFile(path.join(agentDir, 'daemon', 'startup_check_ts'), 'utf8')).trim();
    expect(msg.metadata?.startup_check_ts).toBe(statusTs);
    expect(msg.metadata?.startup_check_ts).toBe(String(timestampMs));

    const motionFinal = await renderFinal(msg, { withMotionGuidance: true });
    const workerFinal = await renderFinal(msg, { withMotionGuidance: false });
    expect(motionFinal).toBe(workerFinal);
    expect(motionFinal).toBe(`[system message] ${NEW_BODY}`);
    // 不追加任何 CLI 或恢复成功保证
    expect(motionFinal).not.toContain('chestnut ');
    expect(motionFinal).not.toContain('已恢复');
    expectNoFormatterFallback();
  });

  it('2. 投递后移走 active 再读回呈现：正文保持历史时态、含已完成无需新增任务（迟到不制造任务）', async () => {
    const delivery = createStartupCheckDelivery({
      agentFs: realAgentFs, clawFs: realAgentFs, agentDir, audit,
    });
    const outcome = await delivery.deliver();
    expect(outcome.kind).toBe('fired');

    // 消息真实投递后、接收方读取前移走 active（迟到场景：契约可能已不在活跃目录）
    await fs.rename(
      path.join(agentDir, 'contract', 'active', 'c-live'),
      path.join(agentDir, 'contract', 'c-live-archived'),
    );

    const reader = createInboxReader(realAgentFs, audit, 'inbox');
    const batch = await reader.drainAndDeliver();
    expect(batch.entries.length).toBe(1);
    const msg = batch.entries[0]!.message;
    await reader.ack(batch.handles[0]!);

    // 消息不重写：仍是投递时的完整正文，历史时态（启动检查时发现）+ 已完成无需新增任务
    expect(msg.content).toBe(NEW_BODY);
    expect(msg.content).toContain('启动检查时发现仍有活跃契约');
    expect(msg.content).toContain('无需因本通知新增任务');

    const final = await renderFinal(msg, { withMotionGuidance: true });
    expect(final).toBe(`[system message] ${NEW_BODY}`);
    expectNoFormatterFallback();
  });

  it('3. 旧历史正文经当前 motion/worker formatter 呈现原样保留，不追加新指导或迁移提示', async () => {
    for (const withMotionGuidance of [true, false]) {
      const final = await buildRuntime(audit, { withMotionGuidance }).testFormatInboxMessage(
        'startup_check', 'daemon', LEGACY_BODY, undefined, { startup_check_ts: '1' },
      );
      // 历史 body 原样呈现（不重写为新闻、不追加迁移说明）；NO_GUIDANCE 不附尾段
      expect(final).toBe(`[system message] ${LEGACY_BODY}`);
    }
    expectNoFormatterFallback();
  });
});
