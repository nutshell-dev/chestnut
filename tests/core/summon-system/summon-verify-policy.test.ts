/**
 * SummonVerifyPolicy unit tests (phase 240 rewrite of phase 230 follow-up,
 * phase 281 Step B migrate from SummonStateStore to SubAgentTask.summonDecision metadata).
 *
 * Phase 1396 Step K: decision 版本化。
 * - v2 (active): 固定 no-verification；executor 只取 ctx.clawDir；缺失为 invariant failure。
 * - Unknown schema_version: fail-observable，不降级成 pass-through。
 *
 * Phase 1402 Step A: decision 缺失时按 canonical post-processor 识别当前 summon task：
 * - decision 缺失 + postProcessor === SUMMON_CONTRACT_EXTRACT_POSTPROCESSOR_NAME → 当前 policy；
 * - decision 缺失 + 无/其他 post-processor → 非 summon pass-through。
 *
 * Phase 1890 Step E: legacy v1/v2 decision 读层删除（存量废弃）；task 上仍带
 * summonDecision（v1/v2/未知版本）一律按 unknown 版本 fail-observable + fail-closed。
 */

import { describe, it, expect, vi } from 'vitest';
import { createSummonVerifyPolicy } from '../../../src/core/summon-system/summon-verify-policy.js';
import { SUMMON_CONTRACT_EXTRACT_POSTPROCESSOR_NAME } from '../../../src/core/summon-system/post-processors/contract-extract.js';
import { ContractCreatePolicyViolationError } from '../../../src/core/contract/types.js';
import type { CreatePolicyContext } from '../../../src/core/contract/types.js';
import { SUMMON_AUDIT_EVENTS } from '../../../src/core/summon-system/audit-events.js';
import { makeFullTaskId, type TaskId, type SubAgentTask } from '../../../src/core/async-task-system/types.js';
import type { ContractYaml } from '../../../src/core/contract/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import {
  SummonContractAlreadyClaimedError,
  type SummonCreationClaim,
  type SummonCreationClaimInput,
  type SummonCreationClaimStore,
} from '../../../src/core/summon-system/creation-claim-store.js';

type SummonDecisionV2 = { schema_version: 2; dispatchedAt: string };
type LegacySummonDecisionV1 = { schema_version: 1; mode: 'shadow' | 'mining'; verify: boolean; targetClaw?: string; dispatchedAt: string };

function makeSubAgentTask(
  taskId: string,
  decision?: SummonDecisionV2 | LegacySummonDecisionV1,
  postProcessor?: string,
): SubAgentTask {
  return {
    kind: 'subagent',
    id: makeFullTaskId(taskId),
    mode: 'shadow',
    intent: 'test intent',
    timeoutMs: 1000,
    parentClawId: 'parent-claw',
    createdAt: '2024-01-01T00:00:00.000Z',
    ...(decision ? { summonDecision: decision } : {}),
    ...(postProcessor ? { postProcessor } : {}),
  };
}

function makeLoadTask(
  decision?: SummonDecisionV2 | LegacySummonDecisionV1,
  readImpl?: (taskId: string) => Promise<SubAgentTask | undefined>,
): (taskId: TaskId) => Promise<SubAgentTask | undefined> {
  return vi.fn().mockImplementation(async (taskId: string) => {
    if (readImpl) return readImpl(taskId);
    if (!decision) return undefined;
    return makeSubAgentTask(taskId, decision);
  });
}

/** In-memory claim store fake，语义与 durable store 一致（fresh/same/conflict）。 */
function makeClaimStore(): {
  claimStore: SummonCreationClaimStore;
  claimSpy: ReturnType<typeof vi.fn>;
  claims: Map<string, SummonCreationClaim>;
} {
  const claims = new Map<string, SummonCreationClaim>();
  const claimSpy = vi.fn(async (input: SummonCreationClaimInput) => {
    const existing = claims.get(input.summonId);
    if (existing) {
      if (
        existing.targetExecutorId === input.targetExecutorId &&
        existing.contractId === input.contractId
      ) {
        return { kind: 'same_claim' as const, claim: existing };
      }
      throw new SummonContractAlreadyClaimedError(existing, input);
    }
    const claim: SummonCreationClaim = {
      schema_version: 1,
      ...input,
      claimedAt: '2024-01-01T00:00:00.000Z',
    };
    claims.set(input.summonId, claim);
    return { kind: 'claimed' as const, claim };
  });
  const claimStore: SummonCreationClaimStore = {
    claim: claimSpy,
    read: async (summonId: string) => claims.get(summonId),
  };
  return { claimStore, claimSpy, claims };
}

function makeAudit(): {
  audit: AuditLog;
  writes: Array<(string | number)[]>;
} {
  const writes: Array<(string | number)[]> = [];
  const audit: AuditLog = {
    __brand: 'AuditLog',
    write: (type: string, ...cols: (string | number)[]) => {
      writes.push([type, ...cols]);
    },
    preview: (s: string) => s,
    message: (s: string) => s,
    summary: (s: string) => s,
  } as unknown as AuditLog;
  return { audit, writes };
}

function makeContract(verification?: ContractYaml['verification']): ContractYaml {
  return {
    schema_version: 1,
    title: 'test',
    goal: 'test',
    subtasks: [{ id: 'a', description: 'do it' }],
    verification,
  };
}

function makeCtx(over?: Partial<CreatePolicyContext>): CreatePolicyContext {
  return { proposedContractId: 'cand-1', ...over };
}

function makeV2Decision(over?: Partial<SummonDecisionV2>): SummonDecisionV2 {
  return { schema_version: 2, dispatchedAt: '2024-01-01T00:00:00.000Z', ...over };
}

function makeV1Decision(over?: Partial<LegacySummonDecisionV1>): LegacySummonDecisionV1 {
  return {
    schema_version: 1,
    mode: 'shadow',
    verify: false,
    dispatchedAt: '2024-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('SummonVerifyPolicy (phase 240 / phase 1396 Step K)', () => {
  describe('pass-through paths (no decision read or no violation)', () => {
    it('subagentTaskId undefined → no-op pass, loadTask not called', async () => {
      const loadTask = makeLoadTask(makeV2Decision());
      const { audit } = makeAudit();
      const { claimStore, claimSpy } = makeClaimStore();
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit, claimStore });
      await expect(
        policy.check(makeCtx(), makeContract([{ subtask_id: 'a', type: 'llm' }])),
      ).resolves.toBeUndefined();
      expect(loadTask).not.toHaveBeenCalled();
      expect(claimSpy).not.toHaveBeenCalled();
    });

    it('task.summonDecision undefined + no postProcessor → audit SUMMON_GATE_NO_DECISION + pass-through', async () => {
      // Phase 1396 Step M: loader 可靠返回 task 且 metadata 缺失 = 普通 subagent → pass-through。
      const loadTask = makeLoadTask(undefined, async (id) => makeSubAgentTask(id));
      const { audit, writes } = makeAudit();
      const { claimStore, claimSpy } = makeClaimStore();
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit, claimStore });
      await expect(
        policy.check(
          makeCtx({ subagentTaskId: 'a1100001-0000-4000-8000-000000000000', clawDir: 'any-claw' }),
          makeContract([{ subtask_id: 'a', type: 'llm' }]),
        ),
      ).resolves.toBeUndefined();
      expect(claimSpy).not.toHaveBeenCalled();
      expect(writes).toContainEqual([
        SUMMON_AUDIT_EVENTS.SUMMON_GATE_NO_DECISION,
        'subagentTaskId=a1100001-0000-4000-8000-000000000000',
        'reason=likely_non_summon_subagent',
      ]);
    });

    it('no decision + non-canonical postProcessor → pass-through (generic name not interpreted)', async () => {
      // Phase 1402 Step A: decision 缺失时只有 canonical summon post-processor 进入 summon policy；
      // 其他 opaque post-processor 名字仍是非 summon pass-through。
      const loadTask = makeLoadTask(undefined, async (id) =>
        makeSubAgentTask(id, undefined, 'some-other-postprocessor'),
      );
      const { audit, writes } = makeAudit();
      const { claimStore, claimSpy } = makeClaimStore();
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit, claimStore });
      await expect(
        policy.check(
          makeCtx({ subagentTaskId: 'a1100001-0000-4000-8000-000000000000', clawDir: 'any-claw' }),
          makeContract([{ subtask_id: 'a', type: 'llm' }]),
        ),
      ).resolves.toBeUndefined();
      expect(claimSpy).not.toHaveBeenCalled();
      expect(writes).toContainEqual([
        SUMMON_AUDIT_EVENTS.SUMMON_GATE_NO_DECISION,
        'subagentTaskId=a1100001-0000-4000-8000-000000000000',
        'reason=likely_non_summon_subagent',
      ]);
    });

    it('loader reliably returns undefined → fail-closed summon_task_not_found, no claim', async () => {
      // Phase 1396 Step M: task 不存在 = summon 状态不可判定，不得假定非 summon 放行。
      const loadTask = makeLoadTask(undefined, async () => undefined);
      const { audit, writes } = makeAudit();
      const { claimStore, claimSpy } = makeClaimStore();
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit, claimStore });
      await expect(
        policy.check(
          makeCtx({ subagentTaskId: 'a1100001-0000-4000-8000-000000000000', clawDir: 'any-claw' }),
          makeContract([{ subtask_id: 'a', type: 'llm' }]),
        ),
      ).rejects.toMatchObject({
        name: 'ContractCreatePolicyViolationError',
        cause: 'summon_task_not_found',
      });
      expect(claimSpy).not.toHaveBeenCalled();
      expect(writes).toContainEqual([
        SUMMON_AUDIT_EVENTS.SUMMON_GATE_NO_DECISION,
        'subagentTaskId=a1100001-0000-4000-8000-000000000000',
        'reason=task_not_found',
      ]);
    });

    it.each([
      ['generic error', new Error('boom')],
      ['EACCES I/O error', Object.assign(new Error('permission denied'), { code: 'EACCES' })],
      ['corrupt JSON', new SyntaxError('Unexpected token')],
      ['future task schema', new Error('unsupported schema_version 99')],
    ])('loadTask throws (%s) → audit SUMMON_STATE_READ_FAILED + fail-closed summon_state_unavailable', async (_label, thrown) => {
      // Phase 1396 Step M: 读失败 fail-closed，不得 pass-through；claim 不得写入。
      const loadTask = makeLoadTask(undefined, async () => { throw thrown; });
      const { audit, writes } = makeAudit();
      const { claimStore, claimSpy } = makeClaimStore();
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit, claimStore });
      await expect(
        policy.check(
          makeCtx({ subagentTaskId: 'a1100001-0000-4000-8000-000000000000', clawDir: 'any-claw' }),
          makeContract([{ subtask_id: 'a', type: 'llm' }]),
        ),
      ).rejects.toMatchObject({
        name: 'ContractCreatePolicyViolationError',
        cause: 'summon_state_unavailable',
      });
      expect(claimSpy).not.toHaveBeenCalled();
      const failedAudit = writes.find(w => w[0] === SUMMON_AUDIT_EVENTS.SUMMON_STATE_READ_FAILED);
      expect(failedAudit).toBeDefined();
      expect(failedAudit).toEqual([
        SUMMON_AUDIT_EVENTS.SUMMON_STATE_READ_FAILED,
        'taskId=a1100001-0000-4000-8000-000000000000',
        expect.stringContaining(String(thrown.message)),
      ]);
    });
  });

  describe('decision present → fail-closed（phase 1890 Step E：legacy v1/v2 读层删除）', () => {
    it.each([
      ['legacy v1', () => makeV1Decision({ targetClaw: 'my-claw' }), 'schema_version=1'],
      ['legacy v2', () => makeV2Decision(), 'schema_version=2'],
      ['unknown v3', () => ({ schema_version: 3, dispatchedAt: '2024-01-01T00:00:00.000Z' } as unknown as SummonDecisionV2), 'schema_version=3'],
    ])('%s decision → audit + summon_unknown_schema_version，不写 claim', async (_label, makeDecision, versionCol) => {
      const loadTask = makeLoadTask(makeDecision());
      const { audit, writes } = makeAudit();
      const { claimStore, claimSpy } = makeClaimStore();
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit, claimStore });

      const err = await policy
        .check(makeCtx({ subagentTaskId: 'a1100001-0000-4000-8000-000000000000', clawDir: 'my-claw' }), makeContract())
        .catch(e => e);

      expect(err).toBeInstanceOf(ContractCreatePolicyViolationError);
      expect(err).toMatchObject({
        policyName: 'summon-verify',
        cause: 'summon_unknown_schema_version',
      });
      expect(claimSpy).not.toHaveBeenCalled();
      expect(writes).toContainEqual([
        SUMMON_AUDIT_EVENTS.SUMMON_GATE_UNKNOWN_SCHEMA_VERSION,
        'subagentTaskId=a1100001-0000-4000-8000-000000000000',
        versionCol,
      ]);
    });
  });

  describe('canonical post-processor current path (Phase 1402 Step A, no decision)', () => {
    it('canonical + no decision + no verification + clawDir present → pass and claim', async () => {
      const loadTask = makeLoadTask(undefined, async (id) =>
        makeSubAgentTask(id, undefined, SUMMON_CONTRACT_EXTRACT_POSTPROCESSOR_NAME),
      );
      const { audit } = makeAudit();
      const { claimStore, claimSpy, claims } = makeClaimStore();
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit, claimStore });

      await expect(
        policy.check(makeCtx({ subagentTaskId: 'a1100001-0000-4000-8000-000000000000', clawDir: 'my-claw', proposedContractId: 'cand-1' }), makeContract()),
      ).resolves.toBeUndefined();

      expect(claimSpy).toHaveBeenCalledTimes(1);
      expect(claimSpy).toHaveBeenCalledWith({
        summonId: 'a1100001-0000-4000-8000-000000000000',
        targetExecutorId: 'my-claw',
        contractId: 'cand-1',
      });
      expect(claims.get('a1100001-0000-4000-8000-000000000000')).toMatchObject({ contractId: 'cand-1' });
    });

    it('canonical same candidate retry → same_claim idempotent', async () => {
      const loadTask = makeLoadTask(undefined, async (id) =>
        makeSubAgentTask(id, undefined, SUMMON_CONTRACT_EXTRACT_POSTPROCESSOR_NAME),
      );
      const { audit } = makeAudit();
      const { claimStore } = makeClaimStore();
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit, claimStore });
      const ctx = makeCtx({ subagentTaskId: 'a1100001-0000-4000-8000-000000000000', clawDir: 'my-claw', proposedContractId: 'cand-1' });

      await expect(policy.check(ctx, makeContract())).resolves.toBeUndefined();
      await expect(policy.check(ctx, makeContract())).resolves.toBeUndefined();
    });

    it('canonical second different candidate → typed reject', async () => {
      const loadTask = makeLoadTask(undefined, async (id) =>
        makeSubAgentTask(id, undefined, SUMMON_CONTRACT_EXTRACT_POSTPROCESSOR_NAME),
      );
      const { audit } = makeAudit();
      const { claimStore } = makeClaimStore();
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit, claimStore });

      await policy.check(
        makeCtx({ subagentTaskId: 'a1100001-0000-4000-8000-000000000000', clawDir: 'my-claw', proposedContractId: 'cand-1' }),
        makeContract(),
      );
      const err = await policy
        .check(makeCtx({ subagentTaskId: 'a1100001-0000-4000-8000-000000000000', clawDir: 'my-claw', proposedContractId: 'cand-2' }), makeContract())
        .catch(e => e);

      expect(err).toBeInstanceOf(ContractCreatePolicyViolationError);
      expect(err).toMatchObject({
        policyName: 'summon-verify',
        cause: 'summon_contract_already_claimed',
        details: expect.objectContaining({
          subagentTaskId: 'a1100001-0000-4000-8000-000000000000',
          claimedContractId: 'cand-1',
          requestedContractId: 'cand-2',
        }),
      });
    });

    it('canonical + no decision + verification entries → throw summon_verify_false_violation', async () => {
      const loadTask = makeLoadTask(undefined, async (id) =>
        makeSubAgentTask(id, undefined, SUMMON_CONTRACT_EXTRACT_POSTPROCESSOR_NAME),
      );
      const { audit, writes } = makeAudit();
      const { claimStore, claimSpy } = makeClaimStore();
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit, claimStore });

      const err = await policy
        .check(
          makeCtx({ subagentTaskId: 'a1100001-0000-4000-8000-000000000000', clawDir: 'my-claw' }),
          makeContract([{ subtask_id: 'a', type: 'llm' }]),
        )
        .catch(e => e);

      expect(err).toBeInstanceOf(ContractCreatePolicyViolationError);
      expect(err).toMatchObject({
        policyName: 'summon-verify',
        cause: 'summon_verify_false_violation',
        details: expect.objectContaining({
          subagentTaskId: 'a1100001-0000-4000-8000-000000000000',
          verificationCount: 1,
        }),
      });
      expect(claimSpy).not.toHaveBeenCalled();
      expect(writes).toContainEqual([
        SUMMON_AUDIT_EVENTS.SUMMON_VERIFY_FALSE_VIOLATION,
        'subagentTaskId=a1100001-0000-4000-8000-000000000000',
        'verificationCount=1',
        'reason=v2_no_verification_allowed',
      ]);
    });

    it('canonical + no decision + clawDir missing → throw summon_v2_executor_context_missing', async () => {
      const loadTask = makeLoadTask(undefined, async (id) =>
        makeSubAgentTask(id, undefined, SUMMON_CONTRACT_EXTRACT_POSTPROCESSOR_NAME),
      );
      const { audit, writes } = makeAudit();
      const { claimStore, claimSpy } = makeClaimStore();
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit, claimStore });

      const err = await policy
        .check(makeCtx({ subagentTaskId: 'a1100001-0000-4000-8000-000000000000' }), makeContract())
        .catch(e => e);

      expect(err).toBeInstanceOf(ContractCreatePolicyViolationError);
      expect(err).toMatchObject({
        policyName: 'summon-verify',
        cause: 'summon_v2_executor_context_missing',
      });
      expect(claimSpy).not.toHaveBeenCalled();
      expect(writes).toContainEqual([
        SUMMON_AUDIT_EVENTS.SUMMON_V2_EXECUTOR_CONTEXT_MISSING,
        'subagentTaskId=a1100001-0000-4000-8000-000000000000',
        'reason=no_executor_context',
      ]);
    });

    it('canonical + decision present → fail-closed（decision 不再被解释，phase 1890 Step E）', async () => {
      const loadTask = makeLoadTask(undefined, async (id) =>
        makeSubAgentTask(
          id,
          makeV1Decision({ targetClaw: 'statsvc-auditor' }),
          SUMMON_CONTRACT_EXTRACT_POSTPROCESSOR_NAME,
        ),
      );
      const { audit } = makeAudit();
      const { claimStore, claimSpy } = makeClaimStore();
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit, claimStore });

      const err = await policy
        .check(makeCtx({ subagentTaskId: 'a1100001-0000-4000-8000-000000000000', clawDir: 'gateway-auditor' }), makeContract())
        .catch(e => e);

      expect(err).toBeInstanceOf(ContractCreatePolicyViolationError);
      expect(err).toMatchObject({
        policyName: 'summon-verify',
        cause: 'summon_unknown_schema_version',
      });
      expect(claimSpy).not.toHaveBeenCalled();
    });
  });
});
