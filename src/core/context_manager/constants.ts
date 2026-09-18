/**
 * @module L4.ContextManager.Constants
 * phase 440 立（phase 421 ratify）：上下文裁剪 3 业务常量。
 * `CACHE_TTL_MS` 顺手裁专用、留 phase D 立。
 * phase 1861 (CM-D2)：TTL 判据归 caller（Runtime）——本常量降级为 caller 侧默认值来源。
 */

/** 24h（86_400_000ms）—— 用户无感边界、24h 内消息全保 */
export const CONTEXT_TRIM_RECENT_WINDOW_MS = 86_400_000;

/** proactive 裁剪目标占用率（整 prompt 上限 = 上下文窗口 × 此值）*/
export const CONTEXT_TRIM_TARGET_RATIO = 0.75;

/** reactive 上下文保留下限比率（整 prompt 不得低于窗口 × 此值）*/
export const REACTIVE_CONTEXT_RETENTION_FLOOR_RATIO = 0.75;

/** 头部预览字节数（P1a / P1b / P3 折叠时保头多少字节） */
export const CONTEXT_TRIM_PREVIEW_BYTES = 100;

/**
 * 提示词缓存 TTL（Anthropic ephemeral 5 分钟）。
 * caller（Runtime）默认值：cacheExpired = lastLLMCallAt !== 0 && now - lastLLMCallAt > CACHE_TTL_MS。
 * 不预判（在「即将失效」时裁等于主动放弃 cache）、不延后（cache TTL 是 hard limit）。
 */
export const CACHE_TTL_MS = 300_000;
