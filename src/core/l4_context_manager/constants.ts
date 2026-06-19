/**
 * @module L4.ContextManager.Constants
 * phase 440 立（phase 421 ratify）：上下文裁剪 3 业务常量。
 * `CACHE_TTL_MS` 顺手裁专用、留 phase D 立。
 */

/** 24h（86_400_000ms）—— 用户无感边界、24h 内消息全保 */
export const CONTEXT_TRIM_RECENT_WINDOW_MS = 86_400_000;

/** 裁剪目标占用率（整 prompt 上限 = 上下文窗口 × 此值）*/
export const CONTEXT_TRIM_TARGET_RATIO = 0.75;

/** 头部预览字节数（P1a / P1b / P3 折叠时保头多少字节） */
export const CONTEXT_TRIM_PREVIEW_BYTES = 100;
