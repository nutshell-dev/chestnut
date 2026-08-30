import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const source = readFileSync(new URL('../../../src/foundation/audit/hourly-heartbeat.ts', import.meta.url), 'utf8');
const barrel = readFileSync(new URL('../../../src/foundation/audit/index.ts', import.meta.url), 'utf8');
describe('HourlyAccumulatorOptions surface', () => {
  it('keeps options local behind the accumulator factory', () => {
    expect(source).not.toMatch(/export\s+interface\s+HourlyAccumulatorOptions\b/);
    expect(source).toMatch(/interface\s+HourlyAccumulatorOptions\s*\{[\s\S]*onHourly:\s*\(tickCount:\s*number,\s*elapsedMs:\s*number\)\s*=>\s*void;[\s\S]*startTs\?:\s*number;[\s\S]*\}/);
    expect(source).toMatch(/options:\s*HourlyAccumulatorOptions,[\s\S]*\):\s*HourlyHeartbeatAccumulator/);
    expect(barrel).not.toMatch(/\bHourlyAccumulatorOptions\b/);
  });
});
