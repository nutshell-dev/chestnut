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
export class CircuitBreaker {
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private failures = 0;
  private openedAt?: number;
  private onTransition?: (transition: 'breaker_half_open' | 'breaker_closed') => void;

  constructor(
    private readonly threshold: number,
    private readonly resetTimeoutMs: number,
    onTransition?: (transition: 'breaker_half_open' | 'breaker_closed') => void,
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
    this.state = 'closed';
    if (was !== 'closed') {
      this.onTransition?.('breaker_closed');
    }
  }

  onFailure(): void {
    this.failures++;
    if (this.state === 'half-open' || this.failures >= this.threshold) {
      this.state = 'open';
      this.openedAt = Date.now();
    }
  }
}
