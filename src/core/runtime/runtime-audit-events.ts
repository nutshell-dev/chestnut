// src/core/runtime/runtime-audit-events.ts
/**
 * Runtime audit event names (含 LLM Response anomalies).
 *
 * Module-owned event namespace per H1 design (phase336 / r36 α 决策 / H1 收官).
 * 字符串值与起步态 events.ts RUNTIME_* + LLM_* 系列等价 / 0 漂移。
 *
 * 合并理由：events.ts 中 Runtime + LLM Response 是 2 分组 / 但 caller 同为 runtime.ts /
 * 1 文件聚合更简洁（M#3 资源唯一归属：runtime caller 模块 own）。
 */
export const RUNTIME_AUDIT_EVENTS = {
  PROCESS_BATCH_FAILED: 'runtime_process_batch_failed',
  LLM_EMPTY_RESPONSE: 'llm_empty_response',
  LLM_UNKNOWN_STOP_REASON: 'llm_unknown_stop_reason',
} as const;
