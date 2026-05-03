/**
 * Abort signal helper: combines external signal with internal timeout
 */

import { LLMTimeoutError } from '../../types/errors.js';

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

  let activeTimeoutId: ReturnType<typeof setTimeout> | undefined =
    setTimeout(() => controller.abort(), timeoutMs);

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
    return makeExternalAbortError(externalSignal.reason as AbortReason | undefined);
  }
  return new LLMTimeoutError(providerName, timeoutMs);
}

/**
 * Abort reason carried through external signal.
 * Distinguishes user_abort / idle_timeout / priority_inbox / turn_timeout / external (plain).
 */
export type AbortReason =
  | { type: 'user' }
  | { type: 'idle_timeout'; ms: number }
  | { type: 'step_yield' }
  | { type: 'turn_timeout'; ms: number }
  | { type: 'external'; original?: unknown };

/**
 * Construct the standard "Execution aborted" error used for both
 * fetch-based external signal aborts and SDK-based APIUserAbortError.
 *
 * Optional `reason` propagates abort context to consumers (e.g. SubAgent
 * catch block can classify turn_interrupted cause).
 */
export function makeExternalAbortError(reason?: AbortReason): Error {
  const validReason = reason && typeof (reason as any).type === 'string' ? reason : undefined;
  const tail = validReason
    ? (validReason.type === 'idle_timeout' || validReason.type === 'turn_timeout'
        ? ` (cause=${validReason.type}, ms=${validReason.ms})`
        : ` (cause=${validReason.type})`)
    : '';
  const err = new Error(`Execution aborted${tail}`);
  err.name = 'AbortError';
  if (validReason !== undefined) {
    (err as Error & { cause: AbortReason }).cause = validReason;
  }
  return err;
}
