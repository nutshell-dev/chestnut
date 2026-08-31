/**
 * @module L6.Assembly.ContractNotificationAdapter
 * @layer L6 装配层
 * @consumers L6.Assembly.RuntimeAssembly
 *
 * ContractNotification → transport adapter：接 ContractSystem-owned typed event，
 * exhaustive mapper 显式恢复 legacy stream/inbox shape（camel/snake 历史混排是
 * 持久化观察协议事实，本 adapter 逐字段保持、不归一化），formatNotifyData 序列化 /
 * stream system_notify + completed/cancelled self-inbox 发出。
 *
 * 抽出动机：assemble() M#1/SRP 治理（assembly-auditor §六.4 follow-up）。
 * phase 1260 Step B：物理归位 Assembly（原 core/contract/contract-notify-callback.ts），
 * runtime-assembly 构造后直接 attach 到 contractManager，Runtime 中转依赖已删除。
 *
 * phase 37：variable `motionInboxDir` → `selfInboxDir` 命名 hygiene + 注释 calibration（详 §A.6）。
 */

import type { StreamWriter } from '../foundation/stream/index.js';
import { STREAM_EVENT_NAMES } from '../foundation/stream/index.js';
import type { AuditLog } from '../foundation/audit/index.js';
import type { FileSystem } from '../foundation/fs/index.js';
import { notifyInbox } from '../foundation/messaging/index.js';
import { makeClawId } from '../foundation/claw-identity/index.js';
import {
  encodeContractEventsGuidance,
  encodeContractCancelledGuidance,
  type ContractNotification,
  type ContractNotificationSink,
} from '../core/contract/index.js';

interface ContractNotificationAdapterDeps {
  streamWriter: StreamWriter;
  clawId: string;
  systemFs: FileSystem;
  /**
   * phase 37: 本 daemon 自家 inbox dir（= clawDir/inbox/pending）。
   * 命名「self」明确：本 callback 写本 daemon 自家 inbox、不跨 claw。
   *
   * - motion daemon (clawId=motion): selfInboxDir = motion/inbox/pending → motion sees 自家契约终态
   * - worker daemon (clawId=worker-X): selfInboxDir = claws/worker-X/inbox/pending → worker sees 自家
   *
   * 跨 claw 通知（worker 契约终态 → motion 知道）归 contract-observer cron 职责
   * （详 src/core/contract/jobs/contract-observer.ts、phase 37 race 治本 + dedup 防护）。
   */
  selfInboxDir: string;
  auditWriter: AuditLog;
}

export function createContractNotificationAdapter(deps: ContractNotificationAdapterDeps): ContractNotificationSink {
  return (event: ContractNotification) => {
    const data = toLegacyNotifyData(event);
    deps.streamWriter.write({ ts: Date.now(), type: STREAM_EVENT_NAMES.SYSTEM_NOTIFY, subtype: event.type, ...data });

    // §A.6 双链路：本 daemon 自家 inbox 接契约终态事件（决策点）
    // subtask_completed / verification_failed 仅 streamWriter（viewport 可见、决策无用）
    if (event.type === 'contract_completed') {
      // phase 1261 Step B: guidance metadata 只经 ContractSystem owner codec 写 v1
      // （schema version + refs JSON 两 owner key；不再手写 legacy wire keys）
      // phase 37: 写 selfInboxDir（本 daemon 自家、详 deps.selfInboxDir doc）
      //   - motion daemon: 写 motion 自家 inbox
      //   - worker daemon: 写 worker 自家 inbox
      //   跨 claw 通知归 contract-observer cron
      notifyInbox(deps.systemFs, {
        inboxDir: deps.selfInboxDir,
        type: 'contract_events',   // inbox sender type（guidance WIRE_TYPE 同值）；非 stream 枚举
        source: 'system',
        priority: 'high',
        body: `[${event.type}] claw=${deps.clawId} ${formatNotifyData(data)}`,
        extraFields: encodeContractEventsGuidance([{
          clawId: makeClawId(deps.clawId),
          contractId: event.contractId,
        }]),
      }, deps.auditWriter);
    }

    // phase 63: contract_cancelled NEW
    if (event.type === 'contract_cancelled') {
      // phase 1262 Step B: guidance metadata 只经 ContractSystem owner codec 写 v1
      // （schema version + refs JSON 两 owner key；不再手写 legacy dialect keys ——
      // 取消原因已由 body 与 stream 持久化、不重复跨边界）
      notifyInbox(deps.systemFs, {
        inboxDir: deps.selfInboxDir,
        type: 'contract_cancelled',  // inbox sender type（guidance WIRE_TYPE 同值）；非 stream 枚举
        source: 'system',
        priority: 'high',
        body: `[contract_cancelled] claw=${deps.clawId} ${formatNotifyData(data)}`,
        extraFields: encodeContractCancelledGuidance([{
          clawId: makeClawId(deps.clawId),
          contractId: event.contractId,
        }]),
      }, deps.auditWriter);
    }

  };
}

/**
 * phase 1260 Step A: typed event → legacy transport data shape（逐 variant exhaustive）。
 *
 * 恢复历史 emitter 手写的 Record shape，key 集合与插入序逐字段保持：
 * - created / cancelled / 普通 subtask_completed：camelCase；
 * - contract_completed：`completed_at` + subtask 内 `completed_at`/`force_accepted`；
 * - forceAccepted subtask_completed：`contract_id`/`subtask_id`/`force_accepted` snake；
 * - verification_failed：全 snake keys。
 *
 * 新增 ContractNotification variant 时本 switch 编译失败（never exhaustive）。
 */
function toLegacyNotifyData(event: ContractNotification): Record<string, unknown> {
  switch (event.type) {
    case 'contract_created':
      return { contractId: event.contractId, title: event.title, subtaskCount: event.subtaskCount };
    case 'contract_completed':
      return {
        contractId: event.contractId,
        title: event.title,
        goal: event.goal,
        subtasks: event.subtasks.map((st) => ({
          id: st.id,
          completed_at: st.completedAt,
          force_accepted: st.forceAccepted,
        })),
        completed_at: event.completedAt,
      };
    case 'contract_cancelled':
      return { contractId: event.contractId, reason: event.reason };
    case 'contract_failed':
      // Phase 1396 Step D: 只呈现最终事实（reason/evidenceRef/producer）；
      // 不写 self-inbox、不给 motion 重启/取消处方（恢复决策归后续 phase）。
      return {
        contractId: event.contractId,
        reason: event.reason,
        evidenceRef: event.evidenceRef,
        producer: event.producer,
      };
    case 'subtask_completed':
      return event.forceAccepted === true
        ? { contract_id: event.contractId, subtask_id: event.subtaskId, force_accepted: true }
        : { contractId: event.contractId, subtaskId: event.subtaskId };
    case 'verification_failed':
      return {
        contract_id: event.contractId,
        subtask_id: event.subtaskId,
        cause: event.cause,
        feedback: event.feedback,
        retry_count: event.retryCount,
        max_attempts: event.maxAttempts,
      };
    default: {
      const exhaustive: never = event;
      throw new Error(`unknown contract notification variant: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function formatNotifyData(data: Record<string, unknown>): string {
  return Object.entries(data)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
}
