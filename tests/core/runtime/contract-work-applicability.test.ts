/**
 * Phase 2094 Step C：排队工作指令终态过滤矩阵。
 *
 * 契约（扩展 phase 1869 判定面，不新开判定即不新开路径）：
 * - 候选 ID 选择：execution_recovery 仍取 metadata.contract_id；
 *   contract_created / contract_resume（且 from=system）经 owner 侧
 *   getContractWorkMessageId 取 metadata.contract_id；其余一律不判定；
 * - 终态（completed / failed / cancelled）→ 不交付：ack 到 done/（正文保留）
 *   + runtime_inbox_contract_terminal 留证（reason=contract_terminal）；
 * - unconfirmed / corrupted / 未知 kind / 查询抛错 → fail-open 照常交付；
 * - 取消通知（contract_cancelled）不是工作指令：即使带 metadata.contract_id 也照常交付；
 * - 混合批次只过滤目标消息，普通用户消息与非 system 同名字段消息照常交付；
 * - ack 失败：原消息保留在 inflight、发 INBOX_ACK_FAILED，**不入本轮批次、不重新 nack**。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Runtime } from '../../../src/core/runtime/runtime.js';
import {
  createInboxReader,
  writeInboxAsync,
  createInboxMessageTypeRegistry,
} from '../../../src/foundation/messaging/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { RUNTIME_AUDIT_EVENTS } from '../../../src/core/runtime/runtime-audit-events.js';
import {
  EXECUTION_RECOVERY_MESSAGE_TYPE,
  EXECUTION_RECOVERY_DELIVERY_META_KEY,
} from '../../../src/core/runtime/inbox-message-types.js';
import type { ContractTerminalFact } from '../../../src/core/contract/index.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';

class TestRuntime extends Runtime {
  injectForTest(opts: { inboxReader: unknown; auditWriter: unknown }) {
    (this as unknown as Record<string, unknown>).inboxReader = opts.inboxReader;
    (this as unknown as Record<string, unknown>).auditWriter = opts.auditWriter;
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

describe('phase 2094 Step C: 排队工作指令终态过滤', () => {
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

  function makeRuntime(): TestRuntime {
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
        contractTerminalFact: factQuery,
        formatterRegistry: createInboxMessageTypeRegistry(),
      },
    } as never);
    const reader = createInboxReader(fsImpl, audit, inboxBaseDir);
    runtime.injectForTest({ inboxReader: reader, auditWriter: audit });
    return runtime;
  }

  async function writeMsg(opts: {
    id: string;
    type: string;
    from?: string;
    contractId?: string;
    content?: string;
  }): Promise<void> {
    await writeInboxAsync(fsImpl, pendingDir, {
      id: opts.id,
      type: opts.type,
      from: opts.from ?? 'system',
      to: '',
      priority: 'normal',
      content: opts.content ?? `work ${opts.id}`,
      timestamp: new Date().toISOString(),
      ...(opts.contractId !== undefined
        ? { metadata: { contract_id: opts.contractId } }
        : {}),
    }, audit);
  }

  function rows(type: string) {
    return audit.entries.filter(e => e[0] === type);
  }

  function doneFiles(): string[] {
    return fs.readdirSync(doneDir).filter(f => f.endsWith('.md'));
  }

  function inflightFiles(): string[] {
    const dir = path.join(inboxBaseDir, 'inflight');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => f.endsWith('.md'));
  }

  it('矩阵：created/resume × cancelled/completed/failed 全部过滤，各留一条终态证据', async () => {
    const states = ['cancelled', 'completed', 'failed'] as const;
    const types = ['contract_created', 'contract_resume'] as const;
    let n = 0;
    for (const state of states) {
      for (const type of types) {
        const id = `w-${++n}`;
        await writeMsg({ id, type, contractId: `c-${state}` });
      }
    }
    // 每个 contract 状态不同 → 用单一 factQuery 按 id 返回
    factQuery.mockImplementation(async (cid: string) => ({
      kind: 'terminal',
      state: cid.replace('c-', '') as 'cancelled' | 'completed' | 'failed',
    }));

    const runtime = makeRuntime();
    const prepared = await runtime.testPrepareInbox();

    expect(prepared.entries).toHaveLength(0);
    expect(doneFiles()).toHaveLength(6);
    expect(rows(RUNTIME_AUDIT_EVENTS.INBOX_CONTRACT_TERMINAL)).toHaveLength(6);
    const rowTexts = rows(RUNTIME_AUDIT_EVENTS.INBOX_CONTRACT_TERMINAL).map(r => r.map(String).join(' '));
    for (const state of states) {
      expect(rowTexts.some(t => t.includes(`state=${state}`))).toBe(true);
    }
    expect(rowTexts.every(t => t.includes('reason=contract_terminal'))).toBe(true);
    // 正文保留：done/ 里仍有原 content
    for (const f of doneFiles()) {
      const raw = fs.readFileSync(path.join(doneDir, f), 'utf8');
      expect(raw).toContain('work w-');
    }
  });

  it('矩阵：corrupted / unconfirmed / 未知 kind 均照常交付且不 ack', async () => {
    const cases: Array<[string, ContractTerminalFact]> = [
      ['c-corrupted', { kind: 'corrupted' } as never],
      ['c-unconfirmed', { kind: 'unconfirmed' }],
      ['c-unknown', { kind: 'something-else' } as never],
    ];
    for (const [i, [cid]] of cases.entries()) {
      await writeMsg({ id: `w-${i}`, type: 'contract_created', contractId: cid });
    }
    factQuery.mockImplementation(async (cid: string) => cases.find(([c]) => c === cid)![1]);

    const runtime = makeRuntime();
    const prepared = await runtime.testPrepareInbox();

    expect(prepared.entries.map(e => e.message.id)).toEqual(['w-0', 'w-1', 'w-2']);
    expect(doneFiles()).toHaveLength(0);
    expect(rows(RUNTIME_AUDIT_EVENTS.INBOX_CONTRACT_TERMINAL)).toHaveLength(0);
  });

  it('混合批次：只过滤终态工作指令，普通用户消息与取消通知照常交付', async () => {
    factQuery.mockImplementation(async (cid: string) =>
      cid === 'c-done' ? { kind: 'terminal', state: 'completed' } : { kind: 'unconfirmed' });

    await writeMsg({ id: 'm-created', type: 'contract_created', contractId: 'c-done' });
    await writeMsg({ id: 'm-resume', type: 'contract_resume', contractId: 'c-done' });
    await writeMsg({ id: 'm-active', type: 'contract_created', contractId: 'c-active' });
    // 取消通知：终态发布事件，不是工作指令
    await writeMsg({ id: 'm-cancel', type: 'contract_cancelled', contractId: 'c-done' });
    // 普通用户消息恰好带同名 metadata：非 system 来源，不得被当作工作指令
    await writeMsg({ id: 'm-user', type: 'user_chat', from: 'user', contractId: 'c-done' });
    // 既有 execution_recovery 行为保持
    await writeMsg({
      id: 'm-recovery',
      type: EXECUTION_RECOVERY_MESSAGE_TYPE,
      from: 'test-claw',
      contractId: 'c-done',
    });

    const runtime = makeRuntime();
    const prepared = await runtime.testPrepareInbox();

    expect(prepared.entries.map(e => e.message.id).sort()).toEqual(
      ['m-active', 'm-cancel', 'm-user'].sort(),
    );
    // 被过滤三条（created + resume + 既有 execution_recovery）进 done/；
    // 取消通知与用户消息仍在 inflight（待交付）
    expect(doneFiles()).toHaveLength(3);
    expect(rows(RUNTIME_AUDIT_EVENTS.INBOX_CONTRACT_TERMINAL)).toHaveLength(3);
  });

  it('无 ID / 空 ID / 非 system 来源：不调查询、照常交付', async () => {
    await writeMsg({ id: 'w-noid', type: 'contract_created' });
    await writeMsg({ id: 'w-empty', type: 'contract_created', contractId: '' });
    await writeMsg({ id: 'w-user', type: 'contract_created', from: 'user', contractId: 'c-1' });

    const runtime = makeRuntime();
    const prepared = await runtime.testPrepareInbox();

    expect(prepared.entries).toHaveLength(3);
    expect(factQuery).not.toHaveBeenCalled();
    expect(doneFiles()).toHaveLength(0);
  });

  it('查询抛错：fail-open 照常交付 + 查询失败留证，不 ack 不吞消息', async () => {
    factQuery.mockRejectedValue(new Error('ENOTDIR boom'));
    await writeMsg({ id: 'w-1', type: 'contract_created', contractId: 'c-1' });

    const runtime = makeRuntime();
    const prepared = await runtime.testPrepareInbox();

    expect(prepared.entries.map(e => e.message.id)).toEqual(['w-1']);
    expect(doneFiles()).toHaveLength(0);
    const failedRows = rows(RUNTIME_AUDIT_EVENTS.INBOX_TERMINAL_QUERY_FAILED);
    expect(failedRows).toHaveLength(1);
    expect(failedRows[0].map(String).some(c => c.includes('ENOTDIR boom'))).toBe(true);
  });

  it('ack 失败：原消息保留在 inflight、记录 INBOX_ACK_FAILED、不入本轮批次、不重新 nack', async () => {
    factQuery.mockResolvedValue({ kind: 'terminal', state: 'cancelled' });
    await writeMsg({ id: 'w-1', type: 'contract_created', contractId: 'c-1' });
    await writeMsg({ id: 'n-1', type: 'user_chat', from: 'user' });

    const runtime = makeRuntime();
    // 注入 done/ 目标 move 失败（与既有 execution-recovery 用例同一注入方式）
    const realMove = fsImpl.move.bind(fsImpl);
    const moveSpy = vi.spyOn(fsImpl, 'move').mockImplementation(async (src: string, dst: string) => {
      if (String(dst).includes('/done/')) throw Object.assign(new Error('EIO move boom'), { code: 'EIO' });
      return realMove(src, dst);
    });

    const prepared = await runtime.testPrepareInbox();

    // 已过滤消息不入本轮 LLM 批次；普通消息照常交付
    expect(prepared.entries.map(e => e.message.id)).toEqual(['n-1']);
    expect(doneFiles()).toHaveLength(0);                     // ack 未完成
    expect(inflightFiles()).toHaveLength(2);                 // 原消息仍在 inflight，未丢失
    expect(rows(RUNTIME_AUDIT_EVENTS.INBOX_CONTRACT_TERMINAL)).toHaveLength(1); // 判定证据已留
    expect(rows(RUNTIME_AUDIT_EVENTS.INBOX_ACK_FAILED)).toHaveLength(1);
    expect(rows(RUNTIME_AUDIT_EVENTS.INBOX_NACK_FAILED)).toHaveLength(0);       // 不重新 nack
    moveSpy.mockRestore();
  });

  it('未注入查询能力：判定面关闭，工作指令照常交付（装配兼容边界）', async () => {
    await writeMsg({ id: 'w-1', type: 'contract_created', contractId: 'c-1' });
    const runtime = new TestRuntime({
      clawId: 'test-claw',
      clawDir: rootDir,
      idleTimeoutMs: 0,
      llmConfig: {
        primary: { name: 'mock', apiKey: 'k', model: 'm', apiFormat: 'anthropic' as const },
        maxAttempts: 1,
        retryDelayMs: 0,
      },
      dependencies: { formatterRegistry: createInboxMessageTypeRegistry() },
    } as never);
    const reader = createInboxReader(fsImpl, audit, inboxBaseDir);
    runtime.injectForTest({ inboxReader: reader, auditWriter: audit });

    const prepared = await runtime.testPrepareInbox();

    expect(prepared.entries.map(e => e.message.id)).toEqual(['w-1']);
    expect(factQuery).not.toHaveBeenCalled();
  });
});
