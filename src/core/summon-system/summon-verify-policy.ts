import type { ContractYaml } from '../contract/index.js';
import type { ContractCreatePolicy, CreatePolicyContext } from '../contract/types.js';
import { ContractCreatePolicyViolationError } from '../contract/types.js';
import { SUMMON_AUDIT_EVENTS } from './audit-events.js';
import type { SubAgentTask } from '../async-task-system/types.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { makeTaskId, type TaskId } from '../async-task-system/types.js';

// ============================================================================
// Phase 230: SummonVerifyPolicy — ContractCreatePolicy implementation
// Phase 281 Step B: decision 改从 SubAgentTask.summonDecision metadata 读取，
// 不再依赖 summon-state-store（已删）。pre-phase 281 任务无 metadata → undefined。
// ============================================================================

export interface SummonVerifyPolicyDeps {
  /** 按 taskId 加载 SubAgentTask；找不到或不是 subagent 时返 undefined */
  loadTask: (taskId: TaskId) => Promise<SubAgentTask | undefined>;
  auditWriter: AuditLog;
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
        deps.auditWriter.write(
          SUMMON_AUDIT_EVENTS.SUMMON_STATE_READ_FAILED,
          `taskId=${subagentTaskId}`,
          `error=${String(err)}`,
        );
        // 读失败 = 未知状态、pass-through 不误拦（M#1 业务承诺无法判定时不强阻）
        return;
      }

      const decision = task?.summonDecision;

      if (!decision) {
        // metadata 缺失 = 非 summon 创建路径（如直接 CLI 调用、其他 caller subagent、pre-phase 281 旧任务）
        deps.auditWriter.write(
          SUMMON_AUDIT_EVENTS.SUMMON_GATE_NO_DECISION,
          `subagentTaskId=${subagentTaskId}`,
          'reason=likely_non_summon_subagent',
        );
        return;
      }

      if (decision.verify) {
        return; // verify=true → 无限制
      }

      // verify=false 路径：检查 verification 承诺
      const verificationArr = contract.verification ?? [];
      if (verificationArr.length > 0) {
        deps.auditWriter.write(
          SUMMON_AUDIT_EVENTS.SUMMON_VERIFY_FALSE_VIOLATION,
          `subagentTaskId=${subagentTaskId}`,
          `targetClaw=${decision.targetClaw ?? '(unset)'}`,
          `verificationCount=${verificationArr.length}`,
        );
        throw new ContractCreatePolicyViolationError(
          'summon-verify',
          'summon_verify_false_violation',
          {
            subagentTaskId,
            targetClaw: decision.targetClaw,
            verificationCount: verificationArr.length,
            note: 'summon dispatch with verify=false; contract must not include verification entries',
          },
        );
      }

      // phase 119: target_claw 边界校验（verify=false 路径）
      const clawDir = ctx.clawDir;
      if (decision.targetClaw && clawDir && decision.targetClaw !== clawDir) {
        deps.auditWriter.write(
          SUMMON_AUDIT_EVENTS.SUMMON_TARGET_CLAW_VIOLATION,
          `subagentTaskId=${subagentTaskId}`,
          `expectedTargetClaw=${decision.targetClaw}`,
          `requestedClawId=${clawDir}`,
        );
        throw new ContractCreatePolicyViolationError(
          'summon-verify',
          'summon_target_claw_violation',
          {
            subagentTaskId,
            expectedTargetClaw: decision.targetClaw,
            requestedClawId: clawDir,
            note: 'cross-claw contract creation from a summon subagent is prohibited',
          },
        );
      }
    },
  };
}
