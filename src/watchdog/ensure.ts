/**
 * @module L6.Watchdog.Ensure
 * 「确保 watchdog 在运行」职责唯一入口 (M#1)
 *
 * Phase 1203 Step C: caller-side 锁/单飞/legacy lock migration 全部删除。
 * 单实例 authority 在真正执行主 loop 的子进程（目录 rename commit、M#4 磁盘即权威）；
 * caller 只做 alive fast-path + spawn candidate，成功条件是出现合法且 alive 的
 * `watchdog/active/owner.json`，不要求自己的 child 获胜。
 */
import type { FileSystem } from '../foundation/fs/index.js';
import {
  assertWatchdogOwnerWorkspace,
  inspectWatchdogOwner,
  WatchdogOwnerInspectionError,
} from './watchdog-pid.js';
import { spawnWatchdogCandidate } from './spawn.js';
import { createWatchdogActionAudit } from './audit-wiring.js';
import { admitWatchdogCandidate } from './candidate-recovery.js';
import { getChestnutFs } from './watchdog-context.js';
import { writeCandidateOutcome } from './watchdog-ownership.js';
import { formatErr } from '../foundation/node-utils/index.js';
import {
  inspectOrphanWatchdogs,
  type WatchdogOrphanInspectionDeps,
  type WatchdogOrphanInspectionReport,
} from './orphan-sweep.js';

export type EnsureWatchdogResult = (
  | { kind: 'already_running'; pid: number }
  | { kind: 'candidate_spawned'; pid: number; attemptId: string; windowId: string }
  | {
      kind: 'rejected';
      reason: 'budget_exhausted' | 'window_closed';
      attemptId: string;
      windowId: string;
    }
) & { startupInspection?: WatchdogOrphanInspectionReport };

export class WatchdogOrphanInspectionError extends Error {
  constructor(readonly report: WatchdogOrphanInspectionReport) {
    super(`Watchdog orphan inspection is ${report.kind}; startup refused without explicit recovery`);
    this.name = 'WatchdogOrphanInspectionError';
  }
}

/**
 * 唯一入口、所有 caller 必经此。
 * - foreign workspace → throw（caller 决定如何 surface）
 * - 已有合法 alive active owner → no-op（alive fast-path 仅为优化，非正确性条件）
 * - 未活 → spawn candidate；子进程在副作用前 commit ownership，
 *   并发 caller 可 spawn 多个短命 candidate，目录 rename 恰好一个 winner。
 */
export async function ensureWatchdog(
  fsFactory: (baseDir: string) => FileSystem,
  deps?: WatchdogOrphanInspectionDeps,
): Promise<EnsureWatchdogResult> {
  // Phase 1878 Step I: writer 生命周期归 action/进程——CLI action 已安装则复用
  // （非 owner handle、dispose no-op）；未安装则本调用 scoped own + 终态 dispose
  // （旧 ensureAuditWired lazy 悬挂语义退役）。
  const actionAudit = createWatchdogActionAudit(fsFactory);
  try {
    const inspection = inspectWatchdogOwner(fsFactory, deps);
    if (inspection.kind === 'unknown' || inspection.kind === 'malformed') {
      throw new WatchdogOwnerInspectionError(inspection);
    }
    if (inspection.kind !== 'none') assertWatchdogOwnerWorkspace(inspection);
    const startupInspection = await inspectOrphanWatchdogs(fsFactory, deps);
    if (startupInspection.kind === 'blocked') throw new WatchdogOrphanInspectionError(startupInspection);
    if (startupInspection.kind === 'recovery_required' && inspection.kind !== 'alive') {
      throw new WatchdogOrphanInspectionError(startupInspection);
    }
    const inspectionEvidence = startupInspection.decisions.length > 0
      ? { startupInspection }
      : {};
    if (inspection.kind === 'alive') {
      return { kind: 'already_running', pid: inspection.pid, ...inspectionEvidence };
    }

    const staleOwner = inspection.kind !== 'none' && inspection.source === 'active' && inspection.owner
      ? inspection.owner
      : null;
    const admission = admitWatchdogCandidate(getChestnutFs(fsFactory), staleOwner);
    if (admission.kind === 'rejected') {
      // A concurrent winner may have committed between the first inspection and
      // admission. Prefer that durable owner over surfacing a stale rejection.
      const current = inspectWatchdogOwner(fsFactory);
      if (current.kind === 'alive') {
        return { kind: 'already_running', pid: current.pid, ...inspectionEvidence };
      }
      return {
        kind: 'rejected',
        reason: admission.reason,
        attemptId: admission.attemptId,
        windowId: admission.windowId,
      };
    }

    try {
      const pid = await spawnWatchdogCandidate(fsFactory, admission.admission.attemptId);
      return {
        kind: 'candidate_spawned',
        pid,
        attemptId: admission.admission.attemptId,
        windowId: admission.admission.windowId,
        ...inspectionEvidence,
      };
    } catch (error) {
      try {
        writeCandidateOutcome(getChestnutFs(fsFactory), admission.admission.attemptId, {
          outcome: 'failed',
          reason: `caller_spawn_failed:${formatErr(error)}`,
        });
      } catch { // silent: preserve the original spawn failure
      }
      throw error;
    }
  } finally {
    actionAudit.dispose();
  }
}
