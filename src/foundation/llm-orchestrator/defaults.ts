// src/foundation/llm-orchestrator/defaults.ts
/**
 * LLMOrchestrator 模块行为默认值 const
 * phase 748 物理迁自 src/constants.ts、M#3 资源唯一归属合规
 * mirror phase 745+746+747 owner module barrel 模板 N=4
 *
 * DEFAULT_LLM_IDLE_TIMEOUT_MS = LLM stream idle timeout 默认值
 * 由 config boundary（zod schema + cli/init）resolve、其他 caller ctor required
 */
export const DEFAULT_LLM_IDLE_TIMEOUT_MS = 60000;

/**
 * Initial idle timeout written to user config by `init` command (ms)
 * - More lenient default for new users (vs schema 60s fallback)
 * - User can edit later to tighter value
 */
export const INIT_LLM_IDLE_TIMEOUT_MS = 120000;

/** Default LLM API call timeout (ms) */
export const DEFAULT_LLM_TIMEOUT_MS = 60_000;

/** Default circuit breaker reset timeout (ms) */
export const DEFAULT_RESET_TIMEOUT_MS = 60_000;

/** Default LLM retry delay between attempts (ms) */
export const DEFAULT_RETRY_DELAY_MS = 1_000;

/** Default LLM retry attempts before failing */
export const DEFAULT_LLM_RETRY_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Phase 1826: 恢复安排的策略参数（由 EventLoop 迁入本模块，数值不变）
// ---------------------------------------------------------------------------

/** 单轮 provider 重试预算上限（原 event-loop LLM_MAX_RETRIES）。 */
export const LLM_RECOVERY_MAX_RETRIES = 3;

/** 恢复安排的初始退避（原 event-loop LLM_RETRY_INITIAL_DELAY_MS）。 */
export const LLM_RECOVERY_RETRY_INITIAL_DELAY_MS = 30_000;

/** 退避延迟上限（原 event-loop LLM_RETRY_MAX_DELAY_MS）。 */
export const LLM_RECOVERY_RETRY_MAX_DELAY_MS = 300_000;

/** 预算耗尽后的完整冷却等待（原 event-loop LLM_COOLDOWN_MS）。 */
export const LLM_RECOVERY_COOLDOWN_MS = 300_000;

/** quota（配额时间窗）退避曲线初值（原 event-loop LLM_QUOTA_INITIAL_DELAY_MS）。 */
export const LLM_RECOVERY_QUOTA_INITIAL_DELAY_MS = 120_000;

/** quota 退避曲线封顶（原 event-loop LLM_QUOTA_MAX_DELAY_MS）。 */
export const LLM_RECOVERY_QUOTA_MAX_DELAY_MS = 480_000;
