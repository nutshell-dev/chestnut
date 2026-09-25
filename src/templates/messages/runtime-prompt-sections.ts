/**
 * M16 提示词片段：runtime context injector 注入 system prompt 的契约/记忆段字面。
 * 触发/接收者：ContextInjector buildParts/buildSystemPrompt → 每轮 system prompt。
 * 原 owner：core/runtime/injector.ts（段落顺序、AGENTS.md/MEMORY.md 读取与缓存、
 * 子任务完成态判断等分支仍归原 owner；字面呈现归本目录单源）。
 */

/* ------------------------------------------------------------------ */
/* phase 1909 Step C：契约/记忆段字面迁入模板单源（机械迁移，逐字节不变）；*/
/* 模板只收必要标量，完成态判断（status === 'completed'）留在调用方。     */
/* ------------------------------------------------------------------ */

export const ACTIVE_CONTRACT_SECTION_HEADING = '## Active Contract';
export const MEMORY_SECTION_HEADING = '## Memory';
export const CONTRACT_TITLE_LABEL = '**Title:**';
export const CONTRACT_GOAL_LABEL = '**Goal:**';
export const CONTRACT_SUBTASKS_LABEL = '**Subtasks:**';

/** 契约段子任务行：复选框 + id + 描述（done 由调用方按子任务状态判断后传入）。 */
export function contractSubtaskLine(done: boolean, id: string, description: string): string {
  const checkbox = done ? '[x]' : '[ ]';
  return `${checkbox} \`${id}\`: ${description}`;
}
