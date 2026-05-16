/**
 * LLM Service - Main implementation with failover and retry
 * 
 * Implements LLMOrchestrator interface
 * - Retry with exponential backoff
 * - Failover to fallback provider
 */


import type { LLMResponse, TextBlock, ThinkingBlock, ToolUseBlock } from '../../types/message.js';
import {
  LLMError,
  LLMAllProvidersFailedError,
  LLMTimeoutError,
  LLMRateLimitError,
  LLMAuthError,
  LLMModelNotFoundError,
  classifyLLMError,
  getUserActionHint,
} from '../../types/errors.js';

import type {
  ProviderConfig,
  LLMOrchestratorConfig,
  LLMCallOptions,
  ProviderAdapter,
  StreamChunk,
  LLMEventSink,
} from './types.js';
import type { LLMOrchestrator } from './index.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { createLLMProvider, type LLMProvider } from '../llm-provider/index.js';
import { makeExternalAbortError, withCombinedAbortSignal, type AbortReason } from '../llm-provider/index.js';

/**
 * Maximum exponential backoff delay (ms).
 *
 * Used as cap in `Math.min(retryDelayMs * 2^attempt, MAX_BACKOFF_MS)`
 * across LLM call() / stream() retry paths (line 170, 407).
 *
 * Value: 30_000 (30s) = empirical / 业界 HTTP retry cap 通常 20-60s 区间
 * （AWS SDK BaseRetryStrategy / GCP backoff cap 一般 32s）/ 平衡 server
 * recovery 等 vs user-perceived hang 上限.
 */
const MAX_BACKOFF_MS = 30_000;

const CONTEXT_EXCEEDED_STOP_REASONS = new Set<string>([
  'model_context_window_exceeded',  // anthropic
  'context_length_exceeded',         // openai variant
]);

/**
 * Provider factory - creates appropriate adapter for config
 */


/**
 * Sleep for `ms` milliseconds; abortable via `signal`.
 *
 * - `signal.aborted === true` at call time → rejects immediately with AbortError
 * - `signal` fires during wait → clearTimeout + rejects with AbortError
 * - Timer elapses normally → removes listener + resolves
 *
 * Used by call()/stream() retry backoff to respect external abort promptly
 * (without this, abort during backoff would wait up to 30s before responding).
 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(makeExternalAbortError(signal?.reason as AbortReason | undefined));
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      reject(makeExternalAbortError(signal?.reason as AbortReason | undefined));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * LLM Service implementation
 */
export class LLMOrchestratorImpl implements LLMOrchestrator {
  private primary: LLMProvider;
  private fallbacks: LLMProvider[];
  private config: LLMOrchestratorConfig;
  // Track current provider: -1 = primary, 0..N = fallbacks[i]
  private currentProviderIndex = -1;

  private lastSuccessProvider: {
    name: string;
    model: string;
    isFallback: boolean;
  } | null = null;

  // Circuit breakers for each provider (primary + fallbacks)
  private breakers: CircuitBreaker[];

  private events: LLMEventSink;

  constructor(config: LLMOrchestratorConfig) {
    this.config = config;
    this.events = config.events;
    this.primary = createLLMProvider(config.primary);
    this.fallbacks = (config.fallbacks ?? []).map(createLLMProvider);
    
    // Initialize circuit breakers if configured
    const cb = config.circuitBreaker;
    const allProviders = [this.primary, ...this.fallbacks];
    this.breakers = cb
      ? allProviders.map((p) => new CircuitBreaker(
          cb.failureThreshold,
          cb.resetTimeoutMs,
          (transition) => this.events.emit({ type: transition, provider: p.name }),
        ))
      : [];

    // Wire onStreamParseError for A.4 (Step 5 calls this)
    const parseErrHandler = (e: { provider: string; raw: string; error: string }) =>
      this.events.emit({ type: 'stream_parse_error', ...e });
    this.primary.onStreamParseError = parseErrHandler;
    this.fallbacks.forEach(fb => { fb.onStreamParseError = parseErrHandler; });

    // Wire onToolArgParseError for tool args JSON.parse failures
    const toolArgErrHandler = (e: { provider: string; toolName: string; rawArgs: string; error: string }) =>
      this.events.emit({ type: 'tool_arg_parse_error', ...e });
    this.primary.onToolArgParseError = toolArgErrHandler;
    this.fallbacks.forEach(fb => { fb.onToolArgParseError = toolArgErrHandler; });
  }

  /**
   * Make an LLM call with retry and failover
   */
  async call(options: LLMCallOptions): Promise<LLMResponse> {
    // Helper to check circuit breaker
    const isBreakerOpen = (index: number): boolean => {
      const breaker = this.breakers[index];
      return breaker ? breaker.isOpen() : false;
    };
    
    // Try primary provider with retries
    let lastError: Error | undefined;
    if (!isBreakerOpen(0)) {
      for (let attempt = 0; attempt < this.config.maxAttempts; attempt++) {
        if (options.signal?.aborted) throw makeExternalAbortError(options.signal.reason as AbortReason | undefined);

        const hardTimeoutMs = options.hardTimeoutMs;
        let providerSignal: AbortSignal | undefined;
        let cleanupSignal: () => void = () => {};
        let hardSignal: AbortSignal | undefined;
        if (hardTimeoutMs) {
          const [handle, cleanup] = withCombinedAbortSignal(options.signal, hardTimeoutMs);
          providerSignal = handle.signal;
          cleanupSignal = cleanup;
          hardSignal = handle.signal;
        } else {
          providerSignal = options.signal;
        }
        const providerOptions: LLMCallOptions = { ...options, signal: providerSignal, hardTimeoutMs: undefined, streamIdleTimeoutMs: undefined };

        try {
          const response = await this.primary.call(providerOptions);
          cleanupSignal();

          // Circuit breaker: record success
          this.breakers[0]?.onSuccess();

          // Reset to primary
          this.currentProviderIndex = -1;
          this.updateLastSuccess(this.primary, false);
          return response;

        } catch (error) {
          cleanupSignal();
          lastError = error as Error;

          // Don't retry on user abort (would add multi-second delay)
          if (options.signal?.aborted) throw lastError;
          // Provider self-thrown AbortError when hard signal did not fire
          if (lastError.name === 'AbortError' && !hardSignal?.aborted) throw lastError;

          // phase 735 step 4: class-aware retry decision
          const errClass = classifyLLMError(lastError);
          if (errClass === 'permanent') {
            // 401/403/404 → 直接 failover / 0 retry / 不浪费 backoff 时间
            this.events.emit({
              type: 'permanent_skip_retry',
              provider: this.primary.name,
              attempt,
              errorClass: errClass,
            });
            break;  // 跳出 retry loop / 进入 fallback failover
          }

          // Wait before retry (exponential backoff with 30s max)
          if (attempt < this.config.maxAttempts - 1) {
            const backoffMs = Math.min(
              this.config.retryDelayMs * Math.pow(2, attempt),
              MAX_BACKOFF_MS,
            );
            this.events.emit({ type: 'retry_scheduled', provider: this.primary.name, attempt, backoffMs });
            await delay(backoffMs, options.signal);
          }
        }
      }
      
      // Circuit breaker: record failure
      const wasOpen0 = this.breakers[0]?.isOpen();
      this.breakers[0]?.onFailure(classifyLLMError(lastError!));
      if (!wasOpen0 && this.breakers[0]?.isOpen()) {
        this.events.emit({ type: 'breaker_opened', provider: this.primary.name, consecutiveFailures: this.config.circuitBreaker?.failureThreshold ?? 0 });
      }

      // Primary failed, continue to fallbacks
    }

    // Primary failed or breaker open, try fallbacks in order
    const failures: Array<{ provider: string; error: Error }> = [];
    if (isBreakerOpen(0)) {
      failures.push({ provider: this.primary.name, error: new Error('Circuit breaker open') });
    } else if (lastError) {
      this.events.emit({ type: 'provider_exhausted', provider: this.primary.name, error: lastError.message });
      failures.push({ provider: this.primary.name, error: lastError });
    }

    if (this.fallbacks.length > 0 && lastError) {
      this.events.emit({ type: 'fallback_switched', from: this.primary.name, to: this.fallbacks[0].name, reason: 'primary_exhausted' });
    }
    
    for (let i = 0; i < this.fallbacks.length; i++) {
      if (options.signal?.aborted) throw makeExternalAbortError(options.signal.reason as AbortReason | undefined);
      // Skip if breaker is open
      if (isBreakerOpen(i + 1)) {
        failures.push({ provider: this.fallbacks[i].name, error: new Error('Circuit breaker open') });
        continue;
      }

      const fb = this.fallbacks[i];

      const hardTimeoutMs = options.hardTimeoutMs;
      let providerSignal: AbortSignal | undefined;
      let cleanupSignal: () => void = () => {};
      let hardSignal: AbortSignal | undefined;
      if (hardTimeoutMs) {
        const [handle, cleanup] = withCombinedAbortSignal(options.signal, hardTimeoutMs);
        providerSignal = handle.signal;
        cleanupSignal = cleanup;
        hardSignal = handle.signal;
      } else {
        providerSignal = options.signal;
      }
      const providerOptions: LLMCallOptions = { ...options, signal: providerSignal, hardTimeoutMs: undefined, streamIdleTimeoutMs: undefined };

      try {
        const response = await fb.call(providerOptions);
        cleanupSignal();

        // Circuit breaker: record success
        this.breakers[i + 1]?.onSuccess();

        this.currentProviderIndex = i;
        this.updateLastSuccess(fb, true);
        return response;

      } catch (fallbackError) {
        cleanupSignal();
        const err = fallbackError as Error;
        if (options.signal?.aborted) throw err;
        // Provider self-thrown AbortError when hard signal did not fire
        if (err.name === 'AbortError' && !hardSignal?.aborted) throw err;
        this.events.emit({ type: 'provider_exhausted', provider: fb.name, error: err.message });
        const wasOpen = this.breakers[i + 1]?.isOpen();
        this.breakers[i + 1]?.onFailure(classifyLLMError(err));
        if (!wasOpen && this.breakers[i + 1]?.isOpen()) {
          this.events.emit({ type: 'breaker_opened', provider: fb.name, consecutiveFailures: this.config.circuitBreaker?.failureThreshold ?? 0 });
        }
        failures.push({ provider: fb.name, error: err });
      }
    }
    
    // All providers failed
    throw new LLMAllProvidersFailedError(failures);
  }
  
  /**
   * Stream LLM response with retry and fallback support
   * 
   * - Retries with exponential backoff on connection failures (same as call())
   * - Falls back to fallback provider if all retries exhausted
   * - Note: retry only applies before stream starts; once chunks are flowing, 
   *         mid-stream errors will fail over without retry
   */
  async* stream(options: LLMCallOptions): AsyncIterableIterator<StreamChunk> {
    // Hedge gate (phase 737): breaker open + transient cause + fallbacks available → 2-track hedge
    const primaryBreakerOpen = this.breakers[0]?.isOpen() ?? false;
    const openCause = this.breakers[0]?.getOpenCause() ?? null;
    if (primaryBreakerOpen && openCause === 'transient' && this.fallbacks.length > 0 && this.primary.stream) {
      yield* this._streamHedge(options);
      return;
    }

    const providers: Array<{ adapter: LLMProvider; breakerIndex: number }> = [
      { adapter: this.primary, breakerIndex: 0 },
      ...this.fallbacks.map((fb, i) => ({ adapter: fb, breakerIndex: i + 1 })),
    ];

    const failures: Array<{ provider: string; error: Error }> = [];

    // contextExceededCount race 边界：single-threaded async loop / per-attempt increment / race 极小
    let contextExceededCount = 0;

    for (let pi = 0; pi < providers.length; pi++) {
      if (options.signal?.aborted) throw makeExternalAbortError(options.signal.reason as AbortReason | undefined);
      const { adapter, breakerIndex } = providers[pi];

      if (!adapter.stream) continue;

      // Check circuit breaker
      const breaker = this.breakers[breakerIndex];
      if (breaker?.isOpen()) {
        failures.push({ provider: adapter.name, error: new Error('Circuit breaker open') });
        yield { type: 'provider_failed' as const, provider: adapter.name, model: adapter.model, error: 'Circuit breaker open' };
        continue;
      }

      // Track current provider so getProviderInfo() reflects the active adapter
      // during mid-stream failover — not just the last one that fully completed.
      this.currentProviderIndex = pi === 0 ? -1 : pi - 1;

      // Retry loop (aligns with call())
      let success = false;
      let hasYielded = false;
      let midStreamReset = false;
      let lastError: Error | null = null;
      let doneChunk: StreamChunk | undefined;
      let contextExceeded = false;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let idleCtrl: AbortController | null = null;
      let cleanupSignal: (() => void) | undefined;
      for (let attempt = 0; attempt < this.config.maxAttempts; attempt++) {
        idleTimer = undefined;
        idleCtrl = null;
        cleanupSignal = undefined;
        try {
          const idleMs = options.streamIdleTimeoutMs;
          idleCtrl = idleMs ? new AbortController() : null;
          const resetIdleTimer = () => {
            if (!idleCtrl || !idleMs) return;
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => idleCtrl!.abort(), idleMs);
          };

          const merged = mergeSignals(options.signal, idleCtrl?.signal);
          cleanupSignal = merged.cleanup;
          const providerOptions: LLMCallOptions = { ...options, signal: merged.signal, hardTimeoutMs: undefined, streamIdleTimeoutMs: undefined };

          resetIdleTimer();
          for await (const chunk of adapter.stream(providerOptions)) {
            resetIdleTimer();
            hasYielded = true;
            if (chunk.type === 'done') {
              doneChunk = chunk;
              if (chunk.stopReason && CONTEXT_EXCEEDED_STOP_REASONS.has(chunk.stopReason)) {
                contextExceeded = true;
                this.events.emit({ type: 'context_exceeded_failover', provider: adapter.name, stopReason: chunk.stopReason });
                yield {
                  type: 'reset',
                  provider: adapter.name,
                };
                break; // exit inner stream loop early
              }
            }
            yield chunk;
          }
          clearTimeout(idleTimer);
          cleanupSignal?.();

          if (contextExceeded) {
            contextExceededCount++;
            midStreamReset = true;
            break; // exit retry loop → outer loop continues to next provider
          }

          success = true;
          break; // Success, exit retry loop
        } catch (error) {
          clearTimeout(idleTimer);
          cleanupSignal?.();
          const err = error as Error;
          lastError = err;
          const isUserAbort = options.signal?.aborted;
          const isIdleTimeout = idleCtrl?.signal.aborted && !isUserAbort;

          if (isUserAbort) throw err;

          if (isIdleTimeout) {
            // ⚓4 ε ratified by phase 628 user binary: probe-then-decide
            // (per design/modules/l2_llm_orchestrator.md §B.stream-idle-failover-vs-retry-symmetry / phase 637 兑现)
            // - probe success → idle 是 transient lull / retry same provider stream
            // - probe failure (network/timeout) → failover next provider
            // - probe auth/model 错 → throw user-facing reconfigure
            const probeTimeoutMs = options.streamIdleProbeTimeoutMs ?? 5_000;
            this.events.emit({
              type: 'stream_idle_probe_attempted',
              provider: adapter.name,
              timeoutMs: probeTimeoutMs,
            });
            const probe = await this._minimalProbe(adapter, probeTimeoutMs);
            if (probe.ok) {
              this.events.emit({
                type: 'stream_idle_probe_succeeded',
                provider: adapter.name,
              });
              continue; // retry same provider stream within retry loop（复用 maxAttempts budget）
            }
            if (probe.reason === 'auth_or_model') {
              // probe auth/model 错 = 用户配置问题 / throw 给 caller decide
              throw probe.error;
            }
            // probe network/timeout → failover next provider（既有 idle_failover 路径）
            this.events.emit({
              type: 'idle_failover_triggered',
              provider: adapter.name,
              ms: options.streamIdleTimeoutMs!,
            });
            lastError = new Error(
              `Idle timeout after ${options.streamIdleTimeoutMs}ms (probe failed: ${probe.error.message})`,
            );
            break; // exit retry loop → outer loop continues to next provider
          }

          // Provider self-thrown AbortError when no signal fired
          if (err.name === 'AbortError') throw err;

          // Mid-stream error: signal caller to discard partial state, then failover to next provider
          if (hasYielded) {
            this.events.emit({ type: 'stream_reset', provider: adapter.name, error: err.message });
            yield {
              type: 'reset',
              provider: adapter.name,
              ...(err instanceof LLMTimeoutError ? { timeoutMs: err.timeoutMs } : {}),
            };
            midStreamReset = true;
            break; // exit retry loop → outer loop continues to next provider
          }

          // Don't wait after the last attempt
          if (attempt < this.config.maxAttempts - 1) {
            const backoffMs = Math.min(
              this.config.retryDelayMs * Math.pow(2, attempt),
              MAX_BACKOFF_MS,
            );
            this.events.emit({ type: 'retry_scheduled', provider: adapter.name, attempt, backoffMs });
            await delay(backoffMs, options.signal);
          }
        }
      }

      if (success && hasYielded) {
        // Circuit breaker: record success
        breaker?.onSuccess();
        // Update current provider index (-1 = primary, 0..N = fallbacks)
        this.currentProviderIndex = pi === 0 ? -1 : pi - 1;
        this.updateLastSuccess(adapter, pi !== 0);
        return; // Success, exit generator
      }

      if (success && !hasYielded) {
        // ⚓5 α default ratified by phase 628 user binary (default accepted):
        // 0-chunk → onFailure (conservative miss-detect / D5 redundant defense)
        // (per design/modules/l2_llm_orchestrator.md §B.stream-zero-chunk-breaker-sensitivity / phase 637 兑现)
        // Stream completed normally but produced nothing — treat as failure
        const wasOpen = breaker?.isOpen();
        // phase 815 P1.34: 显式 pass 'unknown' / 防 half-open probe 失败时 lastFailureClass 保 stale prior class
        // （`if (errClass)` 守卫在 CircuitBreaker.onFailure 不 update lastFailureClass when errClass undefined / 修触发点不动 CB）
        breaker?.onFailure('unknown');
        if (!wasOpen && breaker?.isOpen()) {
          this.events.emit({ type: 'breaker_opened', provider: adapter.name, consecutiveFailures: this.config.circuitBreaker?.failureThreshold ?? 0 });
        }
        const err = new Error('Stream completed with 0 chunks');
        this.events.emit({
          type: 'provider_attempt_failed',
          provider: adapter.name,
          attempt: 0,
          error: err.message,
          errorClass: 'unknown',
          userActionHint: null,
        });
        failures.push({ provider: adapter.name, error: err });
        yield { type: 'provider_failed' as const, provider: adapter.name, model: adapter.model, error: err.message };
        // Continue to next provider
      } else if (!midStreamReset) {
        // Circuit breaker: record failure
        const wasOpen = breaker?.isOpen();
        breaker?.onFailure(classifyLLMError(lastError ?? new Error('Unknown stream error')));
        if (!wasOpen && breaker?.isOpen()) {
          this.events.emit({ type: 'breaker_opened', provider: adapter.name, consecutiveFailures: this.config.circuitBreaker?.failureThreshold ?? 0 });
        }
        const err = lastError ?? new Error('Unknown stream error');
        this.events.emit({
          type: 'provider_attempt_failed',
          provider: adapter.name,
          attempt: 0,
          error: err.message,
          errorClass: classifyLLMError(err),
          userActionHint: getUserActionHint(err),
        });
        failures.push({ provider: adapter.name, error: err });
        yield { type: 'provider_failed' as const, provider: adapter.name, model: adapter.model, error: err.message };
        // Continue to next provider
      }
    }

    // All providers failed
    const totalProviders = providers.length;
    if (contextExceededCount > 0 && contextExceededCount === totalProviders) {
      throw new Error(
        `All ${totalProviders} providers exhausted with context_window_exceeded. ` +
        `Reduce system prompt, tool definitions, or conversation history.`
      );
    }

    throw new LLMAllProvidersFailedError(failures);
  }
  
  private updateLastSuccess(adapter: LLMProvider, isFallback: boolean): void {
    this.lastSuccessProvider = {
      name: adapter.name,
      model: adapter.model,
      isFallback,
    };
  }

  /**
   * Get current provider info
   */
  getProviderInfo(): {
    name: string;
    model: string;
    isFallback: boolean;
  } | null {
    return this.lastSuccessProvider;
  }
  
  /**
   * Minimal probe: single non-stream call with explicit timeout.
   * Distinguishes transient network/timeout errors from auth/model config issues.
   */
  private async _minimalProbe(
    provider: LLMProvider,
    timeoutMs: number,
  ): Promise<{ ok: true } | { ok: false; reason: 'network_timeout' | 'auth_or_model'; error: Error }> {
    const probeCtrl = new AbortController();
    const probeTimer = setTimeout(() => probeCtrl.abort(), timeoutMs);
    try {
      await provider.call({
        messages: [{ role: 'user', content: 'Hi' }],
        maxTokens: 1,
        signal: probeCtrl.signal,
      });
      return { ok: true };
    } catch (err) {
      const e = err as Error;
      // network/timeout 类（含 abort）→ transient
      if (
        probeCtrl.signal.aborted ||
        e.name === 'AbortError' ||
        e instanceof LLMTimeoutError ||
        e instanceof LLMRateLimitError
      ) {
        return { ok: false, reason: 'network_timeout', error: e };
      }
      // 其他（含 auth/model 配置错）→ 非 transient 用户配置问题
      return { ok: false, reason: 'auth_or_model', error: e };
    } finally {
      clearTimeout(probeTimer);
    }
  }

  /**
   * Health check - quick validation that provider is reachable
   */
  async healthCheck(): Promise<boolean> {
    const adapters = [this.primary, ...this.fallbacks];
    const timeoutMs = 10_000; // healthCheck 默 10s（与既有 caller 0 timeout 行为等价）
    for (const adapter of adapters) {
      const result = await this._minimalProbe(adapter, timeoutMs);
      if (result.ok) return true;
      this.events.emit({
        type: 'healthcheck_failed',
        provider: adapter.name,
        error: result.error.message,
      });
    }
    return false;
  }
  
  /**
   * 2-track hedge on breaker open (phase 737).
   * Track A: primary stream — wait for first content chunk (real recovery evidence).
   * Track B: fallback chain sequential call() — first success wins.
   * Winner-takes-all via Promise.race; loser aborted to avoid resource waste.
   */
  private async* _streamHedge(options: LLMCallOptions): AsyncIterableIterator<StreamChunk> {
    const fallbackNames = this.fallbacks.map(f => f.name);
    this.events.emit({
      type: 'hedge_started',
      primary: this.primary.name,
      fallbackChain: fallbackNames,
      triggerErrorClass: 'transient',
    });

    const primaryCtrl = new AbortController();
    const trackBCtrl = new AbortController();

    const primaryMerged = mergeSignals(options.signal, primaryCtrl.signal);
    const trackBMergedBase = mergeSignals(options.signal, trackBCtrl.signal);
    const cleanupSignals = () => { primaryMerged.cleanup(); trackBMergedBase.cleanup(); };

    // Track A: primary.stream() iter, wait for first content chunk
    const primaryProviderOpts: LLMCallOptions = {
      ...options,
      signal: primaryMerged.signal,
      hardTimeoutMs: undefined,
      streamIdleTimeoutMs: undefined,
    };
    const primaryIter = this.primary.stream!(primaryProviderOpts);

    type AResult =
      | { winner: 'A'; chunk: StreamChunk }
      | { winner: 'A-error'; error: Error };

    const trackAPromise: Promise<AResult> = (async () => {
      try {
        // Manual next() to avoid for-await...return triggering iterator.return()
        // which would terminate the generator and prevent post-race drain.
        while (true) {
          const { done, value: chunk } = await primaryIter.next();
          if (done) break;
          if (isContentChunk(chunk)) return { winner: 'A', chunk };
          // skip metadata chunks (done/reset/thinking_signature/etc.)
        }
        return { winner: 'A-error', error: new Error('primary stream ended without content chunk') };
      } catch (e) {
        return { winner: 'A-error', error: e as Error };
      }
    })();

    // Track B: fallback chain sequential call()
    type BResult =
      | { winner: 'B'; provider: LLMProvider; providerIndex: number; response: LLMResponse }
      | { winner: 'B-error'; failures: Array<{ provider: string; error: Error }> };

    const trackBPromise: Promise<BResult> = (async () => {
      const failures: Array<{ provider: string; error: Error }> = [];
      for (let i = 0; i < this.fallbacks.length; i++) {
        if (trackBCtrl.signal.aborted) return { winner: 'B-error', failures };
        const fb = this.fallbacks[i];
        if (this.breakers[i + 1]?.isOpen()) {
          failures.push({ provider: fb.name, error: new Error('Circuit breaker open') });
          continue;
        }
        const fbMerged = mergeSignals(options.signal, trackBCtrl.signal);
        const fbOpts: LLMCallOptions = {
          ...options,
          signal: fbMerged.signal,
          hardTimeoutMs: undefined,
          streamIdleTimeoutMs: undefined,
        };
        try {
          const response = await fb.call(fbOpts);
          fbMerged.cleanup();
          this.breakers[i + 1]?.onSuccess();
          return { winner: 'B', provider: fb, providerIndex: i, response };
        } catch (err) {
          fbMerged.cleanup();
          if (trackBCtrl.signal.aborted) return { winner: 'B-error', failures };
          const e = err as Error;
          const errClass = classifyLLMError(e);
          this.breakers[i + 1]?.onFailure(errClass);
          this.events.emit({
            type: 'provider_attempt_failed',
            provider: fb.name,
            attempt: 0,
            error: e.message,
            errorClass: errClass,
            userActionHint: getUserActionHint(e),
          });
          failures.push({ provider: fb.name, error: e });
        }
      }
      return { winner: 'B-error', failures };
    })();

    // Race
    const winner = await Promise.race([trackAPromise, trackBPromise]);

    // A 胜（first content chunk）
    if (winner.winner === 'A') {
      trackBCtrl.abort();
      this.breakers[0]?.onSuccess(); // breaker auto-close (first chunk = real recovery)
      this.events.emit({ type: 'hedge_primary_recovered', provider: this.primary.name });
      this.currentProviderIndex = -1;
      this.updateLastSuccess(this.primary, false);
      yield winner.chunk;
      try {
        for await (const chunk of primaryIter) yield chunk; // drain rest
      } finally {
        cleanupSignals();
      }
      return;
    }

    // B 胜（fallback call success）
    if (winner.winner === 'B') {
      primaryCtrl.abort();
      const aResult = await trackAPromise.catch(() => null);
      const primaryErr = aResult?.winner === 'A-error' ? aResult.error : new Error('primary stream cancelled');
      const primaryErrClass = classifyLLMError(primaryErr);
      this.events.emit({
        type: 'hedge_fallback_committed',
        winnerProvider: winner.provider.name,
        primaryProvider: this.primary.name,
        primaryError: primaryErr.message,
        primaryErrorClass: primaryErrClass,
      });
      this.currentProviderIndex = winner.providerIndex;
      this.updateLastSuccess(winner.provider, true);
      cleanupSignals();
      yield* wrapResponseAsStream(winner.response, winner.provider);
      return;
    }

    // A-error 胜（A 早失败）→ 等 B
    if (winner.winner === 'A-error') {
      const bResult = await trackBPromise;
      if (bResult.winner === 'B') {
        primaryCtrl.abort();
        this.events.emit({
          type: 'hedge_fallback_committed',
          winnerProvider: bResult.provider.name,
          primaryProvider: this.primary.name,
          primaryError: winner.error.message,
          primaryErrorClass: classifyLLMError(winner.error),
        });
        this.currentProviderIndex = bResult.providerIndex;
        this.updateLastSuccess(bResult.provider, true);
        cleanupSignals();
        yield* wrapResponseAsStream(bResult.response, bResult.provider);
        return;
      }
      // 双失败
      cleanupSignals();
      throw new LLMAllProvidersFailedError([
        { provider: this.primary.name, error: winner.error },
        ...bResult.failures,
      ]);
    }

    // B-error 胜（B 全失败）→ 等 A
    const aResult = await trackAPromise;
    if (aResult.winner === 'A') {
      trackBCtrl.abort();
      this.breakers[0]?.onSuccess();
      this.events.emit({ type: 'hedge_primary_recovered', provider: this.primary.name });
      this.currentProviderIndex = -1;
      this.updateLastSuccess(this.primary, false);
      yield aResult.chunk;
      try {
        for await (const chunk of primaryIter) yield chunk;
      } finally {
        cleanupSignals();
      }
      return;
    }
    // 双失败
    cleanupSignals();
    throw new LLMAllProvidersFailedError([
      { provider: this.primary.name, error: aResult.error },
      ...winner.failures,
    ]);
  }

  /**
   * Close/cleanup - no-op for fetch-based implementation
   */
  async close(): Promise<void> {
    // No persistent connections to close
  }
}

function isContentChunk(chunk: StreamChunk): boolean {
  return chunk.type === 'text_delta'
    || chunk.type === 'thinking_delta'
    || chunk.type === 'tool_use_start'
    || chunk.type === 'tool_use_delta';
}

async function* wrapResponseAsStream(
  response: LLMResponse,
  provider: LLMProvider,
): AsyncIterableIterator<StreamChunk> {
  for (const block of response.content) {
    if (block.type === 'text') {
      const b = block as TextBlock;
      yield { type: 'text_delta', delta: b.text };
    } else if (block.type === 'thinking') {
      const b = block as ThinkingBlock;
      yield { type: 'thinking_delta', delta: b.thinking };
      if (b.signature) yield { type: 'thinking_signature', signature: b.signature };
    } else if (block.type === 'tool_use') {
      const b = block as ToolUseBlock;
      yield { type: 'tool_use_start', toolUse: { id: b.id, name: b.name } };
      yield {
        type: 'tool_use_delta',
        toolUse: { id: b.id, name: b.name, partialInput: JSON.stringify(b.input) },
      };
    }
    // ignore tool_result / unknown blocks (assistant response shouldn't have these)
  }
  yield {
    type: 'done',
    stopReason: typeof response.stop_reason === 'string' ? response.stop_reason : 'end_turn',
    usage: response.usage
      ? { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens }
      : undefined,
  };
}

function mergeSignals(
  a: AbortSignal | undefined,
  b: AbortSignal | undefined,
): { signal: AbortSignal | undefined; cleanup: () => void } {
  if (!a && !b) return { signal: undefined, cleanup: () => {} };
  if (!a) return { signal: b, cleanup: () => {} };
  if (!b) return { signal: a, cleanup: () => {} };
  const ctrl = new AbortController();
  if (a.aborted || b.aborted) {
    ctrl.abort();
    return { signal: ctrl.signal, cleanup: () => {} };
  }
  const abort = () => ctrl.abort();
  a.addEventListener('abort', abort, { once: true });
  b.addEventListener('abort', abort, { once: true });
  return {
    signal: ctrl.signal,
    cleanup: () => {
      a.removeEventListener('abort', abort);
      b.removeEventListener('abort', abort);
    },
  };
}
