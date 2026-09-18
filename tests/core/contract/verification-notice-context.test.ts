/**
 * phase 1829: 验收通知全链路核证——
 * 真实 ContractSystem + 临时 FS + 真实 notifyClaw（routeNotifyClaw 落盘）
 * → decodeInbox → Runtime.formatInboxMessage（真实 registry 声明）
 * → sanitizeForLLMCall（provider 边界投影）。
 *
 * 验收点：最终 provider 可见 content 携带契约/子任务/尝试身份、本次结果与
 * 已提交处置；guidance 缺省时正文自足。不复制状态机造假 fixture。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeContractYaml } from '../../helpers/contract-yaml.js';
import { makeAudit, waitForAuditEvent } from '../../helpers/audit.js';
import { completeSubtask } from '../../helpers/contract-subtask.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import { makeClawNotifyTargetResolver } from '../../../src/core/claw-topology/index.js';
import { createClawNotifier } from '../../../src/foundation/messaging/index.js';
import { decodeInbox } from '../../../src/foundation/messaging/codec-inbox.js';
import {
  createInboxMessageTypeRegistry,
  registerInboxMessageTypes,
} from '../../../src/foundation/messaging/index.js';
import { CONTRACT_INBOX_MESSAGE_TYPES } from '../../../src/core/contract/index.js';
import { Runtime } from '../../../src/core/runtime/runtime.js';
import { sanitizeForLLMCall } from '../../../src/foundation/llm-provider/sanitize.js';

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

/** 真实 Runtime（真实 formatter registry），guidance 缺省（无 guidanceCompose）。 */
function makeRuntime(audit: any): TestRuntime {
  const registry = createInboxMessageTypeRegistry();
  registerInboxMessageTypes(registry, CONTRACT_INBOX_MESSAGE_TYPES);
  return new TestRuntime({
    clawId: 'test-claw',
    clawDir: '/tmp/test-claw',
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
    },
  });
}

/** provider 边界投影：Runtime 格式化结果 → sanitizeForLLMCall 后的可见 content。 */
async function providerVisibleContent(
  runtime: TestRuntime,
  msg: { type: string; from: string; content: string; createdAt?: string },
): Promise<string> {
  const formatted = await runtime.testFormatInboxMessage(msg.type, msg.from, msg.content, msg.createdAt);
  const [wire] = sanitizeForLLMCall([{ role: 'user', content: formatted }]);
  return wire.content;
}

describe('phase 1829: 验收通知 → inbox → Runtime → provider 全链路', () => {
  let rootDir: string;
  let clawDir: string;

  beforeEach(async () => {
    rootDir = await createTempDir('phase1829-notice-');
    clawDir = path.join(rootDir, 'claws', 'test-claw');
    await fs.mkdir(path.join(clawDir, 'inbox', 'pending'), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(rootDir);
  });

  function makeManager(audit: any, notifyClaw?: (targetClawId: string, message: any) => void) {
    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    return new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      clawsDir: '/tmp/test/claws',
      notifyClaw: notifyClaw ?? ((targetClawId: string, message: any) =>
        createClawNotifier({ fs: nodeFs, audit: audit, resolveTarget: makeClawNotifyTargetResolver(rootDir) }).notify(targetClawId, message)),
    });
  }

  async function readInbox() {
    const inboxDir = path.join(clawDir, 'inbox', 'pending');
    const files = (await fs.readdir(inboxDir)).filter(f => f.endsWith('.md'));
    const messages = [];
    for (const f of files.sort()) {
      messages.push(decodeInbox(await fs.readFile(path.join(inboxDir, f), 'utf-8')));
    }
    return messages;
  }

  it('正常通过：provider 可见身份 + 已通过处置，未归档不说已归档', async () => {
    const { audit, events, emitter } = makeAudit();
    const manager = makeManager(audit);
    // 两个子任务避免 allCompleted 触发归档，专注通知内容
    const contractId = await manager.create(makeContractYaml({
      subtasks: [
        { id: 't1', description: 'd1' },
        { id: 't2', description: 'd2' },
      ],
      verification: [{ subtask_id: 't1', type: 'script', script_file: 'verify.sh' }],
    }));
    vi.spyOn(manager as any, 'runScriptVerification').mockResolvedValue({ passed: true, feedback: 'ok' });

    await completeSubtask(manager, { contractId, subtaskId: 't1', evidence: 'e1' });
    await waitForAuditEvent(emitter, events, CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE);

    const inbox = await readInbox();
    expect(inbox).toHaveLength(1);
    expect(inbox[0].type).toBe('verification_result');

    const content = await providerVisibleContent(makeRuntime(audit), inbox[0]);
    expect(content).toContain(`契约：${contractId}；子任务：t1；验收尝试：`);
    expect(content).toContain('本次验收通过，系统已将该子任务记为完成');
    expect(content).toContain('仍有未完成子任务');
    expect(content).not.toContain('已归档');
    // 实际状态：t1 已提交完成，t2 不动
    const progress = await manager.getProgress(contractId);
    expect(progress.subtasks.t1.status).toBe('completed');
    expect(progress.subtasks.t2.status).toBe('todo');
  });

  it('普通未通过：provider 可见身份 + 退回待提交 + 原始反馈 + 实际状态 todo', async () => {
    const { audit, events, emitter } = makeAudit();
    const manager = makeManager(audit);
    const contractId = await manager.create(makeContractYaml({
      subtasks: [{ id: 't1', description: 'd1' }, { id: 't2', description: 'd2' }],
      verification: [{ subtask_id: 't1', type: 'script', script_file: 'verify.sh' }],
      verification_attempts: 3,
    }));
    vi.spyOn(manager as any, 'runScriptVerification')
      .mockResolvedValue({ passed: false, feedback: '输出文件缺少 summary 字段' });

    await completeSubtask(manager, { contractId, subtaskId: 't1', evidence: 'e1' });
    await waitForAuditEvent(emitter, events, CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE);

    const inbox = await readInbox();
    expect(inbox).toHaveLength(1);
    expect(inbox[0].type).toBe('verification_rejection');

    const content = await providerVisibleContent(makeRuntime(audit), inbox[0]);
    expect(content).toContain(`契约：${contractId}；子任务：t1；验收尝试：`);
    expect(content).toContain('本次验收未通过，系统已将该子任务退回待提交');
    expect(content).toContain('输出文件缺少 summary 字段');
    expect(content).toContain('系统尚未自动再次验收');

    const progress = await manager.getProgress(contractId);
    expect(progress.subtasks.t1.status).toBe('todo');
    expect(progress.subtasks.t1.retry_count).toBe(1);
  });

  it('结构化未通过：保留 reason/issues/验收标准，且身份在通知身份行（不重复标题）', async () => {
    const { audit, events, emitter } = makeAudit();
    const manager = makeManager(audit);
    const contractId = await manager.create(makeContractYaml({
      subtasks: [{ id: 't1', description: '实现登录接口' }, { id: 't2', description: 'd2' }],
      verification: [{ subtask_id: 't1', type: 'llm', prompt_file: 'verify.prompt' }],
      verification_attempts: 3,
    }));
    vi.spyOn(manager as any, 'runLLMVerification').mockResolvedValue({
      passed: false,
      feedback: '缺少测试',
      structured: { reason: '缺少测试', issues: ['add unit tests'] },
    });

    await completeSubtask(manager, { contractId, subtaskId: 't1', evidence: 'e1' });
    await waitForAuditEvent(emitter, events, CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE);

    const inbox = await readInbox();
    expect(inbox).toHaveLength(1);
    const content = await providerVisibleContent(makeRuntime(audit), inbox[0]);
    expect(content).toContain(`契约：${contractId}；子任务：t1`);
    expect(content).toContain('缺少测试');
    expect(content).toContain('- add unit tests');
    expect(content).toContain('**验收标准：** llm (verify.prompt)');
    // 结构化块不重复「## 验收失败 — t1」标题（身份已在通知身份行）
    expect(content).not.toContain('## 验收失败');
  });

  it('执行异常：provider 可见异常事实 + 已退回处置；不宣称质量不合格、不承诺自动重试', async () => {
    const { audit, events, emitter } = makeAudit();
    const manager = makeManager(audit);
    const contractId = await manager.create(makeContractYaml({
      subtasks: [{ id: 't1', description: 'd1' }, { id: 't2', description: 'd2' }],
      verification: [{ subtask_id: 't1', type: 'script', script_file: 'verify.sh' }],
      verification_attempts: 3,
    }));
    vi.spyOn(manager as any, 'runScriptVerification').mockRejectedValue(new Error('verifier exploded'));

    await completeSubtask(manager, { contractId, subtaskId: 't1', evidence: 'e1' });
    await waitForAuditEvent(emitter, events, CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE);

    const inbox = await readInbox();
    // phase 1829: 异常退回 = 恰好一条 verification_error（不再先泛化错误再补发）
    expect(inbox).toHaveLength(1);
    expect(inbox[0].type).toBe('verification_error');

    const content = await providerVisibleContent(makeRuntime(audit), inbox[0]);
    expect(content).toContain(`契约：${contractId}；子任务：t1；验收尝试：`);
    expect(content).toContain('系统已将该子任务退回待提交');
    expect(content).toContain('verifier exploded');
    expect(content).toContain('此次异常不提供交付质量结论');
    expect(content).toContain('系统尚未自动再次验收');
    expect(content).not.toContain('本次验收未通过');

    const progress = await manager.getProgress(contractId);
    expect(progress.subtasks.t1.status).toBe('todo');
    expect(progress.subtasks.t1.retry_count).toBe(1);
  });

  it('异常达到阈值放行：仅一条 verification_result，含异常与放行事实，进度与正文一致', async () => {
    const { audit, events, emitter } = makeAudit();
    const manager = makeManager(audit);
    const contractId = await manager.create(makeContractYaml({
      subtasks: [{ id: 't1', description: 'd1' }, { id: 't2', description: 'd2' }],
      verification: [{ subtask_id: 't1', type: 'script', script_file: 'verify.sh' }],
      verification_attempts: 1,
    }));
    vi.spyOn(manager as any, 'runScriptVerification').mockRejectedValue(new Error('verifier exploded'));

    await completeSubtask(manager, { contractId, subtaskId: 't1', evidence: 'e1' });
    await waitForAuditEvent(emitter, events, CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE);

    const inbox = await readInbox();
    expect(inbox).toHaveLength(1);
    expect(inbox[0].type).toBe('verification_result');

    const content = await providerVisibleContent(makeRuntime(audit), inbox[0]);
    expect(content).toContain(`契约：${contractId}；子任务：t1`);
    expect(content).toContain('未得到正常通过结论');
    expect(content).toContain('失败计数达到配置阈值 1');
    expect(content).toContain('verifier exploded');
    expect(content).toContain('这表示流程放行，不表示验收通过');

    const progress = await manager.getProgress(contractId);
    expect(progress.subtasks.t1.status).toBe('completed');
    expect(progress.subtasks.t1.force_accepted).toBe(true);
    expect(progress.subtasks.t1.retry_count).toBe(1);
  });

  it('正常失败阈值放行：一条通知含失败反馈与放行事实（motion/worker 同一正文自足）', async () => {
    const { audit, events, emitter } = makeAudit();
    const manager = makeManager(audit);
    const contractId = await manager.create(makeContractYaml({
      subtasks: [{ id: 't1', description: 'd1' }, { id: 't2', description: 'd2' }],
      verification: [{ subtask_id: 't1', type: 'script', script_file: 'verify.sh' }],
      verification_attempts: 1,
    }));
    vi.spyOn(manager as any, 'runScriptVerification')
      .mockResolvedValue({ passed: false, feedback: '仍缺 summary 字段' });

    await completeSubtask(manager, { contractId, subtaskId: 't1', evidence: 'e1' });
    await waitForAuditEvent(emitter, events, CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE);

    const inbox = await readInbox();
    expect(inbox).toHaveLength(1);
    expect(inbox[0].type).toBe('verification_result');

    const content = await providerVisibleContent(makeRuntime(audit), inbox[0]);
    expect(content).toContain(`契约：${contractId}；子任务：t1`);
    expect(content).toContain('本次验收未通过；失败计数达到配置阈值 1');
    expect(content).toContain('仍缺 summary 字段');
    expect(content).toContain('不需要再次提交已完成的子任务');

    const progress = await manager.getProgress(contractId);
    expect(progress.subtasks.t1.force_accepted).toBe(true);
  });

  // phase 1829 Z4 补修回归（真实 FS）：阈值放行已提交后通知投递失败，不改写
  // 完成度、不阻断原有归档安排——契约仍移至 contract/archive/completed。
  it('Z4: 阈值放行通知投递失败不改写完成度，契约仍按原安排归档（真实 FS）', async () => {
    const { audit, events, emitter } = makeAudit();
    const notifyClaw = vi.fn(() => { throw new Error('INBOX_WRITE_EIO'); });
    const manager = makeManager(audit, notifyClaw);
    // 单子任务：force-accept 后 allCompleted=true，归档是原安排
    const contractId = await manager.create(makeContractYaml({
      subtasks: [{ id: 't1', description: 'd1' }],
      verification: [{ subtask_id: 't1', type: 'script', script_file: 'verify.sh' }],
      verification_attempts: 1,
    }));
    vi.spyOn(manager as any, 'runScriptVerification')
      .mockResolvedValue({ passed: false, feedback: 'needs fix' });

    await completeSubtask(manager, { contractId, subtaskId: 't1', evidence: 'e1' });
    await waitForAuditEvent(emitter, events, CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE);

    // 投递失败被记录为 NOTIFY_FAILED（不进入错误恢复链）
    expect(notifyClaw).toHaveBeenCalled();
    expect(events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.NOTIFY_FAILED)).toBe(true);
    // 完成度未被通知失败改写：归档仍发生（真实 FS 状态）
    const activeExists = await fs.access(path.join(clawDir, 'contract', 'active', contractId)).then(() => true, () => false);
    const archivedExists = await fs.access(path.join(clawDir, 'contract', 'archive', 'completed', contractId)).then(() => true, () => false);
    expect(activeExists).toBe(false);
    expect(archivedExists).toBe(true);
  });
});
