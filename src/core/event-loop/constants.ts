/**
 * Delay after interrupt recovery before processing next message (ms).
 * Derivation: 1000ms = 1s 给 interrupt cleanup completion 后 settle 时间 /
 * 配 INTERRUPT_POLL_INTERVAL_MS=200ms 即 ≈ 5 个 poll cycle / 防 cleanup→next msg 紧贴致竞态.
 */
export const INTERRUPT_RECOVERY_DELAY_MS = 1000;

/**
 * Unknown deterministic failures must not make daemon-loop hot-spin. One
 * second matches the interrupt settle budget while keeping recovery prompt;
 * the wait is abortable by EventLoop.abort().
 */
export const UNKNOWN_ERROR_RECOVERY_DELAY_MS = 1000;

/**
 * Default fallback timeout for inbox wait operations (ms).
 * Derivation: 30000ms = 30s 给 inbox 真故障 cooldown 时间 / 与
 * DAEMON_FALLBACK_TIMEOUT_MS (daemon/constants.ts) 同型经验值.
 */
export const INBOX_FALLBACK_TIMEOUT_MS_DEFAULT = 30000;

/**
 * Phase 1826: context trim 后的有界重试（EventLoop 自有的上下文语义；
 * LLM provider 的恢复安排已归 LLMOrchestrator，不再共用预算/曲线）。
 * Derivation: 3 次预算 + 30s 起翻倍 cap 5min —— 沿用 phase 1153/1268 的既有值。
 */
export const CONTEXT_TRIM_RETRY_MAX = 3;
export const CONTEXT_TRIM_RETRY_INITIAL_DELAY_MS = 30_000;
export const CONTEXT_TRIM_RETRY_MAX_DELAY_MS = 300_000;

/**
 * LLM retry state 持久化文件名（phase 1826：仅用于旧 owner 迁移读取，
 * EventLoop 不再写入；迁移后文件原文保留为只读证据）。
 */
export const LLM_RETRY_STATE_FILE = 'llm-retry-state.json' as const;

/** Phase 1154: LLM-request blocked state 持久化文件名 */
export const LLM_REQUEST_BLOCKED_STATE_FILE = 'llm-request-blocked-state.json' as const;

/** Phase 1153 legacy context-blocked state 文件名（仅用于迁移）。 */
export const LEGACY_CONTEXT_BLOCKED_STATE_FILE = 'context-blocked-state.json' as const;

/**
 * ReAct chain 单 tick 内 batch 最大轮数 / 防 runaway 安全闸.
 * 达 cap 时 emit LOOP_ITERATION_TYPES.CHAIN_LIMITED audit / chain 强制结束本 tick.
 */
export const REACT_CHAIN_MAX_ITERATIONS = 100;

/**
 * Phase 1396 Step E: 执行停滞判定超时 (ms)。
 * Derivation: 沿用既有 watchdog claw_inactivity_timeout_ms 默认 (5min) ——
 * 同一「自发停滞」语义从 Watchdog 迁移到 EventLoop，阈值不变避免行为跳变。
 */
export const EXECUTION_INACTIVITY_TIMEOUT_MS = 300_000;

/**
 * Phase 1396 Step E: recovery record 目录（相对路径，值不变）。
 * Phase 1841: 实例相对路径——记录写到 <agentDir>/event-loop/execution-recovery/
 * （motion 为 <root>/motion/...，claw 为 <root>/claws/<id>/...）；旧
 * <root>/event-loop/execution-recovery/ 相同相对路径仅作为只读共享基线兼容读。
 */
export const EXECUTION_RECOVERY_DIR = 'event-loop/execution-recovery';

/** Phase 1396 Step E: 自愈 resume 的自身 inbox 消息类型（EventLoop 正常消费，不走 Runtime reentrant API）。 */
export const EXECUTION_RECOVERY_MESSAGE_TYPE = 'execution_recovery';

/**
 * Phase 1842: 执行恢复交付义务的 inbox metadata 关联键——owner 查询
 * （findByExtraMeta）以冻结的稳定 delivery id 证实消息存在；不依赖文件名推身份。
 */
export const EXECUTION_RECOVERY_DELIVERY_META_KEY = 'execution_recovery_delivery_id';
