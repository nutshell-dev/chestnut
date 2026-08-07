/**
 * Phase 1318 Step C: 心跳每小时摘要计数器单元测试。
 */
import { describe, it, expect } from 'vitest';
import { createHourlyHeartbeatAccumulator } from '../../../src/foundation/audit/hourly-heartbeat.js';

describe('hourly heartbeat accumulator (phase 1318 Step C)', () => {
  it('does not fire before 1 hour', () => {
    const fired: Array<{ count: number; elapsed: number }> = [];
    const acc = createHourlyHeartbeatAccumulator({
      onHourly: (count, elapsed) => fired.push({ count, elapsed }),
    });

    const start = 1_000_000;
    for (let i = 0; i < 59; i++) {
      acc.tick(start + i * 60_000);
    }

    expect(fired).toHaveLength(0);
  });

  it('fires once after 1 hour and resets tick count', () => {
    const start = 1_000_000;
    const fired: Array<{ count: number; elapsed: number }> = [];
    const acc = createHourlyHeartbeatAccumulator({
      onHourly: (count, elapsed) => fired.push({ count, elapsed }),
      startTs: start,
    });
    for (let i = 0; i < 61; i++) {
      acc.tick(start + i * 60_000);
    }

    expect(fired).toHaveLength(1);
    expect(fired[0].count).toBe(61);
    expect(fired[0].elapsed).toBe(60 * 60_000);
  });

  it('fires again in the next hour window', () => {
    const start = 0;
    const fired: number[] = [];
    const acc = createHourlyHeartbeatAccumulator({
      onHourly: (count) => fired.push(count),
      startTs: start,
    });
    // first hour: 61 ticks (triggers at 1h)
    for (let i = 0; i <= 60; i++) acc.tick(start + i * 60_000);
    expect(fired).toHaveLength(1);

    // next hour: 61 ticks
    const next = 60 * 60_000;
    for (let i = 1; i <= 61; i++) acc.tick(next + i * 60_000);
    expect(fired).toHaveLength(2);
    expect(fired[1]).toBe(60);
  });
});
