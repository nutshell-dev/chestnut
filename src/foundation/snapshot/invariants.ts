/**
 * snapshot SnapshotState persistState 入口 schema invariant。
 *
 * 应然 anchor（per design/modules/l<X>_snapshot.md §「persist-state observability」、phase 275 Step A + phase 285 Step A）：
 * - DP1 信息不丢失：state.json 是降级控制状态、shape 漂 = 降级决策错乱
 * - DP2 不静默丢弃：违例 emit audit 消除静默
 * - DP3/DP5 状态可观察 + 凭日志记录重建：违例显式可观察
 *
 * tagged-union 2 branch：
 * - ok:    { kind: 'ok' }
 * - degraded: { kind: 'degraded'; failures: number + finite + 非负整数; degradedAt: number + finite }
 *
 * 与 `init()` load 端 parseSnapshotState 对称：load 端违例 emit state_corrupt + clear state、
 * save 端本 Step 加对称 invariant emit（不 clear、保 acceptable degradation persist 路径）。
 *
 * 不 throw（DP1 + Path #4 防 break persistState silent fail 路径、acceptable degradation by design）。
 */

import type { AuditLog } from '../audit/index.js';
import { SNAPSHOT_AUDIT_EVENTS } from './audit-events.js';

// phase 701: 加 dir param、emit 加 dir col、延续 phase 699 STATE_CORRUPT + phase 700
// STATE_CROSS_SOURCE_MISMATCH 形态、forensic multi-snapshot 场景 join dir 维度
export function assertSnapshotStateShape(state: unknown, audit: AuditLog, dir: string): void {
  if (typeof state !== 'object' || state === null) {
    audit.write(
      SNAPSHOT_AUDIT_EVENTS.STATE_INVARIANT_VIOLATED,
      `dir=${dir}`, `kind=state_not_object`, `actual=${typeof state}`,
    );
    return;
  }
  const s = state as { kind?: unknown };

  if (s.kind === 'ok') {
    return;
  }

  if (s.kind === 'degraded') {
    checkDegradedShape(state as { failures?: unknown; degradedAt?: unknown }, audit, dir);
    return;
  }

  audit.write(
    SNAPSHOT_AUDIT_EVENTS.STATE_INVARIANT_VIOLATED,
    `dir=${dir}`, `kind=kind_invalid`, `actual=${String(s.kind)}`,
  );
}

function checkDegradedShape(s: { failures?: unknown; degradedAt?: unknown }, audit: AuditLog, dir: string): void {
  const failures = s.failures;
  const degradedAt = s.degradedAt;

  if (typeof failures !== 'number' || !Number.isFinite(failures) || !Number.isInteger(failures) || failures < 0) {
    audit.write(
      SNAPSHOT_AUDIT_EVENTS.STATE_INVARIANT_VIOLATED,
      `dir=${dir}`, `kind=failures_invalid`, `actual=${String(failures)}`,
    );
  }

  if (typeof degradedAt !== 'number' || !Number.isFinite(degradedAt)) {
    audit.write(
      SNAPSHOT_AUDIT_EVENTS.STATE_INVARIANT_VIOLATED,
      `dir=${dir}`, `kind=degradedAt_invalid`, `actual=${String(degradedAt)}`,
    );
  }
}
