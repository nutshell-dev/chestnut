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
