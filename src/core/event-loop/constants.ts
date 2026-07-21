/**
 * Delay after interrupt recovery before processing next message (ms).
 * Derivation: 1000ms = 1s 给 interrupt cleanup completion 后 settle 时间 /
 * 配 INTERRUPT_POLL_INTERVAL_MS=200ms 即 ≈ 5 个 poll cycle / 防 cleanup→next msg 紧贴致竞态.
 */
export const INTERRUPT_RECOVERY_DELAY_MS = 1000;

/**
 * Default fallback timeout for inbox wait operations (ms).
 * Derivation: 30000ms = 30s 给 inbox 真故障 cooldown 时间 / 与
 * DAEMON_FALLBACK_TIMEOUT_MS (daemon/constants.ts) 同型经验值.
 */
export const INBOX_FALLBACK_TIMEOUT_MS_DEFAULT = 30000;

/** LLM 重试最大次数 */
export const LLM_MAX_RETRIES = 3;

/** LLM 重试初始退避延迟 (ms) */
export const LLM_RETRY_INITIAL_DELAY_MS = 30_000;

/** LLM 重试退避延迟上限 (ms) */
export const LLM_RETRY_MAX_DELAY_MS = 300_000;

/** LLM retry state 持久化文件名 */
export const LLM_RETRY_STATE_FILE = 'llm-retry-state.json' as const;

/** Phase 1153: context-blocked state 持久化文件名 */
export const CONTEXT_BLOCKED_STATE_FILE = 'context-blocked-state.json' as const;

/**
 * ReAct chain 单 tick 内 batch 最大轮数 / 防 runaway 安全闸.
 * 达 cap 时 emit LOOP_ITERATION_TYPES.CHAIN_LIMITED audit / chain 强制结束本 tick.
 */
export const REACT_CHAIN_MAX_ITERATIONS = 100;
