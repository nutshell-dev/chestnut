/**
 * SubAgent audit event names.
 *
 * Module-owned event namespace per H1 design (phase338 / r36 α 决策).
 * 字符串值与起步态 events.ts SUBAGENT_ 系列等价 / 0 漂移。
 */

import type { AuditLog } from '../../foundation/audit/index.js';
import type { ToolUseId } from '../../foundation/tool-protocol/index.js';

export const SUBAGENT_AUDIT_EVENTS = {
  // phase 140: tool_result emitted by stream-callbacks (owner: subagent module)
  TOOL_RESULT: 'tool_result',
  STEP_COMPLETE_FAILED: 'subagent_step_complete_failed',
  PERSIST_FAILED: 'subagent_persist_failed',
  LOG_APPEND_FAILED: 'subagent_log_append_failed',
  GHOST_CALLBACK_AFTER_TURN_END: 'ghost_callback_after_turn_end',
  // STREAM_APPEND_FAILED removed (phase 1152 G.1): PerResourceStreamWriter internally emits
  // STREAM_AUDIT_EVENTS.APPEND_FAILED with full path context; caller-side duplicate emit eliminated.
  TIMEOUT_REJECTION: 'subagent_timeout_rejection',
  // phase 1411 (reframe of phase 1409): generic tool_call index row.
  // 仅 name + tool_use_id + args_size — args body 0 入 audit.
  // dialog/current.json 是 tool_use args 全文权威源、CLI 凭 tool_use_id 跨源 join。
  // 详 design/modules/l3_subagent.md §A.phase1409-on-tool-call-args-emit
  // (amended-by phase 1411)。
  TOOL_CALL_INPUT: 'tool_call_input',
  SUBAGENT_STEPS_INVARIANT_VIOLATED: 'subagent_steps_invariant_violated',
  SUBAGENT_ARTIFACT_CROSS_SOURCE_MISMATCH: 'subagent_artifact_cross_source_mismatch',
  SUBAGENT_ARTIFACT_CROSS_SOURCE_SKIPPED: 'subagent_artifact_cross_source_skipped',
  // phase 337 M5 (review-2026-06-13): done tool 二次调被拒、防 LLM 自相矛盾 result 静默覆盖。
  DONE_TOOL_DUPLICATE_CALL: 'subagent_done_tool_duplicate_call',
  // phase 688: catch 路径 partial assistant content 丢弃决策可观测。
  // args body 已由 stream.jsonl tool_use_input event 落盘、本 audit 仅记决策索引。
  // 不入 tool_use_id 列表（CLI 凭 trace_id + ts 范围 join stream.jsonl）。
  PARTIAL_ASSISTANT_DISCARDED: 'partial_assistant_discarded',
} as const;

export type PartialAssistantDiscardCause = 'all_providers_failed' | 'idle_timeout' | 'unknown';

export interface PartialAssistantDiscardInfo {
  cause: PartialAssistantDiscardCause;
  toolUseCount: number;
  hasText: boolean;
  hasThinking: boolean;
  startTs: number;
  endTs: number;
  errMessage: string;
}

export function emitPartialAssistantDiscarded(audit: AuditLog, opts: PartialAssistantDiscardInfo & { traceId?: string; agentId?: string }): void {
  audit.write(
    SUBAGENT_AUDIT_EVENTS.PARTIAL_ASSISTANT_DISCARDED,
    `cause=${opts.cause}`,
    `tool_use_count=${opts.toolUseCount}`,
    `has_text=${opts.hasText}`,
    `has_thinking=${opts.hasThinking}`,
    `ts_range=${opts.startTs}-${opts.endTs}`,
    `trace_id=${opts.traceId ?? ''}`,
    `agent_id=${opts.agentId ?? ''}`,
    `err=${audit.message(opts.errMessage)}`,
  );
}

export function emitToolCallInput(audit: AuditLog, opts: {
  name: string;
  toolUseId: ToolUseId;
  argsSize: number;
  step?: number;
}): void {
  audit.write(
    SUBAGENT_AUDIT_EVENTS.TOOL_CALL_INPUT,
    opts.name,
    `tool_use_id=${String(opts.toolUseId)}`,
    `step=${opts.step ?? 0}`,
    `contract_id=`,
    `trace_id=`,
    `args_size=${opts.argsSize}`,
  );
}

/**
 * React loop audit events (γ 同源复制 / phase375 裁决 2)
 *
 * 字符串值与 src/core/runtime/runtime-audit-events.ts 的 REACT_LOOP_AUDIT_EVENTS 等价 / 0 漂移。
 * 不抽共享层文件（避免新增模块层级 / M#5 反向）。
 * phase 272 Step E：机械守约 = tests/core/runtime/react-loop-audit-events-equiv.test.ts
 *                NEW const 必同步 / equiv test fail 强制 sync。
 */
export const REACT_LOOP_AUDIT_EVENTS = {
  TURN_START: 'turn_start',
  TURN_END: 'turn_end',
  TURN_INTERRUPTED: 'turn_interrupted',
  TURN_ERROR: 'turn_error',
  LLM_CALL: 'llm_call',
  LLM_ERROR: 'llm_error',
} as const;


/**
 * Phase 163 业主声明 file 归属（phase 122 §5.A + §6.7 + phase 159 模式）.
 *
 * 全 'audit'：业务事件归业务事件主 file（信噪比已通过 cron tick 分流改善）.
 */
export const SUBAGENT_FILE_ROUTING: Readonly<Record<string, 'audit'>> = {
  tool_result: 'audit',
  subagent_step_complete_failed: 'audit',
  subagent_persist_failed: 'audit',
  subagent_log_append_failed: 'audit',
  ghost_callback_after_turn_end: 'audit',
  subagent_timeout_rejection: 'audit',
  tool_call_input: 'audit',
  turn_start: 'audit',
  turn_end: 'audit',
  turn_interrupted: 'audit',
  turn_error: 'audit',
  llm_call: 'audit',
  llm_error: 'audit',
  subagent_steps_invariant_violated: 'audit',
  subagent_artifact_cross_source_mismatch: 'audit',
  subagent_artifact_cross_source_skipped: 'audit',
  mark_crashed_failed: 'audit',  // NEW (synced phase 272 Step E)
  partial_assistant_discarded: 'audit',  // phase 688 NEW
} as const;
