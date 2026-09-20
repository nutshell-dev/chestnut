/**
 * Phase 1869 Step C: drain 后同契约重复提醒的系统侧合并（2026-09-20 用户拍板
 * 合并协议：本 epoch 合法唤醒 = record 当前义务；其余为积压重复）。
 *
 * 契约：
 * - 本批 type=execution_recovery 且 from=本 claw 的消息按 metadata.contract_id 分组；
 * - 每组至多交付一条：① delivery_id 命中 record 当前义务者优先；② 无命中取最新
 *   （timestamp）；判定事实不足（无 record / 读取失败）退化为批次内规则；
 * - 其余 ack 到 done/（正文保留）+ execution_recovery_duplicate_merged 审计；
 * - 跨契约、其他 type、单条组完全不受影响。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { EventLoop } from '../../../src/core/event-loop/index.js';
import { EVENTLOOP_AUDIT_EVENTS } from '../../../src/core/event-loop/audit-events.js';
import {
  EXECUTION_RECOVERY_DELIVERY_META_KEY,
  EXECUTION_RECOVERY_DIR,
} from '../../../src/core/event-loop/constants.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import type { Runtime, TurnResult } from '../../../src/core/runtime/index.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import type { InboxHandle, InboxMessage } from '../../../src/foundation/messaging/types.js';
import type { Message } from '../../../src/foundation/dialog-store/index.js';
import type { ToolDefinition } from '../../../src/foundation/llm-provider/types.js';

function createMockAudit(): AuditLog & { entries: [string, ...(string | number)[]][] } {
  const entries: [string, ...(string | number)[]][] = [];
  return {
    entries,
    write: (type: string, ...cols: (string | number)[]) => { entries.push([type, ...cols]); },
  };
}

function makeTurnResult(status: TurnResult['status'], extra?: Partial<TurnResult>): TurnResult {
  return { status, ...extra } as TurnResult;
}

describe('EventLoop 重复提醒合并 (phase 1869 Step C)', () => {
  let agentDir: string;
  let inboxPendingDir: string;
  const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

  beforeEach(() => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    agentDir = path.join(os.tmpdir(), `event-loop-merge-${randomUUID()}`);
    require('fs').mkdirSync(agentDir, { recursive: true });
    inboxPendingDir = path.join(agentDir, 'inbox', 'pending');
    require('fs').mkdirSync(inboxPendingDir, { recursive: true });
  });

  afterEach(() => {
    require('fs').rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function recoveryMessage(
    id: string,
    contractId: string,
    opts: { from?: string; timestampMs?: number; deliveryId?: string } = {},
  ): InboxMessage {
    return {
      id,
      type: 'execution_recovery',
      from: opts.from ?? 'test-claw',
      to: '',
      content: `reminder ${id}`,
      priority: 'high',
      timestamp: new Date(opts.timestampMs ?? Date.now()).toISOString(),
      metadata: {
        contract_id: contractId,
        ...(opts.deliveryId ? { [EXECUTION_RECOVERY_DELIVERY_META_KEY]: opts.deliveryId } : {}),
      },
    };
  }

  function seedRecoveryRecord(contractId: string, deliveryId: string): void {
    const dir = path.join(agentDir, EXECUTION_RECOVERY_DIR);
    require('fs').mkdirSync(dir, { recursive: true });
    require('fs').writeFileSync(path.join(dir, `${contractId}.json`), JSON.stringify({
      schema_version: 1,
      contractId,
      observedActivityAt: 1000,
      attempts: 1,
      lastAttemptAt: 5000,
      delivery: { id: deliveryId, attempt: 1, scheduledAt: 5000, body: 'reminder body', kind: 'pending' },
    }));
  }

  function makeLoop(messages: InboxMessage[], opts: { withRecoveryDeps?: boolean } = {}) {
    const audit = createMockAudit();
    const entries = messages.map((message, i) => ({
      message,
      handle: `handle-${i}` as InboxHandle,
    }));
    let prepareCalls = 0;
    const formatPreparedInbox = vi.fn().mockImplementation(async (batch: { entries: Array<{ message: InboxMessage }> }) => ({
      injected: batch.entries.map(e => ({ role: 'user', content: e.message.content } as Message)),
      sources: batch.entries.map(e => ({ text: e.message.content, type: e.message.type })),
      count: batch.entries.length,
      infos: batch.entries.map(e => e.message),
    }));
    const processTurn = vi.fn().mockResolvedValue(makeTurnResult('success'));
    const ackHandles = vi.fn().mockResolvedValue(undefined);
    const nackHandles = vi.fn().mockResolvedValue(undefined);

    const runtime = {
      prepareInbox: vi.fn().mockImplementation(async () => {
        prepareCalls++;
        return prepareCalls === 1 ? { entries } : { entries: [] };
      }),
      formatPreparedInbox,
      getSystemPrompt: vi.fn().mockResolvedValue('sys'),
      getToolsForLLM: vi.fn().mockReturnValue([] as ToolDefinition[]),
      getMessages: vi.fn().mockResolvedValue([] as Message[]),
      proactiveTrimIfNeeded: vi.fn().mockImplementation((m: Message[]) => m),
      processTurn,
      ackHandles,
      nackHandles,
      reactiveTrim: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn(),
      computeTurnRequestFingerprint: vi.fn().mockResolvedValue('fp'),
      peekPendingTurnFacts: vi.fn().mockResolvedValue({ addressed: [{ id: 'pending-1' } as InboxMessage], controls: [] }),
      peekPendingInterventionFacts: vi.fn().mockResolvedValue({ userIds: [] }),
      consumePendingControls: vi.fn().mockResolvedValue({ consumed: 0 }),
    } as unknown as Runtime;

    const loop = new EventLoop({
      runtime,
      fsFactory,
      agentDir,
      clawId: 'test-claw',
      audit,
      inbox: { pendingDir: inboxPendingDir, fallbackTimeoutMs: 50 },
      ...(opts.withRecoveryDeps
        ? { executionRecovery: { probeActivity: async () => ({ lastActivityAt: null }) } }
        : {}),
    });

    return { loop, audit, formatPreparedInbox, processTurn, ackHandles, nackHandles };
  }

  function mergeAudits(audit: ReturnType<typeof createMockAudit>) {
    return audit.entries.filter(e => e[0] === EVENTLOOP_AUDIT_EVENTS.EXECUTION_RECOVERY_DUPLICATE_MERGED);
  }

  function colOf(entry: [string, ...(string | number)[]], key: string): string | undefined {
    const hit = entry.find(c => String(c).startsWith(`${key}=`));
    return hit === undefined ? undefined : String(hit).slice(key.length + 1);
  }

  it('四条同契约积压：turn 只含一条（最新者），其余三条 ack 到 done + 合并审计', async () => {
    const messages = [
      recoveryMessage('old-1', 'c-1', { timestampMs: 1000 }),
      recoveryMessage('old-2', 'c-1', { timestampMs: 2000 }),
      recoveryMessage('old-3', 'c-1', { timestampMs: 3000 }),
      recoveryMessage('newest', 'c-1', { timestampMs: 4000 }),
    ];
    const { loop, audit, formatPreparedInbox, ackHandles } = makeLoop(messages);

    await loop.run();

    // turn 上下文只含一条提醒
    const formatted = formatPreparedInbox.mock.calls[0][0] as { entries: Array<{ message: InboxMessage }> };
    expect(formatted.entries.map(e => e.message.id)).toEqual(['newest']);

    // 其余三条 ack 到 done/（path=duplicate_merged），kept 那条走正常 turn-end ack
    expect(ackHandles).toHaveBeenCalledWith(['handle-0', 'handle-1', 'handle-2'], 'duplicate_merged');
    expect(ackHandles).toHaveBeenCalledWith(['handle-3'], 'normal_turn_end');

    // 合并审计：merged_id/kept_id/location 齐
    const merges = mergeAudits(audit);
    expect(merges).toHaveLength(3);
    expect(merges.map(m => colOf(m, 'merged_id')).sort()).toEqual(['old-1', 'old-2', 'old-3']);
    expect(merges.every(m => colOf(m, 'kept_id') === 'newest')).toBe(true);
    expect(merges.every(m => colOf(m, 'contract') === 'c-1' && colOf(m, 'location') === 'inflight')).toBe(true);
  });

  it('record 当前义务命中者优先（即使不是最新）', async () => {
    const obligationId = 'execution_recovery-obligation';
    seedRecoveryRecord('c-1', obligationId);
    const messages = [
      recoveryMessage('obligated', 'c-1', { timestampMs: 1000, deliveryId: obligationId }),
      recoveryMessage('newer-backlog', 'c-1', { timestampMs: 9000 }),
    ];
    const { loop, audit, formatPreparedInbox, ackHandles } = makeLoop(messages, { withRecoveryDeps: true });

    await loop.run();

    const formatted = formatPreparedInbox.mock.calls[0][0] as { entries: Array<{ message: InboxMessage }> };
    expect(formatted.entries.map(e => e.message.id)).toEqual(['obligated']);
    expect(ackHandles).toHaveBeenCalledWith(['handle-1'], 'duplicate_merged');
    const merges = mergeAudits(audit);
    expect(merges).toHaveLength(1);
    expect(colOf(merges[0], 'merged_id')).toBe('newer-backlog');
    expect(colOf(merges[0], 'kept_id')).toBe('obligated');
  });

  it('record 读取失败：FATAL 留证 + 退化为批次内规则（不阻断交付）', async () => {
    const dir = path.join(agentDir, 'event-loop', 'execution-recovery');
    require('fs').mkdirSync(dir, { recursive: true });
    require('fs').writeFileSync(path.join(dir, 'c-1.json'), '{ not valid json');
    const messages = [
      recoveryMessage('a', 'c-1', { timestampMs: 1000 }),
      recoveryMessage('b', 'c-1', { timestampMs: 2000 }),
    ];
    const { loop, audit, formatPreparedInbox } = makeLoop(messages, { withRecoveryDeps: true });

    await loop.run();

    const fatal = audit.entries.filter(e =>
      e[0] === EVENTLOOP_AUDIT_EVENTS.FATAL && e.some(c => String(c).includes('duplicateMergeRecordRead')));
    expect(fatal).toHaveLength(1);
    // 退化规则：保留最新（b），合并 a；交付照常
    const formatted = formatPreparedInbox.mock.calls[0][0] as { entries: Array<{ message: InboxMessage }> };
    expect(formatted.entries.map(e => e.message.id)).toEqual(['b']);
    expect(mergeAudits(audit)).toHaveLength(1);
  });

  it('混合批次：正常消息与不同契约/来自其他 claw 的提醒不受影响', async () => {
    const normal: InboxMessage = {
      id: 'normal-1', type: 'user_chat', from: 'user', to: '', content: 'hello',
      priority: 'normal', timestamp: new Date(1500).toISOString(),
    };
    const messages = [
      normal,
      recoveryMessage('dup-1', 'c-1', { timestampMs: 1000 }),
      recoveryMessage('dup-2', 'c-1', { timestampMs: 2000 }),
      recoveryMessage('other-contract', 'c-2', { timestampMs: 1000 }),
      recoveryMessage('other-claw', 'c-1', { from: 'claw-b', timestampMs: 1000 }),
    ];
    const { loop, audit, formatPreparedInbox, ackHandles } = makeLoop(messages);

    await loop.run();

    const formatted = formatPreparedInbox.mock.calls[0][0] as { entries: Array<{ message: InboxMessage }> };
    // 合并仅发生在 c-1 本 claw 组：保留 dup-2；其他全部照常进入 turn
    expect(formatted.entries.map(e => e.message.id).sort()).toEqual(
      ['dup-2', 'normal-1', 'other-claw', 'other-contract'],
    );
    expect(ackHandles).toHaveBeenCalledWith(['handle-1'], 'duplicate_merged');
    expect(mergeAudits(audit)).toHaveLength(1);
  });

  it('单条提醒（每组唯一）不做任何合并处置', async () => {
    const messages = [
      recoveryMessage('solo-1', 'c-1'),
      recoveryMessage('solo-2', 'c-2'),
    ];
    const { loop, audit, ackHandles } = makeLoop(messages);

    await loop.run();

    expect(ackHandles).not.toHaveBeenCalledWith(expect.anything(), 'duplicate_merged');
    expect(mergeAudits(audit)).toHaveLength(0);
  });
});
