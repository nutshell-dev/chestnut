/**
 * Phase 1934 Step E（F-09）：验证执行不可用与业务否决分离。
 *
 * 覆盖：
 * ① provider all-failed（正常链）→ execution_unavailable 事实 + unavailable transition，
 *    无 reject、无预算消耗、通知为「退回待提交、无验收结论」而非验收拒绝
 * ② 外层 catch 链（unspecified 阶段）同样走 unavailable，不走 errored/reject
 * ③ 反复执行失败超过 verification_attempts：retry_count 不增、force_accepted 不置位；
 *    真实 verifier 否决（passed:false）仍按既有策略计数
 * ④ 结果已 produced 后失败（outcome_processing）不创建 unavailable 覆盖原 verdict
 * ⑤ boot replay：execution_unavailable outcome 已写未 apply → 重启一次收敛（todo、无预算）；
 *    duplicate boot 幂等 already_applied
 * ⑥ 反向：abort 不计否决（interrupt 语义不变）；晚到 attempt 不覆盖；不可用不归档完成；
 *    通知故障不升级为 reject
 * ⑦ 执行层：script 超时/spawn 故障、LLM 调用异常、prompt 读取 I/O 故障上抛（不伪 passed:false）；
 *    prompt 文件缺席（ENOENT）仍为确定性配置反馈
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as os from 'os';
import * as nodeFs from 'fs';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { runVerificationInBackground, runScriptVerification, runLLMVerification } from '../../../src/core/contract/verification.js';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { ProcessExecError } from '../../../src/foundation/process-exec/index.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeAudit, makeMockAudit } from '../../helpers/audit.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import type { FileSystem } from '../../../src/foundation/fs/index.js';
import type { VerificationContext } from '../../../src/core/contract/verification.js';

const cleanups: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length > 0) await cleanupTempDir(cleanups.pop()!);
});

// ─── mock-ctx background harness（与 verification.test.ts 同形） ───

function makeCtx(overrides: Partial<VerificationContext> = {}): VerificationContext {
  return {
    clawDir: '/tmp/claw',
    clawId: 'claw-test',
    audit: makeMockAudit() as unknown as VerificationContext['audit'],
    notifyClaw: vi.fn(),
    fs: { realpathSync: vi.fn((p: string) => p) } as unknown as FileSystem,
    contractDir: vi.fn().mockResolvedValue('contract/active'),
    getProgress: vi.fn().mockResolvedValue(null),
    loadContractYaml: vi.fn().mockResolvedValue(null),
    toolRegistry: {} as VerificationContext['toolRegistry'],
    runScriptVerification: vi.fn(),
    runLLMVerification: vi.fn(),
    runVerifierWithCancel: vi.fn(),
    isActiveContract: vi.fn().mockResolvedValue(true),
    getContractRoot: vi.fn().mockResolvedValue('contract/active'),
    persistVerificationOutcome: vi.fn().mockResolvedValue('persisted'),
    transitionVerificationAttempt: vi.fn().mockResolvedValue({ kind: 'skipped', reason: 'not configured' }),
    checkAllSubtasksCompleted: vi.fn().mockResolvedValue(false),
    registerController: vi.fn(),
    unregisterController: vi.fn(),
    moveContractToArchive: vi.fn(),
    emitContractCompleted: vi.fn(),
    ...overrides,
  } as unknown as VerificationContext;
}

const CONTRACT_YAML = {
  subtasks: [{ id: 'st1', description: 'desc' }],
  verification_attempts: 3,
} as any;
const LLM_CFG = { subtask_id: 'st1', type: 'llm' as const, prompt_file: 'prompt.md' };

describe('execution unavailable — 正常链（执行阶段 catch）', () => {
  it('① provider all-failed → execution_unavailable 事实 + unavailable 释放，零 reject/零预算', async () => {
    const subtask: any = { status: 'in_progress', verification_attempt_id: 'a1' };
    const progress: any = { status: 'running', subtasks: { st1: subtask } };
    const transitionVerificationAttempt = vi.fn().mockImplementation((_c: any, _s: any, t: any) => {
      if (t.kind === 'unavailable') {
        subtask.status = 'todo';
        delete subtask.verification_attempt_id;
        return { kind: 'updated', progress };
      }
      return { kind: 'updated', progress };
    });
    const persistVerificationOutcome = vi.fn().mockResolvedValue('persisted');
    const notifyClaw = vi.fn();
    const ctx = makeCtx({
      transitionVerificationAttempt,
      persistVerificationOutcome,
      notifyClaw,
      getProgress: vi.fn().mockResolvedValue(progress),
      runLLMVerification: vi.fn().mockRejectedValue(new Error('all providers failed: primary open, fallback open')),
    });

    await runVerificationInBackground(
      ctx,
      { contractId: 'c1', subtaskId: 'st1', evidence: 'ev', attemptId: 'a1' },
      CONTRACT_YAML,
      LLM_CFG,
    );

    // durable-first：execution_unavailable 事实先持久化，含原始 error。
    expect(persistVerificationOutcome).toHaveBeenCalledTimes(1);
    const outcome = persistVerificationOutcome.mock.calls[0][0] as any;
    expect(outcome.kind).toBe('execution_unavailable');
    expect(outcome.attempt_id).toBe('a1');
    expect(outcome.error.message).toContain('all providers failed');
    // queued 释放 in_progress：unavailable transition，绝非 reject。
    const kinds = transitionVerificationAttempt.mock.calls.map(([, , t]: any) => t.kind);
    expect(kinds).toEqual(['unavailable']);
    expect(subtask.status).toBe('todo');
    expect(subtask.retry_count).toBeUndefined();
    expect(subtask.force_accepted).toBeUndefined();
    // 通知：退回待提交、无验收结论；不是验收拒绝。
    const errorCalls = notifyClaw.mock.calls.filter(([, m]: any) => m.type === 'verification_error');
    expect(errorCalls).toHaveLength(1);
    const body = errorCalls[0][1].body;
    expect(body).toContain('退回待提交');
    expect(body).toContain('不提供交付质量结论');
    expect(body).toContain('all providers failed');
    expect(body).not.toContain('本次验收未通过');
    expect(body).not.toContain('记为完成');
  });

  it('② 外层 catch 链（getContractRoot 故障 → unspecified）同样 execution_unavailable，无 reject', async () => {
    const transitionVerificationAttempt = vi.fn().mockResolvedValue({
      kind: 'updated',
      progress: { status: 'running', subtasks: { st1: { status: 'todo' } } },
    });
    const persistVerificationOutcome = vi.fn().mockResolvedValue('persisted');
    const ctx = makeCtx({
      transitionVerificationAttempt,
      persistVerificationOutcome,
      getProgress: vi.fn().mockResolvedValue({
        status: 'running',
        subtasks: { st1: { status: 'in_progress', verification_attempt_id: 'a1' } },
      }),
      getContractRoot: vi.fn().mockRejectedValue(Object.assign(new Error('disk gone'), { code: 'EIO' })),
    });

    await runVerificationInBackground(
      ctx,
      { contractId: 'c1', subtaskId: 'st1', evidence: 'ev', attemptId: 'a1' },
      CONTRACT_YAML,
      LLM_CFG,
    );

    const outcome = persistVerificationOutcome.mock.calls[0][0] as any;
    expect(outcome.kind).toBe('execution_unavailable');
    const kinds = transitionVerificationAttempt.mock.calls.map(([, , t]: any) => t.kind);
    expect(kinds).toEqual(['unavailable']);
  });

  it('③ 反复执行失败超过 verification_attempts：retry_count 不增、force_accepted 不置位；真实否决仍计数', async () => {
    const subtask: any = { status: 'todo' };
    const progress: any = { status: 'running', subtasks: { st1: subtask } };
    const transitionVerificationAttempt = vi.fn().mockImplementation((_c: any, _s: any, t: any) => {
      if (subtask.status !== 'in_progress' || subtask.verification_attempt_id !== t.attemptId) {
        return { kind: 'skipped', reason: 'attempt id mismatch or subtask not in_progress' };
      }
      if (t.kind === 'unavailable') {
        subtask.status = 'todo';
        delete subtask.verification_attempt_id;
      } else if (t.kind === 'reject') {
        // 与 manager 既有 reject 语义同形：fresh retry_count + forceAccept 判定。
        subtask.retry_count = (subtask.retry_count ?? 0) + 1;
        subtask.last_failed_feedback = { feedback: t.feedback, cause: t.cause };
        if (subtask.retry_count >= t.maxAttempts) {
          subtask.status = 'completed';
          subtask.force_accepted = true;
        } else {
          subtask.status = 'todo';
        }
      }
      return { kind: 'updated', progress };
    });
    const runLLMVerification = vi.fn().mockRejectedValue(new Error('provider quota exhausted'));
    const ctx = makeCtx({
      transitionVerificationAttempt,
      runLLMVerification,
      getProgress: vi.fn().mockImplementation(() => Promise.resolve(progress)),
    });

    // 4 次执行不可用（超过 verification_attempts=3）。
    for (let i = 0; i < 4; i++) {
      subtask.status = 'in_progress';
      subtask.verification_attempt_id = `a${i}`;
      await runVerificationInBackground(
        ctx,
        { contractId: 'c1', subtaskId: 'st1', evidence: 'ev', attemptId: `a${i}` },
        CONTRACT_YAML,
        LLM_CFG,
      );
    }
    const kinds = transitionVerificationAttempt.mock.calls.map(([, , t]: any) => t.kind);
    expect(kinds).toEqual(['unavailable', 'unavailable', 'unavailable', 'unavailable']);
    expect(subtask.retry_count).toBeUndefined();
    expect(subtask.force_accepted).toBeUndefined();
    expect(subtask.status).toBe('todo');

    // 对照：真实 verifier 否决仍按既有策略消耗预算。
    runLLMVerification.mockResolvedValue({ passed: false, feedback: 'not good enough' });
    subtask.status = 'in_progress';
    subtask.verification_attempt_id = 'a-real';
    await runVerificationInBackground(
      ctx,
      { contractId: 'c1', subtaskId: 'st1', evidence: 'ev', attemptId: 'a-real' },
      CONTRACT_YAML,
      LLM_CFG,
    );
    const kindsAfter = transitionVerificationAttempt.mock.calls.map(([, , t]: any) => t.kind);
    expect(kindsAfter[kindsAfter.length - 1]).toBe('reject');
    expect(subtask.retry_count).toBe(1);
    expect(subtask.force_accepted).toBeUndefined();
  });

  it('④ 结果已 produced 后的 persist 失败保持 errored 语义，不创建 execution_unavailable 覆盖原 verdict', async () => {
    const persistVerificationOutcome = vi.fn()
      .mockRejectedValueOnce(new Error('persist boom'))
      .mockResolvedValue('persisted');
    const ctx = makeCtx({
      persistVerificationOutcome,
      getProgress: vi.fn().mockResolvedValue({
        status: 'running',
        subtasks: { st1: { status: 'in_progress', verification_attempt_id: 'a1' } },
      }),
      transitionVerificationAttempt: vi.fn().mockResolvedValue({
        kind: 'updated',
        progress: { status: 'running', subtasks: { st1: { status: 'todo', retry_count: 1 } } },
      }),
      runScriptVerification: vi.fn().mockResolvedValue({ passed: true, feedback: 'lgtm' }),
    });

    await runVerificationInBackground(
      ctx,
      { contractId: 'c1', subtaskId: 'st1', evidence: 'ev', attemptId: 'a1' },
      CONTRACT_YAML,
      { subtask_id: 'st1', type: 'script' as const, script_file: 'check.sh' },
    );

    const persistedKinds = persistVerificationOutcome.mock.calls.map(([o]: any) => o.kind);
    expect(persistedKinds).not.toContain('execution_unavailable');
  });

  it('⑥a 反向：abort 不计否决、不落 execution_unavailable（interrupt 语义不变）', async () => {
    const transitionVerificationAttempt = vi.fn().mockResolvedValue({
      kind: 'updated',
      progress: { status: 'running', subtasks: { st1: { status: 'todo' } } },
    });
    const persistVerificationOutcome = vi.fn().mockResolvedValue('persisted');
    const ctx = makeCtx({
      transitionVerificationAttempt,
      persistVerificationOutcome,
      runScriptVerification: vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError')),
    });

    await expect(
      runVerificationInBackground(
        ctx,
        { contractId: 'c1', subtaskId: 'st1', evidence: 'ev', attemptId: 'a1' },
        CONTRACT_YAML,
        { subtask_id: 'st1', type: 'script' as const, script_file: 'check.sh' },
      ),
    ).rejects.toThrow('aborted');

    const kinds = transitionVerificationAttempt.mock.calls.map(([, , t]: any) => t.kind);
    expect(kinds).toEqual(['interrupt']);
    const persistedKinds = persistVerificationOutcome.mock.calls.map(([o]: any) => o.kind);
    expect(persistedKinds).toEqual(['interrupted']);
  });

  it('⑥b 反向：晚到 attempt 的 unavailable 不覆盖新 attempt（late → not_applied）', async () => {
    const transitionVerificationAttempt = vi.fn().mockResolvedValue({
      kind: 'late',
      expectedAttemptId: 'a-old',
      actualAttemptId: 'a-new',
    });
    const notifyClaw = vi.fn();
    const ctx = makeCtx({
      transitionVerificationAttempt,
      notifyClaw,
      getProgress: vi.fn().mockResolvedValue({
        status: 'running',
        subtasks: { st1: { status: 'in_progress', verification_attempt_id: 'a-new' } },
      }),
      runLLMVerification: vi.fn().mockRejectedValue(new Error('provider down')),
    });

    await expect(
      runVerificationInBackground(
        ctx,
        { contractId: 'c1', subtaskId: 'st1', evidence: 'ev', attemptId: 'a-old' },
        CONTRACT_YAML,
        LLM_CFG,
      ),
    ).resolves.toBeUndefined();

    const kinds = transitionVerificationAttempt.mock.calls.map(([, , t]: any) => t.kind);
    expect(kinds).toEqual(['unavailable']);
    // late 通知：未据其推进状态。
    const errorCalls = notifyClaw.mock.calls.filter(([, m]: any) => m.type === 'verification_error');
    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0][1].body).toContain('旧尝试');
  });

  it('⑥c 反向：执行不可用不归档 contract 完成', async () => {
    const emitContractCompleted = vi.fn();
    const moveContractToArchive = vi.fn();
    const ctx = makeCtx({
      emitContractCompleted,
      moveContractToArchive,
      checkAllSubtasksCompleted: vi.fn().mockResolvedValue(true),
      getProgress: vi.fn().mockResolvedValue({
        status: 'running',
        subtasks: { st1: { status: 'in_progress', verification_attempt_id: 'a1' } },
      }),
      transitionVerificationAttempt: vi.fn().mockResolvedValue({
        kind: 'updated',
        progress: { status: 'running', subtasks: { st1: { status: 'todo' } } },
      }),
      runLLMVerification: vi.fn().mockRejectedValue(new Error('provider down')),
    });

    await runVerificationInBackground(
      ctx,
      { contractId: 'c1', subtaskId: 'st1', evidence: 'ev', attemptId: 'a1' },
      CONTRACT_YAML,
      LLM_CFG,
    );

    expect(emitContractCompleted).not.toHaveBeenCalled();
    expect(moveContractToArchive).not.toHaveBeenCalled();
  });

  it('⑥d 反向：不可用处置的通知投递失败不升级为 reject', async () => {
    const mockAudit = makeMockAudit();
    const transitionVerificationAttempt = vi.fn().mockResolvedValue({
      kind: 'updated',
      progress: { status: 'running', subtasks: { st1: { status: 'todo' } } },
    });
    const ctx = makeCtx({
      audit: mockAudit as unknown as VerificationContext['audit'],
      transitionVerificationAttempt,
      getProgress: vi.fn().mockResolvedValue({
        status: 'running',
        subtasks: { st1: { status: 'in_progress', verification_attempt_id: 'a1' } },
      }),
      runLLMVerification: vi.fn().mockRejectedValue(new Error('provider down')),
      notifyClaw: vi.fn().mockImplementation(() => { throw new Error('inbox disk full'); }),
    });

    await runVerificationInBackground(
      ctx,
      { contractId: 'c1', subtaskId: 'st1', evidence: 'ev', attemptId: 'a1' },
      CONTRACT_YAML,
      LLM_CFG,
    );

    const kinds = transitionVerificationAttempt.mock.calls.map(([, , t]: any) => t.kind);
    expect(kinds).toEqual(['unavailable']);
    expect(vi.mocked(mockAudit.write).mock.calls.some(
      c => c[0] === CONTRACT_AUDIT_EVENTS.NOTIFY_FAILED,
    )).toBe(true);
  });
});

// ─── 执行层：系统失败上抛，不伪造 passed:false ───

describe('verification-execution 系统失败上抛', () => {
  const mockExec = vi.fn();

  afterEach(() => {
    mockExec.mockReset();
  });

  it('⑦a script 超时（killed）上抛而非 passed:false', async () => {
    const err = new ProcessExecError({ message: 'timeout', output: 'took too long', exitCode: null, killed: true });
    mockExec.mockRejectedValue(err);
    const ctx = makeCtx({ exec: mockExec } as Partial<VerificationContext>);
    await expect(runScriptVerification(ctx, 'check.sh', '/tmp/contract')).rejects.toBe(err);
  });

  it('⑦b spawn 故障（非 ProcessExecError）原样上抛', async () => {
    const spawnErr = Object.assign(new Error('spawn sh EIO'), { code: 'EIO' });
    mockExec.mockRejectedValue(spawnErr);
    const ctx = makeCtx({ exec: mockExec } as Partial<VerificationContext>);
    await expect(runScriptVerification(ctx, 'check.sh', '/tmp/contract')).rejects.toBe(spawnErr);
  });

  it('⑦c script 非零退出仍是真实否决', async () => {
    const err = new ProcessExecError({ message: 'sh failed', output: 'first bad line', exitCode: 1 });
    mockExec.mockRejectedValue(err);
    const ctx = makeCtx({ exec: mockExec } as Partial<VerificationContext>);
    const result = await runScriptVerification(ctx, 'check.sh', '/tmp/contract');
    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('first bad line');
  });

  it('⑦d LLM 调用异常（provider all-failed）上抛而非 passed:false', async () => {
    const contractDir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'phase1934-llm-'));
    cleanups.push(contractDir);
    nodeFs.writeFileSync(path.join(contractDir, 'prompt.md'), '{{evidence}}');
    const providerErr = new Error('all providers failed');
    const ctx = makeCtx({
      fs: new NodeFileSystem({ baseDir: contractDir }),
      clawDir: contractDir,
      llm: {} as VerificationContext['llm'],
      runVerifierWithCancel: vi.fn().mockRejectedValue(providerErr),
    });
    await expect(
      runLLMVerification(ctx, 'prompt.md', contractDir, 'c1' as any, 'st1' as any, 'desc', 'evidence', []),
    ).rejects.toBe(providerErr);
  });

  it('⑦e prompt 读取 I/O 故障上抛；ENOENT 仍为确定性配置反馈', async () => {
    const contractDir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'phase1934-llm-io-'));
    cleanups.push(contractDir);
    nodeFs.writeFileSync(path.join(contractDir, 'prompt.md'), '{{evidence}}');
    const base = new NodeFileSystem({ baseDir: contractDir });
    const eioErr = Object.assign(new Error('read EIO'), { code: 'EIO' });
    const failingFs = {
      ...base,
      realpathSync: base.realpathSync.bind(base),
      read: vi.fn().mockRejectedValue(eioErr),
    } as unknown as FileSystem;
    const ctx = makeCtx({
      fs: failingFs,
      clawDir: contractDir,
      llm: {} as VerificationContext['llm'],
    });
    await expect(
      runLLMVerification(ctx, 'prompt.md', contractDir, 'c1' as any, 'st1' as any, 'desc', 'evidence', []),
    ).rejects.toBe(eioErr);

    const ctxMissing = makeCtx({
      fs: new NodeFileSystem({ baseDir: contractDir }),
      clawDir: contractDir,
      llm: {} as VerificationContext['llm'],
    });
    const result = await runLLMVerification(ctxMissing, 'missing.md', contractDir, 'c1' as any, 'st1' as any, 'desc', 'evidence', []);
    expect(result.passed).toBe(false);
  });
});

// ─── boot replay：真实 ContractSystem + 真实 fs ───

describe('boot replay of execution_unavailable outcomes', () => {
  let clawDir: string;

  async function setup() {
    const tempDir = await createTempDir('phase1934-unavailable-');
    cleanups.push(tempDir);
    clawDir = path.join(tempDir, 'claws', 'test-claw');
    await fsp.mkdir(clawDir, { recursive: true });
  }

  function makeManager(audit: any) {
    return new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: new NodeFileSystem({ baseDir: clawDir }),
      audit,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      clawsDir: '/tmp/test/claws',
      notifyClaw: vi.fn(),
    });
  }

  const CONTRACT_ID = 'c-unavail';

  async function seedActiveContract() {
    const activeRoot = path.join(clawDir, 'contract', 'active', CONTRACT_ID);
    await fsp.mkdir(activeRoot, { recursive: true });
    await fsp.writeFile(
      path.join(activeRoot, 'contract.yaml'),
      [
        'schema_version: 1',
        `id: ${CONTRACT_ID}`,
        'title: Unavailable Replay',
        'goal: Test',
        'subtasks:',
        '  - id: st1',
        '    description: S1',
        '  - id: st2',
        '    description: S2',
        '',
      ].join('\n'),
    );
    await fsp.writeFile(
      path.join(activeRoot, 'progress.json'),
      JSON.stringify(
        {
          schema_version: 1,
          subtasks: {
            st1: { status: 'in_progress', verification_attempt_id: 'att-1' },
            st2: { status: 'todo' },
          },
          started_at: '2026-10-10T00:00:00.000Z',
        },
        null,
        2,
      ),
    );
  }

  async function writeUnavailableOutcome() {
    const dir = path.join(clawDir, 'contract', 'verification-outcomes', CONTRACT_ID);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      path.join(dir, 'att-1.json'),
      JSON.stringify(
        {
          schema_version: 1,
          contract_id: CONTRACT_ID,
          subtask_id: 'st1',
          attempt_id: 'att-1',
          completed_at: '2026-10-10T01:00:00.000Z',
          kind: 'execution_unavailable',
          error: { message: 'all providers failed', name: 'Error' },
        },
        null,
        2,
      ),
    );
  }

  async function readSt1() {
    const progress = JSON.parse(
      await fsp.readFile(path.join(clawDir, 'contract', 'active', CONTRACT_ID, 'progress.json'), 'utf-8'),
    );
    return progress.subtasks.st1;
  }

  it('⑤ outcome 已写未 apply → boot 一次收敛为 todo、零拒绝预算；duplicate boot 幂等', async () => {
    await setup();
    await seedActiveContract();
    await writeUnavailableOutcome();

    const first = makeAudit();
    await makeManager(first.audit).init();

    const st1 = await readSt1();
    expect(st1.status).toBe('todo');
    expect(st1.retry_count).toBeUndefined();
    expect(st1.force_accepted).toBeUndefined();
    expect(st1.last_failed_feedback).toBeUndefined();
    expect(st1.verification_attempt_id).toBeUndefined();

    const replay1 = first.events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.VERIFICATION_OUTCOME_REPLAY);
    expect(replay1).toHaveLength(1);
    expect(replay1[0]).toContainEqual('result=replayed');
    expect(replay1[0]).toContainEqual('outcome_kind=execution_unavailable');

    // durable fact 保留。
    await fsp.access(path.join(clawDir, 'contract', 'verification-outcomes', CONTRACT_ID, 'att-1.json'));

    // duplicate boot：already_applied，progress 不变。
    const afterFirst = await fsp.readFile(
      path.join(clawDir, 'contract', 'active', CONTRACT_ID, 'progress.json'), 'utf-8',
    );
    const second = makeAudit();
    await makeManager(second.audit).init();
    const afterSecond = await fsp.readFile(
      path.join(clawDir, 'contract', 'active', CONTRACT_ID, 'progress.json'), 'utf-8',
    );
    expect(afterSecond).toBe(afterFirst);
    const replay2 = second.events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.VERIFICATION_OUTCOME_REPLAY);
    expect(replay2).toHaveLength(1);
    expect(replay2[0]).toContainEqual('result=already_applied');
  });
});
