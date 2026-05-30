/**
 * Summon audit event names.
 *
 * Module-owned event namespace per H1 design.
 * 字符串值与起步态 events.ts DISPATCH_ 系列等价 / 0 漂移。
 */

import type { AuditLog } from '../../foundation/audit/index.js';

export const SUMMON_AUDIT_EVENTS = {
  LOAD_SKILLS_FAILED: 'summon_load_skills_failed',
  /**
   * phase 1466: subagent 完成但 0 次 contract create 成功（根据 subAudit ground truth）。
   * 取代 phase 1464 三件套（CONTRACT_DONE_NOT_FOUND/PARSE_FAILED/MISSING_FIELDS）的语义、
   * 判定从 LLM marker 自报告改系统真相（exec audit row）。
   */
  NO_CONTRACT_CREATED: 'summon_no_contract_created',
  WRITE_BY_CONTRACT_FAILED: 'summon_write_by_contract_failed',
  NO_DIALOG_CONTEXT: 'summon_no_dialog_context',
  RETRO_INDEX_PARSE_FAILED: 'retro_index_parse_failed',
  // phase 1411 (reframe of phase 1409): 业务决策事件 typed cols only.
  // goal body 0 入 audit — dialog/current.json 是 tool_use args 全文权威源、
  // CLI 凭 tool_use_id 跨源 join 取 goal。详 design/modules/l4_summon_system.md
  // §A.phase1409-summon-dispatched-and-rejected-business-events (amended-by phase 1411)。
  DISPATCHED: 'summon_dispatched',
  REJECTED_SHADOW: 'summon_rejected_shadow',
} as const;

export function emitSummonDispatched(audit: AuditLog, opts: {
  toolUseId: string;
  taskId: string;
  mode: 'shadow' | 'mining';
  targetClaw?: string;
  verify: boolean;
}): void {
  audit.write(
    SUMMON_AUDIT_EVENTS.DISPATCHED,
    `tool_use_id=${opts.toolUseId}`,
    `task_id=${opts.taskId}`,
    `mode=${opts.mode}`,
    ...(opts.targetClaw ? [`target_claw=${opts.targetClaw}`] : []),
    `verify=${opts.verify}`,
  );
}

export function emitSummonRejectedShadow(audit: AuditLog, opts: {
  toolUseId: string;
  reason: 'shadow_call_orphan_async_routing';
}): void {
  audit.write(
    SUMMON_AUDIT_EVENTS.REJECTED_SHADOW,
    `tool_use_id=${opts.toolUseId}`,
    `reason=${opts.reason}`,
  );
}
