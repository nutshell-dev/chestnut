/**
 * M13 inbox 文案：onboarding 契约创建/恢复通知正文（CLI start → motion inbox，高优）。
 * 触发/接收者：`chestnut start` 首次/补建/恢复 onboarding 契约 → motion inbox
 * （contract_created / contract_resume，高优）。
 * 原 owner：cli/commands/start.ts（投递面——inbox type/priority/source 与
 * contract 创建分支——仍归原 owner；正文呈现归本目录单源）。
 */

/* ------------------------------------------------------------------ */
/* phase 1909 Step B：onboarding 通知正文迁入模板单源（机械迁移，        */
/* 文本逐字节不变）；pending 列表的缺省分支（?? []）留在调用方。         */
/* ------------------------------------------------------------------ */

/** onboarding 创建通知最小呈现输入。 */
export interface OnboardingCreatedInput {
  contractId: string;
}

/** onboarding 创建通知正文。 */
export function onboardingContractCreatedBody(input: OnboardingCreatedInput): string {
  return `New contract created (${input.contractId}): Onboarding. Please begin execution.`;
}

/** onboarding 恢复通知最小呈现输入（pendingSubtasks 为待办子任务 id 列表，可为空）。 */
export interface OnboardingResumedInput {
  contractId: string;
  pendingSubtasks: readonly string[];
}

/** onboarding 恢复通知正文：契约 id + 待办子任务列表。 */
export function onboardingContractResumedBody(input: OnboardingResumedInput): string {
  return `Resuming Onboarding contract (${input.contractId}). Pending subtasks: ${input.pendingSubtasks.join(', ')}. Please continue.`;
}
