/**
 * M12 inbox 文案：契约创建时投递给 claw 的创建通知正文。
 * 触发/接收者：CLI `contract create` / `contract create-from-dir`（共享
 * notifyContractCreated helper）→ 目标 claw inbox（contract_created，高优）。
 * 原 owner：cli/commands（投递面——inbox 条目字段/优先级/stream 事件/audit——仍归
 * 原 owner；正文呈现归本目录单源）。
 */

/* ------------------------------------------------------------------ */
/* phase 1906 Step B：创建通知正文迁入模板单源（结构迁移，文本逐字不变）。 */
/* 入参为最小标量与已渲染行，不 import 契约实体；调用方逐字段映射。      */
/* ------------------------------------------------------------------ */

/** 契约创建通知最小呈现输入（helper 从 ContractYaml 逐字段传入，不导入 Contract 实体）。 */
export interface ContractCreatedMessageInput {
  contractId: string;
  title: string;
  background?: string;
  goal: string;
  expectations?: string;
  subtasks: ReadonlyArray<{ id: string; description: string }>;
}

/** 契约创建通知正文：对象 + 可选背景 + 目标 + 可选期望 + 子任务清单 + 验收提交指示。 */
export function contractCreatedNotificationBody(input: ContractCreatedMessageInput): string {
  const subtaskLines = input.subtasks.map(s => `- ${s.id}: ${s.description}`).join('\n');
  const lines = [`New contract created (${input.contractId}): ${input.title}`];
  if (input.background) lines.push(`Background: ${input.background}`);
  lines.push(`Goal: ${input.goal}`);
  if (input.expectations) lines.push(`Expectations: ${input.expectations}`);
  lines.push(`Subtasks:`);
  lines.push(subtaskLines);
  lines.push(`After each subtask, submit verification via done:`);
  lines.push(`done: { "subtask": "<subtask-id>", "evidence": "<output path or completion summary>" }`);
  return lines.join('\n');
}
