/**
 * @module L4.ContractSystem.Notification
 * ContractSystem-owned typed notification protocol (phase 1260 Step A)
 *
 * 唯一进程内 notification 契约：五类业务事件以 `type` 为 discriminator 的
 * discriminated union 表达，业务字段统一 canonical camelCase + owner types
 * （ContractId / SubtaskId / failure cause union）。所有 emitter 构造
 * `satisfies ContractNotification` 的单对象；manager / LifecycleContext /
 * VerificationContext / setOnNotify 只引用同一个 `ContractNotificationSink`。
 *
 * 注意：stream `system_notify`（曾名 `user_notify`，2026-08-07 phase 1319 改名）/ self-inbox 的历史 transport shape（camel/snake
 * 混排）是持久化观察协议事实，不归本协议管；legacy-shape 映射归 Assembly
 * transport adapter（contract-notify-callback.ts，phase 1260 Step B 物理归位）。
 */

import type { ContractId, SubtaskId, LastFailedFeedback } from './types.js';

/** contract_completed 事件内已完成 subtask 的 typed fact。 */
interface CompletedSubtaskNotification {
  readonly id: SubtaskId;
  readonly completedAt: string;
  readonly forceAccepted: boolean;
}

export interface ContractCreatedNotification {
  readonly type: 'contract_created';
  readonly contractId: ContractId;
  readonly title: string;
  readonly subtaskCount: number;
}

interface ContractCompletedNotification {
  readonly type: 'contract_completed';
  readonly contractId: ContractId;
  readonly title: string;
  readonly goal: string;
  readonly subtasks: readonly CompletedSubtaskNotification[];
  readonly completedAt: string;
}

interface ContractCancelledNotification {
  readonly type: 'contract_cancelled';
  readonly contractId: ContractId;
  readonly reason: string;
}

/**
 * Phase 1396 Step D: execution-failure terminal fact. Distinct from
 * contract_cancelled: cancelled is explicit business cancellation only.
 */
export interface ContractFailedNotification {
  readonly type: 'contract_failed';
  readonly contractId: ContractId;
  readonly reason: string;
  readonly evidenceRef: string;
  readonly producer: string;
}

export interface SubtaskCompletedNotification {
  readonly type: 'subtask_completed';
  readonly contractId: ContractId;
  readonly subtaskId: SubtaskId;
  /** force-accept 路径专用标记；普通完成路径缺省。 */
  readonly forceAccepted?: true;
}

export interface VerificationFailedNotification {
  readonly type: 'verification_failed';
  readonly contractId: ContractId;
  readonly subtaskId: SubtaskId;
  readonly cause: LastFailedFeedback['cause'];
  readonly feedback: string;
  readonly retryCount: number;
  readonly maxAttempts: number;
}

export type ContractNotification =
  | ContractCreatedNotification
  | ContractCompletedNotification
  | ContractCancelledNotification
  | ContractFailedNotification
  | SubtaskCompletedNotification
  | VerificationFailedNotification;

/** 唯一 notification sink 类型：接完整 typed event，不再接 (type, data) 二元组。 */
export type ContractNotificationSink = (event: ContractNotification) => void;
