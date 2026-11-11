/**
 * @module L4.ContextManager.Constants
 * phase 440 立（phase 421 ratify）：上下文裁剪 3 业务常量。
 * `CACHE_TTL_MS` 顺手裁专用、留 phase D 立。
 * phase 1861 (CM-D2)：TTL 判据归 caller（Runtime）——本常量降级为 caller 侧默认值来源。
 */

/** 24h（86_400_000ms）—— 用户无感边界、24h 内消息全保 */
export const CONTEXT_TRIM_RECENT_WINDOW_MS = 86_400_000;

/** proactive 裁剪触发占用率（整 prompt 达到此值才检查缓存并触发） */
export const CONTEXT_TRIM_PROACTIVE_TRIGGER_RATIO = 0.75;

/** proactive 裁剪目标占用率（整 prompt 上限 = 上下文窗口 × 此值） */
export const CONTEXT_TRIM_PROACTIVE_TARGET_RATIO = 0.37;

/** reactive 裁剪目标占用率（整 prompt 上限 = 上下文窗口 × 此值） */
export const CONTEXT_TRIM_REACTIVE_TARGET_RATIO = 0.75;

/** @deprecated use CONTEXT_TRIM_PROACTIVE_TARGET_RATIO. */
export const CONTEXT_TRIM_TARGET_RATIO = CONTEXT_TRIM_PROACTIVE_TARGET_RATIO;
/** @deprecated use CONTEXT_TRIM_REACTIVE_TARGET_RATIO. */
export const REACTIVE_CONTEXT_RETENTION_FLOOR_RATIO = CONTEXT_TRIM_REACTIVE_TARGET_RATIO;

/** 头部预览字节数（P1a / P1b / P3 折叠时保头多少字节） */
export const CONTEXT_TRIM_PREVIEW_BYTES = 100;

/**
 * 提示词缓存 TTL（Anthropic ephemeral 5 分钟）。
 * caller（Runtime）默认值：cacheExpired = lastLLMCallAt !== 0 && now - lastLLMCallAt > CACHE_TTL_MS。
 * 不预判（在「即将失效」时裁等于主动放弃 cache）、不延后（cache TTL 是 hard limit）。
 */
export const CACHE_TTL_MS = 300_000;

/**
 * phase 1861 (CM-D1)：裁剪规则运行时 policy——规则值经注入链（Assembly/Runtime → CM 入口）传入，
 * 算法只消费边界值；上方常量降级为默认值来源。
 */
export interface TrimRuntimePolicy {
  /** 24h 保护窗口（用户无感边界）。 */
  recentWindowMs: number;
  /** 头部预览字节数（折叠时保头）。 */
  previewBytes: number;
  /** proactive 触发占用率。 */
  proactiveTriggerRatio: number;
  /** proactive 目标占用率。 */
  proactiveTargetRatio: number;
  /** reactive 目标占用率。 */
  reactiveTargetRatio: number;
  /** @deprecated compatibility aliases; callers should use the explicit fields above. */
  targetRatio?: number;
  floorRatio?: number;
}
