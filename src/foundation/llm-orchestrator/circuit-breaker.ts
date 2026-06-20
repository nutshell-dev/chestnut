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

  /**
   * Returns whether the circuit-breaker is currently open (blocking calls).
   *
   * 副作用警告（phase 450 / review-round3 §3）：
   *
   * 本方法 mutates state — 当 `state === 'open'` 且距 openedAt 已超
   * `resetTimeoutMs` 时、本调用会：
   * - 将 state 从 'open' 改为 'half-open'
   * - emit `breaker_half_open` transition 回调
   * - 返回 false 允许一次探测
   *
   * 这意味着：
   * - 并发 caller 同时调用 isOpen() 时、第一个见到「open + 过 timeout」
   *   者触发 transition、其他 caller 此后见到 state='half-open' 也返 false
   *   → 多 probe 并发（review-2026-06-19 指出、目前接受、未深度治理）
   * - `wasOpen = isOpen(); ...; nowOpen = isOpen()` 模式（orchestrator.ts 13+
   *   caller 使用）依赖此副作用、二次调用看到 transition 完成后的状态差。
   *
   * 未来若解决并发 probe race、应拆为：
   * - canAttempt(): boolean — pure query（含 timeout decision）
   * - markProbeStarted(): void — caller 显式 transition
   *   届时所有 13+ caller 需同步改、超 review 单 phase 容量、留 follow-up phase。
   */
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
