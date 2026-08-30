import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const source = readFileSync(new URL('../../../src/foundation/audit/hourly-heartbeat.ts', import.meta.url), 'utf8');
const barrel = readFileSync(new URL('../../../src/foundation/audit/index.ts', import.meta.url), 'utf8');
describe('HourlyHeartbeatAccumulator surface', () => {
  it('keeps the result interface local behind its factory', () => {
    expect(source).not.toMatch(/export\s+interface\s+HourlyHeartbeatAccumulator\b/);
    expect(source).toMatch(/interface\s+HourlyHeartbeatAccumulator\s*\{[\s\S]*tick:\s*\(nowMs\?:\s*number\)\s*=>\s*void;[\s\S]*reset:\s*\(\)\s*=>\s*void;[\s\S]*\}/);
    expect(source).toMatch(/export\s+function\s+createHourlyHeartbeatAccumulator\([\s\S]*\):\s*HourlyHeartbeatAccumulator/);
    expect(barrel).not.toMatch(/\bHourlyHeartbeatAccumulator\b/);
  });
});
