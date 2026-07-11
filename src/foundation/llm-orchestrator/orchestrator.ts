/**
 * LLM Service - Main implementation with failover and retry
 * 
 * Implements LLMOrchestrator interface
 * - Retry with exponential backoff
 * - Failover to fallback provider
 */


import type { LLMResponse } from '../llm-provider/types.js';
import {
  LLMAllProvidersFailedError,
  LLMError,
  LLMTimeoutError,
  LLMRateLimitError,
  LLMEmptyResponseError,
  LLMCircuitBreakerOpenError,
  LLMStreamAbortedError,
  classifyLLMError,
  getUserActionHint,
} from './errors.js';
// Phase 186: ContextTrimExhaustedError from L4 ContextManager — we avoid direct L2→L4 import
// per architecture layer rules, and duck-type via error.name instead of instanceof.
const CONTEXT_TRIM_EXHAUSTED_ERROR_NAME = 'ContextTrimExhaustedError';

import type {
  LLMOrchestratorConfig,
  LLMCallOptions,
  StreamChunk,
  LLMEventSink,
  ProviderConfig,
} from './types.js';
import type { LLMOrchestrator } from './types.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { createLLMProvider, type LLMProvider } from '../llm-provider/index.js';
import { makeExternalAbortError, withCombinedAbortSignal, type AbortReason } from '../llm-provider/index.js';
import { isAbortError } from '../llm-provider/is-abort-error.js';
import { delay, isContentChunk, wrapResponseAsStream, mergeSignals } from './utils.js';
import { sha256ShortHex } from  '../node-utils/index.js';  // phase 450 (review): cache key apiKey hash

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

/**
 * Default stream-idle probe timeout (ms).
 * Derivation: 5_000ms = 5s / 短 enough 不显著拖延 failover decision / 长 enough
 * 覆盖 typical TCP RTT + first byte（即使 cross-region）.
 */
const DEFAULT_STREAM_IDLE_PROBE_TIMEOUT_MS = 5_000;

const CONTEXT_EXCEEDED_STOP_REASONS = new Set<string>([
  'model_context_window_exceeded',  // anthropic
  'context_length_exceeded',         // openai variant
]);

/**
 * LLM Service implementation
 */
export class LLMOrchestratorImpl implements LLMOrchestrator {
  private primary: LLMProvider;
  private fallbacks: LLMProvider[];
  private config: LLMOrchestratorConfig;

  private lastSuccessProvider: {
    name: string;
    model: string;
    isFallback: boolean;
  } | null = null;

  // phase 686: 「正在流的 provider」/ stream 中首 chunk yield 时设、generator 出口（finally）清
  // 修 getProviderInfo 滞后一轮的 bug（failover 转换轮内本字段反映本轮 provider、非上一轮）
  private currentStreamingProvider: {
    name: string;
    model: string;
    isFallback: boolean;
  } | null = null;

  // Circuit breakers for each provider (primary + fallbacks)
  private breakers: CircuitBreaker[];

  private events: LLMEventSink;

  // phase 1374 sub-3: SDK client cache (instance-lifetime)
  private sdkClientCache = new Map<string, LLMProvider>();

  /**
   * phase 287 Step C: extract backoff formula to helper (M#1 共用基础设施单源)
   *
   * Exponential backoff with jitter, capped at MAX_BACKOFF_MS.
   * Formula: retryDelayMs * 2^attempt * (0.75 + random * 0.5) capped at MAX_BACKOFF_MS.
   */
  private computeBackoffMs(attempt: number): number {
    return Math.min(
      this.config.retryDelayMs * Math.pow(2, attempt) * (0.75 + Math.random() * 0.5),
      MAX_BACKOFF_MS,
    );
  }

  private getSdkClient(config: ProviderConfig): LLMProvider {
    // phase 450 (review): cache key 含全部 endpoint-determining 字段
    // - baseUrl: 同 apiFormat+model 不同 endpoint 不应共享 client
    // - apiKey hash (SHA-256 前 8 位): 防末 8 位明文 collision + 不放完整 key
    const apiKeyHash = config.apiKey
      ? sha256ShortHex(config.apiKey, 8)
      : 'noapikey';
    const key = [
      config.apiFormat ?? 'unknown',
      config.model ?? 'unknown',
      config.baseUrl ?? 'default',
      apiKeyHash,
    ].join(':');
    if (!this.sdkClientCache.has(key)) {
      this.sdkClientCache.set(key, createLLMProvider(config));
      this.events?.emit({ type: 'sdk_client_cache_miss', preset: config.apiFormat ?? 'unknown', model: config.model ?? 'unknown' });
    } else {
      this.events?.emit({ type: 'sdk_client_cache_hit', preset: config.apiFormat ?? 'unknown', model: config.model ?? 'unknown' });
    }
    return this.sdkClientCache.get(key)!;
  }

  constructor(config: LLMOrchestratorConfig) {
    this.config = config;
    this.events = config.events;
    this.primary = this.getSdkClient(config.primary);
    this.fallbacks = (config.fallbacks ?? []).map((c) => this.getSdkClient(c));
    
    // Initialize circuit breakers if configured
    const cb = config.circuitBreaker;
    const allProviders = [this.primary, ...this.fallbacks];
    this.breakers = cb
      ? allProviders.map((p) => new CircuitBreaker(
          cb.failureThreshold,
          cb.resetTimeoutMs,
          (transition, failures) => {
            if (transition === 'breaker_opened') {
              this.events.emit({ type: 'breaker_opened', provider: p.name, consecutiveFailures: failures ?? 0 });
            } else {
              this.events.emit({ type: transition, provider: p.name });
            }
          },
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
   * Try a single provider with retries.
   * Returns LLMResponse on success, throws lastError when all retries exhausted.
   * Caller catches to proceed to next provider.
   */
  private async _tryCallProvider(
    adapter: LLMProvider,
    breakerIndex: number,
    isFallback: boolean,
    options: LLMCallOptions,
  ): Promise<LLMResponse> {
    let lastError: Error | undefined;

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
        this.currentStreamingProvider = { name: adapter.name, model: adapter.model, isFallback };
        const response = await adapter.call(providerOptions);
        cleanupSignal();
        this.breakers[breakerIndex]?.onSuccess();
        this.updateLastSuccess(adapter, isFallback);
        return response;
      } catch (error) {
        cleanupSignal();
        lastError = error as Error;

        if (options.signal?.aborted) throw lastError;
        if (lastError.name === 'AbortError' && hardSignal?.aborted) throw lastError;
        if (lastError.name === 'AbortError' && !hardSignal?.aborted) throw lastError;

        if (lastError?.name === CONTEXT_TRIM_EXHAUSTED_ERROR_NAME) {
          this.events.emit({ type: 'context_exceeded_failover', provider: adapter.name, stopReason: 'context_trim_exhausted' });
          break;
        }

        if (classifyLLMError(lastError) === 'context_exceeded') {
          this.events.emit({ type: 'context_exceeded_throwthrough', provider: adapter.name });
          throw lastError;
        }

        this.events.emit({
          type: 'provider_attempt_failed',
          provider: adapter.name,
          attempt,
          error: lastError.message,
          errorClass: classifyLLMError(lastError),
          userActionHint: getUserActionHint(lastError),
        });

        const errClass = classifyLLMError(lastError);
        if (errClass === 'permanent') {
          this.events.emit({ type: 'permanent_skip_retry', provider: adapter.name, attempt, errorClass: errClass });
          break;
        }

        if (attempt < this.config.maxAttempts - 1) {
          const backoffMs = this.computeBackoffMs(attempt);
          this.events.emit({ type: 'retry_scheduled', provider: adapter.name, attempt, backoffMs });
          await delay(backoffMs, options.signal);
        }
      }
    }

    // All retries exhausted — record breaker failure and throw
    const wasOpen = this.breakers[breakerIndex]?.isOpen();
    this.breakers[breakerIndex]?.onFailure(classifyLLMError(lastError!));
    if (!wasOpen && this.breakers[breakerIndex]?.isOpen()) {
      this.events.emit({ type: 'breaker_opened', provider: adapter.name, consecutiveFailures: this.config.circuitBreaker?.failureThreshold ?? 0 });
    }
    this.events.emit({ type: 'provider_exhausted', provider: adapter.name, error: lastError!.message });
    throw lastError;
  }

  /**
   * Make an LLM call with retry and failover
   */
  async call(options: LLMCallOptions): Promise<LLMResponse> {
    const isBreakerOpen = (index: number): boolean => {
      const breaker = this.breakers[index];
      return breaker ? breaker.isOpen() : false;
    };

    const failures: Array<{ provider: string; error: Error }> = [];

    try {
      // 上次成功的 fallback 排最前：同 turn 内后续 step 直接用、不反复 failover
      if (this.lastSuccessProvider?.isFallback) {
        const stickyFb = this.fallbacks.find(fb => fb.name === this.lastSuccessProvider!.name);
        const stickyIdx = stickyFb ? this.fallbacks.indexOf(stickyFb) : -1;
        if (stickyFb && stickyIdx >= 0 && !isBreakerOpen(stickyIdx + 1)) {
          try {
            return await this._tryCallProvider(stickyFb, stickyIdx + 1, true, options);
          } catch (err) {
            // User abort is not a provider failure — propagate immediately
            if (options.signal?.aborted || isAbortError(err)) throw err;
            // silent: collect sticky fallback failure for aggregate LLMAllProvidersFailedError
            failures.push({ provider: stickyFb.name, error: err as Error });
          }
        }
      }

      // Try primary
      let primaryFailed = false;
      if (!isBreakerOpen(0)) {
        try {
          return await this._tryCallProvider(this.primary, 0, false, options);
        } catch (err) {
          // User abort is not a provider failure — propagate immediately
          if (options.signal?.aborted || isAbortError(err)) throw err;
          // silent: collect primary failure for aggregate LLMAllProvidersFailedError
          primaryFailed = true;
          failures.push({ provider: this.primary.name, error: err as Error });
        }
      } else {
        failures.push({ provider: this.primary.name, error: new LLMCircuitBreakerOpenError(this.primary.name) });
      }

      // Primary exhausted — try remaining fallbacks
      if (this.fallbacks.length > 0 && primaryFailed) {
        this.events.emit({ type: 'fallback_switched', from: this.primary.name, to: this.fallbacks[0].name, reason: 'primary_exhausted' });
      }

      for (let i = 0; i < this.fallbacks.length; i++) {
        if (options.signal?.aborted) throw makeExternalAbortError(options.signal.reason as AbortReason | undefined);
        if (isBreakerOpen(i + 1)) {
          failures.push({ provider: this.fallbacks[i].name, error: new LLMCircuitBreakerOpenError(this.fallbacks[i].name) });
          continue;
        }

        try {
          return await this._tryCallProvider(this.fallbacks[i], i + 1, true, options);
        } catch (err) {
          // User abort is not a provider failure — propagate immediately
          if (options.signal?.aborted || isAbortError(err)) throw err;
          // silent: collect fallback failure for aggregate LLMAllProvidersFailedError
          failures.push({ provider: this.fallbacks[i].name, error: err as Error });
        }
      }

      throw new LLMAllProvidersFailedError(failures);
    } finally {
      this.currentStreamingProvider = null;
    }
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

    // 上次成功的 fallback 排到最前：同 turn 内后续 step 直接用、不反复 failover
    if (this.lastSuccessProvider?.isFallback) {
      const stickyIdx = providers.findIndex(p => p.adapter.name === this.lastSuccessProvider!.name);
      if (stickyIdx > 0) {
        const [entry] = providers.splice(stickyIdx, 1);
        providers.unshift(entry);
      }
    }

    const failures: Array<{ provider: string; error: Error }> = [];

    // contextExceededCount race 边界：single-threaded async loop / per-attempt increment / race 极小
    let contextExceededCount = 0;
    // phase 991 B.4: skipped (breaker-open) provider 不计入 totalAttempted 分母
    let skippedCount = 0;

    // phase 686: 跟踪上个失败 provider / 下个 provider 成功首 chunk 时 emit fallback_switched
    // call() 与 stream() 对称（call 在 line 262 已 emit、stream 路径之前缺、本 phase 补）
    let lastFailedProviderName: string | null = null;

    try {
    for (let pi = 0; pi < providers.length; pi++) {
      if (options.signal?.aborted) throw makeExternalAbortError(options.signal.reason as AbortReason | undefined);
      const { adapter, breakerIndex } = providers[pi];

      if (!adapter.stream) continue;

      // Check circuit breaker
      const breaker = this.breakers[breakerIndex];
      if (breaker?.isOpen()) {
        skippedCount++;
        failures.push({ provider: adapter.name, error: new LLMCircuitBreakerOpenError(adapter.name) });
        yield { type: 'provider_failed' as const, provider: adapter.name, model: adapter.model, error: 'Circuit breaker open' };
        lastFailedProviderName = adapter.name;  // phase 686
        continue;
      }

      let firstChunkAnnounced = false;  // phase 686: 本 provider 内 fallback_switched + currentStreamingProvider 只首 chunk 一次


      // Retry loop (aligns with call())
      let success = false;
      let hasYielded = false;
      let receivedDone = false;
      let midStreamReset = false;
      let lastError: Error | null = null;
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
            // phase 686: 首 chunk yield 前 emit fallback_switched + set currentStreamingProvider
            if (!firstChunkAnnounced) {
              firstChunkAnnounced = true;
              if (lastFailedProviderName !== null && lastFailedProviderName !== adapter.name) {
                this.events.emit({
                  type: 'fallback_switched',
                  from: lastFailedProviderName,
                  to: adapter.name,
                  reason: 'failover_succeeded',
                });
                lastFailedProviderName = null;
              }
              this.currentStreamingProvider = { name: adapter.name, model: adapter.model, isFallback: pi !== 0 };
            }
            hasYielded = true;
            if (chunk.type === 'done') {
              receivedDone = true;
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
            lastFailedProviderName = adapter.name;  // phase 686
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
            const probeTimeoutMs = options.streamIdleProbeTimeoutMs ?? DEFAULT_STREAM_IDLE_PROBE_TIMEOUT_MS;
            this.events.emit({
              type: 'stream_idle_probe_attempted',
              provider: adapter.name,
              timeoutMs: probeTimeoutMs,
            });
            const probe = await this._minimalProbe(adapter, probeTimeoutMs, options.signal);
            if (options.signal?.aborted) {
              // user abort overrides probe result — stop immediately instead of failover/retry
              throw err;
            }
            if (probe.ok) {
              this.events.emit({
                type: 'stream_idle_probe_succeeded',
                provider: adapter.name,
              });
              if (hasYielded) {
                // partial output already yielded → reset before retry
                this.events.emit({ type: 'stream_reset', provider: adapter.name, error: 'idle_timeout_probe_retry' });
                yield {
                  type: 'reset',
                  provider: adapter.name,
                };
              }
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
            lastError = new LLMTimeoutError(adapter.name, options.streamIdleTimeoutMs!);
            lastFailedProviderName = adapter.name;  // phase 686
            break; // exit retry loop → outer loop continues to next provider
          }

          // Provider self-thrown AbortError when no signal fired
          if (err.name === 'AbortError') throw err;

          // phase 690: stream 路径 context-exceeded（400 at handshake）→ 直接向上抛
          // 不 failover、不 retry、不进 stream_reset partial-state 路径（context-exceeded 必 0 chunks yielded）
          if (classifyLLMError(err) === 'context_exceeded') {
            this.events.emit({ type: 'context_exceeded_throwthrough', provider: adapter.name });
            throw err;
          }

          // Mid-stream error: signal caller to discard partial state, then failover to next provider
          if (hasYielded) {
            this.events.emit({ type: 'stream_reset', provider: adapter.name, error: err.message });
            yield {
              type: 'reset',
              provider: adapter.name,
              ...(err instanceof LLMTimeoutError ? { timeoutMs: err.timeoutMs } : {}),
            };
            midStreamReset = true;
            lastFailedProviderName = adapter.name;  // phase 686
            break; // exit retry loop → outer loop continues to next provider
          }

          // Don't wait after the last attempt
          if (attempt < this.config.maxAttempts - 1) {
            const backoffMs = this.computeBackoffMs(attempt);
            this.events.emit({ type: 'retry_scheduled', provider: adapter.name, attempt, backoffMs });
            await delay(backoffMs, options.signal);
          }
        }
      }

      if (success && receivedDone) {
        // Circuit breaker: record success
        breaker?.onSuccess();
        this.updateLastSuccess(adapter, pi !== 0);
        return; // Success, exit generator
      }

      if (success && hasYielded && !receivedDone) {
        // Stream ended cleanly but never emitted a done chunk — truncated/interrupted stream.
        // Signal caller to discard partial state, then failover to next provider.
        this.events.emit({ type: 'stream_reset', provider: adapter.name, error: 'stream ended without done chunk' });
        yield {
          type: 'reset',
          provider: adapter.name,
        };
        midStreamReset = true;
        lastFailedProviderName = adapter.name;
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
        const err = new LLMEmptyResponseError(adapter.name);
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
        lastFailedProviderName = adapter.name;  // phase 686
        // Continue to next provider
      } else if (!midStreamReset) {
        // Circuit breaker: record failure
        const wasOpen = breaker?.isOpen();
        breaker?.onFailure(classifyLLMError(lastError ?? new LLMStreamAbortedError(adapter.name, 'no error captured')));
        if (!wasOpen && breaker?.isOpen()) {
          this.events.emit({ type: 'breaker_opened', provider: adapter.name, consecutiveFailures: this.config.circuitBreaker?.failureThreshold ?? 0 });
        }
        const err = lastError ?? new LLMStreamAbortedError(adapter.name, 'no error captured');
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
        lastFailedProviderName = adapter.name;  // phase 686
        // Continue to next provider
      }
    }
    } finally {
      // phase 686: generator 出口（success return / throw / consumer abort）一定清 currentStreamingProvider
      // getProviderInfo 回落到 lastSuccessProvider（既有语义）
      this.currentStreamingProvider = null;
    }

    // All providers failed
    const totalProviders = providers.length;
    // phase 991 B.4: 减 skipped 让 user-actionable context-exceeded message 在 1+ skipped 时仍能触发
    const totalAttempted = totalProviders - skippedCount;
    if (contextExceededCount > 0 && contextExceededCount === totalAttempted) {
      this.events.emit({
        type: 'all_providers_context_exceeded',
        totalAttempted,
        skippedCount,
      });
      throw new LLMError(
        `All ${totalAttempted} providers exhausted with context_window_exceeded. ` +
        `Reduce system prompt, tool definitions, or conversation history.`,
        { totalAttempted, skippedCount },
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
  } {
    return (
      this.currentStreamingProvider
      ?? this.lastSuccessProvider
      ?? { name: this.primary.name, model: this.primary.model, isFallback: false }
    );
  }

  /**
   * 重置 lastSuccessProvider，下次 stream/call 从 primary 开始挑。
   * Runtime 在每轮 turn 开始调。
   */
  resetLastSuccessProvider(): void {
    this.lastSuccessProvider = null;
  }

  /**
   * Minimal probe: single non-stream call with explicit timeout.
   * Distinguishes transient network/timeout errors from auth/model config issues.
   */
  private async _minimalProbe(
    provider: LLMProvider,
    timeoutMs: number,
    userSignal?: AbortSignal,
  ): Promise<{ ok: true } | { ok: false; reason: 'network_timeout' | 'auth_or_model'; error: Error }> {
    const probeCtrl = new AbortController();
    const probeTimer = setTimeout(() => probeCtrl.abort(), timeoutMs);
    const merged = mergeSignals(userSignal, probeCtrl.signal);
    const signal = merged.signal ?? probeCtrl.signal;
    try {
      await provider.call({
        messages: [{ role: 'user', content: 'Hi' }],
        maxTokens: 1,
        signal,
      });
      return { ok: true };
    } catch (err) {
      const e = err as Error;
      // network/timeout 类（含 abort）→ transient
      if (
        probeCtrl.signal.aborted ||
        signal.aborted ||
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
      merged.cleanup();
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
        return { winner: 'A-error', error: new LLMStreamAbortedError(this.primary.name, 'stream ended without content chunk') };
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
          failures.push({ provider: fb.name, error: new LLMCircuitBreakerOpenError(fb.name) });
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
          // User abort takes priority over any provider-internal signal
          if (options.signal?.aborted) {
            throw makeExternalAbortError(options.signal.reason as AbortReason | undefined);
          }
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
      this.updateLastSuccess(this.primary, false);
      yield winner.chunk;
      let receivedDone = false;
      let drainError: Error | undefined;
      try {
        // phase 991 B.2: drain loop user-abort early-exit guard
        for await (const chunk of primaryIter) {
          if (options.signal?.aborted) {
            throw makeExternalAbortError(options.signal.reason as AbortReason | undefined);
          }
          if (chunk.type === 'done') receivedDone = true;
          yield chunk;
        }
      } catch (err) {
        // User abort is not a provider failure — don't trip breaker or emit stream_reset
        if (options.signal?.aborted) {
          throw makeExternalAbortError(options.signal.reason as AbortReason | undefined);
        }
        this.breakers[0]?.onFailure(classifyLLMError(err));
        this.events.emit({
          type: 'hedge_primary_post_first_chunk_failure',
          provider: this.primary.name,
          error: err as Error,
        });
        // phase 991 B.6: emit stream_reset + yield reset chunk mirror non-hedge line 442-450
        // caller 收 reset signal 知 discard partial state、与 non-hedge path 对称 invariant
        this.events.emit({ type: 'stream_reset', provider: this.primary.name, error: (err as Error).message });
        yield {
          type: 'reset',
          provider: this.primary.name,
          ...(err instanceof LLMTimeoutError ? { timeoutMs: err.timeoutMs } : {}),
        };
        drainError = err as Error;
      } finally {
        // phase 1374 sub-2: explicit cleanup instead of relying on GC / for-await auto-close
        try { await primaryIter.return?.(); } catch { /* silent: generator already closed, ignore */ }
        cleanupSignals();
      }
      if (!receivedDone && !drainError) {
        // Clean EOF without done → truncated stream, treat as provider failure
        this.breakers[0]?.onFailure('transient');
        this.events.emit({ type: 'stream_reset', provider: this.primary.name, error: 'hedge primary stream ended without done chunk' });
        yield { type: 'reset', provider: this.primary.name };
        yield { type: 'provider_failed', provider: this.primary.name, model: this.primary.model, error: 'stream ended without done chunk' };
        throw new LLMStreamAbortedError(this.primary.name, 'stream ended without done chunk');
      }
      if (drainError) throw drainError;
      return;
    }

    // B 胜（fallback call success）
    if (winner.winner === 'B') {
      primaryCtrl.abort();
      const aResult = await trackAPromise;

      if (aResult.winner === 'A') {
        // 3 态 race outcome: A 实际 produced content chunk 但 B race 先 settled (rare race window)
        // NEW event explicit observability、不合成假 'primary stream cancelled' Error
        this.events.emit({
          type: 'hedge_primary_succeeded_after_race_lost',
          primaryProvider: this.primary.name,
          winnerProvider: winner.provider.name,
        });
        this.events.emit({
          type: 'hedge_fallback_committed',
          winnerProvider: winner.provider.name,
          primaryProvider: this.primary.name,
          primaryError: 'A succeeded but race lost (commit fallback for low latency)',
          primaryErrorClass: 'unknown', // A succeeded、no real error; 'unknown' enum value 不误导 (LLMErrorClass 无 'none')
          cacheCreationInputTokens: winner.response.usage?.cache_creation_input_tokens ?? undefined,
          cacheReadInputTokens: winner.response.usage?.cache_read_input_tokens ?? undefined,
        });
      } else {
        // A-error (含 AbortError from primaryCtrl.abort propagated to iterator)
        if (options.signal?.aborted) {
          throw makeExternalAbortError(options.signal.reason as AbortReason | undefined);
        }
        const primaryErr = aResult.error;
        const primaryErrClass = classifyLLMError(primaryErr);
        this.events.emit({
          type: 'hedge_fallback_committed',
          winnerProvider: winner.provider.name,
          primaryProvider: this.primary.name,
          primaryError: primaryErr.message,
          primaryErrorClass: primaryErrClass,
          cacheCreationInputTokens: winner.response.usage?.cache_creation_input_tokens ?? undefined,
          cacheReadInputTokens: winner.response.usage?.cache_read_input_tokens ?? undefined,
        });
      }

      this.updateLastSuccess(winner.provider, true);
      // NEW: drain primary generator (mirror L821 double-fail template)
      try { await primaryIter.return?.(); } catch { /* silent: generator already closed, ignore */ }
      this.events.emit({ type: 'race_loser_cleaned', provider: this.primary.name, reason: 'hedge_trackB_won' });
      cleanupSignals();
      yield* wrapResponseAsStream(winner.response);
      return;
    }

    // A-error 胜（A 早失败）→ 等 B
    if (winner.winner === 'A-error') {
      const bResult = await trackBPromise;
      if (options.signal?.aborted) {
        throw makeExternalAbortError(options.signal.reason as AbortReason | undefined);
      }
      if (bResult.winner === 'B') {
        primaryCtrl.abort();
        this.events.emit({
          type: 'hedge_fallback_committed',
          winnerProvider: bResult.provider.name,
          primaryProvider: this.primary.name,
          primaryError: winner.error.message,
          primaryErrorClass: classifyLLMError(winner.error),
          cacheCreationInputTokens: bResult.response.usage?.cache_creation_input_tokens ?? undefined,
          cacheReadInputTokens: bResult.response.usage?.cache_read_input_tokens ?? undefined,
        });
        this.updateLastSuccess(bResult.provider, true);
        cleanupSignals();
        yield* wrapResponseAsStream(bResult.response);
        return;
      }
      // 双失败
      // phase 991 B.3: primary breaker accounting mirror line 715 single-fail
      if (options.signal?.aborted) {
        throw makeExternalAbortError(options.signal.reason as AbortReason | undefined);
      }
      this.breakers[0]?.onFailure(classifyLLMError(winner.error));
      try { await primaryIter.return?.(); } catch { /* silent: generator already closed, ignore */ }
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
      this.updateLastSuccess(this.primary, false);
      yield aResult.chunk;
      let receivedDone = false;
      let drainError: Error | undefined;
      try {
        // phase 991 B.2: drain loop user-abort early-exit guard
        for await (const chunk of primaryIter) {
          if (options.signal?.aborted) {
            throw makeExternalAbortError(options.signal.reason as AbortReason | undefined);
          }
          if (chunk.type === 'done') receivedDone = true;
          yield chunk;
        }
      } catch (err) {
        // User abort is not a provider failure — don't trip breaker or emit stream_reset
        if (options.signal?.aborted) {
          throw makeExternalAbortError(options.signal.reason as AbortReason | undefined);
        }
        this.breakers[0]?.onFailure(classifyLLMError(err));
        this.events.emit({
          type: 'hedge_primary_post_first_chunk_failure',
          provider: this.primary.name,
          error: err as Error,
        });
        this.events.emit({ type: 'stream_reset', provider: this.primary.name, error: (err as Error).message });
        yield {
          type: 'reset',
          provider: this.primary.name,
          ...(err instanceof LLMTimeoutError ? { timeoutMs: err.timeoutMs } : {}),
        };
        drainError = err as Error;
      } finally {
        cleanupSignals();
      }
      if (!receivedDone && !drainError) {
        // Clean EOF without done → truncated stream, treat as provider failure
        this.breakers[0]?.onFailure('transient');
        this.events.emit({ type: 'stream_reset', provider: this.primary.name, error: 'hedge primary stream ended without done chunk' });
        yield { type: 'reset', provider: this.primary.name };
        yield { type: 'provider_failed', provider: this.primary.name, model: this.primary.model, error: 'stream ended without done chunk' };
        throw new LLMStreamAbortedError(this.primary.name, 'stream ended without done chunk');
      }
      if (drainError) throw drainError;
      return;
    }
    // 双失败
    // phase 991 B.3: primary breaker accounting mirror line 715 single-fail
    if (options.signal?.aborted) {
      throw makeExternalAbortError(options.signal.reason as AbortReason | undefined);
    }
    this.breakers[0]?.onFailure(classifyLLMError(aResult.error));
    try { await primaryIter.return?.(); } catch { /* silent: generator already closed, ignore */ }
    cleanupSignals();
    throw new LLMAllProvidersFailedError([
      { provider: this.primary.name, error: aResult.error },
      ...winner.failures,
    ]);
  }

  /**
   * Close/cleanup - clear SDK client cache.
   * phase 517 B7: 实现 API 契约「close() 释放资源」。Anthropic SDK 等用 fetch keepalive
   * agent、不显式清理依赖 GC 回收时机不可控。close 后再 call 会 lazy 重建 cache。
   */
  async close(): Promise<void> {
    for (const [, provider] of this.sdkClientCache) {
      // LLMProvider 接口未要求 close()、optional chain 兼容未实现的 provider
      await (provider as { close?: () => Promise<void> | void }).close?.();
    }
    this.sdkClientCache.clear();
  }

  /**
   * phase 320: 原地替换 primary/fallbacks/breakers，对象引用不变。
   * 同 ctor L98-131 同构（改 ctor 需同步改本方法、否则 reload 与起步态漂移）。
   * sdkClientCache 不清（旧 key 残留无害；切回旧 provider 时 cache hit、性能更好）。
   * events 不动（装配期注入）。
   * lastSuccessProvider 重置：配置已变，上次成功的 provider 信息应失效。
   * currentStreamingProvider 不动（如有活跃 stream，配置替换不影响当前流）。
   */
  reloadConfig(newConfig: LLMOrchestratorConfig): void {
    this.config = newConfig;
    this.primary = this.getSdkClient(newConfig.primary);
    this.fallbacks = (newConfig.fallbacks ?? []).map((c) => this.getSdkClient(c));

    const cb = newConfig.circuitBreaker;
    const allProviders = [this.primary, ...this.fallbacks];
    this.breakers = cb
      ? allProviders.map((p) => new CircuitBreaker(
          cb.failureThreshold,
          cb.resetTimeoutMs,
          (transition, failures) => {
            if (transition === 'breaker_opened') {
              this.events.emit({ type: 'breaker_opened', provider: p.name, consecutiveFailures: failures ?? 0 });
            } else {
              this.events.emit({ type: transition, provider: p.name });
            }
          },
        ))
      : [];

    const parseErrHandler = (e: { provider: string; raw: string; error: string }) =>
      this.events.emit({ type: 'stream_parse_error', ...e });
    this.primary.onStreamParseError = parseErrHandler;
    this.fallbacks.forEach(fb => { fb.onStreamParseError = parseErrHandler; });

    const toolArgErrHandler = (e: { provider: string; toolName: string; rawArgs: string; error: string }) =>
      this.events.emit({ type: 'tool_arg_parse_error', ...e });
    this.primary.onToolArgParseError = toolArgErrHandler;
    this.fallbacks.forEach(fb => { fb.onToolArgParseError = toolArgErrHandler; });

    // 配置已替换 → 上次成功的 provider 信息不再有效
    this.lastSuccessProvider = null;
  }
}

