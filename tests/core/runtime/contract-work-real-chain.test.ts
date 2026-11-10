/**
 * Phase 2094 Step C / R：真实 CLI 生产链 → 交付前边界（不跑 provider、不跑 Runtime 循环）。
 *
 * Step R 修正：创建侧改走真实 `notifyContractCreated`（createClawNotifier + 真实
 * 目标 resolver + 真实落盘），onboarding 续作侧走真实 `ensureOnboardingAndNotify`，
 * 取消侧走真实 cancellation delivery。消息全部由生产代码写出，测试只负责断言。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { makeAudit } from '../../helpers/audit.js';
import { makeContractYaml } from '../../helpers/contract-yaml.js';
import {
  ContractSystem,
  ONBOARDING_CONTRACT_ID,
  type ContractTerminalFact,
  type QueryAuditSink,
} from '../../../src/core/contract/index.js';
import { makeClawNotifyTargetResolver, MOTION_CLAW_ID } from '../../../src/core/claw-topology/index.js';
import { makeClawId, makeChestnutRoot } from '../../../src/foundation/claw-identity/index.js';
import { createClawNotifier } from '../../../src/foundation/messaging/index.js';
import { decodeInbox } from '../../../src/foundation/messaging/codec-inbox.js';
import { Runtime } from '../../../src/core/runtime/runtime.js';
import {
  createInboxReader,
  createInboxMessageTypeRegistry,
} from '../../../src/foundation/messaging/index.js';
import type { RuntimeDeps } from '../../../src/core/runtime/types.js';
import { createContractCancellationDelivery } from '../../../src/assembly/contract-cancellation-delivery.js';
import { notifyContractCreated } from '../../../src/cli/commands/contract-helpers.js';
import { ensureOnboardingAndNotify } from '../../../src/cli/start-bootstrap.js';

type Prepared = Awaited<ReturnType<Runtime['prepareInbox']>>;

interface TestRuntime {
  prepareInbox: (opts?: { messageType?: string; deliveryId?: string }) => Promise<Prepared>;
  nackHandles: (handles: Prepared['entries'][number]['handle'][], reason: string, path: string) => Promise<void>;
}

/** 与既有 applicability 测试同形的 Runtime 子类：注入 reader/auditWriter 后直接调 prepareInbox。 */
class RealChainTestRuntime extends Runtime {
  injectForTest(opts: { inboxReader: unknown; auditWriter: unknown }): void {
    (this as unknown as Record<string, unknown>).inboxReader = opts.inboxReader;
    (this as unknown as Record<string, unknown>).auditWriter = opts.auditWriter;
    (this as unknown as Record<string, unknown>).execContext = { trace_id: undefined };
  }
}

describe('phase 2094 Step C/R: 真实创建 / 取消 / 续作链 → 交付前边界', () => {
  let tempDir: string;
  let chestnutRoot: string;
  let motionDir: string;
  let clawspaceDir: string;
  let savedRoot: string | undefined;

  beforeEach(() => {
    savedRoot = process.env.CHESTNUT_ROOT;
    tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'phase2094-realchain-'));
    process.env.CHESTNUT_ROOT = tempDir;
    chestnutRoot = makeChestnutRoot(tempDir);
    motionDir = path.join(chestnutRoot, MOTION_CLAW_ID);
    clawspaceDir = path.join(chestnutRoot, 'claws', 'wjc');
    fsSync.mkdirSync(path.join(motionDir, 'inbox', 'pending'), { recursive: true });
    fsSync.mkdirSync(path.join(clawspaceDir, 'contract', 'active'), { recursive: true });
  });

  afterEach(() => {
    if (savedRoot === undefined) delete process.env.CHESTNUT_ROOT;
    else process.env.CHESTNUT_ROOT = savedRoot;
    fsSync.rmSync(tempDir, { recursive: true, force: true });
  });

  const fsFactory = (dir: string): NodeFileSystem => new NodeFileSystem({ baseDir: dir });

  /** 真实 ContractSystem（motion 侧，带真实取消投递）。 */
  function makeSystem(): ContractSystem {
    return new ContractSystem({
      clawDir: motionDir,
      clawId: makeClawId(MOTION_CLAW_ID),
      fs: fsFactory(motionDir),
      fsFactory,
      audit: makeAudit().audit,
      toolRegistry: new Map(),
      verbs: new Map(),
      rootConfig: { get: () => ({}), has: () => false } as never,
      snapshot: { schedule: () => {} } as never,
      snapshotService: undefined as never,
      clawsDir: path.join(chestnutRoot, 'claws'),
      deliverCancellation: createContractCancellationDelivery({
        clawId: MOTION_CLAW_ID,
        notifyAsync: createClawNotifier({
          fs: fsFactory(motionDir),
          audit: makeAudit().audit,
          resolveTarget: makeClawNotifyTargetResolver(chestnutRoot),
        }).notifyAsync,
      }),
    } as never);
  }

  /** 真实 owner 侧终态事实查询 + 审计 sink（与 Runtime 同一调用形态）。 */
  function makeFactQuery(): { factQuery: QueryAuditSink; sink: ReturnType<typeof makeAudit> } {
    const sink = makeAudit();
    const nodeFs = fsFactory(motionDir);
    return {
      sink,
      factQuery: async (contractId: string): Promise<ContractTerminalFact> => {
        const { readContractTerminalFact } = await import('../../../src/core/contract/terminal-fact.js');
        return readContractTerminalFact(nodeFs, contractId);
      },
    };
  }

  function makePreparer(sink: ReturnType<typeof makeAudit>, factQuery: QueryAuditSink): TestRuntime {
    const fsImpl = fsFactory(motionDir);
    const runtime = new RealChainTestRuntime({
      clawId: 'motion',
      clawDir: motionDir,
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
    const reader = createInboxReader(fsImpl, sink.audit, path.join(motionDir, 'inbox'));
    runtime.injectForTest({ inboxReader: reader, auditWriter: sink.audit });
    return runtime as unknown as TestRuntime;
  }

  function pendingNames(): string[] {
    return fsSync.readdirSync(path.join(motionDir, 'inbox', 'pending')).filter(n => n.endsWith('.md'));
  }

  function doneNames(): string[] {
    return fsSync.readdirSync(path.join(motionDir, 'inbox', 'done')).filter(n => n.endsWith('.md'));
  }

  function decodeAll(names: string[], dir: string): ReturnType<typeof decodeInbox>[] {
    return names.map(n => decodeInbox(fsSync.readFileSync(path.join(motionDir, 'inbox', dir, n), 'utf8')));
  }

  it('创建 → 取消全链：cancel 后 created 工作消息不再交付，取消通知照常交付', async () => {
    await fsSync.promises.mkdir(path.join(clawspaceDir, 'contract', 'active'), { recursive: true });
    const system = makeSystem();
    const contractId = await system.create({
      contract: makeContractYaml({ id: 'real-chain', title: 'Real chain' }),
    } as never);
    expect(contractId).toBe('real-chain');

    // 真实 CLI 创建通知落盘（生产 helper → 真实 notifier → 真实 resolver）
    await notifyContractCreated(
      { fsFactory, audit: makeAudit().audit } as never,
      motionDir,
      MOTION_CLAW_ID,
      contractId,
      makeContractYaml({ id: 'real-chain', title: 'Real chain' }),
      chestnutRoot,
    );
    const createdFiles = pendingNames();
    expect(createdFiles).toHaveLength(1);
    const createdMsg = decodeAll(createdFiles, 'pending')[0];
    expect(createdMsg.type).toBe('contract_created');
    expect(createdMsg.metadata?.contract_id).toBe('real-chain');

    // 真实取消（带真实取消投递 → 真实取消通知落盘）
    const outcome = await system.cancel(contractId, 'phase2094 real chain');
    expect(outcome.commit.kind).toBe('committed');
    expect(await fsSync.promises.readdir(path.join(motionDir, 'contract', 'archive', 'cancelled')))
      .toContain('real-chain');

    const pendingAfterCancel = pendingNames();
    expect(pendingAfterCancel).toHaveLength(2);
    const cancelledMsg = decodeAll(pendingAfterCancel, 'pending').find(m => m.type === 'contract_cancelled');
    expect(cancelledMsg, '真实取消投递未落盘').toBeDefined();
    expect(String(cancelledMsg!.content)).toContain('real-chain');
    // 取消通知不是工作消息：身份走 guidance extraMeta（`__` 前缀），不进 metadata。

    // 交付前边界：created 被过滤，取消通知（非工作消息）照常交付
    const { factQuery, sink } = makeFactQuery();
    const runtime = makePreparer(sink, factQuery);
    const prepared = await runtime.prepareInbox();

    expect(prepared.entries.map(e => e.message.id)).toEqual([cancelledMsg!.id]);
    expect(prepared.entries[0].message.type).toBe('contract_cancelled');
    // created 被过滤 → ack 到 done/（正文保留）；被交付的取消通知已 claim 进 inflight
    expect(doneNames()).toHaveLength(1);
    expect(decodeAll(doneNames(), 'done')[0].id).toBe(createdMsg.id);
    expect(pendingNames()).toHaveLength(0);
    // 终态证据一行（execution_recovery 才带 delivery_id 列，工作消息只带 contract_id）
    const terminalRows = sink.events.filter(e => e[0] === 'runtime_inbox_contract_terminal');
    expect(terminalRows).toHaveLength(1);
    const cols = terminalRows[0].slice(1).map(String).join(' ');
    expect(cols).toContain('contract=real-chain');
    expect(cols).toContain('state=cancelled');
    expect(cols).not.toContain('delivery_id=');
  }, 30_000);

  it('续作链：真实 ensureOnboardingAndNotify 产出 contract_resume → 取消后同样被过滤', async () => {
    const system = makeSystem();
    // 生产侧 onboarding 契约（id 必须来自 yaml.id，create 不接受外部 id 参数）
    const contractId = await system.create({
      contract: makeContractYaml({ id: ONBOARDING_CONTRACT_ID, title: 'Onboarding' }),
    } as never);
    expect(contractId).toBe(ONBOARDING_CONTRACT_ID);

    const deps = { fsFactory, audit: makeAudit().audit, rootConfig: { get: () => ({}), has: () => false } as never } as never;
    const clawNotifier = createClawNotifier({
      fs: fsFactory(motionDir),
      audit: makeAudit().audit,
      resolveTarget: makeClawNotifyTargetResolver(chestnutRoot),
    });
    const onboardingInput = () => ({
      motionDir,
      onboarding: { state: 'in_progress', contractId: ONBOARDING_CONTRACT_ID } as never,
      firstRun: false,
      language: 'zh',
      clawNotifier,
    });

    // 真实续作入口（scheduler 触发的就是这条）
    const result = await ensureOnboardingAndNotify(deps, onboardingInput());
    expect(result.contractId).toBe(ONBOARDING_CONTRACT_ID);

    const resumeMsg = decodeAll(pendingNames(), 'pending').find(m => m.type === 'contract_resume');
    expect(resumeMsg, '真实续作入口未写出 contract_resume').toBeDefined();
    expect(resumeMsg!.from).toBe('system');
    expect(resumeMsg!.metadata?.contract_id).toBe(ONBOARDING_CONTRACT_ID);
    expect(resumeMsg!.content).toContain(ONBOARDING_CONTRACT_ID);

    // 未终态前：续作消息照常交付（守卫：过滤只在已确认终态后发生）
    const before = makeFactQuery();
    const beforeRuntime = makePreparer(before.sink, before.factQuery);
    const beforePrepared = await beforeRuntime.prepareInbox();
    expect(beforePrepared.entries.map(e => e.message.id)).toEqual([resumeMsg!.id]);

    // R2 剩余项：把第一次领取的原句柄归还 pending —— 取消后重新消费「同一条」消息，
    // 而不是让调用方再生成一条新消息来替代验证。
    await beforeRuntime.nackHandles(
      beforePrepared.entries.map(e => e.handle),
      'phase2094 resume chain requeue',
      'pending',
    );
    expect(decodeAll(pendingNames(), 'pending').map(m => m.id)).toEqual([resumeMsg!.id]);

    // 取消（真实取消链，onboarding 契约已过期/未推进也不影响取消）
    const outcome = await system.cancel(ONBOARDING_CONTRACT_ID, 'phase2094 resume chain');
    expect(outcome.commit.kind).toBe('committed');

    // R2 剩余项：取消落地后再次领取 —— 只交付真实 contract_cancelled；
    // 同一条原 resume 消息按 id 被过滤进 done/（经真实 decodeInbox 读回核对身份）。
    const after = makeFactQuery();
    const afterPrepared = await makePreparer(after.sink, after.factQuery).prepareInbox();
    expect(afterPrepared.entries.map(e => e.message.type)).toEqual(['contract_cancelled']);
    expect(afterPrepared.entries.map(e => e.message.id)).not.toContain(resumeMsg!.id);

    const resumeInDone = decodeAll(doneNames(), 'done').find(m => m.id === resumeMsg!.id);
    expect(resumeInDone, '原 resume 消息未被过滤进 done/').toBeDefined();
    // 身份一致：type / from / content / metadata.contract_id 与原消息相同
    // （nack 允许改写 delivery_attempts 等处理元数据，故不整体深比较）
    expect(resumeInDone!.type).toBe('contract_resume');
    expect(resumeInDone!.from).toBe(resumeMsg!.from);
    expect(resumeInDone!.content).toBe(resumeMsg!.content);
    expect(resumeInDone!.metadata?.contract_id).toBe(ONBOARDING_CONTRACT_ID);
    expect(resumeInDone!.metadata?.contract_id).toBe(resumeMsg!.metadata?.contract_id);
    // pending 中不再存在同一身份
    expect(decodeAll(pendingNames(), 'pending').map(m => m.id)).not.toContain(resumeMsg!.id);

    // 终态审计断言（保留）：判定用的是这条原 resume 消息里的契约身份
    const termRows = after.sink.events.filter(e => e[0] === 'runtime_inbox_contract_terminal');
    expect(termRows).toHaveLength(1);
    expect(termRows[0].slice(1).map(String).join(' ')).toContain(`contract=${ONBOARDING_CONTRACT_ID}`);
  }, 30_000);
});
