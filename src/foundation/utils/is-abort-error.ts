/**
 * 判 err 是否表示 abort/cancel 语义。
 *
 * 兼容：
 * - Web/Node AbortController → DOMException with name 'AbortError'
 * - 自定义 abort 错误类（继承 Error 且 name='AbortError'，如 makeExternalAbortError 工厂）
 *
 * phase 534 抽：15+ 处手写 `err.name === 'AbortError'` 易漏 instanceof Error 守护、
 * 集中 helper 提供一致语义。
 *
 * 注：与 'cancelled' / 'AbortError' string 命名相关错误可能也需要识别，但当前 chestnut
 * 内部 abort 路径统一用 name='AbortError' 约定（详 step-executor/abort-helpers.ts /
 * subagent/timeout-controller.ts 等）。
 */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}
