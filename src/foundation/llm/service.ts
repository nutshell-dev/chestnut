/**
 * LLM Service - Main implementation with failover and retry
 * 
 * Implements LLMService interface
 * - Retry with exponential backoff
 * - Failover to fallback provider
 */


import type { LLMResponse } from '../../types/message.js';
import {
  LLMError,
  LLMAllProvidersFailedError,
  LLMTimeoutError,
} from '../../types/errors.js';

import type {
  ProviderConfig,
  LLMServiceConfig,
  LLMCallOptions,
  ProviderAdapter,
  StreamChunk,
  LLMEventSink,
} from './types.js';
import type { LLMService } from './index.js';
import { AnthropicAdapter } from './anthropic.js';
import { CustomAnthropicAdapter } from './custom-anthropic.js';
import { OpenAIAdapter } from './openai.js';
import { GeminiAdapter } from './gemini.js';
import { makeExternalAbortError } from './abort-helper.js';

/**
 * Provider factory - creates appropriate adapter for config
 */
function createProvider(config: ProviderConfig): ProviderAdapter {
  // Allow passing a pre-built adapter directly (used in tests)
  if ('stream' in config && typeof (config as any).stream === 'function') {
    return config as unknown as ProviderAdapter;
  }
  if (config.apiFormat === 'openai') return new OpenAIAdapter(config);
  if (config.apiFormat === 'gemini') return new GeminiAdapter(config);
  // anthropic format: Claude models use SDK (native API), others use raw fetch
  const isClaude = config.model.toLowerCase().includes('claude');
  return isClaude ? new AnthropicAdapter(config) : new CustomAnthropicAdapter(config);
}

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
      reject(makeExternalAbortError());
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      reject(makeExternalAbortError());
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Circuit Breaker for provider health
 * 
 * State machine:
 * closed --(连续失败 N 次)--> open --(resetTimeoutMs 后)--> half-open
 *   ^                            |
 *   └────────(探测成功)──────────┘
 *             (探测失败) → 回 open
 */
class CircuitBreaker {
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private failures = 0;
  private openedAt?: number;

  constructor(
    private readonly threshold: number,
    private readonly resetTimeoutMs: number,
  ) {}

  isOpen(): boolean {
    if (this.state === 'open') {
      if (Date.now() - this.openedAt! >= this.resetTimeoutMs) {
        this.state = 'half-open';
        return false; // 允许一次探测
      }
      return true; // 仍在冷却
    }
    return false;
  }

  onSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
  }

  onFailure(): void {
    this.failures++;
    if (this.state === 'half-open' || this.failures >= this.threshold) {
      this.state = 'open';
      this.openedAt = Date.now();
    }
  }
}

/**
 * LLM Service implementation
 */
export class LLMServiceImpl implements LLMService {
  private primary: ProviderAdapter;
  private fallbacks: ProviderAdapter[];
  private config: LLMServiceConfig;
  // Track current provider: -1 = primary, 0..N = fallbacks[i]
  private currentProviderIndex = -1;

  // Circuit breakers for each provider (primary + fallbacks)
  private breakers: CircuitBreaker[];

  private events: LLMEventSink;

  constructor(config: LLMServiceConfig) {
    this.config = config;
    this.events = config.events;
    this.primary = createProvider(config.primary);
    this.fallbacks = (config.fallbacks ?? []).map(createProvider);
    
    // Initialize circuit breakers if configured
    const cb = config.circuitBreaker;
    this.breakers = cb
      ? [this.primary, ...this.fallbacks].map(() => new CircuitBreaker(cb.failureThreshold, cb.resetTimeoutMs))
      : [];

    // Wire onStreamParseError for A.4 (Step 5 calls this)
    const parseErrHandler = (e: { provider: string; raw: string; error: string }) =>
      this.events.emit({ type: 'stream_parse_error', ...e });
    this.primary.onStreamParseError = parseErrHandler;
    this.fallbacks.forEach(fb => { fb.onStreamParseError = parseErrHandler; });
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
        if (options.signal?.aborted) throw makeExternalAbortError();
        try {
          const response = await this.primary.call(options);
          
          // Circuit breaker: record success
          this.breakers[0]?.onSuccess();
          
          // Reset to primary
          this.currentProviderIndex = -1;
          return response;
          
        } catch (error) {
          lastError = error as Error;

          // Don't retry on user abort (would add multi-second delay)
          if (lastError.name === 'AbortError') throw lastError;
          
          // Wait before retry (exponential backoff with 30s max)
          if (attempt < this.config.maxAttempts - 1) {
            const backoffMs = Math.min(
              this.config.retryDelayMs * Math.pow(2, attempt),
              30_000  // Max 30 seconds
            );
            this.events.emit({ type: 'retry_scheduled', provider: this.primary.name, attempt, backoffMs });
            await delay(backoffMs, options.signal);
          }
        }
      }
      
      // Circuit breaker: record failure
      const wasOpen0 = this.breakers[0]?.isOpen();
      this.breakers[0]?.onFailure();
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
      if (options.signal?.aborted) throw makeExternalAbortError();
      // Skip if breaker is open
      if (isBreakerOpen(i + 1)) {
        failures.push({ provider: this.fallbacks[i].name, error: new Error('Circuit breaker open') });
        continue;
      }
      
      const fb = this.fallbacks[i];
      try {
        const response = await fb.call(options);
        
        // Circuit breaker: record success
        this.breakers[i + 1]?.onSuccess();
        
        this.currentProviderIndex = i;
        return response;
        
      } catch (fallbackError) {
        const err = fallbackError as Error;
        this.events.emit({ type: 'provider_exhausted', provider: fb.name, error: err.message });
        const wasOpen = this.breakers[i + 1]?.isOpen();
        this.breakers[i + 1]?.onFailure();
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
    const providers: Array<{ adapter: ProviderAdapter; breakerIndex: number }> = [
      { adapter: this.primary, breakerIndex: 0 },
      ...this.fallbacks.map((fb, i) => ({ adapter: fb, breakerIndex: i + 1 })),
    ];

    const failures: Array<{ provider: string; error: Error }> = [];

    for (let pi = 0; pi < providers.length; pi++) {
      if (options.signal?.aborted) throw makeExternalAbortError();
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
      for (let attempt = 0; attempt < this.config.maxAttempts; attempt++) {
        try {
          for await (const chunk of adapter.stream(options)) {
            hasYielded = true;
            if (chunk.type === 'done') doneChunk = chunk;
            yield chunk;
          }
          success = true;
          break; // Success, exit retry loop
        } catch (error) {
          const err = error as Error;
          lastError = err;
          // Don't retry on user abort
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
              30000,
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
        return; // Success, exit generator
      }

      if (success && !hasYielded) {
        // Stream completed normally but produced nothing — treat as failure
        const wasOpen = breaker?.isOpen();
        breaker?.onFailure();
        if (!wasOpen && breaker?.isOpen()) {
          this.events.emit({ type: 'breaker_opened', provider: adapter.name, consecutiveFailures: this.config.circuitBreaker?.failureThreshold ?? 0 });
        }
        const err = new Error('Stream completed with 0 chunks');
        this.events.emit({ type: 'provider_attempt_failed', provider: adapter.name, attempt: 0, error: err.message });
        failures.push({ provider: adapter.name, error: err });
        yield { type: 'provider_failed' as const, provider: adapter.name, model: adapter.model, error: err.message };
        // Continue to next provider
      } else if (!midStreamReset) {
        // Circuit breaker: record failure
        const wasOpen = breaker?.isOpen();
        breaker?.onFailure();
        if (!wasOpen && breaker?.isOpen()) {
          this.events.emit({ type: 'breaker_opened', provider: adapter.name, consecutiveFailures: this.config.circuitBreaker?.failureThreshold ?? 0 });
        }
        const err = lastError ?? new Error('Unknown stream error');
        this.events.emit({ type: 'provider_attempt_failed', provider: adapter.name, attempt: 0, error: err.message });
        failures.push({ provider: adapter.name, error: err });
        yield { type: 'provider_failed' as const, provider: adapter.name, model: adapter.model, error: err.message };
        // Continue to next provider
      }
    }

    // All providers failed
    throw new LLMAllProvidersFailedError(failures);
  }
  
  /**
   * Get current provider info
   */
  getProviderInfo(): {
    name: string;
    model: string;
    isFallback: boolean;
  } {
    const provider = this.currentProviderIndex === -1
      ? this.primary
      : this.fallbacks[this.currentProviderIndex];
    
    return {
      name: provider.name,
      model: provider.model,
      isFallback: this.currentProviderIndex !== -1,
    };
  }
  
  /**
   * Health check - quick validation that provider is reachable
   */
  async healthCheck(): Promise<boolean> {
    try {
      // Make a minimal request (low token count)
      await this.primary.call({
        messages: [{ role: 'user', content: 'Hi' }],
        maxTokens: 1,
      });
      return true;
    } catch (err) {
      this.events.emit({ type: 'healthcheck_failed', provider: this.primary.name, error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }
  
  /**
   * Close/cleanup - no-op for fetch-based implementation
   */
  async close(): Promise<void> {
    // No persistent connections to close
  }
}
