/**
 * phase 1832: 契约完成通知全链路核证——
 * 两路真实生产入口写 inbox → decodeInbox → Runtime.formatInboxMessage
 * （真实 formatter registry + 真实 motion guidance registry）→ sanitizeForLLMCall
 * （provider 边界投影）。
 *
 * 路一（自家 M04）：createContractNotificationAdapter 接 typed contract_completed
 *   event → 本 daemon 自家 inbox（motion 自家带 guidance / worker 自家无 guidance）。
 * 路二（observer M05）：真实 archive 目录 → runContractObserver → 真实 notifyInbox
 *   → motion inbox。
 *
 * 验收点：provider 可见内容携带流程终态、对象身份、执行者与提交材料/放行/历史反馈
 * 已有事实；guidance 只有查询用途标签；guidance 失败正文仍可识别；不伪造验收结论、
 * 不含隐含新任务。stream payload 逐字段不变由 contract-notification-adapter.test.ts 锁定。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeAudit } from '../../helpers/audit.js';
import { createContractNotificationAdapter } from '../../../src/assembly/contract-notification-adapter.js';
import { makeContractId, makeSubtaskId } from '../../../src/core/contract/types.js';
import { runContractObserver } from '../../../src/core/contract/jobs/contract-observer.js';
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

/** provider 边界投影：decode 后真实 inbox 消息 → Runtime 格式化 → sanitize 后可见 content。 */
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

/** 不伪造结论、不隐含新任务的反向断言（注意放行注记含「不表示验收通过」子串）。 */
function expectNoFabrication(content: string): void {
  expect(content).not.toContain('已通过验收');
  expect(content).not.toContain('用户已认可');
  expect(content).not.toContain('新任务');
  expect(content).not.toContain('重做');
}

describe('phase 1832: 契约完成通知 → inbox → Runtime/指导 → provider 全链路', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await createTempDir('phase1832-completed-');
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

  describe('路一：自家 typed completed（M04 adapter）', () => {
    function emitSelfCompleted(clawId: string, event: Parameters<ReturnType<typeof createContractNotificationAdapter>>[0]) {
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

    it('motion 自家完成：正文自足 + 真实 guidance 链追加查询用途标签，无伪造结论', async () => {
      const { selfInboxDir, streamWrite } = emitSelfCompleted('motion', {
        type: 'contract_completed',
        contractId: makeContractId('c-self'),
        title: '整理周报',
        goal: '汇总本周进展',
        subtasks: [{ id: makeSubtaskId('st-1'), completedAt: '2026-09-14T01:00:00.000Z', forceAccepted: false }],
        completedAt: '2026-09-14T01:00:00.000Z',
      });
      // stream payload 保持 legacy shape（本 phase 不动 stream 协议）
      expect(streamWrite).toHaveBeenCalledWith(expect.objectContaining({
        type: 'system_notify',
        subtype: 'contract_completed',
        contractId: 'c-self',
        completed_at: '2026-09-14T01:00:00.000Z',
      }));

      const { audit, events } = makeAudit();
      const runtime = makeRuntime(audit, { withGuidance: true });
      const [msg] = await readInboxDir(selfInboxDir);
      expect(msg.type).toBe('contract_events');
      const content = await providerVisibleContent(runtime, msg);

      expect(content).toContain('契约流程已完成｜整理周报（c-self）');
      expect(content).toContain('执行者：motion');
      expect(content).toContain('原目标：汇总本周进展');
      expect(content).toContain('完成时间：2026-09-14T01:00:00.000Z');
      expect(content).toContain('[st-1] 完成时间：2026-09-14T01:00:00.000Z');
      // 真实 guidance 链：查询用途标签 + 命令；无动作命令语气
      expect(content).toContain('查看相关执行记录： chestnut claw motion trace --contract c-self');
      expect(content).toContain('查看契约与进度摘要： chestnut contract show -c motion --contract c-self');
      expectNoFabrication(content);
      // 无 GUIDANCE_COMPOSER_FAILED
      expect(events.some(e => e[0] === RUNTIME_AUDIT_EVENTS.GUIDANCE_COMPOSER_FAILED)).toBe(false);
    });

    it('worker 自家完成（无 guidanceCompose）：放行注记中性、正文自足可识别', async () => {
      const { selfInboxDir } = emitSelfCompleted('worker-1', {
        type: 'contract_completed',
        contractId: makeContractId('c-w'),
        title: '',
        goal: '',
        subtasks: [
          { id: makeSubtaskId('st-1'), completedAt: '2026-09-14T02:00:00.000Z', forceAccepted: true },
        ],
        completedAt: '2026-09-14T02:00:00.000Z',
      });

      const { audit } = makeAudit();
      const runtime = makeRuntime(audit, { withGuidance: false });
      const [msg] = await readInboxDir(selfInboxDir);
      const content = await providerVisibleContent(runtime, msg);

      // 空标题只显 ID；缺省目标省略；放行中性注记；缺省不反推质量通过
      expect(content).toContain('契约流程已完成｜c-w');
      expect(content).not.toContain('原目标：');
      expect(content).toContain('完成方式：按流程放行记为完成；该标记不表示验收通过');
      expect(content).not.toContain('chestnut claw');
      expectNoFabrication(content);
    });
  });

  describe('路二：observer 观察其他 claw（M05 event-collector/contract-observer）', () => {
    let motionDir: string;
    let motionPendingDir: string;
    let nodeFs: NodeFileSystem;

    beforeEach(async () => {
      motionDir = path.join(rootDir, 'motion');
      motionPendingDir = path.join(motionDir, 'inbox', 'pending');
      await fs.mkdir(motionPendingDir, { recursive: true });
      nodeFs = new NodeFileSystem({ baseDir: rootDir });
      // observer state v7：bootstrapDone=true 使首个 tick 即投递
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

    async function writeCompletedArchive(
      clawId: string,
      contractId: string,
      progress: Record<string, unknown>,
      contractYaml?: string,
    ) {
      const dir = path.join(rootDir, 'claws', clawId, 'contract', 'archive', 'completed', contractId);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'progress.json'), JSON.stringify({
        schema_version: 1,
        contract_id: contractId,
        status: 'completed',
        ...progress,
      }));
      if (contractYaml !== undefined) {
        await fs.writeFile(path.join(dir, 'contract.yaml'), contractYaml);
      }
    }

    async function runObserverToMotionInbox(audit: any) {
      await runContractObserver({
        clawTopology: createClawTopology({ fs: nodeFs, chestnutRoot: rootDir, motionDir }),
        motionDir,
        fs: nodeFs,
        motionAudit: audit,
        notifyMotion: async (m: any) => {
          notifyInbox(nodeFs, { inboxDir: motionPendingDir, ...m }, audit);
        },
      } as any);
      return readInboxDir(motionPendingDir);
    }

    it('普通完成 + 先失败后通过 + 放行 + 空材料 + 长材料：批量两契约对象边界保留', async () => {
      const longEvidence = `交付物清单：${'x'.repeat(400)}`;
      const longFeedback = `历史反馈：${'y'.repeat(400)}`;
      await writeCompletedArchive('claw-1', 'c-a', {
        subtasks: {
          'st-1': { status: 'completed', completed_at: '2026-09-13T00:00:00.000Z', evidence: '交付：报告.md' },
          'st-2': {
            status: 'completed',
            completed_at: '2026-09-13T01:00:00.000Z',
            evidence: longEvidence,
            last_failed_feedback: { feedback: longFeedback },
          },
        },
      }, 'title: 契约甲\ngoal: 目标甲\n');
      // 缺 contract.yaml：按 owner 当前解码事实呈现（只显 ID），不宣称恢复缺失事实
      await writeCompletedArchive('claw-1', 'c-b', {
        subtasks: {
          'st-1': { status: 'completed', completed_at: '2026-09-13T02:00:00.000Z', force_accepted: true },
        },
      });

      const { audit } = makeAudit();
      const messages = await runObserverToMotionInbox(audit);
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('contract_events');

      const runtime = makeRuntime(audit, { withGuidance: true });
      const content = await providerVisibleContent(runtime, messages[0]);

      // 批量契约对象边界：两份完成正文各自完整
      expect(content).toContain('契约流程已完成｜契约甲（c-a）');
      expect(content).toContain('契约流程已完成｜c-b');
      expect(content.match(/契约流程已完成｜/g)).toHaveLength(2);
      // 材料原文（含长材料逐字保留）
      expect(content).toContain('执行者提交材料：交付：报告.md');
      expect(content).toContain(`执行者提交材料：${longEvidence}`);
      // 空材料明示，不冒称无工作成果
      expect(content).toContain('执行者提交材料：未记录提交材料');
      // 放行中性注记
      expect(content).toContain('完成方式：按流程放行记为完成；该标记不表示验收通过');
      // 历史反馈原文保留并指明是历史记录（长反馈逐字保留）
      expect(content).toContain(`历史验收反馈（该子任务保留的历史记录，不对应最终验收结论）：${longFeedback}`);
      // guidance refs 只含有历史反馈的 c-a（hasFailure 选择保持）
      expect(content).toContain('查看相关执行记录： chestnut claw claw-1 trace --contract c-a');
      expect(content).toContain('查看契约与进度摘要： chestnut contract show -c claw-1 --contract c-a');
      expect(content).not.toContain('--contract c-b');
      expectNoFabrication(content);
    });

    it('超过 10 refs：正文覆盖全部完成事件，guidance cap=10 且 truncation 事实呈现', async () => {
      for (let i = 0; i < 12; i++) {
        await writeCompletedArchive('claw-1', `c-${String(i).padStart(2, '0')}`, {
          subtasks: {
            'st-1': {
              status: 'completed',
              completed_at: `2026-09-13T03:${String(i).padStart(2, '0')}:00.000Z`,
              evidence: `e${i}`,
              last_failed_feedback: { feedback: `f${i}` },
            },
          },
        });
      }

      const { audit } = makeAudit();
      const messages = await runObserverToMotionInbox(audit);
      expect(messages).toHaveLength(1);

      const runtime = makeRuntime(audit, { withGuidance: true });
      const content = await providerVisibleContent(runtime, messages[0]);

      // 正文 12 份全保留（cap 只截 guidance、不截正文）
      expect(content.match(/契约流程已完成｜/g)).toHaveLength(12);
      expect(content).toContain('契约流程已完成｜c-11');
      // guidance cap=10 + truncation 事实（total/shown/subject）
      expect(content).toContain('(12 contract events、显示前 10)');
      expect(content).toContain('chestnut claw claw-1 trace --contract c-09');
      expect(content).not.toContain('trace --contract c-10');
      expect(content).not.toContain('trace --contract c-11');
    });

    it('guidance 失败仍可识别正文：损坏 metadata → 审计暴露 + 正文事实完整投递', async () => {
      await writeCompletedArchive('claw-1', 'c-a', {
        subtasks: {
          'st-1': { status: 'completed', completed_at: '2026-09-13T00:00:00.000Z', evidence: '交付：报告.md' },
        },
      }, 'title: 契约甲\n');

      const { audit: obsAudit } = makeAudit();
      const messages = await runObserverToMotionInbox(obsAudit);
      expect(messages).toHaveLength(1);

      const { audit, events } = makeAudit();
      const runtime = makeRuntime(audit, { withGuidance: true });
      const content = await providerVisibleContent(runtime, messages[0], {
        guidance_schema_version: '1',
        contract_refs: 'not-json',
      });

      expect(events.some(e => e[0] === RUNTIME_AUDIT_EVENTS.GUIDANCE_COMPOSER_FAILED)).toBe(true);
      expect(content).toContain('契约流程已完成｜契约甲（c-a）');
      expect(content).toContain('执行者提交材料：交付：报告.md');
      expect(content).not.toContain('chestnut claw');
    });
  });
});
