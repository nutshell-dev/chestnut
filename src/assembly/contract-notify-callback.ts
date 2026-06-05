/**
 * @module L6.Assembly.ContractNotifyCallback
 * @layer L6 装配层
 * @consumers L6.Assembly.assemble
 *
 * Contract event → outbox notify 回调工厂、按 type 分发 / formatNotifyData 序列化 / outbox.write 发出。
 * 抽出动机：assemble() M#1/SRP 治理（assembly-auditor §六.4 follow-up）。
 *
 * phase 37：variable `motionInboxDir` → `selfInboxDir` 命名 hygiene + 注释 calibration（详 §A.6）。
 */

import type { StreamWriter } from '../foundation/stream/index.js';
import type { AuditLog } from '../foundation/audit/index.js';
import type { ClawId } from '../foundation/paths.js';
import type { FileSystem } from '../foundation/fs/types.js';
import { notifyInbox } from '../foundation/messaging/index.js';

export interface ContractNotifyDeps {
  streamWriter: StreamWriter;
  clawId: ClawId;
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

export type ContractNotifyCallback = (type: string, data: Record<string, unknown>) => void;

export function createContractNotifyCallback(deps: ContractNotifyDeps): ContractNotifyCallback {
  return (type: string, data: Record<string, unknown>) => {
    deps.streamWriter.write({ ts: Date.now(), type: 'user_notify', subtype: type, ...data });

    // §A.6 双链路：本 daemon 自家 inbox 接契约终态事件（决策点）
    // subtask_completed / verification_failed 仅 streamWriter（viewport 可见、决策无用）
    if (type === 'contract_completed') {
      // phase 1487: 透传 source_claw 给 motion guidance composer
      //   - composer 见 source_claw == MOTION_CLAW_ID → null (motion 自家、session 已含上下文)
      // phase 37: 写 selfInboxDir（本 daemon 自家、详 deps.selfInboxDir doc）
      //   - motion daemon: 写 motion 自家 inbox
      //   - worker daemon: 写 worker 自家 inbox
      //   跨 claw 通知归 contract-observer cron
      notifyInbox(deps.systemFs, {
        inboxDir: deps.selfInboxDir,
        type: 'contract_events',
        source: 'system',
        priority: 'high',
        body: `[${type}] claw=${deps.clawId} ${formatNotifyData(data)}`,
        extraFields: {
          source_claw: deps.clawId,
        },
      }, deps.auditWriter);
    }

    // phase 63: contract_cancelled NEW
    if (type === 'contract_cancelled') {
      const reason = typeof data.reason === 'string' ? data.reason : '';
      notifyInbox(deps.systemFs, {
        inboxDir: deps.selfInboxDir,
        type: 'contract_cancelled',
        source: 'system',
        priority: 'high',
        body: `[contract_cancelled] claw=${deps.clawId} ${formatNotifyData(data)}`,
        extraFields: {
          source_claw: deps.clawId,
          contract_id: String(data.contractId ?? ''),
          reason,
        },
      }, deps.auditWriter);
    }

    // phase 63: contract_crashed NEW
    if (type === 'contract_crashed') {
      const cause = typeof data.cause === 'string' ? data.cause : '';
      notifyInbox(deps.systemFs, {
        inboxDir: deps.selfInboxDir,
        type: 'contract_crashed',
        source: 'system',
        priority: 'high',
        body: `[contract_crashed] claw=${deps.clawId} ${formatNotifyData(data)}`,
        extraFields: {
          source_claw: deps.clawId,
          contract_id: String(data.contractId ?? ''),
          cause,
        },
      }, deps.auditWriter);
    }
  };
}

function formatNotifyData(data: Record<string, unknown>): string {
  return Object.entries(data)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
}
