/**
 * memory dream-state internal self-consistency audit.
 *
 * 应然 anchor（per design/modules/l4_memory_system.md §「persist-state observability」、phase 247 Step B + phase 280）:
 * - DP1 信息不丢失：state 内"已处理"标记与实然 archive 集合应同步、漂移 = 重复处理或永久遗漏
 * - DP5 凭日志记录重建：state 演进 + archive 实然应等价
 * - M#3 资源唯一：archive list 归 L2 DialogStore (deep-dream) / L4 ContractSystem (random-dream)、memory 调
 *
 * phase 280: 高水位线改造后，DC-1/DC-2/RC-1（集合 subset/unique check）消除，
 * 仅保留内部自洽 check：
 * deep-dream:
 * - DC-3: state.currentSessionRetryCount ?? 0 < 上限（防 runaway）
 *
 * random-dream:
 * - RC-2: pendingLateSettle 内 taskId 唯一
 * - RC-3: pendingLateSettle 内 expectedTimeoutAt >= scheduledAt
 *
 * 不 throw（DP1 + Path #4 防 break dream cron 路径）。
 */

import type { AuditLog } from '../../foundation/audit/index.js';
import { MEMORY_AUDIT_EVENTS } from './audit-events.js';

/**
 * deep-dream.ts 内 retry exhausted 阈值（cross-source audit 验证用、phase 1200 立）.
 * Derivation: 3 = deep-dream.ts retry 上限的镜像值 / 配 DEFAULT_VERIFICATION_ATTEMPTS=3 同型 /
 * 若 deep-dream.ts 改 retry 限定、本 const 需同步.
 */
const DEEP_DREAM_RETRY_UPPER_BOUND = 3;

interface DeepDreamStateLike {
  currentSessionRetryCount?: number;
}

interface RandomDreamStateLike {
  pendingLateSettle?: Array<{ taskId: string; scheduledAt: number; expectedTimeoutAt: number }>;
}

export function auditDeepDreamCrossSource(
  state: DeepDreamStateLike,
  audit: AuditLog,
): void {
  checkDC3_RetryCountBound(state, audit);
}

export function auditRandomDreamCrossSource(
  state: RandomDreamStateLike,
  audit: AuditLog,
): void {
  checkRC2_PendingTaskIdUnique(state, audit);
  checkRC3_PendingTimingValid(state, audit);
}

function checkDC3_RetryCountBound(s: DeepDreamStateLike, audit: AuditLog): void {
  const rc = s.currentSessionRetryCount ?? 0;
  if (rc < DEEP_DREAM_RETRY_UPPER_BOUND) return;
  audit.write(
    MEMORY_AUDIT_EVENTS.MEMORY_DREAM_CROSS_SOURCE_MISMATCH,
    `kind=dc3_retry_runaway`, `count=${rc}`, `upper=${DEEP_DREAM_RETRY_UPPER_BOUND}`,
  );
}

function checkRC2_PendingTaskIdUnique(s: RandomDreamStateLike, audit: AuditLog): void {
  if (!s.pendingLateSettle) return;
  const seen = new Set<string>();
  const dups: string[] = [];
  for (const e of s.pendingLateSettle) {
    if (seen.has(e.taskId)) dups.push(e.taskId); else seen.add(e.taskId);
  }
  if (dups.length === 0) return;
  audit.write(
    MEMORY_AUDIT_EVENTS.MEMORY_DREAM_CROSS_SOURCE_MISMATCH,
    `kind=rc2_pending_taskId_duplicate`,
    `dup_ids=${dups.slice(0, 5).join(',')}`, `dup_count=${dups.length}`,
  );
}

function checkRC3_PendingTimingValid(s: RandomDreamStateLike, audit: AuditLog): void {
  if (!s.pendingLateSettle) return;
  const bad: string[] = [];
  for (const e of s.pendingLateSettle) {
    if (e.expectedTimeoutAt < e.scheduledAt) bad.push(e.taskId);
  }
  if (bad.length === 0) return;
  audit.write(
    MEMORY_AUDIT_EVENTS.MEMORY_DREAM_CROSS_SOURCE_MISMATCH,
    `kind=rc3_pending_timing_invalid`,
    `bad_ids=${bad.slice(0, 5).join(',')}`, `bad_count=${bad.length}`,
  );
}
