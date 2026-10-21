// src/foundation/llm-provider/audit-events.ts
/**
 * LLMProvider audit event names（Phase 1960 Step C）。
 *
 * context 观测面：成功响应 silent overflow 只写 audit observation，不扩 stream
 * 协议、不触发 trim（用户 2026-10-21 拍板）。事件默认进 audit.tsv，无 fileRouting。
 */
export const LLM_PROVIDER_AUDIT_EVENTS = {
  CONTEXT_OVERFLOW_OBSERVED: 'llm_context_overflow_observed',
} as const;
