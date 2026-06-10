/**
 * contract progress.json save 入口结构合法性 invariant。
 *
 * 应然 anchor（per design/modules/l4_contract_system.md §「persist-state observability」、phase 233）：
 * - DP1 信息不丢失：progress.json 是 contract 权威状态、保 schema 合法是 DP1 最后一道闸门
 * - DP2 不静默丢弃：违例 emit audit 消除静默
 * - DP3/DP5 状态可观察 + 凭日志记录重建：违例显式可观察
 *
 * 与 `manager.ts:getProgress` load 端 schema check 对称：load 守得严、save 守同样严。
 * load 端违例走 isolateCorruptedFile + markCrashed；save 端只 emit audit（不 isolate 文件、Path #4 防 break prod saveProgress 路径）。
 */

import type { AuditLog } from '../../foundation/audit/index.js';
import type { ProgressData } from './types.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';

// ContractStatus union 7 值（与 types.ts:27-34 同源、改时同步）
const CONTRACT_STATUS_SET: ReadonlySet<string> = new Set([
  'pending', 'running', 'paused', 'completed', 'cancelled', 'crashed', 'archive_pending_recovery',
]);

const SUBTASK_STATUS_SET: ReadonlySet<string> = new Set(['todo', 'in_progress', 'completed']);

export function assertProgressShapeInvariants(
  progress: ProgressData,
  audit: AuditLog,
  source: 'saveProgress' | 'boot_reconcile_escalated' | 'boot_reconcile_all_completed',
): void {
  checkSchemaVersion(progress, audit, source);
  checkContractIdNonEmpty(progress, audit, source);
  checkContractStatusInUnion(progress, audit, source);
  checkSubtasksShape(progress, audit, source);
}

function checkSchemaVersion(p: ProgressData, audit: AuditLog, source: string): void {
  if (p.schema_version === undefined) return;   // 兼容旧文件（不强求）
  // PROGRESS_CURRENT_SCHEMA_VERSION 与 persistence.ts 同步（当前 = 1）
  if (typeof p.schema_version !== 'number' || p.schema_version > 1) {
    audit.write(
      CONTRACT_AUDIT_EVENTS.CONTRACT_PROGRESS_INVARIANT_VIOLATED,
      `kind=schema_version_invalid`,
      `contract_id=${String(p.contract_id ?? 'unknown')}`,
      `actual=${String(p.schema_version)}`,
      `current=1`,
      `source=${source}`,
    );
  }
}

function checkContractIdNonEmpty(p: ProgressData, audit: AuditLog, source: string): void {
  if (typeof p.contract_id !== 'string' || p.contract_id.length === 0) {
    audit.write(
      CONTRACT_AUDIT_EVENTS.CONTRACT_PROGRESS_INVARIANT_VIOLATED,
      `kind=contract_id_invalid`,
      `actual=${String(p.contract_id)}`,
      `source=${source}`,
    );
  }
}

function checkContractStatusInUnion(p: ProgressData, audit: AuditLog, source: string): void {
  if (!CONTRACT_STATUS_SET.has(p.status as string)) {
    audit.write(
      CONTRACT_AUDIT_EVENTS.CONTRACT_PROGRESS_INVARIANT_VIOLATED,
      `kind=status_not_in_union`,
      `contract_id=${String(p.contract_id ?? 'unknown')}`,
      `actual=${String(p.status)}`,
      `source=${source}`,
    );
  }
}

function checkSubtasksShape(p: ProgressData, audit: AuditLog, source: string): void {
  if (typeof p.subtasks !== 'object' || p.subtasks === null) {
    audit.write(
      CONTRACT_AUDIT_EVENTS.CONTRACT_PROGRESS_INVARIANT_VIOLATED,
      `kind=subtasks_not_object`,
      `contract_id=${String(p.contract_id ?? 'unknown')}`,
      `source=${source}`,
    );
    return;
  }
  for (const [stId, st] of Object.entries(p.subtasks)) {
    if (!st || typeof st !== 'object') {
      audit.write(
        CONTRACT_AUDIT_EVENTS.CONTRACT_PROGRESS_INVARIANT_VIOLATED,
        `kind=subtask_not_object`,
        `contract_id=${String(p.contract_id ?? 'unknown')}`,
        `subtask_id=${stId}`,
        `source=${source}`,
      );
      continue;
    }
    if (!SUBTASK_STATUS_SET.has((st as { status?: string }).status as string)) {
      audit.write(
        CONTRACT_AUDIT_EVENTS.CONTRACT_PROGRESS_INVARIANT_VIOLATED,
        `kind=subtask_status_not_in_union`,
        `contract_id=${String(p.contract_id ?? 'unknown')}`,
        `subtask_id=${stId}`,
        `actual=${String((st as { status?: string }).status)}`,
        `source=${source}`,
      );
    }
  }
}
