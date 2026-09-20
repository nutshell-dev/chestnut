/** Watchdog liveness check interval (ms) */
export const WATCHDOG_INTERVAL_MS = 30_000;

/**
 * alive-but-loop-stale 判定阈值（ms）：daemon 进程 alive 但心跳事实超过本阈值未更新
 * → 判事件循环停滞，走既有重启 machinery。
 * Derivation: daemon liveness tick = 60s（daemon-loop LIVENESS_HEARTBEAT_MS）；
 * 3 × tick = 180s —— 容忍单次 tick 延迟/进程重载抖动（防误杀），同时保证
 * ≤3 拍内发现完全阻塞。Phase 1878 Step C 起由 config `heartbeat_stale_timeout_ms`
 * 承载（默认即本常量）；本常量为 schema 默认源。
 */
export const HEARTBEAT_STALE_TIMEOUT_MS = 180_000;

