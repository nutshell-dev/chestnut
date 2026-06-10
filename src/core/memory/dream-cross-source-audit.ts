/**
 * memory dream-state processed-set ↔ archive 实然权威列表 cross-source audit。
 *
 * 应然 anchor（per design/modules/l4_memory_system.md §「persist-state observability」、phase 247 Step B）：
 * - DP1 信息不丢失：state 内"已处理"标记与实然 archive 集合应同步、漂移 = 重复处理或永久遗漏
 * - DP5 凭日志记录重建：state 演进 + archive 实然应等价
 * - M#3 资源唯一：archive list 归 L2 DialogStore (deep-dream) / L4 ContractSystem (random-dream)、memory 调
 *
 * 6 check 维度（互独立、各 emit）：
 * deep-dream:
 * - DC-1: set(state.processedArchives) ⊆ set(dialogStore.listArchives())
 * - DC-2: state.processedArchives 元素唯一
 * - DC-3: state.currentSessionRetryCount ?? 0 < 上限（防 runaway）
 *
 * random-dream:
 * - RC-1: set(state.processedContractIds) ⊆ set(listArchiveContracts())
 * - RC-2: pendingLateSettle 内 taskId 唯一
 * - RC-3: pendingLateSettle 内 expectedTimeoutAt >= scheduledAt
 *
 * 不 throw（DP1 + Path #4 防 break dream cron 路径）。
 * archive list provider 失败 → emit _skipped、子集 check 跳、内部 check 仍跑。
 */

import { formatErr } from '../../foundation/utils/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { MEMORY_AUDIT_EVENTS } from './audit-events.js';

// deep-dream.ts 内 retry exhausted 阈值 = 3（phase 1200）
const DEEP_DREAM_RETRY_UPPER_BOUND = 3;

interface DeepDreamStateLike {
  processedArchives: string[];
  currentSessionRetryCount?: number;
}

interface RandomDreamStateLike {
  processedContractIds: string[];
  pendingLateSettle?: Array<{ taskId: string; scheduledAt: number; expectedTimeoutAt: number }>;
}

export async function auditDeepDreamCrossSource(
  state: DeepDreamStateLike,
  listArchives: () => Promise<string[]>,
  audit: AuditLog,
): Promise<void> {
  // DC-2/DC-3 内部 check、独立跑
  checkDC2_ProcessedArchivesUnique(state, audit);
  checkDC3_RetryCountBound(state, audit);

  // DC-1 archive subset 依赖外部 list、降级路径
  let archives: Set<string>;
  try {
    archives = new Set(await listArchives());
  } catch (err) {
    audit.write(
      MEMORY_AUDIT_EVENTS.MEMORY_DREAM_CROSS_SOURCE_SKIPPED,
      `kind=deep_dc1_skip`, `reason=list_archives_failed`,
      `error=${formatErr(err)}`
    );
    return;
  }
  checkDC1_ProcessedArchivesSubset(state, archives, audit);
}

export async function auditRandomDreamCrossSource(
  state: RandomDreamStateLike,
  listArchiveContractIds: () => Promise<string[]>,
  audit: AuditLog,
): Promise<void> {
  // RC-2/RC-3 内部 check、独立跑
  checkRC2_PendingTaskIdUnique(state, audit);
  checkRC3_PendingTimingValid(state, audit);

  // RC-1 archive subset
  let archives: Set<string>;
  try {
    archives = new Set(await listArchiveContractIds());
  } catch (err) {
    audit.write(
      MEMORY_AUDIT_EVENTS.MEMORY_DREAM_CROSS_SOURCE_SKIPPED,
      `kind=random_rc1_skip`, `reason=list_archive_contracts_failed`,
      `error=${formatErr(err)}`
    );
    return;
  }
  checkRC1_ProcessedContractIdsSubset(state, archives, audit);
}

function checkDC1_ProcessedArchivesSubset(
  s: DeepDreamStateLike, archives: Set<string>, audit: AuditLog,
): void {
  const orphan = s.processedArchives.filter(a => !archives.has(a));
  if (orphan.length === 0) return;
  audit.write(
    MEMORY_AUDIT_EVENTS.MEMORY_DREAM_CROSS_SOURCE_MISMATCH,
    `kind=dc1_processedArchives_orphan`,
    `orphan_ids=${orphan.slice(0, 5).join(',')}`,
    `orphan_count=${orphan.length}`,
    `archive_total=${archives.size}`,
  );
}

function checkDC2_ProcessedArchivesUnique(s: DeepDreamStateLike, audit: AuditLog): void {
  const seen = new Set<string>();
  const dups: string[] = [];
  for (const a of s.processedArchives) {
    if (seen.has(a)) dups.push(a); else seen.add(a);
  }
  if (dups.length === 0) return;
  audit.write(
    MEMORY_AUDIT_EVENTS.MEMORY_DREAM_CROSS_SOURCE_MISMATCH,
    `kind=dc2_processedArchives_duplicate`,
    `dup_ids=${dups.slice(0, 5).join(',')}`, `dup_count=${dups.length}`,
  );
}

function checkDC3_RetryCountBound(s: DeepDreamStateLike, audit: AuditLog): void {
  const rc = s.currentSessionRetryCount ?? 0;
  if (rc < DEEP_DREAM_RETRY_UPPER_BOUND) return;
  audit.write(
    MEMORY_AUDIT_EVENTS.MEMORY_DREAM_CROSS_SOURCE_MISMATCH,
    `kind=dc3_retry_runaway`, `count=${rc}`, `upper=${DEEP_DREAM_RETRY_UPPER_BOUND}`,
  );
}

function checkRC1_ProcessedContractIdsSubset(
  s: RandomDreamStateLike, archives: Set<string>, audit: AuditLog,
): void {
  const orphan = s.processedContractIds.filter(id => !archives.has(id));
  if (orphan.length === 0) return;
  audit.write(
    MEMORY_AUDIT_EVENTS.MEMORY_DREAM_CROSS_SOURCE_MISMATCH,
    `kind=rc1_processedContractIds_orphan`,
    `orphan_ids=${orphan.slice(0, 5).join(',')}`, `orphan_count=${orphan.length}`,
    `archive_total=${archives.size}`,
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
