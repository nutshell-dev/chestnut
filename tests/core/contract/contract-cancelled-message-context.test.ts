/**
 * phase 1833: 契约取消通知全链路核证——
 * 两路真实生产入口写 inbox → decodeInbox → Runtime.formatInboxMessage
 * （真实 formatter registry + 真实 motion guidance registry）→ sanitizeForLLMCall。
 *
 * 路一（自家 M04）：createContractNotificationAdapter 接 typed contract_cancelled
 *   event → 本 daemon 自家 inbox（typed event 仅 contractId/reason）。
 * 路二（observer M05）：真实 archive + 真实 lifecycle-intent 文件（生产
 *   persistLifecycleIntent 写入 / 手工坏文件）→ runContractObserver → 真实
 *   notifyInbox → motion inbox；读取异常经生产 AuditWriter 落盘、AuditReader 读回。
 *
 * 验收点：原因来源明确（请求记录/历史检查点/未取得）、原文保留、缺失与失败均不断言
 * 「没有原因」；取消前已完成子任务 ID；guidance 只有查询用途标签；guidance 失败正文
 * 仍可识别；无伪造结论、无隐含新任务。stream/idempotency 由 adapter 测试锁定不变。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import type { FileSystem } from '../../../src/foundation/fs/index.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeAudit } from '../../helpers/audit.js';
import { createContractNotificationAdapter } from '../../../src/assembly/contract-notification-adapter.js';
import { makeContractId } from '../../../src/core/contract/types.js';
import type { ContractId } from '../../../src/core/contract/types.js';
import { runContractObserver } from '../../../src/core/contract/jobs/contract-observer.js';
import {
  buildCancelledIntent,
  lifecycleIntentPath,
  persistLifecycleIntent,
} from '../../../src/core/contract/lifecycle-intent.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import { createClawTopology } from '../../../src/core/claw-topology/index.js';
import { decodeInbox } from '../../../src/foundation/messaging/codec-inbox.js';
import { notifyInbox } from '../../../src/foundation/messaging/index.js';
import {
  createInboxMessageTypeRegistry,
  registerInboxMessageTypes,
} from '../../../src/foundation/messaging/index.js';
import { CONTRACT_INBOX_MESSAGE_TYPES } from '../../../src/core/contract/index.js';
import { RUNTIME_AUDIT_EVENTS } from '../../../src/core/runtime/runtime-audit-events.js';
import { Runtime } from '../../../src/core/runtime/runtime.js';
import { sanitizeForLLMCall } from '../../../src/foundation/llm-provider/sanitize.js';
import { createMotionGuidanceRegistry } from '../../../src/assembly/guidance/registry.js';
import { registerAllMotionGuidance } from '../../../src/assembly/guidance/composers/index.js';
import { createAuditWriter } from '../../../src/foundation/audit/index.js';
import { createAuditReader } from '../../../src/foundation/audit/reader.js';
import type { AuditRecord } from '../../../src/foundation/audit/reader.js';
import type { StreamWriter } from '../../../src/foundation/stream/index.js';

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

/** 真实 Runtime（真实 formatter registry）；withGuidance 时持真实 motion guidance 链。 */
function makeRuntime(audit: any, opts: { withGuidance: boolean }): TestRuntime {
  const registry = createInboxMessageTypeRegistry();
  registerInboxMessageTypes(registry, CONTRACT_INBOX_MESSAGE_TYPES);
  let guidanceCompose: ((input: { type: string; from: string; meta: Record<string, string> }) => { text: string } | null) | undefined;
  if (opts.withGuidance) {
    const guidanceRegistry = createMotionGuidanceRegistry();
    registerAllMotionGuidance(guidanceRegistry);
    guidanceCompose = (input) => guidanceRegistry.compose(input) ?? null;
  }
  return new TestRuntime({
    clawId: 'motion',
    clawDir: '/tmp/motion',
    clawsDir: '/tmp/claws',
    idleTimeoutMs: 0,
    llmConfig: {
      primary: { name: 'mock', apiKey: 'k', model: 'm', maxTokens: 1, temperature: 0, timeoutMs: 1, apiFormat: 'anthropic' as const },
      maxAttempts: 1,
      retryDelayMs: 0,
    },
    dependencies: {
      systemFs: {} as any,
      auditWriter: audit,
      snapshot: {} as any,
      sessionManager: {} as any,
      inboxReader: {} as any,
      llm: {} as any,
      toolRegistry: {
        register: vi.fn(),
        getForProfile: vi.fn().mockReturnValue([]),
        getAll: vi.fn().mockReturnValue([]),
        formatForLLM: vi.fn().mockReturnValue([]),
      } as any,
      toolExecutor: {} as any,
      contractManager: {} as any,
      taskSystem: {
        initialize: vi.fn().mockResolvedValue(undefined),
        startDispatch: vi.fn(),
        shutdown: vi.fn().mockResolvedValue({ kind: 'converged', aborted: 0, terminal: [] }),
      } as any,
      skillRegistry: {} as any,
      permissionChecker: {} as any,
      fsFactory: () => ({}) as any,
      contractNotifyCallback: undefined,
      formatterRegistry: registry,
      guidanceCompose: guidanceCompose as any,
    },
  });
}

async function providerVisibleContent(
  runtime: TestRuntime,
  msg: { type: string; from: string; content: string; timestamp?: string; metadata?: Record<string, string> },
  metaOverride?: Record<string, string>,
): Promise<string> {
  const formatted = await runtime.testFormatInboxMessage(
    msg.type,
    msg.from,
    msg.content,
    msg.timestamp,
    metaOverride ?? msg.metadata,
  );
  const [wire] = sanitizeForLLMCall([{ role: 'user', content: formatted }]);
  return wire.content;
}

/** 不伪造结论、不承诺副作用终止、不隐含新任务的反向断言。 */
function expectNoFabrication(content: string): void {
  expect(content).not.toContain('已停止所有工作');
  expect(content).not.toContain('已通过验收');
  expect(content).not.toContain('用户已认可');
  expect(content).not.toContain('新任务');
  expect(content).not.toContain('重做');
}

/** FS 包装：仅对指定目录的 async list 注入失败，其余方法委托真实 NodeFileSystem。 */
function wrapListFailure(nodeFs: NodeFileSystem, failDir: string): FileSystem {
  return new Proxy(nodeFs as unknown as FileSystem, {
    get(_t, prop) {
      if (prop === 'list') {
        return async (p: string, opts?: unknown) => {
          if (p === failDir) throw new Error('EIO: injected list failure');
          return (nodeFs as unknown as { list(d: string, o?: unknown): Promise<unknown> }).list(p, opts);
        };
      }
      const v = (nodeFs as unknown as Record<string | symbol, unknown>)[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(nodeFs) : v;
    },
  });
}

describe('phase 1833: 契约取消通知 → inbox → Runtime/指导 → provider 全链路', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await createTempDir('phase1833-cancelled-');
  });

  afterEach(async () => {
    await cleanupTempDir(rootDir);
  });

  async function readInboxDir(dir: string) {
    const files = (await fs.readdir(dir)).filter(f => f.endsWith('.md')).sort();
    const messages = [];
    for (const f of files) {
      messages.push(decodeInbox(await fs.readFile(path.join(dir, f), 'utf-8')));
    }
    return messages;
  }

  describe('路一：自家 typed cancelled（M04 adapter）', () => {
    function emitSelfCancelled(clawId: string, event: Parameters<ReturnType<typeof createContractNotificationAdapter>>[0]) {
      const selfInboxDir = path.join(rootDir, clawId, 'inbox', 'pending');
      const streamWrite = vi.fn();
      const { audit } = makeAudit();
      const emit = createContractNotificationAdapter({
        streamWriter: { write: streamWrite } as unknown as StreamWriter,
        clawId,
        systemFs: new NodeFileSystem({ baseDir: rootDir }),
        selfInboxDir,
        auditWriter: audit,
      });
      emit(event);
      return { selfInboxDir, streamWrite };
    }

    it('motion 自家取消：正文自足 + 真实 guidance 查询用途标签；stream payload 不变', async () => {
      const { selfInboxDir, streamWrite } = emitSelfCancelled('motion', {
        type: 'contract_cancelled',
        contractId: makeContractId('c-self'),
        reason: '用户不需要了',
      });
      // stream payload 保持 legacy shape（本 phase 不动 stream 协议）
      expect(streamWrite).toHaveBeenCalledWith({
        ts: expect.any(Number),
        type: 'system_notify',
        subtype: 'contract_cancelled',
        contractId: 'c-self',
        reason: '用户不需要了',
      });

      const { audit, events } = makeAudit();
      const runtime = makeRuntime(audit, { withGuidance: true });
      const [msg] = await readInboxDir(selfInboxDir);
      expect(msg.type).toBe('contract_cancelled');
      const content = await providerVisibleContent(runtime, msg);

      expect(content).toContain('契约已取消｜c-self');
      expect(content).toContain('执行者：motion');
      expect(content).toContain('取消原因：用户不需要了');
      // 真实 guidance 链：1832 查询用途标签（同一查询入口，取消共用）
      expect(content).toContain('查看相关执行记录： chestnut claw motion trace --contract c-self');
      expect(content).toContain('查看契约与进度摘要： chestnut contract show -c motion --contract c-self');
      expectNoFabrication(content);
      expect(events.some(e => e[0] === RUNTIME_AUDIT_EVENTS.GUIDANCE_COMPOSER_FAILED)).toBe(false);
    });

    it('worker 自家取消（空原因，无 guidanceCompose）：明示未填写原因、正文自足', async () => {
      const { selfInboxDir } = emitSelfCancelled('worker-1', {
        type: 'contract_cancelled',
        contractId: makeContractId('c-w'),
        reason: '',
      });

      const { audit } = makeAudit();
      const runtime = makeRuntime(audit, { withGuidance: false });
      const [msg] = await readInboxDir(selfInboxDir);
      const content = await providerVisibleContent(runtime, msg);

      expect(content).toContain('契约已取消｜c-w');
      expect(content).toContain('取消请求未填写原因');
      expect(content).not.toContain('chestnut claw');
      expectNoFabrication(content);
    });
  });

  describe('路二：observer 观察其他 claw 的取消（M05）', () => {
    let motionDir: string;
    let motionPendingDir: string;
    let nodeFs: NodeFileSystem;
    const CLAW = 'claw-1';

    beforeEach(async () => {
      motionDir = path.join(rootDir, 'motion');
      motionPendingDir = path.join(motionDir, 'inbox', 'pending');
      await fs.mkdir(motionPendingDir, { recursive: true });
      nodeFs = new NodeFileSystem({ baseDir: rootDir });
      await fs.mkdir(path.join(motionDir, 'status'), { recursive: true });
      await fs.writeFile(path.join(motionDir, 'status', 'contract-observer-state.json'), JSON.stringify({
        version: 7,
        lastCheckTs: 0,
        clawWatermarks: {},
        bootstrapDone: true,
        completedWatermarks: {},
        cancelledWatermarks: {},
        crashedWatermarks: {},
        reportedCorrupted: {},
        reportedActiveState: {},
        retrospectiveWatermarks: {},
      }));
    });

    function clawDir(clawId: string = CLAW): string {
      return path.join(rootDir, 'claws', clawId);
    }

    async function writeCancelledArchive(
      contractId: string,
      progress: Record<string, unknown>,
      opts?: { legacyFlat?: boolean; contractYaml?: string },
    ) {
      const dir = opts?.legacyFlat
        ? path.join(clawDir(), 'contract', 'archive', contractId)
        : path.join(clawDir(), 'contract', 'archive', 'cancelled', contractId);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'progress.json'), JSON.stringify({
        schema_version: 1,
        contract_id: contractId,
        status: 'cancelled',
        ...progress,
      }));
      if (opts?.contractYaml !== undefined) {
        await fs.writeFile(path.join(dir, 'contract.yaml'), opts.contractYaml);
      }
    }

    async function runObserverToMotionInbox(audit: any, fsOverride?: FileSystem) {
      const effectiveFs = fsOverride ?? (nodeFs as unknown as FileSystem);
      await runContractObserver({
        clawTopology: createClawTopology({ fs: effectiveFs, chestnutRoot: rootDir, motionDir }),
        motionDir,
        fs: effectiveFs,
        motionAudit: audit,
        notifyMotion: async (m: any) => {
          notifyInbox(nodeFs, { inboxDir: motionPendingDir, ...m }, audit);
        },
      } as any);
      return readInboxDir(motionPendingDir);
    }

    async function readAuditRecords(file: string): Promise<AuditRecord[]> {
      const reader = createAuditReader(nodeFs, file);
      const records: AuditRecord[] = [];
      try {
        for await (const rec of reader.read()) records.push(rec);
      } finally {
        reader.close();
      }
      return records;
    }

    it('多请求不同原因（含空白原因与长原因）+ 取消前部分完成 + legacy checkpoint；批量对象边界保留', async () => {
      const longReason = `很长的取消理由：${'长'.repeat(300)}`;
      const { audit: seedAudit } = makeAudit();
      // 生产 writer 落三条取消请求（含不同原因/空白原因）
      await persistLifecycleIntent(nodeFs, seedAudit, clawDir(), buildCancelledIntent('c-a' as ContractId, 'req-1', '需求变更'));
      await persistLifecycleIntent(nodeFs, seedAudit, clawDir(), buildCancelledIntent('c-a' as ContractId, 'req-2', ' '));
      await persistLifecycleIntent(nodeFs, seedAudit, clawDir(), buildCancelledIntent('c-a' as ContractId, 'req-3', longReason));
      await writeCancelledArchive('c-a', {
        subtasks: {
          'st-1': { status: 'completed', completed_at: '2026-09-13T00:00:00.000Z' },
          'st-2': { status: 'todo' },
        },
      }, { contractYaml: 'title: 契约甲\ngoal: 目标甲\n' });
      // legacy flat：无 intent store，checkpoint 带 cancelled: 前缀
      await writeCancelledArchive('c-legacy', {
        checkpoint: 'cancelled: 旧时代的手动取消',
        subtasks: {},
      }, { legacyFlat: true });

      const { audit } = makeAudit();
      const messages = await runObserverToMotionInbox(audit);
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('contract_cancelled');

      const runtime = makeRuntime(audit, { withGuidance: true });
      const content = await providerVisibleContent(runtime, messages[0]);

      // 批量契约对象边界：两份取消正文各自完整
      expect(content.match(/契约已取消｜/g)).toHaveLength(2);
      // 请求原因逐条完整保留（不同原因 + 空白明示 + 长原因逐字），不择一冒称最终原因
      expect(content).toContain('契约已取消｜契约甲（c-a）');
      expect(content).toContain('原目标：目标甲');
      expect(content).toContain('记录中的取消请求原因：');
      expect(content).toContain('  - 需求变更');
      expect(content).toContain('  - （该条未填写原因）');
      expect(content).toContain(`  - ${longReason}`);
      // 取消前已完成子任务 ID；不称其余子任务未开始
      expect(content).toContain('取消前已完成子任务：\n  [st-1]');
      expect(content).not.toContain('[st-2]');
      // legacy checkpoint 来源明确
      expect(content).toContain('契约已取消｜c-legacy');
      expect(content).toContain('历史检查点记录的取消原因：旧时代的手动取消');
      // guidance refs 覆盖两份取消契约（1832 用途标签）
      expect(content).toContain('查看相关执行记录： chestnut claw claw-1 trace --contract c-a');
      expect(content).toContain('查看契约与进度摘要： chestnut contract show -c claw-1 --contract c-legacy');
      expectNoFabrication(content);
    });

    it('完全缺失与非取消 checkpoint：均不断言「没有原因」，非取消 checkpoint 单列完整保留', async () => {
      await writeCancelledArchive('c-none', { subtasks: {} });
      await writeCancelledArchive('c-chk', {
        checkpoint: 'paused: 等待评审',
        subtasks: {},
      }, { legacyFlat: true });

      const { audit } = makeAudit();
      const messages = await runObserverToMotionInbox(audit);
      expect(messages).toHaveLength(1);

      const runtime = makeRuntime(audit, { withGuidance: true });
      const content = await providerVisibleContent(runtime, messages[0]);

      expect(content).toContain('契约已取消｜c-none\n执行者：claw-1\n本次未取得取消原因记录');
      expect(content).toContain('契约已取消｜c-chk');
      expect(content).toContain('本次未取得取消原因记录\n历史检查点记录：paused: 等待评审');
      expect(content).not.toContain('没有取消原因');
      expectNoFabrication(content);
    });

    it('单文件坏 + 身份错 → 部分读取注记 + 生产 AuditWriter/Reader 读回异常证据', async () => {
      const auditFile = path.join(rootDir, 'motion-audit.tsv');
      const realAudit = createAuditWriter(nodeFs, auditFile);
      const { audit: seedAudit } = makeAudit();
      await persistLifecycleIntent(nodeFs, seedAudit, clawDir(), buildCancelledIntent('c-bad' as ContractId, 'req-good', '已读到的理由'));
      // 坏 JSON 与身份错（手工写入，模拟损坏记录）
      await fs.writeFile(
        lifecycleIntentPath(clawDir(), 'c-bad' as ContractId, 'req-broken'),
        '{not-json',
      );
      await fs.writeFile(
        lifecycleIntentPath(clawDir(), 'c-bad' as ContractId, 'req-wrong'),
        JSON.stringify({
          schema_version: 1,
          request_id: 'req-wrong',
          contract_id: 'c-other',
          requested_state: 'cancelled',
          requested_at: '2026-09-13T01:00:00.000Z',
          reason: '属于别的契约',
        }),
      );
      await writeCancelledArchive('c-bad', { subtasks: {} });

      const messages = await runObserverToMotionInbox(realAudit);
      expect(messages).toHaveLength(1);

      const runtime = makeRuntime(makeAudit().audit, { withGuidance: true });
      const content = await providerVisibleContent(runtime, messages[0]);
      // 已读取部分保留 + 部分失败注记；不抛掉整个消息掩盖部分信息
      expect(content).toContain('  - 已读到的理由');
      expect(content).toContain('部分原因记录读取失败，以上为已读取部分');
      expect(content).not.toContain('属于别的契约');

      // 异常经生产审计链读回（原错误仍在）
      const records = await readAuditRecords(auditFile);
      const issues = records.filter(r => r.type === CONTRACT_AUDIT_EVENTS.LIFECYCLE_INTENT_READ_ISSUE);
      expect(issues.some(r => r.cols.includes('requestId=req-broken') && r.cols.includes('reason=parse_failed'))).toBe(true);
      expect(issues.some(r => r.cols.includes('requestId=req-wrong') && r.cols.includes('reason=identity_mismatch'))).toBe(true);
    });

    it('列表失败 → 「未取得」措辞（不制造无原因假结论）+ 审计读回 list_failed', async () => {
      const auditFile = path.join(rootDir, 'motion-audit.tsv');
      const realAudit = createAuditWriter(nodeFs, auditFile);
      const { audit: seedAudit } = makeAudit();
      await persistLifecycleIntent(nodeFs, seedAudit, clawDir(), buildCancelledIntent('c-io' as ContractId, 'req-1', '存在但读不到'));
      await writeCancelledArchive('c-io', { subtasks: {} });

      const failingFs = wrapListFailure(nodeFs, path.join(clawDir(), 'contract', 'lifecycle-intents', 'c-io'));
      const messages = await runObserverToMotionInbox(realAudit, failingFs);
      expect(messages).toHaveLength(1);

      const runtime = makeRuntime(makeAudit().audit, { withGuidance: true });
      const content = await providerVisibleContent(runtime, messages[0]);
      expect(content).toContain('契约已取消｜c-io\n执行者：claw-1\n本次未取得取消原因记录');
      expect(content).not.toContain('存在但读不到');

      const records = await readAuditRecords(auditFile);
      const issues = records.filter(r => r.type === CONTRACT_AUDIT_EVENTS.LIFECYCLE_INTENT_READ_ISSUE);
      expect(issues.some(r => r.cols.includes('reason=list_failed'))).toBe(true);
    });

    it('guidance 失败仍可识别正文：损坏 metadata → 审计暴露 + 原因事实完整投递', async () => {
      const { audit: seedAudit } = makeAudit();
      await persistLifecycleIntent(nodeFs, seedAudit, clawDir(), buildCancelledIntent('c-g' as ContractId, 'req-1', '理由仍在'));
      await writeCancelledArchive('c-g', { subtasks: {} });

      const { audit } = makeAudit();
      const messages = await runObserverToMotionInbox(audit);
      expect(messages).toHaveLength(1);

      const { audit: rtAudit, events } = makeAudit();
      const runtime = makeRuntime(rtAudit, { withGuidance: true });
      const content = await providerVisibleContent(runtime, messages[0], {
        guidance_schema_version: '1',
        cancelled_contract_refs: 'not-json',
      });

      expect(events.some(e => e[0] === RUNTIME_AUDIT_EVENTS.GUIDANCE_COMPOSER_FAILED)).toBe(true);
      expect(content).toContain('契约已取消｜c-g');
      expect(content).toContain('  - 理由仍在');
      expect(content).not.toContain('chestnut claw');
    });
  });
});
