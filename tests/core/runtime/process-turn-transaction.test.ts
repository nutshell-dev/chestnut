/**
 * Phase 1158 Step B: Runtime.processTurn transaction total-result tests.
 *
 * 验证 begin/save/react/commit/rollback 全路径失败均收敛为 TurnResult，
 * 不使 processTurn reject；rollback 失败时保留 original + recovery 双因果。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { Runtime } from '../../../src/core/runtime/index.js';
import type { RuntimeOptions } from '../../../src/core/runtime/types.js';
import type { ToolDefinition } from '../../../src/foundation/llm-provider/types.js';
import type { Message } from '../../../src/foundation/dialog-store/index.js';
import { StepAbortError } from '../../../src/core/step-executor/index.js';

class TransactionTestRuntime extends Runtime {
  public reactError: Error | null = null;

  constructor(options: RuntimeOptions) {
    super(options);
  }

  override async initialize(): Promise<void> {
    // no-op: tests inject deps directly
  }

  protected override async _runReact(_messages: Message[], _systemPrompt: string, _tools: ToolDefinition[]): Promise<void> {
    if (this.reactError) throw this.reactError;
  }
}

function createMockSessionManager() {
  return {
    beginTurn: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue({ blockIndexPersisted: true, assignedBlockIds: [] }),
    commitTurn: vi.fn().mockResolvedValue(undefined),
    rollbackTurn: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue({ source: 'current', session: { messages: [], systemPrompt: 'sp' } }),
  };
}

function createMockDeps() {
  return {
    systemFs: {} as unknown as import('../../../src/foundation/fs/types.js').FileSystem,
    auditWriter: { write: vi.fn() } as unknown as import('../../../src/foundation/audit/types.js').AuditLog,
    snapshot: {
      commit: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as import('../../../src/foundation/snapshot/index.js').Snapshot,
    sessionManager: createMockSessionManager() as unknown as import('../../../src/foundation/dialog-store/index.js').DialogStore,
    inboxReader: {} as unknown as import('../../../src/foundation/messaging/index.js').InboxReader,
    llm: {
      resetLastSuccessProvider: vi.fn(),
      getFailureDisposition: vi.fn().mockReturnValue('unknown'),
      getProviderInfo: vi.fn().mockReturnValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as import('../../../src/foundation/llm-orchestrator/index.js').LLMOrchestrator,
    toolRegistry: {} as unknown as import('../../../src/foundation/tools/index.js').ToolRegistry,
    toolExecutor: {} as unknown as import('../../../src/foundation/tools/index.js').IToolExecutor,
    contractManager: { setOnNotify: vi.fn(), close: vi.fn().mockResolvedValue(undefined) } as unknown as import('../../../src/core/contract/index.js').ContractSystem,
    taskSystem: { shutdown: vi.fn().mockResolvedValue({ kind: 'converged', aborted: 0, terminal: [] }), abort: vi.fn(), initialize: vi.fn().mockResolvedValue(undefined), startDispatch: vi.fn().mockResolvedValue(undefined) } as unknown as import('../../../src/core/async-task-system/index.js').AsyncTaskRuntimeLifecycle,
    skillRegistry: {} as unknown as import('../../../src/foundation/skill-system/index.js').SkillSystem,
    permissionChecker: {} as unknown as import('../../../src/foundation/tool-protocol/index.js').PermissionChecker,
    fsFactory: (dir: string) => ({} as unknown as import('../../../src/foundation/fs/types.js').FileSystem),
    dialogStoreFactory: () => createMockSessionManager() as unknown as import('../../../src/foundation/dialog-store/index.js').DialogStore,
    formatterRegistry: { resolve: () => undefined } as unknown as import('../../../src/foundation/messaging/index.js').InboxMessageRenderingResolver,
  };
}

describe('processTurn transaction total-result (phase 1158 step B)', () => {
  let testTempDir: string;
  let testClawDir: string;

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    testTempDir = path.join(tmpdir(), `chestnut-process-turn-${randomUUID()}`);
    testClawDir = path.join(testTempDir, 'claws', 'txn-claw');
    await fs.mkdir(testClawDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testTempDir, { recursive: true, force: true }).catch(() => { /* silent cleanup */ });
  });

  function makeRuntime(sessionExtra?: Record<string, unknown>) {
    const deps = createMockDeps();
    if (sessionExtra) Object.assign(deps.sessionManager as object, sessionExtra);
    const runtime = new TransactionTestRuntime({
      clawId: 'txn-claw',
      clawDir: testClawDir,
      llmConfig: { provider: 'mock', model: 'mock', apiKey: 'test' },
      idleTimeoutMs: 0,
      dependencies: deps,
    } as unknown as RuntimeOptions);
    (runtime as any).initialized = true;
    (runtime as any).auditWriter = deps.auditWriter;
    (runtime as any).sessionManager = deps.sessionManager;
    (runtime as any).snapshot = deps.snapshot;
    (runtime as any).llm = deps.llm;
    (runtime as any).execContext = { trace_id: undefined, signal: undefined };
    return { runtime, deps };
  }

  it('success path: commitTurn called, returns {status:success}', async () => {
    const { runtime, deps } = makeRuntime();
    const result = await runtime.processTurn([{ role: 'user', content: 'hi' }], 'sp', []);

    expect(result.status).toBe('success');
    expect((deps.sessionManager as any).beginTurn).toHaveBeenCalledTimes(1);
    expect((deps.sessionManager as any).save).toHaveBeenCalledTimes(1);
    expect((deps.sessionManager as any).commitTurn).toHaveBeenCalledTimes(1);
    expect((deps.sessionManager as any).rollbackTurn).not.toHaveBeenCalled();
    expect((deps.snapshot as any).commit).toHaveBeenCalledWith(expect.stringContaining('outcome=success'));
  });

  it('beginTurn reject -> {status:failed, error:beginError}, rollback once', async () => {
    const { runtime, deps } = makeRuntime();
    const beginError = new Error('begin failed');
    (deps.sessionManager as any).beginTurn.mockRejectedValue(beginError);

    const result = await runtime.processTurn([{ role: 'user', content: 'hi' }], 'sp', []);

    expect(result.status).toBe('failed');
    expect(result.error).toBe(beginError);
    expect((deps.sessionManager as any).rollbackTurn).toHaveBeenCalledTimes(1);
    expect((deps.sessionManager as any).rollbackTurn).toHaveBeenCalledWith('begin failed');
    expect((deps.sessionManager as any).commitTurn).not.toHaveBeenCalled();
    expect((deps.snapshot as any).commit).toHaveBeenCalledWith(expect.stringContaining('outcome=failed'));
  });

  it('initial save reject -> {status:failed, error:saveError}, rollback once', async () => {
    const { runtime, deps } = makeRuntime();
    const saveError = new Error('save failed');
    (deps.sessionManager as any).save.mockRejectedValue(saveError);

    const result = await runtime.processTurn([{ role: 'user', content: 'hi' }], 'sp', []);

    expect(result.status).toBe('failed');
    expect(result.error).toBe(saveError);
    expect((deps.sessionManager as any).rollbackTurn).toHaveBeenCalledTimes(1);
    expect((deps.sessionManager as any).rollbackTurn).toHaveBeenCalledWith('save failed');
    expect((deps.sessionManager as any).commitTurn).not.toHaveBeenCalled();
  });

  it('react error -> {status:failed, error:reactError}, rollback once', async () => {
    const { runtime, deps } = makeRuntime();
    const reactError = new Error('react failed');
    runtime.reactError = reactError;

    const result = await runtime.processTurn([{ role: 'user', content: 'hi' }], 'sp', []);

    expect(result.status).toBe('failed');
    expect(result.error).toBe(reactError);
    expect((deps.sessionManager as any).rollbackTurn).toHaveBeenCalledTimes(1);
    expect((deps.sessionManager as any).commitTurn).not.toHaveBeenCalled();
  });

  it('rollbackTurn reject -> AggregateError([original, rollbackError])', async () => {
    const { runtime, deps } = makeRuntime();
    const original = new Error('react failed');
    const rollbackError = new Error('rollback failed');
    runtime.reactError = original;
    (deps.sessionManager as any).rollbackTurn.mockRejectedValue(rollbackError);

    const result = await runtime.processTurn([{ role: 'user', content: 'hi' }], 'sp', []);

    expect(result.status).toBe('failed');
    expect(result.error).toBeInstanceOf(AggregateError);
    const aggregate = result.error as AggregateError;
    expect([...aggregate.errors]).toEqual([original, rollbackError]);
    expect(aggregate.message).toBe('Turn failed and dialog rollback also failed');
    expect(aggregate.cause).toBe(original);
  });

  it('UserInterrupt -> commitTurn(user_interrupt) -> {status:interrupted}', async () => {
    const { runtime, deps } = makeRuntime();
    runtime.reactError = new StepAbortError({ kind: 'user_interrupt' });

    const result = await runtime.processTurn([{ role: 'user', content: 'hi' }], 'sp', []);

    expect(result.status).toBe('interrupted');
    expect(result.cause).toBe('user_interrupt');
    expect((deps.sessionManager as any).commitTurn).toHaveBeenCalledTimes(1);
    expect((deps.sessionManager as any).commitTurn).toHaveBeenCalledWith('user_interrupt');
    expect((deps.sessionManager as any).rollbackTurn).not.toHaveBeenCalled();
    expect((deps.snapshot as any).commit).toHaveBeenCalledWith(expect.stringContaining('outcome=interrupted'));
  });

  it('IdleTimeoutSignal -> commitTurn(idle_timeout) -> {status:interrupted}', async () => {
    const { runtime, deps } = makeRuntime();
    runtime.reactError = new StepAbortError({ kind: 'idle_timeout', ms: 30000 });

    const result = await runtime.processTurn([{ role: 'user', content: 'hi' }], 'sp', []);

    expect(result.status).toBe('interrupted');
    expect(result.cause).toBe('idle_timeout');
    expect((deps.sessionManager as any).commitTurn).toHaveBeenCalledTimes(1);
    expect((deps.sessionManager as any).commitTurn).toHaveBeenCalledWith('idle_timeout');
    expect((deps.sessionManager as any).rollbackTurn).not.toHaveBeenCalled();
  });

  it('PriorityInboxInterrupt -> commitTurn(priority_inbox) -> {status:interrupted}', async () => {
    const { runtime, deps } = makeRuntime();
    runtime.reactError = new StepAbortError({ kind: 'step_yield' });

    const result = await runtime.processTurn([{ role: 'user', content: 'hi' }], 'sp', []);

    expect(result.status).toBe('interrupted');
    expect(result.cause).toBe('priority_inbox');
    expect((deps.sessionManager as any).commitTurn).toHaveBeenCalledTimes(1);
    expect((deps.sessionManager as any).commitTurn).toHaveBeenCalledWith('priority_inbox');
    expect((deps.sessionManager as any).rollbackTurn).not.toHaveBeenCalled();
  });

  it('interrupt commit fails -> rollback with AggregateError([interrupt, commitError])', async () => {
    const { runtime, deps } = makeRuntime();
    const interrupt = new StepAbortError({ kind: 'user_interrupt' });
    const commitError = new Error('commit failed');
    runtime.reactError = interrupt;
    (deps.sessionManager as any).commitTurn.mockRejectedValue(commitError);

    const result = await runtime.processTurn([{ role: 'user', content: 'hi' }], 'sp', []);

    expect(result.status).toBe('failed');
    expect(result.error).toBeInstanceOf(AggregateError);
    const aggregate = result.error as AggregateError;
    expect(aggregate.errors[0]).toBe(interrupt);
    expect(aggregate.errors[1]).toBe(commitError);
    expect(aggregate.message).toBe('Interrupted turn commit failed');
    expect(aggregate.cause).toBe(interrupt);
    expect((deps.sessionManager as any).rollbackTurn).toHaveBeenCalledTimes(1);
  });

  it('processTurn never rejects for transaction errors', async () => {
    const { runtime, deps } = makeRuntime();
    (deps.sessionManager as any).beginTurn.mockRejectedValue(new Error('begin boom'));
    (deps.sessionManager as any).save.mockRejectedValue(new Error('save boom'));
    (deps.sessionManager as any).commitTurn.mockRejectedValue(new Error('commit boom'));
    (deps.sessionManager as any).rollbackTurn.mockRejectedValue(new Error('rollback boom'));

    await expect(runtime.processTurn([{ role: 'user', content: 'hi' }], 'sp', [])).resolves.toMatchObject({ status: 'failed' });
  });

  // ---------------------------------------------------------------------------
  // Phase 1944 Step B: 失败出口携带 LLM owner 的 typed failureDisposition
  // ---------------------------------------------------------------------------

  it('failed turn carries owner failureDisposition alongside the preserved original error', async () => {
    const { runtime, deps } = makeRuntime();
    const reactError = new Error('llm boom');
    runtime.reactError = reactError;
    (deps.llm as any).getFailureDisposition.mockReturnValue('provider_recovery_scheduled');

    const result = await runtime.processTurn([{ role: 'user', content: 'hi' }], 'sp', []);

    expect(result.status).toBe('failed');
    expect(result.error).toBe(reactError);  // 原始错误对象不替换、不摘要
    expect(result.failureDisposition).toBe('provider_recovery_scheduled');
    expect((deps.llm as any).getFailureDisposition).toHaveBeenCalledWith(reactError);
  });

  it('rollback failure keeps AggregateError 双因果 and disposition still describes the original error', async () => {
    const { runtime, deps } = makeRuntime();
    const original = new Error('react failed');
    const rollbackError = new Error('rollback failed');
    runtime.reactError = original;
    (deps.sessionManager as any).rollbackTurn.mockRejectedValue(rollbackError);
    (deps.llm as any).getFailureDisposition.mockReturnValue('provider_recovery_scheduled');

    const result = await runtime.processTurn([{ role: 'user', content: 'hi' }], 'sp', []);

    expect(result.status).toBe('failed');
    expect(result.error).toBeInstanceOf(AggregateError);
    const aggregate = result.error as AggregateError;
    expect([...aggregate.errors]).toEqual([original, rollbackError]);
    expect(aggregate.cause).toBe(original);
    // disposition 只描述主失败（包装前求值），不描述 rollback 附加错误
    expect(result.failureDisposition).toBe('provider_recovery_scheduled');
    expect((deps.llm as any).getFailureDisposition).toHaveBeenCalledWith(original);
    expect((deps.llm as any).getFailureDisposition).not.toHaveBeenCalledWith(aggregate);
  });

  it('non-LLM failure maps to unknown disposition via the capability', async () => {
    const { runtime, deps } = makeRuntime();
    runtime.reactError = new Error('plain crash');
    (deps.llm as any).getFailureDisposition.mockReturnValue('unknown');

    const result = await runtime.processTurn([{ role: 'user', content: 'hi' }], 'sp', []);

    expect(result.status).toBe('failed');
    expect(result.failureDisposition).toBe('unknown');
  });

  // ---------------------------------------------------------------------------
  // Phase 1955 Step C: provider 失败保留已完成 step
  // ---------------------------------------------------------------------------

  function makeTurnRecovery(commitResult: unknown) {
    return {
      recordLlmResponse: vi.fn().mockResolvedValue(undefined),
      recordToolStarted: vi.fn().mockResolvedValue(undefined),
      recordToolResult: vi.fn().mockResolvedValue(undefined),
      checkpointTurn: vi.fn().mockResolvedValue(undefined),
      commitPartial: vi.fn().mockResolvedValue(commitResult),
    };
  }

  it('provider failure + checkpoint -> commitPartial，不回滚，preservedCheckpoint=true', async () => {
    const turnRecovery = makeTurnRecovery(true);
    const { runtime, deps } = makeRuntime({ turnRecovery });
    const original = new Error('llm boom');
    runtime.reactError = original;
    (deps.llm as any).getFailureDisposition.mockReturnValue('provider_recovery_scheduled');

    const result = await runtime.processTurn([{ role: 'user', content: 'hi' }], 'sp', []);

    expect(result.status).toBe('failed');
    expect(result.preservedCheckpoint).toBe(true);
    expect(result.failureDisposition).toBe('provider_recovery_scheduled');
    expect(turnRecovery.commitPartial).toHaveBeenCalledWith(
      'turn_failure:provider_recovery_scheduled',
    );
    expect((deps.sessionManager as any).rollbackTurn).not.toHaveBeenCalled();
  });

  it('provider failure 无 checkpoint -> commitPartial=false，仍回落 rollback', async () => {
    const turnRecovery = makeTurnRecovery(false);
    const { runtime, deps } = makeRuntime({ turnRecovery });
    const original = new Error('llm boom');
    runtime.reactError = original;
    (deps.llm as any).getFailureDisposition.mockReturnValue('provider_recovery_scheduled');

    const result = await runtime.processTurn([{ role: 'user', content: 'hi' }], 'sp', []);

    expect(result.status).toBe('failed');
    expect(result.preservedCheckpoint).toBeUndefined();
    expect((deps.sessionManager as any).rollbackTurn).toHaveBeenCalledTimes(1);
  });

  it('checkpoint commit 失败 -> 回落 rollback 并保留双因果', async () => {
    const checkpointError = new Error('checkpoint write failed');
    const turnRecovery = makeTurnRecovery(false);
    turnRecovery.commitPartial.mockRejectedValue(checkpointError);
    const { runtime, deps } = makeRuntime({ turnRecovery });
    const original = new Error('llm boom');
    runtime.reactError = original;
    (deps.llm as any).getFailureDisposition.mockReturnValue('provider_recovery_scheduled');

    const result = await runtime.processTurn([{ role: 'user', content: 'hi' }], 'sp', []);

    expect(result.status).toBe('failed');
    expect(result.error).toBeInstanceOf(AggregateError);
    const aggregate = result.error as AggregateError;
    expect([...aggregate.errors]).toEqual([original, checkpointError]);
    expect(aggregate.message).toBe('Turn failed and checkpoint commit failed; dialog rolled back');
    expect((deps.sessionManager as any).rollbackTurn).toHaveBeenCalledTimes(1);
  });

  it('非可恢复失败（unknown）不调用 commitPartial，走 rollback', async () => {
    const turnRecovery = makeTurnRecovery(true);
    const { runtime, deps } = makeRuntime({ turnRecovery });
    runtime.reactError = new Error('plain crash');
    (deps.llm as any).getFailureDisposition.mockReturnValue('unknown');

    const result = await runtime.processTurn([{ role: 'user', content: 'hi' }], 'sp', []);

    expect(result.status).toBe('failed');
    expect(turnRecovery.commitPartial).not.toHaveBeenCalled();
    expect((deps.sessionManager as any).rollbackTurn).toHaveBeenCalledTimes(1);
  });

  it('Runtime.getLLMFailureDisposition forwards the capability fact (post-drain 查询面)', () => {
    const { runtime, deps } = makeRuntime();
    const err = new Error('post drain boom');
    (deps.llm as any).getFailureDisposition.mockReturnValue('provider_recovery_scheduled');

    expect(runtime.getLLMFailureDisposition(err)).toBe('provider_recovery_scheduled');
    expect((deps.llm as any).getFailureDisposition).toHaveBeenCalledWith(err);
  });
});
