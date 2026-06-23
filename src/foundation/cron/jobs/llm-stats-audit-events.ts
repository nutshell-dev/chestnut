/**
 * llm-stats cron job audit events（业主自治、归 helper）。
 * phase 180 拆 sub-event const、删 stem LLM_STATS（避 `step=enum` 跨业主漂、phase 706 §6.2 + §6.7 + phase 136 §5.B）。
 */
export const LLM_STATS_AUDIT_EVENTS = {
  LLM_STATS_EMPTY: 'cron_llm_stats_empty',
  LLM_STATS_REPORTED: 'cron_llm_stats_reported',
} as const;

// 业主声明 per-event col schema (mirror phase 140 IdNamingEntry 模式)
export const LLM_STATS_COLS = {
  [LLM_STATS_AUDIT_EVENTS.LLM_STATS_EMPTY]: [
    { name: 'date', required: true },  // ISO YYYY-MM-DD
  ],
  [LLM_STATS_AUDIT_EVENTS.LLM_STATS_REPORTED]: [
    { name: 'date', required: true },
    { name: 'totalCalls', required: true },
    { name: 'successCalls', required: true },
    { name: 'failedCalls', required: true },
    { name: 'totalInputTokens', required: true },
    { name: 'totalOutputTokens', required: true },
    { name: 'avgLatencyMs', required: true },  // camelCase 一致、纠 snake_case 漂
  ],
} as const;
