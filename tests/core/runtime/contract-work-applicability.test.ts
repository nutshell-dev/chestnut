/**
 * Phase 2094 Step C：排队工作指令终态过滤矩阵。
 *
 * 契约（扩展 phase 1869 判定面，不新开判定即不新开路径）：
 * - 候选 ID 选择：execution_recovery 仍取 metadata.contract_id；
 *   contract_created / contract_resume（且 from=system）经 owner 侧
 *   getContractWorkMessageId 取 metadata.contract_id；其余一律不判定；
 * - 终态（completed / failed / cancelled）→ 不交付：ack 到 done/（正文保留）
 *   + runtime_inbox_contract_terminal 留证（reason=contract_terminal）；
 * - 真实终态 = { kind: 'terminal', state } 且 state ∈ {completed, cancelled, corrupted, failed}
 *   （ARCHIVE_STATE_DIRS_TUPLE），corrupted 同样必须过滤；
 * - unconfirmed / 非法 kind（owner 不产生的防御分支） / 查询抛错 → fail-open 照常交付；
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
  decodeInbox,
  createInboxMessageTypeRegistry,
} from '../../../src/foundation/messaging/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { RUNTIME_AUDIT_EVENTS } from '../../../src/core/runtime/runtime-audit-events.js';
import {
  EXECUTION_RECOVERY_MESSAGE_TYPE,
  EXECUTION_RECOVERY_DELIVERY_META_KEY,
} from '../../../src/core/runtime/inbox-message-types.js';
import { makeContractId, readContractTerminalFact } from '../../../src/core/contract/index.js';
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

  function makeRuntime(overrides?: {
    contractTerminalFact?: (contractId: string) => Promise<ContractTerminalFact>;
  }): TestRuntime {
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
        contractTerminalFact: overrides?.contractTerminalFact ?? factQuery,
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

  it('矩阵：created/resume × cancelled/completed/failed/corrupted 全部过滤，各留一条终态证据', async () => {
    // phase 2094 Step R：corrupted 是 ArchiveState 的合法成员，事实形态为
    // { kind: 'terminal', state: 'corrupted' } —— 必须与其余终态一样被过滤。
    const states = ['cancelled', 'completed', 'failed', 'corrupted'] as const;
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
      state: cid.replace('c-', '') as 'cancelled' | 'completed' | 'failed' | 'corrupted',
    }));

    const runtime = makeRuntime();
    const prepared = await runtime.testPrepareInbox();

    expect(prepared.entries).toHaveLength(0);
    expect(doneFiles()).toHaveLength(8);
    expect(rows(RUNTIME_AUDIT_EVENTS.INBOX_CONTRACT_TERMINAL)).toHaveLength(8);
    const rowTexts = rows(RUNTIME_AUDIT_EVENTS.INBOX_CONTRACT_TERMINAL).map(r => r.map(String).join(' '));
    for (const state of states) {
      expect(rowTexts.some(t => t.includes(`state=${state}`))).toBe(true);
    }
    expect(rowTexts.every(t => t.includes('reason=contract_terminal'))).toBe(true);
    // corrupted 走与 cancelled/completed/failed 完全相同的过滤路径（不留特例）
    expect(rowTexts.filter(t => t.includes('state=corrupted'))).toHaveLength(2);
    // 正文保留：done/ 里仍有原 content
    for (const f of doneFiles()) {
      const raw = fs.readFileSync(path.join(doneDir, f), 'utf8');
      expect(raw).toContain('work w-');
    }
  });

  it('非法查询结果防御：kind 非 terminal/unconfirmed（owner 不产生的形态）照常交付且不 ack', async () => {
    // 说明（phase 2094 Step R 纠正）：{ kind: 'corrupted' } 不是 corrupted 语义——
    // corrupted 的真实形态是 { kind: 'terminal', state: 'corrupted' }，已在上方终态矩阵覆盖。
    // 本用例只防御 owner 永不产生的非法联合成员，不承担 corrupted 语义。
    const cases: Array<[string, ContractTerminalFact]> = [
      ['c-illegal', { kind: 'something-else' } as never],
      ['c-unconfirmed', { kind: 'unconfirmed' }],
    ];
    for (const [i, [cid]] of cases.entries()) {
      await writeMsg({ id: `w-${i}`, type: 'contract_created', contractId: cid });
    }
    factQuery.mockImplementation(async (cid: string) => cases.find(([c]) => c === cid)![1]);

    const runtime = makeRuntime();
    const prepared = await runtime.testPrepareInbox();

    expect(prepared.entries.map(e => e.message.id)).toEqual(['w-0', 'w-1']);
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
    // 句柄归属（可观测核证）：ack 成功即从 ownedHandles 释放——若仍持有，
    // prepareInbox 的 catch 会把它 nack 回 pending；实测它停在 inflight/ 且零 NACK 审计。
    expect(fs.readdirSync(pendingDir).filter(f => f.endsWith('.md'))).toHaveLength(0);
    expect(rows(RUNTIME_AUDIT_EVENTS.INBOX_NACK_FAILED)).toHaveLength(0);
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

  /* ==================================================================
   * phase 2094 Step R：句柄与恢复矩阵（计划 §设计细节「句柄与恢复矩阵」）
   * ================================================================== */

  it('恢复①：ack→done move 失败后 inflight 保留；恢复 FS + 过期 claim 重启重领 → 真实终态查询落到 done', async () => {
    // phase 2094 Step R2: 去掉 mock 终态查询，改走真实 readContractTerminalFact
    // （复用 contract-work-real-chain.test.ts 同款真实查询入口；此处落一个真实 archive/completed 目录）
    const realFact = (contractId: string) => readContractTerminalFact(fsImpl, contractId);
    await fsImpl.ensureDir(path.join(rootDir, 'contract', 'archive', 'completed', 'c-1'));

    await writeMsg({ id: 'w-recover', type: 'contract_created', contractId: 'c-1' });

    const runtime = makeRuntime({ contractTerminalFact: realFact });
    const realMove = fsImpl.move.bind(fsImpl);
    const moveSpy = vi.spyOn(fsImpl, 'move').mockImplementation(async (src: string, dst: string) => {
      if (String(dst).includes('/done/')) throw Object.assign(new Error('EIO move'), { code: 'EIO' });
      return realMove(src, dst);
    });
    const prepared1 = await runtime.testPrepareInbox();
    moveSpy.mockRestore();

    // 本轮不交付、原消息留在 inflight、失败留证
    expect(prepared1.entries).toHaveLength(0);
    expect(doneFiles()).toHaveLength(0);
    expect(inflightFiles()).toHaveLength(1);
    expect(rows(RUNTIME_AUDIT_EVENTS.INBOX_ACK_FAILED)).toHaveLength(1);

    // 模拟进程崩死后的残留：claim 改为 startTime=0（身份不可确立）+ mtime 回溯过期租约
    const inflightDir = path.join(inboxBaseDir, 'inflight');
    const inflightName = inflightFiles()[0];
    const originalName = inflightName.replace(/^\d+_[0-9a-f]+_/i, '');
    const stalePath = path.join(inflightDir, `${process.pid}_0_${originalName}`);
    fs.renameSync(path.join(inflightDir, inflightName), stalePath);
    const oldMtime = new Date(Date.now() - 6 * 60 * 1000);
    fs.utimesSync(stalePath, oldMtime, oldMtime);

    // 重启：init reconcile 把过期 inflight 残留回 pending → 重新领取 → 再次真实判定 → ack 到 done
    const reader2 = createInboxReader(fsImpl, audit, inboxBaseDir);
    await reader2.init();
    const runtime2 = makeRuntime({ contractTerminalFact: realFact });
    runtime2.injectForTest({ inboxReader: reader2, auditWriter: audit });
    const prepared2 = await runtime2.testPrepareInbox();

    expect(prepared2.entries).toHaveLength(0);
    expect(doneFiles()).toHaveLength(1);
    // 幂等重判：再次留证，无重复交付、无消息丢失
    expect(rows(RUNTIME_AUDIT_EVENTS.INBOX_CONTRACT_TERMINAL)).toHaveLength(2);
    // 重启后重领→过滤→ack 全链走完，同样无悬挂句柄（零 NACK、pending 空）
    expect(rows(RUNTIME_AUDIT_EVENTS.INBOX_NACK_FAILED)).toHaveLength(0);
    expect(fs.readdirSync(pendingDir).filter(f => f.endsWith('.md'))).toHaveLength(0);
    const decodedDone = decodeInbox(fs.readFileSync(path.join(doneDir, doneFiles()[0]), 'utf8'));
    expect(decodedDone.id).toBe('w-recover');
    expect(decodedDone.content).toBe('work w-recover');
  }, 30_000);

  it('恢复②：首次 unconfirmed 交付后 nack 回 pending；状态转终态后第二次 prepare 必须重新查询并过滤', async () => {
    // 第一次查询 unconfirmed，第二次起 terminal —— 若实现缓存了上次结果，第二次会误交付
    factQuery
      .mockResolvedValueOnce({ kind: 'unconfirmed' })
      .mockResolvedValue({ kind: 'terminal', state: 'cancelled' });
    await writeMsg({ id: 'w-requery', type: 'contract_created', contractId: 'c-1' });

    const runtime = makeRuntime();
    const prepared1 = await runtime.testPrepareInbox();
    expect(prepared1.entries.map(e => e.message.id)).toEqual(['w-requery']);
    expect(factQuery).toHaveBeenCalledTimes(1);

    // 未处理句柄用 nack 归还原 pending（不删除、不重建消息）
    await runtime.nackHandles(
      prepared1.entries.map(e => e.handle),
      'test_requeue',
      'test_requeue',
    );
    const pendingAfterNack = fs.readdirSync(pendingDir).filter(f => f.endsWith('.md'));
    expect(pendingAfterNack).toHaveLength(1);
    // 归还的是同一条消息（内容未改写）
    const requeued = decodeInbox(fs.readFileSync(path.join(pendingDir, pendingAfterNack[0]), 'utf8'));
    expect(requeued.id).toBe('w-requery');
    expect(requeued.content).toBe('work w-requery');

    // 第二次 prepare：必须重新查询（次数 +1），拿到 terminal 后过滤
    const runtime2 = makeRuntime();
    const prepared2 = await runtime2.testPrepareInbox();
    expect(factQuery).toHaveBeenCalledTimes(2);
    expect(prepared2.entries).toHaveLength(0);
    expect(doneFiles()).toHaveLength(1);
    expect(rows(RUNTIME_AUDIT_EVENTS.INBOX_CONTRACT_TERMINAL)).toHaveLength(1);
  }, 30_000);

  it('恢复③：前项已 ack 到 done 后，后项查询失败且错误审计抛出 → 整体 catch 只回队后项，不 nack 已处置前项', async () => {
    factQuery.mockImplementation(async (cid: string) => {
      if (cid === 'c-term') return { kind: 'terminal', state: 'failed' };
      throw new Error('EIO query boom');
    });
    await writeMsg({ id: 'w-first', type: 'contract_created', contractId: 'c-term' });
    await writeMsg({ id: 'w-second', type: 'contract_resume', contractId: 'c-fail' });

    const runtime = makeRuntime();
    const reader = (runtime as unknown as { inboxReader: { nack: (h: unknown, r: string) => Promise<void> } }).inboxReader;
    const nackSpy = vi.spyOn(reader, 'nack');

    // 让「查询失败」审计本身抛出，触发 prepareInbox 的整体 catch
    const realWrite = audit.write;
    const auditSpy = vi.spyOn(audit, 'write').mockImplementation((type: string, ...cols: unknown[]) => {
      if (type === RUNTIME_AUDIT_EVENTS.INBOX_TERMINAL_QUERY_FAILED) {
        throw Object.assign(new Error('audit sink down'), { code: 'EIO' });
      }
      return realWrite(type, ...cols);
    });

    await expect(runtime.testPrepareInbox()).rejects.toThrow(/audit sink down/);
    auditSpy.mockRestore();

    // 前项已 ack：在 done/，且从未被 nack（句柄已结算、已从 ownedHandles 移除）
    const doneNames = doneFiles();
    expect(doneNames).toHaveLength(1);
    const decodedDone = decodeInbox(fs.readFileSync(path.join(doneDir, doneNames[0]), 'utf8'));
    expect(decodedDone.id).toBe('w-first');
    const nackedFiles = nackSpy.mock.calls.map(c => String((c[0] as { originalFileName?: string })?.originalFileName ?? ''));
    expect(nackedFiles.some(f => f.includes('w-first'))).toBe(false);

    // 后项仍被持有的句柄回队：pending 里有 w-second，无 w-first
    const pendingNames = fs.readdirSync(pendingDir).filter(f => f.endsWith('.md'));
    const pendingIds = pendingNames.map(f => decodeInbox(fs.readFileSync(path.join(pendingDir, f), 'utf8')).id);
    expect(pendingIds).toEqual(['w-second']);
    expect(nackedFiles.length).toBeGreaterThan(0);
    nackSpy.mockRestore();
  }, 30_000);

  it('恢复④：坏路径 contract_id 被真实 owner 查询拒绝 → query_failed 且仍交付；工作消息不输出恢复专用 delivery_id 列', async () => {
    // 真实 owner 查询（1846）：非单目录名在 stat 前就被拒绝
    const realQuery = (cid: string) => readContractTerminalFact(fsImpl, makeContractId(cid));
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
        contractTerminalFact: realQuery,
        formatterRegistry: createInboxMessageTypeRegistry(),
      },
    } as never);
    const reader = createInboxReader(fsImpl, audit, inboxBaseDir);
    runtime.injectForTest({ inboxReader: reader, auditWriter: audit });

    // 坏路径 id + 恢复专用 delivery_id 键（工作消息不该输出该列）
    await writeInboxAsync(fsImpl, pendingDir, {
      id: 'w-badid',
      type: 'contract_created',
      from: 'system',
      to: '',
      priority: 'normal',
      content: 'work w-badid',
      timestamp: new Date().toISOString(),
      metadata: { contract_id: '../escape', [EXECUTION_RECOVERY_DELIVERY_META_KEY]: 'rec-bad' },
    }, audit);

    const prepared = await runtime.testPrepareInbox();

    // 查询被拒 → fail-open 交付，留 query_failed 证据
    expect(prepared.entries.map(e => e.message.id)).toEqual(['w-badid']);
    expect(doneFiles()).toHaveLength(0);
    const failedRows = rows(RUNTIME_AUDIT_EVENTS.INBOX_TERMINAL_QUERY_FAILED);
    expect(failedRows).toHaveLength(1);
    const failedText = failedRows[0].map(String).join(' ');
    expect(failedText).toContain('contract=../escape');
    expect(failedText).toContain('not a single directory name');
    expect(rows(RUNTIME_AUDIT_EVENTS.INBOX_CONTRACT_TERMINAL)).toHaveLength(0);
  }, 30_000);

  it('恢复④b：工作消息命中终态时不输出 delivery_id 列，execution_recovery 同目录消息仍输出（列语义按来源区分）', async () => {
    factQuery.mockResolvedValue({ kind: 'terminal', state: 'cancelled' });
    await writeInboxAsync(fsImpl, pendingDir, {
      id: 'w-work',
      type: 'contract_created',
      from: 'system',
      to: '',
      priority: 'normal',
      content: 'work w-work',
      timestamp: new Date().toISOString(),
      metadata: { contract_id: 'c-1', [EXECUTION_RECOVERY_DELIVERY_META_KEY]: 'rec-work' },
    }, audit);
    await writeInboxAsync(fsImpl, pendingDir, {
      id: 'w-recovery',
      type: EXECUTION_RECOVERY_MESSAGE_TYPE,
      from: 'test-claw',
      to: '',
      priority: 'normal',
      content: 'recovery w-recovery',
      timestamp: new Date().toISOString(),
      metadata: { contract_id: 'c-1', [EXECUTION_RECOVERY_DELIVERY_META_KEY]: 'rec-recovery' },
    }, audit);

    const runtime = makeRuntime();
    const prepared = await runtime.testPrepareInbox();

    expect(prepared.entries).toHaveLength(0);
    const terminalRows = rows(RUNTIME_AUDIT_EVENTS.INBOX_CONTRACT_TERMINAL).map(r => r.map(String).join(' '));
    expect(terminalRows).toHaveLength(2);
    // 工作消息行：无 delivery_id 列
    const workRowMatch = terminalRows.find(t => t.includes('rec-work'));
    expect(workRowMatch).toBeUndefined();
    // execution_recovery 行：保留 delivery_id 列
    expect(terminalRows.some(t => t.includes('delivery_id=rec-recovery'))).toBe(true);
  }, 30_000);
});
