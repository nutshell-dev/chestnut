/**
 * Abort signal helper: combines external signal with internal timeout
 */

import { LLMTimeoutError } from './errors.js';

export interface CombinedAbortHandle {
  /** Combined signal to pass to fetch / SDK */
  signal: AbortSignal;
  /** Explicit abort (used by stream maxTimer, etc.) */
  abort(): void;
  /**
   * Switch from "initial timeout" phase to "streaming maxDuration" phase.
   * Clears the old internal timer and starts a new one for maxDurationMs.
   * External signal listener is unaffected. May be called multiple times;
   * each call replaces the active timer (idempotent swap).
   */
  enterStreamPhase(maxDurationMs: number): void;
}

/**
 * Merge an external AbortSignal with an internal timeout into a single
 * AbortController.  Caller receives a handle plus a cleanup function that
 * **must** be called in a `finally` block.
 *
 * @param externalSignal  Optional signal provided by the caller
 * @param timeoutMs       Internal timeout in milliseconds
 * @returns [handle, cleanup]
 */
export function withCombinedAbortSignal(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): [CombinedAbortHandle, () => void] {
  const controller = new AbortController();

  // 防御：外部 signal 若已处于 aborted 状态，立即同步 abort 内部 controller
  // （addEventListener 只监听未来事件，否则本 handle 会错过已发生的 abort）
  if (externalSignal?.aborted) {
    controller.abort();
  }

  // phase 528 (review-round4 Foundation L): externalSignal 已 aborted 时短路 timer
  // 防 entry 就 abort 仍 schedule 一个无用 timer（unref 不能阻止 Node 计数）
  let activeTimeoutId: ReturnType<typeof setTimeout> | undefined =
    externalSignal?.aborted ? undefined : setTimeout(() => controller.abort(), timeoutMs);

  let onAbort: (() => void) | undefined;
  if (externalSignal && !externalSignal.aborted) {
    onAbort = () => controller.abort();
    externalSignal.addEventListener('abort', onAbort);
  }

  const handle: CombinedAbortHandle = {
    signal: controller.signal,
    abort: () => controller.abort(),
    enterStreamPhase: (maxDurationMs: number) => {
      if (activeTimeoutId !== undefined) clearTimeout(activeTimeoutId);
      activeTimeoutId = setTimeout(() => controller.abort(), maxDurationMs);
    },
  };

  const cleanup = () => {
    if (activeTimeoutId !== undefined) {
      clearTimeout(activeTimeoutId);
      activeTimeoutId = undefined;
    }
    if (externalSignal && onAbort) {
      externalSignal.removeEventListener('abort', onAbort);
    }
  };

  return [handle, cleanup];
}

/**
 * For fetch-based providers: classify a fetch-thrown DOMException AbortError
 * into "external abort" or "internal timeout", returning the domain error.
 *
 * Returns null for non-AbortError — caller should fall through to other handling.
 */
export function classifyFetchAbortError(
  error: unknown,
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
  providerName: string,
): Error | null {
  if (!(error instanceof DOMException) || error.name !== 'AbortError') {
    return null;
  }
  if (externalSignal?.aborted) {
    return makeExternalAbortError(externalSignal.reason);
  }
  return new LLMTimeoutError(providerName, timeoutMs);
}

/**
 * phase 1802: Abort reason 是上层业务的 opaque evidence —— L1 只承载、不枚举。
 *
 * reason 词汇（user/step_yield/turn_timeout/tool_timeout/…）由发起业务 owner 各自定义
 * 并在边界映射（如 SubAgent timeout-controller → ToolTimeoutError/UserInterrupt）；
 * provider 仅检查 signal.aborted 与原样透传 signal.reason，不对 reason 做业务裁决。
 */
export class ExternalAbortError extends Error {
  constructor(readonly abortReason?: unknown) {
    // 结构化格式化（duck-typing，零上层词汇枚举）：{type: string, ms?: number}
    // 形状的 reason 产出与旧枚举实现字节兼容的 message。
    const r = abortReason;
    const type = r && typeof r === 'object' && 'type' in r && typeof (r as { type: unknown }).type === 'string'
      ? (r as { type: string }).type : undefined;
    const ms = r && typeof r === 'object' && 'ms' in r && typeof (r as { ms: unknown }).ms === 'number'
      ? (r as { ms: number }).ms : undefined;
    const tail = type !== undefined
      ? (ms !== undefined ? ` (cause=${type}, ms=${ms})` : ` (cause=${type})`)
      : '';
    super(`Execution aborted${tail}`);
    this.name = 'AbortError';
    if (abortReason !== undefined) this.cause = abortReason;
  }
}

export function makeExternalAbortError(reason?: unknown): ExternalAbortError {
  const validReason = reason && typeof reason === 'object' && 'type' in reason && typeof (reason as { type: unknown }).type === 'string' ? reason : undefined;
  return new ExternalAbortError(validReason);
}
