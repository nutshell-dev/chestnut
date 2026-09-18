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
  SUMMON_VERIFY_FALSE_VIOLATION: 'summon_verify_false_violation',
  SUMMON_STATE_READ_FAILED: 'summon_state_read_failed',
  SUMMON_GATE_NO_DECISION: 'summon_gate_no_decision',
  SUMMON_TARGET_CLAW_VIOLATION: 'summon_target_claw_violation',
  SUMMON_LEGACY_STATE_FILE_DETECTED: 'summon_legacy_state_file_detected',
  /**
   * Phase 1396 Step K: v2 active path invariants.
   * V2_EXECUTOR_CONTEXT_MISSING: ctx.clawDir 缺失，无法确定 executor。
   * GATE_UNKNOWN_SCHEMA_VERSION: task.summonDecision schema_version 非 1/2，fail-observable。
   */
  SUMMON_V2_EXECUTOR_CONTEXT_MISSING: 'summon_v2_executor_context_missing',
  SUMMON_GATE_UNKNOWN_SCHEMA_VERSION: 'summon_gate_unknown_schema_version',
  /**
   * phase 1129 P1-16: subagent audit.tsv 非 FNF 读失败。
   * 与 NO_CONTRACT_CREATED 区分：audit 不可读时契约状态不确定、禁止盲目 mining 重试。
   */
  SUB_AUDIT_READ_FAILED: 'summon_sub_audit_read_failed',
  LEGACY_RETRO_ACK_FAILED: 'summon_legacy_retro_ack_failed',
  /**
   * Phase 1396 Step B: 0/1 创建 claim 事件。
   * CONTRACT_ALREADY_CLAIMED: 同一 summonId 的第二候选被 policy 拒绝。
   * CLAIM_SKIPPED: summon task 缺少 executor 上下文（clawDir 与 decision.targetClaw 均缺失）、
   *   无法构造 claim —— 实然路径不可达（CLI contract create 必传 --claw），保留作防御审计。
   */
  SUMMON_CONTRACT_ALREADY_CLAIMED: 'summon_contract_already_claimed',
  SUMMON_CLAIM_SKIPPED: 'summon_claim_skipped',
  /**
   * Phase 1396 Step B: post-processor 创建事实核实事件。
   * CREATION_RECOVERED: task error envelope 但 claim 指向的 contract 已提交 → 恢复为成功。
   * CLAIM_CONTRACT_MISSING: claim 存在但 ContractSystem 核实无此 contract → 保持失败。
   * CREATION_EVIDENCE_MISMATCH: audit evidence 与 claim 不一致 / 出现第二个不同 contract
   *   evidence → invariant violation（evidence 只作审计交叉验证，不再是 authority）。
   */
  SUMMON_CREATION_RECOVERED: 'summon_creation_recovered',
  SUMMON_CLAIM_CONTRACT_MISSING: 'summon_claim_contract_missing',
  SUMMON_CREATION_EVIDENCE_MISMATCH: 'summon_creation_evidence_mismatch',
  /**
   * phase 1866 Step E（SU-D4）：系统面故障（读/查询失败）——owner=系统面。
   * 与 creation_rejected / execution_failed 分层：本事件伴随 typed
   * SummonSystemFaultError 上抛（ATS 有界 defer/retry 语义保持），不产出 delivered 失败。
   */
  SUMMON_SYSTEM_FAULT: 'summon_system_fault',
} as const;

export function emitSummonDispatched(audit: AuditLog, opts: {
  toolUseId: string;
  taskId: string;
}): void {
  // Phase 1396 Step C: 公开契约收缩后 mode/targetClaw/verify 不再是 agent 决策，
  // audit 只记录 accepted 事实（tool_use_id + task_id）。
  audit.write(
    SUMMON_AUDIT_EVENTS.DISPATCHED,
    `tool_use_id=${opts.toolUseId}`,
    `task_id=${opts.taskId}`,
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
