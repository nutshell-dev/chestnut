/**
 * snapshot SnapshotState 内部自洽 cross-source audit。
 *
 * 应然 anchor（per design/modules/l<X>_snapshot.md §「persist-state observability」、phase 275 Step B + phase 285 Step A）：
 * - DP1 信息不丢失：state 内部字段语义不一致 = 降级决策错乱
 * - DP3 状态可观察：2 check 各显式 audit
 * - DP5 凭日志记录重建：state 演进契约抬到运行期
 * - M#3 资源唯一：snapshot 自治、scope 限内部自洽（无业务集合 cross-source）
 * - M#9 tagged union 编译期 enforce 互斥：degradedAt set ⇒ failures > 0 已由类型保证、
 *   故删除原 SC-2（phase 285 消除 by-construction illegal combination）
 *
 * 2 check：
 * - SC-1: degraded 时 failures >= 0 非负整数
 * - SC-3: degraded 时 degradedAt <= now（timestamp 不在 future）
 *
 * 不 throw（DP1 + Path #4 防 break persistState silent fail 路径）。
 */

import type { AuditLog } from '../audit/index.js';
import { SNAPSHOT_AUDIT_EVENTS } from './audit-events.js';

type SnapshotStateLike =
  | { kind: 'ok' }
  | { kind: 'degraded'; failures: number; degradedAt: number };

// phase 700: 加 dir param、emit 加 dir col、与 phase 699 STATE_CORRUPT + 同模块其他 emit 形态对齐
export function auditSnapshotStateCrossSource(
  state: SnapshotStateLike,
  audit: AuditLog,
  now: number,
  dir: string,
): void {
  if (state.kind === 'ok') return;

  checkSC1(state, audit, dir);
  checkSC3(state, audit, now, dir);
}

function checkSC1(s: { failures: number }, audit: AuditLog, dir: string): void {
  if (s.failures < 0 || !Number.isInteger(s.failures)) {
    audit.write(
      SNAPSHOT_AUDIT_EVENTS.STATE_CROSS_SOURCE_MISMATCH,
      `dir=${dir}`,
      `kind=sc1_failures_invalid`,
      `actual=${s.failures}`,
    );
  }
}

function checkSC3(s: { degradedAt: number }, audit: AuditLog, now: number, dir: string): void {
  if (s.degradedAt > now) {
    audit.write(
      SNAPSHOT_AUDIT_EVENTS.STATE_CROSS_SOURCE_MISMATCH,
      `dir=${dir}`,
      `kind=sc3_degradedAt_in_future`,
      `degradedAt=${s.degradedAt}`, `now=${now}`,
    );
  }
}
