/**
 * Phase 1869 Step G：消费适用性判定（execution_recovery × 契约终态事实）。
 *
 * 契约：
 * - prepareInbox 领取后、formatPreparedInbox 前按 readContractTerminalFact 判定；
 *   契约已终态（completed/failed/cancelled）→ 不交付：ack 到 done/（正文保留）
 *   + runtime_inbox_contract_terminal 审计（reason=contract_terminal + delivery_id）；
 * - 混合批次逐条判定，正常消息不受影响；全过期批次 prepare 返回空（不进入 turn）；
 * - 查询失败 → fail-open 照常交付 + runtime_inbox_terminal_query_failed 留证；
 * - 非 execution_recovery / 无 contract_id / 未注入 capability → 不调查询、照常交付；
 * - 判定与 ack 间崩溃 → 消息留 inflight → reconcile 回 pending → 重启重判（幂等）；
 * - 消费者侧常量与 event-loop owner 常量相等（drift 即红）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Runtime } from '../../../src/core/runtime/runtime.js';
import {
  createInboxReader,
  writeInboxAsync,
} from '../../../src/foundation/messaging/index.js';
import { createInboxMessageTypeRegistry } from '../../../src/foundation/messaging/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { RUNTIME_AUDIT_EVENTS } from '../../../src/core/runtime/runtime-audit-events.js';
import {
  EXECUTION_RECOVERY_MESSAGE_TYPE,
  EXECUTION_RECOVERY_DELIVERY_META_KEY,
} from '../../../src/core/runtime/inbox-message-types.js';
import {
  EXECUTION_RECOVERY_MESSAGE_TYPE as EVENTLOOP_MESSAGE_TYPE,
  EXECUTION_RECOVERY_DELIVERY_META_KEY as EVENTLOOP_DELIVERY_META_KEY,
} from '../../../src/core/event-loop/constants.js';
import type { ContractTerminalFact } from '../../../src/core/contract/index.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';

class TestRuntime extends Runtime {
  injectForTest(opts: { inboxReader: unknown; auditWriter: unknown }) {
    (this as unknown as Record<string, unknown>).inboxReader = opts.inboxReader;
    (this as unknown as Record<string, unknown>).auditWriter = opts.auditWriter;
    // ack/nack 失败分支直读 execContext.trace_id（生产 initialize 建）；测试直调需补位。
    (this as unknown as Record<string, unknown>).execContext = { trace_id: undefined };
  }
  async testPrepareInbox() {
    return this.prepareInbox();
  }
}

function createMockAudit() {
  const entries: [string, ...unknown[]][] = [];
  return {
    entries,
    write: (type: string, ...cols: unknown[]) => { entries.push([type, ...cols]); },
    preview: (s: string) => s,
    message: (s: string) => s,
    summary: (s: string) => s,
  };
}

describe('phase 1869 Step G: 消费适用性判定', () => {
  let rootDir: string;
  let inboxBaseDir: string;
  let pendingDir: string;
  let doneDir: string;
  let fsImpl: NodeFileSystem;
  let audit: ReturnType<typeof createMockAudit>;
  let factQuery: ReturnType<typeof vi.fn<(contractId: string) => Promise<ContractTerminalFact>>>;

  beforeEach(async () => {
    rootDir = await createTempDir();
    inboxBaseDir = path.join(rootDir, 'inbox');
    pendingDir = path.join(inboxBaseDir, 'pending');
    doneDir = path.join(inboxBaseDir, 'done');
    fsImpl = new NodeFileSystem({ baseDir: rootDir });
    await fsImpl.ensureDir(pendingDir);
    await fsImpl.ensureDir(doneDir);
    audit = createMockAudit();
    factQuery = vi.fn<(contractId: string) => Promise<ContractTerminalFact>>()
      .mockResolvedValue({ kind: 'unconfirmed' });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(rootDir);
  });

  function makeRuntime(opts: { injectFactQuery?: boolean } = {}): TestRuntime {
    const runtime = new TestRuntime({
      clawId: 'test-claw',
      clawDir: rootDir,
      idleTimeoutMs: 0,
      llmConfig: {
        primary: { name: 'mock', apiKey: 'k', model: 'm', apiFormat: 'anthropic' as const },
        maxAttempts: 1,
        retryDelayMs: 0,
      },
      dependencies: {
        ...(opts.injectFactQuery !== false ? { contractTerminalFact: factQuery } : {}),
        formatterRegistry: createInboxMessageTypeRegistry(),
      },
    } as never);
    const reader = createInboxReader(fsImpl, audit, inboxBaseDir);
    runtime.injectForTest({ inboxReader: reader, auditWriter: audit });
    return runtime;
  }

  async function writeRecovery(id: string, contractId: string, deliveryId?: string): Promise<void> {
    await writeInboxAsync(fsImpl, pendingDir, {
      id,
      type: EXECUTION_RECOVERY_MESSAGE_TYPE,
      from: 'test-claw',
      to: '',
      priority: 'high',
      content: `reminder ${id}`,
      timestamp: new Date().toISOString(),
      metadata: {
        contract_id: contractId,
        ...(deliveryId ? { [EXECUTION_RECOVERY_DELIVERY_META_KEY]: deliveryId } : {}),
      },
    }, audit);
  }

  async function writeNormal(id: string): Promise<void> {
    await writeInboxAsync(fsImpl, pendingDir, {
      id,
      type: 'user_chat',
      from: 'user',
      to: '',
      priority: 'normal',
      content: `hello ${id}`,
      timestamp: new Date().toISOString(),
    }, audit);
  }

  function rows(type: string) {
    return audit.entries.filter(e => e[0] === type);
  }

  function doneFiles(): string[] {
    return fs.readdirSync(doneDir).filter(f => f.endsWith('.md'));
  }

  it('常量锁定：消费者侧 type / meta key 与 event-loop owner 相等', () => {
    expect(EXECUTION_RECOVERY_MESSAGE_TYPE).toBe(EVENTLOOP_MESSAGE_TYPE);
    expect(EXECUTION_RECOVERY_DELIVERY_META_KEY).toBe(EVENTLOOP_DELIVERY_META_KEY);
  });

  it('契约终态：不交付（ack 到 done/）+ runtime_inbox_contract_terminal 留证', async () => {
    factQuery.mockResolvedValue({ kind: 'terminal', state: 'completed' });
    await writeRecovery('r-1', 'c-1', 'execution_recovery-d1');
    const runtime = makeRuntime();

    const prepared = await runtime.testPrepareInbox();

    expect(prepared.entries).toHaveLength(0);
    expect(doneFiles()).toHaveLength(1);
    const skipRows = rows(RUNTIME_AUDIT_EVENTS.INBOX_CONTRACT_TERMINAL);
    expect(skipRows).toHaveLength(1);
    const row = skipRows[0].map(String);
    expect(row.some(c => c === 'reason=contract_terminal')).toBe(true);
    expect(row.some(c => c === 'contract=c-1')).toBe(true);
    expect(row.some(c => c === 'state=completed')).toBe(true);
    expect(row.some(c => c === 'delivery_id=execution_recovery-d1')).toBe(true);
  });

  it('混合批次：终态提醒被跳过、正常消息照常交付', async () => {
    factQuery.mockResolvedValue({ kind: 'terminal', state: 'failed' });
    await writeRecovery('r-1', 'c-1');
    await writeNormal('n-1');
    const runtime = makeRuntime();

    const prepared = await runtime.testPrepareInbox();

    expect(prepared.entries.map(e => e.message.id)).toEqual(['n-1']);
    expect(doneFiles()).toHaveLength(1);  // 只有被跳过的提醒
    expect(rows(RUNTIME_AUDIT_EVENTS.INBOX_CONTRACT_TERMINAL)).toHaveLength(1);
  });

  it('全过期批次：prepare 返回空（不进入 turn）', async () => {
    factQuery.mockResolvedValue({ kind: 'terminal', state: 'cancelled' });
    await writeRecovery('r-1', 'c-1');
    await writeRecovery('r-2', 'c-1');
    const runtime = makeRuntime();

    const prepared = await runtime.testPrepareInbox();

    expect(prepared.entries).toHaveLength(0);
    expect(doneFiles()).toHaveLength(2);
    expect(rows(RUNTIME_AUDIT_EVENTS.INBOX_CONTRACT_TERMINAL)).toHaveLength(2);
  });

  it('unconfirmed：照常交付（活动期提醒零漂移）', async () => {
    factQuery.mockResolvedValue({ kind: 'unconfirmed' });
    await writeRecovery('r-1', 'c-1');
    const runtime = makeRuntime();

    const prepared = await runtime.testPrepareInbox();

    expect(prepared.entries.map(e => e.message.id)).toEqual(['r-1']);
    expect(doneFiles()).toHaveLength(0);
    expect(rows(RUNTIME_AUDIT_EVENTS.INBOX_CONTRACT_TERMINAL)).toHaveLength(0);
  });

  it('查询失败：fail-open 照常交付 + terminal_query_failed 留证', async () => {
    factQuery.mockRejectedValue(new Error('EIO stat'));
    await writeRecovery('r-1', 'c-1');
    const runtime = makeRuntime();

    const prepared = await runtime.testPrepareInbox();

    expect(prepared.entries.map(e => e.message.id)).toEqual(['r-1']);
    const failRows = rows(RUNTIME_AUDIT_EVENTS.INBOX_TERMINAL_QUERY_FAILED);
    expect(failRows).toHaveLength(1);
    expect(failRows[0].map(String).some(c => c.includes('EIO stat'))).toBe(true);
    expect(doneFiles()).toHaveLength(0);
  });

  it('非 execution_recovery / 无 contract_id：不调查询、照常交付', async () => {
    await writeNormal('n-1');
    await writeRecovery('r-no-contract', '');  // 空 contract_id
    const runtime = makeRuntime();

    const prepared = await runtime.testPrepareInbox();

    expect(prepared.entries.map(e => e.message.id).sort()).toEqual(['n-1', 'r-no-contract']);
    expect(factQuery).not.toHaveBeenCalled();
  });

  it('未注入 capability：判定面关闭、照常交付', async () => {
    await writeRecovery('r-1', 'c-1');
    const runtime = makeRuntime({ injectFactQuery: false });

    const prepared = await runtime.testPrepareInbox();

    expect(prepared.entries.map(e => e.message.id)).toEqual(['r-1']);
  });

  it('判定与 ack 间中断：消息留 inflight → reconcile 回 pending → 重启重判（幂等）', async () => {
    factQuery.mockResolvedValue({ kind: 'terminal', state: 'completed' });
    await writeRecovery('r-1', 'c-1', 'execution_recovery-d1');

    // 注入 ack 移动失败（done/ 目标）——模拟判定后、ack 前中断
    const realMove = fsImpl.move.bind(fsImpl);
    const moveSpy = vi.spyOn(fsImpl, 'move').mockImplementation(async (src: string, dst: string) => {
      if (String(dst).includes('/done/')) throw Object.assign(new Error('EIO move'), { code: 'EIO' });
      return realMove(src, dst);
    });

    const runtime1 = makeRuntime();
    const prepared1 = await runtime1.testPrepareInbox();
    expect(prepared1.entries).toHaveLength(0);          // 未交付
    expect(doneFiles()).toHaveLength(0);                 // ack 未完成
    expect(rows(RUNTIME_AUDIT_EVENTS.INBOX_CONTRACT_TERMINAL)).toHaveLength(1);
    moveSpy.mockRestore();

    // 模拟崩死进程的残留：inflight 改名 startTime=0 claim + mtime 回溯过期
    // （phase 930 租约语义：活进程 inflight 不回队；过期租约才回收）。
    const inflightDir = path.join(inboxBaseDir, 'inflight');
    const inflightFiles = fs.readdirSync(inflightDir).filter(f => f.endsWith('.md'));
    expect(inflightFiles).toHaveLength(1);
    const originalName = inflightFiles[0].replace(/^\d+_[0-9a-f]+_/i, '');
    const stalePath = path.join(inflightDir, `${process.pid}_0_${originalName}`);
    fs.renameSync(path.join(inflightDir, inflightFiles[0]), stalePath);
    const oldMtime = new Date(Date.now() - 6 * 60 * 1000);
    fs.utimesSync(stalePath, oldMtime, oldMtime);

    // 重启：init reconcile 把过期 inflight 残留回 pending → 重新判定并处置
    const reader2 = createInboxReader(fsImpl, audit, inboxBaseDir);
    await reader2.init();
    const runtime2 = makeRuntime();
    runtime2.injectForTest({ inboxReader: reader2, auditWriter: audit });
    const prepared2 = await runtime2.testPrepareInbox();

    expect(prepared2.entries).toHaveLength(0);
    expect(doneFiles()).toHaveLength(1);                 // 本次 ack 成功
    // 幂等重判：第二次判定再留一条证据行，无重复交付/无消息丢失
    expect(rows(RUNTIME_AUDIT_EVENTS.INBOX_CONTRACT_TERMINAL)).toHaveLength(2);
  });
});
