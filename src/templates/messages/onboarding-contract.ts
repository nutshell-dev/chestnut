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

/* ------------------------------------------------------------------ */
/* phase 1909 Step C：onboarding 子任务描述字面迁入（机械迁移，逐字节    */
/* 不变）；子任务 id 集合、顺序与 language==='auto' 分支留在 start.ts。  */
/* ------------------------------------------------------------------ */

/** language 子任务的语言指示（auto 形态）。 */
export const ONBOARDING_LANG_INSTRUCTION_AUTO = "Detect the user's preferred language from their first message and respond in it immediately.";

/** language 子任务的语言指示（用户已键入形态）。 */
export function onboardingLangInstructionTyped(language: string): string {
  return `The user typed "${language}" at the language prompt. Infer the language from this text and respond in that language immediately.`;
}

/** language 子任务描述：语言指示 + 落盘要求。 */
export function onboardingLanguageSubtaskDescription(langInstruction: string): string {
  return `${langInstruction} Write the language preference to USER.md (not inside clawspace/).`;
}

export const ONBOARDING_IDENTITY_SUBTASK_DESCRIPTION = 'You are the coordinator of Claws — "Motion" is your system role, not your name. Ask the user what they want to call you, and what kind of vibe or presence they want from you. Write the result to IDENTITY.md (not inside clawspace/).';

export const ONBOARDING_USER_SUBTASK_DESCRIPTION = 'Learn who they are: name, how to address them, any relevant context. Write to USER.md (not inside clawspace/).';

export const ONBOARDING_SOUL_SUBTASK_DESCRIPTION = 'Open SOUL.md together. Talk about what matters to them and how they want you to behave. Update SOUL.md (not inside clawspace/) with what you learn.';

export const ONBOARDING_FIRST_CLAW_SUBTASK_DESCRIPTION = 'Help the user create their first Claw. Ask what task or project they want to work on. A Claw is a separate context window for a specific ongoing task — all Claws have identical capabilities, they just handle different work. Run both commands: exec: chestnut claw <name> create, then exec: chestnut claw <name> daemon';

export const ONBOARDING_FIRST_CONTRACT_SUBTASK_DESCRIPTION = 'Help the user assign the first contract to their new Claw. Ask what they want to get done, then create the contract via summon: { "goal": "为 <claw-name> 创建契约：<task description>" }';

export const ONBOARDING_READY_SUBTASK_DESCRIPTION = 'Onboarding is complete. Let them know everything is set up and the Claw is working on their first task.';
