/**
 * LLM Service - Main implementation with failover and retry
 * 
 * Implements ILLMService interface
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
  IProviderAdapter,
  StreamChunk,
} from './types.js';
import type { ILLMService } from './index.js';
import { AnthropicAdapter } from './anthropic.js';
import { CustomAnthropicAdapter } from './custom-anthropic.js';
import { OpenAIAdapter } from './openai.js';
import { GeminiAdapter } from './gemini.js';

/**
 * Provider factory - creates appropriate adapter for config
 */
function createProvider(config: ProviderConfig): IProviderAdapter {
  if (config.apiFormat === 'openai') return new OpenAIAdapter(config);
  if (config.apiFormat === 'gemini') return new GeminiAdapter(config);
  // anthropic format: Claude models use SDK (native API), others use raw fetch
  const isClaude = config.model.toLowerCase().includes('claude');
  return isClaude ? new AnthropicAdapter(config) : new CustomAnthropicAdapter(config);
}

/**
 * Delay helper for retry backoff
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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
export class LLMService implements ILLMService {
  private primary: IProviderAdapter;
  private fallbacks: IProviderAdapter[];
  private config: LLMServiceConfig;
  // Track current provider: -1 = primary, 0..N = fallbacks[i]
  private currentProviderIndex = -1;

  // Circuit breakers for each provider (primary + fallbacks)
  private breakers: CircuitBreaker[];

  constructor(config: LLMServiceConfig) {
    this.config = config;
    this.primary = createProvider(config.primary);
    this.fallbacks = (config.fallbacks ?? []).map(createProvider);
    
    // Initialize circuit breakers if configured
    const cb = config.circuitBreaker;
    this.breakers = cb
      ? [this.primary, ...this.fallbacks].map(() => new CircuitBreaker(cb.failureThreshold, cb.resetTimeoutMs))
      : [];
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
            await delay(backoffMs);
          }
        }
      }
      
      // Circuit breaker: record failure
      this.breakers[0]?.onFailure();
      
      // Primary failed, continue to fallbacks
    }
    
    // Primary failed or breaker open, try fallbacks in order
    const failures: Array<{ provider: string; error: Error }> = [];
    if (isBreakerOpen(0)) {
      failures.push({ provider: this.primary.name, error: new Error('Circuit breaker open') });
    } else if (lastError) {
      console.warn(`[llm] provider "${this.primary.name}" failed: ${lastError.message}`);
      failures.push({ provider: this.primary.name, error: lastError });
    }
    
    for (let i = 0; i < this.fallbacks.length; i++) {
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
        console.warn(`[llm] provider "${fb.name}" failed: ${err.message}`);
        this.breakers[i + 1]?.onFailure();
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
    const providers: Array<{ adapter: IProviderAdapter; breakerIndex: number }> = [
      { adapter: this.primary, breakerIndex: 0 },
      ...this.fallbacks.map((fb, i) => ({ adapter: fb, breakerIndex: i + 1 })),
    ];

    const failures: Array<{ provider: string; error: Error }> = [];

    for (let pi = 0; pi < providers.length; pi++) {
      const { adapter, breakerIndex } = providers[pi];

      if (!adapter.stream) continue;

      // Check circuit breaker
      const breaker = this.breakers[breakerIndex];
      if (breaker?.isOpen()) {
        console.warn(`[llm] provider "${adapter.name}" skipped: circuit breaker open`);
        failures.push({ provider: adapter.name, error: new Error('Circuit breaker open') });
        continue;
      }

      // Retry loop (aligns with call())
      let success = false;
      let hasYielded = false;
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
          // Mid-stream timeout: signal caller to discard partial state, then failover to next provider
          if (hasYielded) {
            if (err instanceof LLMTimeoutError) {
              yield { type: 'reset', provider: adapter.name, timeoutMs: err.timeoutMs };
              break; // exit retry loop → outer loop continues to next provider
            }
            throw err;
          }

          // Don't wait after the last attempt
          if (attempt < this.config.maxAttempts - 1) {
            const backoffMs = Math.min(
              this.config.retryDelayMs * Math.pow(2, attempt),
              30000,
            );
            await delay(backoffMs);
          }
        }
      }

      if (success) {
        // Circuit breaker: record success
        breaker?.onSuccess();
        // Update current provider index (-1 = primary, 0..N = fallbacks)
        this.currentProviderIndex = pi === 0 ? -1 : pi - 1;
        if (!hasYielded) {
          console.warn(`[llm] provider "${adapter.name}" stream completed but yielded 0 chunks`);
        }
        return; // Success, exit generator
      } else {
        // Circuit breaker: record failure
        breaker?.onFailure();
        const err = lastError ?? new Error('Unknown stream error');
        console.warn(`[llm] provider "${adapter.name}" failed: ${err.message}`);
        failures.push({ provider: adapter.name, error: err });
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
      console.warn('[llm] healthCheck failed:', err instanceof Error ? err.message : err);
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
