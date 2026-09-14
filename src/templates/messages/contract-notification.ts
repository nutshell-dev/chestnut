/**
 * M04 inbox 文案：契约终态事件的外壳（标签 + claw + 已序列化数据）。
 * 触发/接收者：Assembly 契约通知 adapter → 本 daemon 自家 inbox（contract_events / contract_cancelled，高优）。
 * 原 owner：assembly（数据序列化与字段顺序仍归 adapter）。
 */

export function contractNotificationBody(label: string, clawId: string, serializedData: string): string {
  return `[${label}] claw=${clawId} ${serializedData}`;
}

/* ------------------------------------------------------------------ */
/* phase 1832：自家契约完成通知纯呈现入口。                             */
/* 只呈现 typed event 已有事实（标题/目标/完成时间/子任务完成时间/放行   */
/* 标记），不反推质量结论；措辞与 observer 路共用 contract-events 纯函数。*/
/* 取消通知仍走上面的旧入口（保留到 1833）。                            */
/* ------------------------------------------------------------------ */

import {
  contractCompletedExecutorLine,
  contractCompletedForceAcceptedNoteLine,
  contractCompletedGoalLine,
  contractCompletedStateLine,
  contractCompletedSubtasksHeading,
  contractCompletedTimeLine,
} from './contract-events.js';

/** 自家完成通知最小呈现输入（adapter 从 typed event 逐字段传入，不导入 Contract 实体）。 */
export interface ContractCompletedMessageInput {
  clawId: string;
  contractId: string;
  title: string;
  goal: string;
  completedAt: string;
  subtaskLines: readonly string[];
}

/** 自家完成通知子任务行：id + 已有完成时间；forceAccepted 追加放行中性注记。 */
export function contractCompletedSubtaskLine(subtaskId: string, completedAt: string, forceAccepted: boolean): string {
  const base = completedAt ? `  [${subtaskId}] 完成时间：${completedAt}` : `  [${subtaskId}]`;
  return forceAccepted ? `${base}\n${contractCompletedForceAcceptedNoteLine()}` : base;
}

/** 自家完成通知正文：终态 + 对象 + 执行者 + 已有事实；空标题只显 ID，缺失项省略不补造。 */
export function contractCompletedNotificationBody(input: ContractCompletedMessageInput): string {
  const lines: string[] = [
    contractCompletedStateLine(input.title, input.contractId),
    contractCompletedExecutorLine(input.clawId),
  ];
  if (input.goal) lines.push(contractCompletedGoalLine(input.goal));
  if (input.completedAt) lines.push(contractCompletedTimeLine(input.completedAt));
  if (input.subtaskLines.length > 0) {
    lines.push(contractCompletedSubtasksHeading(), ...input.subtaskLines);
  }
  return lines.join('\n');
}
