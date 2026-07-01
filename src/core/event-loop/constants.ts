/**
 * Delay after interrupt recovery before processing next message (ms).
 * Derivation: 1000ms = 1s 给 interrupt cleanup completion 后 settle 时间 /
 * 配 INTERRUPT_POLL_INTERVAL_MS=200ms 即 ≈ 5 个 poll cycle / 防 cleanup→next msg 紧贴致竞态.
 */
export const INTERRUPT_RECOVERY_DELAY_MS = 1000;

/** LLM 重试最大次数 */
export const LLM_MAX_RETRIES = 3;

/** LLM 重试初始退避延迟 (ms) */
export const LLM_RETRY_INITIAL_DELAY_MS = 30_000;

/** LLM 重试退避延迟上限 (ms) */
export const LLM_RETRY_MAX_DELAY_MS = 300_000;

/** LLM retry state 持久化文件名 */
export const LLM_RETRY_STATE_FILE = 'llm-retry-state.json' as const;
