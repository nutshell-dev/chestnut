/**
 * SummonVerifyPolicy unit tests (phase 240 rewrite of phase 230 follow-up,
 * phase 281 Step B migrate from SummonStateStore to SubAgentTask.summonDecision metadata).
 *
 * Background: phase 230 introduced ContractCreatePolicy plug-in framework + replaced
 * SummonContractCreateGate with SummonVerifyPolicy; an adapter shim was left behind
 * (commit e242b5e2) and later deleted (commit 281e2abf). The old gate test file
 * (`tests/core/summon-system/contract-create-gate.test.ts`) was left as
 * `describe.skip(...)` with a dead import to mark the follow-up debt.
 *
 * Phase 240 deletes the old test file and replaces it with this one: 13 cases
 * = 12 mapped from the old gate API to the new policy API + 1 new case covering
 * the `read throws → SUMMON_STATE_READ_FAILED + pass-through` path the old tests
 * never exercised.
 *
 * Phase 281 Step B: decision source changed from SummonStateStore.read to
 * loadTask(taskId).summonDecision. Tests now construct a SubAgentTask with
 * optional summonDecision metadata.
 *
 * Phase 1396 Step B: 0/1 creation claim — policy 在 violation 检查通过后调用
 * SummonCreationClaimStore.claim；同候选重试幂等通过，不同候选 typed reject
 * （ContractCreatePolicyViolationError cause='summon_contract_already_claimed'）。
 *
 * Assertion patterns:
 * - Violation cases assert on `policyName` + `cause` + `details` (public fields of
 *   ContractCreatePolicyViolationError), not on the message string — message format
 *   may legitimately change without breaking the contract.
 * - Audit cases use SUMMON_AUDIT_EVENTS constants instead of literal event names.
 */

import { describe, it, expect, vi } from 'vitest';
import { createSummonVerifyPolicy } from '../../../src/core/summon-system/summon-verify-policy.js';
import { ContractCreatePolicyViolationError } from '../../../src/core/contract/types.js';
import type { CreatePolicyContext } from '../../../src/core/contract/types.js';
import { SUMMON_AUDIT_EVENTS } from '../../../src/core/summon-system/audit-events.js';
import { makeTaskId, type TaskId, type SubAgentTask } from '../../../src/core/async-task-system/types.js';
import type { ContractYaml } from '../../../src/core/contract/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import {
  SummonContractAlreadyClaimedError,
  type SummonCreationClaim,
  type SummonCreationClaimInput,
  type SummonCreationClaimStore,
} from '../../../src/core/summon-system/creation-claim-store.js';

type DecisionBody = Omit<NonNullable<SubAgentTask['summonDecision']>, 'schema_version'> & { schema_version?: 1 };

function makeSubAgentTask(
  taskId: string,
  decision?: DecisionBody,
): SubAgentTask {
  return {
    kind: 'subagent',
    id: makeTaskId(taskId),
    mode: 'shadow',
    intent: 'test intent',
    timeoutMs: 1000,
    parentClawId: 'parent-claw',
    createdAt: '2024-01-01T00:00:00.000Z',
    ...(decision ? { summonDecision: { schema_version: 1 as const, ...decision } } : {}),
  };
}

function makeLoadTask(
  decision?: DecisionBody,
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
  const audit = {
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

/** Phase 1396 Step B: CreatePolicyContext 必带 ContractSystem 规范化后的 proposedContractId。 */
function makeCtx(over?: Partial<CreatePolicyContext>): CreatePolicyContext {
  return { proposedContractId: 'cand-1', ...over };
}

function makeBaseDecision(over?: Partial<DecisionBody>): DecisionBody {
  return {
    verify: false,
    mode: 'shadow',
    dispatchedAt: '2024-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('SummonVerifyPolicy (phase 240 rewrite of phase 230 follow-up, phase 281 metadata)', () => {

  describe('pass-through paths (no decision read or no violation)', () => {
    it('subagentTaskId undefined → no-op pass, loadTask not called', async () => {
      const loadTask = makeLoadTask(makeBaseDecision({ verify: false, targetClaw: 'my-claw' }));
      const { audit } = makeAudit();
      const { claimStore, claimSpy } = makeClaimStore();
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit, claimStore });
      await expect(
        policy.check(makeCtx(), makeContract([{ subtask_id: 'a', type: 'llm' }])),
      ).resolves.toBeUndefined();
      expect(loadTask).not.toHaveBeenCalled();
      expect(claimSpy).not.toHaveBeenCalled();
    });

    it('subagentTaskId unset + decision.targetClaw set → pass, loadTask still not called', async () => {
      const loadTask = makeLoadTask(makeBaseDecision({ targetClaw: 'my-claw' }));
      const { audit } = makeAudit();
      const { claimStore } = makeClaimStore();
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit, claimStore });
      await expect(
        policy.check(makeCtx({ clawDir: 'other-claw' }), makeContract()),
      ).resolves.toBeUndefined();
      expect(loadTask).not.toHaveBeenCalled();
    });

    it('verify=false + decision.targetClaw unset + clawDir present → pass (motion 未指定 targetClaw 由子代理自决)', async () => {
      const loadTask = makeLoadTask(makeBaseDecision({ verify: false }));
      const { audit } = makeAudit();
      const { claimStore } = makeClaimStore();
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit, claimStore });
      await expect(
        policy.check(makeCtx({ subagentTaskId: 't1', clawDir: 'any-claw' }), makeContract()),
      ).resolves.toBeUndefined();
    });

    it('verify=true + clawDir mismatch → pass (verify=true 路径不校 target_claw)', async () => {
      const loadTask = makeLoadTask(makeBaseDecision({ verify: true, targetClaw: 'statsvc-auditor' }));
      const { audit } = makeAudit();
      const { claimStore } = makeClaimStore();
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit, claimStore });
      await expect(
        policy.check(makeCtx({ subagentTaskId: 't1', clawDir: 'gateway-auditor' }), makeContract()),
      ).resolves.toBeUndefined();
    });

    it('verify=true + verification non-empty → pass', async () => {
      const loadTask = makeLoadTask(makeBaseDecision({ verify: true }));
      const { audit } = makeAudit();
      const { claimStore } = makeClaimStore();
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit, claimStore });
      await expect(
        policy.check(makeCtx({ subagentTaskId: 't1' }), makeContract([{ subtask_id: 'a', type: 'llm' }])),
      ).resolves.toBeUndefined();
    });

    it('verify=false + verification empty → pass', async () => {
      const loadTask = makeLoadTask(makeBaseDecision({ verify: false }));
      const { audit } = makeAudit();
      const { claimStore } = makeClaimStore();
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit, claimStore });
      await expect(
        policy.check(makeCtx({ subagentTaskId: 't1' }), makeContract([])),
      ).resolves.toBeUndefined();
    });

    it('verify=false + verification missing → pass', async () => {
      const loadTask = makeLoadTask(makeBaseDecision({ verify: false }));
      const { audit } = makeAudit();
      const { claimStore } = makeClaimStore();
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit, claimStore });
      await expect(
        policy.check(makeCtx({ subagentTaskId: 't1' }), makeContract()),
      ).resolves.toBeUndefined();
    });

    it('loadTask throws → audit SUMMON_STATE_READ_FAILED + pass-through (phase 240 NEW)', async () => {
      const loadTask = makeLoadTask(undefined, async () => { throw new Error('boom'); });
      const { audit, writes } = makeAudit();
      const { claimStore, claimSpy } = makeClaimStore();
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit, claimStore });
      await expect(
        policy.check(
          makeCtx({ subagentTaskId: 't1', clawDir: 'any-claw' }),
          makeContract([{ subtask_id: 'a', type: 'llm' }]),
        ),
      ).resolves.toBeUndefined();
      expect(claimSpy).not.toHaveBeenCalled();
      const failedAudit = writes.find(w => w[0] === SUMMON_AUDIT_EVENTS.SUMMON_STATE_READ_FAILED);
      expect(failedAudit).toBeDefined();
      expect(failedAudit).toEqual([
        SUMMON_AUDIT_EVENTS.SUMMON_STATE_READ_FAILED,
        'taskId=t1',
        expect.stringContaining('boom'),
      ]);
    });
  });

  describe('target_claw boundary (phase 119 contract)', () => {
    it('verify=false + clawDir match → pass', async () => {
      const loadTask = makeLoadTask(makeBaseDecision({ verify: false, targetClaw: 'my-claw' }));
      const { audit, writes } = makeAudit();
      const { claimStore } = makeClaimStore();
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit, claimStore });
      await expect(
        policy.check(makeCtx({ subagentTaskId: 't1', clawDir: 'my-claw' }), makeContract()),
      ).resolves.toBeUndefined();
      expect(writes).toEqual([]);  // no violation, no audit
    });

    it('verify=false + clawDir mismatch → throw ContractCreatePolicyViolationError', async () => {
      const loadTask = makeLoadTask(makeBaseDecision({ verify: false, targetClaw: 'statsvc-auditor' }));
      const { audit } = makeAudit();
      const { claimStore, claimSpy } = makeClaimStore();
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit, claimStore });
      const err = await policy
        .check(makeCtx({ subagentTaskId: 't1', clawDir: 'gateway-auditor' }), makeContract())
        .catch(e => e);
      expect(err).toBeDefined();
      expect(err).toMatchObject({
        name: 'ContractCreatePolicyViolationError',
        policyName: 'summon-verify',
        cause: 'summon_target_claw_violation',
        details: expect.objectContaining({
          subagentTaskId: 't1',
          expectedTargetClaw: 'statsvc-auditor',
          requestedClawId: 'gateway-auditor',
        }),
      });
      expect(err).toBeInstanceOf(ContractCreatePolicyViolationError);
      // 被拒绝的创建不消耗 claim
      expect(claimSpy).not.toHaveBeenCalled();
    });

    it('audit SUMMON_TARGET_CLAW_VIOLATION 载荷正确', async () => {
      const loadTask = makeLoadTask(makeBaseDecision({ verify: false, targetClaw: 'statsvc-auditor' }));
      const { audit, writes } = makeAudit();
      const { claimStore } = makeClaimStore();
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit, claimStore });
      await policy
        .check(makeCtx({ subagentTaskId: 't1', clawDir: 'gateway-auditor' }), makeContract())
        .catch(() => { /* swallow: 本 case 验 audit 载荷、不断言抛出（独立 case 已覆盖） */ });
      expect(writes).toContainEqual([
        SUMMON_AUDIT_EVENTS.SUMMON_TARGET_CLAW_VIOLATION,
        'subagentTaskId=t1',
        'expectedTargetClaw=statsvc-auditor',
        'requestedClawId=gateway-auditor',
      ]);
    });
  });

  describe('verify=false verification violation', () => {
    it('task.summonDecision undefined → audit SUMMON_GATE_NO_DECISION + pass-through', async () => {
      const loadTask = makeLoadTask();  // no decision
      const { audit, writes } = makeAudit();
      const { claimStore, claimSpy } = makeClaimStore();
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit, claimStore });
      await expect(
        policy.check(
          makeCtx({ subagentTaskId: 't1', clawDir: 'any-claw' }),
          makeContract([{ subtask_id: 'a', type: 'llm' }]),
        ),
      ).resolves.toBeUndefined();
      expect(claimSpy).not.toHaveBeenCalled();
      expect(writes).toContainEqual([
        SUMMON_AUDIT_EVENTS.SUMMON_GATE_NO_DECISION,
        'subagentTaskId=t1',
        'reason=likely_non_summon_subagent',
      ]);
    });

    it('verify=false + verification non-empty → throw violation + audit SUMMON_VERIFY_FALSE_VIOLATION', async () => {
      const loadTask = makeLoadTask(makeBaseDecision({ verify: false, targetClaw: 'foo' }));
      const { audit, writes } = makeAudit();
      const { claimStore, claimSpy } = makeClaimStore();
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit, claimStore });
      const err = await policy
        .check(
          makeCtx({ subagentTaskId: 't1', clawDir: 'any-claw' }),
          makeContract([{ subtask_id: 'a', type: 'llm' }]),
        )
        .catch(e => e);
      expect(err).toBeInstanceOf(ContractCreatePolicyViolationError);
      expect(err).toMatchObject({
        policyName: 'summon-verify',
        cause: 'summon_verify_false_violation',
        details: expect.objectContaining({
          subagentTaskId: 't1',
          targetClaw: 'foo',
          verificationCount: 1,
        }),
      });
      expect(writes).toContainEqual([
        SUMMON_AUDIT_EVENTS.SUMMON_VERIFY_FALSE_VIOLATION,
        'subagentTaskId=t1',
        'targetClaw=foo',
        'verificationCount=1',
      ]);
      // 被拒绝的创建不消耗 claim
      expect(claimSpy).not.toHaveBeenCalled();
    });
  });

  describe('phase 1396 Step B: 0/1 creation claim', () => {
    it('summon task 首个合法候选 → claim {summonId, targetExecutorId, proposedContractId}', async () => {
      const loadTask = makeLoadTask(makeBaseDecision({ verify: true }));
      const { audit } = makeAudit();
      const { claimStore, claimSpy, claims } = makeClaimStore();
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit, claimStore });

      await expect(
        policy.check(makeCtx({ subagentTaskId: 't1', clawDir: 'my-claw', proposedContractId: 'cand-1' }), makeContract()),
      ).resolves.toBeUndefined();

      expect(claimSpy).toHaveBeenCalledTimes(1);
      expect(claimSpy).toHaveBeenCalledWith({
        summonId: 't1',
        targetExecutorId: 'my-claw',
        contractId: 'cand-1',
      });
      expect(claims.get('t1')).toMatchObject({ contractId: 'cand-1' });
    });

    it('verify=false 路径同样 claim（0/1 不变量与 verify 无关）', async () => {
      const loadTask = makeLoadTask(makeBaseDecision({ verify: false }));
      const { audit } = makeAudit();
      const { claimStore, claimSpy } = makeClaimStore();
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit, claimStore });

      await expect(
        policy.check(makeCtx({ subagentTaskId: 't1', clawDir: 'my-claw', proposedContractId: 'cand-1' }), makeContract()),
      ).resolves.toBeUndefined();
      expect(claimSpy).toHaveBeenCalledTimes(1);
    });

    it('相同候选重试 → same_claim 幂等通过', async () => {
      const loadTask = makeLoadTask(makeBaseDecision({ verify: true }));
      const { audit } = makeAudit();
      const { claimStore } = makeClaimStore();
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit, claimStore });
      const ctx = makeCtx({ subagentTaskId: 't1', clawDir: 'my-claw', proposedContractId: 'cand-1' });

      await expect(policy.check(ctx, makeContract())).resolves.toBeUndefined();
      await expect(policy.check(ctx, makeContract())).resolves.toBeUndefined();
    });

    it('第二个不同候选 → typed reject（summon_contract_already_claimed）+ audit', async () => {
      const loadTask = makeLoadTask(makeBaseDecision({ verify: true }));
      const { audit, writes } = makeAudit();
      const { claimStore } = makeClaimStore();
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit, claimStore });

      await policy.check(
        makeCtx({ subagentTaskId: 't1', clawDir: 'my-claw', proposedContractId: 'cand-1' }),
        makeContract(),
      );
      const err = await policy
        .check(makeCtx({ subagentTaskId: 't1', clawDir: 'my-claw', proposedContractId: 'cand-2' }), makeContract())
        .catch(e => e);

      expect(err).toBeInstanceOf(ContractCreatePolicyViolationError);
      expect(err).toMatchObject({
        policyName: 'summon-verify',
        cause: 'summon_contract_already_claimed',
        details: expect.objectContaining({
          subagentTaskId: 't1',
          claimedContractId: 'cand-1',
          requestedContractId: 'cand-2',
        }),
      });
      expect(writes).toContainEqual([
        SUMMON_AUDIT_EVENTS.SUMMON_CONTRACT_ALREADY_CLAIMED,
        'subagentTaskId=t1',
        'summonId=t1',
        'claimedContractId=cand-1',
        'requestedContractId=cand-2',
      ]);
    });

    it('不同 executor 的第二候选 → typed reject', async () => {
      const loadTask = makeLoadTask(makeBaseDecision({ verify: true }));
      const { audit } = makeAudit();
      const { claimStore } = makeClaimStore();
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit, claimStore });

      await policy.check(
        makeCtx({ subagentTaskId: 't1', clawDir: 'claw-a', proposedContractId: 'cand-1' }),
        makeContract(),
      );
      const err = await policy
        .check(makeCtx({ subagentTaskId: 't1', clawDir: 'claw-b', proposedContractId: 'cand-1' }), makeContract())
        .catch(e => e);
      expect(err).toBeInstanceOf(ContractCreatePolicyViolationError);
      expect(err.cause).toBe('summon_contract_already_claimed');
    });

    it('clawDir 缺失时回退 decision.targetClaw 作 executor；两者皆缺 → CLAIM_SKIPPED + pass-through', async () => {
      const loadTask = makeLoadTask(makeBaseDecision({ verify: true, targetClaw: 'fallback-claw' }));
      const { audit, writes } = makeAudit();
      const { claimStore, claimSpy } = makeClaimStore();
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit, claimStore });

      // clawDir 缺、decision.targetClaw 在 → 用 targetClaw claim
      await expect(
        policy.check(makeCtx({ subagentTaskId: 't1' }), makeContract()),
      ).resolves.toBeUndefined();
      expect(claimSpy).toHaveBeenCalledWith(expect.objectContaining({ targetExecutorId: 'fallback-claw' }));

      // 两者皆缺 → skip + audit
      const loadTask2 = makeLoadTask(makeBaseDecision({ verify: true }));
      const { audit: audit2, writes: writes2 } = makeAudit();
      const { claimStore: cs2, claimSpy: spy2 } = makeClaimStore();
      const policy2 = createSummonVerifyPolicy({ loadTask: loadTask2, auditWriter: audit2, claimStore: cs2 });
      await expect(
        policy2.check(makeCtx({ subagentTaskId: 't2' }), makeContract()),
      ).resolves.toBeUndefined();
      expect(spy2).not.toHaveBeenCalled();
      expect(writes2).toContainEqual([
        SUMMON_AUDIT_EVENTS.SUMMON_CLAIM_SKIPPED,
        'subagentTaskId=t2',
        'reason=no_executor_context',
      ]);
      expect(writes.filter(w => w[0] === SUMMON_AUDIT_EVENTS.SUMMON_CLAIM_SKIPPED)).toHaveLength(0);
    });
  });
});
