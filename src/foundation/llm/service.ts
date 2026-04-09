/**
 * LLM Service - Main implementation with failover and retry
 * 
 * Implements ILLMService interface
 * - Retry with exponential backoff
 * - Failover to fallback provider
 * - Monitor integration for logging
 */


import type { LLMResponse } from '../../types/message.js';
import {
  LLMError,
  LLMAllProvidersFailedError,
  LLMTimeoutError,
} from '../../types/errors.js';
import { appendFileSync, mkdirSync, writeFileSync } from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { AuditWriter } from '../audit/writer.js';
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
  private clawId?: string;
  
  // Track current provider: -1 = primary, 0..N = fallbacks[i]
  private currentProviderIndex = -1;
  
  // Circuit breakers for each provider (primary + fallbacks)
  private breakers: CircuitBreaker[];
  
  private auditWriter?: AuditWriter;
  private errorLogDir?: string;

  constructor(
    config: LLMServiceConfig,
    clawId?: string,
    auditWriter?: AuditWriter,
    errorLogDir?: string,
  ) {
    this.config = config;
    this.primary = createProvider(config.primary);
    this.fallbacks = (config.fallbacks ?? []).map(createProvider);
    this.clawId = clawId;
    this.auditWriter = auditWriter;
    this.errorLogDir = errorLogDir;
    
    // Initialize circuit breakers if configured
    const cb = config.circuitBreaker;
    this.breakers = cb
      ? [this.primary, ...this.fallbacks].map(() => new CircuitBreaker(cb.failureThreshold, cb.resetTimeoutMs))
      : [];
  }

  private writeErrorLog(ref: string, failures: Array<{ provider: string; error: Error }>): void {
    if (!this.errorLogDir) return;
    try {
      mkdirSync(this.errorLogDir, { recursive: true });
      const body = JSON.stringify(
        failures.map(f => ({
          provider: f.provider,
          message: f.error.message,
          stack: f.error.stack,
          code: (f.error as any).code,
        })),
        null, 2
      );
      writeFileSync(path.join(this.errorLogDir, `${ref}.json`), body);
    } catch { /* 日志写失败不能影响业务 */ }
  }
  
  /**
   * Make an LLM call with retry and failover
   */
  async call(options: LLMCallOptions): Promise<LLMResponse> {
    const startTime = Date.now();
    let retryCount = 0;
    
    // Helper to check circuit breaker
    const isBreakerOpen = (index: number): boolean => {
      const breaker = this.breakers[index];
      return breaker ? breaker.isOpen() : false;
    };
    
    // Try primary provider with retries
    if (!isBreakerOpen(0)) {
      let lastError: Error | undefined;
      
      for (let attempt = 0; attempt < this.config.maxAttempts; attempt++) {
        try {
          const callStart = Date.now();
          const response = await this.primary.call(options);
          
          // Circuit breaker: record success
          this.breakers[0]?.onSuccess();
          
          // Reset to primary
          this.currentProviderIndex = -1;
          this.auditWriter?.write('llm_call', this.primary.model,
            `in=${response.usage?.input_tokens ?? 0}`,
            `out=${response.usage?.output_tokens ?? 0}`,
            `ms=${Date.now() - callStart}`);
          return response;
          
        } catch (error) {
          lastError = error as Error;
          retryCount++;
          
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
    const failures: Array<{ provider: string; error: Error }> = [
      { provider: this.primary.name, error: new Error(isBreakerOpen(0) ? 'Circuit breaker open' : 'All retries failed') }
    ];
    
    for (let i = 0; i < this.fallbacks.length; i++) {
      // Skip if breaker is open
      if (isBreakerOpen(i + 1)) {
        failures.push({ provider: this.fallbacks[i].name, error: new Error('Circuit breaker open') });
        continue;
      }
      
      const fb = this.fallbacks[i];
      try {
        const callStart = Date.now();
        const response = await fb.call(options);
        
        // Circuit breaker: record success
        this.breakers[i + 1]?.onSuccess();
        
        this.currentProviderIndex = i;
        this.auditWriter?.write('llm_call', fb.model,
          `in=${response.usage?.input_tokens ?? 0}`,
          `out=${response.usage?.output_tokens ?? 0}`,
          `ms=${Date.now() - callStart}`);
        return response;
        
      } catch (fallbackError) {
        // Circuit breaker: record failure
        this.breakers[i + 1]?.onFailure();
        
        failures.push({ provider: fb.name, error: fallbackError as Error });
      }
    }
    
    // All providers failed
    const ref = randomUUID().slice(0, 8);
    this.writeErrorLog(ref, failures);
    this.auditWriter?.write('llm_error', this.primary.model,
      `err=${failures.map(f => f.error.message).join('; ')}`,
      `ms=${Date.now() - startTime}`,
      `ref=${ref}`);
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
    const startTime = Date.now();
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
        failures.push({ provider: adapter.name, error: new Error('Circuit breaker open') });
        continue; // Skip if breaker open
      }

      // Retry loop (aligns with call())
      let success = false;
      let hasYielded = false;
      let lastError: Error | null = null;
      let doneChunk: StreamChunk | undefined;
      let callStart = Date.now();
      for (let attempt = 0; attempt < this.config.maxAttempts; attempt++) {
        callStart = Date.now();
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
        this.auditWriter?.write('llm_call', adapter.model,
          `in=${doneChunk?.usage?.inputTokens ?? 0}`,
          `out=${doneChunk?.usage?.outputTokens ?? 0}`,
          `ms=${Date.now() - callStart}`);
        return; // Success, exit generator
      } else {
        // Circuit breaker: record failure
        breaker?.onFailure();
        failures.push({
          provider: adapter.name,
          error: lastError ?? new Error('Unknown stream error'),
        });
        // Continue to next provider
      }
    }

    // All providers failed
    const ref = randomUUID().slice(0, 8);
    this.writeErrorLog(ref, failures);
    this.auditWriter?.write('llm_error', this.primary.model,
      `err=${failures.map(f => f.error.message).join('; ')}`,
      `ms=${Date.now() - startTime}`,
      `ref=${ref}`);
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
  
  /**
   * Log LLM call to monitor (if configured)
   */
}
