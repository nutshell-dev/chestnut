/**
 * memory dream-state save 入口 schema invariant。
 *
 * 应然 anchor（per design/modules/l4_memory_system.md §「persist-state observability」、phase 247）:
 * - DP1 信息不丢失：dream-state 是 dream cron 累进权威进度
 * - DP2 不静默丢弃：违例 emit audit 消除静默
 * - DP3/DP5 状态可观察 + 凭日志记录重建：违例显式可观察
 *
 * 2 子模块共享 helper、按 source 字段分流走子模块特定 shape check：
 * - source='deep_dream_save': DreamStateData（lastProcessedDeepDreamAt / currentSessionDreamedDate / currentSessionRetryCount?）
 * - source='random_dream_save': RandomDreamState（completedContractIds / pendingLateSettle?）
 *
 * 不 throw（DP1 + Path #4 防 break dream cron 路径、保既有 save throw / 不 throw 业务语义对称差）。
 */

import type { AuditLog } from '../../foundation/audit/index.js';
import { MEMORY_AUDIT_EVENTS } from './audit-events.js';

export type DreamSaveSource = 'deep_dream_save' | 'random_dream_save';

export function assertDreamStateShape(
  state: unknown,
  audit: AuditLog,
  source: DreamSaveSource,
): void {
  if (typeof state !== 'object' || state === null) {
    audit.write(
      MEMORY_AUDIT_EVENTS.MEMORY_DREAM_INVARIANT_VIOLATED,
      `kind=state_not_object`, `source=${source}`, `actual=${typeof state}`,
    );
    return;
  }

  if (source === 'deep_dream_save') {
    checkDeepDream(state as Record<string, unknown>, audit);
  } else {
    checkRandomDream(state as Record<string, unknown>, audit);
  }
}

function checkDeepDream(s: Record<string, unknown>, audit: AuditLog): void {
  // lastProcessedDeepDreamAt: number (finite, non-negative)
  if (typeof s.lastProcessedDeepDreamAt !== 'number'
      || !Number.isFinite(s.lastProcessedDeepDreamAt)
      || s.lastProcessedDeepDreamAt < 0) {
    audit.write(
      MEMORY_AUDIT_EVENTS.MEMORY_DREAM_INVARIANT_VIOLATED,
      `kind=deep_lastProcessedDeepDreamAt_invalid`, `source=deep_dream_save`,
      `actual=${String(s.lastProcessedDeepDreamAt)}`,
    );
  }

  // currentSessionDreamedDate: string (empty or YYYY-MM-DD)
  if (typeof s.currentSessionDreamedDate !== 'string') {
    audit.write(
      MEMORY_AUDIT_EVENTS.MEMORY_DREAM_INVARIANT_VIOLATED,
      `kind=deep_currentSessionDreamedDate_not_string`, `source=deep_dream_save`,
      `actual=${typeof s.currentSessionDreamedDate}`,
    );
  } else if (s.currentSessionDreamedDate !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(s.currentSessionDreamedDate)) {
    audit.write(
      MEMORY_AUDIT_EVENTS.MEMORY_DREAM_INVARIANT_VIOLATED,
      `kind=deep_currentSessionDreamedDate_invalid_format`, `source=deep_dream_save`,
      `actual=${s.currentSessionDreamedDate}`,
    );
  }

  // currentSessionRetryCount?: number (non-negative integer)
  if (s.currentSessionRetryCount !== undefined) {
    if (typeof s.currentSessionRetryCount !== 'number' ||
        !Number.isInteger(s.currentSessionRetryCount) ||
        s.currentSessionRetryCount < 0) {
      audit.write(
        MEMORY_AUDIT_EVENTS.MEMORY_DREAM_INVARIANT_VIOLATED,
        `kind=deep_currentSessionRetryCount_invalid`, `source=deep_dream_save`,
        `actual=${String(s.currentSessionRetryCount)}`,
      );
    }
  }
}

function checkRandomDream(s: Record<string, unknown>, audit: AuditLog): void {
  // completedContractIds: string[]
  if (!Array.isArray(s.completedContractIds)) {
    audit.write(
      MEMORY_AUDIT_EVENTS.MEMORY_DREAM_INVARIANT_VIOLATED,
      `kind=random_completedContractIds_not_array`, `source=random_dream_save`,
      `actual=${typeof s.completedContractIds}`,
    );
  } else {
    for (let i = 0; i < s.completedContractIds.length; i++) {
      const id = s.completedContractIds[i];
      if (typeof id !== 'string') {
        audit.write(
          MEMORY_AUDIT_EVENTS.MEMORY_DREAM_INVARIANT_VIOLATED,
          `kind=random_completedContractIds_entry_not_string`, `source=random_dream_save`,
          `idx=${i}`, `actual=${typeof id}`,
        );
      }
    }
  }

  // pendingLateSettle?: PendingLateSettleEntry[]（taskId/string + scheduledAt/number + expectedTimeoutAt/number）
  if (s.pendingLateSettle !== undefined) {
    if (!Array.isArray(s.pendingLateSettle)) {
      audit.write(
        MEMORY_AUDIT_EVENTS.MEMORY_DREAM_INVARIANT_VIOLATED,
        `kind=random_pendingLateSettle_not_array`, `source=random_dream_save`,
        `actual=${typeof s.pendingLateSettle}`,
      );
    } else {
      for (let i = 0; i < s.pendingLateSettle.length; i++) {
        const e = s.pendingLateSettle[i];
        if (typeof e !== 'object' || e === null
            || typeof (e as Record<string, unknown>).taskId !== 'string'
            || typeof (e as Record<string, unknown>).scheduledAt !== 'number'
            || typeof (e as Record<string, unknown>).expectedTimeoutAt !== 'number') {
          audit.write(
            MEMORY_AUDIT_EVENTS.MEMORY_DREAM_INVARIANT_VIOLATED,
            `kind=random_pendingLateSettle_entry_invalid`, `source=random_dream_save`,
            `idx=${i}`,
          );
        }
      }
    }
  }
}
