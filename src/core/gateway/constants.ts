/**
 * Debounce window for interrupt messages from clients (ms).
 * Derivation: 500ms 给 client 短期重复 interrupt（如手抖双击）合并空间 / < user-perceptible
 * delay (1s) / 配合 LOCK_RETRY_DELAY_MS=500 同型 short-budget 间隔.
 */
export const GATEWAY_INTERRUPT_DEBOUNCE_MS = 500;
