/**
 * Circuit Breaker for provider health
 *
 * Module-level state machine used by LLMOrchestratorImpl per provider (primary + fallbacks).
 * Self-contained: 0 cross-module state dependencies / not exported from barrel
 * (implementation detail of llm-orchestrator).
 *
 * State machine:
 * closed --(连续失败 N 次)--> open --(resetTimeoutMs 后)--> half-open
 *   ^                            |
 *   └────────(探测成功)──────────┘
 *             (探测失败) → 回 open
 */
import type { LLMErrorClass } from './errors.js';

export class CircuitBreaker {
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private failures = 0;
  private openedAt?: number;
  private lastFailureClass: LLMErrorClass | null = null;
  private onTransition?: (transition: 'breaker_half_open' | 'breaker_closed' | 'breaker_opened', failures?: number) => void;

  constructor(
    private readonly threshold: number,
    private readonly resetTimeoutMs: number,
    onTransition?: (transition: 'breaker_half_open' | 'breaker_closed' | 'breaker_opened', failures?: number) => void,
  ) {
    this.onTransition = onTransition;
  }

  isOpen(): boolean {
    if (this.state === 'open') {
      if (Date.now() - this.openedAt! >= this.resetTimeoutMs) {
        this.state = 'half-open';
        this.onTransition?.('breaker_half_open');
        return false; // 允许一次探测
      }
      return true; // 仍在冷却
    }
    return false;
  }

  onSuccess(): void {
    const was = this.state;
    this.failures = 0;
    this.lastFailureClass = null;
    this.state = 'closed';
    if (was !== 'closed') {
      this.onTransition?.('breaker_closed');
    }
  }

  onFailure(errClass?: LLMErrorClass): void {
    this.failures++;
    if (errClass) this.lastFailureClass = errClass;
    if (this.state === 'half-open' || this.failures >= this.threshold) {
      const was = this.state;
      this.state = 'open';
      this.openedAt = Date.now();
      if (was !== 'open') {
        this.onTransition?.('breaker_opened', this.failures);
      }
    }
  }

  /**
   * Returns the error class that caused the breaker to enter 'open' state.
   * Returns null if breaker is not open, or class not recorded.
   *
   * Used by LLMOrchestrator hedge gate (phase 737):
   * - 'transient' → enable hedge mode (parallel A track stream + B track sequential)
   * - 'permanent' / 'rate_limit' → skip hedge (avoid abuse detection / rate limiter trigger)
   */
  getOpenCause(): LLMErrorClass | null {
    return this.state === 'open' ? this.lastFailureClass : null;
  }
}
