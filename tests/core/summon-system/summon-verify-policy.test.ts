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
 * Assertion patterns:
 * - Violation cases assert on `policyName` + `cause` + `details` (public fields of
 *   ContractCreatePolicyViolationError), not on the message string — message format
 *   may legitimately change without breaking the contract.
 * - Audit cases use SUMMON_AUDIT_EVENTS constants instead of literal event names.
 */

import { describe, it, expect, vi } from 'vitest';
import { createSummonVerifyPolicy } from '../../../src/core/summon-system/summon-verify-policy.js';
import { ContractCreatePolicyViolationError } from '../../../src/core/contract/types.js';
import { SUMMON_AUDIT_EVENTS } from '../../../src/core/summon-system/audit-events.js';
import { makeTaskId, type TaskId, type SubAgentTask } from '../../../src/core/async-task-system/types.js';
import type { ContractYaml } from '../../../src/core/contract/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

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
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit });
      await expect(
        policy.check({}, makeContract([{ subtask_id: 'a', type: 'llm' }])),
      ).resolves.toBeUndefined();
      expect(loadTask).not.toHaveBeenCalled();
    });

    it('subagentTaskId unset + decision.targetClaw set → pass, loadTask still not called', async () => {
      const loadTask = makeLoadTask(makeBaseDecision({ targetClaw: 'my-claw' }));
      const { audit } = makeAudit();
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit });
      await expect(
        policy.check({ clawDir: 'other-claw' }, makeContract()),
      ).resolves.toBeUndefined();
      expect(loadTask).not.toHaveBeenCalled();
    });

    it('verify=false + decision.targetClaw unset + clawDir present → pass (motion 未指定 targetClaw 由子代理自决)', async () => {
      const loadTask = makeLoadTask(makeBaseDecision({ verify: false }));
      const { audit } = makeAudit();
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit });
      await expect(
        policy.check({ subagentTaskId: 't1', clawDir: 'any-claw' }, makeContract()),
      ).resolves.toBeUndefined();
    });

    it('verify=true + clawDir mismatch → pass (verify=true 路径不校 target_claw)', async () => {
      const loadTask = makeLoadTask(makeBaseDecision({ verify: true, targetClaw: 'statsvc-auditor' }));
      const { audit } = makeAudit();
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit });
      await expect(
        policy.check({ subagentTaskId: 't1', clawDir: 'gateway-auditor' }, makeContract()),
      ).resolves.toBeUndefined();
    });

    it('verify=true + verification non-empty → pass', async () => {
      const loadTask = makeLoadTask(makeBaseDecision({ verify: true }));
      const { audit } = makeAudit();
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit });
      await expect(
        policy.check({ subagentTaskId: 't1' }, makeContract([{ subtask_id: 'a', type: 'llm' }])),
      ).resolves.toBeUndefined();
    });

    it('verify=false + verification empty → pass', async () => {
      const loadTask = makeLoadTask(makeBaseDecision({ verify: false }));
      const { audit } = makeAudit();
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit });
      await expect(
        policy.check({ subagentTaskId: 't1' }, makeContract([])),
      ).resolves.toBeUndefined();
    });

    it('verify=false + verification missing → pass', async () => {
      const loadTask = makeLoadTask(makeBaseDecision({ verify: false }));
      const { audit } = makeAudit();
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit });
      await expect(
        policy.check({ subagentTaskId: 't1' }, makeContract()),
      ).resolves.toBeUndefined();
    });

    it('loadTask throws → audit SUMMON_STATE_READ_FAILED + pass-through (phase 240 NEW)', async () => {
      const loadTask = makeLoadTask(undefined, async () => { throw new Error('boom'); });
      const { audit, writes } = makeAudit();
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit });
      await expect(
        policy.check(
          { subagentTaskId: 't1', clawDir: 'any-claw' },
          makeContract([{ subtask_id: 'a', type: 'llm' }]),
        ),
      ).resolves.toBeUndefined();
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
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit });
      await expect(
        policy.check({ subagentTaskId: 't1', clawDir: 'my-claw' }, makeContract()),
      ).resolves.toBeUndefined();
      expect(writes).toEqual([]);  // no violation, no audit
    });

    it('verify=false + clawDir mismatch → throw ContractCreatePolicyViolationError', async () => {
      const loadTask = makeLoadTask(makeBaseDecision({ verify: false, targetClaw: 'statsvc-auditor' }));
      const { audit } = makeAudit();
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit });
      const err = await policy
        .check({ subagentTaskId: 't1', clawDir: 'gateway-auditor' }, makeContract())
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
    });

    it('audit SUMMON_TARGET_CLAW_VIOLATION 载荷正确', async () => {
      const loadTask = makeLoadTask(makeBaseDecision({ verify: false, targetClaw: 'statsvc-auditor' }));
      const { audit, writes } = makeAudit();
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit });
      await policy
        .check({ subagentTaskId: 't1', clawDir: 'gateway-auditor' }, makeContract())
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
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit });
      await expect(
        policy.check(
          { subagentTaskId: 't1', clawDir: 'any-claw' },
          makeContract([{ subtask_id: 'a', type: 'llm' }]),
        ),
      ).resolves.toBeUndefined();
      expect(writes).toContainEqual([
        SUMMON_AUDIT_EVENTS.SUMMON_GATE_NO_DECISION,
        'subagentTaskId=t1',
        'reason=likely_non_summon_subagent',
      ]);
    });

    it('verify=false + verification non-empty → throw violation + audit SUMMON_VERIFY_FALSE_VIOLATION', async () => {
      const loadTask = makeLoadTask(makeBaseDecision({ verify: false, targetClaw: 'foo' }));
      const { audit, writes } = makeAudit();
      const policy = createSummonVerifyPolicy({ loadTask, auditWriter: audit });
      const err = await policy
        .check(
          { subagentTaskId: 't1', clawDir: 'any-claw' },
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
    });
  });
});
