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

/** LLM 重试最大次数 */
export const LLM_MAX_RETRIES = 3;

/** LLM 重试初始退避延迟 (ms) */
export const LLM_RETRY_INITIAL_DELAY_MS = 30_000;

/** LLM 重试退避延迟上限 (ms) */
export const LLM_RETRY_MAX_DELAY_MS = 300_000;

/**
 * Phase 1268 Step B: LLM 重试预算耗尽后的 cooldown 等待时长 (ms)。
 * Derivation: 300000ms = 5min 持续限流的保守恢复间隔 / 到期仅一次 probe，
 * 避免“每 cooldown 刷一批”重建刷屏周期 / 不复用 LLM_RETRY_MAX_DELAY_MS
 * （语义不同：backoff cap 截断单次退避，cooldown 是耗尽后的完整等待，
 * 服务端更长 Retry-After 时不得被 cap 截短）。
 */
export const LLM_COOLDOWN_MS = 300_000;

/**
 * phase 1776 Step C + phase 1777 Step B: quota（配额时间窗）独立退避曲线（ms）。
 * Derivation: 2min 起、每次 probe 失败翻倍（4/8）、cap 8min——恢复检测最坏 8min
 * （原 10min 起 cap 60min，1777 用户拍板缩短：配额恢复后应尽快继续）；quota
 * 拒绝不耗配额 token、快速失败，分钟级探测成本可接受（每小时 ≤15 次失败请求；
 * 若仍嫌频繁可放宽备选 300s/900s）；quota 不进 retry 预算（llmRetryCount 不消耗）、
 * 指纹变化不释放（内容与时间窗无关，1777 Step C 例外：waiting 期间新 user 消息放行一次探测）。
 */
export const LLM_QUOTA_INITIAL_DELAY_MS = 120_000;
export const LLM_QUOTA_MAX_DELAY_MS = 480_000;

/** LLM retry state 持久化文件名 */
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

/** Phase 1396 Step E: recovery record 目录（chestnut root 相对路径）。 */
export const EXECUTION_RECOVERY_DIR = 'event-loop/execution-recovery';

/** Phase 1396 Step E: 自愈 resume 的自身 inbox 消息类型（EventLoop 正常消费，不走 Runtime reentrant API）。 */
export const EXECUTION_RECOVERY_MESSAGE_TYPE = 'execution_recovery';
