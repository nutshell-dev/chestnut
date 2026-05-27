/**
 * Phase 1013 E.1: breaker_opened transition fire audit
 */

import { describe, it, expect, vi } from 'vitest';
import { CircuitBreaker } from '../../../src/foundation/llm-orchestrator/circuit-breaker.js';

describe('phase 1013 E.1: breaker_opened transition fire', () => {
  it('N failures reaches threshold → onTransition fired with breaker_opened and failures count', () => {
    const onTransition = vi.fn();
    const cb = new CircuitBreaker(3, 1000, onTransition);

    cb.onFailure();
    cb.onFailure();
    cb.onFailure();

    expect(onTransition).toHaveBeenCalledTimes(1);
    expect(onTransition).toHaveBeenCalledWith('breaker_opened', 3);
  });

  it('half-open state then failure → onTransition fired with breaker_opened', () => {
    const onTransition = vi.fn();
    const cb = new CircuitBreaker(3, 0, onTransition); // resetTimeoutMs=0 so half-open immediately

    // Open the breaker
    cb.onFailure();
    cb.onFailure();
    cb.onFailure();
    onTransition.mockClear();

    // isOpen() should transition to half-open since resetTimeoutMs=0
    cb.isOpen(); // transitions to half-open, calls onTransition('breaker_half_open')
    onTransition.mockClear();

    // Failure in half-open should trigger breaker_opened again
    cb.onFailure();
    expect(onTransition).toHaveBeenCalledTimes(1);
    expect(onTransition).toHaveBeenCalledWith('breaker_opened', 4);
  });

  it('already open then additional onFailure does NOT re-fire breaker_opened', () => {
    const onTransition = vi.fn();
    const cb = new CircuitBreaker(2, 1000, onTransition);

    cb.onFailure();
    cb.onFailure();
    expect(onTransition).toHaveBeenCalledTimes(1);
    onTransition.mockClear();

    cb.onFailure();
    expect(onTransition).not.toHaveBeenCalled();
  });
});
