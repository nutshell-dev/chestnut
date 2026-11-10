/**
 * Phase 2094 Step C：真实 CLI 契约创建 / 取消链 → 交付前边界（不跑 provider）。
 *
 * 本用例用**真实**生产件，不 mock 业务语义：
 * - 真实 `ContractSystem`（CLI contract create/cancel 的同一 core，真实 NodeFileSystem
 *   落盘 archive/cancelled/<id>）；
 * - 真实 `readContractTerminalFact`（1846 目录即生命周期权威的只读查询）；
 * - 真实 Messaging `createInboxReader` + `writeInboxAsync` + `decodeInbox`；
 * - 真实 `Runtime.prepareInbox` 交付前边界。
 *
 * 断言只覆盖「系统控制的交付前边界」：已取消契约的排队工作指令不进入本轮批次、
 * 原消息保留在 done/ 且可解码比对 id/type/content/contract_id；取消通知（终态事件、
 * 非工作指令）照常交付。**不固定随机文件名**——一律从磁盘实际文件名解码比对。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Runtime } from '../../../src/core/runtime/runtime.js';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { readContractTerminalFact, makeContractId } from '../../../src/core/contract/index.js';
import {
  createInboxReader,
  writeInboxAsync,
  decodeInbox,
  createInboxMessageTypeRegistry,
} from '../../../src/foundation/messaging/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { RUNTIME_AUDIT_EVENTS } from '../../../src/core/runtime/runtime-audit-events.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeContractYaml } from '../../helpers/contract-yaml.js';
import { makeAudit } from '../../helpers/audit.js';

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

describe('phase 2094 Step C: 真实创建/取消链的交付前边界', () => {
  let rootDir: string;
  let inboxBaseDir: string;
  let pendingDir: string;
  let doneDir: string;
  let fsImpl: NodeFileSystem;
  let audit: ReturnType<typeof makeAudit>['audit'];
  let events: ReturnType<typeof makeAudit>['events'];

  beforeEach(async () => {
    rootDir = await createTempDir();
    inboxBaseDir = path.join(rootDir, 'inbox');
    pendingDir = path.join(inboxBaseDir, 'pending');
    doneDir = path.join(inboxBaseDir, 'done');
    fsImpl = new NodeFileSystem({ baseDir: rootDir });
    await fsImpl.ensureDir(pendingDir);
    await fsImpl.ensureDir(doneDir);
    const made = makeAudit();
    audit = made.audit;
    events = made.events;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(rootDir);
  });

  function makeSystem(): ContractSystem {
    return new ContractSystem({
      clawDir: rootDir,
      clawId: 'test-motion',
      fs: fsImpl,
      audit,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      clawsDir: path.join(rootDir, 'claws'),
      deliverCancellation: async () => {},
      notifyClaw: vi.fn(),
    } as never);
  }

  function makeRuntime(): TestRuntime {
    const runtime = new TestRuntime({
      clawId: 'test-motion',
      clawDir: rootDir,
      idleTimeoutMs: 0,
      llmConfig: {
        primary: { name: 'mock', apiKey: 'k', model: 'm', apiFormat: 'anthropic' as const },
        maxAttempts: 1,
        retryDelayMs: 0,
      },
      dependencies: {
        // 真实 1846 查询（目录为权威），不是 mock
        contractTerminalFact: (contractId: string) =>
          readContractTerminalFact(fsImpl, makeContractId(contractId)),
        formatterRegistry: createInboxMessageTypeRegistry(),
      },
    } as never);
    const reader = createInboxReader(fsImpl, audit, inboxBaseDir);
    runtime.injectForTest({ inboxReader: reader, auditWriter: audit });
    return runtime;
  }

  it('已取消契约：排队工作指令不进批次、落 done/ 可解码；取消通知照常交付', async () => {
    const system = makeSystem();
    const contractId = await system.create({ contract: makeContractYaml({ title: 'Chain contract' }) });
    expect(typeof contractId).toBe('string');

    // 真实取消（CLI contract cancel 的同一 core 路径）
    const outcome = await system.cancel(makeContractId(contractId), 'test cancel for phase 2094');
    expect(outcome.commit.kind).toBe('committed');

    // 终态事实由真实目录给出
    const fact = await readContractTerminalFact(fsImpl, makeContractId(contractId));
    expect(fact).toEqual({ kind: 'terminal', state: 'cancelled' });

    // 真实写入两条真实消息：工作指令（created）与取消通知（终态事件）
    const createdContent = `合同「Chain contract」已创建（id: ${contractId}），请开始执行。`;
    await writeInboxAsync(fsImpl, pendingDir, {
      id: 'w-created-1',
      type: 'contract_created',
      from: 'system',
      to: '',
      priority: 'high',
      content: createdContent,
      timestamp: new Date().toISOString(),
      metadata: { contract_id: contractId },
    }, audit);
    const cancelContent = `合同 ${contractId} 已取消（reason: test cancel for phase 2094）。`;
    await writeInboxAsync(fsImpl, pendingDir, {
      id: 'w-cancelled-1',
      type: 'contract_cancelled',
      from: 'system',
      to: '',
      priority: 'high',
      content: cancelContent,
      timestamp: new Date().toISOString(),
      metadata: { contract_id: contractId },
    }, audit);

    const runtime = makeRuntime();
    const prepared = await runtime.testPrepareInbox();

    // 只有取消通知进入本轮批次；工作指令被过滤
    expect(prepared.entries.map(e => e.message.id)).toEqual(['w-cancelled-1']);

    // done/ 里恰是那条工作指令：不固定文件名，解码后逐字段比对
    const doneFiles = fs.readdirSync(doneDir).filter(f => f.endsWith('.md'));
    expect(doneFiles).toHaveLength(1);
    const decodedDone = decodeInbox(fs.readFileSync(path.join(doneDir, doneFiles[0]), 'utf8'));
    expect(decodedDone.id).toBe('w-created-1');
    expect(decodedDone.type).toBe('contract_created');
    expect(decodedDone.from).toBe('system');
    expect(decodedDone.content).toBe(createdContent);
    expect(decodedDone.metadata?.contract_id).toBe(contractId);

    // 取消通知仍在 inflight（待交付），内容未被改写
    const inflightDir = path.join(inboxBaseDir, 'inflight');
    const inflightFiles = fs.readdirSync(inflightDir).filter(f => f.endsWith('.md'));
    expect(inflightFiles).toHaveLength(1);
    const decodedInflight = decodeInbox(
      fs.readFileSync(path.join(inflightDir, inflightFiles[0]), 'utf8'),
    );
    expect(decodedInflight.id).toBe('w-cancelled-1');
    expect(decodedInflight.type).toBe('contract_cancelled');
    expect(decodedInflight.metadata?.contract_id).toBe(contractId);

    // 留证：终态过滤恰一条，且指向该契约
    const terminalRows = events.filter(e => e[0] === RUNTIME_AUDIT_EVENTS.INBOX_CONTRACT_TERMINAL);
    expect(terminalRows).toHaveLength(1);
    const rowText = terminalRows[0].map(String).join(' ');
    expect(rowText).toContain(`contract=${contractId}`);
    expect(rowText).toContain('state=cancelled');
    expect(rowText).toContain('reason=contract_terminal');
  });

  it('活动契约：工作指令照常交付（过滤边界不误伤）', async () => {
    const system = makeSystem();
    const contractId = await system.create({ contract: makeContractYaml({ title: 'Active contract' }) });

    const fact = await readContractTerminalFact(fsImpl, makeContractId(contractId));
    expect(fact.kind).toBe('unconfirmed');

    await writeInboxAsync(fsImpl, pendingDir, {
      id: 'w-created-2',
      type: 'contract_created',
      from: 'system',
      to: '',
      priority: 'high',
      content: `合同「Active contract」已创建（id: ${contractId}），请开始执行。`,
      timestamp: new Date().toISOString(),
      metadata: { contract_id: contractId },
    }, audit);

    const runtime = makeRuntime();
    const prepared = await runtime.testPrepareInbox();

    expect(prepared.entries.map(e => e.message.id)).toEqual(['w-created-2']);
    expect(fs.readdirSync(doneDir).filter(f => f.endsWith('.md'))).toHaveLength(0);
    expect(events.filter(e => e[0] === RUNTIME_AUDIT_EVENTS.INBOX_CONTRACT_TERMINAL)).toHaveLength(0);
  });
});
