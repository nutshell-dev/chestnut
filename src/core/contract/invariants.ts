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

// phase 282 Step A: CONTRACT_STATUS_SET 已删除（status 改 derive、不再做 shape invariant check）

const SUBTASK_STATUS_SET: ReadonlySet<string> = new Set(['todo', 'in_progress', 'completed']);

export function assertProgressShapeInvariants(
  progress: ProgressData,
  audit: AuditLog,
  source: 'saveProgress' | 'boot_reconcile_escalated' | 'boot_reconcile_all_completed',
): void {
  checkSchemaVersion(progress, audit, source);
  // phase 282 Step A: status 改 derive from subtasks，不再做 shape invariant check
  // phase 282 Step B: contract_id 改 derive from caller/dir，不再做 shape invariant check
  // checkContractStatusInUnion(progress, audit, source);
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
