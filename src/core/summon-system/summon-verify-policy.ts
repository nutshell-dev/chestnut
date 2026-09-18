import type { ContractYaml } from '../contract/index.js';
import type { ContractCreatePolicy, CreatePolicyContext } from '../contract/index.js';
import { ContractCreatePolicyViolationError } from '../contract/index.js';
import { SUMMON_AUDIT_EVENTS } from './audit-events.js';
import { SUMMON_CONTRACT_EXTRACT_POSTPROCESSOR_NAME } from './post-processors/contract-extract.js';
import type { SubAgentTask, LegacySummonDecisionV1 } from '../async-task-system/index.js';
import { readSummonDecision } from './legacy-decision.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { makeTaskId, type TaskId } from '../async-task-system/index.js';
import {
  SummonContractAlreadyClaimedError,
  type SummonCreationClaimStore,
} from './creation-claim-store.js';

// ============================================================================
// Phase 230: SummonVerifyPolicy — ContractCreatePolicy implementation
// Phase 281 Step B: decision 改从 SubAgentTask.summonDecision metadata 读取，
// 不再依赖 summon-state-store（已删）。pre-phase 281 任务无 metadata → undefined。
// Phase 1396 Step B: summon 0/1 创建 claim —— 同一 summon task 首个合法候选取得
// durable claim；同候选重试幂等通过，不同候选由 policy 拒绝。claim store 归
// SummonSystem 独占；ContractSystem 只运行已注册 policy，不理解 summon。
// Phase 1396 Step K: decision 版本化 —— v2 active path 固定 no-verification，
// executor 只取自 ctx.clawDir；v1 legacy adapter 保留原 verify/targetClaw 行为。
// Phase 1402 Step A: decision 缺失时按 canonical post-processor 识别当前 summon
// task（decision-present 永远优先按 legacy v1/v2 解释）；active writer 停写
// decision 后 policy 无需等待新字段即可识别新任务。
// ============================================================================

export interface SummonVerifyPolicyDeps {
  /** 按 taskId 加载 SubAgentTask；找不到或不是 subagent 时返 undefined */
  loadTask: (taskId: TaskId) => Promise<SubAgentTask | undefined>;
  auditWriter: AuditLog;
  /** Phase 1396 Step B: summon-scoped 创建 claim store（SummonSystem 独占资源） */
  claimStore: SummonCreationClaimStore;
}

export function createSummonVerifyPolicy(
  deps: SummonVerifyPolicyDeps,
): ContractCreatePolicy {
  return {
    name: 'summon-verify',
    async check(ctx: CreatePolicyContext, contract: ContractYaml): Promise<void> {
      const subagentTaskId = ctx.subagentTaskId;
      if (!subagentTaskId) {
        // 非 subagent 路径（如 motion 直接 contract create）、本 policy 不适用、pass-through
        return;
      }

      let task: SubAgentTask | undefined;
      try {
        // phase 276 Step A: makeTaskId SoT (M#9 编译器可检) / 替 'subagentTaskId as TaskId' 直 cast
        task = await deps.loadTask(makeTaskId(subagentTaskId));
      } catch (err) {
        // Phase 1396 Step M: 读失败 = summon 创建状态不可判定（I/O / corrupt / future schema），
        // fail-closed 抛 typed violation、不放行创建、不写 claim。不得 pass-through。
        deps.auditWriter.write(
          SUMMON_AUDIT_EVENTS.SUMMON_STATE_READ_FAILED,
          `taskId=${subagentTaskId}`,
          `error=${String(err)}`,
        );
        throw new ContractCreatePolicyViolationError(
          'summon-verify',
          'summon_state_unavailable',
          {
            subagentTaskId,
            note: 'summon task state unreadable; contract creation blocked (fail-closed)',
          },
        );
      }

      if (!task) {
        // loader 可靠返回 undefined：task 不存在，同样无法判定 summon 创建状态 → fail-closed。
        deps.auditWriter.write(
          SUMMON_AUDIT_EVENTS.SUMMON_GATE_NO_DECISION,
          `subagentTaskId=${subagentTaskId}`,
          'reason=task_not_found',
        );
        throw new ContractCreatePolicyViolationError(
          'summon-verify',
          'summon_task_not_found',
          {
            subagentTaskId,
            note: 'subagent task not found; contract creation blocked (fail-closed)',
          },
        );
      }

      // phase 1866 Step C（SU-D2）：decision 解释经 migration 读面（不内联版本判断）；
      // legacy decision 是恢复兼容输入，不是创建 authority（authority = claim）。
      const decisionRead = readSummonDecision(task);

      if (decisionRead.kind === 'absent') {
        if (task.postProcessor === SUMMON_CONTRACT_EXTRACT_POSTPROCESSOR_NAME) {
          // Phase 1402 Step A: 当前 summon task 由 canonical post-processor identity 识别，
          // 与 legacy v2 共用 no-verification + ctx.clawDir executor + claim 行为。
          await checkCurrent(ctx, contract, task, deps);
          return;
        }
        // metadata 缺失且无 canonical post-processor = 非 summon 创建路径（如直接 CLI 调用、其他 caller subagent、pre-phase 281 旧任务）
        deps.auditWriter.write(
          SUMMON_AUDIT_EVENTS.SUMMON_GATE_NO_DECISION,
          `subagentTaskId=${subagentTaskId}`,
          'reason=likely_non_summon_subagent',
        );
        return;
      }

      if (decisionRead.kind === 'legacy_v2') {
        // Phase 1402 Step A: legacy v2 decision 与 canonical 当前路径行为一致，共用 helper。
        await checkCurrent(ctx, contract, task, deps);
        return;
      }

      if (decisionRead.kind === 'legacy_v1') {
        await checkLegacyV1(ctx, contract, task, decisionRead.decision, deps);
        return;
      }

      // Unknown future version: fail-observable, never downgrade to pass-through.
      deps.auditWriter.write(
        SUMMON_AUDIT_EVENTS.SUMMON_GATE_UNKNOWN_SCHEMA_VERSION,
        `subagentTaskId=${subagentTaskId}`,
        `schema_version=${String(decisionRead.version)}`,
      );
      throw new ContractCreatePolicyViolationError(
        'summon-verify',
        'summon_unknown_schema_version',
        {
          subagentTaskId,
          schemaVersion: decisionRead.version,
          note: 'unsupported summon decision schema version',
        },
      );
    },
  };
}

async function checkCurrent(
  ctx: CreatePolicyContext,
  contract: ContractYaml,
  task: SubAgentTask,
  deps: SummonVerifyPolicyDeps,
): Promise<void> {
  // Phase 1396 Step K: v2 固定 no-verification 策略；verification/escalation 字段禁止出现。
  const verificationArr = contract.verification ?? [];
  if (verificationArr.length > 0) {
    deps.auditWriter.write(
      SUMMON_AUDIT_EVENTS.SUMMON_VERIFY_FALSE_VIOLATION,
      `subagentTaskId=${ctx.subagentTaskId}`,
      `verificationCount=${verificationArr.length}`,
      'reason=v2_no_verification_allowed',
    );
    throw new ContractCreatePolicyViolationError(
      'summon-verify',
      'summon_verify_false_violation',
      {
        subagentTaskId: ctx.subagentTaskId,
        verificationCount: verificationArr.length,
        note: 'summon v2 policy prohibits verification entries',
      },
    );
  }

  // v2 executor 必须来自 CreatePolicyContext.clawDir，不允许回退旧字段。
  const targetExecutorId = ctx.clawDir;
  if (!targetExecutorId) {
    deps.auditWriter.write(
      SUMMON_AUDIT_EVENTS.SUMMON_V2_EXECUTOR_CONTEXT_MISSING,
      `subagentTaskId=${ctx.subagentTaskId}`,
      'reason=no_executor_context',
    );
    throw new ContractCreatePolicyViolationError(
      'summon-verify',
      'summon_v2_executor_context_missing',
      {
        subagentTaskId: ctx.subagentTaskId,
        note: 'v2 summon decision requires executor context (ctx.clawDir)',
      },
    );
  }

  await claimCreation(ctx, task, targetExecutorId, deps);
}

async function checkLegacyV1(
  ctx: CreatePolicyContext,
  contract: ContractYaml,
  task: SubAgentTask,
  decision: LegacySummonDecisionV1,
  deps: SummonVerifyPolicyDeps,
): Promise<void> {
  // Legacy v1 path: 保留原 verify/targetClaw 行为，用于已落盘任务的恢复兼容。
  if (!decision.verify) {
    const verificationArr = contract.verification ?? [];
    if (verificationArr.length > 0) {
      deps.auditWriter.write(
        SUMMON_AUDIT_EVENTS.SUMMON_VERIFY_FALSE_VIOLATION,
        `subagentTaskId=${ctx.subagentTaskId}`,
        `targetClaw=${decision.targetClaw ?? '(unset)'}`,
        `verificationCount=${verificationArr.length}`,
      );
      throw new ContractCreatePolicyViolationError(
        'summon-verify',
        'summon_verify_false_violation',
        {
          subagentTaskId: ctx.subagentTaskId,
          targetClaw: decision.targetClaw,
          verificationCount: verificationArr.length,
          note: 'legacy v1 summon dispatch with verify=false; contract must not include verification entries',
        },
      );
    }

    // phase 119: target_claw 边界校验（verify=false 路径）
    const clawDir = ctx.clawDir;
    if (decision.targetClaw && clawDir && decision.targetClaw !== clawDir) {
      deps.auditWriter.write(
        SUMMON_AUDIT_EVENTS.SUMMON_TARGET_CLAW_VIOLATION,
        `subagentTaskId=${ctx.subagentTaskId}`,
        `expectedTargetClaw=${decision.targetClaw}`,
        `requestedClawId=${clawDir}`,
      );
      throw new ContractCreatePolicyViolationError(
        'summon-verify',
        'summon_target_claw_violation',
        {
          subagentTaskId: ctx.subagentTaskId,
          expectedTargetClaw: decision.targetClaw,
          requestedClawId: clawDir,
          note: 'legacy v1: cross-claw contract creation from a summon subagent is prohibited',
        },
      );
    }
  }

  const targetExecutorId = ctx.clawDir ?? decision.targetClaw;
  if (!targetExecutorId) {
    deps.auditWriter.write(
      SUMMON_AUDIT_EVENTS.SUMMON_CLAIM_SKIPPED,
      `subagentTaskId=${ctx.subagentTaskId}`,
      'reason=no_executor_context',
    );
    return;
  }

  await claimCreation(ctx, task, targetExecutorId, deps);
}

async function claimCreation(
  ctx: CreatePolicyContext,
  task: SubAgentTask,
  targetExecutorId: string,
  deps: SummonVerifyPolicyDeps,
): Promise<void> {
  // Phase 1396 Step B: 0/1 创建 claim（在上述 violation 检查全部通过后，
  // 被拒绝的创建不消耗 claim）。claim 是最后闸门。
  try {
    await deps.claimStore.claim({
      summonId: task.id,
      targetExecutorId,
      contractId: ctx.proposedContractId,
    });
  } catch (err) {
    if (err instanceof SummonContractAlreadyClaimedError) {
      deps.auditWriter.write(
        SUMMON_AUDIT_EVENTS.SUMMON_CONTRACT_ALREADY_CLAIMED,
        `subagentTaskId=${ctx.subagentTaskId}`,
        `summonId=${task.id}`,
        `claimedContractId=${err.existing.contractId}`,
        `requestedContractId=${err.requested.contractId}`,
      );
      throw new ContractCreatePolicyViolationError(
        'summon-verify',
        'summon_contract_already_claimed',
        {
          subagentTaskId: ctx.subagentTaskId,
          summonId: task.id,
          claimedContractId: err.existing.contractId,
          claimedTargetExecutorId: err.existing.targetExecutorId,
          requestedContractId: err.requested.contractId,
          requestedTargetExecutorId: err.requested.targetExecutorId,
          note: 'one summon may create at most one contract; a different candidate is rejected',
        },
      );
    }
    throw err;
  }
}
