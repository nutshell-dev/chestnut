/**
 * Phase 1013 E.1: breaker_opened transition fire audit
 */

import { describe, it, expect, vi } from 'vitest';
import { CircuitBreaker } from '../../../src/foundation/llm-orchestrator/circuit-breaker.js';

/**
 * Default 失败 threshold for primary test fixtures（CircuitBreaker constructor 第 1 param）.
 * Derivation: 3 = 经验值 N 次连续失败 → open / 配 test 用例「N failures reaches threshold」
 * 验 N=threshold 触发 breaker_opened.
 */
const DEFAULT_FAILURE_THRESHOLD = 3;

/**
 * Default reset timeout for half-open transition（CircuitBreaker constructor 第 2 param）.
 * Derivation: 1000ms = 1s 给 test 简短 cool-down / 比 production default (~30s) 短 30× 加速 test /
 * 配「already open then additional onFailure」验证 cool-down 内不 re-fire.
 */
const DEFAULT_RESET_TIMEOUT_MS = 1000;

describe('phase 1013 E.1: breaker_opened transition fire', () => {
  it('N failures reaches threshold → onTransition fired with breaker_opened and failures count', () => {
    const onTransition = vi.fn();
    const cb = new CircuitBreaker(DEFAULT_FAILURE_THRESHOLD, DEFAULT_RESET_TIMEOUT_MS, onTransition);

    cb.onFailure();
    cb.onFailure();
    cb.onFailure();

    expect(onTransition).toHaveBeenCalledTimes(1);
    expect(onTransition).toHaveBeenCalledWith('breaker_opened', DEFAULT_FAILURE_THRESHOLD);
  });

  it('half-open state then failure → onTransition fired with breaker_opened', () => {
    const onTransition = vi.fn();
    // resetTimeoutMs=0 is sentinel: half-open transition fires immediately
    const cb = new CircuitBreaker(DEFAULT_FAILURE_THRESHOLD, 0, onTransition);

    // Open the breaker
    cb.onFailure();
    cb.onFailure();
    cb.onFailure();
    onTransition.mockClear();

    // isOpen() should transition to half-open since resetTimeoutMs=0
    cb.isOpen(); // transitions to half-open, calls onTransition('breaker_half_open')
    onTransition.mockClear();

    // Failure in half-open should trigger breaker_opened again with failures count = threshold + 1
    cb.onFailure();
    expect(onTransition).toHaveBeenCalledTimes(1);
    expect(onTransition).toHaveBeenCalledWith('breaker_opened', DEFAULT_FAILURE_THRESHOLD + 1);
  });

  it('already open then additional onFailure does NOT re-fire breaker_opened', () => {
    // Per-it lower threshold: terse repro path（2 failures 即 open）
    const LOW_FAILURE_THRESHOLD = 2;
    const onTransition = vi.fn();
    const cb = new CircuitBreaker(LOW_FAILURE_THRESHOLD, DEFAULT_RESET_TIMEOUT_MS, onTransition);

    cb.onFailure();
    cb.onFailure();
    expect(onTransition).toHaveBeenCalledTimes(1);
    onTransition.mockClear();

    cb.onFailure();
    expect(onTransition).not.toHaveBeenCalled();
  });
});
