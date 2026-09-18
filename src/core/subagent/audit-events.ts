/**
 * SubAgent audit event names.
 *
 * Module-owned event namespace per H1 design (phase338 / r36 α 决策).
 * 字符串值与起步态 events.ts SUBAGENT_ 系列等价 / 0 漂移。
 */

// phase 1858 Step K (SA-D10): 本文件不再直接写 audit——事件写点经 lifecycle-sink adapter；
// emitPartialAssistantDiscarded / emitToolCallInput 两个 AuditLog 直写 helper 随之删除。

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
  // phase 1858 Step E (SA-D4): race 失败后 settle 超窗、runReact 仍未收敛的显式留证
  RUNREACT_ABORT_STILL_RUNNING: 'subagent_runreact_abort_still_running',
  // phase 1858 Step H (SA-D7): capture 原始值不合 result-tool 协议形状的边界登记
  CAPTURE_PROTOCOL_MALFORMED: 'subagent_capture_protocol_malformed',
  // phase 1858 Step L (SA-D11): onIdleTimeout callback 故障留证（原静默吞）
  IDLE_TIMEOUT_CALLBACK_FAILED: 'subagent_idle_timeout_callback_failed',
  // phase 1411 (reframe of phase 1409): generic tool_call index row.
  // name + tool_use_id + step + contract_id + trace_id + args_size；args body 0 入 audit.
  // dialog/current.json 是 tool_use args 全文权威源、CLI 凭 tool_use_id 跨源 join。
  // 详 design/modules/l3_subagent.md §A.phase1409-on-tool-call-args-emit
  // (amended-by phase 1411)。
  TOOL_CALL_INPUT: 'tool_call_input',
  SUBAGENT_STEPS_INVARIANT_VIOLATED: 'subagent_steps_invariant_violated',
  SUBAGENT_ARTIFACT_CROSS_SOURCE_MISMATCH: 'subagent_artifact_cross_source_mismatch',
  // phase 1858 Step D (SA-D3): 检查执行即持久化结论（ok 分支）——不再只有异常时可见
  SUBAGENT_ARTIFACT_CROSS_SOURCE_OK: 'subagent_artifact_cross_source_ok',
  SUBAGENT_ARTIFACT_CROSS_SOURCE_SKIPPED: 'subagent_artifact_cross_source_skipped',
  // phase 337 M5 (review-2026-06-13): done tool 二次调被拒、防 LLM 自相矛盾 result 静默覆盖。
  DONE_TOOL_DUPLICATE_CALL: 'subagent_done_tool_duplicate_call',
  // phase 688: catch 路径 partial assistant content 丢弃决策可观测。
  // args body 已由 stream.jsonl tool_use_input event 落盘、本 audit 仅记决策索引。
  // 不入 tool_use_id 列表（CLI 凭 trace_id + ts 范围 join stream.jsonl）。
  PARTIAL_ASSISTANT_DISCARDED: 'partial_assistant_discarded',
} as const;

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
  subagent_runreact_abort_still_running: 'audit',
  subagent_capture_protocol_malformed: 'audit',
  subagent_idle_timeout_callback_failed: 'audit',
  tool_call_input: 'audit',
  turn_start: 'audit',
  turn_end: 'audit',
  turn_interrupted: 'audit',
  turn_error: 'audit',
  llm_call: 'audit',
  llm_error: 'audit',
  subagent_steps_invariant_violated: 'audit',
  subagent_artifact_cross_source_mismatch: 'audit',
  subagent_artifact_cross_source_ok: 'audit',
  subagent_artifact_cross_source_skipped: 'audit',
  partial_assistant_discarded: 'audit',  // phase 688 NEW
} as const;
