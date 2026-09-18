/**
 * @module L4.ShadowSystem.LifecycleAudit
 * @layer L4
 *
 * phase 1865 (SH-D9)：shadow 生命周期审计事件的单一 owner——入口层（工具拒递归）与
 * 执行层（started/prefix_restored/failed/finished）同经本模块写入。
 * 事件字符串与列格式逐列沿用（SHADOW_AUDIT_EVENTS），零 audit 面漂移；
 * sink 为 optional（省略静默——测试/无 audit 场景保持）。
 */

import type { AuditLog } from '../../foundation/audit/index.js';
import { SHADOW_AUDIT_EVENTS } from './audit-events.js';

export function emitShadowStarted(audit: AuditLog | undefined, shadowId: string, task: string): void {
  if (!audit) return;
  audit.write(SHADOW_AUDIT_EVENTS.STARTED, shadowId, audit.preview(task));
}

export function emitShadowPrefixRestored(audit: AuditLog | undefined, shadowId: string): void {
  audit?.write(SHADOW_AUDIT_EVENTS.PREFIX_RESTORED, `shadowId=${shadowId}`);
}

export function emitShadowFinished(audit: AuditLog | undefined, shadowId: string): void {
  audit?.write(SHADOW_AUDIT_EVENTS.FINISHED, `shadowId=${shadowId}`);
}

export function emitShadowFailed(
  audit: AuditLog | undefined,
  shadowId: string,
  error: string,
  phase?: string,
): void {
  const cols: string[] = [`shadowId=${shadowId}`];
  if (phase !== undefined) cols.push(`phase=${phase}`);
  cols.push(`error=${error}`);
  audit?.write(SHADOW_AUDIT_EVENTS.FAILED, ...cols);
}

export function emitShadowRecursionRejected(audit: AuditLog | undefined, clawId: string): void {
  audit?.write(SHADOW_AUDIT_EVENTS.RECURSION_REJECTED, clawId);
}
