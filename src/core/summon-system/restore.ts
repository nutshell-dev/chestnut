/**
 * @module L4.SummonSystem.Restore
 *
 * phase 1866 Step H（SU-D8）：Summon 恢复事实**单一入口**。
 *
 * 恢复面在本入口汇总为一份只读报告：
 * - legacy pending-retrospective 待办列举（补报面，非创建 evidence）；
 * - creation claim 核对（authority 面：不可读/损坏 claim 显式列出）。
 *
 * 边界：
 * - 子面实现不搬家、行为逐个不变（列举/ack 语义原样）；
 * - 面级读取故障进 `issues`（DP：恢复事实缺失不静默），不 throw；
 * - 本入口不写任何状态、不产生 audit。
 *
 * Phase 1890 Step E：legacy `summon-state/` 残留扫描子面删除（存量废弃），
 * 随删 `SUMMON_LEGACY_STATE_FILE_DETECTED` 事件与 audit 透传依赖。
 */

import type { FileSystem } from '../../foundation/fs/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import { listPendingRetrospectives, type PendingRetroRef } from './pending-retrospective.js';
import type { SummonCreationClaimStore } from './creation-claim-store.js';

/** claim 核对异常项（authority 面）。 */
export interface SummonClaimIssue {
  readonly summonId: string;
  readonly detail: string;
}

/** 面级故障（恢复事实不可得的原因，不静默）。 */
export interface SummonRestoreIssue {
  readonly face: 'pending_retrospectives' | 'claims';
  readonly detail: string;
}

/** Summon 恢复事实报告（只读汇总）。 */
export interface SummonRestoreReport {
  readonly pendingRetrospectives: readonly PendingRetroRef[];
  readonly claimIssues: readonly SummonClaimIssue[];
  readonly issues: readonly SummonRestoreIssue[];
}

export interface SummonRestoreDeps {
  /** claw 面 fs（clawspace/pending-retrospective 列举）。 */
  fs: FileSystem;
  /** authority 面 claim store（装配期同一 factory 注入）。 */
  claimStore: SummonCreationClaimStore;
}

/** 恢复事实单一入口：汇总各面、逐面带故障隔离（不 throw）。 */
export async function restoreSummonFacts(deps: SummonRestoreDeps): Promise<SummonRestoreReport> {
  const { fs, claimStore } = deps;
  const issues: SummonRestoreIssue[] = [];

  let pendingRetrospectives: readonly PendingRetroRef[] = [];
  try {
    pendingRetrospectives = await listPendingRetrospectives({ fs });
  } catch (err) {
    issues.push({ face: 'pending_retrospectives', detail: formatErr(err) });
  }

  const claimIssues: SummonClaimIssue[] = [];
  try {
    const listing = await claimStore.list();
    if (!listing.readable) {
      issues.push({ face: 'claims', detail: 'creation claim directory unreadable' });
    }
    claimIssues.push(...listing.unreadable);
  } catch (err) {
    issues.push({ face: 'claims', detail: formatErr(err) });
  }

  return { pendingRetrospectives, claimIssues, issues };
}
