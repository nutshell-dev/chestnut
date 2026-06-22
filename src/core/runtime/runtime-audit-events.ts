// src/core/runtime/runtime-audit-events.ts
/**
 * Runtime audit event names (含 LLM Response anomalies + Session + AsyncTaskSystem + Snapshot + Inbox + Tool + Outbox).
 *
 * Module-owned event namespace per H1 design (phase336 / r36 α 决策 / H1 收官).
 * 字符串值与起步态 events.ts RUNTIME_* + LLM_* 系列等价 / 0 漂移。
 *
 * 合并理由：events.ts 中 Runtime + LLM Response 是 2 分组 / 但 caller 同为 runtime.ts /
 * 1 文件聚合更简洁（M#3 资源唯一归属：runtime caller 模块 own）。
 */

import type { IdNamingEntry, ColSchemaEntry } from '../../foundation/audit/index.js';

export const RUNTIME_AUDIT_EVENTS = {
  // 原有
  PROCESS_BATCH_FAILED: 'runtime_process_batch_failed',
  LLM_EMPTY_RESPONSE: 'llm_empty_response',
  LLM_UNKNOWN_STOP_REASON: 'llm_unknown_stop_reason',
  LLM_UNPARSEABLE_TOOL_USE: 'llm_unparseable_tool_use',
  TOOL_INPUT_PARSE_FAILED: 'tool_input_parse_failed',   // ← NEW (phase 850 β refactor / r108 F fork F2.2)
  TOOL_EXECUTION_FAILED: 'tool_execution_failed',       // ← NEW (phase 850 β refactor / r108 F fork F2.4)
  // SESSION_*
  SESSION_LOADED: 'session_loaded',
  SESSION_REPAIRED: 'session_repaired',
  // TASK_SYSTEM_*
  TASK_SYSTEM_INIT_FAILED: 'task_system_init_failed',
  TASK_SYSTEM_START_DISPATCH_FAILED: 'task_system_start_dispatch_failed',
  // SNAPSHOT_*
  SNAPSHOT_COMMIT_FAILED: 'snapshot_commit_failed',
  SNAPSHOT_COMMIT_UNCATEGORIZED: 'snapshot_commit_uncategorized',
  // INBOX_*
  INBOX_HANDLER_FAILED: 'inbox_handler_failed',
  INBOX_INJECT: 'inbox_inject',
  INBOX_UNADDRESSED: 'inbox_unaddressed',
  INBOX_UNKNOWN_TYPE: 'runtime_inbox_unknown_type',
  INBOX_DRAIN_FAILED: 'runtime_inbox_drain_failed',
  // TOOL / OUTBOX
  TOOL_RESULT: 'tool_result',
  // phase 1411 (reframe of phase 1409): generic tool_call index row.
  // γ 同源复制 with src/core/subagent/audit-events.ts TOOL_CALL_INPUT / 0 漂移.
  // 仅 name + tool_use_id + args_size — args body 0 入 audit (dialog 是权威源).
  // 详 design/modules/l3_subagent.md §A.phase1409-on-tool-call-args-emit.
  TOOL_CALL_INPUT: 'tool_call_input',
  CATCH_UNHANDLED: 'runtime_catch_unhandled',
  // INITIALIZE phase failures (phase 454: 替代 Runtime 借 ASSEMBLE_FAILED)
  INBOX_INIT_FAILED: 'runtime_inbox_init_failed',
  SESSION_REPAIR_FAILED: 'runtime_session_repair_failed',
  // phase 521: regime switch audit event
  REGIME_SWITCH: 'regime_switch',
  REGIME_SWITCH_COMMITTED: 'regime_switch_committed', // NEW phase1108
  // phase 539: regime switch failed audit event
  REGIME_SWITCH_FAILED: 'regime_switch_failed',
  REGIME_SWITCH_HARD_FAIL: 'regime_switch_hard_fail',
  // phase 598: optional section read failed audit event
  OPTIONAL_SECTION_READ_FAILED: 'runtime_optional_section_read_failed',
  // phase 845: step executor callback failed audit event
  STEP_EXECUTOR_CALLBACK_FAILED: 'step_executor_callback_failed',
  // phase 446 (review): onStepComplete 内 fire-and-forget maybeAuditStep 防御 catch
  MAYBE_AUDIT_STEP_FAILED: 'runtime_maybe_audit_step_failed',
  // phase 521 (review-round4 N4-Core-H2): processBatch ack/nack per-handle atomicity
  // 防 ack/nack 抛错 cascade 到 turn-level catch 触发 rollback + duplicate delivery
  INBOX_ACK_FAILED: 'runtime_inbox_ack_failed',
  INBOX_NACK_FAILED: 'runtime_inbox_nack_failed',
  // phase 555: _runReact 入口 contractManager.loadActive() 失败 fallback emit；
  // 拆 phase 544 misuse 的 MAYBE_AUDIT_STEP_FAILED（语义专属 onStepComplete maybeAuditStep）
  TURN_CONTRACT_ID_CACHE_FAILED: 'runtime_turn_contract_id_cache_failed',
  // phase 1274: max_tokens stop handler prebuilt-only final path
  MAX_TOKENS_PREBUILT_ONLY_FINAL: 'max_tokens_prebuilt_only_final',
  // phase 1274: max_tokens stop handler empty assistant skipped
  MAX_TOKENS_ASSISTANT_EMPTY_SKIPPED: 'max_tokens_assistant_empty_skipped',
  // phase 1383: max_tokens stop handler State A orphan prebuilt drop observability
  MAX_TOKENS_STATE_A_ORPHAN_DROP: 'max_tokens_state_a_orphan_drop',
  // phase 227: turn_end cross-source completeness audit
  TURN_COMPLETENESS_MISMATCH: 'turn_completeness_mismatch',
  // NEW (raw migration phase 272 Step C)
  GUIDANCE_COMPOSER_FAILED: 'guidance_composer_failed',
  // phase 320: LLM config hot-reload via inbox `reload_llm_config` message
  LLM_RELOADED: 'runtime_llm_reloaded',
  LLM_RELOAD_FAILED: 'runtime_llm_reload_failed',
  LLM_RELOAD_SKIPPED: 'runtime_llm_reload_skipped',
  // phase 688: catch 路径 partial assistant content 丢弃决策。
  // γ 同源复制 with src/core/subagent/audit-events.ts PARTIAL_ASSISTANT_DISCARDED / 0 漂移。
  // args body 已由 stream.jsonl tool_use_input event 落盘、本 audit 仅记决策索引。
  PARTIAL_ASSISTANT_DISCARDED: 'partial_assistant_discarded',
} as const;

// phase 320: re-export reload message type const for callers that already import from this file
export { RELOAD_LLM_CONFIG_MESSAGE_TYPE } from './inbox-message-types.js';

/**
 * React loop audit events (γ 同源复制 / phase375 裁决 2)
 *
 * 字符串值与 src/core/subagent/audit-events.ts 的 REACT_LOOP_AUDIT_EVENTS 等价 / 0 漂移。
 * 不抽共享层文件（避免新增模块层级 / M#5 反向）。
 */
export const REACT_LOOP_AUDIT_EVENTS = {
  TURN_START: 'turn_start',
  TURN_END: 'turn_end',
  TURN_INTERRUPTED: 'turn_interrupted',
  TURN_ERROR: 'turn_error',
  LLM_CALL: 'llm_call',
  LLM_ERROR: 'llm_error',
  MARK_CRASHED_FAILED: 'mark_crashed_failed',  // phase 63 NEW
} as const;

/**
 * Phase 140 + phase 216: runtime 业主声明 ID-naming map.
 *
 * SoT 区分:
 * - trace_id：runtime 是产生方（startTrace 时新生成 traceId）
 * - stepNumber：runtime 是 **emit 方**（audit emit `step=` col on tool_call_input）；
 *               产生方 = agent-executor（agent-executor.ts:75 `ctx.stepNumber = makeStepNumber(stepCount)`、ReAct loop counter）；
 *               ctx 跨业主边界传递、phase 216 立 StepNumber brand 编译期守语义。
 */
export const RUNTIME_ID_NAMING: Readonly<Record<string, IdNamingEntry>> = {
  trace: {
    auditCol: 'trace_id',
    dialogMeta: 'trace_id',
    tsField: 'traceId',
    cliFlag: '--trace',
  },
  step: {
    auditCol: 'step',
    dialogMeta: null,  // dialog session 不存 step
    tsField: 'stepNumber',
    cliFlag: '--col step',
  },
} as const;

/**
 * Phase 140: runtime tool 类 event col schema (β 兼容期，required: false).
 * 用于 snapshot.json schema 同步（Step E）+ lock test 守 emit cols.
 */
/**
 * Phase 163 业主声明 file 归属（phase 122 §5.A + §6.7 + phase 159 模式）.
 */
export const RUNTIME_FILE_ROUTING: Readonly<Record<string, 'audit'>> = {
  guidance_composer_failed: 'audit',
  // phase 553 (back-fill phase 521 / 446): 业主声明 file 归属
  runtime_inbox_ack_failed: 'audit',
  runtime_inbox_nack_failed: 'audit',
  runtime_maybe_audit_step_failed: 'audit',
  runtime_turn_contract_id_cache_failed: 'audit',
  partial_assistant_discarded: 'audit',  // phase 688
} as const;

export const RUNTIME_TOOL_EVENT_COLS: Readonly<Record<string, readonly ColSchemaEntry[]>> = {
  tool_result: [
    { name: 'tool_name', type: 'string', required: true },
    { name: 'tool_use_id', type: 'string', required: false },
    { name: 'step', type: 'number', required: false },
    { name: 'contract_id', type: 'string', required: false },
    { name: 'trace_id', type: 'string', required: false },
    { name: 'status', type: 'string', required: false },
    { name: 'summary', type: 'string', required: false, max_chars: 200 },
    { name: 'content_size', type: 'number', required: false },
  ],
  tool_call_input: [
    { name: 'tool_name', type: 'string', required: true },
    { name: 'tool_use_id', type: 'string', required: false },
    { name: 'step', type: 'number', required: false },
    { name: 'contract_id', type: 'string', required: false },
    { name: 'args_size', type: 'number', required: true },
    { name: 'trace_id', type: 'string', required: false },
  ],
} as const;
