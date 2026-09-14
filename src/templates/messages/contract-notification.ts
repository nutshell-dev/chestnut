/**
 * M04 inbox 文案：契约终态事件的自家通知正文（typed event 事实纯呈现）。
 * 触发/接收者：Assembly 契约通知 adapter → 本 daemon 自家 inbox（contract_events / contract_cancelled，高优）。
 * 原 owner：assembly（typed event 字段归 ContractSystem；正文呈现归本目录单源）。
 */

/* ------------------------------------------------------------------ */
/* phase 1832：自家契约完成通知纯呈现入口。                             */
/* 只呈现 typed event 已有事实（标题/目标/完成时间/子任务完成时间/放行   */
/* 标记），不反推质量结论；措辞与 observer 路共用 contract-events 纯函数。*/
/* ------------------------------------------------------------------ */

import {
  contractCancelledEmptyReasonLine,
  contractCancelledReasonLine,
  contractCancelledStateLine,
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

/* ------------------------------------------------------------------ */
/* phase 1833：自家契约取消通知纯呈现入口（旧串行化入口已随调用移除）。   */
/* typed cancelled event 只有契约 ID 与取消事由：呈现终态+对象+执行者+   */
/* 原事由（非空时）；空事由明示「取消请求未填写原因」，不跨模块查询补     */
/* 标题/进度。                                                          */
/* ------------------------------------------------------------------ */

/**
 * 自家取消通知最小呈现输入：adapter 把 typed cancelled event 整体直传
 * （结构子集，不 import event 定义）；投递 block 不再出现 owner wire key
 * 同名字面（arch ratchet 保持严格）。
 */
export interface ContractCancelledMessageEvent {
  contractId: string;
  reason: string;
}

/** 自家取消通知正文：终态 + 对象 + 执行者 + 原因事实。 */
export function contractCancelledNotificationBody(clawId: string, event: ContractCancelledMessageEvent): string {
  return [
    contractCancelledStateLine('', event.contractId),
    contractCompletedExecutorLine(clawId),
    event.reason.trim()
      ? contractCancelledReasonLine(event.reason)
      : contractCancelledEmptyReasonLine(),
  ].join('\n');
}
